/**
 * 증강(Augment) 효과 적용 룰 엔진 — 데이터 드리븐.
 * augments.json에 항목만 추가하면 코드 수정 없이 증강이 늘어난다.
 */

import type { Card, Rank, Suit } from './types';
import type { HandCategory } from './handEvaluator';

export type AugmentRarity = 'silver' | 'gold' | 'prismatic';

/**
 * on_pick: 다른 트리거들(쇼다운/핸드 시작 등 매 핸드 반복 발동)과 달리, 선택되는
 * 즉시 1회성으로 해소되는 증강 — 대상 지정이 필요하면 PokerRoom이 별도 phase에서
 * 대상을 받아 처리한다 (음침한 눈 / 카멜레온 / 당근이세요?).
 */
export type AugmentTrigger = 'on_showdown' | 'on_hand_start' | 'on_round_start' | 'on_shuffle' | 'on_pick';

export type AugmentEffectType =
  | 'payout_multiplier'
  | 'card_swap'
  | 'jokerize_random'
  | 'shuffle_bias'
  | 'reveal_opponent_card'
  | 'edit_own_card'
  | 'swap_with_opponent';

/** trigger가 'on_pick'인 증강 — 선택 즉시 대상 지정 → 효과 적용이 필요하다 */
export function isInstantAugment(augment: Augment): boolean {
  return augment.trigger === 'on_pick';
}

export interface AugmentCondition {
  handType?: HandCategory;
  isAllIn?: boolean;
}

export interface Augment {
  id: string;
  name: string;
  rarity: AugmentRarity;
  trigger: AugmentTrigger;
  condition?: AugmentCondition;
  effect: { type: AugmentEffectType; value: number };
  description: string;
}

export const RARITY_NAMES_KO: Record<AugmentRarity, string> = {
  silver: '실버',
  gold: '골드',
  prismatic: '프리즘',
};

/** 쇼다운 시점의 판 상태 — 조건 매칭에 사용 */
export interface ShowdownContext {
  handCategory: HandCategory;
  isAllIn: boolean;
}

/** 플러시 조건은 상위 플러시 계열(스트레이트/로열 플러시)도 인정 */
const CATEGORY_FAMILY: Partial<Record<HandCategory, HandCategory[]>> = {
  flush: ['flush', 'straight_flush', 'royal_flush'],
  straight: ['straight', 'straight_flush', 'royal_flush'],
};

function matchesCondition(condition: AugmentCondition | undefined, ctx: ShowdownContext): boolean {
  if (!condition) return true;
  if (condition.handType) {
    const accepted = CATEGORY_FAMILY[condition.handType] ?? [condition.handType];
    if (!accepted.includes(ctx.handCategory)) return false;
  }
  if (condition.isAllIn !== undefined && condition.isAllIn !== ctx.isAllIn) return false;
  return true;
}

export interface PayoutResult {
  payout: number;
  multiplier: number;
  /** 실제로 발동한 증강들 (결과 연출에 사용) */
  applied: Augment[];
}

/**
 * 쇼다운 승리 시 보유 증강의 배당 배율을 누적 적용한다.
 * 여러 증강이 동시에 발동하면 배율은 곱연산 (콤보 형성).
 */
export function applyPayoutAugments(
  owned: Augment[],
  ctx: ShowdownContext,
  basePayout: number,
): PayoutResult {
  let multiplier = 1;
  const applied: Augment[] = [];

  for (const augment of owned) {
    if (augment.trigger !== 'on_showdown') continue;
    if (augment.effect.type !== 'payout_multiplier') continue;
    if (!matchesCondition(augment.condition, ctx)) continue;
    multiplier *= augment.effect.value;
    applied.push(augment);
  }

  return { payout: Math.round(basePayout * multiplier), multiplier, applied };
}

export function hasAugment(owned: Augment[], id: string): boolean {
  return owned.some((a) => a.id === id);
}

/** 특정 효과 타입의 증강 찾기 (핸드 시작/셔플 훅에서 사용) */
export function findByEffect(owned: Augment[], type: AugmentEffectType): Augment | undefined {
  return owned.find((a) => a.effect.type === type);
}

/** 아직 보유하지 않은 증강 중 count개를 무작위 제시 */
export function rollAugmentChoices(pool: Augment[], owned: Augment[], count = 3): Augment[] {
  const remaining = pool.filter((a) => !hasAugment(owned, a.id));
  const shuffled = [...remaining];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

// ─────────────────────────── on_pick 증강: 홀카드 조작 (순수 함수) ───────────────────────────
//
// 아래 세 함수는 상태를 직접 건드리지 않는 순수 함수다 — 실제 서버 상태(PokerRoom의
// private holes 맵) 반영, 메시지 전송(누구에게 무엇을 보여줄지), 유효성 검증은 전부
// 호출부(PokerRoom)의 책임이다. 여기서는 "카드 배열이 이렇게 바뀐다"는 규칙만 계산한다.

export type HoleIndex = 0 | 1;

/** 카멜레온 — 홀카드 1장을 원하는 숫자/무늬로 교체한 새 배열을 반환한다 (원본 불변) */
export function applyEditCard(hole: readonly Card[], index: HoleIndex, rank: Rank, suit: Suit): Card[] {
  const next = [...hole];
  next[index] = { id: `chameleon-${suit}-${rank}-${Math.random().toString(36).slice(2, 8)}`, suit, rank };
  return next;
}

/** 당근이세요? — 두 플레이어의 홀카드 중 지정된 1장씩을 맞바꾼 결과를 반환한다 (원본 불변) */
export function swapCards(
  myHole: readonly Card[],
  theirHole: readonly Card[],
  myIndex: HoleIndex,
  theirIndex: HoleIndex,
): { mine: Card[]; theirs: Card[] } {
  const mine = [...myHole];
  const theirs = [...theirHole];
  const tmp = mine[myIndex];
  mine[myIndex] = theirs[theirIndex];
  theirs[theirIndex] = tmp;
  return { mine, theirs };
}

/** 음침한 눈 — 대상 홀카드 1장을 그대로 조회한다 (조회만, 상태 변경 없음) */
export function revealCard(hole: readonly Card[], index: HoleIndex): Card {
  return hole[index];
}
