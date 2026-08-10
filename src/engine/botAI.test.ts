/**
 * 클라이언트 봇(rng 주입형) 판단 테스트.
 * tsconfig.app.json에서 제외돼 있으므로 앱 빌드에는 포함되지 않는다.
 * 실행: npx tsx --test src/engine/botAI.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeck } from './deck';
import { decideBotAction, type BotDecisionInput, type BotPersona } from './botAI';

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

/** 기본 판 상태 — 각 테스트에서 필요한 필드만 덮어쓴다 */
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

/**
 * 60회 중 "대부분"의 기준 (85%).
 * 저빈도 블러핑이 4~6% 섞이므로 명백한 상황이라도 100%를 요구할 수는 없다.
 */
const MOSTLY = 51;

/** 쿼드 에이스가 완성되는 리버 보드 — 에퀴티 1.0 */
const NUTS_BOARD = [card('clubs', 14), card('diamonds', 14), card('spades', 2), card('hearts', 7), card('clubs', 9)];

/** 여러 시드로 돌려 액션 분포를 센다 */
function actionCounts(input: BotDecisionInput, seeds: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let seed = 1; seed <= seeds; seed++) {
    const { action } = decideBotAction(input, seededRng(seed));
    counts[action] = (counts[action] ?? 0) + 1;
  }
  return counts;
}

// ── 명백한 상황에서의 판단 ──────────────────────────────────────────

test('리버 넛츠(쿼드 에이스)는 어떤 시드에서도 폴드하지 않는다', () => {
  for (const persona of PERSONAS) {
    const input = situation({
      community: [card('clubs', 14), card('diamonds', 14), card('spades', 2), card('hearts', 7), card('clubs', 9)],
      street: 'river',
      toCall: 400,
      potSize: 1200,
      persona,
    });
    const counts = actionCounts(input, 60);
    assert.equal(counts.fold ?? 0, 0, `${persona}: ${JSON.stringify(counts)}`);
  }
});

test('완패 확정 핸드(에퀴티 ≈ 0)로 큰 베팅을 콜하지 않는다', () => {
  // 45o vs 2-3-8-J-Q 보드 — 상대에게 거의 항상 진다 (에퀴티 ≈ 0.004)
  for (const persona of PERSONAS) {
    const input = situation({
      holeCards: [card('spades', 4), card('hearts', 5)],
      community: [card('clubs', 2), card('diamonds', 3), card('hearts', 8), card('clubs', 11), card('spades', 12)],
      street: 'river',
      toCall: 1500, // potOdds = 1500 / 2000 = 0.75
      potSize: 500,
      raisesThisStreet: 1,
      persona,
    });
    const counts = actionCounts(input, 60);
    assert.equal(counts.call ?? 0, 0, `${persona}가 콜함: ${JSON.stringify(counts)}`);
    assert.ok((counts.fold ?? 0) >= MOSTLY, `${persona} 폴드율 부족: ${JSON.stringify(counts)}`);
  }
});

test('팟오즈가 아주 좋으면(0.1) 약한 드로우로도 콜한다', () => {
  // 2s5s vs 9s-Ks-4h 플랍 — 완성된 핸드는 없고 플러시 드로우뿐 (에퀴티 ≈ 0.47)
  const draw = {
    holeCards: [card('spades', 2), card('spades', 5)],
    community: [card('spades', 9), card('spades', 13), card('hearts', 4)],
    street: 'flop' as const,
    raisesThisStreet: 1,
  };
  for (const persona of PERSONAS) {
    const cheap = actionCounts(
      situation({ ...draw, toCall: 100, potSize: 900, persona }), // potOdds = 0.10
      60,
    );
    assert.ok((cheap.call ?? 0) >= MOSTLY, `${persona} 싼 콜을 안 함: ${JSON.stringify(cheap)}`);

    // 같은 드로우인데 값이 비싸면 접어야 한다 — 무조건 콜하는 게 아님을 확인
    const pricey = actionCounts(
      situation({ ...draw, toCall: 2400, potSize: 1000, persona }), // potOdds ≈ 0.71
      60,
    );
    assert.ok((pricey.fold ?? 0) >= MOSTLY, `${persona} 비싼 콜을 접지 않음: ${JSON.stringify(pricey)}`);
  }
});

