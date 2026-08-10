/**
 * 봇 self-play 하네스 — 봇 임계값 튜닝과 증강 밸런스 측정용.
 *
 * Colyseus를 띄우지 않고 엔진(deck/handEvaluator/equity/botAI)만으로 핸드를
 * 직접 시뮬레이션한다. 네트워크 왕복도, 연출 딜레이도 없어 수천 판을 돌릴 수 있다.
 *
 * 재현하는 범위: 블라인드 → 프리플랍/플랍/턴/리버 베팅 → 쇼다운(사이드팟 포함).
 * 재현하지 않는 범위: 증강, 딜러 특수 규칙, 대풍년/러시안 룰렛 등 변형.
 *   → 증강은 applyAugments 훅 자리만 비워뒀다(HAND_HOOKS 참고).
 *
 * 사용법:
 *   npm run selfplay                          기본 2000판, 헤즈업
 *   npm run selfplay -- --hands=500 --players=4
 *   npm run selfplay -- --foldMargin=0.05 --raiseFacingBet=0.72
 *   npm run selfplay -- --personaOffset.aggressive=0.02
 *   SELFPLAY_SET="foldMargin=0.05,allinCallMargin=0.12" npm run selfplay
 *
 * --<경로>=<숫자> 또는 SELFPLAY_SET 으로 BOT_EQUITY_CONFIG의 아무 숫자 항목이나
 * 덮어쓸 수 있다. 임계값을 바꿔가며 같은 판수로 비교하는 게 이 스크립트의 핵심 용도다.
 *
 * ── 알려진 한계: BB/100으로 설정을 비교하지 말 것 ──
 * 칩 수지(BB/100)는 노이즈 바닥이 ±50~75라 설정 비교에 쓸 수 없다. 두 페르소나를
 * 완전히 동일하게 맞춘 대조군(personaOffset.aggressive=-0.04)에서도 참값 0 대신
 * 2000판 기준 -73.6 / -17.2가 나왔다. 설정 간 실제 차이가 이 폭에 묻힌다.
 *
 * 설정 비교에는 [4] 손해 보는 콜 비율과 [2] 레이즈 비율을 써라. 핸드 결과가 아니라
 * 판단 8000건을 평균 내므로 회차 간 0.6%p 안에서 재현된다.
 *
 * 미러 핸드(같은 덱을 좌석만 바꿔 두 번 플레이해 카드 운을 상쇄)를 넣으면 BB/100의
 * 노이즈가 한 자릿수로 떨어져 수지로도 비교할 수 있다 — 아직 구현하지 않았다.
 */

import { createDeck, shuffle } from '../src/engine/deck';
import { compareHands, evaluateBest } from '../src/engine/handEvaluator';
import { calculateEquity } from '../src/engine/equity';
import { BOT_EQUITY_CONFIG, decideBotAction, type BotDecision, type BotPersona } from '../src/engine/botAI';
import type { Card, Street } from '../src/engine/types';

// ─────────────────────────── 설정 ───────────────────────────

const SMALL_BLIND = 50;
const BIG_BLIND = 100;
const STARTING_STACK = 10_000;

/** 핸드마다 스택을 초기화한다 — 파산으로 표본이 줄지 않게 하고 핸드당 손익을 그대로 누적한다 */
const RESET_STACKS_EACH_HAND = true;

interface Options {
  hands: number;
  players: number;
  /** 지표용 "진짜 에퀴티" 롤아웃 횟수 — 수천 건을 평균 내므로 봇보다 낮아도 된다 */
  truthIterations: number;
  quiet: boolean;
}

// ─────────────────────────── 인자 파싱 ───────────────────────────

/** BOT_EQUITY_CONFIG의 중첩 경로에 숫자를 써넣는다 (as const는 타입 전용이라 런타임 변경 가능) */
function applyOverride(path: string, raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`덮어쓸 값이 숫자가 아닙니다: ${path}=${raw}`);

  const keys = path.split('.');
  let target: Record<string, unknown> = BOT_EQUITY_CONFIG as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const next = target[key];
    if (typeof next !== 'object' || next === null) throw new Error(`알 수 없는 설정 경로: ${path}`);
    target = next as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1];
  if (typeof target[leaf] !== 'number') throw new Error(`알 수 없는 설정 경로: ${path}`);
  const before = target[leaf] as number;
  target[leaf] = value;
  return `${path}: ${before} → ${value}`;
}

