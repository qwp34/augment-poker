/**
 * 서버 측 AI 봇 베팅 판단 로직.
 *
 * 현재는 규칙 기반 휴리스틱(핸드 강도 + 랜덤성 + 페르소나)으로 동작한다.
 * decideBotAction의 입출력(BotDecisionInput → BotDecision)만 유지하면
 * 내부 구현을 Claude API 호출로 교체하기 쉽다 — async로 바꾸고 이 파일
 * 안에서 API를 호출한 뒤, 실패 시 아래 휴리스틱을 폴백으로 유지하면 된다.
 * (클라이언트 단일플레이용 src/engine/botAI.ts와 동일한 인터페이스)
 */

import type { Card, Street } from './types';
import { evaluateBest } from './handEvaluator';

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
}

export type BotAction = 'fold' | 'check' | 'call' | 'raise' | 'allin';

export interface BotDecision {
  action: BotAction;
  /** raise 시 추가로 올리는 금액 */
  amount?: number;
  /** 결정 이유 (로그/연출용 — 추후 Claude API가 생성) */
  reason: string;
}

/** 봇 베팅 판단 함수 시그니처 — Claude API 연동 시에도 이 형태를 유지 (동기/비동기 모두 허용) */
export type BotDecider = (input: BotDecisionInput) => BotDecision | Promise<BotDecision>;

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

export function estimateStrength(hole: Card[], community: Card[]): number {
  return community.length === 0 ? preflopStrength(hole) : postflopStrength(hole, community);
}

/**
 * 봇의 베팅 결정 (기본 구현 — 규칙 기반 휴리스틱).
 *
 * TODO(AI 연동): 이 구현을 async로 바꾸고, 아래 휴리스틱 대신 Claude API에
 * BotDecisionInput(판 상태)과 페르소나 프롬프트를 전달해 BotDecision(JSON)을
 * 받아오도록 교체 — API 실패/타임아웃 시 현재 휴리스틱을 폴백으로 유지.
 */
export const decideBotAction: BotDecider = (input) => {
  const { holeCards, community, toCall, potSize, botStack, raisesThisStreet, persona } = input;

  let strength = estimateStrength(holeCards, community);

  // 랜덤성: 판마다 ±0.1 흔들림 + 10% 확률 블러핑 부스트
  strength += (Math.random() - 0.5) * 0.2;
  const bluffing = Math.random() < (persona === 'aggressive' ? 0.15 : 0.07);
  if (bluffing) strength = Math.max(strength, 0.75);
  strength = Math.max(0, Math.min(1, strength));

  const aggression = persona === 'aggressive' ? 0.12 : -0.08;
  const potOdds = toCall > 0 ? toCall / (potSize + toCall) : 0;

  // 올인 판단
  if (toCall >= botStack) {
    if (strength > 0.55 + potOdds * 0.3) {
      return { action: 'call', reason: bluffing ? '이판사판이다!' : '이 핸드는 접을 수 없지.' };
    }
    return { action: 'fold', reason: '올인은 무리다... 접는다.' };
  }

  // 강한 핸드 → 레이즈/올인
  if (strength > 0.78 - aggression && raisesThisStreet < 2) {
    if (strength > 0.92 && botStack <= potSize * 2) {
      return { action: 'allin', reason: bluffing ? '전부 걸겠다!' : '이길 자신 있다. 올인!' };
    }
    const amount = Math.min(botStack - toCall, Math.max(100, Math.round((potSize * (0.5 + strength * 0.5)) / 50) * 50));
    if (amount > 0) {
      return { action: 'raise', amount, reason: bluffing ? '겁먹었나? 레이즈.' : '좋은 패다. 레이즈.' };
    }
  }

  // 콜/체크 판단
  if (toCall === 0) {
    return { action: 'check', reason: '일단 지켜보지.' };
  }
  if (strength > potOdds + 0.12 - aggression) {
    return { action: 'call', reason: '콜. 아직 볼 만하다.' };
  }
  return { action: 'fold', reason: '이 판은 버린다.' };
};