test('토탈 올인 콜은 팟오즈를 넘는 에퀴티가 있을 때만 한다', () => {
  const allin = { toCall: 800, botStack: 800, potSize: 800, street: 'river' as const };

  const nuts = actionCounts(
    situation({
      ...allin,
      community: [card('clubs', 14), card('diamonds', 14), card('spades', 2), card('hearts', 7), card('clubs', 9)],
    }),
    60,
  );
  assert.equal(nuts.call ?? 0, 60, `넛츠로 올인 콜을 안 함: ${JSON.stringify(nuts)}`);

  const trash = actionCounts(
    situation({
      ...allin,
      holeCards: [card('spades', 4), card('hearts', 5)],
      community: [card('clubs', 2), card('diamonds', 3), card('hearts', 8), card('clubs', 11), card('spades', 12)],
    }),
    60,
  );
  assert.ok((trash.fold ?? 0) >= MOSTLY, `완패 핸드로 올인 콜함: ${JSON.stringify(trash)}`);
});

test('베팅이 없고 에퀴티가 높으면 레이즈, 낮으면 체크', () => {
  const strong = actionCounts(
    situation({
      community: [card('clubs', 14), card('diamonds', 14), card('spades', 2), card('hearts', 7), card('clubs', 9)],
      street: 'river',
      toCall: 0,
      botStack: 9000, // potSize * 2 보다 커서 allin 분기를 피한다
    }),
    60,
  );
  assert.equal(strong.check ?? 0, 0, `넛츠로 체크함: ${JSON.stringify(strong)}`);

  const weak = actionCounts(
    situation({
      holeCards: [card('spades', 4), card('hearts', 5)],
      community: [card('clubs', 2), card('diamonds', 3), card('hearts', 8), card('clubs', 11), card('spades', 12)],
      street: 'river',
      toCall: 0,
    }),
    60,
  );
  assert.ok((weak.check ?? 0) >= MOSTLY, `약한 핸드로 체크를 안 함: ${JSON.stringify(weak)}`);
});

// ── 재현성 · 페르소나 · reason ──────────────────────────────────────

test('같은 시드는 같은 결정을 재현한다', () => {
  const input = situation({
    community: [card('spades', 9), card('spades', 13), card('hearts', 4)],
    street: 'flop',
    toCall: 200,
    potSize: 600,
  });
  for (const seed of [1, 7, 42, 1234]) {
    const first = decideBotAction(input, seededRng(seed));
    const second = decideBotAction(input, seededRng(seed));
    assert.deepEqual(first, second, `seed ${seed} 재현 실패`);
  }
});

test('시드가 다르면 결정이 갈리는 구간이 존재한다', () => {
  // 폴드 기준선(potOdds - foldMargin - offset)이 에퀴티 한가운데 걸리도록 잡으면
  // ±jitter 때문에 시드마다 콜/폴드가 갈려야 한다.
  // 27o vs 9s-Ks-4h 에퀴티 ≈ 0.17, cautious 기준선 = 0.143 - 0.01 + 0.04 ≈ 0.173
  const counts = actionCounts(
    situation({
      holeCards: [card('clubs', 2), card('diamonds', 7)],
      community: [card('spades', 9), card('spades', 13), card('hearts', 4)],
      street: 'flop',
      toCall: 150,
      potSize: 900, // potOdds ≈ 0.143
      raisesThisStreet: 1,
    }),
    120,
  );
  assert.ok((counts.call ?? 0) > 0 && (counts.fold ?? 0) > 0, `콜/폴드가 갈리지 않음: ${JSON.stringify(counts)}`);
});

test('페르소나 오프셋만으로 콜/폴드가 갈리는 구간이 있다', () => {
  // 플러시 드로우(에퀴티 ≈ 0.47)에 potOdds를 에퀴티와 같은 0.47로 맞춘다.
  // 폴드 기준선 = potOdds - foldMargin - personaOffset 이므로
  // aggressive는 0.44, cautious는 0.50 — 에퀴티가 정확히 그 사이에 놓인다.
  // (두 오프셋 간격이 0.06뿐이라 ±0.04 흔들림보다 좁다. 그래서 "한쪽은 항상 콜,
  //  다른 쪽은 항상 폴드"가 아니라 콜 비율이 크게 갈리는 것으로 확인한다.)
  const marginal = situation({
    holeCards: [card('spades', 2), card('spades', 5)],
    community: [card('spades', 9), card('spades', 13), card('hearts', 4)],
    street: 'flop',
    toCall: 880,
    potSize: 1000, // potOdds ≈ 0.468
    raisesThisStreet: 1,
  });
  const aggro = actionCounts({ ...marginal, persona: 'aggressive' }, 120);
  const cautious = actionCounts({ ...marginal, persona: 'cautious' }, 120);
  assert.ok((aggro.call ?? 0) > (cautious.call ?? 0) * 3, `콜 격차 부족: aggressive=${JSON.stringify(aggro)} cautious=${JSON.stringify(cautious)}`);
  assert.ok((cautious.fold ?? 0) > (aggro.fold ?? 0) * 3, `폴드 격차 부족: aggressive=${JSON.stringify(aggro)} cautious=${JSON.stringify(cautious)}`);
});

