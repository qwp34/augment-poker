import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFixedBet } from './betSizing';

describe('computeFixedBet — 삥', () => {
  it('아무도 베팅 안 한 스트리트(currentBet=0)에서는 빅블라인드만큼', () => {
    const r = computeFixedBet('bet_bb', { currentBet: 0, potTotal: 300, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.deepEqual(r, { pay: 100, raises: true });
  });

  it('이미 베팅이 있으면(currentBet>0) 거부', () => {
    const r = computeFixedBet('bet_bb', { currentBet: 100, potTotal: 300, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.equal(typeof r, 'string');
  });

  it('스택이 빅블라인드보다 적으면 자동 올인(캡)', () => {
    const r = computeFixedBet('bet_bb', { currentBet: 0, potTotal: 300, bigBlind: 100, streetBet: 0, stack: 37 });
    assert.deepEqual(r, { pay: 37, raises: true });
  });
});

describe('computeFixedBet — 따당', () => {
  it('현재 베팅액의 정확히 2배로 레이즈 (베팅 없던 상태에서는 거부)', () => {
    const reject = computeFixedBet('bet_double', { currentBet: 0, potTotal: 300, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.equal(typeof reject, 'string');

    // 프리플랍: 빅블라인드 100이 이미 걸려 있고, UTG가 따당 → 200으로 레이즈(직전 베팅의 2배)
    const r1 = computeFixedBet('bet_double', { currentBet: 100, potTotal: 250, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.deepEqual(r1, { pay: 200, raises: true });
  });

  it('여러 라운드에 걸쳐 직전 베팅 기준으로 계속 정확히 2배가 된다 (누적 체이닝 검증)', () => {
    // 1차: currentBet 100 → 따당 → 200
    const r1 = computeFixedBet('bet_double', { currentBet: 100, potTotal: 250, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.equal((r1 as { pay: number }).pay, 200);
    const newCurrentBet1 = 0 + (r1 as { pay: number }).pay; // streetBet(0) + pay
    assert.equal(newCurrentBet1, 200);

    // 2차: 상대가 다시 따당 → 새 currentBet(200)의 2배인 400
    const r2 = computeFixedBet('bet_double', { currentBet: newCurrentBet1, potTotal: 450, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.equal((r2 as { pay: number }).pay, 400);
    const newCurrentBet2 = 0 + (r2 as { pay: number }).pay;
    assert.equal(newCurrentBet2, 400);

    // 3차: 이미 100을 콜해서 걸어둔 플레이어가 따당 → 목표 총액 800에서 이미 낸 100을 뺀 700만 추가로
    const r3 = computeFixedBet('bet_double', { currentBet: newCurrentBet2, potTotal: 900, bigBlind: 100, streetBet: 100, stack: 5000 });
    assert.deepEqual(r3, { pay: 700, raises: true });
  });

  it('2배 금액이 스택을 넘으면 자동 올인(캡)', () => {
    const r = computeFixedBet('bet_double', { currentBet: 300, potTotal: 900, bigBlind: 100, streetBet: 0, stack: 400 });
    assert.deepEqual(r, { pay: 400, raises: true });
  });
});

describe('computeFixedBet — 쿼터/하프', () => {
  it('베팅이 없을 때(currentBet=0)는 팟의 25%/50%를 그대로 베팅', () => {
    const q = computeFixedBet('bet_quarter', { currentBet: 0, potTotal: 1000, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.deepEqual(q, { pay: 250, raises: true });
    const h = computeFixedBet('bet_half', { currentBet: 0, potTotal: 1000, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.deepEqual(h, { pay: 500, raises: true });
  });

  it('베팅이 있을 때(currentBet>0)는 콜 위에 팟 비율만큼 얹어 레이즈', () => {
    // currentBet 200, 내 streetBet 0 → toCall 200, 팟 1000의 25% = 250 → 총 450
    const q = computeFixedBet('bet_quarter', { currentBet: 200, potTotal: 1000, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.deepEqual(q, { pay: 450, raises: true });
  });

  it('팟이 바뀌면 같은 조건이라도 실시간으로 다른 금액이 나온다 (재계산 검증)', () => {
    const small = computeFixedBet('bet_half', { currentBet: 0, potTotal: 200, bigBlind: 100, streetBet: 0, stack: 5000 });
    const big = computeFixedBet('bet_half', { currentBet: 0, potTotal: 2000, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.equal((small as { pay: number }).pay, 100);
    assert.equal((big as { pay: number }).pay, 1000);
  });

  it('반올림 결과가 0이면(팟이 사실상 없음) 무효 처리', () => {
    const r = computeFixedBet('bet_quarter', { currentBet: 0, potTotal: 1, bigBlind: 100, streetBet: 0, stack: 5000 });
    assert.equal(typeof r, 'string');
  });

  it('스택 초과분은 자동 올인(캡)', () => {
    const r = computeFixedBet('bet_half', { currentBet: 0, potTotal: 10000, bigBlind: 100, streetBet: 0, stack: 800 });
    assert.deepEqual(r, { pay: 800, raises: true });
  });
});
