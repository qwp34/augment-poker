/** 포커 핸드 랭킹 판정 (7장 중 최고의 5장 조합 평가, 조커 지원) */

import type { Card, Rank, Suit } from './types';
import { SUITS } from './types';

export type HandCategory =
  | 'high_card'
  | 'pair'
  | 'two_pair'
  | 'three_of_a_kind'
  | 'straight'
  | 'flush'
  | 'full_house'
  | 'four_of_a_kind'
  | 'straight_flush'
  | 'royal_flush';

const CATEGORY_RANK: Record<HandCategory, number> = {
  high_card: 0,
  pair: 1,
  two_pair: 2,
  three_of_a_kind: 3,
  straight: 4,
  flush: 5,
  full_house: 6,
  four_of_a_kind: 7,
  straight_flush: 8,
  royal_flush: 9,
};

export const CATEGORY_NAMES_KO: Record<HandCategory, string> = {
  high_card: '하이 카드',
  pair: '원 페어',
  two_pair: '투 페어',
  three_of_a_kind: '트리플',
  straight: '스트레이트',
  flush: '플러시',
  full_house: '풀 하우스',
  four_of_a_kind: '포카드',
  straight_flush: '스트레이트 플러시',
  royal_flush: '로열 스트레이트 플러시',
};

export interface HandResult {
  category: HandCategory;
  /** [카테고리 순위, 타이브레이커...] — 사전식 비교용 */
  score: number[];
  /** 최고 조합을 이룬 실제 5장 (조커는 원본 카드 그대로) */
  bestFive: Card[];
}

/** a가 이기면 양수, b가 이기면 음수, 무승부면 0 */
export function compareHands(a: HandResult, b: HandResult): number {
  const len = Math.max(a.score.length, b.score.length);
  for (let i = 0; i < len; i++) {
    const diff = (a.score[i] ?? 0) - (b.score[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 5장 고정 조합 평가 (조커 없음 가정 — 무늬가 확정된 카드만) */
function evaluateFive(cards: { rank: Rank; suit: Suit }[]): { category: HandCategory; score: number[] } {
  const ranks = cards.map((c) => c.rank).sort((x, y) => y - x);
  const isFlush = cards.every((c) => c.suit === cards[0].suit);

  // 스트레이트 검사 (A-5 휠 포함)
  const unique = [...new Set(ranks)].sort((x, y) => y - x);
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) {
      straightHigh = unique[0];
    } else if (unique[0] === 14 && unique[1] === 5 && unique[4] === 2) {
      straightHigh = 5; // A-2-3-4-5
    }
  }

  // 랭크별 개수 집계
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // [개수 내림차순, 같은 개수면 랭크 내림차순] 정렬
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const groupRanks = groups.map(([r]) => r);
  const pattern = groups.map(([, n]) => n).join('');

  let category: HandCategory;
  let tiebreak: number[];

  if (isFlush && straightHigh === 14) {
    category = 'royal_flush';
    tiebreak = [];
  } else if (isFlush && straightHigh > 0) {
    category = 'straight_flush';
    tiebreak = [straightHigh];
  } else if (pattern === '41') {
    category = 'four_of_a_kind';
    tiebreak = groupRanks;
  } else if (pattern === '32') {
    category = 'full_house';
    tiebreak = groupRanks;
  } else if (isFlush) {
    category = 'flush';
    tiebreak = ranks;
  } else if (straightHigh > 0) {
    category = 'straight';
    tiebreak = [straightHigh];
  } else if (pattern === '311') {
    category = 'three_of_a_kind';
    tiebreak = groupRanks;
  } else if (pattern === '221') {
    category = 'two_pair';
    tiebreak = groupRanks;
  } else if (pattern === '2111') {
    category = 'pair';
    tiebreak = groupRanks;
  } else {
    category = 'high_card';
    tiebreak = ranks;
  }

  return { category, score: [CATEGORY_RANK[category], ...tiebreak] };
}

/** n개 중 5개 조합 생성 */
function combinations5<T>(items: T[]): T[][] {
  if (items.length <= 5) return [items];
  const result: T[][] = [];
  const n = items.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++)
            result.push([items[a], items[b], items[c], items[d], items[e]]);
  return result;
}

/** 조커 카드의 무늬 배정 경우의 수 전개 */
function jokerVariants(five: Card[]): { rank: Rank; suit: Suit }[][] {
  const jokerIndices = five.flatMap((c, i) => (c.isJoker ? [i] : []));
  if (jokerIndices.length === 0) {
    return [five.map((c) => ({ rank: c.rank, suit: c.suit }))];
  }
  let variants: { rank: Rank; suit: Suit }[][] = [five.map((c) => ({ rank: c.rank, suit: c.suit }))];
  for (const idx of jokerIndices) {
    variants = variants.flatMap((variant) =>
      SUITS.map((suit) => {
        const next = variant.map((c) => ({ ...c }));
        next[idx].suit = suit;
        return next;
      }),
    );
  }
  return variants;
}

/**
 * 주어진 카드들(홀 2장 + 커뮤니티 최대 5장)에서 최고의 5장 핸드를 찾는다.
 * 조커는 모든 무늬로 인정 — 가능한 배정 중 가장 높은 결과를 채택.
 */
export function evaluateBest(cards: Card[]): HandResult {
  if (cards.length < 5) {
    throw new Error(`핸드 평가에는 최소 5장이 필요합니다 (현재 ${cards.length}장)`);
  }

  let best: HandResult | null = null;
  for (const five of combinations5(cards)) {
    for (const variant of jokerVariants(five)) {
      const { category, score } = evaluateFive(variant);
      const candidate: HandResult = { category, score, bestFive: five };
      if (!best || compareHands(candidate, best) > 0) {
        best = candidate;
      }
    }
  }
  return best!;
}
