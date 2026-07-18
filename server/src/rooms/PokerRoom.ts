/**
 * PokerRoom — 서버 권위(Server-Authoritative) 증강 포커 룸.
 *
 * 원칙:
 *  - 셔플/딜링/판정은 전부 서버에서만 수행 (덱·홀카드는 스키마 밖 private 필드)
 *  - 클라이언트 메시지는 전부 검증 후 적용 (차례, phase, 금액 정수/범위, 증강 소유 여부)
 *  - 게임 루프: [augment 선택] → betting(프리플랍→리버) → showdown → roundResult → 다음 라운드
 */

import { Room, type Client, type Delayed } from 'colyseus';
import { PokerState, PlayerState, toCardSchema, type Phase } from '../schema/PokerState';
import type { Card, Suit } from '../engine/types';
import { SUITS } from '../engine/types';
import { createDeck, shuffle } from '../engine/deck';
import { evaluateBest, compareHands, type HandResult } from '../engine/handEvaluator';
import {
  applyPayoutAugments,
  rollAugmentChoices,
  findByEffect,
  type Augment,
} from '../engine/augmentEngine';
import augmentsData from '../data/augments.json';

const AUGMENT_POOL = augmentsData as Augment[];

const START_STACK = 5000;
const ANTE = 100;
const MAX_ROUNDS = 5;
const TURN_TIMEOUT_MS = 30_000;
const AUGMENT_TIMEOUT_MS = 20_000;
const RESULT_DELAY_MS = 5_000;

type ActionMessage = { type?: unknown; amount?: unknown };

export class PokerRoom extends Room<PokerState> {
  maxClients = 4;

  /** 서버 전용 — 클라이언트에 절대 동기화되지 않는 비밀 상태 */
  private deck: Card[] = [];
  private holes = new Map<string, Card[]>();
  private board: Card[] = [];
  /** 이번 라운드 각 플레이어에게 제시된 증강 선택지 (검증용 원본) */
  private pendingChoices = new Map<string, Augment[]>();

  private dealerIndex = 0;
  private turnTimer?: Delayed;
  private augmentTimer?: Delayed;

  onCreate() {
    this.state = new PokerState();
    this.state.maxRounds = MAX_ROUNDS;

    this.onMessage('action', (client, message: ActionMessage) => this.handleAction(client, message));
    this.onMessage('chooseAugment', (client, message: { id?: unknown }) =>
      this.handleChooseAugment(client, message),
    );
    this.onMessage('swapCard', (client, message: { index?: unknown }) =>
      this.handleSwapCard(client, message),
    );
  }

  onJoin(client: Client, options?: { name?: unknown }) {
    const p = new PlayerState();
    p.sessionId = client.sessionId;
    const rawName = typeof options?.name === 'string' ? options.name.trim() : '';
    p.name = rawName.slice(0, 12) || `플레이어${this.state.players.size + 1}`;
    p.stack = START_STACK;
    this.state.players.set(client.sessionId, p);

    // MVP: 2명이 모이면 즉시 시작하고 방을 잠근다
    if (this.state.players.size >= 2 && this.state.phase === 'waiting') {
      void this.lock();
      this.state.round = 1;
      this.beginRound();
    }
  }

  onLeave(client: Client) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.connected = false;
    p.folded = true;
    this.pendingChoices.delete(client.sessionId);

    const remaining = this.seatOrder().filter((o) => o.connected);
    if (this.state.phase === 'waiting' || this.state.phase === 'gameOver') {
      this.state.players.delete(client.sessionId);
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
    if (this.state.phase === 'augment') return this.checkAllChosen();
    if (this.state.phase === 'betting') {
      if (this.state.activePlayerId === client.sessionId) this.resolveAfterAction();
      else this.resolveAfterAction();
    }
  }

  // ─────────────────────────── 라운드 / 증강 선택 phase ───────────────────────────

