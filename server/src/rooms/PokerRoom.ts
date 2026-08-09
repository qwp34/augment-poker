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
  collectHandStartTargetQueue,
  isOneShotAugment,
  applyEditCard,
  swapCards,
  revealCard,
  type Augment,
  type HoleIndex,
} from '../engine/augmentEngine';
import { decideBotAction, type BotDecision, type BotPersona } from '../engine/botAI';
import { computeFixedBet, type FixedBetType } from '../engine/betSizing';
import augmentsData from '../data/augments.json';

const AUGMENT_POOL = augmentsData as Augment[];

const START_STACK = 5000;
const SMALL_BLIND = 50;
const BIG_BLIND = 100;
const MAX_NAME_LENGTH = 8;
const MAX_ROUNDS = 5;
const TURN_TIMEOUT_MS = 30_000;
const AUGMENT_TIMEOUT_MS = 20_000;
/**
 * 즉시형 증강(음침한 눈/카멜레온/당근이세요?) 대상 지정 제한시간 — 한 단계(예: 카멜레온의
 * "카드 선택"/"숫자 선택"/"무늬 선택" 중 하나)당 주어지는 시간. 예전엔 큐 전체에 15초
 * 하나만 걸려 있어 여러 항목을 골라야 하면 체감상 너무 급했다 — 단계마다 새로 리셋되는
 * 넉넉한 시간으로 늘렸다(그래도 AFK로 게임 전체가 멈추지 않도록 완전히 없애지는 않음).
 */
