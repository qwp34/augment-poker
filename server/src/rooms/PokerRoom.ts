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
import { evaluateBest, compareHands, type HandResult, type HandCategory } from '../engine/handEvaluator';
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
import { SettlementTracker } from '../engine/settlement';
import { supabaseAdmin, isSupabaseConfigured } from '../lib/supabaseAdmin';
import augmentsData from '../data/augments.json';

const AUGMENT_POOL = augmentsData as Augment[];

/** 게임 입장 바이인 겸 시작 스택 — 로그인 유저는 이 금액이 profiles.chips에서
 *  차감되고(부족하면 GREATEST로 먼저 채워짐, deduct_chips 참고), 게스트/봇은 그냥
 *  이 값으로 시작한다. */
const INITIAL_CHIPS = 5000;
const SMALL_BLIND = 50;
const BIG_BLIND = 100;
const MAX_NAME_LENGTH = 8;
const MAX_ROUNDS = 5;
const TURN_TIMEOUT_MS = 30_000;
/** 증강 선택 — 20초는 자유롭게 고민(타이머 비표시), 이후 10초는 카운트다운 표시 후 자동 선택.
 *  클라이언트(AugmentSelectScreen.tsx)가 같은 두 값을 그대로 미러링해 카운트다운을 근사
 *  재현한다 — 실제 자동 선택 판정은 여기 서버 타이머가 유일한 기준이라 클라이언트가
 *  조작할 수 없다. 두 파일의 상수를 바꿀 땐 항상 같이 맞춰야 한다. */
const AUGMENT_THINK_MS = 20_000;
const AUGMENT_COUNTDOWN_MS = 10_000;
const AUGMENT_TIMEOUT_MS = AUGMENT_THINK_MS + AUGMENT_COUNTDOWN_MS;
/**
 * 즉시형 증강(음침한 눈/카멜레온/당근이세요?) 대상 지정 제한시간 — 한 단계(예: 카멜레온의
 * "카드 선택"/"숫자 선택"/"무늬 선택" 중 하나)당 주어지는 시간. 예전엔 큐 전체에 15초
 * 하나만 걸려 있어 여러 항목을 골라야 하면 체감상 너무 급했다 — 단계마다 새로 리셋되는
 * 넉넉한 시간으로 늘렸다(그래도 AFK로 게임 전체가 멈추지 않도록 완전히 없애지는 않음).
 */
const AUGMENT_TARGET_TIMEOUT_MS = 45_000;
const RESULT_DELAY_MS = 5_000;
/** 쇼다운 순차 공개 연출(클라이언트, PokerTable.tsx)이 다 재생될 시간을 벌어주는 지연 —
 * 이 시간이 끝나야 beginRound()가 phase를 'augment_select'로 바꾸고, 그 phase 전환이
 * 클라이언트의 결과 배너를 지운다(useMultiplayerRoom.ts). 클라이언트 연출 타임라인과
 * 맞춰 여유를 두고 늘렸다 — 정확히 맞출 필요는 없고, 연출보다 짧지만 않으면 된다.
 * (홀카드 공개 → 턴 1200ms → 리버 1400ms → 결과 1600ms 타임라인 기준 최대 약 9.8초 +
 * 배너를 읽을 여유를 더해 12초로 잡았다 — 계산 근거는 PokerTable.tsx의 SD_* 상수 주석 참고.) */
const SHOWDOWN_RESULT_DELAY_MS = 12_000;
/** 러시안 룰렛이 발동한 쇼다운 — 순차 공개 연출 뒤에 원래 족보/카운트다운/총성 연출까지
 * 이어지므로 훨씬 더 오래 걸린다(최대 약 14.9초 + 여유 → 18초). */
