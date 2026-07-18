import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Card, Rank, Suit } from './types';
import { evaluateBest, compareHands } from './handEvaluator';
import { applyPayoutAugments, type Augment, type ShowdownContext } from './augmentEngine';
import augmentsData from '../data/augments.json';

const POOL = augmentsData as Augment[];
const byId = (id: string) => POOL.find((a) => a.id === id)!;

function c(suit: Suit, rank: Rank): Card {
  return { id: `${suit}-${rank}`, suit, rank };
}

interface Contender {
  id: string;
  hole: Card[];
  augments: Augment[];
  isAllIn: boolean;
}

/**
 * PokerRoom.showdown()과 동일한 순서를 그대로 재현한다:
 * 족보 판정 -> 승자 결정(동점 포함 스플릿) -> 승자별 보유 증강 배당 적용 -> 팟 분배
 */
function runShowdown(contenders: Contender[], community: Card[], pot: number) {
  const results = contenders.map((p) => ({ p, hand: evaluateBest([...p.hole, ...community]) }));

  results.sort((a, b) => compareHands(b.hand, a.hand));
  const best = results[0].hand;
  const winners = results.filter((r) => compareHands(r.hand, best) === 0);
  const share = Math.floor(pot / winners.length);
  const remainder = pot % winners.length;

  return winners.map((w, i) => {
    const base = share + (i === 0 ? remainder : 0);
    const ctx: ShowdownContext = { handCategory: w.hand.category, isAllIn: w.p.isAllIn };
    const { payout, multiplier } = applyPayoutAugments(w.p.augments, ctx, base);
    return { id: w.p.id, category: w.hand.category, base, payout, multiplier };
  });
}

describe('쇼다운 파이프라인: 족보 판정 -> 승자 결정 -> 증강 적용 -> 팟 분배', () => {
  it('단독 승자가 조건을 만족하는 증강 2개를 보유하면 배율이 곱연산으로 적용된다', () => {
    const community = [c('hearts', 2), c('hearts', 5), c('hearts', 9), c('spades', 14), c('clubs', 8)];
    const winner: Contender = {
      id: 'A',
      hole: [c('hearts', 11), c('hearts', 13)], // 하트 플러시
      augments: [byId('aug_flush_boost'), byId('aug_allin_snipe')],
      isAllIn: true,
    };
    const loser: Contender = {
      id: 'B',
      hole: [c('diamonds', 4), c('clubs', 6)], // 하이카드 (스트레이트/플러시 불가하도록 랭크 분산)
      augments: [],
      isAllIn: false,
    };

    const payouts = runShowdown([winner, loser], community, 1000);
    assert.equal(payouts.length, 1);
    assert.equal(payouts[0].id, 'A');
    assert.equal(payouts[0].category, 'flush');
    assert.equal(payouts[0].multiplier, 3); // 1.5 * 2
    assert.equal(payouts[0].payout, 3000);
  });

  it('스플릿 팟: 동점자는 각자의 증강 보유 여부에 따라 독립적으로 배율이 적용된다', () => {
    // 보드 자체가 로열 플러시 -> 참가한 두 명 모두 동일한 족보로 묶인다
    const community = [c('spades', 10), c('spades', 11), c('spades', 12), c('spades', 13), c('spades', 14)];
    const withAugment: Contender = {
      id: 'A',
      hole: [c('hearts', 2), c('diamonds', 4)],
      augments: [byId('aug_flush_boost')],
      isAllIn: false,
    };
    const withoutAugment: Contender = {
      id: 'B',
      hole: [c('clubs', 7), c('hearts', 9)],
      augments: [],
      isAllIn: false,
    };

    // 홀수 팟(1001) -> 나머지 1은 정렬상 첫 번째 승자에게 돌아간다
    const payouts = runShowdown([withAugment, withoutAugment], community, 1001);
    assert.equal(payouts.length, 2);
    for (const p of payouts) assert.equal(p.category, 'royal_flush');

    const a = payouts.find((p) => p.id === 'A')!;
    const b = payouts.find((p) => p.id === 'B')!;
    assert.equal(a.multiplier, 1.5); // 로열 플러시도 플러시 계열이라 발동
    assert.equal(b.multiplier, 1);
    assert.equal(a.base + b.base, 1001);
    assert.equal(a.payout, Math.round(a.base * 1.5));
    assert.equal(b.payout, b.base);
  });

  it('증강이 없는 평범한 승부는 배율 없이 팟 전체를 가져간다', () => {
    const community = [c('spades', 7), c('hearts', 13), c('diamonds', 9), c('clubs', 12), c('spades', 2)];
    const winner: Contender = {
      id: 'A',
      hole: [c('spades', 9), c('hearts', 9)], // 트리플(9,9,9)
      augments: [],
      isAllIn: false,
    };
    const loser: Contender = {
      id: 'B',
      hole: [c('diamonds', 3), c('clubs', 5)], // 하이카드
      augments: [],
      isAllIn: false,
    };

    const payouts = runShowdown([winner, loser], community, 750);
    assert.equal(payouts.length, 1);
    assert.equal(payouts[0].category, 'three_of_a_kind');
    assert.equal(payouts[0].payout, 750);
  });
});