function parseArgs(argv: string[]): { options: Options; overrides: string[] } {
  const options: Options = { hands: 2000, players: 2, truthIterations: 500, quiet: false };
  const overrides: string[] = [];

  const pairs: [string, string][] = [];
  for (const chunk of (process.env.SELFPLAY_SET ?? '').split(',')) {
    const trimmed = chunk.trim();
    if (trimmed) {
      const [key, value] = trimmed.split('=');
      pairs.push([key, value]);
    }
  }
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value = 'true'] = arg.slice(2).split('=');
    pairs.push([key, value]);
  }

  for (const [key, value] of pairs) {
    switch (key) {
      case 'hands': options.hands = Number(value); break;
      case 'players': options.players = Number(value); break;
      case 'truthIterations': options.truthIterations = Number(value); break;
      case 'quiet': options.quiet = value !== 'false'; break;
      default: overrides.push(applyOverride(key, value));
    }
  }

  if (!Number.isInteger(options.hands) || options.hands < 1) throw new Error(`--hands는 1 이상의 정수 (현재 ${options.hands})`);
  if (options.players !== 2 && options.players !== 4) throw new Error(`--players는 2 또는 4 (현재 ${options.players})`);
  return { options, overrides };
}

// ─────────────────────────── 핸드 상태 ───────────────────────────

interface SimPlayer {
  seat: number;
  persona: BotPersona;
  stack: number;
  hole: Card[];
  folded: boolean;
  allIn: boolean;
  /** 이번 스트리트에 낸 칩 */
  streetBet: number;
  /** 이번 핸드에 낸 칩 총합 (사이드팟 계산용) */
  contributed: number;
  hasActed: boolean;
}

/** 판단 1건의 기록 — 리포트는 전부 이 배열에서 만든다 */
interface DecisionRecord {
  persona: BotPersona;
  street: Street;
  action: BotDecision['action'];
  toCall: number;
  potOdds: number;
  /** 하네스가 따로 계산한 실제 에퀴티 (봇의 흔들림/블러핑이 섞이지 않은 값) */
  trueEquity: number;
  /** 봇이 reason에 남긴, 실제 판단에 쓴 에퀴티 */
  botEquity: number | null;
}

/** 증강을 나중에 붙이기 위한 자리 — 지금은 아무것도 하지 않는다 */
const HAND_HOOKS = {
  /** 홀카드를 나눠준 직후 (증강 선택/즉시 효과가 들어갈 곳) */
  afterDeal(_players: SimPlayer[]): void {},
  /** 쇼다운 배당 직전 (배율 증강이 들어갈 곳) */
  beforePayout(_players: SimPlayer[]): void {},
};

const STREETS: { name: Street; boardSize: number }[] = [
  { name: 'preflop', boardSize: 0 },
  { name: 'flop', boardSize: 3 },
  { name: 'turn', boardSize: 4 },
  { name: 'river', boardSize: 5 },
];

// ─────────────────────────── 사이드팟 ───────────────────────────

interface Pot {
  amount: number;
  /** 이 팟을 다툴 수 있는 좌석 */
  eligible: number[];
}

/**
 * 투입액 계층별로 팟을 쪼갠다.
 * 폴드한 플레이어의 칩도 팟에 남지만 그들은 eligible에서 빠진다.
 */
function buildPots(players: SimPlayer[]): Pot[] {
  const pots: Pot[] = [];
  const remaining = players.map((p) => p.contributed);

  for (;;) {
    const contributors = players.map((_, i) => i).filter((i) => remaining[i] > 0);
    if (contributors.length === 0) break;

    const live = contributors.filter((i) => !players[i].folded);
    if (live.length === 0) {
      // 남은 칩이 전부 폴드한 사람 것 — 마지막 팟에 합친다
      const leftover = contributors.reduce((sum, i) => sum + remaining[i], 0);
      contributors.forEach((i) => (remaining[i] = 0));
      if (pots.length > 0) pots[pots.length - 1].amount += leftover;
      break;
    }

    const level = Math.min(...live.map((i) => remaining[i]));
    let amount = 0;
    for (const i of contributors) {
      const take = Math.min(level, remaining[i]);
      amount += take;
      remaining[i] -= take;
    }
    pots.push({ amount, eligible: live });
  }

  return pots;
}