const ROULETTE_RESULT_DELAY_MS = 18_000;
const BOT_ACT_DELAY_MIN_MS = 600;
const BOT_ACT_DELAY_MAX_MS = 1_400;
/** 봇의 대상 지정형 증강 자동 처리 딜레이 — 여러 명이 몰려도 한 명씩 자연스럽게 순서대로 보이도록 */
const BOT_TARGET_RESOLVE_DELAY_MIN_MS = 700;
const BOT_TARGET_RESOLVE_DELAY_MAX_MS = 1_400;
/** 예고 홈런 — 선언한 족보 적중 시 보너스 배율(획득한 팟의 N배를 추가 지급) */
const PROPHECY_BONUS_MULTIPLIER = 3;
/** 예고 홈런 보너스 상한 — 팟이 매우 커진 상황에서 보너스 한 방에 게임이 끝나버리는 게
 * 밸런스상 괜찮은지는 실제 플레이해보고 정한다. null이면 상한 없음(지금은 없음). */
const PROPHECY_BONUS_CAP: number | null = null;

/** 베팅 액션을 받는 phase 집합 — preflop/flop/turn/river 각각이 곧 스트리트다 */
const BETTING_PHASES = new Set<Phase>(['preflop', 'flop', 'turn', 'river']);
/** 예고 홈런 선언 가능 족보 목록 — handEvaluator의 HandCategory와 동일 순서(하이카드~로열플러시) */
const HAND_CATEGORIES: HandCategory[] = [
  'high_card',
  'pair',
  'two_pair',
  'three_of_a_kind',
  'straight',
  'flush',
  'full_house',
  'four_of_a_kind',
  'straight_flush',
  'royal_flush',
];

type ActionMessage = { type?: unknown; amount?: unknown };

/** 즉시형 증강 대상 지정 메시지 — 효과 종류에 따라 필요한 필드만 채워 보낸다 */
type AugmentTargetMessage = {
  targetSessionId?: unknown;
  targetCardIndex?: unknown;
  ownCardIndex?: unknown;
  cardIndex?: unknown;
  rank?: unknown;
  suit?: unknown;
  /** 예고 홈런 — 선언할 목표 족보 */
  handType?: unknown;
};

function toHoleIndex(value: unknown): HoleIndex | null {
  return value === 0 || value === 1 ? value : null;
}

/**
 * onAuth()의 반환값 — Colyseus는 onAuth를 오버라이드하면 falsy 반환 시 무조건 입장을
 * 거부한다(게스트 포함). 그래서 "인증 없음"도 별도의 truthy 값({guest:true})으로
 * 표현해야 한다 — null/false를 반환하면 게스트 플레이 자체가 막혀버린다.
 */
type PokerAuth = { userId: string; nickname: string } | { guest: true };

export class PokerRoom extends Room<PokerState> {
  maxClients = 4;

  /** 서버 전용 — 클라이언트에 절대 동기화되지 않는 비밀 상태 */
  private deck: Card[] = [];
  private holes = new Map<string, Card[]>();
  private board: Card[] = [];
  /** 매 핸드(startHand)마다 1씩 증가 — 카드 id에 섞어 넣어 핸드 간 id 충돌을 막는다
   *  (createDeck()의 id는 "suit-rank"뿐이라 다음 핸드에 같은 카드가 재등장하면 id가
   *  그대로 겹친다. 러시안 룰렛으로 제외된 카드 id를 클라이언트가 그대로 들고 있다가
   *  다음 핸드의 커뮤니티 카드와 우연히 id가 같아지면 엉뚱한 카드에 X가 뜨는 원인이 됐다) */
  private handSeq = 0;
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
  /** 현재 턴이 자동으로 넘어가는 시각(ms epoch) — 장고의 시간으로 타이머를 연장할 때
   * "지금까지 얼마나 남았는지"를 계산하는 기준이 된다. armTurnTimer()가 매번 갱신한다. */
  private turnDeadline = 0;

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

