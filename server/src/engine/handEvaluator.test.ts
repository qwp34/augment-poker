import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Card, Rank, Suit } from './types';
import { evaluateBest, compareHands } from './handEvaluator';

/** 테스트용 카드 생성 헬퍼 — id는 deck.ts와 동일한 `${suit}-${rank}` 규칙 */
function c(suit: Suit, rank: Rank, isJoker = false): Card {
  return { id: `${suit}-${rank}${isJoker ? '-joker' : ''}`, suit, rank, isJoker };
}

describe('evaluateBest — 족보 판정', () => {
  it('하이 카드: 페어/플러시/스트레이트가 전혀 없으면 high_card', () => {
    const hand = evaluateBest([
      c('spades', 2),
      c('hearts', 5),
      c('diamonds', 9),
      c('clubs', 11),
      c('spades', 13),
      c('hearts', 7),
      c('diamonds', 3),
    ]);
    assert.equal(hand.category, 'high_card');
    // 상위 5장 내림차순: 13,11,9,7,5
    assert.deepEqual(hand.score, [0, 13, 11, 9, 7, 5]);
  });

  it('원 페어', () => {
    const hand = evaluateBest([
      c('spades', 9),
      c('hearts', 9),
      c('diamonds', 2),
      c('clubs', 5),
      c('spades', 13),
      c('hearts', 7),
      c('diamonds', 3),
    ]);
    assert.equal(hand.category, 'pair');
    assert.deepEqual(hand.score, [1, 9, 13, 7, 5]);
  });

  it('투 페어', () => {
    const hand = evaluateBest([
      c('spades', 9),
      c('hearts', 9),
      c('diamonds', 4),
      c('clubs', 4),
      c('spades', 13),
      c('hearts', 7),
      c('diamonds', 3),
    ]);
    assert.equal(hand.category, 'two_pair');
    assert.deepEqual(hand.score, [2, 9, 4, 13]);
  });

  it('트리플 (three of a kind)', () => {
    const hand = evaluateBest([
      c('spades', 6),
      c('hearts', 6),
      c('diamonds', 6),
      c('clubs', 4),
      c('spades', 13),
      c('hearts', 7),
      c('diamonds', 3),
    ]);
    assert.equal(hand.category, 'three_of_a_kind');
    assert.deepEqual(hand.score, [3, 6, 13, 7]);
  });

  it('스트레이트 (일반)', () => {
    const hand = evaluateBest([
      c('spades', 5),
      c('hearts', 6),
      c('diamonds', 7),
      c('clubs', 8),
      c('spades', 9),
      c('hearts', 2),
      c('diamonds', 2),
    ]);
    assert.equal(hand.category, 'straight');
    assert.deepEqual(hand.score, [4, 9]);
  });

  it('스트레이트 — 휠(A-2-3-4-5)은 5 하이로 취급', () => {
    const hand = evaluateBest([
      c('spades', 14), // A
      c('hearts', 2),
      c('diamonds', 3),
      c('clubs', 4),
      c('spades', 5),
      c('hearts', 9),
      c('diamonds', 9),
    ]);
    assert.equal(hand.category, 'straight');
    assert.deepEqual(hand.score, [4, 5]);
  });

  it('플러시', () => {
    const hand = evaluateBest([
      c('hearts', 2),
      c('hearts', 5),
      c('hearts', 9),
      c('hearts', 11),
      c('hearts', 13),
      c('spades', 8),
      c('clubs', 3),
    ]);
    assert.equal(hand.category, 'flush');
    assert.deepEqual(hand.score, [5, 13, 11, 9, 5, 2]);
  });

  it('풀 하우스', () => {
    const hand = evaluateBest([
      c('spades', 13),
      c('hearts', 13),
      c('diamonds', 13),
      c('clubs', 5),
      c('spades', 5),
      c('hearts', 2),
      c('diamonds', 9),
    ]);
    assert.equal(hand.category, 'full_house');
    assert.deepEqual(hand.score, [6, 13, 5]);
  });

  it('포카드 — 최고 키커까지 정확히 선택', () => {
    const hand = evaluateBest([
      c('spades', 12),
      c('hearts', 12),
      c('diamonds', 12),
      c('clubs', 12),
      c('spades', 2),
      c('hearts', 7),
      c('diamonds', 9),
    ]);
    assert.equal(hand.category, 'four_of_a_kind');
    // 남은 2,7,9 중 최고 키커는 9
    assert.deepEqual(hand.score, [7, 12, 9]);
  });

  it('스트레이트 플러시', () => {
    const hand = evaluateBest([
      c('clubs', 5),
      c('clubs', 6),
      c('clubs', 7),
      c('clubs', 8),
      c('clubs', 9),
      c('spades', 2),
      c('hearts', 3),
    ]);
    assert.equal(hand.category, 'straight_flush');
    assert.deepEqual(hand.score, [8, 9]);
  });

  it('로열 플러시', () => {
    const hand = evaluateBest([
      c('spades', 10),
      c('spades', 11),
      c('spades', 12),
      c('spades', 13),
      c('spades', 14),
      c('hearts', 2),
      c('diamonds', 4),
    ]);
    assert.equal(hand.category, 'royal_flush');
    assert.deepEqual(hand.score, [9]);
  });

  it('7장 중 최고 5장을 정확히 골라낸다 (풀하우스 vs 흩어진 페어)', () => {
    // 킹 트리플 + 5 페어가 있으므로 반드시 풀하우스(K,K,K,5,5)를 선택해야 한다
    const hand = evaluateBest([
      c('spades', 13),
      c('hearts', 13),
      c('diamonds', 13),
      c('clubs', 5),
      c('spades', 5),
      c('hearts', 9),
      c('diamonds', 2),
    ]);
    assert.equal(hand.category, 'full_house');
    assert.equal(hand.bestFive.length, 5);
  });

  it('조커는 최적의 무늬로 배정되어 플러시를 완성시킨다', () => {
    const hand = evaluateBest([
      c('hearts', 4),
      c('hearts', 7),
      c('hearts', 9),
      c('hearts', 13),
      c('spades', 2, true), // 조커 — hearts로 인정되어야 플러시 완성
      c('clubs', 6),
      c('diamonds', 8),
    ]);
    assert.equal(hand.category, 'flush');
  });

  it('5장 미만이면 에러를 던진다', () => {
    assert.throws(() => evaluateBest([c('spades', 2), c('hearts', 3), c('diamonds', 4)]));
  });
});

