/**
 * 스모크 테스트 — 서버를 in-process로 띄우고 클라이언트 2명이 실제로 접속해
 * [증강 선택 → 베팅 → 쇼다운 → 다음 라운드]를 자동 플레이하며 검증한다.
 *
 * 검증 항목:
 *  1. 입장 2명 → 게임 자동 시작, 증강 3개 제시
 *  2. 홀카드는 개별 메시지로만 수신 (동기화 상태에 비공개)
 *  3. 잘못된 레이즈 금액(-500) → 서버가 거부
 *  4. 베팅 진행 → 쇼다운 result 수신 → 라운드 2 진입
 */

import { Client, Room } from 'colyseus.js';
import { bootstrap } from '../src/index';

const PORT = 2599;
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

let holeCount = 0;
let resultReceived = false;
let rejectionReceived = false;
let invalidRaiseSent = false;

function autoPlay(room: Room, label: string) {
  const done = new Set<string>();

  room.onMessage('hole', (cards: { id: string }[]) => {
    holeCount++;
    log(`[${label}] 홀카드 수신:`, cards.map((c) => c.id).join(', '));
  });
  room.onMessage('result', (r: unknown) => {
    resultReceived = true;
    log(`[${label}] 결과:`, JSON.stringify(r));
  });
  room.onMessage('gameOver', (g: unknown) => log(`[${label}] 게임 종료:`, JSON.stringify(g)));
  room.onMessage('error', (e: { message: string }) => {
    rejectionReceived = true;
    log(`[${label}] 서버 거부: "${e.message}"`);
  });

  room.onStateChange(() => {
    const st = room.state.toJSON() as any;
    const me = st.players?.[room.sessionId];
    if (!me) return;

    // 증강 선택
    if (st.phase === 'augment' && me.augmentChoices?.length > 0) {
      const key = `aug-${st.round}`;
      if (!done.has(key)) {
        done.add(key);
        log(`[${label}] 증강 선택지:`, me.augmentChoices.join(', '), '→', me.augmentChoices[0]);
        room.send('chooseAugment', { id: me.augmentChoices[0] });
      }
    }

    // 내 차례면 자동 체크/콜
    if (st.phase === 'betting' && st.activePlayerId === room.sessionId && !me.folded && !me.allIn) {
      const toCall = st.currentBet - me.streetBet;
      const key = `act-${st.round}-${st.street}-${st.currentBet}-${me.streetBet}-${me.hasActed}`;
      if (!done.has(key)) {
        done.add(key);
        // 첫 차례에 한 번, 조작된 레이즈 값을 보내 서버 검증을 확인
        if (!invalidRaiseSent) {
          invalidRaiseSent = true;
          log(`[${label}] 조작된 레이즈 전송 (amount: -500) — 거부되어야 함`);
          room.send('action', { type: 'raise', amount: -500 });
        }
        room.send('action', toCall > 0 ? { type: 'call' } : { type: 'check' });
        log(`[${label}] 액션: ${toCall > 0 ? `콜 ${toCall}` : '체크'} (${st.street})`);
      }
    }
  });
}

async function main() {
  await bootstrap(PORT);
  log(`서버 기동 완료 (포트 ${PORT})`);

  const clientA = new Client(`ws://localhost:${PORT}`);
  const clientB = new Client(`ws://localhost:${PORT}`);

  const roomA = await clientA.joinOrCreate('poker', { name: '영희' });
  autoPlay(roomA, 'A:영희');
  const roomB = await clientB.joinOrCreate('poker', { name: '철수' });
  autoPlay(roomB, 'B:철수');
  log('클라이언트 2명 입장 완료');

  // 라운드 2 베팅 진입(= 1라운드 전체 루프 완주)까지 대기
  const deadline = Date.now() + 40_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      const st = roomA.state?.toJSON() as any;
      if (st?.round >= 2 && st?.phase === 'betting') {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`타임아웃 — 현재 상태: round=${st?.round} phase=${st?.phase}`));
      }
    }, 300);
  });

  // 홀카드 비공개 검증: 베팅 중 상태에 상대 revealedHole이 비어 있어야 함
  const st = roomA.state.toJSON() as any;
  const leaked = Object.values(st.players as Record<string, any>).some(
    (p) => p.revealedHole?.length > 0,
  );

  log('─'.repeat(50));
  const checks: [string, boolean][] = [
    ['홀카드 개별 전송 (4회 이상 수신)', holeCount >= 4],
    ['쇼다운/결과 브로드캐스트 수신', resultReceived],
    ['조작된 레이즈 값 서버 거부', rejectionReceived],
    ['베팅 중 홀카드 상태 비공개', !leaked],
    ['라운드 2 진입 (게임 루프 완주)', true],
  ];
  let allOk = true;
  for (const [name, ok] of checks) {
    log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) allOk = false;
  }

  roomA.leave();
  roomB.leave();
  if (!allOk) {
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
