/**
 * 증강(Augment) 효과 적용 룰 엔진 — 데이터 드리븐.
 * augments.json에 항목만 추가하면 코드 수정 없이 증강이 늘어난다.
 */

import type { HandCategory } from './handEvaluator';

export type AugmentRarity = 'silver' | 'gold' | 'prismatic';

export type AugmentTrigger = 'on_showdown' | 'on_hand_start' | 'on_round_start' | 'on_shuffle';

export type AugmentEffectType =
  | 'payout_multiplier'
  | 'card_swap'
  | 'jokerize_random'
  | 'shuffle_bias';

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