// ─────────────────────────── 한 핸드 ───────────────────────────

interface HandOutcome {
  reachedShowdown: boolean;
}

async function playHand(
  players: SimPlayer[],
  buttonSeat: number,
  options: Options,
  records: DecisionRecord[],
): Promise<HandOutcome> {
  const deck = shuffle(createDeck());
  let next = 0;

  for (const p of players) {
    p.hole = [deck[next++], deck[next++]];
    p.folded = false;
    p.allIn = false;
    p.streetBet = 0;
    p.contributed = 0;
    p.hasActed = false;
  }
  HAND_HOOKS.afterDeal(players);

  const board: Card[] = [];
  const n = players.length;
  const seatAfter = (offset: number) => players[(buttonSeat + offset) % n];

  // 블라인드 — 헤즈업은 버튼이 SB, 그 외는 버튼 다음이 SB
  const sb = n === 2 ? seatAfter(0) : seatAfter(1);
  const bb = n === 2 ? seatAfter(1) : seatAfter(2);
  const post = (p: SimPlayer, amount: number) => {
    const paid = Math.min(amount, p.stack);
    p.stack -= paid;
    p.streetBet += paid;
    p.contributed += paid;
    if (p.stack === 0) p.allIn = true;
  };
  post(sb, SMALL_BLIND);
  post(bb, BIG_BLIND);

  // 지표용 실제 에퀴티 캐시 — 같은 (좌석, 보드, 상대 수)면 다시 굴리지 않는다
  const truthCache = new Map<string, number>();
  const trueEquityFor = (p: SimPlayer, liveOpponents: number): number => {
    const key = `${p.seat}|${board.length}|${liveOpponents}`;
    const cached = truthCache.get(key);
    if (cached !== undefined) return cached;
    const { equity } = calculateEquity({
      hole: p.hole,
      board,
      opponents: liveOpponents,
      iterations: options.truthIterations,
    });
    truthCache.set(key, equity);
    return equity;
  };

  let reachedShowdown = false;

  for (const street of STREETS) {
    if (players.filter((p) => !p.folded).length <= 1) break;

    while (board.length < street.boardSize) board.push(deck[next++]);

    for (const p of players) {
      p.streetBet = 0;
      p.hasActed = false;
    }

    // 프리플랍만 블라인드를 다시 얹는다 (위에서 이미 낸 금액을 streetBet으로 복원)
    let currentBet = 0;
    if (street.name === 'preflop') {
      sb.streetBet = Math.min(SMALL_BLIND, sb.contributed);
      bb.streetBet = Math.min(BIG_BLIND, bb.contributed);
      currentBet = bb.streetBet;
    }

    // 첫 행동 좌석(버튼 기준 오프셋).
    // 프리플랍: 헤즈업은 버튼(=SB)부터, 그 외는 UTG(버튼+3)부터.
    // 포스트플랍: 버튼 다음 좌석부터 (헤즈업이면 BB).
    let cursor = street.name === 'preflop' ? (n === 2 ? 0 : 3) : 1;
    let raisesThisStreet = 0;

    for (let guard = 0; guard < 400; guard++) {
      if (players.filter((p) => !p.folded).length <= 1) break;

      // 아직 행동이 필요한 좌석 찾기
      let actor: SimPlayer | null = null;
      for (let step = 0; step < n; step++) {
        const candidate = seatAfter((cursor + step) % n);
        if (candidate.folded || candidate.allIn) continue;
        if (candidate.hasActed && candidate.streetBet === currentBet) continue;
        actor = candidate;
        cursor = (cursor + step + 1) % n;
        break;
      }
      if (!actor) break;

      const toCall = currentBet - actor.streetBet;
      const potSize = players.reduce((sum, p) => sum + p.contributed, 0);
      const liveOpponents = Math.max(1, players.filter((p) => !p.folded && p !== actor).length);

      const decision = (await decideBotAction({
        holeCards: actor.hole,
        community: board,
        street: street.name,
        toCall,
        potSize,
        botStack: actor.stack,
        raisesThisStreet,
        persona: actor.persona,
        opponents: liveOpponents,
      })) as BotDecision;

      // 서버 applyAction과 같은 방어적 보정 — 불가능한 액션은 안전한 쪽으로 바꾼다
      let action = decision.action;
      if (action === 'check' && toCall > 0) action = 'fold';
      if (action === 'fold' && toCall === 0) action = 'check';

      records.push({
        persona: actor.persona,
        street: street.name,
        action,
        toCall,
        potOdds: toCall > 0 ? toCall / (potSize + toCall) : 0,
        trueEquity: trueEquityFor(actor, liveOpponents),
        botEquity: parseReportedEquity(decision.detail),
      });

      const pay = (amount: number) => {
        const paid = Math.max(0, Math.min(amount, actor!.stack));
        actor!.stack -= paid;
        actor!.streetBet += paid;
        actor!.contributed += paid;
        if (actor!.stack === 0) actor!.allIn = true;
      };

      switch (action) {
        case 'fold': actor.folded = true; break;
        case 'check': break;
        case 'call': pay(toCall); break;
        case 'allin': pay(actor.stack); break;
        case 'raise': pay(toCall + Math.max(BIG_BLIND, Math.round(decision.amount ?? BIG_BLIND))); break;
      }

      actor.hasActed = true;
      if (actor.streetBet > currentBet) {
        currentBet = actor.streetBet;
        raisesThisStreet++;
        // 레이즈가 나오면 나머지는 다시 응수해야 한다
        for (const other of players) {
          if (other !== actor && !other.folded && !other.allIn) other.hasActed = false;
        }
      }
    }
  }

  // ── 배당 ──
  const live = players.filter((p) => !p.folded);
  HAND_HOOKS.beforePayout(players);

  if (live.length === 1) {
    live[0].stack += players.reduce((sum, p) => sum + p.contributed, 0);
  } else {
    reachedShowdown = true;
    while (board.length < 5) board.push(deck[next++]);
    const hands = players.map((p) => (p.folded ? null : evaluateBest([...p.hole, ...board])));

    for (const pot of buildPots(players)) {
      let best: number[] = [];
      for (const seat of pot.eligible) {
        if (best.length === 0) { best = [seat]; continue; }
        const cmp = compareHands(hands[seat]!, hands[best[0]]!);
        if (cmp > 0) best = [seat];
        else if (cmp === 0) best.push(seat);
      }
      const share = Math.floor(pot.amount / best.length);
      best.forEach((seat) => (players[seat].stack += share));
      // 나눠떨어지지 않는 잔돈은 첫 승자에게
      players[best[0]].stack += pot.amount - share * best.length;
    }
  }

  return { reachedShowdown };
}