const AUGMENT_TARGET_TIMEOUT_MS = 45_000;
const RESULT_DELAY_MS = 5_000;
const BOT_ACT_DELAY_MIN_MS = 600;
const BOT_ACT_DELAY_MAX_MS = 1_400;
/** 봇의 대상 지정형 증강 자동 처리 딜레이 — 여러 명이 몰려도 한 명씩 자연스럽게 순서대로 보이도록 */
const BOT_TARGET_RESOLVE_DELAY_MIN_MS = 700;
const BOT_TARGET_RESOLVE_DELAY_MAX_MS = 1_400;

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
  /**
   * 이번 핸드에 각 플레이어가 대상 지정을 해야 할 증강 id 목록(획득 순서) — 큐의 맨
   * 앞(index 0)이 현재 대상 지정을 기다리는 증강이다. 하나를 해소하면 shift하고 다음
   * 항목이 있으면 곧바로 다음 대상 지정 UI를 띄운다. 대상 지정이 필요한 증강을 보유한
   * 플레이어는 이 큐가 매 핸드 시작마다 새로 채워진다 — 1회성이 아니라 계속 재발동.
   */
  private pendingTargetQueues = new Map<string, string[]>();
  /**
   * augment_target phase에서 아직 자기 차례를 시작하지 않은 플레이어 순서열 — 여러 명이
   * 동시에 대상 지정이 필요해도 한 명씩 순서대로만 처리한다(화면이 한꺼번에 정신없이
   * 지나가지 않도록). 맨 앞을 꺼내 그 사람의 큐가 전부 끝나면 다음 사람으로 넘어간다.
   */
  private targetPhaseOrder: string[] = [];
  /** startHand()에서 계산한 이번 핸드의 프리플랍 첫 액션 좌석 — augment_target을 거친 뒤에도 써야 해서 보관 */
  private handFirstActorSeat = -1;

  private turnTimer?: Delayed;
  private augmentTimer?: Delayed;
  /** augment_target에서 현재 차례인 플레이어(사람의 응답 대기 또는 봇의 처리 딜레이) 전용 타이머 */
  private targetPromptTimer?: Delayed;

  /**
   * 밑장빼기 — 이번 스트리트 리빌 직전, 아직 사용하지 않은 보유자들에게 순서대로
   * "사용하시겠습니까?" 를 묻는다(augment_target의 targetPhaseOrder와 같은 구조).
   */
  private streetRevealQueue: string[] = [];
  /** 지금 프롬프트를 보낸 대상 — 이 값과 일치하는 클라이언트의 응답만 유효 처리 */
  private streetRevealCurrentId: string | null = null;
  /** 이번 스트리트에 "사용"을 선택한 인원 수 — 그만큼 딜링 전에 덱 맨 위 카드를 추가로 버린다 */
  private streetRevealBurnCount = 0;
  /** street_reveal_choice를 마치면 실제로 진입할 phase(flop/turn/river)와 딜링할 장수 */
  private pendingStreetPhase: Phase | null = null;
  private pendingStreetDealCount = 0;
  private streetRevealPromptTimer?: Delayed;

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
    this.onMessage('skipAugmentTarget', (client) => this.handleSkipAugmentTarget(client));
    this.onMessage('swapCard', (client, message: { index?: unknown }) =>
      this.handleSwapCard(client, message),
    );
    this.onMessage('bottomDealChoice', (client, message: { use?: unknown }) =>
      this.handleBottomDealChoice(client, message),
    );
    this.onMessage('resetBoard', (client) => this.handleResetBoard(client));
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
      const wasActive = p.pendingTargetAugment !== '';
      this.autoResolveEntireQueue(p);
      this.targetPhaseOrder = this.targetPhaseOrder.filter((id) => id !== p.sessionId);
      if (wasActive) this.advanceTargetPhasePlayer();
      return;
    }
    if (this.state.phase === 'street_reveal_choice') {
      const wasActive = this.streetRevealCurrentId === p.sessionId;
      this.streetRevealQueue = this.streetRevealQueue.filter((id) => id !== p.sessionId);
      if (wasActive) {
        this.streetRevealPromptTimer?.clear();
        this.streetRevealCurrentId = null;
        this.resolveBottomDealChoice(p, false);
        this.advanceStreetRevealPlayer();
      }
      return;
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

  /**
   * 봇의 증강 선택 — 지금은 무작위, 추후 botAI 판단 로직과 함께 확장 가능.
   * 선택은 그저 보유 목록에 추가할 뿐, 효과는 여기서 발동하지 않는다 — 대상 지정이
   * 필요한 증강이든 아니든 실제 발동은 매 핸드 시작 시 beginAugmentTargetPhase/
   * startHand에서 보유 증강 전체를 훑으며 재처리한다.
   */
  private chooseAugmentForBot(p: PlayerState, choices: Augment[]) {
    const chosen = choices[Math.floor(Math.random() * choices.length)];
    p.augmentIds.push(chosen.id);
    p.augmentChoices.clear();
    this.pendingChoices.delete(p.sessionId);
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
      p.bottomDealUsed = false;
      p.resetBoardUsed = false;
      p.holeCount = 2;
      p.lastAction = '';
      p.revealedHole.clear();
      p.pendingTargetAugment = '';
    }

    const active = this.actingPlayers();
    if (active.length < 2) return this.endGame('플레이 가능 인원 부족');

    // 블라인드 — 딜러 다음 두 자리가 스몰/빅 블라인드를 강제 베팅
    const { bigBlindSeat } = this.postBlinds(active);

    // 전원에게 적용되는 테이블 단위 증강(대풍년/흔들리는 테이블) — 누구 한 명이라도
    // 보유하고 있으면(소유자만이 아니라) 이번 라운드 전체 딜링 방식에 영향을 준다.
    const anyExtraHole = active.some((p) => findByEffect(this.ownedAugments(p), 'extra_hole_card'));
    const anyRotate = active.some((p) => findByEffect(this.ownedAugments(p), 'rotate_hole_cards'));
    const holeCount = anyExtraHole ? 3 : 2;

    // 대풍년 — 갑자기 홀카드가 3장으로 늘어나면 혼란스러우므로, 딜링 직전 전원에게
    // 눈에 띄는 큰 배너로 무슨 일이 일어나는지 먼저 알린다(작은 토스트로는 부족해
    // 별도 메시지 타입을 쓴다 — 클라이언트가 더 크고 오래 표시).
    if (anyExtraHole) {
      this.broadcast('bigAnnouncement', {
        text: '🌾 대풍년 발동! 모든 플레이어의 홀카드가 1장씩 추가됩니다',
      });
    }

    // 1) 기본 딜링 — active 배열은 seatIndex 오름차순(=시계 방향) 순서다
    const dealtHoles = new Map<string, Card[]>();
    for (const p of active) {
      const hole: Card[] = [];
      for (let i = 0; i < holeCount; i++) hole.push(this.deck.pop()!);
      dealtHoles.set(p.sessionId, hole);
    }

    // 2) 흔들리는 테이블 — 방금 딜링된 손을 시계 방향으로 한 자리씩 넘긴다(내 카드는
    // 다음 사람에게 = 나는 이전 사람의 손을 받는다)
    if (anyRotate && active.length > 1) {
      const rotated = new Map<string, Card[]>();
      active.forEach((p, i) => {
        const from = active[(i - 1 + active.length) % active.length];
        rotated.set(p.sessionId, dealtHoles.get(from.sessionId)!);
      });
      for (const [sid, hole] of rotated) dealtHoles.set(sid, hole);
    }

    // 3) 증강 훅 (on_shuffle / on_round_start) — 회전이 끝난 뒤, 최종적으로 내가
    // 쥐게 된 손을 기준으로 적용한다
    for (const p of active) {
      let hole = dealtHoles.get(p.sessionId)!;
      const owned = this.ownedAugments(p);

      const bias = findByEffect(owned, 'shuffle_bias');
      if (bias && Math.random() < bias.effect.value) hole = this.riggedBroadway(hole);

      if (findByEffect(owned, 'jokerize_random')) {
        const idx = Math.random() < 0.5 ? 0 : 1;
        hole[idx] = { ...hole[idx], isJoker: true };
      }

      p.holeCount = hole.length;
      this.holes.set(p.sessionId, hole);
      this.sendHole(p.sessionId);
    }

    // 흔들리는 테이블이 실제로 발동했음을 전원에게 알린다 — 카드 값은 담지 않고, 기존
    // "카드 변경" 글로우 연출(cardChange)을 재사용해 모든 좌석의 홀카드에 잠깐 글로우를 준다
    if (anyRotate && active.length > 1) {
      const shakyTable = active
        .flatMap((p) => this.ownedAugments(p))
        .find((a) => a.effect.type === 'rotate_hole_cards')!;
      this.broadcastCardChange(
        shakyTable,
        active.flatMap((p) => [
          { sessionId: p.sessionId, cardIndex: 0 as const },
          { sessionId: p.sessionId, cardIndex: 1 as const },
        ]),
      );
    }

    // 프리플랍은 빅블라인드 다음(UTG)부터 시작 — 헤즈업이면 postBlinds가 딜러=SB로 배정해
    // nextActorFromSeat(bigBlindSeat)이 자연히 딜러(SB) 자신을 돌려준다. augment_target을
    // 거칠 수도 있으므로 좌석만 기억해두고 실제 진입은 enterPreflop()에서 한다.
    this.handFirstActorSeat = bigBlindSeat;
    this.beginAugmentTargetPhase(active);
  }

  // ─────────────────────────── 증강: 대상 지정형(음침한 눈 / 카멜레온 / 당근이세요?) ───────────────────────────
  //
  // 아래 세 증강은 보유하고 있는 한 1회성으로 끝나지 않고 매 핸드 시작 시 재발동한다 —
  // 그 핸드의 새 홀카드를 대상으로 매번 다시 대상 지정 UI가 뜬다. 한 플레이어가 이런
  // 증강을 여러 개 보유했다면 획득 순서대로 큐에 쌓아 하나씩 순서대로 처리한다.

  /**
   * 홀카드가 갓 딜링된 직후 호출된다. 대상 지정이 필요한 증강(음침한 눈/카멜레온/
   * 당근이세요?)을 보유한 플레이어가 있으면 그 보유 증강 전부를 획득 순서대로 큐에
   * 담아 augment_target phase로 진입하고, 없으면 곧바로 preflop으로 넘어간다.
   * 실제 처리는 advanceTargetPhasePlayer()가 한 명씩 순서대로 진행한다.
   */
  private beginAugmentTargetPhase(active: PlayerState[]) {
    this.pendingTargetQueues.clear();
    const order: string[] = [];
    for (const p of active) {
      const queue = collectHandStartTargetQueue(this.ownedAugments(p), p.usedOneShotAugmentIds).map((a) => a.id);
      if (queue.length > 0) {
        this.pendingTargetQueues.set(p.sessionId, queue);
        order.push(p.sessionId);
      }
    }

    if (order.length === 0) return this.enterPreflop();

    this.setPhase('augment_target');
    this.targetPhaseOrder = order;
    this.advanceTargetPhasePlayer();
  }

  /**
   * 대상 지정이 필요한 다음 플레이어로 넘어간다 — 여러 명이 동시에 발동해야 하는
   * 상황이어도 한 명씩 순서대로만 처리해 카드 변경 알림 등이 한꺼번에 몰리지 않게 한다.
   * 봇은 짧은 딜레이 후 자동으로, 사람은 대상 지정 UI를 띄우고 응답(또는 넉넉한
   * 제한시간)을 기다린 뒤에야 다음 사람 차례로 넘어간다.
   */
  private advanceTargetPhasePlayer(): void {
    if (this.state.phase !== 'augment_target') return;
    this.targetPromptTimer?.clear();

    let nextId = this.targetPhaseOrder.shift();
    while (nextId && !this.pendingTargetQueues.has(nextId)) nextId = this.targetPhaseOrder.shift();
    if (!nextId) return this.enterPreflop(); // 대기열 전원 처리 완료

    const p = this.state.players.get(nextId);
    if (!p) return this.advanceTargetPhasePlayer();

    if (p.isBot) {
      const delay =
        BOT_TARGET_RESOLVE_DELAY_MIN_MS + Math.random() * (BOT_TARGET_RESOLVE_DELAY_MAX_MS - BOT_TARGET_RESOLVE_DELAY_MIN_MS);
      this.targetPromptTimer = this.clock.setTimeout(() => {
        this.autoResolveEntireQueue(p);
        this.advanceTargetPhasePlayer();
      }, delay);
    } else {
      this.armNextTargetPrompt(p);
    }
  }

  /**
   * 큐의 맨 앞 증강을 pendingTargetAugment에 반영하고 대상 지정 요청을 보낸다 — 이 한
   * 항목에 넉넉한 제한시간을 새로 건다(단계마다 리셋). 큐가 비었으면 이 플레이어의
   * 차례를 마치고 다음 사람으로 넘어간다.
   */
  private armNextTargetPrompt(p: PlayerState) {
    this.targetPromptTimer?.clear();
    const queue = this.pendingTargetQueues.get(p.sessionId);
    const nextId = queue?.[0];
    if (!nextId) {
      p.pendingTargetAugment = '';
      this.pendingTargetQueues.delete(p.sessionId);
      this.advanceTargetPhasePlayer();
      return;
    }
    p.pendingTargetAugment = nextId;
    this.sendAugmentTargetPrompt(p, nextId);
    this.targetPromptTimer = this.clock.setTimeout(() => {
      this.autoResolveEntireQueue(p);
      this.advanceTargetPhasePlayer();
    }, AUGMENT_TARGET_TIMEOUT_MS);
  }

  /** 대상 지정이 필요한 플레이어에게만 개별 전송 — 카드 값은 아직 안 알려준다(선택 UI는 이름/인덱스만 필요) */
  private sendAugmentTargetPrompt(p: PlayerState, augmentId: string) {
    const client = this.clients.find((c) => c.sessionId === p.sessionId);
    if (!client) return;
    const augment = this.ownedAugments(p).find((a) => a.id === augmentId);
    if (!augment) return;
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
    if (!p || !p.pendingTargetAugment) return;
    const augment = this.ownedAugments(p).find((a) => a.id === p.pendingTargetAugment);
    if (!augment) return this.advanceTargetQueueFor(p);

    const ok = this.applyInstantAugmentEffect(p, augment, message);
    if (!ok) return this.reject(client, '증강 대상 지정이 올바르지 않습니다');
    this.markOneShotUsed(p, augment);
    this.advanceTargetQueueFor(p);
  }

  /**
   * 지금 대상 지정을 띄우고 있는 증강(음침한 눈/카멜레온/당근이세요?)을 이번 핸드엔
   * 사용하지 않고 넘어간다. markOneShotUsed를 호출하지 않으므로, 일회성(카멜레온) 증강을
   * 스킵해도 "아직 한 번도 안 썼다"는 상태 그대로 유지되어 다음 핸드에 다시 재발동된다.
   */
  private handleSkipAugmentTarget(client: Client) {
    if (this.state.phase !== 'augment_target') return;
    const p = this.state.players.get(client.sessionId);
    if (!p || !p.pendingTargetAugment) return;
    this.advanceTargetQueueFor(p);
  }

  /** 일회성 증강(trigger: 'on_pick' — 카멜레온)을 소모 처리 — 이후로는 큐에 다시 담기지 않는다 */
  private markOneShotUsed(p: PlayerState, augment: Augment) {
    if (isOneShotAugment(augment) && !p.usedOneShotAugmentIds.includes(augment.id)) {
      p.usedOneShotAugmentIds.push(augment.id);
    }
  }

  /** 방금 처리한 증강을 큐에서 제거하고, 이 플레이어에게 남은 게 있으면 바로 다음 것을 띄운다 */
  private advanceTargetQueueFor(p: PlayerState) {
    this.pendingTargetQueues.get(p.sessionId)?.shift();
    this.armNextTargetPrompt(p);
  }

  /** 한 플레이어의 남은 큐 전체를 획득 순서대로 무작위 대상으로 자동 해소한다 — 봇 처리 및 타임아웃/퇴장 폴백 공용 */
  private autoResolveEntireQueue(p: PlayerState) {
    const queue = this.pendingTargetQueues.get(p.sessionId);
    if (!queue) return;
    while (queue.length > 0) {
      const augmentId = queue.shift()!;
      this.autoApplyInstantAugment(p, augmentId);
    }
    p.pendingTargetAugment = '';
    this.pendingTargetQueues.delete(p.sessionId);
  }

  /** 무작위로 유효한 대상을 골라 지정된 증강 1개를 즉시 해소 (봇/타임아웃/퇴장 폴백 공용) */
  private autoApplyInstantAugment(p: PlayerState, augmentId: string) {
    const augment = this.ownedAugments(p).find((a) => a.id === augmentId);
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
        this.applyEditCardEffect(p, { cardIndex: randomIndex(), rank, suit }, augment);
        break;
      }
      case 'swap_with_opponent': {
        const target = opponents[Math.floor(Math.random() * opponents.length)];
        if (target) {
          this.applySwapCardEffect(
            p,
            {
              targetSessionId: target.sessionId,
              targetCardIndex: randomIndex(),
              ownCardIndex: randomIndex(),
            },
            augment,
          );
        }
        break;
      }
    }
    this.markOneShotUsed(p, augment);
  }

  private applyInstantAugmentEffect(p: PlayerState, augment: Augment, message: AugmentTargetMessage): boolean {
    switch (augment.effect.type) {
      case 'reveal_opponent_card':
        return this.applyRevealCardEffect(p, message);
      case 'edit_own_card':
        return this.applyEditCardEffect(p, message, augment);
      case 'swap_with_opponent':
        return this.applySwapCardEffect(p, message, augment);
      default:
        return false;
    }
  }

  /**
   * 카드가 바뀐 순간을 전원에게 공개 브로드캐스트한다 — 실제 카드 값(숫자/무늬)은 절대
   * 담지 않고 "어느 자리의 몇 번째 카드가 어떤 증강으로 바뀌었는지"만 알린다. 다른
   * 플레이어 화면에서 해당 좌석 카드에 글로우 연출을 재생하고 짧은 텍스트 알림을 띄우는 데 쓰인다.
   */
  private broadcastCardChange(augment: Augment, changes: { sessionId: string; cardIndex: HoleIndex }[]) {
    this.broadcast('cardChange', {
      augmentId: augment.id,
      augmentName: augment.name,
      changes: changes.map((c) => ({
        ...c,
        playerName: this.state.players.get(c.sessionId)?.name ?? '',
      })),
    });
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
  private applyEditCardEffect(p: PlayerState, message: AugmentTargetMessage, augment: Augment): boolean {
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
    this.broadcastCardChange(augment, [{ sessionId: p.sessionId, cardIndex: idx }]);
    return true;
  }

  /** 당근이세요? — 지정한 상대와 홀카드 1장씩 교환. 상대에게는 평범한 hole 메시지만 가서 교체 사실/출처를 알 수 없다 */
  private applySwapCardEffect(p: PlayerState, message: AugmentTargetMessage, augment: Augment): boolean {
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
    this.broadcastCardChange(augment, [
      { sessionId: p.sessionId, cardIndex: oIdx },
      { sessionId: targetId, cardIndex: tIdx },
    ]);
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

  /**
   * "로열의 예언" — 같은 무늬 브로드웨이 카드들로 홀카드 전체 교체 (연출용 편향).
   * 대풍년으로 홀카드가 3장이면 3장 모두 브로드웨이로 채우려 시도하고, 그만큼 못
   * 찾으면(picks.length < hole.length) 포기하고 원래 손을 그대로 둔다.
   */
  private riggedBroadway(hole: Card[]): Card[] {
    const suit: Suit = SUITS[Math.floor(Math.random() * SUITS.length)];
    const picks: Card[] = [];
    for (let i = this.deck.length - 1; i >= 0 && picks.length < hole.length; i--) {
      const c = this.deck[i];
      if (c.suit === suit && c.rank >= 10) {
        picks.push(c);
        this.deck.splice(i, 1);
      }
    }
    if (picks.length < hole.length) {
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
        // 검증 2: 클라이언트가 보낸 금액은 신뢰하지 않는다 — 이 타입은 봇 AI 내부 전용이며,
        // 사람 클라이언트는 아래의 정형화된 한게임식 버튼(삥/따당/쿼터/하프/맥스)만 보낸다.
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

      // ── 한게임식 정형 배팅 버튼 — 금액은 전부 서버가 computeFixedBet()으로 계산한다.
      // 클라이언트가 보내는 amount는 무시하며, 계산된 금액이 보유 칩을 넘으면 자동 올인(min으로 캡)한다.
      case 'bet_bb':
      case 'bet_double':
      case 'bet_quarter':
      case 'bet_half': {
        const result = computeFixedBet(type, {
          currentBet: st.currentBet,
          potTotal: this.currentPotTotal(),
          bigBlind: st.bigBlind,
          streetBet: p.streetBet,
          stack: p.stack,
        });
        if (typeof result === 'string') return result;
        const before = st.currentBet;
        this.commit(p, result.pay);
        this.registerRaiseIfAny(p, before);
        const labels: Record<FixedBetType, string> = { bet_bb: '삥', bet_double: '따당', bet_quarter: '쿼터', bet_half: '하프' };
        const label = labels[type];
        p.lastAction = `${label} ${result.pay}`;
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

  /** commit() 이후, 실제로 이전 최고 베팅액(before)보다 더 냈으면(=레이즈) minRaise 갱신 + 재행동 오픈 */
  private registerRaiseIfAny(p: PlayerState, before: number) {
    if (p.streetBet <= before) return;
    this.state.minRaise = Math.max(this.state.minRaise, p.streetBet - before);
    this.reopenAction(p);
    this.raisesThisStreet += 1;
  }

  /** 화면에 표시되는 POT과 동일한 기준 — 정산된 팟 + 이번 스트리트에 각자 낸 베팅 합계 */
  private currentPotTotal(): number {
    return this.state.pot + this.seatOrder().reduce((sum, p) => sum + p.streetBet, 0);
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
    const nextPhase: Phase = st.phase === 'preflop' ? 'flop' : st.phase === 'flop' ? 'turn' : 'river';

    // 밑장빼기 — 아직 사용하지 않은 보유자가 있으면(전원 올인이라 더 이상 액션이 없는
    // 러너 상황은 제외 — canAct 기준 실제로 액션 가능한 인원만) 공개 직전 사용 여부를 묻는다
    const eligible = canAct.filter((p) => !p.bottomDealUsed && findByEffect(this.ownedAugments(p), 'bottom_deal'));
    if (eligible.length === 0) {
      this.setPhase(nextPhase);
      this.dealBoard(dealCount);
      const first = this.firstActor();
      if (!first) return this.runoutAndShowdown();
      return this.setTurn(first);
    }

    this.pendingStreetPhase = nextPhase;
    this.pendingStreetDealCount = dealCount;
    this.streetRevealBurnCount = 0;
    this.streetRevealQueue = eligible.map((p) => p.sessionId);
    this.setPhase('street_reveal_choice');
    this.advanceStreetRevealPlayer();
  }

  /** 밑장빼기 대상 지정 큐의 다음 사람 — 전원 처리되면 실제로 스트리트를 진행한다 */
  private advanceStreetRevealPlayer(): void {
    if (this.state.phase !== 'street_reveal_choice') return;
    this.streetRevealPromptTimer?.clear();
    this.streetRevealCurrentId = null;

    const nextId = this.streetRevealQueue.shift();
    if (!nextId) return this.resolveStreetReveal();
    const p = this.state.players.get(nextId);
    if (!p) return this.advanceStreetRevealPlayer();

    if (p.isBot) {
      const delay =
        BOT_TARGET_RESOLVE_DELAY_MIN_MS + Math.random() * (BOT_TARGET_RESOLVE_DELAY_MAX_MS - BOT_TARGET_RESOLVE_DELAY_MIN_MS);
      this.streetRevealPromptTimer = this.clock.setTimeout(() => {
        this.resolveBottomDealChoice(p, Math.random() < 0.4);
        this.advanceStreetRevealPlayer();
      }, delay);
      return;
    }

    this.streetRevealCurrentId = p.sessionId;
    const client = this.clients.find((c) => c.sessionId === p.sessionId);
    client?.send('bottomDealPrompt', {});
    this.streetRevealPromptTimer = this.clock.setTimeout(() => {
      this.resolveBottomDealChoice(p, false); // 시간 초과 = 사용 안 함(스킵), 라운드 내 재사용 가능하지 않음
      this.advanceStreetRevealPlayer();
    }, AUGMENT_TARGET_TIMEOUT_MS);
  }

  private handleBottomDealChoice(client: Client, message: { use?: unknown }) {
    if (this.state.phase !== 'street_reveal_choice') return;
    if (client.sessionId !== this.streetRevealCurrentId) return;
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    this.streetRevealPromptTimer?.clear();
    this.streetRevealCurrentId = null;
    this.resolveBottomDealChoice(p, message?.use === true);
    this.advanceStreetRevealPlayer();
  }

  /** 밑장빼기 사용 여부 확정 — 라운드당 1회 소모되며, 사용을 선택했을 때만 버림 카드 수가 늘어난다 */
  private resolveBottomDealChoice(p: PlayerState, use: boolean) {
    p.bottomDealUsed = true;
    if (use) {
      this.streetRevealBurnCount += 1;
      this.broadcast('notice', { text: `🃏 ${p.name}님이 밑장을 뺐습니다` });
    }
  }

  /** street_reveal_choice 큐가 전부 끝나면 실제로 카드를 (필요시 버림 후) 공개하고 스트리트를 진행한다 */
  private resolveStreetReveal() {
    const nextPhase = this.pendingStreetPhase;
    const dealCount = this.pendingStreetDealCount;
    this.pendingStreetPhase = null;
    this.pendingStreetDealCount = 0;
    if (!nextPhase) return;

    for (let i = 0; i < this.streetRevealBurnCount; i++) this.deck.pop();
    this.streetRevealBurnCount = 0;

    this.setPhase(nextPhase);
    this.dealBoard(dealCount);
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

    // 러시안 룰렛 — 누구 한 명이라도 보유하면(소유자만 유리한 게 아니라) 전원 동일하게
    // 무작위 커뮤니티 카드 1장을 제외하고 판정한다. 이 라운드에서 실제로 발동했으면
    // result 브로드캐스트에 제거된 카드 id를 실어 클라이언트가 X 표시로 연출한다.
    const hasRoulette = contenders.some((p) => findByEffect(this.ownedAugments(p), 'remove_random_community'));
    let evalBoard = this.board;
    let removedCard: Card | null = null;
    if (hasRoulette && this.board.length > 0) {
      const idx = Math.floor(Math.random() * this.board.length);
      removedCard = this.board[idx];
      evalBoard = this.board.filter((_, i) => i !== idx);
    }

    const results: { p: PlayerState; hand: HandResult }[] = contenders.map((p) => ({
      p,
      hand: evaluateBest([...this.holes.get(p.sessionId)!, ...evalBoard]),
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
      removedCommunityCardId: removedCard?.id,
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
    this.targetPromptTimer?.clear();
    this.streetRevealPromptTimer?.clear();
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
    const augment = findByEffect(this.ownedAugments(p), 'card_swap');
    if (!augment) return this.reject(client, '카드 재구성 증강이 없습니다');
    if (p.swapUsed) return this.reject(client, '이번 핸드에 이미 교체했습니다');

    const index = Math.floor(Number(message?.index));
    if (index !== 0 && index !== 1) return this.reject(client, '카드 인덱스는 0 또는 1이어야 합니다');

    const hole = this.holes.get(client.sessionId);
    const newCard = this.deck.pop();
    if (!hole || !newCard) return;
    hole[index] = newCard;
    p.swapUsed = true;
    this.sendHole(client.sessionId);
    this.broadcastCardChange(augment, [{ sessionId: client.sessionId, cardIndex: index }]);
  }

  // ─────────────────────────── 증강: 리셋 버튼 ───────────────────────────

  /**
   * 리셋 버튼 — 본인 차례에 한해(카드 재구성과 달리 "본인 턴에 사용 가능"이 스펙이라
   * activePlayerId까지 검증한다), 라운드당 1회, 현재 공개된 커뮤니티 카드를 전부 버리고
   * 같은 장수만큼 새로 딜링한다. 베팅/팟은 건드리지 않고, 액션을 소비하지도 않는다 —
   * 리셋 후에도 본인은 이어서 정상적으로 폴드/체크/콜/레이즈를 선택할 수 있다.
   *
   * 사용 시점은 플랍(커뮤니티 3번째 장 공개) 단계까지만으로 제한한다 — 턴(4번째 장)이
   * 공개된 뒤에는 더 이상 사용할 수 없다(기획 스펙 — 프리플랍은 보드 자체가 없어 애초에
   * 대상이 없고, 턴/리버까지 허용하면 상대가 이미 베팅한 정보를 본 뒤에 보드를 통째로
   * 되돌릴 수 있어 밸런스가 깨진다).
   */
  private handleResetBoard(client: Client) {
    const st = this.state;
    if (st.phase !== 'flop')
      return this.reject(client, '리셋 버튼은 플랍(3번째 보드 카드) 공개 시점까지만 사용할 수 있습니다');
    if (client.sessionId !== st.activePlayerId) return this.reject(client, '본인 차례에만 사용할 수 있습니다');
    const p = st.players.get(client.sessionId);
    if (!p || p.isFolded) return;
    const augment = findByEffect(this.ownedAugments(p), 'reset_board');
    if (!augment) return this.reject(client, '리셋 버튼 증강이 없습니다');
    if (p.resetBoardUsed) return this.reject(client, '이번 라운드에 이미 사용했습니다');
    if (this.board.length === 0) return this.reject(client, '아직 공개된 보드가 없습니다');

    const count = this.board.length;
    this.board = [];
    st.community.clear();
    this.dealBoard(count);
    p.resetBoardUsed = true;
    this.broadcast('notice', { text: `🔄 ${p.name}님이 보드를 리셋했습니다` });
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

  /** 보유 증강을 획득(선택) 순서 그대로 반환한다 — 여러 증강이 겹칠 때 재발동 순서의 기준이 된다 */
  private ownedAugments(p: PlayerState): Augment[] {
    return p.augmentIds
      .map((id) => AUGMENT_POOL.find((a) => a.id === id))
      .filter((a): a is Augment => !!a);
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
    const potSize = this.currentPotTotal();

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
