/**
 * 한게임식 정형 배팅 버튼(삥/따당/쿼터/하프) 전용 스모크 테스트 — 실제 Colyseus 룸을
 * in-process로 띄우고 클라이언트가 진짜 'bet_bb'/'bet_double'/'bet_quarter'/'bet_half'
 * 메시지를 보내, computeFixedBet()이 계산했을 값과 서버가 실제로 반영한 값이 일치하는지
 * (수학 자체는 betSizing.test.ts가 이미 커버하므로 여기서는 배선/실전 반영을 검증) 확인한다.
 *
 * 각 스트리트마다 딱 한 번만 레이즈성 액션(삥/따당/쿼터/하프 중 하나)을 보내고 그다음은
 * 콜/체크로 넘어간다 — 매 턴 재레이즈하면 첫 핸드가 프리플랍에서 바로 올인으로 끝나버려
 * 포스트플랍(삥이 실제로 열리는 상황)을 검증할 기회가 없어지기 때문.
 *
 * 검증 항목:
 *  1. currentBet === 0일 때 '삥' → 정확히 min(빅블라인드, 스택)만큼 반영
 *  2. currentBet > 0일 때 '따당' → 정확히 직전 베팅액의 2배로 반영
 *  3. 조건이 안 맞는 상태에서 보낸 삥/따당은 서버가 거부(상태 변화 없음)
 *  4. 쿼터/하프 — 그 순간의 실제 팟으로 재계산된 금액과 일치
 *  5. 위 전부를 "스택 감소분"으로 검증한다 — streetBet은 스트리트가 바뀌면 0으로
 *     리셋되지만 stack은 핸드 내내 단조 감소라 라운드 경계를 넘어가도 흔들리지 않는다.
 */

import { Client, Room } from 'colyseus.js';
import { bootstrap } from '../src/index';
import { computeFixedBet, type FixedBetType } from '../src/engine/betSizing';

const PORT = 2601;
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

let checksRun = 0;
let checksFailed = 0;
let bingSeen = false;
let ttadangSeen = false;
let quarterOrHalfSeen = false;
let rejectionSeen = false;

function assertEqual(label: string, actual: unknown, expected: unknown) {
  checksRun++;
  const ok = actual === expected;
  if (!ok) checksFailed++;
  log(`${ok ? '✅' : '❌'} ${label} (actual=${actual}, expected=${expected})`);
}

interface Pending {
  type: FixedBetType;
  beforeStack: number;
  expected: ReturnType<typeof computeFixedBet>;
}

