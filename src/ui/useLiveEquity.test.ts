/**
 * useLiveEquity의 순수 헬퍼 테스트 (훅 자체는 React 렌더가 필요해 제외).
 * 실행: npx tsx --test src/ui/useLiveEquity.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateEquity } from '../engine/equity';
import {
  countLiveOpponents,
  equityToPerMille,
  formatPerMille,
  toDeckCard,
  EQUITY_DISPLAY_ITERATIONS,
} from './useLiveEquity';

test('승률은 소수점 첫째 자리까지 표시한다', () => {
  const show = (equity: number) => formatPerMille(equityToPerMille(equity));
  assert.equal(show(0.632), '63.2%');
  assert.equal(show(1), '100.0%');
  assert.equal(show(0), '0.0%');
  // 반올림은 천분율 기준 — 0.6358 → 636‰ → 63.6%
  assert.equal(show(0.6358), '63.6%');
});

test('서버가 붙인 핸드 번호 접미사를 엔진 덱 id로 정규화한다', () => {
  // 멀티플레이 서버는 `spades-8#3`처럼 핸드 번호를 붙여 내려준다
  assert.equal(toDeckCard({ suit: 'spades', rank: 8 }).id, 'spades-8');
  assert.deepEqual(toDeckCard({ suit: 'hearts', rank: 14, isJoker: true }), {
    id: 'hearts-14',
    suit: 'hearts',
    rank: 14,
    isJoker: true,
  });
});

test('정규화하지 않으면 내 카드가 덱에 남아 상대에게 다시 배분된다', () => {
  // 쿼드 에이스 — 정규화된 입력이면 승률이 정확히 1이어야 한다
  const raw = [
    { suit: 'spades', rank: 14 },
    { suit: 'hearts', rank: 14 },
  ];
  const rawBoard = [
    { suit: 'clubs', rank: 14 },
    { suit: 'diamonds', rank: 14 },
    { suit: 'spades', rank: 2 },
    { suit: 'hearts', rank: 7 },
    { suit: 'clubs', rank: 9 },
  ];

  const normalized = calculateEquity({
    hole: raw.map(toDeckCard),
    board: rawBoard.map(toDeckCard),
    opponents: 3,
    iterations: EQUITY_DISPLAY_ITERATIONS,
  });
  assert.equal(normalized.equity, 1, '정규화된 입력은 확정 승리여야 한다');

  // 서버 id를 그대로 넘기면 제외가 하나도 안 걸려 상대가 같은 에이스를 받을 수 있다
  const suffixed = calculateEquity({
    hole: raw.map((c, i) => ({ ...toDeckCard(c), id: `${c.suit}-${c.rank}#${i}` })),
    board: rawBoard.map((c, i) => ({ ...toDeckCard(c), id: `${c.suit}-${c.rank}#${i}` })),
    opponents: 3,
    iterations: EQUITY_DISPLAY_ITERATIONS,
  });
  assert.ok(suffixed.equity < 1, `정규화 없이도 1이면 이 방어가 무의미하다 (${suffixed.equity})`);
});

test('상대 수는 자신을 빼고 폴드하지 않은 플레이어만 센다', () => {
  const players = [
    { sessionId: 'me', isFolded: false },
    { sessionId: 'a', isFolded: false },
    { sessionId: 'b', isFolded: true },
    { sessionId: 'c', isFolded: false },
  ];
  assert.equal(countLiveOpponents(players, 'me'), 2);

  // 전원이 폴드해도 계산에는 최소 1명이 필요하다
  assert.equal(countLiveOpponents([{ sessionId: 'me', isFolded: false }], 'me'), 1);
});

test('상대가 폴드하면 같은 핸드의 승률이 올라간다', () => {
  const hole = [
    { suit: 'clubs', rank: 9 },
    { suit: 'diamonds', rank: 10 },
  ].map(toDeckCard);
  const board = [
    { suit: 'spades', rank: 9 },
    { suit: 'spades', rank: 13 },
    { suit: 'hearts', rank: 4 },
  ].map(toDeckCard);

  const run = (opponents: number) =>
    calculateEquity({ hole, board, opponents, iterations: 4000 }).equity;

  const three = run(3);
  const one = run(1);
  assert.ok(one > three + 0.1, `상대가 줄어도 승률이 안 오름: 3명=${three} 1명=${one}`);
});
