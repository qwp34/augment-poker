/**
 * 멀티플레이 룸 연결 훅.
 *
 * - create(): poker_room 생성 → 주소창을 /room/:roomId로 갱신해 공유 가능하게 함
 * - /room/:roomId 링크로 접속한 경우에도 자동으로 입장하지 않는다 — roomId는 URL에서
 *   미리 읽어 노출만 해두고, 실제 연결은 호출부(닉네임 입력 후)가 joinById(roomId)를
 *   명시적으로 호출할 때 이루어진다. 방 생성과 마찬가지로 "닉네임을 정하고 나서 입장"
 *   흐름을 강제하기 위함이며, 부수효과로 마운트 시 자동 발화하는 이펙트가 없어져
 *   StrictMode 이중 마운트로 인한 중복 접속 문제도 원천적으로 사라진다.
 * - 방이 꽉 찼거나 존재하지 않으면 status가 'error'로 전환되고 errorMessage에 안내 문구가 담김
 * - room.state(phase/community/currentBet/currentTurnSeat/players...)를 실시간 구독해
 *   gameState로 노출하고, 내 홀카드는 private 메시지('hole')로만 받아 myHole에 담는다.
 *   다른 플레이어의 실제 카드 값은 쇼다운 전까지 서버가 아예 보내지 않으므로(스키마 밖 비밀
 *   상태), 클라이언트는 애초에 그 값을 알 수 없다 — UI는 gameState.players[].revealedHole이
 *   빈 배열인 동안 뒷면 카드를 그리면 된다(쇼다운 시점에 서버가 채워서 브로드캐스트).
 * - 증강 선택: 후보 3개는 gameState.players[내 항목].augmentChoices로 이미 실시간 동기화되고,
 *   chooseAugment(id)로 서버에 선택을 전송한다.
 *
 * 유령 접속 방지 원칙:
 *  - room 상태가 바뀌거나(교체) 컴포넌트가 언마운트될 때 이전 room은 반드시 leave()한다.
 *    StrictMode 이중 마운트·Vite HMR 재마운트 시에도 이 정리 로직이 실행되어야
 *    서버에 소켓이 살아있는 채로 방치되지 않는다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MatchMakeError, type Room } from 'colyseus.js';
import { client, ROOM_NAME, buildRoomShareUrl, getRoomIdFromPath, pushRoomPath } from './colyseusClient';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface ClientCard {
  id: string;
  suit: string;
  rank: number;
  isJoker: boolean;
}

export interface ClientPlayer {
  sessionId: string;
  name: string;
  seatIndex: number;
  isBot: boolean;
  stack: number;
  streetBet: number;
  isFolded: boolean;
  allIn: boolean;
  hasActed: boolean;
  connected: boolean;
  swapUsed: boolean;
  /** 밑장빼기 사용 여부 (라운드당 1회) */
  bottomDealUsed: boolean;
  /** 리셋 버튼 사용 여부 (라운드당 1회) */
  resetBoardUsed: boolean;
  /** 이번 핸드 홀카드 매수 — 평소 2, 대풍년 보유자가 있으면 전원 3 */
  holeCount: number;
  lastAction: string;
  /** 쇼다운 전에는 항상 빈 배열 — 서버가 그 전까지는 아예 값을 보내지 않는다 */
  revealedHole: ClientCard[];
  augmentIds: string[];
  augmentChoices: string[];
}

export interface ClientGameState {
  phase: string;
  round: number;
  maxRounds: number;
  pot: number;
  currentBet: number;
  minRaise: number;
  smallBlind: number;
  bigBlind: number;
  activePlayerId: string;
  hostSessionId: string;
  dealerSeat: number;
  currentTurnSeat: number;
  community: ClientCard[];
  /** seatIndex 순으로 정렬된 플레이어 목록 */
  players: ClientPlayer[];
}

/**
 * 한게임 스타일 정형 배팅 액션 — 금액은 서버가 팟/베팅 상태로 직접 계산한다(자유 금액 입력 없음).
 * bet_bb(삥)/bet_double(따당)은 같은 버튼 자리에서 currentBet===0 여부로 양자택일 전송한다.
 */
export type BettingActionType =
  | 'fold'
  | 'check'
  | 'call'
  | 'bet_bb'
  | 'bet_double'
  | 'bet_quarter'
  | 'bet_half'
  | 'allin';

