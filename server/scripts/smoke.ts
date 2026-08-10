/**
 * 스모크 테스트 — 서버를 in-process로 띄우고 클라이언트 2명이 실제로 접속해
 * [방장 게임 시작 → 증강 선택 → 베팅 → 쇼다운 → 다음 라운드]를 자동 플레이하며 검증한다.
 *
 * 검증 항목:
 *  1. 입장 2명 → 방장이 "게임 시작"을 눌러야 라운드가 시작됨, 증강 3개 제시
 *  2. 홀카드는 개별 메시지로만 수신 (동기화 상태에 비공개)
 *  3. 잘못된 레이즈 금액(-500) → 서버가 거부
 *  4. 베팅 진행 → 쇼다운 result 수신 → 라운드 2 진입
 *
 * 서버가 응답을 기다리는 프롬프트(augmentTargetRequest / bottomDealPrompt)는 전부
 * 즉시 답해줘야 한다 — 응답하지 않으면 서버의 자동 해소 타임아웃(45초)이
 * 이 스크립트의 데드라인(40초)보다 길어 그대로 타임아웃된다.
 */

import { Client, Room } from 'colyseus.js';
import { bootstrap } from '../src/index';

const PORT = 2599;
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

let holeCount = 0;
let resultReceived = false;
let rejectionReceived = false;
let invalidRaiseSent = false;
let instantAugmentFlowSeen = false;
let bottomDealPromptSeen = false;

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

  // 즉시형 증강(음침한 눈/카멜레온/당근이세요?)을 뽑았다면 augment_target 단계에서
  // 대상 지정 요청이 온다 — 즉시 유효한 값으로 응답해 흐름이 막히지 않게 한다.
  room.onMessage(
    'augmentTargetRequest',
    (req: { augmentId: string; effectType: string; opponents: { sessionId: string; name: string }[] }) => {
      instantAugmentFlowSeen = true;
      log(`[${label}] 즉시형 증강 대상 지정 요청: ${req.augmentId} (${req.effectType})`);
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
  room.onMessage('augmentReveal', (r: unknown) => log(`[${label}] 카드 공개 수신:`, JSON.stringify(r)));

  // 밑장빼기(street_reveal_choice)는 응답이 올 때까지 진행이 멈춘다. 서버가 45초 뒤
  // 자동으로 "사용 안 함" 처리하긴 하지만, 그 45초가 이 스크립트의 데드라인(40초)보다
  // 길어서 응답하지 않으면 스모크가 그대로 타임아웃된다 — 즉시 스킵으로 답한다.
  // (showdown_runout_test.ts의 attachAutoFlow와 같은 방식)
  room.onMessage('bottomDealPrompt', () => {
    bottomDealPromptSeen = true;
    log(`[${label}] 밑장빼기 프롬프트 수신 → 사용 안 함으로 응답`);
    room.send('bottomDealChoice', { use: false });
  });

  // 아래는 응답이 필요 없는 단방향 알림. 등록해두지 않으면 colyseus.js가
  // "onMessage() not registered for type ..." 경고를 뿌려 로그가 지저분해진다.
  room.onMessage('notice', (n: { text: string }) => log(`[${label}] 알림: ${n.text}`));
  room.onMessage('cardChange', () => {});
  room.onMessage('bigAnnouncement', (a: unknown) => log(`[${label}] 큰 알림:`, JSON.stringify(a)));
  room.onMessage('turnExtended', () => {});
  room.onMessage('chipsSettled', (c: unknown) => log(`[${label}] 칩 정산:`, JSON.stringify(c)));

  room.onStateChange(() => {
    const st = room.state.toJSON() as any;
    const me = st.players?.[room.sessionId];
    if (!me) return;

    // 증강 선택
    if (st.phase === 'augment_select' && me.augmentChoices?.length > 0) {
      const key = `aug-${st.round}`;
      if (!done.has(key)) {
        done.add(key);
        log(`[${label}] 증강 선택지:`, me.augmentChoices.join(', '), '→', me.augmentChoices[0]);
        room.send('chooseAugment', { id: me.augmentChoices[0] });
      }
    }

    // 내 차례면 자동 체크/콜 (preflop/flop/turn/river 각각이 곧 phase)
    const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);
    if (BETTING_PHASES.has(st.phase) && st.activePlayerId === room.sessionId && !me.isFolded && !me.allIn) {
      const toCall = st.currentBet - me.streetBet;
      const key = `act-${st.round}-${st.phase}-${st.currentBet}-${me.streetBet}-${me.hasActed}`;
      if (!done.has(key)) {
        done.add(key);
        // 첫 차례에 한 번, 조작된 레이즈 값을 보내 서버 검증을 확인
        if (!invalidRaiseSent) {
          invalidRaiseSent = true;
          log(`[${label}] 조작된 레이즈 전송 (amount: -500) — 거부되어야 함`);
          room.send('action', { type: 'raise', amount: -500 });
        }
        room.send('action', toCall > 0 ? { type: 'call' } : { type: 'check' });
        log(`[${label}] 액션: ${toCall > 0 ? `콜 ${toCall}` : '체크'} (${st.phase})`);
      }
    }
  });
}

