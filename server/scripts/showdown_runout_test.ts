/**
 * 쇼다운 "SHOW DOWN" 연출 발동 조건 검증 — 서버를 in-process로 띄우고 4명의 실제 클라이언트로
 * 두 시나리오를 각각 재현해 result 브로드캐스트의 runout 플래그가 기대대로 오는지 확인한다.
 *
 * 1. 전원 올인(프리플랍) → 남은 스트리트를 전부 건너뛰고 쇼다운 → runout: true
 * 2. 매 스트리트 체크/콜로 정상 진행해 리버까지 도달한 쇼다운 → runout: false
 *
 * 봇이 섞이면 액션을 완전히 통제할 수 없으므로, maxClients(4)를 사람 4명으로 채워
 * fillWithBots()가 개입하지 않게 한다(PokerRoom.ts 참고).
 */

import { Client, Room } from 'colyseus.js';
import { bootstrap } from '../src/index';

const PORT = 2602;
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);

/** 증강 선택/대상 지정/밑장빼기 프롬프트를 즉시 처리해 흐름이 멈추지 않게 한다 (연출 검증과 무관한 잡음 제거) */
function attachAutoFlow(room: Room) {
  const done = new Set<string>();

  room.onMessage('augmentTargetRequest', () => room.send('skipAugmentTarget'));
  room.onMessage('bottomDealPrompt', () => room.send('bottomDealChoice', { use: false }));

  room.onStateChange(() => {
    const st = room.state.toJSON() as any;
    const me = st.players?.[room.sessionId];
    if (!me) return;
    if (st.phase === 'augment_select' && me.augmentChoices?.length > 0) {
      const key = `aug-${st.round}`;
      if (!done.has(key)) {
        done.add(key);
        room.send('chooseAugment', { id: me.augmentChoices[0] });
      }
    }
  });
}

/** 베팅 전략 — 'allin'은 자기 차례마다 무조건 올인, 'checkcall'은 체크 가능하면 체크, 아니면 콜(레이즈 없음) */
function attachBettingStrategy(room: Room, strategy: 'allin' | 'checkcall') {
  const done = new Set<string>();
  room.onStateChange(() => {
    const st = room.state.toJSON() as any;
    const me = st.players?.[room.sessionId];
    if (!me) return;
    if (!BETTING_PHASES.has(st.phase) || st.activePlayerId !== room.sessionId || me.isFolded || me.allIn) return;
    const key = `act-${st.round}-${st.phase}-${st.currentBet}-${me.streetBet}-${me.hasActed}`;
    if (done.has(key)) return;
    done.add(key);
    if (strategy === 'allin') {
      room.send('action', { type: 'allin' });
    } else {
      const toCall = st.currentBet - me.streetBet;
      room.send('action', toCall > 0 ? { type: 'call' } : { type: 'check' });
    }
  });
}

async function runScenario(label: string, strategy: 'allin' | 'checkcall'): Promise<any> {
  const clients = Array.from({ length: 4 }, () => new Client(`ws://localhost:${PORT}`));
  const first = await clients[0].create('poker_room', { name: `${label}1` });
  const rooms: Room[] = [first];
  for (let i = 1; i < 4; i++) {
    rooms.push(await clients[i].joinById(first.roomId, { name: `${label}${i + 1}` }));
  }
  log(`[${label}] 4명 입장 완료 (room ${first.roomId})`);

  let result: any = null;
  for (const room of rooms) {
    attachAutoFlow(room);
    attachBettingStrategy(room, strategy);
  }
  rooms[0].onMessage('result', (r: unknown) => {
    if (!result) result = r;
  });

  rooms[0].send('startGame');
  log(`[${label}] 게임 시작 요청 전송`);

  const deadline = Date.now() + 30_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (result) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`[${label}] 타임아웃 — result 미수신`));
      }
    }, 200);
  });

  for (const room of rooms) room.leave();
  return result;
}

async function main() {
  await bootstrap(PORT);
  log(`서버 기동 완료 (포트 ${PORT})`);

  const allInResult = await runScenario('allin', 'allin');
  log('[전원 올인] result:', JSON.stringify(allInResult));

  const normalResult = await runScenario('normal', 'checkcall');
  log('[정상 리버 쇼다운] result:', JSON.stringify(normalResult));

  log('─'.repeat(50));
  const checks: [string, boolean][] = [
    ['전원 올인 → runout:true (SHOW DOWN 연출 + 순차 공개 발동)', allInResult?.runout === true],
    ['정상 리버 쇼다운 → runout:false (연출 없이 일반 공개)', normalResult?.runout === false],
    ['두 시나리오 모두 폴드가 아닌 쇼다운으로 종료됨', allInResult?.byFold === false && normalResult?.byFold === false],
  ];

  let allOk = true;
  for (const [name, ok] of checks) {
    log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) allOk = false;
  }

  if (!allOk) {
    console.error('SHOWDOWN RUNOUT TEST FAILED');
    process.exit(1);
  }
  log('SHOWDOWN RUNOUT TEST OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('SHOWDOWN RUNOUT TEST FAILED:', err);
  process.exit(1);
});