function autoPlay(room: Room, label: string, opts: { firstChoice: FixedBetType; secondChoice: FixedBetType }) {
  const actedThisStreet = new Set<string>(); // `${round}-${phase}` — 이 스트리트에서 이미 레이즈성 액션을 보냈는지
  let streetIndex = 0;
  let pending: Pending | null = null;

  room.onMessage('error', (e: { message: string }) => {
    rejectionSeen = true;
    log(`[${label}] 서버 거부: "${e.message}"`);
  });
  room.onMessage(
    'augmentTargetRequest',
    (req: { effectType: string; opponents: { sessionId: string }[] }) => {
      const opponent = req.opponents[0];
      if (req.effectType === 'reveal_opponent_card' && opponent) {
        room.send('chooseAugmentTarget', { targetSessionId: opponent.sessionId, targetCardIndex: 0 });
      } else if (req.effectType === 'edit_own_card') {
        room.send('chooseAugmentTarget', { cardIndex: 0, rank: 14, suit: 'spades' });
      } else if (req.effectType === 'swap_with_opponent' && opponent) {
        room.send('chooseAugmentTarget', { targetSessionId: opponent.sessionId, targetCardIndex: 0, ownCardIndex: 0 });
      }
    },
  );

  const doneAugment = new Set<string>();
  const doneAction = new Set<string>();

  room.onStateChange(() => {
    const st = room.state.toJSON() as any;
    const me = st.players?.[room.sessionId];
    if (!me) return;

    // 직전에 보낸 레이즈성 액션의 결과 검증 — stack 변화가 관측되는 즉시 1회만 판정
    if (pending && me.stack !== pending.beforeStack) {
      const actualPay = pending.beforeStack - me.stack;
      const expected = pending.expected;
      if (typeof expected === 'string') {
        assertEqual(`[${label}] ${pending.type} 무효 상태에서는 반영되면 안 됨`, actualPay, 0);
      } else {
        assertEqual(`[${label}] ${pending.type} 실제 반영액`, actualPay, expected.pay);
      }
      pending = null;
    }

    if (st.phase === 'augment_select' && me.augmentChoices?.length > 0) {
      const key = `aug-${st.round}`;
      if (!doneAugment.has(key)) {
        doneAugment.add(key);
        room.send('chooseAugment', { id: me.augmentChoices[0] });
      }
    }

    const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);
    if (!BETTING_PHASES.has(st.phase) || st.activePlayerId !== room.sessionId || me.isFolded || me.allIn) return;

    const key = `act-${st.round}-${st.phase}-${st.currentBet}-${me.streetBet}-${me.hasActed}`;
    if (doneAction.has(key)) return;
    doneAction.add(key);

    const streetKey = `${st.round}-${st.phase}`;
    const potTotal = st.pot + Object.values(st.players as Record<string, any>).reduce((s, p: any) => s + p.streetBet, 0);
    const ctx = { currentBet: st.currentBet, potTotal, bigBlind: st.bigBlind, streetBet: me.streetBet, stack: me.stack };
    const toCall = Math.max(0, st.currentBet - me.streetBet);

    // 이 스트리트에서 이미 레이즈성 액션을 한 번 보냈으면 이후로는 콜/체크만 — 무한 레이즈 체이닝 방지
    if (actedThisStreet.has(streetKey)) {
      room.send('action', { type: toCall > 0 ? 'call' : 'check' });
      return;
    }
    actedThisStreet.add(streetKey);

    if (st.currentBet === 0) {
      bingSeen = true;
      // 대칭 검증: 조건 불충족인 따당을 먼저 시도 → 거부되어야 함(상태 변화 없이 무시됨)
      room.send('action', { type: 'bet_double' });
      const expected = computeFixedBet('bet_bb', ctx);
      log(`[${label}] 삥 시도 (round ${st.round}, ${st.phase}) — 기대 pay=${typeof expected === 'string' ? expected : expected.pay}`);
      room.send('action', { type: 'bet_bb' });
      pending = { type: 'bet_bb', beforeStack: me.stack, expected };
      return;
    }

    // 대칭 검증: 조건 불충족인 삥을 먼저 시도 → 거부되어야 함
    room.send('action', { type: 'bet_bb' });
    streetIndex++;
    const choice: FixedBetType = streetIndex % 2 === 0 ? opts.firstChoice : opts.secondChoice;
    if (choice === 'bet_double') ttadangSeen = true;
    else quarterOrHalfSeen = true;
    const expected = computeFixedBet(choice, ctx);
    log(
      `[${label}] ${choice} 시도 (round ${st.round}, ${st.phase}, currentBet=${st.currentBet}, pot=${potTotal}) — 기대 pay=${typeof expected === 'string' ? expected : expected.pay}`,
    );
    room.send('action', { type: choice });
    pending = { type: choice, beforeStack: me.stack, expected };
  });
}

async function main() {
  await bootstrap(PORT);
  log(`서버 기동 완료 (포트 ${PORT})`);

  const clientA = new Client(`ws://localhost:${PORT}`);
  const clientB = new Client(`ws://localhost:${PORT}`);

  const roomA = await clientA.joinOrCreate('poker_room', { name: '영희' });
  autoPlay(roomA, 'A:영희', { firstChoice: 'bet_double', secondChoice: 'bet_quarter' });
  const roomB = await clientB.joinOrCreate('poker_room', { name: '철수' });
  autoPlay(roomB, 'B:철수', { firstChoice: 'bet_half', secondChoice: 'bet_double' });
  log('클라이언트 2명 입장 완료');

  roomA.send('startGame');
  log('방장이 게임 시작 요청 전송');

  const deadline = Date.now() + 45_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      const st = roomA.state?.toJSON() as any;
      if (st?.round >= 2) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`타임아웃 — 현재 상태: round=${st?.round} phase=${st?.phase}`));
      }
    }, 300);
  });

  log('─'.repeat(50));
  const flowChecks: [string, boolean][] = [
    ['삥(currentBet=0 오픈) 최소 1회 실전 검증', bingSeen],
    ['따당(2배 레이즈) 최소 1회 실전 검증', ttadangSeen],
    ['쿼터/하프(팟 비율) 최소 1회 실전 검증', quarterOrHalfSeen],
    ['조건 불충족 삥/따당 서버 거부 확인', rejectionSeen],
  ];
  for (const [name, ok] of flowChecks) {
    log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) checksFailed++;
    checksRun++;
  }

  roomA.leave();
  roomB.leave();
  log(`총 ${checksRun}건 검증, 실패 ${checksFailed}건`);
  if (checksFailed > 0) {
    console.error('SMOKE FAILED');
    process.exit(1);
  }
  log('SMOKE OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