  /** 라운드 시작: 각 플레이어에게 증강 3개 제시 (기획서 4장) */
  private beginRound() {
    this.setPhase('augment');
    this.pendingChoices.clear();

    let anyChoices = false;
    for (const p of this.seatOrder()) {
      p.augmentChoices.clear();
      if (!p.connected || p.stack <= 0) continue;
      const choices = rollAugmentChoices(AUGMENT_POOL, this.ownedAugments(p), 3);
      if (choices.length === 0) continue;
      anyChoices = true;
      this.pendingChoices.set(p.sessionId, choices);
      choices.forEach((c) => p.augmentChoices.push(c.id));
    }

    if (!anyChoices) return this.startHand();
    // 제한시간 내 미선택 시 자동 선택
    this.augmentTimer = this.clock.setTimeout(() => this.autoPickAugments(), AUGMENT_TIMEOUT_MS);
  }

  private handleChooseAugment(client: Client, message: { id?: unknown }) {
    if (this.state.phase !== 'augment') return;
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
    if (this.pendingChoices.size === 0 && this.state.phase === 'augment') {
      this.augmentTimer?.clear();
      this.startHand();
    }
  }

  private autoPickAugments() {
    for (const [sessionId, choices] of this.pendingChoices) {
      const p = this.state.players.get(sessionId);
      if (p && choices.length > 0) {
        p.augmentIds.push(choices[0].id);
        p.augmentChoices.clear();
      }
    }
    this.pendingChoices.clear();
    if (this.state.phase === 'augment') this.startHand();
  }

  // ─────────────────────────── 핸드 시작 / 딜링 ───────────────────────────

  /** 핸드 시작 — 셔플·딜링은 서버에서만. 홀카드는 각자에게 개별 전송 */
  private startHand() {
    const st = this.state;
    st.street = 'preflop';
    st.pot = 0;
    st.currentBet = 0;
    st.minRaise = ANTE;
    st.community.clear();
    this.board = [];
    this.holes.clear();
    this.deck = shuffle(createDeck());

    for (const p of this.seatOrder()) {
      p.folded = !p.connected || p.stack <= 0; // 빈 스택은 이번 핸드 자동 관전
      p.allIn = false;
      p.hasActed = false;
      p.streetBet = 0;
      p.swapUsed = false;
      p.lastAction = '';
      p.revealedHole.clear();
    }

    const active = this.actingPlayers();
    if (active.length < 2) return this.endGame('플레이 가능 인원 부족');

    // 앤티
    for (const p of active) {
      const ante = Math.min(ANTE, p.stack);
      p.stack -= ante;
      st.pot += ante;
      if (p.stack === 0) p.allIn = true;
    }

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

    this.setPhase('betting');
    const first = this.firstActor();
    if (!first) return this.runoutAndShowdown(); // 전원 앤티 올인
    st.activePlayerId = first.sessionId;
    this.armTurnTimer();
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
    if (st.phase !== 'betting') return this.reject(client, '지금은 베팅 시간이 아닙니다');
    if (client.sessionId !== st.activePlayerId) return this.reject(client, '당신의 차례가 아닙니다');
    const p = st.players.get(client.sessionId);
    if (!p || p.folded || p.allIn) return;

    const type = typeof message?.type === 'string' ? message.type : '';
    const toCall = st.currentBet - p.streetBet;

    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = '다이';
        break;

      case 'check':
        if (toCall > 0) return this.reject(client, `체크 불가 — 콜 ${toCall} 필요`);
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
        const amount = Math.floor(Number(message?.amount));
        if (!Number.isSafeInteger(amount) || amount <= 0)
          return this.reject(client, '레이즈 금액이 올바르지 않습니다');
        const pay = toCall + amount;
        if (pay > p.stack) return this.reject(client, '스택이 부족합니다');
        if (amount < st.minRaise && pay < p.stack)
          return this.reject(client, `최소 레이즈는 ${st.minRaise}입니다`);
        this.commit(p, pay);
        st.minRaise = amount;
        this.reopenAction(p);
        p.lastAction = `레이즈 +${amount}`;
        break;
      }

      case 'allin': {
        const pay = p.stack;
        if (pay <= 0) return;
        const raiseAmount = p.streetBet + pay - st.currentBet;
        this.commit(p, pay);
        if (raiseAmount > 0) {
          st.minRaise = Math.max(st.minRaise, raiseAmount);
          this.reopenAction(p);
        }
        p.lastAction = '올인';
        break;
      }