test('detail에 에퀴티와 팟오즈 수치가 들어간다', () => {
  const facingBet = decideBotAction(
    situation({
      community: [card('spades', 9), card('spades', 13), card('hearts', 4)],
      street: 'flop',
      toCall: 200,
      potSize: 600,
    }),
    seededRng(11),
  );
  assert.match(facingBet.detail ?? '', /equity \d\.\d\d (>=|<) potOdds \d\.\d\d/, String(facingBet.detail));

  const noBet = decideBotAction(situation({ toCall: 0 }), seededRng(11));
  assert.match(noBet.detail ?? '', /equity \d\.\d\d, 무베팅/, String(noBet.detail));
});

test('reason은 플레이어에게 보이는 대사뿐 — 수치가 새지 않는다', () => {
  // reason은 말풍선·게임 로그에 그대로 나가므로 숫자가 하나라도 있으면 안 된다.
  // 다섯 액션이 각각 확정적으로 나오는 상황 — 블러핑 운에 기대지 않는다
  const deadHole = [card('spades', 4), card('hearts', 5)];
  const deadBoard = [card('clubs', 2), card('diamonds', 3), card('hearts', 8), card('clubs', 11), card('spades', 12)];
  const drawHole = [card('spades', 2), card('spades', 5)];
  const drawBoard = [card('spades', 9), card('spades', 13), card('hearts', 4)];
  const spots: Partial<BotDecisionInput>[] = [
    { holeCards: deadHole, community: deadBoard, street: 'river', toCall: 0 }, // 체크
    { holeCards: drawHole, community: drawBoard, street: 'flop', toCall: 100, potSize: 900, raisesThisStreet: 2 }, // 콜
    { holeCards: deadHole, community: deadBoard, street: 'river', toCall: 1500, potSize: 500, raisesThisStreet: 2 }, // 폴드
    { community: NUTS_BOARD, street: 'river', toCall: 400, potSize: 1200 }, // 레이즈
    { community: NUTS_BOARD, street: 'river', toCall: 800, botStack: 800, potSize: 800 }, // 올인 콜
    { holeCards: [card('spades', 14), card('hearts', 14), card('clubs', 14)], toCall: 200, potSize: 600 }, // 폴백(추정)
  ];

  const seen = new Set<string>();
  for (const spot of spots) {
    for (const persona of PERSONAS) {
      for (let seed = 1; seed <= 30; seed++) {
        const { reason } = decideBotAction(situation({ ...spot, persona }), seededRng(seed));
        assert.ok(!/\d/.test(reason), `reason에 숫자가 들어 있음: "${reason}"`);
        assert.ok(!reason.includes('equity') && !reason.includes('potOdds'), `reason에 수치 표현이 있음: "${reason}"`);
        seen.add(reason);
      }
    }
  }
  // 위 상황들이 실제로 여러 분기를 탔는지 (대사가 한 종류만 나왔다면 검사가 무의미)
  assert.ok(seen.size >= 5, `대사 종류가 너무 적음: ${[...seen].join(' / ')}`);
});

test('에퀴티를 계산할 수 없는 입력은 estimateStrength 폴백으로 처리한다', () => {
  // 홀카드 3장 — calculateEquity가 거부하는 입력
  const decision = decideBotAction(
    situation({
      holeCards: [card('spades', 14), card('hearts', 14), card('clubs', 14)],
      toCall: 200,
      potSize: 600,
    }),
    seededRng(3),
  );
  assert.match(decision.detail ?? '', /\(추정\)/, String(decision.detail));
  assert.ok(['fold', 'call', 'raise', 'allin', 'check'].includes(decision.action));
});
