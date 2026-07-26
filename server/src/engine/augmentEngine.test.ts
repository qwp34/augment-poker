import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import augmentsData from '../data/augments.json';
import type { Card } from './types';
import {
  applyPayoutAugments,
  applyEditCard,
  swapCards,
  revealCard,
  needsTargetSelection,
  isOneShotAugment,
  collectHandStartTargetQueue,
  type Augment,
  type ShowdownContext,
} from './augmentEngine';

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

// 대상 지정이 필요한 증강 3종 — 음침한 눈/당근이세요?는 매 핸드 재발동(on_hand_start),
// 카멜레온만 유일하게 최초 1회만 발동하고 소모되는 예외(on_pick)
const sinisterEye = byId('aug_sinister_eye'); // 음침한 눈 — reveal_opponent_card, on_hand_start
const chameleon = byId('aug_chameleon'); // 카멜레온 — edit_own_card, on_pick(일회성)
const carrot = byId('aug_carrot'); // 당근이세요? — swap_with_opponent, on_hand_start

function card(suit: Card['suit'], rank: Card['rank'], id = `${suit}-${rank}`): Card {
  return { id, suit, rank };
}

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

describe('needsTargetSelection — 대상 지정형 증강 판별', () => {
  it('음침한 눈/카멜레온/당근이세요?는 대상 지정이 필요하다', () => {
    assert.equal(needsTargetSelection(sinisterEye), true);
    assert.equal(needsTargetSelection(chameleon), true);
    assert.equal(needsTargetSelection(carrot), true);
  });

  it('기존 5종은 대상 지정이 필요 없다', () => {
    for (const a of [flushBoost, cardSwap, allinSnipe, goldenFlip, royalProphecy]) {
      assert.equal(needsTargetSelection(a), false, `${a.name}은 대상 지정형이 아니어야 함`);
    }
  });
});

describe('collectHandStartTargetQueue — 매 핸드 재발동 큐 구성', () => {
  it('대상 지정이 필요한 증강만, 주어진 순서(획득 순서) 그대로 뽑는다', () => {
    const queue = collectHandStartTargetQueue([carrot, flushBoost, chameleon, cardSwap, sinisterEye]);
    assert.deepEqual(queue, [carrot, chameleon, sinisterEye]);
  });

  it('대상 지정형 증강이 없으면 빈 큐를 반환한다', () => {
    assert.deepEqual(collectHandStartTargetQueue([flushBoost, cardSwap, goldenFlip]), []);
  });

  it('같은 보유 목록이라도 획득 순서가 다르면 큐의 순서도 그에 따라 달라진다', () => {
    const queueA = collectHandStartTargetQueue([sinisterEye, carrot]);
    const queueB = collectHandStartTargetQueue([carrot, sinisterEye]);
    assert.deepEqual(queueA, [sinisterEye, carrot]);
    assert.deepEqual(queueB, [carrot, sinisterEye]);
  });

  it('카멜레온(일회성)이 아직 소모되지 않았으면 다른 대상 지정형 증강과 함께 큐에 포함된다', () => {
    const queue = collectHandStartTargetQueue([chameleon, sinisterEye, carrot]);
    assert.deepEqual(queue, [chameleon, sinisterEye, carrot]);
  });

  it('카멜레온이 이미 소모된(usedOneShotIds) 뒤에는 큐에서 제외되지만, 나머지 재발동형은 그대로 남는다', () => {
    const queue = collectHandStartTargetQueue([chameleon, sinisterEye, carrot], [chameleon.id]);
    assert.deepEqual(queue, [sinisterEye, carrot]);
  });

  it('usedOneShotIds에 재발동형 증강의 id가 우연히 들어있어도(원래 그럴 일은 없지만) 영향받지 않는다', () => {
    const queue = collectHandStartTargetQueue([sinisterEye, carrot], [sinisterEye.id, carrot.id]);
    assert.deepEqual(queue, [sinisterEye, carrot]);
  });
});

describe('isOneShotAugment — 일회성(on_pick) 증강 판별', () => {
  it('카멜레온만 일회성이다', () => {
    assert.equal(isOneShotAugment(chameleon), true);
  });

  it('음침한 눈/당근이세요?를 포함한 나머지는 일회성이 아니다(매 핸드 재발동)', () => {
    for (const a of [flushBoost, cardSwap, allinSnipe, goldenFlip, royalProphecy, sinisterEye, carrot]) {
      assert.equal(isOneShotAugment(a), false, `${a.name}은 일회성이 아니어야 함`);
    }
  });
});

