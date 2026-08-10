import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeck } from './deck';
import { calculateEquity } from './equity';

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const deck = createDeck();
const card = (suit: string, rank: number) =>
  deck.find((candidate) => candidate.suit === suit && candidate.rank === rank)!;

const aces = [card('spades', 14), card('hearts', 14)];

test('AA has expected heads-up preflop equity', () => {
  const result = calculateEquity({
    hole: aces,
    board: [],
    opponents: 1,
    iterations: 2000,
    rng: seededRng(1),
  });
  assert.ok(result.equity > 0.82 && result.equity < 0.88, `equity=${result.equity}`);
});

test('AA equity decreases against three opponents', () => {
  const result = calculateEquity({
    hole: aces,
    board: [],
    opponents: 3,
    iterations: 2000,
    rng: seededRng(1),
  });
  assert.ok(result.equity > 0.60 && result.equity < 0.68, `equity=${result.equity}`);
});

test('a made four-of-a-kind is a certain river winner', () => {
  const result = calculateEquity({
    hole: aces,
    board: [card('clubs', 14), card('diamonds', 14), card('spades', 2), card('hearts', 7), card('clubs', 9)],
    opponents: 3,
    rng: seededRng(2),
  });
  assert.equal(result.equity, 1);
});

test('a broadway straight on the board is a certain river tie', () => {
  const result = calculateEquity({
    hole: [card('spades', 2), card('hearts', 3)],
    board: [card('spades', 14), card('hearts', 13), card('diamonds', 12), card('clubs', 11), card('spades', 10)],
    opponents: 1,
    rng: seededRng(3),
  });
  assert.equal(result.equity, 0.5);
});

test('joker defaults to half the normal iteration count', () => {
  const result = calculateEquity({
    hole: [{ ...aces[0], isJoker: true }, aces[1]],
    board: [],
    opponents: 1,
    rng: seededRng(4),
  });
  assert.equal(result.iterations, 1000);
});

test('reports 2000-rollout timing with and without one joker', () => {
  const plainStart = performance.now();
  calculateEquity({ hole: aces, board: [], opponents: 1, iterations: 2000, rng: seededRng(5) });
  const plainMs = performance.now() - plainStart;

  const jokerStart = performance.now();
  calculateEquity({
    hole: [{ ...aces[0], isJoker: true }, aces[1]],
    board: [],
    opponents: 1,
    iterations: 2000,
    rng: seededRng(5),
  });
  const jokerMs = performance.now() - jokerStart;

  console.log(`equity benchmark: plain=${plainMs.toFixed(2)}ms, joker=${jokerMs.toFixed(2)}ms, slowdown=${(jokerMs / plainMs).toFixed(2)}x`);
  assert.ok(plainMs > 0 && jokerMs > 0);
});