      default:
        return this.reject(client, '알 수 없는 액션입니다');
    }

    p.hasActed = true;
    this.resolveAfterAction();
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
    if (st.phase !== 'betting') return;

    const alive = this.actingPlayers();
    if (alive.length <= 1) return this.endByFold(alive[0]);

    const canAct = alive.filter((p) => !p.allIn);
    const betsMatched = alive.every((p) => p.allIn || p.streetBet === st.currentBet);
    const allActed = canAct.every((p) => p.hasActed);

    if (canAct.length === 0 || (betsMatched && allActed)) return this.advanceStreet();

    const next = this.nextActor(st.activePlayerId);
    if (!next) return this.advanceStreet();
    st.activePlayerId = next.sessionId;
    this.armTurnTimer();
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
    st.minRaise = ANTE;
    st.activePlayerId = '';

    const alive = this.actingPlayers();
    const canAct = alive.filter((p) => !p.allIn);
    if (st.street === 'river' || canAct.length <= 1) return this.runoutAndShowdown();

    const dealCount = st.street === 'preflop' ? 3 : 1;
    st.street = st.street === 'preflop' ? 'flop' : st.street === 'flop' ? 'turn' : 'river';
    this.dealBoard(dealCount);

    const first = this.firstActor();
    if (!first) return this.runoutAndShowdown();
    st.activePlayerId = first.sessionId;
    this.armTurnTimer();
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
    st.activePlayerId = '';

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

    this.setPhase('roundResult');
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
    st.activePlayerId = '';
    this.setPhase('roundResult');
    this.clock.setTimeout(() => this.endRound(), RESULT_DELAY_MS);
  }

  private endRound() {
    if (this.state.phase !== 'roundResult') return;
    const solvent = this.seatOrder().filter((p) => p.connected && p.stack > 0);
    if (this.state.round >= MAX_ROUNDS || solvent.length < 2) return this.endGame('라운드 종료');
    this.state.round += 1;
    this.dealerIndex += 1;
    this.beginRound();
  }

  private endGame(reason: string) {
    this.clearTurnTimer();
    this.augmentTimer?.clear();
    this.setPhase('gameOver');
    this.state.activePlayerId = '';
    const standings = this.seatOrder()
      .map((p) => ({ sessionId: p.sessionId, name: p.name, stack: p.stack, connected: p.connected }))
      .sort((a, b) => b.stack - a.stack);
    this.broadcast('gameOver', { reason, standings, winner: standings[0] ?? null });
  }

  // ─────────────────────────── 증강: 카드 재구성 ───────────────────────────

  private handleSwapCard(client: Client, message: { index?: unknown }) {
    if (this.state.phase !== 'betting') return this.reject(client, '지금은 교체할 수 없습니다');
    const p = this.state.players.get(client.sessionId);
    if (!p || p.folded) return;
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

  private seatOrder(): PlayerState[] {
    return [...this.state.players.values()];
  }

  /** 폴드하지 않고 연결된 플레이어 (올인 포함) */
  private actingPlayers(): PlayerState[] {
    return this.seatOrder().filter((p) => !p.folded && p.connected);
  }

  /** 딜러 다음 순서부터 행동 가능한 첫 플레이어 */
  private firstActor(): PlayerState | null {
    const order = this.seatOrder();
    for (let i = 0; i < order.length; i++) {
      const p = order[(this.dealerIndex + 1 + i) % order.length];
      if (!p.folded && p.connected && !p.allIn) return p;
    }
    return null;
  }

  private nextActor(fromSessionId: string): PlayerState | null {
    const order = this.seatOrder();
    const start = order.findIndex((p) => p.sessionId === fromSessionId);
    for (let i = 1; i <= order.length; i++) {
      const p = order[(start + i) % order.length];
      if (!p.folded && p.connected && !p.allIn) return p;
    }
    return null;
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
      if (!p || this.state.phase !== 'betting' || this.state.activePlayerId !== sessionId) return;
      const toCall = this.state.currentBet - p.streetBet;
      if (toCall > 0) {
        p.folded = true;
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
}