describe('revealCard — 음침한 눈 (조회 전용, 상태 변경 없음)', () => {
  it('지정한 인덱스의 카드를 그대로 반환한다', () => {
    const hole = [card('hearts', 14), card('spades', 2)];
    assert.deepEqual(revealCard(hole, 0), hole[0]);
    assert.deepEqual(revealCard(hole, 1), hole[1]);
  });

  it('원본 배열을 변경하지 않는다', () => {
    const hole = [card('hearts', 14), card('spades', 2)];
    const snapshot = [...hole];
    revealCard(hole, 0);
    assert.deepEqual(hole, snapshot);
  });
});

describe('applyEditCard — 카멜레온 (내 카드 자유 교체)', () => {
  it('지정한 인덱스만 원하는 숫자/무늬로 바뀌고 나머지 한 장은 그대로다', () => {
    const hole = [card('hearts', 5), card('clubs', 9)];
    const next = applyEditCard(hole, 0, 14, 'spades');
    assert.equal(next[0].rank, 14);
    assert.equal(next[0].suit, 'spades');
    assert.deepEqual(next[1], hole[1]); // 건드리지 않은 카드는 원래 그대로
  });

  it('원본 배열/카드를 훼손하지 않는다 (불변)', () => {
    const hole = [card('hearts', 5), card('clubs', 9)];
    const snapshot = hole.map((c) => ({ ...c }));
    applyEditCard(hole, 0, 14, 'spades');
    assert.deepEqual(hole, snapshot);
  });

  it('새로 만든 카드는 원본과 다른 고유 id를 가진다 (교체 전 카드와 값이 우연히 같아도 구분 가능)', () => {
    const hole = [card('hearts', 5), card('clubs', 9)];
    const next = applyEditCard(hole, 0, 5, 'hearts'); // 우연히 원래와 같은 숫자/무늬로 "교체"
    assert.notEqual(next[0].id, hole[0].id);
  });
});

describe('swapCards — 당근이세요? (상대와 카드 1장씩 교환)', () => {
  it('지정한 인덱스끼리 정확히 맞바뀐다', () => {
    const mine = [card('hearts', 14), card('spades', 2)];
    const theirs = [card('diamonds', 9), card('clubs', 3)];
    const result = swapCards(mine, theirs, 0, 1);
    assert.deepEqual(result.mine[0], theirs[1]); // 내 0번 자리엔 상대의 1번 카드가
    assert.deepEqual(result.mine[1], mine[1]); // 건드리지 않은 카드는 그대로
    assert.deepEqual(result.theirs[1], mine[0]); // 상대의 1번 자리엔 내 0번 카드가
    assert.deepEqual(result.theirs[0], theirs[0]);
  });

  it('원본 배열을 훼손하지 않는다 (불변)', () => {
    const mine = [card('hearts', 14), card('spades', 2)];
    const theirs = [card('diamonds', 9), card('clubs', 3)];
    const mineSnapshot = [...mine];
    const theirsSnapshot = [...theirs];
    swapCards(mine, theirs, 0, 1);
    assert.deepEqual(mine, mineSnapshot);
    assert.deepEqual(theirs, theirsSnapshot);
  });

  it('여러 증강이 순서대로 겹쳐도 문제없이 처리된다 — 카멜레온으로 바뀐 카드를 당근이세요로 교환', () => {
    // 1) A가 카멜레온으로 자기 카드 0번을 스페이드 에이스로 바꾼다
    const aHoleAfterChameleon = applyEditCard([card('hearts', 5), card('clubs', 9)], 0, 14, 'spades');
    assert.equal(aHoleAfterChameleon[0].rank, 14);
    assert.equal(aHoleAfterChameleon[0].suit, 'spades');

    // 2) B가 당근이세요?로 A의 0번(방금 바뀐 카드)과 자기 카드를 교환한다
    const bHole = [card('diamonds', 2), card('clubs', 3)];
    const { mine: bAfter, theirs: aAfterSwap } = swapCards(bHole, aHoleAfterChameleon, 0, 0);

    // B는 A가 카멜레온으로 만든 "스페이드 에이스"를 그대로 넘겨받아야 한다 — 원본(하트5)이 아니라
    assert.equal(bAfter[0].rank, 14);
    assert.equal(bAfter[0].suit, 'spades');
    // A는 그 대가로 B의 원래 카드를 받는다
    assert.deepEqual(aAfterSwap[0], bHole[0]);
    // 서로 건드리지 않은 두 번째 카드는 각자 그대로
    assert.deepEqual(bAfter[1], bHole[1]);
    assert.deepEqual(aAfterSwap[1], aHoleAfterChameleon[1]);
  });
});
