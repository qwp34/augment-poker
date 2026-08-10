/**
 * 서버 봇 판단 테스트.
 * 서버 decideBotAction은 rng를 주입받지 않고 내부에서 Math.random을 쓰므로
 * 개별 결정 대신 여러 번 돌린 분포로 검증한다.
 * (시드 고정 재현성은 rng 주입형인 클라이언트 사본 테스트에서 다룬다)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeck } from './deck';
import {
  decideBotAction,
  estimateStrength,
  type BotDecision,
  type BotDecisionInput,
  type BotPersona,
} from './botAI';

const deck = createDeck();
const card = (suit: string, rank: number) =>
  deck.find((candidate) => candidate.suit === suit && candidate.rank === rank)!;

function situation(over: Partial<BotDecisionInput>): BotDecisionInput {
  return {
    holeCards: [card('spades', 14), card('hearts', 14)],
    community: [],
    street: 'preflop',
    toCall: 0,
    potSize: 300,
    botStack: 5000,
    raisesThisStreet: 0,
    persona: 'cautious',
    ...over,
  } as BotDecisionInput;
}

const PERSONAS: BotPersona[] = ['aggressive', 'cautious'];
const RUNS = 40;

function actionCounts(input: BotDecisionInput, runs = RUNS): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < runs; i++) {
    const decision = decideBotAction(input) as { action: string };
    counts[decision.action] = (counts[decision.action] ?? 0) + 1;
  }
  return counts;
}

const NUTS_BOARD = [card('clubs', 14), card('diamonds', 14), card('spades', 2), card('hearts', 7), card('clubs', 9)];
const DEAD_HOLE = [card('spades', 4), card('hearts', 5)];
const DEAD_BOARD = [card('clubs', 2), card('diamonds', 3), card('hearts', 8), card('clubs', 11), card('spades', 12)];

test('리버 넛츠는 폴드하지 않는다', () => {
  for (const persona of PERSONAS) {
    const counts = actionCounts(
      situation({ community: NUTS_BOARD, street: 'river', toCall: 400, potSize: 1200, persona }),
    );
    assert.equal(counts.fold ?? 0, 0, `${persona}: ${JSON.stringify(counts)}`);
  }
});

test('완패 확정 핸드로 큰 베팅을 콜하지 않는다', () => {
  for (const persona of PERSONAS) {
    const counts = actionCounts(
      situation({
        holeCards: DEAD_HOLE,
        community: DEAD_BOARD,
        street: 'river',
        toCall: 1500, // potOdds = 0.75
        potSize: 500,
        raisesThisStreet: 1,
        persona,
      }),
    );
    assert.equal(counts.call ?? 0, 0, `${persona}가 콜함: ${JSON.stringify(counts)}`);
    assert.ok((counts.fold ?? 0) >= RUNS * 0.85, `${persona} 폴드율 부족: ${JSON.stringify(counts)}`);
  }
});

test('팟오즈가 좋으면 약한 드로우로 콜하고, 나쁘면 접는다', () => {
  // 2s5s vs 9s-Ks-4h — 플러시 드로우뿐 (에퀴티 ≈ 0.47)
  const draw = {
    holeCards: [card('spades', 2), card('spades', 5)],
    community: [card('spades', 9), card('spades', 13), card('hearts', 4)],
    street: 'flop' as const,
    raisesThisStreet: 1,
  };
  const cheap = actionCounts(situation({ ...draw, toCall: 100, potSize: 900 })); // potOdds = 0.10
  assert.ok((cheap.call ?? 0) >= RUNS * 0.85, `싼 콜을 안 함: ${JSON.stringify(cheap)}`);

  const pricey = actionCounts(situation({ ...draw, toCall: 2400, potSize: 1000 })); // potOdds ≈ 0.71
  assert.ok((pricey.fold ?? 0) >= RUNS * 0.85, `비싼 콜을 접지 않음: ${JSON.stringify(pricey)}`);
});

test('올인 콜은 넛츠에서만 하고 완패 핸드에서는 접는다', () => {
  const allin = { toCall: 800, botStack: 800, potSize: 800, street: 'river' as const };

  const nuts = actionCounts(situation({ ...allin, community: NUTS_BOARD }));
  assert.equal(nuts.call ?? 0, RUNS, `넛츠로 올인 콜을 안 함: ${JSON.stringify(nuts)}`);

  const trash = actionCounts(situation({ ...allin, holeCards: DEAD_HOLE, community: DEAD_BOARD }));
  assert.ok((trash.fold ?? 0) >= RUNS * 0.85, `완패 핸드로 올인 콜함: ${JSON.stringify(trash)}`);
});

test('상대 수가 늘면 같은 핸드로 더 자주 접는다', () => {
  // 9-T 미들페어: 헤즈업 에퀴티 ≈ 0.73 이지만 상대 4명이면 ≈ 0.30 으로 떨어진다.
  // potOdds = 0.50 이 그 사이에 걸리므로 상대 수만으로 콜↔폴드가 갈려야 한다.
  const marginal = {
    holeCards: [card('clubs', 9), card('diamonds', 10)],
    community: [card('spades', 9), card('spades', 13), card('hearts', 4)],
    street: 'flop' as const,
    toCall: 1000,
    potSize: 1000,
    raisesThisStreet: 2, // 레이즈 분기를 막아 콜/폴드만 남긴다
  };
  const heads = actionCounts(situation({ ...marginal, opponents: 1 }), 60);
  const multi = actionCounts(situation({ ...marginal, opponents: 4 }), 60);
  assert.ok((heads.call ?? 0) >= 54, `헤즈업에서 콜하지 않음: ${JSON.stringify(heads)}`);
  assert.ok((multi.fold ?? 0) >= 54, `멀티웨이에서 접지 않음: ${JSON.stringify(multi)}`);
});

test('detail에 에퀴티와 팟오즈 수치가 들어간다', () => {
  const facingBet = decideBotAction(
    situation({ community: NUTS_BOARD, street: 'river', toCall: 200, potSize: 600 }),
  ) as BotDecision;
  assert.match(facingBet.detail ?? '', /equity \d\.\d\d (>=|<) potOdds \d\.\d\d/, String(facingBet.detail));

  const noBet = decideBotAction(situation({ toCall: 0 })) as BotDecision;
  assert.match(noBet.detail ?? '', /equity \d\.\d\d, 무베팅/, String(noBet.detail));
});

test('reason은 플레이어에게 보이는 대사뿐 — 수치가 새지 않는다', () => {
  // 다섯 액션이 각각 확정적으로 나오는 상황 — 블러핑 운에 기대지 않는다
  const DRAW_HOLE = [card('spades', 2), card('spades', 5)];
  const DRAW_BOARD = [card('spades', 9), card('spades', 13), card('hearts', 4)];
  const spots: Partial<BotDecisionInput>[] = [
    { holeCards: DEAD_HOLE, community: DEAD_BOARD, street: 'river', toCall: 0 }, // 체크
    { holeCards: DRAW_HOLE, community: DRAW_BOARD, street: 'flop', toCall: 100, potSize: 900, raisesThisStreet: 2 }, // 콜
    { holeCards: DEAD_HOLE, community: DEAD_BOARD, street: 'river', toCall: 1500, potSize: 500, raisesThisStreet: 2 }, // 폴드
    { community: NUTS_BOARD, street: 'river', toCall: 400, potSize: 1200 }, // 레이즈
    { community: NUTS_BOARD, street: 'river', toCall: 800, botStack: 800, potSize: 800 }, // 올인 콜
    { holeCards: [card('spades', 14), card('hearts', 14), card('clubs', 14)], toCall: 200, potSize: 600 }, // 폴백(추정)
  ];

  const seen = new Set<string>();
  for (const spot of spots) {
    for (const persona of PERSONAS) {
      for (let i = 0; i < 30; i++) {
        const { reason } = decideBotAction(situation({ ...spot, persona })) as BotDecision;
        assert.ok(!/\d/.test(reason), `reason에 숫자가 들어 있음: "${reason}"`);
        assert.ok(!reason.includes('equity') && !reason.includes('potOdds'), `reason에 수치 표현이 있음: "${reason}"`);
        seen.add(reason);
      }
    }
  }
  assert.ok(seen.size >= 5, `대사 종류가 너무 적음: ${[...seen].join(' / ')}`);
});

test('estimateStrength는 폴백용으로 남아 있다', () => {
  const strong = estimateStrength([card('spades', 14), card('hearts', 14)], []);
  const weak = estimateStrength([card('spades', 7), card('hearts', 2)], []);
  assert.ok(strong > weak, `${strong} <= ${weak}`);

  // 에퀴티 계산이 불가능한 입력(홀카드 3장)은 폴백으로 처리된다
  const decision = decideBotAction(
    situation({
      holeCards: [card('spades', 14), card('hearts', 14), card('clubs', 14)],
      toCall: 200,
      potSize: 600,
    }),
  ) as BotDecision;
  assert.match(decision.detail ?? '', /\(추정\)/, String(decision.detail));
});