  /** 로그인 유저(sessionId → userId)가 게임당 정확히 한 번만 정산되도록 추적 */
  private settlement = new SettlementTracker();

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
    this.onMessage('extendTurnTimer', (client) => this.handleExtendTurnTimer(client));
    this.onMessage('startGame', (client) => this.handleStartGame(client));
  }

  /**
   * 로그인 유저의 신원 확인 + 바이인 차감 — onJoin보다 먼저 실행되며, Colyseus는 이
   * 반환값이 falsy면 무조건 입장을 거부한다(게스트 포함) — 그래서 "인증 없음"도
   * {guest:true}라는 truthy 값으로 표현한다.
   *
   * 검증(토큰) → 차감(RPC) → 반환 순서를 반드시 지킨다: 차감이 성공한 뒤에는 실패할
   * 코드가 전혀 없어야 한다(단순 객체 리터럴 반환뿐) — 그래야 "차감은 됐는데 어디에도
   * 기록되지 않아 환불 경로를 못 찾는" 상태가 생기지 않는다.
   */
  async onAuth(_client: Client, options?: { accessToken?: unknown }): Promise<PokerAuth> {
    const token = typeof options?.accessToken === 'string' ? options.accessToken : '';
    if (!isSupabaseConfigured || !token || !supabaseAdmin) return { guest: true };

    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData?.user) {
      throw new Error('로그인 세션이 만료되었습니다. 다시 로그인해주세요.');
    }

    // deduct_chips는 잔액이 바이인(INITIAL_CHIPS)보다 적어도(0골드 포함) 먼저 그만큼
    // 채운 뒤 차감하므로(GREATEST) 이제 "칩 부족으로 입장 거부"라는 경우 자체가 없다 —
    // 항상 정확히 1행을 반환한다. 그래도 0행이 오거나 error가 나면(권한 오류·네트워크
    // 오류·존재하지 않는 유저 등 진짜 실패) 잔액 문제가 아니라 일시적 오류로 안내한다
    // (SUPABASE_SERVICE_ROLE_KEY가 실제로는 publishable/anon 키였을 때 매번 permission
    // denied로 실패했던 사례가 있었다 — 그때도 "칩 부족"으로 잘못 보고돼 원인 파악이 안 됐다).
    const { data: rows, error: deductError } = await supabaseAdmin.rpc('deduct_chips', {
      p_user_id: userData.user.id,
      p_amount: INITIAL_CHIPS,
    });
    // 사용자에게 보여주는 문구는 일부러 뭉뚱그리지만("일시적인 오류"), 서버 콘솔에는
    // 항상 RPC 응답 전문을 그대로 남긴다 — 그래야 다음에 같은 문제가 나도 스크립트를
    // 새로 짜서 재현할 필요 없이 로그만 보고 바로 원인을 알 수 있다. 실제로 겪은 두 원인:
    //  1) SUPABASE_SERVICE_ROLE_KEY가 service role이 아니라 publishable/anon 키였던 경우
    //     → error.code 42501 "permission denied for function deduct_chips"
    //  2) supabase/schema.sql의 GREATEST 기반 마이그레이션을 아직 실행 안 한 경우
    //     → 옛 버전 deduct_chips가 "chips >= p_amount"에서 걸려 0행 반환(error 없음) —
    //     0골드/저잔액 계정에서만 재현되고 고잔액 계정에선 안 보여서 헷갈리기 쉽다.
    console.log('[PokerRoom] deduct_chips 응답:', JSON.stringify({ userId: userData.user.id, amount: INITIAL_CHIPS, rows, error: deductError }, null, 2));
    if (deductError) {
      console.error(
        '[PokerRoom] deduct_chips RPC 실패 — SUPABASE_SERVICE_ROLE_KEY가 올바른 service role(secret) 키인지 확인할 것:',
        deductError,
      );
      throw new Error('일시적인 오류로 입장할 수 없습니다. 잠시 후 다시 시도해주세요.');
    }
    if (!rows || rows.length === 0) {
      console.error(
        '[PokerRoom] deduct_chips가 에러 없이 0행을 반환함 — GREATEST 기반 최신 SQL이 실제로 적용됐는지' +
          ' Supabase SQL Editor에서 확인할 것(supabase/schema.sql 참고). 정상이라면 항상 1행을 반환해야 한다.',
      );
      throw new Error('일시적인 오류로 입장할 수 없습니다. 잠시 후 다시 시도해주세요.');
    }
    return { userId: userData.user.id, nickname: rows[0].nickname };
  }

  onJoin(client: Client, options?: { name?: unknown; isBot?: unknown }, auth?: PokerAuth) {
    const authed = auth && 'userId' in auth ? auth : null;

    const p = new PlayerState();
    p.sessionId = client.sessionId;
    p.seatIndex = this.assignSeat();
    p.isBot = options?.isBot === true;
    // 로그인 유저는 서버가 확인한 프로필 닉네임을 그대로 쓴다 — 실제 칩이 걸린 신원을
    // 클라이언트가 보낸 임의의 표시 이름으로 대체(스푸핑)하지 못하게 한다.
    p.name = authed ? this.resolvePlayerName(authed.nickname) : this.resolvePlayerName(options?.name);
    p.stack = INITIAL_CHIPS;
    // 게임이 이미 진행 중이면 이번 핸드는 관전, 다음 라운드부터 합류
    if (this.state.phase !== 'waiting') p.isFolded = true;
    this.state.players.set(client.sessionId, p);

    if (authed) this.settlement.track(client.sessionId, authed.userId);

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
      bot.stack = INITIAL_CHIPS;
      this.state.players.set(bot.sessionId, bot);
      this.botPersonas.set(bot.sessionId, Math.random() < 0.5 ? 'aggressive' : 'cautious');
    }
  }

  async onLeave(client: Client) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.connected = false;
    p.isFolded = true;
    this.pendingChoices.delete(client.sessionId);

    const remaining = this.seatOrder().filter((o) => o.connected);
    if (this.state.phase === 'waiting' || this.state.phase === 'gameOver') {
      // 'gameOver'면 endGame()에서 이미 정산이 끝났을 것(settlePlayer는 정확히 한 번만
      // 실행되도록 SettlementTracker가 보장). 'waiting'이면 게임 시작 전 이탈이라
      // 여기가 유일한 정산 지점 — 안 하면 입장 시 차감한 바이인이 그대로 증발한다.
      await this.settlePlayer(client.sessionId, p.stack);
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
      await this.endGame('상대 퇴장');
      return;
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
      const choices = rollAugmentChoices(AUGMENT_POOL, this.ownedAugments(p), this.state.round, 3);
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
   * 증강을 실제로 획득(augmentIds에 추가)하는 공통 지점 — 대상 지정 없이 "고르는 즉시"
   * 부수효과가 있는 증강이 생기면 여기서 함께 처리한다(지금은 없음, 훅만 유지).
   */
  private grantAugment(p: PlayerState, augment: Augment) {
    p.augmentIds.push(augment.id);
  }

  /**
   * 봇의 증강 선택 — 지금은 무작위, 추후 botAI 판단 로직과 함께 확장 가능.
   * 선택은 그저 보유 목록에 추가할 뿐, 효과는 여기서 발동하지 않는다 — 대상 지정이
   * 필요한 증강이든 아니든 실제 발동은 매 핸드 시작 시 beginAugmentTargetPhase/
   * startHand에서 보유 증강 전체를 훑으며 재처리한다.
   */
  private chooseAugmentForBot(p: PlayerState, choices: Augment[]) {
    const chosen = choices[Math.floor(Math.random() * choices.length)];
    this.grantAugment(p, chosen);
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
    this.grantAugment(p, chosen);
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
    // 시간 초과로 실제 누군가 자동 선택되는 경우에만 알린다 — checkAllChosen()이 전원
    // 선택 완료 시 이 타이머를 이미 clear()하므로, 여기 도달했다는 것 자체가 곧 "적어도
    // 한 명은 못 골랐다"는 뜻이다.
    if (this.pendingChoices.size > 0) {
      this.broadcast('notice', { text: '⏰ 시간 초과 — 첫 번째 증강이 선택되었습니다' });
    }
    for (const [sessionId, choices] of this.pendingChoices) {
      const p = this.state.players.get(sessionId);
      if (p && choices.length > 0) {
        this.grantAugment(p, choices[0]);
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
    this.handSeq += 1;
    this.deck = shuffle(createDeck()).map((c) => ({ ...c, id: `${c.id}#${this.handSeq}` }));

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
      // 예고 홈런 — 선언은 매 핸드 새로 한다(다음 beginAugmentTargetPhase에서 다시 큐에 담김).
      // deepThinkUsed는 여기서 절대 건드리지 않는다 — 라운드가 아니라 게임 전체 단위로
      // 유지돼야 하는 값이다.
      p.declaredHandCategory = '';
    }

    const active = this.actingPlayers();
    if (active.length < 2) {
      void this.endGame('플레이 가능 인원 부족');
      return;
    }

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
      case 'declare_hand': {
        // 봇/타임아웃 자동 선언 — 낮은 족보 쪽으로 편향(제곱 분포)을 줘서 로열 플러시 같은
        // 사실상 불가능한 선언을 남발하지 않게 한다. 그래도 무작위성은 남겨 둔다.
        const idx = Math.min(HAND_CATEGORIES.length - 1, Math.floor(Math.random() ** 2 * HAND_CATEGORIES.length));
        this.applyDeclareHandEffect(p, { handType: HAND_CATEGORIES[idx] });
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
      case 'declare_hand':
        return this.applyDeclareHandEffect(p, message);
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

  /**
   * 예고 홈런 — 이번 핸드에 완성하겠다고 선언한 족보를 기록한다. 카드 값을 바꾸는 다른
   * 즉시형 효과와 달리 상태 변경이 스키마 필드(declaredHandCategory) 자체라 다른 플레이어
   * 에게도 그대로 실시간 동기화된다(심리전 요소 — 공개 표시가 의도된 사양).
   */
  private applyDeclareHandEffect(p: PlayerState, message: AugmentTargetMessage): boolean {
    const handType = typeof message.handType === 'string' ? message.handType : '';
    if (!HAND_CATEGORIES.includes(handType as HandCategory)) return false;
    p.declaredHandCategory = handType;
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
    // 아직 5장이 안 갖춰진 상태로 쇼다운에 들어왔다 = 더 이상 베팅이 불가능해서(전원 올인 /
    // 한 명만 남았는데 그마저 콜해서 더 진행할 액션이 없음 / 그 밖에 액션 가능자가 없는 경우)
    // 남은 스트리트를 전부 건너뛰고 한 번에 왔다는 뜻 — 이 경우에만 클라이언트가
    // "SHOW DOWN" 연출 + 보드 순차 공개를 재생한다. 정상적으로 리버까지 매 스트리트
    // 베팅하며 도달한 쇼다운은 board.length가 이미 5라 여기서 건너뛴 스트리트가 없다.
    const isRunout = this.board.length < 5;
    // dealBoard()로 나머지 카드를 채우기 전, "올인이 확정된 시점에 이미 몇 장이 정상
    // 베팅으로 공개돼 있었는지"를 스냅샷해둔다 — 클라이언트가 이 값을 받아야 이미 봤던
    // 스트리트(예: 플랍 3장)를 다시 리캡하지 않고 그 이후(턴/리버)만 새로 공개할 수 있다.
    const preRunoutBoardCount = this.board.length;
    if (isRunout) this.dealBoard(5 - this.board.length);
    this.showdown(isRunout, preRunoutBoardCount);
  }

  private showdown(isRunout = false, revealedBoardCount = 5) {
    const st = this.state;
    this.setPhase('showdown');
    this.setActivePlayer(null);

    const contenders = this.actingPlayers();

    // 러시안 룰렛 — 누구 한 명이라도 보유하면(소유자만 유리한 게 아니라) 전원 동일하게
    // 무작위 커뮤니티 카드 1장을 제외하고 판정한다. 이 라운드에서 실제로 발동했으면
    // result 브로드캐스트에 제거된 카드 id를 실어 클라이언트가 총알 구멍 연출로 보여준다.
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

      // 예고 홈런 — 선언한 족보와 정확히 일치할 때만 발동한다(payout_multiplier의 조건
      // 매칭과 달리 상위 계열 승격 없음 — 로열 플러시를 선언했는데 플러시로 이겼다고 터지면 안 됨).
      let finalPayout = payout;
      let prophecyBonus = 0;
      if (
        w.p.declaredHandCategory &&
        w.p.declaredHandCategory === w.hand.category &&
        findByEffect(this.ownedAugments(w.p), 'declare_hand')
      ) {
        const rawBonus = Math.round(payout * PROPHECY_BONUS_MULTIPLIER);
        prophecyBonus = PROPHECY_BONUS_CAP != null ? Math.min(rawBonus, PROPHECY_BONUS_CAP) : rawBonus;
        finalPayout += prophecyBonus;
      }

      w.p.stack += finalPayout;
      return {
        sessionId: w.p.sessionId,
        name: w.p.name,
        category: w.hand.category,
        basePayout: base,
        payout: finalPayout,
        multiplier,
        augments: applied.map((a) => a.name),
        prophecyBonus,
      };
    });

    st.pot = 0;
    this.broadcast('result', {
      byFold: false,
      round: st.round,
      winners: winnerSummaries,
      hands: results.map((r) => ({
        sessionId: r.p.sessionId,
        name: r.p.name,
        category: r.hand.category,
      })),
      removedCommunityCardId: removedCard?.id,
      // 전원 올인 등으로 남은 스트리트를 건너뛰고 온 쇼다운인지 — 이때만 클라이언트가
      // "SHOW DOWN" 텍스트 + 보드 순차 공개 연출을 재생한다 (runoutAndShowdown 참고)
      runout: isRunout,
      // 올인이 확정된 시점에 이미 정상 공개돼 있던 보드 카드 수(0/3/4) — runout이 아니면
      // 항상 5(전부 이미 공개된 상태). 클라이언트는 이 값부터 이어서(예: 3이면 턴부터)
      // 순차 공개하고, 그 이전 카드는 다시 리캡하지 않는다.
      revealedBoardCount,
    });

    this.setPhase('round_end');
    const delay = removedCard ? ROULETTE_RESULT_DELAY_MS : SHOWDOWN_RESULT_DELAY_MS;
    this.clock.setTimeout(() => this.endRound(), delay);
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
        round: st.round,
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
    if (this.state.round >= MAX_ROUNDS || solvent.length < 2) {
      void this.endGame('라운드 종료');
      return;
    }
    this.state.round += 1;
    this.beginRound();
  }

  private async endGame(reason: string) {
    this.clearTurnTimer();
    this.augmentTimer?.clear();
    this.targetPromptTimer?.clear();
    this.streetRevealPromptTimer?.clear();
    this.setPhase('gameOver');
    this.setActivePlayer(null);
    // 클라이언트가 'gameOver'를 받는 시점엔 이미 칩 정산이 끝나 있도록, 브로드캐스트
    // 전에 로그인 유저 전원을 정산한다(게스트/봇은 SettlementTracker에 없어 스킵된다).
    for (const p of this.seatOrder()) {
      await this.settlePlayer(p.sessionId, p.stack);
    }
    const standings = this.seatOrder()
      .map((p) => ({ sessionId: p.sessionId, name: p.name, stack: p.stack, connected: p.connected }))
      .sort((a, b) => b.stack - a.stack);
    this.broadcast('gameOver', { reason, standings, winner: standings[0] ?? null });
  }

  /**
   * 로그인 유저의 최종 스택을 profiles.chips에 되돌려준다 — 입장 시 바이인을 이미
   * 전부 차감했으므로, 여기서 finalStack을 그대로 더해주면 순효과가 정확히 "이번
   * 판에서 딴/잃은 만큼"이 된다. SettlementTracker가 세션당 정확히 한 번만 실행되게
   * 보장하므로 endGame()과 onLeave() 양쪽에서 호출해도 이중 정산되지 않는다.
   *
   * 정산 결과가 정확히 0골드(완전히 파산)면 credit_chips가 그 자리에서 INITIAL_CHIPS(5000)
   * 골드로 채워주고 bailout_granted:true를 돌려준다 — 이 경우 본인에게만 파산 구제 안내를
   * 보낸다. 구제 금액 자체는 supabase/schema.sql의 credit_chips 함수에 하드코딩돼 있으니
   * (SQL은 이 TS 상수를 참조할 수 없다) INITIAL_CHIPS를 바꾸면 그쪽도 같이 맞춰야 한다.
   *
   * Supabase 호출 실패는 로그만 남기고 삼킨다 — 정산 실패로 게임 종료 흐름 자체가
   * 막히면 안 되기 때문(최소 스코프에서 감수하는 잔여 리스크: 이 시점의 일시적 장애는
   * 재시도 큐 없이 유실될 수 있다).
   */
  private async settlePlayer(sessionId: string, finalStack: number) {
    const userId = this.settlement.consume(sessionId);
    if (!userId || !supabaseAdmin) return;
    try {
      const { data: rows, error } = await supabaseAdmin.rpc('credit_chips', {
        p_user_id: userId,
        p_amount: finalStack,
      });
      if (error) throw error;
      const row = rows?.[0];
      if (!row) return;
      const client = this.clients.find((c) => c.sessionId === sessionId);
      client?.send('chipsSettled', { chips: row.new_chips });
      if (row.bailout_granted) {
        client?.send('notice', { text: `골드가 0이어서 ${INITIAL_CHIPS.toLocaleString()}골드를 채워드렸습니다` });
      }
    } catch (err) {
      console.error(`[PokerRoom] 칩 정산 실패 (sessionId=${sessionId}, userId=${userId}):`, err);
    }
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

  /** 턴 제한시간 — 초과 시 자동 체크/다이. durationMs를 넘기면(장고의 시간) 그 값으로 새로 건다 */
  private armTurnTimer(durationMs = TURN_TIMEOUT_MS) {
    this.clearTurnTimer();
    const sessionId = this.state.activePlayerId;
    this.turnDeadline = Date.now() + durationMs;
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
    }, durationMs);
  }

  private clearTurnTimer() {
    this.turnTimer?.clear();
    this.turnTimer = undefined;
  }

  /**
   * 장고의 시간 — 게임 전체 1회, 지금 내 턴 제한시간을 15초(증강 데이터 값) 연장한다.
   * 이미 경과한 만큼은 그대로 소진된 것으로 두고, 남은 시간 + 연장분으로 타이머를 다시 건다.
   */
  private handleExtendTurnTimer(client: Client) {
    if (!BETTING_PHASES.has(this.state.phase)) return this.reject(client, '지금은 사용할 수 없습니다');
    if (client.sessionId !== this.state.activePlayerId) return this.reject(client, '당신의 차례가 아닙니다');
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    const augment = findByEffect(this.ownedAugments(p), 'extend_timer');
    if (!augment) return this.reject(client, '장고의 시간 증강이 없습니다');
    if (p.deepThinkUsed) return this.reject(client, '이미 사용했습니다');

    p.deepThinkUsed = true;
    const extendMs = Math.round(augment.effect.value * 1000);
    const remaining = Math.max(0, this.turnDeadline - Date.now());
    this.armTurnTimer(remaining + extendMs);
    this.broadcast('notice', { text: `⏳ ${p.name}님이 장고의 시간을 사용했습니다 (+${Math.round(extendMs / 1000)}초)` });
    this.broadcast('turnExtended', { sessionId: p.sessionId, extendMs });
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