describe('compareHands — 동점(킥커) 비교 및 승자 판정', () => {
  it('카테고리가 다르면 상위 카테고리가 이긴다', () => {
    const flush = evaluateBest([
      c('hearts', 2),
      c('hearts', 5),
      c('hearts', 9),
      c('hearts', 11),
      c('hearts', 13),
      c('spades', 8),
      c('clubs', 3),
    ]);
    const pair = evaluateBest([
      c('spades', 9),
      c('hearts', 9),
      c('diamonds', 2),
      c('clubs', 5),
      c('spades', 13),
      c('hearts', 7),
      c('diamonds', 3),
    ]);
    assert.ok(compareHands(flush, pair) > 0);
    assert.ok(compareHands(pair, flush) < 0);
  });

  it('같은 페어라도 킥커가 높은 쪽이 이긴다', () => {
    const community: Card[] = [c('hearts', 13), c('spades', 9), c('diamonds', 7), c('clubs', 3), c('spades', 2)];
    // 둘 다 킹 페어 — A는 킥커 9,7,6 / B는 킥커 9,7,4
    const handA = evaluateBest([c('spades', 13), c('hearts', 6), ...community]);
    const handB = evaluateBest([c('diamonds', 13), c('clubs', 4), ...community]);
    assert.equal(handA.category, 'pair');
    assert.equal(handB.category, 'pair');
    assert.ok(compareHands(handA, handB) > 0);
    assert.ok(compareHands(handB, handA) < 0);
  });

  it('보드 자체가 로열 플러시면 전원 스플릿 팟(동점)', () => {
    const board: Card[] = [c('spades', 10), c('spades', 11), c('spades', 12), c('spades', 13), c('spades', 14)];
    const handA = evaluateBest([c('hearts', 2), c('diamonds', 4), ...board]);
    const handB = evaluateBest([c('clubs', 7), c('hearts', 9), ...board]);
    assert.equal(handA.category, 'royal_flush');
    assert.equal(handB.category, 'royal_flush');
    assert.equal(compareHands(handA, handB), 0);
  });

  it('완전히 동일한 5장 조합은 0(무승부)을 반환한다', () => {
    const cards: Card[] = [c('spades', 9), c('hearts', 9), c('diamonds', 2), c('clubs', 5), c('spades', 13)];
    const handA = evaluateBest(cards);
    const handB = evaluateBest([...cards]);
    assert.equal(compareHands(handA, handB), 0);
  });
});
