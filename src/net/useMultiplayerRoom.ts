/**
 * 멀티플레이 룸 연결 훅.
 *
 * - create(): poker_room 생성 → 주소창을 /room/:roomId로 갱신해 공유 가능하게 함
 * - /room/:roomId로 접속한 경우 마운트 시 자동으로 joinById 호출
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
 *  - 주소창 기반 자동 입장은 마운트 시점의 URL 값 하나에만 반응한다(별도 ref).
 *    create()/joinById()가 갱신하는 `roomId` 상태를 의존성으로 두면, 방을 막 만든
 *    호스트 본인에게도 자동 입장 이펙트가 다시 발동해 같은 방에 중복 접속하게 된다.
 *  - room 상태가 바뀌거나(교체) 컴포넌트가 언마운트될 때 이전 room은 반드시 leave()한다.
 *    StrictMode 이중 마운트·Vite HMR 재마운트 시에도 이 정리 로직이 실행되어야
 *    서버에 소켓이 살아있는 채로 방치되지 않는다.
 *  - 자동 입장 도중 언마운트(취소)되면, 이미 완료된 join도 즉시 leave() 처리한다.
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

export type BettingActionType = 'fold' | 'check' | 'call' | 'raise' | 'allin';

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
}

export interface GameOverInfo {
  reason: string;
  standings: { sessionId: string; name: string; stack: number; connected: boolean }[];
  winner: { sessionId: string; name: string; stack: number; connected: boolean } | null;
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
  lastAction: string;
  revealedHole: Iterable<{ id: string; suit: string; rank: number; isJoker?: boolean }>;
  augmentIds: Iterable<string>;
  augmentChoices: Iterable<string>;
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
    lastAction: p.lastAction,
    revealedHole: [...p.revealedHole].map(toClientCard),
    augmentIds: [...p.augmentIds],
    augmentChoices: [...p.augmentChoices],
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
  community: Iterable<{ id: string; suit: string; rank: number; isJoker?: boolean }>;
  players: { values(): Iterable<Parameters<typeof toClientPlayer>[0]> };
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
    community: [...state.community].map(toClientCard),
    players: [...state.players.values()].map(toClientPlayer).sort((a, b) => a.seatIndex - b.seatIndex),
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

  // 최신 닉네임을 이펙트 의존성 없이 읽기 위한 ref (자동 입장 이펙트가 닉네임 변경으로 재실행되지 않도록)
  const playerNameRef = useRef(playerName);
  playerNameRef.current = playerName;

  // 주소창에서 읽은 초기 roomId — create()/joinById()가 이후 roomId 상태를 바꿔도 이 값은 고정
  const initialLinkRoomId = useRef(roomId).current;

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

  // 공유 링크(/room/:roomId)로 접속한 경우 마운트 시 1회 자동 입장.
  // StrictMode/HMR로 이펙트가 두 번 실행돼도, 취소된 쪽은 join이 끝나는 즉시 leave()하여
  // 유령 세션이 남지 않도록 한다.
  useEffect(() => {
    if (!initialLinkRoomId) return;
    let cancelled = false;
    setStatus('connecting');
    setErrorMessage('');

    client.joinById(initialLinkRoomId, { name: playerNameRef.current }).then(
      (joined) => {
        if (cancelled) {
          joined.leave();
          return;
        }
        setRoom(joined);
        setStatus('connected');
        attachLeaveHandler(joined);
      },
      (err) => {
        if (cancelled) return;
        setStatus('error');
        setErrorMessage(describeJoinError(err));
        console.error('룸 입장 실패:', err);
      },
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLinkRoomId]);

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
  useEffect(() => {
    if (!room) {
      setGameState(null);
      return;
    }
    const update = (state: unknown) => setGameState(toClientGameState(state as Parameters<typeof toClientGameState>[0]));
    update(room.state);
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

  // 다음 핸드의 프리플랍이 시작되면 지난 핸드의 결과 배너는 더 이상 유효하지 않다
  useEffect(() => {
    if (gameState?.phase === 'preflop') setLastResult(null);
  }, [gameState?.phase]);

  /** 서버가 뽑아 보낸 증강 후보 3개 중 하나를 선택해 전송 */
  const chooseAugment = useCallback(
    (augmentId: string) => {
      room?.send('chooseAugment', { id: augmentId });
    },
    [room],
  );

  /** 베팅 액션(폴드/체크/콜/레이즈/올인) 전송 — 금액 검증은 서버가 최종 수행한다 */
  const sendAction = useCallback(
    (type: BettingActionType, amount?: number) => {
      room?.send('action', { type, amount });
    },
    [room],
  );

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
    lastResult,
    gameOver,
  };
}