export interface ResultWinner {
  sessionId: string;
  name: string;
  payout: number;
  category?: string;
  basePayout?: number;
  multiplier?: number;
  augments?: string[];
}

/** 쇼다운(또는 폴드 승) 결과 브로드캐스트 — 지속 상태가 아니라 한 번 오는 메시지라 별도로 구독한다 */
export interface ShowdownResult {
  byFold: boolean;
  winners: ResultWinner[];
  hands?: { sessionId: string; name: string; category: string }[];
  /** 러시안 룰렛 발동 시 — 판정에서 제외된 커뮤니티 카드 id (연출용 X 표시) */
  removedCommunityCardId?: string;
}

/** 서버가 보내는 짧은 시스템 알림(밑장빼기/보드 리셋 등) — 매번 새 id라 같은 문구라도 토스트가 다시 뜬다 */
export interface NoticeEvent {
  text: string;
  id: number;
}

export interface GameOverInfo {
  reason: string;
  standings: { sessionId: string; name: string; stack: number; connected: boolean }[];
  winner: { sessionId: string; name: string; stack: number; connected: boolean } | null;
}

/**
 * 즉시형 증강(음침한 눈/카멜레온/당근이세요?)을 고르면 서버가 이 요청을 보낸다.
 * 대상 지정 UI가 없으면 augment_target phase에서 15초 타임아웃까지 아무 반응도
 * 못 하는 것처럼 보인다 — 이 요청을 받는 즉시 대상 지정 화면을 띄워야 한다.
 */
export interface AugmentTargetRequest {
  augmentId: string;
  effectType: 'reveal_opponent_card' | 'edit_own_card' | 'swap_with_opponent';
  opponents: { sessionId: string; name: string }[];
}

/** 음침한 눈으로 확인한 상대 카드 — 나에게만 온다 */
export interface AugmentRevealInfo {
  targetSessionId: string;
  targetName: string;
  cardIndex: number;
  card: ClientCard;
}

/**
 * 카드가 바뀌는 증강(카드 재구성/카멜레온/당근이세요?)이 발동한 순간 전원에게 오는 공개
 * 브로드캐스트 — 실제 카드 값은 담기지 않는다("어느 자리의 몇 번째 카드가 바뀌었는지"만).
 * 뒷면 카드라도 글로우 연출과 짧은 텍스트 알림을 띄우는 데 쓰인다.
 */
export interface CardChangeEvent {
  augmentId: string;
  augmentName: string;
  changes: { sessionId: string; playerName: string; cardIndex: 0 | 1 }[];
}

const ENTRY_NOT_FOUND_MESSAGE = '입장할 수 없습니다 — 방이 존재하지 않거나 이미 종료되었습니다';
const ENTRY_FULL_MESSAGE = '입장할 수 없습니다 — 방 인원이 가득 찼습니다 (최대 4명)';
const ENTRY_GENERIC_MESSAGE = '입장할 수 없습니다';

function describeJoinError(err: unknown): string {
  if (err instanceof MatchMakeError) {
    // Colyseus 매치메이킹 실패 사유: 방 없음/잠김(꽉 참) 등
    if (/not found|invalid room/i.test(err.message)) return ENTRY_NOT_FOUND_MESSAGE;
    if (/locked|full/i.test(err.message)) return ENTRY_FULL_MESSAGE;
    return `${ENTRY_GENERIC_MESSAGE} (${err.message})`;
  }
  return ENTRY_GENERIC_MESSAGE;
}

function toClientCard(card: { id: string; suit: string; rank: number; isJoker?: boolean }): ClientCard {
  return { id: card.id, suit: card.suit, rank: card.rank, isJoker: !!card.isJoker };
}

/**
 * ArraySchema(또는 다른 iterable)를 순수 배열로 안전하게 변환한다. 방 입장 직후(JOIN_ROOM
 * 핸드셰이크 시점)엔 room.state가 스키마 "구조"만 알고 있을 뿐 실제 데이터(ROOM_STATE)는
 * 아직 도착 전이라 community 같은 컬렉션 필드가 일시적으로 undefined일 수 있다 — 이때
 * `[...undefined]`는 그대로 던진다. `Array.isArray`로 걸러내지 않는 이유는 @colyseus/schema의
 * ArraySchema가 네이티브 Array를 상속하지 않아(Symbol.iterator만 구현) 정상적으로 채워진
 * 인스턴스마저 false로 판정돼 데이터가 항상 비어버리기 때문 — 대신 null/undefined 여부만 본다.
 */