/**
 * botAI가 detail에 남긴 "equity 0.42 >= potOdds 0.25"에서 에퀴티를 읽는다.
 * (reason은 플레이어에게 보이는 대사라 수치가 없다 — 파싱 대상이 아니다)
 */
function parseReportedEquity(detail: string | undefined): number | null {
  if (!detail) return null;
  const match = /equity (\d+\.\d+)/.exec(detail);
  return match ? Number(match[1]) : null;
}

// ─────────────────────────── 리포트 ───────────────────────────

const ACTIONS: BotDecision['action'][] = ['fold', 'check', 'call', 'raise', 'allin'];

function pct(part: number, whole: number): string {
  return whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;
}

function avg(values: number[]): string {
  return values.length === 0 ? '—' : (values.reduce((a, b) => a + b, 0) / values.length).toFixed(3);
}

function report(
  records: DecisionRecord[],
  netByPersona: Map<BotPersona, number>,
  handsByPersona: Map<BotPersona, number>,
  showdowns: number,
  options: Options,
  overrides: string[],
  elapsedMs: number,
) {
  const personas: BotPersona[] = ['aggressive', 'cautious'];
  const line = (char = '─') => console.log(char.repeat(78));

  line('━');
  console.log(`self-play 리포트 — ${options.hands}판 / ${options.players}인 / 소요 ${(elapsedMs / 1000).toFixed(1)}초`);
  console.log(
    `블라인드 ${SMALL_BLIND}/${BIG_BLIND} · 시작 스택 ${STARTING_STACK.toLocaleString()}` +
      `${RESET_STACKS_EACH_HAND ? ' (핸드마다 초기화)' : ''} · 봇 롤아웃 ${BOT_EQUITY_CONFIG.iterations} · 지표 롤아웃 ${options.truthIterations}`,
  );
  console.log(overrides.length > 0 ? `임계값 덮어쓰기: ${overrides.join(' | ')}` : '임계값: 기본값 (덮어쓰기 없음)');
  line('━');

  // ── 1. 페르소나별 칩 수지 ──
  console.log('\n[1] 페르소나별 칩 수지  (가장 중요한 지표)');
  console.log(`  ${'페르소나'.padEnd(12)}${'핸드'.padStart(8)}${'총 수지'.padStart(14)}${'핸드당'.padStart(12)}${'BB/100'.padStart(11)}`);
  for (const persona of personas) {
    const net = netByPersona.get(persona) ?? 0;
    const hands = handsByPersona.get(persona) ?? 0;
    const perHand = hands === 0 ? 0 : net / hands;
    const bb100 = (perHand / BIG_BLIND) * 100;
    console.log(
      `  ${persona.padEnd(12)}${String(hands).padStart(8)}${net.toLocaleString().padStart(14)}` +
        `${perHand.toFixed(1).padStart(12)}${bb100.toFixed(1).padStart(11)}`,
    );
  }

  // ── 2. 액션 분포 ──
  console.log('\n[2] 액션 분포');
  console.log(`  ${'페르소나'.padEnd(12)}${'판단수'.padStart(9)}${ACTIONS.map((a) => a.padStart(9)).join('')}`);
  for (const persona of personas) {
    const mine = records.filter((r) => r.persona === persona);
    const cells = ACTIONS.map((a) => pct(mine.filter((r) => r.action === a).length, mine.length).padStart(9)).join('');
    console.log(`  ${persona.padEnd(12)}${String(mine.length).padStart(9)}${cells}`);
  }

  // ── 3. 액션 시점의 실제 에퀴티 ──
  console.log('\n[3] 액션 시점의 평균 실제 에퀴티  (봇의 흔들림/블러핑을 뺀 값)');
  console.log(`  ${'페르소나'.padEnd(12)}${'콜'.padStart(10)}${'폴드'.padStart(10)}${'레이즈'.padStart(11)}${'체크'.padStart(10)}${'올인'.padStart(10)}`);
  for (const persona of personas) {
    const mine = records.filter((r) => r.persona === persona);
    const at = (a: BotDecision['action']) => avg(mine.filter((r) => r.action === a).map((r) => r.trueEquity));
    console.log(
      `  ${persona.padEnd(12)}${at('call').padStart(10)}${at('fold').padStart(10)}` +
        `${at('raise').padStart(11)}${at('check').padStart(10)}${at('allin').padStart(10)}`,
    );
  }

  // ── 4. 손해 보는 콜 ──
  console.log('\n[4] 손해 보는 콜  (실제 에퀴티 < 팟오즈인데 콜/올인콜한 비율)');
  console.log(`  ${'페르소나'.padEnd(12)}${'유료 콜'.padStart(10)}${'그중 손해'.padStart(12)}${'비율'.padStart(9)}${'평균 손실폭'.padStart(14)}`);
  for (const persona of personas) {
    const paidCalls = records.filter((r) => r.persona === persona && r.action === 'call' && r.toCall > 0);
    const losing = paidCalls.filter((r) => r.trueEquity < r.potOdds);
    const gap = avg(losing.map((r) => r.potOdds - r.trueEquity));
    console.log(
      `  ${persona.padEnd(12)}${String(paidCalls.length).padStart(10)}${String(losing.length).padStart(12)}` +
        `${pct(losing.length, paidCalls.length).padStart(9)}${gap.padStart(14)}`,
    );
  }

  // ── 5. 스트리트별 손해 보는 콜 ──
  console.log('\n[5] 스트리트별 손해 보는 콜 비율');
  console.log(`  ${'스트리트'.padEnd(12)}${'유료 콜'.padStart(10)}${'손해'.padStart(9)}${'비율'.padStart(9)}`);
  for (const street of STREETS) {
    const paidCalls = records.filter((r) => r.street === street.name && r.action === 'call' && r.toCall > 0);
    const losing = paidCalls.filter((r) => r.trueEquity < r.potOdds);
    console.log(
      `  ${street.name.padEnd(12)}${String(paidCalls.length).padStart(10)}` +
        `${String(losing.length).padStart(9)}${pct(losing.length, paidCalls.length).padStart(9)}`,
    );
  }

  // ── 6. 요약 ──
  console.log('\n[6] 전체');
  console.log(`  쇼다운 도달률      ${pct(showdowns, options.hands)}  (${showdowns} / ${options.hands})`);
  console.log(`  핸드당 판단 수     ${(records.length / options.hands).toFixed(2)}`);
  const withBoth = records.filter((r) => r.botEquity !== null);
  const bias = withBoth.map((r) => r.botEquity! - r.trueEquity);
  console.log(`  봇 추정 - 실제     평균 ${avg(bias)}  (흔들림·블러핑이 얹힌 정도)`);
  line('━');
}

