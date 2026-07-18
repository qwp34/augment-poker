/** 덱 생성 · Fisher-Yates 셔플 · 딜링 */

import type { Card, Rank, Suit } from './types';
import { RANKS, SUITS } from './types';

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: `${suit}-${rank}`, suit, rank });
    }
  }
  return deck;
}

/** Fisher-Yates 셔플 (원본 훼손 없이 새 배열 반환) */
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 덱 맨 위에서 n장 뽑기 — [뽑은 카드들, 남은 덱] */
export function draw(deck: Card[], n: number): [Card[], Card[]] {
  return [deck.slice(0, n), deck.slice(n)];
}

/**
 * "로열의 예언" 증강용 셔플 편향 (연출/재미 목적 — 기획서 4.2 참고).
 * 일정 확률로 플레이어 홀카드 위치(0, 1)에 같은 무늬 브로드웨이 카드를 배치한다.
 */
export function applyRoyalBias(deck: Card[], chance = 0.15, rng: () => number = Math.random): Card[] {
  if (rng() >= chance) return deck;

  const suit: Suit = SUITS[Math.floor(rng() * SUITS.length)];
  const broadway: Rank[] = [10, 11, 12, 13, 14];
  const picks = shuffle(broadway, rng).slice(0, 2);

  const result = [...deck];
  picks.forEach((rank, holeIndex) => {
    const from = result.findIndex((c) => c.suit === suit && c.rank === rank);
    if (from >= 0) {
      [result[holeIndex], result[from]] = [result[from], result[holeIndex]];
    }
  });
  return result;
}