function toArray<T>(value: Iterable<T> | null | undefined): T[] {
  return value ? [...value] : [];
}

function toClientPlayer(p: {
  sessionId: string;
  name: string;
  seatIndex: number;
  isBot: boolean;
  stack: number;
  streetBet: number;
  isFolded: boolean;
  allIn: boolean;
  hasActed: boolean;
  connected: boolean;
  swapUsed: boolean;
  bottomDealUsed: boolean;
  resetBoardUsed: boolean;
  holeCount: number;
  lastAction: string;
  revealedHole: Iterable<{ id: string; suit: string; rank: number; isJoker?: boolean }> | null | undefined;
  augmentIds: Iterable<string> | null | undefined;
  augmentChoices: Iterable<string> | null | undefined;
}): ClientPlayer {
  return {
    sessionId: p.sessionId,
    name: p.name,
    seatIndex: p.seatIndex,
    isBot: p.isBot,
    stack: p.stack,
    streetBet: p.streetBet,
    isFolded: p.isFolded,
    allIn: p.allIn,
    hasActed: p.hasActed,
    connected: p.connected,
    swapUsed: p.swapUsed,
    bottomDealUsed: p.bottomDealUsed,
    resetBoardUsed: p.resetBoardUsed,
    holeCount: p.holeCount,
    lastAction: p.lastAction,
    revealedHole: toArray(p.revealedHole).map(toClientCard),
    augmentIds: toArray(p.augmentIds),
    augmentChoices: toArray(p.augmentChoices),
  };
}

/** Colyseus 스키마 인스턴스(room.state)를 화면에서 쓰기 편한 순수 객체로 스냅샷한다 */
function toClientGameState(state: {
  phase: string;
  round: number;
  maxRounds: number;
  pot: number;
  currentBet: number;
  minRaise: number;
  smallBlind: number;
  bigBlind: number;
  activePlayerId: string;
  hostSessionId: string;
  dealerSeat: number;
  currentTurnSeat: number;
  community: Iterable<{ id: string; suit: string; rank: number; isJoker?: boolean }> | null | undefined;
  players: { values(): Iterable<Parameters<typeof toClientPlayer>[0]> } | null | undefined;
}): ClientGameState {
  return {
    phase: state.phase,
    round: state.round,
    maxRounds: state.maxRounds,
    pot: state.pot,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    activePlayerId: state.activePlayerId,
    hostSessionId: state.hostSessionId,
    dealerSeat: state.dealerSeat,
    currentTurnSeat: state.currentTurnSeat,
    community: toArray(state.community).map(toClientCard),
    players: toArray(state.players?.values()).map(toClientPlayer).sort((a, b) => a.seatIndex - b.seatIndex),
  };
}

