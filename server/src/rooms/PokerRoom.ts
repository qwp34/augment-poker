/**
 * PokerRoom — 서버 권위(Server-Authoritative) 증강 포커 룸.
 *
 * 원칙:
 *  - 셔플/딜링/판정은 전부 서버에서만 수행 (덱·홀카드는 스키마 밖 private 필드)
 *  - 클라이언트 메시지는 전부 검증 후 적용 (차례, phase, 금액 정수/범위, 증강 소유 여부)
 *  - 게임 루프: waiting → augment_select → preflop → flop → turn → river → showdown
 *    → round_end → (다음 라운드는 다시 augment_select로 순환, 증강은 라운드 간 누적)
 */

import { Room, type Client, type Delayed } from 'colyseus';
import { PokerState, PlayerState, toCardSchema, type Phase } from '../schema/PokerState';
import type { Card, Rank, Street, Suit } from '../engine/types';
import { RANKS, SUITS } from '../engine/types';
import { createDeck, shuffle } from '../engine/deck';
import { evaluateBest, compareHands, type HandResult } from '../engine/handEvaluator';
import {
  applyPayoutAugments,
  rollAugmentChoices,
  findByEffect,
  isInstantAugment,
  applyEditCard,
  swapCards,
  revealCard,
  type Augment,
  type HoleIndex,
} from '../engine/augmentEngine';
import { decideBotAction, type BotDecision, type BotPersona } from '../engine/botAI';
import augmentsData from '../data/augments.json';

const AUGMENT_POOL = augmentsData as Augment[];

const START_STACK = 5000;
const SMALL_BLIND = 50;
const BIG_BLIND = 100;
const MAX_NAME_LENGTH = 8;
const MAX_ROUNDS = 5;
const TURN_TIMEOUT_MS = 30_000;
const AUGMENT_TIMEOUT_MS = 20_000;
/** 즉시형 증강(음침한 눈/카멜레온/당근이세요?) 대상 지정 제한시간 */
const AUGMENT_TARGET_TIMEOUT_MS = 15_000;
const RESULT_DELAY_MS = 5_000;
const BOT_ACT_DELAY_MIN_MS = 600;
const BOT_ACT_DELAY_MAX_MS = 1_400;

/** 베팅 액션을 받는 phase 집합 — preflop/flop/turn/river 각각이 곧 스트리트다 */
const BETTING_PHASES = new Set<Phase>(['preflop', 'flop', 'turn', 'river']);

type ActionMessage = { type?: unknown; amount?: unknown };

/** 즉시형 증강 대상 지정 메시지 — 효과 종류에 따라 필요한 필드만 채워 보낸다 */
type AugmentTargetMessage = {
  targetSessionId?: unknown;
  targetCardIndex?: unknown;
  ownCardIndex?: unknown;
  cardIndex?: unknown;
  rank?: unknown;
  suit?: unknown;
};

function toHoleIndex(value: unknown): HoleIndex | null {
  return value === 0 || value === 1 ? value : null;
}

export class PokerRoom extends Room<PokerState> {
  maxClients = 4;

  /** 서버 전용 — 클라이언트에 절대 동기화되지 않는 비밀 상태 */
  private deck: Card[] = [];
  private holes = new Map<string, Card[]>();
  private board: Card[] = [];
  /** 이번 라운드 각 플레이어에게 제시된 증강 선택지 (검증용 원본) */
  private pendingChoices = new Map<string, Augment[]>();
  /** 이번 라운드 시작 시점에 착석해 있던 플레이어 — 라운드 도중 합류한 인원은 다음 라운드부터 참여 */
  private roundRosterIds = new Set<string>();
  /** 봇 sessionId → 페르소나 (생성 시 랜덤 배정, 게임 내내 유지) */
  private botPersonas = new Map<string, BotPersona>();
  /** 이번 스트리트에 발생한 레이즈 횟수 (봇의 재레이즈 억제용) */
  private raisesThisStreet = 0;
  /** augment_target phase에서 아직 대상 지정을 안 한 플레이어 sessionId 집합 */
  private augmentTargetPendingIds = new Set<string>();
  /** startHand()에서 계산한 이번 핸드의 프리플랍 첫 액션 좌석 — augment_target을 거친 뒤에도 써야 해서 보관 */
  private handFirstActorSeat = -1;

  private turnTimer?: Delayed;
  private augmentTimer?: Delayed;

  onCreate() {
    this.state = new PokerState();
    this.state.maxRounds = MAX_ROUNDS;
    this.state.smallBlind = SMALL_BLIND;
    this.state.bigBlind = BIG_BLIND;
    this.state.minRaise = BIG_BLIND;

    this.onMessage('action', (client, message: ActionMessage) => this.handleAction(client, message));
    this.onMessage('chooseAugment', (client, message: { id?: unknown }) =>
      this.handleChooseAugment(client, message),
    );
    this.onMessage('chooseAugmentTarget', (client, message: AugmentTargetMessage) =>
      this.handleAugmentTarget(client, message),
    );
    this.onMessage('swapCard', (client, message: { index?: unknown }) =>
      this.handleSwapCard(client, message),
    );
    this.onMessage('startGame', (client) => this.handleStartGame(client));
  }