// ─────────────────────────── 진입점 ───────────────────────────

async function main() {
  const { options, overrides } = parseArgs(process.argv.slice(2));

  // 헤즈업은 공격적 1 · 신중 1, 4인은 2 · 2
  const personas: BotPersona[] =
    options.players === 2
      ? ['aggressive', 'cautious']
      : ['aggressive', 'cautious', 'aggressive', 'cautious'];

  const players: SimPlayer[] = personas.map((persona, seat) => ({
    seat,
    persona,
    stack: STARTING_STACK,
    hole: [],
    folded: false,
    allIn: false,
    streetBet: 0,
    contributed: 0,
    hasActed: false,
  }));

  const records: DecisionRecord[] = [];
  const netByPersona = new Map<BotPersona, number>();
  const handsByPersona = new Map<BotPersona, number>();
  let showdowns = 0;

  const started = Date.now();
  for (let hand = 0; hand < options.hands; hand++) {
    if (RESET_STACKS_EACH_HAND) players.forEach((p) => (p.stack = STARTING_STACK));
    const before = players.map((p) => p.stack);

    const outcome = await playHand(players, hand % players.length, options, records);
    if (outcome.reachedShowdown) showdowns++;

    // 칩 보존 검사 — 베팅/배당 로직이 칩을 만들거나 없애면 수지 지표가 통째로 무의미해진다
    const totalBefore = before.reduce((a, b) => a + b, 0);
    const totalAfter = players.reduce((sum, p) => sum + p.stack, 0);
    if (totalBefore !== totalAfter) {
      throw new Error(`핸드 ${hand}에서 칩이 보존되지 않았습니다: ${totalBefore} → ${totalAfter}`);
    }

    players.forEach((p, i) => {
      netByPersona.set(p.persona, (netByPersona.get(p.persona) ?? 0) + (p.stack - before[i]));
      handsByPersona.set(p.persona, (handsByPersona.get(p.persona) ?? 0) + 1);
    });

    if (!options.quiet && (hand + 1) % 250 === 0) {
      const rate = (hand + 1) / ((Date.now() - started) / 1000);
      process.stderr.write(`  ...${hand + 1}/${options.hands}판 (${rate.toFixed(1)}판/초)\n`);
    }
  }

  report(records, netByPersona, handsByPersona, showdowns, options, overrides, Date.now() - started);
}

main().catch((err) => {
  console.error('self-play 실패:', err);
  process.exit(1);
});
