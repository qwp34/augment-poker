/**
 * 서버 측 AI 봇 베팅 판단 로직.
 *
 * 몬테카를로 에퀴티(calculateEquity)와 팟오즈를 비교해 판단하고,
 * 거기에 페르소나 오프셋 · 랜덤 흔들림 · 저빈도 블러핑을 얹는다.
 * decideBotAction의 입출력(BotDecisionInput → BotDecision)만 유지하면
 * 내부 구현을 Claude API 호출로 교체하기 쉽다 — async로 바꾸고 이 파일
 * 안에서 API를 호출한 뒤, 실패 시 아래 휴리스틱을 폴백으로 유지하면 된다.
 * (클라이언트 단일플레이용 src/engine/botAI.ts와 동일한 인터페이스)
 */

import type { Card, Street } from './types';
import { evaluateBest } from './handEvaluator';
import { calculateEquity } from './equity';

export type BotPersona = 'aggressive' | 'cautious';

export interface BotDecisionInput {
  holeCards: Card[];
  community: Card[];
  street: Street;
  /** 봇이 콜하기 위해 추가로 내야 하는 칩 */
  toCall: number;
  potSize: number;
  botStack: number;
  /** 이번 스트리트에 발생한 레이즈 횟수 (재레이즈 억제용) */
  raisesThisStreet: number;
  persona: BotPersona;
  /** 아직 살아있는 상대 수. 생략 시 헤즈업(1명)으로 본다. */
  opponents?: number;
}

export type BotAction = 'fold' | 'check' | 'call' | 'raise' | 'allin';

export interface BotDecision {
  action: BotAction;
  /** raise 시 추가로 올리는 금액 */
  amount?: number;
  /** 플레이어에게 보이는 대사 — 봇 말풍선·게임 로그에 그대로 노출된다 (추후 Claude API가 생성) */
  reason: string;
  /**
   * 판단 근거 수치 (`equity 0.42 >= potOdds 0.25`) — 개발·튜닝용.
   * 플레이어에게 보이는 어떤 경로(말풍선/로그 패널/연출)로도 내보내지 말 것.
   */
  detail?: string;
}

/** 봇 베팅 판단 함수 시그니처 — Claude API 연동 시에도 이 형태를 유지 (동기/비동기 모두 허용) */
export type BotDecider = (input: BotDecisionInput) => BotDecision | Promise<BotDecision>;

/**
 * 에퀴티 기반 판단에 쓰는 임계값 모음.
 * 모든 임계값은 에퀴티(0~1) 스케일이며, personaOffset만큼 낮춰서 적용한다
 * (오프셋이 클수록 공격적).
 *
 * personaOffset.aggressive(0.02)와 raiseFacingBet(0.72)은 셀프플레이로 측정해 정한 값이다
 * (server/scripts/selfplay.ts, 2000판 × 2회). 이전 값(0.06 / 0.68)은 공격적 봇이
 * "실제 에퀴티 < 팟오즈"인데도 콜하는 비율이 7.3%였는데, 지금 값에서 3.8%로 떨어졌다.
 * 레이즈 비율도 31.6% → 26.2%로 줄었다. 두 지표 모두 판단 8000건을 평균 낸 값이라
 * 회차 간 0.6%p 안에서 재현된다.
 *
 * 칩 수지(BB/100)는 판단 근거로 쓰지 않았다 — 두 페르소나를 동일하게 맞춘 대조군에서도
 * 참값 0 대신 -73.6 / -17.2가 나올 만큼 노이즈 바닥(±50~75)이 커서, 설정 간 차이를
 * 분해하지 못한다.
 */
export const BOT_EQUITY_CONFIG = {
  /** 봇 판단 1회당 몬테카를로 롤아웃 횟수 (decideBotAction 호출당 1회만 계산) */
  iterations: 1200,
  /** input.opponents가 없을 때 가정하는 상대 수 */
  defaultOpponents: 1,
  /** 에퀴티에 더하는 랜덤 흔들림 폭 (±) */
  jitter: 0.04,
  /** 저빈도 블러핑 확률 */
  bluffChance: { aggressive: 0.06, cautious: 0.04 },
  /** 블러핑 시 끌어올릴 최소 에퀴티 */
  bluffEquity: 0.7,
  /** 페르소나별 임계값 오프셋 — 임계값에서 이만큼 빼서 적용 (셀프플레이 측정값) */
  personaOffset: { aggressive: 0.02, cautious: -0.04 },
  /** toCall === 0일 때 밸류 레이즈에 필요한 에퀴티 */
  raiseNoBet: 0.62,
  /** toCall > 0일 때 밸류 레이즈에 필요한 에퀴티 (셀프플레이 측정값) */
  raiseFacingBet: 0.72,
  /** 스택이 팟 대비 작을 때 올인으로 미는 에퀴티 */
  allinPush: 0.85,
  /**
   * 폴드 기준선을 팟오즈보다 이만큼만 아래로 둔다 — 경계에서의 진동 완충용.
   * 느슨함/타이트함은 personaOffset이 담당하므로 여기서 키우면 기댓값상 손해인
   * 콜을 하게 된다.
   */
  foldMargin: 0.01,
  /** 올인 콜에 요구하는 팟오즈 대비 추가 여유 */
  allinCallMargin: 0.08,
  /** 스트리트당 최대 레이즈 횟수 */
  maxRaisesPerStreet: 2,
} as const;