  onJoin(client: Client, options?: { name?: unknown; isBot?: unknown }) {
    const p = new PlayerState();
    p.sessionId = client.sessionId;
    p.seatIndex = this.assignSeat();
    p.isBot = options?.isBot === true;
    p.name = this.resolvePlayerName(options?.name);
    p.stack = START_STACK;
    // 게임이 이미 진행 중이면 이번 핸드는 관전, 다음 라운드부터 합류
    if (this.state.phase !== 'waiting') p.isFolded = true;
    this.state.players.set(client.sessionId, p);

    // 대기실에서 가장 먼저 들어온 사람이 방장 — "게임 시작"은 방장만 누를 수 있다
    if (this.state.phase === 'waiting' && !this.state.hostSessionId) {
      this.state.hostSessionId = client.sessionId;
    }
    if (this.state.players.size >= this.maxClients) void this.lock();
  }

  /** 빈 좌석 중 가장 낮은 번호를 배정 */
  private assignSeat(): number {
    const used = new Set([...this.state.players.values()].map((p) => p.seatIndex));
    for (let seat = 0; seat < this.maxClients; seat++) {
      if (!used.has(seat)) return seat;
    }
    throw new Error('빈 좌석이 없습니다');
  }

  /**
   * 입력 닉네임을 검증한다 — 앞뒤 공백 제거 후 최대 길이로 자르고,
   * 문자/숫자가 하나도 남지 않으면(빈 값·공백만·특수문자만) 중복 없는 기본 이름으로 대체한다.
   */
  private resolvePlayerName(rawInput: unknown): string {
    const trimmed = (typeof rawInput === 'string' ? rawInput : '').trim().slice(0, MAX_NAME_LENGTH);
    const hasRealContent = /[\p{L}\p{N}]/u.test(trimmed);
    return hasRealContent ? trimmed : this.uniqueDefaultName();
  }

  /** 현재 아무도 쓰지 않는 "플레이어N" 중 가장 낮은 번호 — 커스텀 닉네임과의 충돌도 피한다 */
  private uniqueDefaultName(): string {
    const existing = new Set([...this.state.players.values()].map((p) => p.name));
    let n = 1;
    while (existing.has(`플레이어${n}`)) n++;
    return `플레이어${n}`;
  }

  /** 방장이 "게임 시작"을 누르면: 빈 좌석을 봇으로 채우고 방을 잠근 뒤 라운드 진행 */
  private handleStartGame(client: Client) {
    if (this.state.phase !== 'waiting') return this.reject(client, '이미 게임이 시작되었습니다');
    if (client.sessionId !== this.state.hostSessionId)
      return this.reject(client, '방장만 게임을 시작할 수 있습니다');

    this.fillWithBots();
    void this.lock();
    this.state.round = 1;
    this.beginRound();
  }

  /** 빈 좌석을 봇 PlayerState로 채운다 (isBot: true) */
  private fillWithBots() {
    const used = new Set([...this.state.players.values()].map((p) => p.seatIndex));
    for (let seat = 0; seat < this.maxClients; seat++) {
      if (used.has(seat)) continue;
      const bot = new PlayerState();
      bot.sessionId = `bot-seat-${seat}`;
      bot.seatIndex = seat;
      bot.isBot = true;
      bot.name = `AI 봇 ${seat + 1}`;
      bot.stack = START_STACK;
      this.state.players.set(bot.sessionId, bot);
      this.botPersonas.set(bot.sessionId, Math.random() < 0.5 ? 'aggressive' : 'cautious');
    }
  }

  onLeave(client: Client) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.connected = false;
    p.isFolded = true;
    this.pendingChoices.delete(client.sessionId);