async function main() {
  await bootstrap(PORT);
  log(`서버 기동 완료 (포트 ${PORT})`);

  const clientA = new Client(`ws://localhost:${PORT}`);
  const clientB = new Client(`ws://localhost:${PORT}`);

  const roomA = await clientA.joinOrCreate('poker_room', { name: '영희' });
  autoPlay(roomA, 'A:영희');
  const roomB = await clientB.joinOrCreate('poker_room', { name: '철수' });
  autoPlay(roomB, 'B:철수');
  log('클라이언트 2명 입장 완료');

  // 방장(첫 입장자)이 "게임 시작" — 사람이 4명 미만이므로 남은 좌석은 봇으로 채워진다
  roomA.send('startGame');
  log('방장이 게임 시작 요청 전송');

  // 라운드 2 베팅 진입(= 1라운드 전체 루프 완주)까지 대기
  const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);
  const deadline = Date.now() + 40_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      const st = roomA.state?.toJSON() as any;
      if (st?.round >= 2 && BETTING_PHASES.has(st?.phase)) {
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

  // 실패 시 원인을 바로 알 수 있도록 최종 상태를 남긴다 (판정에는 쓰지 않음)
  log(
    `최종 상태: round=${st.round} phase=${st.phase} | ` +
      Object.values(st.players as Record<string, any>)
        .map((p) => `${p.name} stack=${p.stack}${p.isFolded ? ' (folded)' : ''}`)
        .join(', '),
  );

  // 라운드 1에는 2명 모두 홀카드를 받는다. 라운드 2치까지 받으려면 둘 다 살아남아야 하는데,
  // 올인 런아웃으로 파산하면 stack 0 → 자동 관전이라 홀카드가 오지 않는 게 정상 동작이다.
  // 그래서 생존 인원에 맞춰 기대치를 잡는다 (예전엔 4회 고정이라 파산 시 오탐이 났다).
  const humanIds = [roomA.sessionId, roomB.sessionId];
  const survivors = humanIds.filter((id) => ((st.players as Record<string, any>)[id]?.stack ?? 0) > 0);
  const expectedHoles = survivors.length === 2 ? 4 : 2;

  log('─'.repeat(50));
  const checks: [string, boolean][] = [
    [`홀카드 개별 전송 (${expectedHoles}회 이상 수신, 생존 ${survivors.length}명 기준)`, holeCount >= expectedHoles],
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
  // 즉시형 증강은 8개 중 무작위 3개 제시라 매 실행마다 뽑힌다는 보장이 없다 — 참고용 로그만 남긴다
  log(`${instantAugmentFlowSeen ? 'ℹ️' : '·'} 즉시형 증강(음침한 눈/카멜레온/당근이세요?) 대상 지정 흐름 ${instantAugmentFlowSeen ? '실제로 검증됨' : '이번 실행에선 미등장'}`);
  log(`${bottomDealPromptSeen ? 'ℹ️' : '·'} 밑장빼기 프롬프트 응답 흐름 ${bottomDealPromptSeen ? '실제로 검증됨' : '이번 실행에선 미등장'}`);

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
