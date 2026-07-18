import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import augmentsData from '../data/augments.json';
import { applyPayoutAugments, type Augment, type ShowdownContext } from './augmentEngine';

const POOL = augmentsData as Augment[];

function byId(id: string): Augment {
  const a = POOL.find((x) => x.id === id);
  if (!a) throw new Error(`fixture augment not found: ${id}`);
  return a;
}

// 저번에 정의한 증강 5종
const flushBoost = byId('aug_flush_boost'); // on_showdown, handType:flush, x1.5
const cardSwap = byId('aug_card_swap'); // on_hand_start — 쇼다운 배당과 무관
const allinSnipe = byId('aug_allin_snipe'); // on_showdown, isAllIn:true, x2
const goldenFlip = byId('aug_golden_flip'); // on_round_start — 쇼다운 배당과 무관
const royalProphecy = byId('aug_royal_prophecy'); // on_shuffle — 쇼다운 배당과 무관

const ctx = (handCategory: ShowdownContext['handCategory'], isAllIn = false): ShowdownContext => ({
  handCategory,
  isAllIn,
});

describe('applyPayoutAugments — 쇼다운 배당 배율 적용', () => {
  it('보유 증강이 없으면 배당은 그대로다', () => {
    const result = applyPayoutAugments([], ctx('flush'), 1000);
    assert.equal(result.payout, 1000);
    assert.equal(result.multiplier, 1);
    assert.deepEqual(result.applied, []);
  });

  it('플러시의 축복: 플러시로 승리하면 1.5배', () => {
    const result = applyPayoutAugments([flushBoost], ctx('flush'), 1000);
    assert.equal(result.multiplier, 1.5);
    assert.equal(result.payout, 1500);
    assert.deepEqual(result.applied, [flushBoost]);
  });

  it('플러시의 축복: 스트레이트 플러시/로열 플러시도 상위 플러시 계열로 인정한다', () => {
    assert.equal(applyPayoutAugments([flushBoost], ctx('straight_flush'), 1000).multiplier, 1.5);
    assert.equal(applyPayoutAugments([flushBoost], ctx('royal_flush'), 1000).multiplier, 1.5);
  });

  it('플러시의 축복: 조건에 맞지 않는 족보면 발동하지 않는다', () => {
    const result = applyPayoutAugments([flushBoost], ctx('pair'), 1000);
    assert.equal(result.multiplier, 1);
    assert.equal(result.payout, 1000);
    assert.deepEqual(result.applied, []);
  });

  it('정조준 올인: 올인 상태로 승리하면 2배', () => {
    const result = applyPayoutAugments([allinSnipe], ctx('pair', true), 1000);
    assert.equal(result.multiplier, 2);
    assert.equal(result.payout, 2000);
  });

  it('정조준 올인: 올인이 아니면 발동하지 않는다', () => {
    const result = applyPayoutAugments([allinSnipe], ctx('pair', false), 1000);
    assert.equal(result.multiplier, 1);
    assert.equal(result.payout, 1000);
  });

  it('여러 증강이 동시에 조건을 만족하면 배율이 곱연산으로 누적된다', () => {
    const result = applyPayoutAugments([flushBoost, allinSnipe], ctx('flush', true), 1000);
    assert.equal(result.multiplier, 3); // 1.5 * 2
    assert.equal(result.payout, 3000);
    assert.equal(result.applied.length, 2);
  });

  it('쇼다운 배당과 무관한 증강(카드 재구성/황금 뒤집개/로열의 예언)은 영향을 주지 않는다', () => {
    const result = applyPayoutAugments([cardSwap, goldenFlip, royalProphecy], ctx('royal_flush', true), 1000);
    assert.equal(result.multiplier, 1);
    assert.equal(result.payout, 1000);
    assert.deepEqual(result.applied, []);
  });

  it('배당은 반올림된다', () => {
    // 333 * 1.5 = 499.5 -> 500
    const result = applyPayoutAugments([flushBoost], ctx('flush'), 333);
    assert.equal(result.payout, 500);
  });
});
