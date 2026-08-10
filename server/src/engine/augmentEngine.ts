/**
 * 증강(Augment) 효과 적용 룰 엔진 — 데이터 드리븐.
 * augments.json에 항목만 추가하면 코드 수정 없이 증강이 늘어난다.
 */

import type { Card, Rank, Suit } from './types';
import type { HandCategory } from './handEvaluator';
import rarityTableData from '../data/augmentRarityTable.json';

export type AugmentRarity = 'silver' | 'gold' | 'prismatic';

/**
 * 보유한 증강은 원칙적으로 매 라운드(핸드) 시작 시점마다 재발동한다. 유일한 예외는
 * trigger가 'on_pick'인 증강(카멜레온) — 최초 선택 직후의 첫 발동 한 번만 효과가
 * 적용되고, 그 뒤로는 계속 보유하고 있어도 다시 발동하지 않는다(효과 소모 처리).
 * 대상 지정(상대/카드/숫자·무늬)이 필요한 증강은 PokerRoom이 augment_target phase에서
 * 대상을 받아 처리한다 (음침한 눈 / 카멜레온 / 당근이세요? / 예고 홈런).
 *
 * 'on_street_reveal'(밑장빼기)과 'on_turn'(리셋 버튼)은 카드 재구성(card_swap)과 같은
 * 계열 — trigger 자체는 분류/문서화용이고, 실제 "라운드당 1회" 제약과 발동 시점은
 * PokerRoom이 전용 메시지 핸들러 + PlayerState 플래그(bottomDealUsed/resetBoardUsed)로
 * 직접 관리한다.
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

/**
 * 보유 증강 중 이번 핸드 시작 시 대상 지정이 필요한 것만 골라낸다. owned는 반드시
 * 획득(선택) 순서로 정렬돼 들어와야 하며, 이 함수는 그 순서를 그대로 보존한다 —
 * 여러 증강을 동시에 보유하면 이 순서대로 하나씩 대상 지정 UI가 뜬다.
 * usedOneShotIds에 담긴 id의 일회성 증강(카멜레온)은 이미 소모된 것으로 보고 제외한다.
 */
export function collectHandStartTargetQueue(
  owned: Augment[],
  usedOneShotIds: readonly string[] = [],
): Augment[] {
  return owned.filter((a) => needsTargetSelection(a) && !(isOneShotAugment(a) && usedOneShotIds.includes(a.id)));
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

// ─────────────────────────── 대상 지정형 증강: 홀카드 조작 (순수 함수) ───────────────────────────
//
// 아래 세 함수는 상태를 직접 건드리지 않는 순수 함수다 — 실제 서버 상태(PokerRoom의
// private holes 맵) 반영, 메시지 전송(누구에게 무엇을 보여줄지), 유효성 검증은 전부
// 호출부(PokerRoom)의 책임이다. 여기서는 "카드 배열이 이렇게 바뀐다"는 규칙만 계산한다.

/**
 * 홀카드 배열 인덱스 — 평소엔 2장(0|1)이지만 대풍년(extra_hole_card)이 발동하면 전원이
 * 3장(0~2)을 받으므로 0|1로 고정하지 않는다. 실제 유효 범위(0 이상, hole.length 미만)는
 * 호출부(PokerRoom)가 대상 hole 배열의 실제 길이를 기준으로 검증한다 — 이 타입 자체는
 * 그 검증을 통과한 정수라는 의미만 가진다.
 */
export type HoleIndex = number;

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
