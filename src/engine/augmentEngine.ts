/**
 * 증강(Augment) 효과 적용 룰 엔진 — 데이터 드리븐.
 * augments.json에 항목만 추가하면 코드 수정 없이 증강이 늘어난다.
 */

import type { HandCategory } from './handEvaluator';
import rarityTableData from '../data/augmentRarityTable.json';

export type AugmentRarity = 'silver' | 'gold' | 'prismatic';

/**
 * 보유한 증강은 원칙적으로 매 라운드(핸드) 시작 시점마다 재발동한다. 유일한 예외는
 * trigger가 'on_pick'인 증강(카멜레온) — 최초 선택 직후 한 번만 발동하고 그 뒤로는
 * 재발동하지 않는다(멀티플레이 서버에서만 실제로 처리됨). 대상 지정(상대/카드/숫자·무늬)이
 * 필요한 증강(음침한 눈/카멜레온/당근이세요?)은 멀티플레이 서버(PokerRoom)에서만 대상
 * 지정 흐름과 함께 처리되며, 로컬 싱글플레이 엔진(gameStore)은 아직 그 흐름을 실행할 수
 * 없으므로 needsTargetSelection()으로 걸러 증강 풀에서 제외한다.
 */
export type AugmentTrigger =
  | 'on_showdown'
  | 'on_hand_start'
  | 'on_round_start'
  | 'on_shuffle'
  | 'on_pick'
  | 'on_street_reveal'
  | 'on_turn';

export type AugmentEffectType =
  | 'payout_multiplier'
  | 'card_swap'
  | 'jokerize_random'
  | 'shuffle_bias'
  | 'reveal_opponent_card'
  | 'edit_own_card'
  | 'swap_with_opponent'
  | 'bottom_deal'
  | 'remove_random_community'
  | 'extra_hole_card'
  | 'rotate_hole_cards'
  | 'reset_board'
  | 'extend_timer'
  | 'declare_hand';

/**
 * 대상 지정(상대 플레이어/카드/숫자·무늬/족보 선언)이 필요한 효과인지 — (일회성이 아닌 한)
 * 매 핸드 시작 시 새로 딜링된 홀카드를 대상으로 다시 대상을 받아야 한다
 * (음침한 눈 / 카멜레온 / 당근이세요? / 예고 홈런).
 */
export function needsTargetSelection(augment: Augment): boolean {
  return (
    augment.effect.type === 'reveal_opponent_card' ||
    augment.effect.type === 'edit_own_card' ||
    augment.effect.type === 'swap_with_opponent' ||
    augment.effect.type === 'declare_hand'
  );
}

/** trigger가 'on_pick'인 증강 — 보유 중 딱 한 번만 발동하고, 그 뒤로는 영구히 재발동하지 않는다 (카멜레온) */
export function isOneShotAugment(augment: Augment): boolean {
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

type RarityWeights = Record<AugmentRarity, number>;

const RARITY_TABLE = rarityTableData as unknown as Record<string, RarityWeights>;
/** JSON에 "_comment" 같은 비-라운드 키가 섞여 있어도 무시하도록 숫자 키만 정렬해 둔다 */
const RARITY_TABLE_ROUNDS = Object.keys(RARITY_TABLE)
  .filter((k) => /^\d+$/.test(k))
  .map(Number)
  .sort((a, b) => a - b);

/**
 * 라운드 번호로 등급 확률 가중치를 조회한다 (augmentRarityTable.json, 코드 수정 없이
 * 숫자만 바꿔 밸런스 조정 가능). 테이블에 없는 라운드(예: MAX_ROUNDS를 늘린 경우)는
 * 가장 가까운 정의된 라운드의 값으로 고정(clamp)된다.
 */
export function rarityWeightsForRound(round: number): RarityWeights {
  const min = RARITY_TABLE_ROUNDS[0];
  const max = RARITY_TABLE_ROUNDS[RARITY_TABLE_ROUNDS.length - 1];
  const clamped = Math.min(Math.max(round, min), max);
  return RARITY_TABLE[String(clamped)];
}

/** 가중치와, 등급별로 실제 남은 후보가 있는지를 함께 보고 등급 하나를 뽑는다.
 *  후보가 없는 등급은 아예 후보군에서 빠지므로(가중치가 다른 등급으로 자연히
 *  재분배됨) 특정 등급 풀이 비어도 에러 없이 다른 등급으로 대체된다. */
function pickWeightedRarity(
  weights: RarityWeights,
  available: Record<AugmentRarity, Augment[]>,
): AugmentRarity | null {
  const rarities = (Object.keys(weights) as AugmentRarity[]).filter((r) => available[r].length > 0);
  if (rarities.length === 0) return null;

  const total = rarities.reduce((sum, r) => sum + weights[r], 0);
  if (total <= 0) return rarities[Math.floor(Math.random() * rarities.length)];

  let roll = Math.random() * total;
  for (const r of rarities) {
    roll -= weights[r];
    if (roll <= 0) return r;
  }
  return rarities[rarities.length - 1];
}

/**
 * 라운드에 맞는 등급 확률로 count개의 증강 후보를 제시한다. 슬롯마다 독립적으로 등급을
 * 굴린 뒤 해당 등급 풀에서 무작위로 하나를 뽑으므로, 최종 3장의 등급 구성은 매번 달라질
 * 수 있다(예: 실버 2 + 골드 1). 이미 보유한 증강은 애초에 후보에서 제외되고, 이번 호출
 * 안에서 뽑힌 증강은 다음 슬롯에서 다시 뽑히지 않는다(3장 중복 방지). 특정 등급 풀이
 * 비었거나(또는 전부 이미 보유 중이면) 다른 등급에서 대체되며, 전체 풀이 소진되면
 * count보다 적게 반환될 수 있다(에러는 나지 않는다).
 */
export function rollAugmentChoices(pool: Augment[], owned: Augment[], round: number, count = 3): Augment[] {
  const remaining = pool.filter((a) => !hasAugment(owned, a.id));
  const byRarity: Record<AugmentRarity, Augment[]> = { silver: [], gold: [], prismatic: [] };
  for (const a of remaining) byRarity[a.rarity].push(a);

  const weights = rarityWeightsForRound(round);
  const picks: Augment[] = [];

  for (let i = 0; i < count; i++) {
    const rarity = pickWeightedRarity(weights, byRarity);
    if (!rarity) break;
    const list = byRarity[rarity];
    const idx = Math.floor(Math.random() * list.length);
    picks.push(list[idx]);
    list.splice(idx, 1);
  }

  return picks;
}