/** 프리플랍 홀카드 강도 추정 (0~1) — 간이 첸 공식 */
function preflopStrength(hole: Card[]): number {
  const [a, b] = [...hole].sort((x, y) => y.rank - x.rank);
  let score = a.rank / 14; // 높은 카드 기준

  if (a.rank === b.rank) score = Math.min(1, 0.5 + a.rank / 20); // 포켓 페어
  if (a.suit === b.suit || a.isJoker || b.isJoker) score += 0.08; // 수딧
  const gap = a.rank - b.rank;
  if (gap === 1) score += 0.06; // 커넥터
  else if (gap >= 4) score -= 0.08;

  return Math.max(0, Math.min(1, score));
}

/** 포스트플랍: 현재 완성된 핸드 카테고리 기반 강도 (0~1) */
function postflopStrength(hole: Card[], community: Card[]): number {
  const result = evaluateBest([...hole, ...community]);
  const categoryRank = result.score[0]; // 0(하이카드) ~ 9(로열)
  const base = categoryRank / 9;
  const kicker = (result.score[1] ?? 0) / 14 / 10; // 소폭 보정
  return Math.min(1, base + kicker + 0.1); // 하이카드도 최소한의 강도
}

/**
 * 카테고리 기반 간이 강도 추정 (0~1).
 * 에퀴티 계산이 불가능한 입력(홀카드 0장·3장 이상 등)에서 폴백으로 쓴다.
 * 에퀴티와 정확히 같은 스케일은 아니므로 어디까지나 근사치다.
 */
export function estimateStrength(hole: Card[], community: Card[]): number {
  return community.length === 0 ? preflopStrength(hole) : postflopStrength(hole, community);
}

/**
 * 승률 추정. 정상 입력이면 몬테카를로 에퀴티를, 계산 불가면 null을 돌려준다.
 * decideBotAction 호출당 정확히 한 번만 불린다.
 */
function estimateEquity(input: BotDecisionInput, rng: () => number): number | null {
  try {
    return calculateEquity({
      hole: input.holeCards,
      board: input.community,
      opponents: input.opponents ?? BOT_EQUITY_CONFIG.defaultOpponents,
      iterations: BOT_EQUITY_CONFIG.iterations,
      rng,
    }).equity;
  } catch {
    return null;
  }
}

/**
 * 봇의 베팅 결정 (기본 구현 — 에퀴티 기반 휴리스틱).
 *
 * TODO(AI 연동): 이 구현을 async로 바꾸고, 아래 휴리스틱 대신 Claude API에
 * BotDecisionInput(판 상태)과 페르소나 프롬프트를 전달해 BotDecision(JSON)을
 * 받아오도록 교체 — API 실패/타임아웃 시 현재 휴리스틱을 폴백으로 유지.
 */
export const decideBotAction: BotDecider = (input) => {
  const { holeCards, community, toCall, potSize, botStack, raisesThisStreet, persona } = input;
  const cfg = BOT_EQUITY_CONFIG;
  const rng = Math.random;

  const rolledOut = estimateEquity(input, rng);
  let equity = rolledOut ?? estimateStrength(holeCards, community);

  // 랜덤성: ±jitter 흔들림 + 저빈도 블러핑 부스트
  equity += (rng() - 0.5) * 2 * cfg.jitter;
  const bluffing = rng() < cfg.bluffChance[persona];
  if (bluffing) equity = Math.max(equity, cfg.bluffEquity);
  equity = Math.max(0, Math.min(1, equity));

  const offset = cfg.personaOffset[persona];
  const potOdds = toCall > 0 ? toCall / (potSize + toCall) : 0;

  // 판단에 실제로 쓰인 수치 — reason(대사)과 섞지 않고 detail로만 내보낸다.
  const note = rolledOut === null ? ' (추정)' : '';
  const cmp = (op: string) =>
    toCall > 0
      ? `equity ${equity.toFixed(2)} ${op} potOdds ${potOdds.toFixed(2)}${note}`
      : `equity ${equity.toFixed(2)}, 무베팅${note}`;

  // 올인 대응 (기존 분기 구조 유지 — 판단 기준만 에퀴티로 교체)
  if (toCall >= botStack) {
    if (equity >= potOdds + cfg.allinCallMargin - offset) {
      return {
        action: 'call',
        reason: bluffing ? '이판사판이다!' : '이 핸드는 접을 수 없지.',
        detail: cmp('>='),
      };
    }
    return { action: 'fold', reason: '올인은 무리다... 접는다.', detail: cmp('<') };
  }

  // 강한 핸드 → 레이즈/올인
  const raiseBar = (toCall === 0 ? cfg.raiseNoBet : cfg.raiseFacingBet) - offset;
  if (equity >= raiseBar && raisesThisStreet < cfg.maxRaisesPerStreet) {
    if (equity >= cfg.allinPush && botStack <= potSize * 2) {
      return {
        action: 'allin',
        reason: bluffing ? '전부 걸겠다!' : '이길 자신 있다. 올인!',
        detail: cmp('>='),
      };
    }
    const amount = Math.min(botStack - toCall, Math.max(100, Math.round((potSize * (0.5 + equity * 0.5)) / 50) * 50));
    if (amount > 0) {
      return {
        action: 'raise',
        amount,
        reason: bluffing ? '겁먹었나? 레이즈.' : '좋은 패다. 레이즈.',
        detail: cmp('>='),
      };
    }
  }

  // 콜/체크 판단
  if (toCall === 0) {
    return { action: 'check', reason: '일단 지켜보지.', detail: cmp('<') };
  }
  if (equity >= potOdds - cfg.foldMargin - offset) {
    return { action: 'call', reason: '콜. 아직 볼 만하다.', detail: cmp('>=') };
  }
  return { action: 'fold', reason: '이 판은 버린다.', detail: cmp('<') };
};