export function useMultiplayerRoom(playerName: string) {
  const [roomId, setRoomId] = useState<string | null>(() => getRoomIdFromPath());
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [room, setRoom] = useState<Room | null>(null);
  const [gameState, setGameState] = useState<ClientGameState | null>(null);
  /** 내 홀카드 — private 메시지('hole')로만 전달되며 다른 플레이어에게는 절대 동기화되지 않는다 */
  const [myHole, setMyHole] = useState<ClientCard[]>([]);
  /** 가장 최근 쇼다운/폴드 결과 — 지속 상태가 아닌 1회성 브로드캐스트라 별도 보관 */
  const [lastResult, setLastResult] = useState<ShowdownResult | null>(null);
  const [gameOver, setGameOver] = useState<GameOverInfo | null>(null);
  /** 내가 즉시형 증강을 골라 대상 지정이 필요한 상태 — null이면 지정할 게 없음 */
  const [pendingAugmentTarget, setPendingAugmentTarget] = useState<AugmentTargetRequest | null>(null);
  /** 음침한 눈으로 확인한 상대 카드 (나에게만 표시) */
  const [lastAugmentReveal, setLastAugmentReveal] = useState<AugmentRevealInfo | null>(null);
  /** 카드가 바뀐 순간의 공개 브로드캐스트 — 매번 새 객체라 참조 변화만으로 연출 트리거에 충분하다 */
  const [cardChangeEvent, setCardChangeEvent] = useState<CardChangeEvent | null>(null);
  /** 밑장빼기 — 내가 지금 "사용하시겠습니까?" 프롬프트에 응답해야 하는 상태인지 */
  const [pendingBottomDealChoice, setPendingBottomDealChoice] = useState(false);
  /** 서버의 짧은 시스템 알림(밑장빼기 사용/보드 리셋 등) — 토스트로 표시 */
  const [noticeEvent, setNoticeEvent] = useState<NoticeEvent | null>(null);
  const noticeIdRef = useRef(0);

  // 최신 닉네임을 콜백 의존성 없이 읽기 위한 ref (닉네임 입력 중 재렌더링돼도 콜백 identity가 안정적으로 유지되도록)
  const playerNameRef = useRef(playerName);
  playerNameRef.current = playerName;

  const attachLeaveHandler = (r: Room) => {
    r.onLeave(() => setRoom((prev) => (prev === r ? null : prev)));
  };

  const joinById = useCallback(async (id: string) => {
    setStatus('connecting');
    setErrorMessage('');
    try {
      const joined = await client.joinById(id, { name: playerNameRef.current });
      setRoom(joined);
      setRoomId(id);
      setStatus('connected');
      attachLeaveHandler(joined);
    } catch (err) {
      setStatus('error');
      setErrorMessage(describeJoinError(err));
      console.error('룸 입장 실패:', err);
    }
  }, []);

  const create = useCallback(async () => {
    setStatus('connecting');
    setErrorMessage('');
    try {
      const created = await client.create(ROOM_NAME, { name: playerNameRef.current });
      pushRoomPath(created.roomId);
      setRoom(created);
      setRoomId(created.roomId);
      setStatus('connected');
      attachLeaveHandler(created);
    } catch (err) {
      setStatus('error');
      setErrorMessage('방을 생성할 수 없습니다');
      console.error('룸 생성 실패:', err);
    }
  }, []);

  // room이 교체되거나 컴포넌트가 언마운트될 때 이전 연결을 명확히 종료.
  // 이 정리가 없으면 서버는 소켓이 살아있는 한 플레이어를 계속 붙어있는 것으로 간주해
  // 재마운트(StrictMode 이중 마운트, Vite HMR) 때마다 유령 접속이 쌓인다.
  useEffect(() => {
    if (!room) return;
    return () => {
      room.leave();
    };
  }, [room]);

  // 게임 상태 실시간 구독 — phase/community/currentBet/currentTurnSeat/players 등
  // room.state가 바뀔 때마다(서버 브로드캐스트) 화면용 스냅샷으로 변환해 반영한다.
  //
  // client.create()/joinById()는 JOIN_ROOM 핸드셰이크(스키마 "구조"만 앎)가 끝나는 즉시
  // resolve되고, 실제 상태 데이터(ROOM_STATE)는 그 뒤에 별도 웹소켓 메시지로 도착한다.
  // room이 세팅된 시점에 room.state를 곧바로 변환하면 community 등 컬렉션 필드가 아직
  // 채워지기 전이라 깨질 수 있다(로컬은 지연이 거의 없어 잘 안 보이지만, 실제 네트워크를
  // 거쳐 접속하는 다른 기기에서는 이 창이 넓어져 재현된다). 그래서 이미 데이터가 와
  // 있는 게 확인될 때만 즉시 반영하고, 아직이면 건너뛰어 최초 onStateChange(ROOM_STATE
  // 처리 후 반드시 호출됨)가 실제 데이터를 들고 올 때까지 기다린다 — onStateChange는
  // 재생(replay) 없는 단순 이벤트라, 여기서 무작정 매번 호출하면 이미 지나간 첫 갱신을
  // 영영 놓쳐 로딩 화면에 멈출 수 있어서 그렇게 하지 않는다.
  useEffect(() => {
    if (!room) {
      setGameState(null);
      return;
    }
    const update = (state: unknown) => setGameState(toClientGameState(state as Parameters<typeof toClientGameState>[0]));
    const initialState = room.state as { community?: unknown } | undefined;
    if (initialState?.community) update(initialState);
    room.onStateChange(update);
    return () => {
      room.onStateChange.remove(update);
    };
  }, [room]);

  // 내 홀카드 수신 — 서버가 client.send('hole', ...)로 나에게만 개별 전송한다
  useEffect(() => {
    if (!room) {
      setMyHole([]);
      return;
    }
    const offHole = room.onMessage('hole', (cards: { id: string; suit: string; rank: number; isJoker?: boolean }[]) => {
      setMyHole(cards.map(toClientCard));
    });
    return () => {
      offHole?.();
    };
  }, [room]);

  // 새 라운드의 증강 선택 단계로 들어가면 지난 핸드의 홀카드는 화면에서 지운다
  // (새 홀카드는 베팅이 시작되기 직전 'hole' 메시지로 다시 도착한다)
  useEffect(() => {
    if (gameState?.phase === 'augment_select') setMyHole([]);
  }, [gameState?.phase]);

  // 쇼다운/폴드 결과, 게임 종료 브로드캐스트 수신
  useEffect(() => {
    if (!room) {
      setLastResult(null);
      setGameOver(null);
      return;
    }
    const offResult = room.onMessage('result', (r: ShowdownResult) => setLastResult(r));
    const offGameOver = room.onMessage('gameOver', (g: GameOverInfo) => setGameOver(g));
    return () => {
      offResult?.();
      offGameOver?.();
    };
  }, [room]);

  // 라운드 결과 화면(round_end)이 끝나고 다음 라운드로 넘어가면(증강 선택 단계부터) 지난
  // 라운드의 결과 배너/러시안 룰렛 X 표시는 더 이상 유효하지 않다 — augment_select에서
  // 클리어하지 않으면, community가 아직 startHand()로 비워지기 전이라(다음 라운드 증강
  // 선택 중에도 서버 상태엔 직전 핸드의 보드가 그대로 남아있다) 쇼다운이 아닌 증강 선택
  // 화면에서까지 이전 핸드의 X 표시가 계속 보이는 문제가 있었다.
  useEffect(() => {
    if (
      gameState?.phase === 'augment_select' ||
      gameState?.phase === 'augment_target' ||
      gameState?.phase === 'preflop'
    )
      setLastResult(null);
  }, [gameState?.phase]);

  // 안전장치 — 어떤 사유로든 위 조건에서 못 지워지더라도, 결과 배너는 일정 시간 뒤 무조건 사라진다
  useEffect(() => {
    if (!lastResult) return;
    const t = setTimeout(() => setLastResult(null), 6000);
    return () => clearTimeout(t);
  }, [lastResult]);

  // 즉시형 증강(음침한 눈/카멜레온/당근이세요?) 대상 지정 요청 — 나에게만 온다.
  // 서버는 대상이 필요 없어질 때(해소·타임아웃)까지 phase를 'augment_target'에 둔다.
  useEffect(() => {
    if (!room) {
      setPendingAugmentTarget(null);
      return;
    }
    const offRequest = room.onMessage('augmentTargetRequest', (req: AugmentTargetRequest) =>
      setPendingAugmentTarget(req),
    );
    const offReveal = room.onMessage('augmentReveal', (info: AugmentRevealInfo) => {
      setLastAugmentReveal(info);
    });
    return () => {
      offRequest?.();
      offReveal?.();
    };
  }, [room]);

  // augment_target을 벗어나면(해소 완료·타임아웃 자동 처리) 더 지정할 게 없다
  useEffect(() => {
    if (gameState?.phase !== 'augment_target') setPendingAugmentTarget(null);
  }, [gameState?.phase]);

  // 음침한 눈으로 본 카드는 그 핸드 동안만 유효 — 다음 라운드 증강 선택에 들어가면 지운다
  useEffect(() => {
    if (gameState?.phase === 'augment_select') setLastAugmentReveal(null);
  }, [gameState?.phase]);

  // 카드가 바뀌는 증강(카드 재구성/카멜레온/당근이세요?/흔들리는 테이블) 발동 — 전원에게
  // 오는 공개 브로드캐스트. 소비 측(PokerTable)이 이 값이 바뀔 때마다 글로우 연출 + 토스트를 새로 재생한다.
  useEffect(() => {
    if (!room) {
      setCardChangeEvent(null);
      return;
    }
    const offCardChange = room.onMessage('cardChange', (payload: CardChangeEvent) => setCardChangeEvent(payload));
    return () => {
      offCardChange?.();
    };
  }, [room]);

  // 밑장빼기 — 스트리트 공개 직전, 서버가 나에게만 "사용하시겠습니까?" 프롬프트를 보낸다
  useEffect(() => {
    if (!room) {
      setPendingBottomDealChoice(false);
      return;
    }
    const off = room.onMessage('bottomDealPrompt', () => setPendingBottomDealChoice(true));
    return () => {
      off?.();
    };
  }, [room]);

  // street_reveal_choice를 벗어나면(응답 완료·타임아웃 자동 처리) 더 이상 물어볼 게 없다
  useEffect(() => {
    if (gameState?.phase !== 'street_reveal_choice') setPendingBottomDealChoice(false);
  }, [gameState?.phase]);

  // 서버의 짧은 시스템 알림(밑장빼기 사용/보드 리셋 등) — 전원에게 오는 토스트용 브로드캐스트
  useEffect(() => {
    if (!room) {
      setNoticeEvent(null);
      return;
    }
    const off = room.onMessage('notice', (payload: { text: string }) =>
      setNoticeEvent({ text: payload.text, id: ++noticeIdRef.current }),
    );
    return () => {
      off?.();
    };
  }, [room]);

  /** 서버가 뽑아 보낸 증강 후보 3개 중 하나를 선택해 전송 */
  const chooseAugment = useCallback(
    (augmentId: string) => {
      room?.send('chooseAugment', { id: augmentId });
    },
    [room],
  );

  /** 즉시형 증강의 대상(상대/카드/새 숫자·무늬)을 지정해 전송 — 응답 즉시 대기 화면을 닫는다 */
  const chooseAugmentTarget = useCallback(
    (payload: {
      targetSessionId?: string;
      targetCardIndex?: 0 | 1;
      ownCardIndex?: 0 | 1;
      cardIndex?: 0 | 1;
      rank?: number;
      suit?: string;
    }) => {
      room?.send('chooseAugmentTarget', payload);
      setPendingAugmentTarget(null);
    },
    [room],
  );

  /** 이미 보유한 즉시형 증강(음침한 눈/카멜레온/당근이세요?)이 이번 핸드 재발동될 때, 이번엔
   * 사용하지 않고 넘어간다 — 일회성 증강이어도 "사용한 것"으로 처리되지 않아 다음 핸드에
   * 다시 재발동될 수 있다. */
  const skipAugmentTarget = useCallback(() => {
    room?.send('skipAugmentTarget');
    setPendingAugmentTarget(null);
  }, [room]);

  /** 베팅 액션(폴드/체크/콜/레이즈/올인) 전송 — 금액 검증은 서버가 최종 수행한다 */
  const sendAction = useCallback(
    (type: BettingActionType, amount?: number) => {
      room?.send('action', { type, amount });
    },
    [room],
  );

  /** 카드 재구성 증강 — 내 홀카드 index(0|1)를 새 카드로 교체 요청 (핸드당 1회, 서버가 검증) */
  const swapHoleCard = useCallback(
    (index: 0 | 1) => {
      room?.send('swapCard', { index });
    },
    [room],
  );

  /** 밑장빼기 — "사용하시겠습니까?" 프롬프트에 응답 (사용/사용 안 함) */
  const chooseBottomDeal = useCallback(
    (use: boolean) => {
      room?.send('bottomDealChoice', { use });
      setPendingBottomDealChoice(false);
    },
    [room],
  );

  /** 리셋 버튼 — 본인 차례에 현재 커뮤니티 카드를 전부 회수하고 다시 딜링 요청 (라운드당 1회, 서버가 검증) */
  const resetBoard = useCallback(() => {
    room?.send('resetBoard');
  }, [room]);

  const myPlayer = useMemo(
    () => gameState?.players.find((p) => p.sessionId === room?.sessionId) ?? null,
    [gameState, room],
  );

  const shareUrl = roomId ? buildRoomShareUrl(roomId) : '';

  return {
    roomId,
    status,
    errorMessage,
    room,
    shareUrl,
    create,
    joinById,
    gameState,
    myHole,
    myPlayer,
    myAugmentChoices: myPlayer?.augmentChoices ?? [],
    chooseAugment,
    sendAction,
    swapHoleCard,
    lastResult,
    gameOver,
    pendingAugmentTarget,
    chooseAugmentTarget,
    skipAugmentTarget,
    lastAugmentReveal,
    cardChangeEvent,
    pendingBottomDealChoice,
    chooseBottomDeal,
    resetBoard,
    noticeEvent,
  };
}