    const remaining = this.seatOrder().filter((o) => o.connected);
    if (this.state.phase === 'waiting' || this.state.phase === 'gameOver') {
      this.state.players.delete(client.sessionId);
      if (this.state.hostSessionId === client.sessionId) {
        const next = this.seatOrder()[0];
        this.state.hostSessionId = next ? next.sessionId : '';
      }
      return;
    }
    if (remaining.length < 2) {
      // 진행 중 상대가 모두 떠남 → 남은 플레이어가 팟 회수 후 게임 종료
      const winner = remaining[0];
      if (winner) {
        for (const o of this.seatOrder()) {
          winner.stack += o === winner ? o.streetBet : 0;
          this.state.pot += o !== winner ? o.streetBet : 0;
          o.streetBet = 0;
        }
        winner.stack += this.state.pot;
        this.state.pot = 0;
      }
      return this.endGame('상대 퇴장');
    }
    if (this.state.phase === 'augment_select') return this.checkAllChosen();
    if (this.state.phase === 'augment_target') {
      if (p.pendingInstantAugment) this.autoApplyInstantAugment(p);
      return this.resolveInstantAugmentFor(p);
    }
    if (BETTING_PHASES.has(this.state.phase)) this.resolveAfterAction();
  }

  // ─────────────────────────── 라운드 / 증강 선택 phase ───────────────────────────

  /** 라운드 시작: 각 플레이어에게 증강 3개 제시 (기획서 4장) */
  private beginRound() {
    this.setPhase('augment_select');
    this.pendingChoices.clear();
    this.roundRosterIds = new Set(this.state.players.keys());
    this.advanceDealer();

    let anyChoices = false;
    for (const p of this.seatOrder()) {
      p.augmentChoices.clear();
      if (!p.connected || p.stack <= 0) continue;
      const choices = rollAugmentChoices(AUGMENT_POOL, this.ownedAugments(p), 3);
      if (choices.length === 0) continue;
      anyChoices = true;
      this.pendingChoices.set(p.sessionId, choices);
      choices.forEach((c) => p.augmentChoices.push(c.id));
      // 봇은 사람의 선택을 기다리지 않고 곧바로 하나를 고른다
      if (p.isBot) this.chooseAugmentForBot(p, choices);
    }

    if (!anyChoices || this.pendingChoices.size === 0) return this.startHand();
    // 제한시간 내 미선택 시 자동 선택
    this.augmentTimer = this.clock.setTimeout(() => this.autoPickAugments(), AUGMENT_TIMEOUT_MS);
  }

  /** 봇의 증강 선택 — 지금은 무작위, 추후 botAI 판단 로직과 함께 확장 가능 */
  private chooseAugmentForBot(p: PlayerState, choices: Augment[]) {
    const chosen = choices[Math.floor(Math.random() * choices.length)];
    p.augmentIds.push(chosen.id);
    p.augmentChoices.clear();
    this.pendingChoices.delete(p.sessionId);
    if (isInstantAugment(chosen)) p.pendingInstantAugment = chosen.id;
  }

  private handleChooseAugment(client: Client, message: { id?: unknown }) {
    if (this.state.phase !== 'augment_select') return;
    const choices = this.pendingChoices.get(client.sessionId);
    if (!choices) return; // 선택지가 없거나 이미 선택함

    const id = typeof message?.id === 'string' ? message.id : '';
    const chosen = choices.find((a) => a.id === id);
    if (!chosen) return this.reject(client, '유효하지 않은 증강 선택입니다');

    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.augmentIds.push(chosen.id);
    p.augmentChoices.clear();
    this.pendingChoices.delete(client.sessionId);
    if (isInstantAugment(chosen)) p.pendingInstantAugment = chosen.id;
    this.checkAllChosen();
  }

  private checkAllChosen() {
    // 연결이 끊긴 플레이어의 선택은 기다리지 않는다
    for (const [sessionId] of this.pendingChoices) {
      const p = this.state.players.get(sessionId);
      if (!p || !p.connected) this.pendingChoices.delete(sessionId);
    }
    if (this.pendingChoices.size === 0 && this.state.phase === 'augment_select') {
      this.augmentTimer?.clear();
      this.startHand();
    }
  }

  private autoPickAugments() {
    for (const [sessionId, choices] of this.pendingChoices) {
      const p = this.state.players.get(sessionId);
      if (p && choices.length > 0) {
        const chosen = choices[0];
        p.augmentIds.push(chosen.id);
        p.augmentChoices.clear();
        if (isInstantAugment(chosen)) p.pendingInstantAugment = chosen.id;
      }
    }
    this.pendingChoices.clear();
    if (this.state.phase === 'augment_select') this.startHand();
  }

  // ─────────────────────────── 핸드 시작 / 딜링 ───────────────────────────

  /** 핸드 시작 — 셔플·딜링은 서버에서만. 홀카드는 각자에게 개별 전송 */
  private startHand() {
    const st = this.state;
    st.pot = 0;
    st.currentBet = 0;
    this.raisesThisStreet = 0;
    st.community.clear();
    this.board = [];
    this.holes.clear();
    this.deck = shuffle(createDeck());

    for (const p of this.seatOrder()) {
      if (!this.roundRosterIds.has(p.sessionId)) continue; // 라운드 도중 합류 → 다음 라운드부터 참여
      p.isFolded = !p.connected || p.stack <= 0; // 빈 스택은 이번 핸드 자동 관전
      p.allIn = false;
      p.hasActed = false;
      p.streetBet = 0;
      p.swapUsed = false;
      p.lastAction = '';
      p.revealedHole.clear();
    }

    const active = this.actingPlayers();
    if (active.length < 2) return this.endGame('플레이 가능 인원 부족');

    // 블라인드 — 딜러 다음 두 자리가 스몰/빅 블라인드를 강제 베팅
    const { bigBlindSeat } = this.postBlinds(active);

    // 딜링 + 증강 훅 (on_shuffle / on_round_start)
    for (const p of active) {
      let hole: Card[] = [this.deck.pop()!, this.deck.pop()!];
      const owned = this.ownedAugments(p);

      const bias = findByEffect(owned, 'shuffle_bias');
      if (bias && Math.random() < bias.effect.value) hole = this.riggedBroadway(hole);

      if (findByEffect(owned, 'jokerize_random')) {
        const idx = Math.random() < 0.5 ? 0 : 1;
        hole[idx] = { ...hole[idx], isJoker: true };
      }

      this.holes.set(p.sessionId, hole);
      this.sendHole(p.sessionId);
    }

    // 프리플랍은 빅블라인드 다음(UTG)부터 시작 — 헤즈업이면 postBlinds가 딜러=SB로 배정해
    // nextActorFromSeat(bigBlindSeat)이 자연히 딜러(SB) 자신을 돌려준다. augment_target을
    // 거칠 수도 있으므로 좌석만 기억해두고 실제 진입은 enterPreflop()에서 한다.
    this.handFirstActorSeat = bigBlindSeat;
    this.beginAugmentTargetPhase(active);
  }

  // ─────────────────────────── 증강: 즉시형(음침한 눈 / 카멜레온 / 당근이세요?) ───────────────────────────

  /**
   * 홀카드가 갓 딜링된 직후 호출된다. 이번 라운드에 즉시형 증강을 고른 플레이어가
   * 있으면 augment_target phase로 진입해 대상 지정을 기다리고, 없으면 곧바로
   * preflop으로 넘어간다. 봇은 기다리지 않고 즉시 무작위로 자동 처리한다.
   */
  private beginAugmentTargetPhase(active: PlayerState[]) {
    const pending = active.filter((p) => p.pendingInstantAugment);
    for (const p of pending) {
      if (p.isBot) this.autoApplyInstantAugment(p);
    }

    const waiting = pending.filter((p) => p.pendingInstantAugment);
    if (waiting.length === 0) return this.enterPreflop();

    this.setPhase('augment_target');
    this.augmentTargetPendingIds = new Set(waiting.map((p) => p.sessionId));
    for (const p of waiting) this.sendAugmentTargetPrompt(p);
    this.augmentTimer = this.clock.setTimeout(() => this.autoResolveAugmentTargets(), AUGMENT_TARGET_TIMEOUT_MS);
  }

  /** 대상 지정이 필요한 플레이어에게만 개별 전송 — 카드 값은 아직 안 알려준다(선택 UI는 이름/인덱스만 필요) */
  private sendAugmentTargetPrompt(p: PlayerState) {
    const client = this.clients.find((c) => c.sessionId === p.sessionId);
    if (!client) return;
    const augment = this.ownedAugments(p).find((a) => a.id === p.pendingInstantAugment);
    if (!augment) {
      p.pendingInstantAugment = '';
      return;
    }
    const opponents = this.actingPlayers()
      .filter((o) => o.sessionId !== p.sessionId)
      .map((o) => ({ sessionId: o.sessionId, name: o.name }));
    client.send('augmentTargetRequest', {
      augmentId: augment.id,
      effectType: augment.effect.type,
      opponents,
    });
  }

  private handleAugmentTarget(client: Client, message: AugmentTargetMessage) {
    if (this.state.phase !== 'augment_target') return;
    const p = this.state.players.get(client.sessionId);
    if (!p || !p.pendingInstantAugment) return;
    const augment = this.ownedAugments(p).find((a) => a.id === p.pendingInstantAugment);
    if (!augment) return this.resolveInstantAugmentFor(p);

    const ok = this.applyInstantAugmentEffect(p, augment, message);
    if (!ok) return this.reject(client, '증강 대상 지정이 올바르지 않습니다');
    this.resolveInstantAugmentFor(p);
  }

  /** 대상 지정이 끝난 플레이어를 대기 목록에서 제거 — 전원 끝나면 preflop으로 진행 */
  private resolveInstantAugmentFor(p: PlayerState) {
    p.pendingInstantAugment = '';
    this.augmentTargetPendingIds.delete(p.sessionId);
    if (this.state.phase === 'augment_target' && this.augmentTargetPendingIds.size === 0) {
      this.augmentTimer?.clear();
      this.enterPreflop();
    }
  }

  /** 제한시간 초과 시 아직 대상을 안 정한 플레이어 전원을 무작위로 자동 처리 */
  private autoResolveAugmentTargets() {
    if (this.state.phase !== 'augment_target') return;
    for (const sessionId of [...this.augmentTargetPendingIds]) {
      const p = this.state.players.get(sessionId);
      if (p) this.autoApplyInstantAugment(p);
    }
    this.augmentTargetPendingIds.clear();
    this.enterPreflop();
  }

  /** 무작위로 유효한 대상을 골라 즉시 해소 — 봇 처리 및 타임아웃/퇴장 폴백 공용 */
  private autoApplyInstantAugment(p: PlayerState) {
    const augment = this.ownedAugments(p).find((a) => a.id === p.pendingInstantAugment);
    p.pendingInstantAugment = '';
    if (!augment) return;

    const opponents = this.actingPlayers().filter((o) => o.sessionId !== p.sessionId);
    const randomIndex = (): HoleIndex => (Math.random() < 0.5 ? 0 : 1);

    switch (augment.effect.type) {
      case 'reveal_opponent_card': {
        const target = opponents[Math.floor(Math.random() * opponents.length)];
        if (target) {
          this.applyRevealCardEffect(p, { targetSessionId: target.sessionId, targetCardIndex: randomIndex() });
        }
        break;
      }
      case 'edit_own_card': {
        const rank = RANKS[Math.floor(Math.random() * RANKS.length)];
        const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
        this.applyEditCardEffect(p, { cardIndex: randomIndex(), rank, suit });
        break;
      }
      case 'swap_with_opponent': {
        const target = opponents[Math.floor(Math.random() * opponents.length)];
        if (target) {
          this.applySwapCardEffect(p, {
            targetSessionId: target.sessionId,
            targetCardIndex: randomIndex(),
            ownCardIndex: randomIndex(),
          });
        }
        break;
      }
    }
  }

  private applyInstantAugmentEffect(p: PlayerState, augment: Augment, message: AugmentTargetMessage): boolean {
    switch (augment.effect.type) {
      case 'reveal_opponent_card':
        return this.applyRevealCardEffect(p, message);
      case 'edit_own_card':
        return this.applyEditCardEffect(p, message);
      case 'swap_with_opponent':
        return this.applySwapCardEffect(p, message);
      default:
        return false;
    }
  }

  /** 음침한 눈 — 지정한 상대 홀카드 1장을 나에게만 전송한다. 게임 상태(this.holes)는 건드리지 않는 순수 조회 */
  private applyRevealCardEffect(p: PlayerState, message: AugmentTargetMessage): boolean {
    const targetId = typeof message.targetSessionId === 'string' ? message.targetSessionId : '';
    const idx = toHoleIndex(message.targetCardIndex);
    if (idx === null || !targetId || targetId === p.sessionId) return false;
    const target = this.state.players.get(targetId);
    if (!target || !this.actingPlayers().includes(target)) return false;

    const hole = this.holes.get(targetId);
    if (!hole) return false;
    const card = revealCard(hole, idx);

    const client = this.clients.find((c) => c.sessionId === p.sessionId);
    client?.send('augmentReveal', {
      targetSessionId: targetId,
      targetName: target.name,
      cardIndex: idx,
      card,
    });
    return true;
  }

  /** 카멜레온 — 내 홀카드 1장을 원하는 숫자/무늬로 교체하고, 갱신된 홀카드를 나에게만 다시 전송 */
  private applyEditCardEffect(p: PlayerState, message: AugmentTargetMessage): boolean {
    const idx = toHoleIndex(message.cardIndex);
    if (idx === null) return false;
    const rank = Math.floor(Number(message.rank));
    if (!RANKS.includes(rank as Rank)) return false;
    const suit = message.suit;
    if (typeof suit !== 'string' || !SUITS.includes(suit as Suit)) return false;

    const hole = this.holes.get(p.sessionId);
    if (!hole) return false;
    this.holes.set(p.sessionId, applyEditCard(hole, idx, rank as Rank, suit as Suit));
    this.sendHole(p.sessionId);
    return true;
  }

  /** 당근이세요? — 지정한 상대와 홀카드 1장씩 교환. 상대에게는 평범한 hole 메시지만 가서 교체 사실/출처를 알 수 없다 */
  private applySwapCardEffect(p: PlayerState, message: AugmentTargetMessage): boolean {
    const targetId = typeof message.targetSessionId === 'string' ? message.targetSessionId : '';
    if (!targetId || targetId === p.sessionId) return false;
    const target = this.state.players.get(targetId);
    if (!target || !this.actingPlayers().includes(target)) return false;

    const tIdx = toHoleIndex(message.targetCardIndex);
    const oIdx = toHoleIndex(message.ownCardIndex);
    if (tIdx === null || oIdx === null) return false;

    const myHole = this.holes.get(p.sessionId);
    const theirHole = this.holes.get(targetId);
    if (!myHole || !theirHole) return false;

    const { mine, theirs } = swapCards(myHole, theirHole, oIdx, tIdx);
    this.holes.set(p.sessionId, mine);
    this.holes.set(targetId, theirs);
    this.sendHole(p.sessionId);
    this.sendHole(targetId);
    return true;
  }

  /** augment_target을 무사히 통과한(또는 처음부터 필요 없던) 핸드를 실제로 시작한다 */
  private enterPreflop() {
    this.setPhase('preflop');
    const first = this.handFirstActorSeat >= 0 ? this.nextActorFromSeat(this.handFirstActorSeat) : this.firstActor();
    this.handFirstActorSeat = -1;
    if (!first) return this.runoutAndShowdown(); // 전원 올인
    this.setTurn(first);
  }

  /**
   * 스몰/빅 블라인드를 강제 베팅시킨다.
   * 다인 테이블: 딜러 다음 좌석 = SB, 그다음 좌석 = BB.
   * 헤즈업(활성 인원 2명) 표준 규칙: 딜러가 SB를 겸하고 프리플랍에 먼저 행동한다.
   */
  private postBlinds(active: PlayerState[]): { smallBlindSeat: number; bigBlindSeat: number } {
    const st = this.state;
    const dealer = active.find((p) => p.seatIndex === st.dealerSeat);

    let sb: PlayerState | null;
    let bb: PlayerState | null;
    if (active.length === 2 && dealer) {
      sb = dealer;
      bb = this.nextActorFromSeat(dealer.seatIndex);
    } else {
      sb = this.nextActorFromSeat(st.dealerSeat);
      bb = sb ? this.nextActorFromSeat(sb.seatIndex) : null;
    }

    if (sb) {
      this.commit(sb, Math.min(st.smallBlind, sb.stack));
      sb.lastAction = `스몰블라인드 ${sb.streetBet}`;
    }
    if (bb) {
      this.commit(bb, Math.min(st.bigBlind, bb.stack));
      bb.lastAction = `빅블라인드 ${bb.streetBet}`;
    }
    st.minRaise = st.bigBlind;

    return { smallBlindSeat: sb ? sb.seatIndex : -1, bigBlindSeat: bb ? bb.seatIndex : -1 };
  }

  /** "로열의 예언" — 같은 무늬 브로드웨이 2장으로 홀카드 교체 (연출용 편향) */
  private riggedBroadway(hole: Card[]): Card[] {
    const suit: Suit = SUITS[Math.floor(Math.random() * SUITS.length)];
    const picks: Card[] = [];
    for (let i = this.deck.length - 1; i >= 0 && picks.length < 2; i--) {
      const c = this.deck[i];
      if (c.suit === suit && c.rank >= 10) {
        picks.push(c);
        this.deck.splice(i, 1);
      }
    }
    if (picks.length < 2) {
      this.deck.push(...picks);
      return hole;
    }
    this.deck.unshift(...hole); // 원래 카드는 덱 바닥으로
    return picks;
  }

  private sendHole(sessionId: string) {
    const client = this.clients.find((c) => c.sessionId === sessionId);
    const hole = this.holes.get(sessionId);
    if (client && hole) client.send('hole', hole);
  }

  // ─────────────────────────── 베팅 phase ───────────────────────────

  private handleAction(client: Client, message: ActionMessage) {
    const st = this.state;
    // 검증 1: phase와 차례
    if (!BETTING_PHASES.has(st.phase)) return this.reject(client, '지금은 베팅 시간이 아닙니다');
    if (client.sessionId !== st.activePlayerId) return this.reject(client, '당신의 차례가 아닙니다');
    const p = st.players.get(client.sessionId);
    if (!p || p.isFolded || p.allIn) return;

    const type = typeof message?.type === 'string' ? message.type : '';
    const error = this.applyAction(p, type, message?.amount);
    if (error) return this.reject(client, error);
    this.resolveAfterAction();
  }

  /**
   * 액션을 실제 상태에 반영한다. 사람(handleAction)과 봇(runBotAction) 공용 —
   * 실패 시 에러 메시지를 반환하고(null이면 성공) 상태는 건드리지 않는다.
   */
  private applyAction(p: PlayerState, type: string, rawAmount?: unknown): string | null {
    const st = this.state;
    const toCall = st.currentBet - p.streetBet;

    switch (type) {
      case 'fold':
        p.isFolded = true;
        p.lastAction = '다이';
        break;

      case 'check':
        if (toCall > 0) return `체크 불가 — 콜 ${toCall} 필요`;
        p.lastAction = '체크';
        break;

      case 'call': {
        if (toCall <= 0) {
          p.lastAction = '체크';
          break;
        }
        const pay = Math.min(toCall, p.stack);
        this.commit(p, pay);
        p.lastAction = `콜 ${pay}`;
        break;
      }

      case 'raise': {
        // 검증 2: 클라이언트가 보낸 금액은 신뢰하지 않는다
        const amount = Math.floor(Number(rawAmount));
        if (!Number.isSafeInteger(amount) || amount <= 0) return '레이즈 금액이 올바르지 않습니다';
        const pay = toCall + amount;
        if (pay > p.stack) return '스택이 부족합니다';
        if (amount < st.minRaise && pay < p.stack) return `최소 레이즈는 ${st.minRaise}입니다`;
        this.commit(p, pay);
        st.minRaise = amount;
        this.reopenAction(p);
        this.raisesThisStreet += 1;
        p.lastAction = `레이즈 +${amount}`;
        break;
      }

      case 'allin': {
        const pay = p.stack;
        if (pay <= 0) return '베팅할 칩이 없습니다';
        const raiseAmount = p.streetBet + pay - st.currentBet;
        this.commit(p, pay);
        if (raiseAmount > 0) {
          st.minRaise = Math.max(st.minRaise, raiseAmount);
          this.reopenAction(p);
          this.raisesThisStreet += 1;
        }
        p.lastAction = '올인';
        break;
      }

      default:
        return '알 수 없는 액션입니다';
    }

    p.hasActed = true;
    return null;
  }

  /** 칩을 스트리트 베팅에 반영 (currentBet/올인 처리 포함) */
  private commit(p: PlayerState, pay: number) {
    p.stack -= pay;
    p.streetBet += pay;
    if (p.streetBet > this.state.currentBet) this.state.currentBet = p.streetBet;
    if (p.stack === 0) p.allIn = true;
  }

  /** 레이즈 발생 시 다른 플레이어들이 다시 행동해야 함 */
  private reopenAction(raiser: PlayerState) {
    for (const o of this.actingPlayers()) {
      if (o !== raiser && !o.allIn) o.hasActed = false;
    }
  }

  /** 액션 처리 후: 핸드 종료/스트리트 종료/다음 차례 판정 */
  private resolveAfterAction() {
    this.clearTurnTimer();
    const st = this.state;
    if (!BETTING_PHASES.has(st.phase)) return;

    const alive = this.actingPlayers();
    if (alive.length <= 1) return this.endByFold(alive[0]);

    const canAct = alive.filter((p) => !p.allIn);
    const betsMatched = alive.every((p) => p.allIn || p.streetBet === st.currentBet);
    const allActed = canAct.every((p) => p.hasActed);

    if (canAct.length === 0 || (betsMatched && allActed)) return this.advanceStreet();

    const next = this.nextActor(st.activePlayerId);
    if (!next) return this.advanceStreet();
    this.setTurn(next);
  }

  private advanceStreet() {
    const st = this.state;
    // 스트리트 베팅 정산
    for (const p of this.seatOrder()) {
      st.pot += p.streetBet;
      p.streetBet = 0;
      p.hasActed = false;
      p.lastAction = '';
    }
    st.currentBet = 0;
    st.minRaise = st.bigBlind;
    this.raisesThisStreet = 0;
    this.setActivePlayer(null);

    const alive = this.actingPlayers();
    const canAct = alive.filter((p) => !p.allIn);
    if (st.phase === 'river' || canAct.length <= 1) return this.runoutAndShowdown();

    const dealCount = st.phase === 'preflop' ? 3 : 1;
    this.setPhase(st.phase === 'preflop' ? 'flop' : st.phase === 'flop' ? 'turn' : 'river');
    this.dealBoard(dealCount);

    // 포스트플랍은 딜러 다음의 첫 활성 좌석부터 (헤즈업이면 자연히 빅블라인드 쪽)
    const first = this.firstActor();
    if (!first) return this.runoutAndShowdown();
    this.setTurn(first);
  }

  private dealBoard(n: number) {
    for (let i = 0; i < n; i++) {
      const card = this.deck.pop()!;
      this.board.push(card);
      this.state.community.push(toCardSchema(card));
    }
  }

  // ─────────────────────────── 쇼다운 / 결과 ───────────────────────────

  private runoutAndShowdown() {
    if (this.board.length < 5) this.dealBoard(5 - this.board.length);
    this.showdown();
  }

  private showdown() {
    const st = this.state;
    this.setPhase('showdown');
    this.setActivePlayer(null);

    const contenders = this.actingPlayers();
    const results: { p: PlayerState; hand: HandResult }[] = contenders.map((p) => ({
      p,
      hand: evaluateBest([...this.holes.get(p.sessionId)!, ...this.board]),
    }));

    // 홀카드 전체 공개
    for (const { p } of results) {
      p.revealedHole.clear();
      for (const c of this.holes.get(p.sessionId)!) p.revealedHole.push(toCardSchema(c));
    }

    results.sort((a, b) => compareHands(b.hand, a.hand));
    const best = results[0].hand;
    const winners = results.filter((r) => compareHands(r.hand, best) === 0);
    const share = Math.floor(st.pot / winners.length);
    const remainder = st.pot % winners.length;

    const winnerSummaries = winners.map((w, i) => {
      const base = share + (i === 0 ? remainder : 0);
      // [증강 훅: on_showdown] 배당 배율 적용 — 서버에서만 계산
      const { payout, multiplier, applied } = applyPayoutAugments(
        this.ownedAugments(w.p),
        { handCategory: w.hand.category, isAllIn: w.p.allIn },
        base,
      );
      w.p.stack += payout;
      return {
        sessionId: w.p.sessionId,
        name: w.p.name,
        category: w.hand.category,
        basePayout: base,
        payout,
        multiplier,
        augments: applied.map((a) => a.name),
      };
    });

    st.pot = 0;
    this.broadcast('result', {
      byFold: false,
      winners: winnerSummaries,
      hands: results.map((r) => ({
        sessionId: r.p.sessionId,
        name: r.p.name,
        category: r.hand.category,
      })),
    });

    this.setPhase('round_end');
    this.clock.setTimeout(() => this.endRound(), RESULT_DELAY_MS);
  }

  private endByFold(winner?: PlayerState) {
    this.clearTurnTimer();
    const st = this.state;
    for (const p of this.seatOrder()) {
      st.pot += p.streetBet;
      p.streetBet = 0;
    }
    if (winner) {
      winner.stack += st.pot;
      this.broadcast('result', {
        byFold: true,
        winners: [{ sessionId: winner.sessionId, name: winner.name, payout: st.pot }],
      });
    }
    st.pot = 0;
    this.setActivePlayer(null);
    this.setPhase('round_end');
    this.clock.setTimeout(() => this.endRound(), RESULT_DELAY_MS);
  }

  private endRound() {
    if (this.state.phase !== 'round_end') return;
    const solvent = this.seatOrder().filter((p) => p.connected && p.stack > 0);
    if (this.state.round >= MAX_ROUNDS || solvent.length < 2) return this.endGame('라운드 종료');
    this.state.round += 1;
    this.beginRound();
  }

  private endGame(reason: string) {
    this.clearTurnTimer();
    this.augmentTimer?.clear();
    this.setPhase('gameOver');
    this.setActivePlayer(null);
    const standings = this.seatOrder()
      .map((p) => ({ sessionId: p.sessionId, name: p.name, stack: p.stack, connected: p.connected }))
      .sort((a, b) => b.stack - a.stack);
    this.broadcast('gameOver', { reason, standings, winner: standings[0] ?? null });
  }

  // ─────────────────────────── 증강: 카드 재구성 ───────────────────────────

  private handleSwapCard(client: Client, message: { index?: unknown }) {
    if (!BETTING_PHASES.has(this.state.phase)) return this.reject(client, '지금은 교체할 수 없습니다');
    const p = this.state.players.get(client.sessionId);
    if (!p || p.isFolded) return;
    // 검증: 증강 소유 + 핸드당 1회
    if (!findByEffect(this.ownedAugments(p), 'card_swap'))
      return this.reject(client, '카드 재구성 증강이 없습니다');
    if (p.swapUsed) return this.reject(client, '이번 핸드에 이미 교체했습니다');

    const index = Math.floor(Number(message?.index));
    if (index !== 0 && index !== 1) return this.reject(client, '카드 인덱스는 0 또는 1이어야 합니다');

    const hole = this.holes.get(client.sessionId);
    const newCard = this.deck.pop();
    if (!hole || !newCard) return;
    hole[index] = newCard;
    p.swapUsed = true;
    this.sendHole(client.sessionId);
  }

  // ─────────────────────────── 유틸 ───────────────────────────

  /** 좌석 번호(0~3) 순으로 정렬된 플레이어 목록 */
  private seatOrder(): PlayerState[] {
    return [...this.state.players.values()].sort((a, b) => a.seatIndex - b.seatIndex);
  }

  /** 좌석 번호 → 플레이어 (빈 좌석은 undefined) */
  private seatSlots(): (PlayerState | undefined)[] {
    const slots: (PlayerState | undefined)[] = new Array(this.maxClients).fill(undefined);
    for (const p of this.state.players.values()) slots[p.seatIndex] = p;
    return slots;
  }

  /** 폴드하지 않고 연결된 플레이어 (올인 포함) */
  private actingPlayers(): PlayerState[] {
    return this.seatOrder().filter((p) => !p.isFolded && p.connected);
  }

  /** 딜러 버튼을 다음 착석·플레이 가능(파산하지 않은) 플레이어 좌석으로 시계 방향 이동 */
  private advanceDealer() {
    const slots = this.seatSlots();
    let seat = this.state.dealerSeat;
    for (let i = 0; i < this.maxClients; i++) {
      seat = (seat + 1 + this.maxClients) % this.maxClients;
      const p = slots[seat];
      if (p && p.connected && p.stack > 0) {
        this.state.dealerSeat = seat;
        return;
      }
    }
  }

  /** 딜러 다음 좌석부터 시계 방향으로 행동 가능한 첫 플레이어 */
  private firstActor(): PlayerState | null {
    return this.nextActorFromSeat(this.state.dealerSeat);
  }

  private nextActor(fromSessionId: string): PlayerState | null {
    const from = this.state.players.get(fromSessionId);
    if (!from) return null;
    return this.nextActorFromSeat(from.seatIndex);
  }

  /** 주어진 좌석 다음부터 시계 방향으로 행동 가능한(폴드하지 않고 연결됨, 올인 아님) 첫 플레이어 — 폴드한 플레이어는 자동 스킵 */
  private nextActorFromSeat(seat: number): PlayerState | null {
    const slots = this.seatSlots();
    for (let i = 1; i <= this.maxClients; i++) {
      const p = slots[(seat + i + this.maxClients) % this.maxClients];
      if (p && !p.isFolded && p.connected && !p.allIn) return p;
    }
    return null;
  }

  /** activePlayerId와 currentTurnSeat을 함께 갱신 */
  private setActivePlayer(p: PlayerState | null) {
    this.state.activePlayerId = p ? p.sessionId : '';
    this.state.currentTurnSeat = p ? p.seatIndex : -1;
  }

  /** 다음 차례를 지정 — 사람이면 제한시간 타이머, 봇이면 자동 행동을 예약 */
  private setTurn(p: PlayerState) {
    this.setActivePlayer(p);
    if (p.isBot) this.scheduleBotAction(p);
    else this.armTurnTimer();
  }

  private ownedAugments(p: PlayerState): Augment[] {
    return AUGMENT_POOL.filter((a) => p.augmentIds.includes(a.id));
  }

  private setPhase(phase: Phase) {
    this.state.phase = phase;
  }

  private reject(client: Client, message: string) {
    client.send('error', { message });
  }

  /** 턴 제한시간 — 초과 시 자동 체크/다이 */
  private armTurnTimer() {
    this.clearTurnTimer();
    const sessionId = this.state.activePlayerId;
    this.turnTimer = this.clock.setTimeout(() => {
      const p = this.state.players.get(sessionId);
      if (!p || !BETTING_PHASES.has(this.state.phase) || this.state.activePlayerId !== sessionId) return;
      const toCall = this.state.currentBet - p.streetBet;
      if (toCall > 0) {
        p.isFolded = true;
        p.lastAction = '다이 (시간 초과)';
      } else {
        p.lastAction = '체크 (시간 초과)';
      }
      p.hasActed = true;
      this.resolveAfterAction();
    }, TURN_TIMEOUT_MS);
  }

  private clearTurnTimer() {
    this.turnTimer?.clear();
    this.turnTimer = undefined;
  }

  // ─────────────────────────── 봇 자동 진행 ───────────────────────────

  /** "생각하는 척" 딜레이 후 봇의 액션을 실행 예약 (turnTimer 슬롯을 재사용) */
  private scheduleBotAction(bot: PlayerState) {
    this.clearTurnTimer();
    const sessionId = bot.sessionId;
    const delay = BOT_ACT_DELAY_MIN_MS + Math.random() * (BOT_ACT_DELAY_MAX_MS - BOT_ACT_DELAY_MIN_MS);
    this.turnTimer = this.clock.setTimeout(() => this.runBotAction(sessionId), delay);
  }

  /** botAI에 현재 판 상태를 넘겨 결정을 받고, 사람과 동일한 applyAction 경로로 반영 */
  private async runBotAction(sessionId: string) {
    const st = this.state;
    if (!BETTING_PHASES.has(st.phase) || st.activePlayerId !== sessionId) return;
    const bot = st.players.get(sessionId);
    if (!bot || bot.isFolded || bot.allIn) return;

    const toCall = st.currentBet - bot.streetBet;
    const potSize = st.pot + this.seatOrder().reduce((sum, p) => sum + p.streetBet, 0);

    let decision: BotDecision;
    try {
      decision = await decideBotAction({
        holeCards: this.holes.get(sessionId) ?? [],
        community: this.board,
        street: st.phase as Street,
        toCall,
        potSize,
        botStack: bot.stack,
        raisesThisStreet: this.raisesThisStreet,
        persona: this.botPersonas.get(sessionId) ?? 'cautious',
      });
    } catch (err) {
      // 향후 Claude API 연동 시 호출 실패에 대비한 안전한 폴백
      console.error('botAI 판단 실패, 안전한 기본 액션으로 대체:', err);
      decision = { action: toCall > 0 ? 'fold' : 'check', reason: '판단 실패 — 안전하게 처리' };
    }

    // 판단을 기다리는 동안 차례/페이즈가 바뀌었을 수 있으므로 재검증
    if (!BETTING_PHASES.has(st.phase) || st.activePlayerId !== sessionId) return;

    let error = this.applyAction(bot, decision.action, decision.amount);
    if (error) error = this.applyAction(bot, toCall > 0 ? 'fold' : 'check'); // 방어적 폴백
    if (error) return;
    this.resolveAfterAction();
  }
}
