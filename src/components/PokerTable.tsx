import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from './Card';
import { AugmentCard } from './AugmentCard';
import augmentsData from '../data/augments.json';
import { RARITY_NAMES_KO, type Augment } from '../engine/augmentEngine';
import { evaluateBest, CATEGORY_NAMES_KO, type HandCategory } from '../engine/handEvaluator';
import type { Card as EngineCard } from '../engine/types';
import { CATEGORY_SHORT_KO } from '../ui/format';
import { useFitScale } from '../ui/useFitScale';
import type {
  AugmentRevealInfo,
  BettingActionType,
  CardChangeEvent,
  ClientCard,
  ClientGameState,
  ClientPlayer,
  ShowdownResult,
} from '../net/useMultiplayerRoom';

const AUGMENT_POOL = augmentsData as Augment[];
const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);
/** 하이카드 ~ 로열스트레이트플러시, 오름차순(handEvaluator의 내부 랭킹과 동일한 순서) */
const HAND_CATEGORY_ORDER: HandCategory[] = [
  'high_card',
  'pair',
  'two_pair',
  'three_of_a_kind',
  'straight',
  'flush',
  'full_house',
  'four_of_a_kind',
  'straight_flush',
  'royal_flush',
];

function findAugment(id: string): Augment | undefined {
  return AUGMENT_POOL.find((a) => a.id === id);
}

/** 네트워크로 전달된 느슨한 카드 타입 → 로컬 엔진의 리터럴 타입으로 캐스팅 (값은 서버가 보장) */
function asEngineCard(c: ClientCard): EngineCard {
  return c as unknown as EngineCard;
}

/**
 * 홀카드 + 커뮤니티 카드로 현재(또는 쇼다운) 최고 족보를 구성하는 5장의 카드 id를 계산한다.
 * handEvaluator.evaluateBest()의 bestFive를 그대로 활용 — 최소 5장이 안 모이면(프리플랍 등)
 * null을 반환해 하이라이트를 표시하지 않는다.
 */
function computeBestFiveIds(hole: ClientCard[], community: ClientCard[]): Set<string> | null {
  if (hole.length + community.length < 5) return null;
  const best = evaluateBest([...hole, ...community].map(asEngineCard));
  return new Set(best.bestFive.map((c) => c.id));
}

/** 카드 재구성 증강(card_swap 효과)을 보유했는지 */
function hasCardSwapAugment(player: ClientPlayer | null): boolean {
  if (!player) return false;
  return player.augmentIds.some((id) => findAugment(id)?.effect.type === 'card_swap');
}

/** 카드 변경 브로드캐스트를 짧은 한글 알림 문구로 변환 */
function describeCardChange(event: CardChangeEvent): string {
  if (event.augmentId === 'aug_carrot' && event.changes.length >= 2) {
    const [a, b] = event.changes;
    return `🔄 ${a.playerName}님과 ${b.playerName}님의 카드가 맞바뀌었습니다`;
  }
  const name = event.changes[0]?.playerName ?? '';
  return `✨ ${name}님의 카드가 '${event.augmentName}' 효과로 바뀌었습니다`;
}

/**
 * 서버의 seatIndex(턴 순서 등 게임 로직)는 그대로 두고, 화면에 어디(상/좌/우/하)에 그릴지만
 * "내 seatIndex가 항상 하단 중앙"이 되도록 상대적으로 재계산한다 — 마름모(다이아몬드) 배치.
 * 슬롯 순서 0→하단(나), 1→우측, 2→상단, 3→좌측 — 시계 방향 순서는 그대로 유지된다.
 * 예: 내가 seat 2면 2→하단, 3→우측, 0→상단, 1→좌측.
 */
function toDisplaySlot(seatIndex: number, mySeatIndex: number): number {
  return (seatIndex - mySeatIndex + 4) % 4;
}

const DIAMOND_CLASS = ['mp-diamond-bottom', 'mp-diamond-right', 'mp-diamond-top', 'mp-diamond-left'];
/** 안 보이는 홀카드 자리를 위한 고정 참조 — 매 렌더 새 배열 리터럴을 만들면 아래 useMemo가 매번 무효화된다 */
const EMPTY_HOLE: ClientCard[] = [];

interface DiamondSeatProps {
  player: ClientPlayer;
  isMe: boolean;
  myHole: ClientCard[];
  isDealer: boolean;
  isActive: boolean;
  diamondSlot: number;
  /** 음침한 눈으로 확인한 이 좌석의 카드 (나에게만 보임) — 없으면 null */
  reveal: AugmentRevealInfo | null;
  /** 이 좌석의 어느 홀카드가 방금 바뀌었는지 — "sessionId:0"/"sessionId:1" 키, 잠깐만 유지된다 */
  glowKeys: Set<string>;
  /** 족보 판정용 커뮤니티 카드 (쇼다운 후 공개된 홀카드와 조합해 하이라이트할 5장을 계산) */
  community: ClientCard[];
  /** 카드 재구성 증강으로 지금 내 홀카드를 클릭해 교체할 수 있는 상태인지 (isMe 좌석에서만 의미 있음) */
  canSwap: boolean;
  /** 카드 재구성 — 내 홀카드 index(0|1)를 새 카드로 교체 요청 (isMe 좌석에서만 의미 있음) */
  onSwapCard: (index: 0 | 1) => void;
  /** 증강 뱃지를 클릭했을 때 — 이름/효과 설명 팝업을 띄우기 위해 상위(PokerTable)로 알린다 */
  onAugmentClick: (augmentId: string) => void;
}

/** 상/좌/우/하 마름모 형태로 배치되는 좌석 카드 — 이름/칩/미니 홀카드/보유 증강(항상 공개) */
function DiamondSeat({
  player,
  isMe,
  myHole,
  isDealer,
  isActive,
  diamondSlot,
  reveal,
  glowKeys,
  community,
  canSwap,
  onSwapCard,
  onAugmentClick,
}: DiamondSeatProps) {
  const holeCards: ClientCard[] = isMe ? myHole : player.revealedHole.length > 0 ? player.revealedHole : EMPTY_HOLE;
  // 폴드한 플레이어도 카드 자리는 그대로 유지(뒷면을 흐리게 표시)한다 — 그래야 자리마다 높이가
  // 들쭉날쭉해지지 않고, 그 아래/옆의 증강 뱃지가 폴드 여부에 따라 위치를 옮기지 않는다.
  const showBacks = holeCards.length === 0;
  const bestFiveIds = useMemo(() => computeBestFiveIds(holeCards, community), [holeCards, community]);

  return (
    <div
      className={[
        'mp-diamond-seat',
        DIAMOND_CLASS[diamondSlot],
        player.isFolded ? 'mp-seat-folded' : '',
        isActive ? 'mp-seat-active' : '',
        isActive && isMe ? 'mp-seat-my-turn' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* 홀카드 오른쪽에 보유 증강을 나란히 배치 — 개수가 늘어나면 이 열만 세로 스크롤된다.
          닉네임 박스는 이 열이 아니라 카드 2장하고만 짝지어 쌓아서, 항상 카드 2장의 정중앙
          위쪽에 오도록 한다(증강 칩 열의 폭에 영향받지 않음). */}
      <div className="mp-seat-body">
        <div className="mp-seat-cards-col">
          <div className="mp-seat-info">
            {isDealer && <span className="mp-dealer-chip">D</span>}
            <span className="seat-name">
              {player.name}
              {isMe ? ' (나)' : ''}
              {player.isBot ? ' 🤖' : ''}
            </span>
            <span className="seat-gold">{player.stack.toLocaleString()}</span>
            {player.streetBet > 0 && <span className="seat-bet">베팅 {player.streetBet.toLocaleString()}</span>}
            {player.lastAction && <span className="mp-seat-last-action">{player.lastAction}</span>}
          </div>
          <div className="mp-seat-cards">
            {showBacks
              ? [0, 1].map((idx) =>
                  reveal && reveal.cardIndex === idx ? (
                    // 음침한 눈으로 확인한 카드 — 뒷면 대신 실제 카드 + 눈 표식 (나에게만 렌더됨)
                    <span key={idx} className="mp-revealed-card" title="음침한 눈으로 확인한 카드">
                      <Card card={asEngineCard(reveal.card)} size="sm" />
                      <span className="mp-revealed-eye">👁</span>
                    </span>
                  ) : (
                    <Card
                      key={idx}
                      hidden
                      size="sm"
                      changeFx={glowKeys.has(`${player.sessionId}:${idx}`)}
                    />
                  ),
                )
              : holeCards.map((c, idx) => (
                  <Card
                    key={c.id}
                    card={asEngineCard(c)}
                    size="sm"
                    clickable={isMe && canSwap}
                    onClick={isMe && canSwap ? () => onSwapCard(idx as 0 | 1) : undefined}
                    changeFx={glowKeys.has(`${player.sessionId}:${idx}`)}
                    highlight={!!bestFiveIds?.has(c.id)}
                  />
                ))}
          </div>
        </div>
        {/* 보유 증강 — 상대방 것도 항상 공개 표시(숨김 정보 아님) + 클릭하면 이름/효과 팝업 */}
        {player.augmentIds.length > 0 && (
          <div className="mp-seat-augments">
            {player.augmentIds.map((id) => {
              const augment = findAugment(id);
              return augment ? (
                <AugmentCard key={id} augment={augment} compact onSelect={() => onAugmentClick(id)} />
              ) : null;
            })}
          </div>
        )}
      </div>
      {isMe && canSwap && <span className="mp-swap-hint">🔄 카드를 클릭해 1장 교체 가능</span>}
    </div>
  );
}

/** 증강 뱃지 클릭 시 뜨는 이름/효과 설명 팝업 — 바깥(배경) 클릭 시 닫힌다 */
function AugmentInfoPopup({ augment, onClose }: { augment: Augment; onClose: () => void }) {
  return (
    <div className="mp-augment-popup-overlay" onClick={onClose}>
      <motion.div
        className={`mp-augment-popup rarity-${augment.rarity}`}
        initial={{ opacity: 0, scale: 0.85, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 22 }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="mp-augment-popup-rarity">{RARITY_NAMES_KO[augment.rarity]}</span>
        <h3 className="mp-augment-popup-name">{augment.name}</h3>
        <p className="mp-augment-popup-desc">{augment.description}</p>
        <button type="button" className="mp-augment-popup-close" onClick={onClose}>
          닫기
        </button>
      </motion.div>
    </div>
  );
}

/**
 * 한게임 스타일 정형 배팅 버튼 그리드. 자유 금액 입력은 없다 — 각 버튼이 낼 금액은 서버(PokerRoom)가
 * 팟/현재 베팅액 기준으로 최종 계산하고, 여기서는 그 값을 그대로 미리보기로 표시만 한다(서버 공식과
 * 반드시 동일해야 함: 삥=빅블라인드, 따당=현재 베팅액의 2배, 쿼터/하프=화면 표시 POT의 25%/50%+콜).
 * 순서(왼→오): 다이 / 삥·따당(양자택일) / 콜·체크(양자택일) / 쿼터 / 하프 / 맥스.
 */
function BettingActionBar({
  gameState,
  myPlayer,
  onAction,
}: {
  gameState: ClientGameState;
  myPlayer: ClientPlayer;
  onAction: (type: BettingActionType) => void;
}) {
  const { toCall, stack, bbAmount, doubleAmount, quarterAmount, halfAmount } = useMemo(() => {
    const toCall = Math.max(0, gameState.currentBet - myPlayer.streetBet);
    const stack = myPlayer.stack;
    const potTotal = gameState.pot + gameState.players.reduce((sum, p) => sum + p.streetBet, 0);
    const bbAmount = Math.min(gameState.bigBlind, stack);
    const doubleAmount = Math.min(Math.max(0, gameState.currentBet * 2 - myPlayer.streetBet), stack);
    const sizeAt = (ratio: number) => Math.min(toCall + Math.round(potTotal * ratio), stack);
    return {
      toCall,
      stack,
      bbAmount,
      doubleAmount,
      quarterAmount: sizeAt(0.25),
      halfAmount: sizeAt(0.5),
    };
  }, [gameState.currentBet, gameState.bigBlind, gameState.pot, gameState.players, myPlayer.streetBet, myPlayer.stack]);

  const isOpenStreet = gameState.currentBet === 0;
  // 쿼터/하프가 실질적으로 콜보다 더 내는 게 없으면(팟이 0에 가까워 반올림이 0인 경우) 무의미한 레이즈이므로 비활성화
  const quarterEnabled = quarterAmount > toCall || (isOpenStreet && quarterAmount > 0);
  const halfEnabled = halfAmount > toCall || (isOpenStreet && halfAmount > 0);

  return (
    <div className="mp-action-bar">
      <button className="bet-btn bet-die" onClick={() => onAction('fold')}>
        다이
      </button>

      {isOpenStreet ? (
        <button className="bet-btn" disabled={bbAmount <= 0} onClick={() => onAction('bet_bb')}>
          삥 <em>{bbAmount.toLocaleString()}</em>
        </button>
      ) : (
        <button className="bet-btn" disabled={doubleAmount <= 0} onClick={() => onAction('bet_double')}>
          따당 <em>{doubleAmount.toLocaleString()}</em>
        </button>
      )}

      <button className="bet-btn bet-call" onClick={() => onAction(toCall > 0 ? 'call' : 'check')}>
        {toCall > 0 ? (
          <>
            콜 <em>{Math.min(toCall, stack).toLocaleString()}</em>
          </>
        ) : (
          '체크'
        )}
      </button>

      <button className="bet-btn" disabled={!quarterEnabled} onClick={() => onAction('bet_quarter')}>
        쿼터 <em>{quarterAmount.toLocaleString()}</em>
      </button>

      <button className="bet-btn" disabled={!halfEnabled} onClick={() => onAction('bet_half')}>
        하프 <em>{halfAmount.toLocaleString()}</em>
      </button>

      <button className="bet-btn bet-max" disabled={stack <= 0} onClick={() => onAction('allin')}>
        맥스 <em>{stack.toLocaleString()}</em>
      </button>
    </div>
  );
}

function ResultBanner({ result }: { result: ShowdownResult }) {
  return (
    <motion.div
      className="mp-result-banner"
      initial={{ opacity: 0, y: -20, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
    >
      {result.byFold ? (
        <div className="mp-result-line">
          <div className="mp-result-winner-name">
            🏆 <strong>{result.winners[0]?.name}</strong> 승리 — 상대 다이
          </div>
          <div className="mp-result-payout-row">
            <span className="mp-result-payout">+{result.winners[0]?.payout.toLocaleString()} 골드</span>
          </div>
        </div>
      ) : (
        result.winners.map((w) => (
          <div key={w.sessionId} className="mp-result-line">
            <div className="mp-result-winner-name">
              🏆 <strong>{w.name}</strong>
            </div>
            {/* 족보 이름 — 한눈에 보이도록 별도 줄에 크고 굵게 표시 */}
            {w.category && (
              <div className="mp-result-category">{CATEGORY_SHORT_KO[w.category as HandCategory] ?? w.category}</div>
            )}
            <div className="mp-result-payout-row">
              <span className="mp-result-payout">+{w.payout.toLocaleString()} 골드</span>
              {w.multiplier && w.multiplier > 1 && (
                <span className="mp-result-multiplier">×{w.multiplier} 배당!</span>
              )}
            </div>
            {w.augments && w.augments.length > 0 && (
              <div className="augment-chip-row">
                {w.augments.map((name) => (
                  <span key={name} className="augment-chip rarity-prismatic">
                    ⚡ {name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </motion.div>
  );
}

/**
 * 내 홀카드 + 공개된 커뮤니티 카드만으로 현재 최고 족보를 계산한다. handEvaluator.ts의
 * evaluateBest는 최소 5장이 필요해서 그것만으로는 프리플랍(홀카드 2장뿐)을 다룰 수 없다 —
 * 프리플랍은 페어 여부만 별도로 즉석 판정하고, 플랍 이후(5장 이상)는 evaluateBest를 그대로 쓴다.
 */
function computeCurrentCategory(myHole: ClientCard[], community: ClientCard[]): HandCategory | null {
  const totalCards = myHole.length + community.length;
  if (totalCards >= 5) {
    return evaluateBest([...myHole, ...community].map(asEngineCard)).category;
  }
  if (myHole.length === 2 && community.length === 0) {
    return myHole[0].rank === myHole[1].rank ? 'pair' : 'high_card';
  }
  return null;
}

/**
 * 족보 진행 상황 패널(정보 패널의 "족보" 탭) — 내 홀카드 + 공개된 커뮤니티 카드만으로
 * handEvaluator.ts를 재사용해 클라이언트에서 계산한다. 상대 카드는 애초에 클라이언트에
 * 오지 않으므로(서버가 쇼다운 전까지 보내지 않음) 이 계산엔 절대 섞일 수 없다.
 */
function HandProgressPanel({ myHole, community }: { myHole: ClientCard[]; community: ClientCard[] }) {
  const current = computeCurrentCategory(myHole, community);

  return (
    <div className="mp-hand-progress">
      <p className="mp-hand-progress-hint">
        {current ? `현재 최고 족보 — ${CATEGORY_NAMES_KO[current]}` : '홀카드를 받으면 표시됩니다'}
      </p>
      <ul className="mp-hand-progress-list">
        {HAND_CATEGORY_ORDER.map((cat) => (
          <li
            key={cat}
            className={`mp-hand-progress-item${cat === current ? ' mp-hand-progress-active' : ''}`}
          >
            {CATEGORY_NAMES_KO[cat]}
          </li>
        ))}
      </ul>
    </div>
  );
}

const STRAIGHT_RANK = HAND_CATEGORY_ORDER.indexOf('straight');

function isBigHandCategory(current: HandCategory | null): boolean {
  return current !== null && HAND_CATEGORY_ORDER.indexOf(current) >= STRAIGHT_RANK;
}

/**
 * 족보 목록 패널 — 항상 화면 옆에 떠 있는 상시 표시 패널(팝업 아님). 작고 컴팩트한 고정
 * 크기 박스 안에서 10개 항목을 세로 스크롤로 확인한다. 평소엔 배경을 아주 투명하게 낮춰
 * 눈에 띄지 않다가, 내 현재 최고 족보가 스트레이트 이상으로 올라가는 순간에만 완전히
 * 또렷해진다(스트레이트 미만은 계속 흐림) — opacity는 CSS가 아니라 아래 style로 직접
 * 제어한다(framer-motion을 쓰지 않는 일반 div라 CSS 클래스 토글만으로 충분하다).
 */
function InfoPanel({ myHole, community }: { myHole: ClientCard[]; community: ClientCard[] }) {
  const current = computeCurrentCategory(myHole, community);
  const isBigHand = isBigHandCategory(current);

  return (
    <div className={`mp-info-panel${isBigHand ? ' mp-info-panel-focused' : ''}`}>
      <div className="mp-info-header">족보</div>
      <div className="mp-info-content">
        <HandProgressPanel myHole={myHole} community={community} />
      </div>
    </div>
  );
}

interface PokerTableProps {
  gameState: ClientGameState;
  myHole: ClientCard[];
  mySessionId: string;
  lastResult: ShowdownResult | null;
  /** 음침한 눈으로 확인한 상대 카드 — 이번 핸드 동안 해당 좌석에 표시 */
  augmentReveal: AugmentRevealInfo | null;
  /** 카드가 바뀌는 증강(카드 재구성/카멜레온/당근이세요?) 발동 시 오는 공개 브로드캐스트 */
  cardChangeEvent: CardChangeEvent | null;
  onAction: (type: BettingActionType, amount?: number) => void;
  /** 카드 재구성 — 내 홀카드 index(0|1)를 새 카드로 교체 요청 */
  onSwapCard: (index: 0 | 1) => void;
}

/** 토스트 알림 1건 (화면에 잠깐 떴다가 사라짐) */
interface CardChangeToast {
  id: number;
  text: string;
}

const CARD_CHANGE_FX_MS = 1600;
const CARD_CHANGE_TOAST_MS = 3000;

/** 포커 테이블 화면 — 상/좌/우/하 마름모 좌석 + 상단 중앙 커뮤니티/팟 + 하단 중앙 내 카드/액션 + 우측 정보 패널 */
export function PokerTable({
  gameState,
  myHole,
  mySessionId,
  lastResult,
  augmentReveal,
  cardChangeEvent,
  onAction,
  onSwapCard,
}: PokerTableProps) {
  const myPlayer = gameState.players.find((p) => p.sessionId === mySessionId) ?? null;
  const isMyTurn = gameState.activePlayerId === mySessionId;
  const activePlayer = gameState.players.find((p) => p.sessionId === gameState.activePlayerId);
  const potTotal = gameState.pot + gameState.players.reduce((sum, p) => sum + p.streetBet, 0);
  // 서버의 seatIndex/턴 순서는 건드리지 않고, 내 자리를 항상 하단으로 보이게 하는 표시 슬롯만 계산
  const mySeatIndex = myPlayer?.seatIndex ?? 0;
  const canAct = isMyTurn && myPlayer && !myPlayer.isFolded && !myPlayer.allIn;
  const canSwap =
    BETTING_PHASES.has(gameState.phase) &&
    !!myPlayer &&
    !myPlayer.isFolded &&
    !myPlayer.swapUsed &&
    hasCardSwapAugment(myPlayer);

  // 내 관점에서 실시간(또는 쇼다운) 최고 족보를 구성하는 카드 — 홀카드/보드에 골드 하이라이트
  const myBestFiveIds = useMemo(() => computeBestFiveIds(myHole, gameState.community), [myHole, gameState.community]);

  // 카드가 바뀐 좌석/인덱스("sessionId:0"/"sessionId:1") — 잠깐 글로우를 재생하고 자동으로 사라진다
  const [glowKeys, setGlowKeys] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<CardChangeToast[]>([]);
  const toastIdRef = useRef(0);
  // 클릭해서 이름/효과 설명을 다시 확인 중인 증강 — null이면 팝업 닫힘
  const [augmentPopupId, setAugmentPopupId] = useState<string | null>(null);
  const augmentPopup = augmentPopupId ? findAugment(augmentPopupId) : null;
  const glowTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = glowTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (!cardChangeEvent) return;
    const keys = cardChangeEvent.changes.map((c) => `${c.sessionId}:${c.cardIndex}`);
    setGlowKeys((prev) => new Set([...prev, ...keys]));
    for (const key of keys) {
      const existing = glowTimers.current.get(key);
      if (existing) clearTimeout(existing);
      glowTimers.current.set(
        key,
        setTimeout(() => {
          setGlowKeys((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
          glowTimers.current.delete(key);
        }, CARD_CHANGE_FX_MS),
      );
    }

    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, text: describeCardChange(cardChangeEvent) }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), CARD_CHANGE_TOAST_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardChangeEvent]);

  // 고정 크기로 디자인된 테이블 전체를 뷰포트에 맞춰 통째로 스케일한다 — 요소 각각을
  // 반응형으로 다시 배치하는 대신 하나의 캔버스로 취급해, 화면 크기와 무관하게 상/좌/우/하
  // 좌석·보드·베팅 바의 상대적 크기 비율이 항상 그대로 유지되고 스크롤 없이 한 화면에 들어온다.
  const { ref: stageRef, scale } = useFitScale<HTMLDivElement>();

  return (
    <div className="mp-scale-viewport">
      <div className="mp-scale-stage" ref={stageRef} style={{ transform: `scale(${scale})` }}>
        <div className="screen room mp-table-screen">
      <div className="scanlines" />
      <div className="mp-round-badge">
        라운드 {gameState.round}/{gameState.maxRounds}
      </div>

      {/* 카드 변경 알림 토스트 — "OO님의 카드가 XX 효과로 바뀌었습니다" */}
      <div className="mp-cardchange-toast-stack">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              className="mp-cardchange-toast"
              initial={{ opacity: 0, y: -10, scale: 0.7 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 320, damping: 18 }}
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="mp-game-layout">
        <div className="mp-table-main">
          <div className="mp-table-area">
            <div className="mp-center-board">
              <div className="pot-capsule">
                <span className="pot-label">POT</span>
                <span className="pot-value">{potTotal.toLocaleString()} 골드</span>
              </div>
              <div className="card-row board-cards">
                {gameState.community.map((c) => (
                  <Card key={c.id} card={asEngineCard(c)} highlight={!!myBestFiveIds?.has(c.id)} />
                ))}
                {Array.from({ length: 5 - gameState.community.length }).map((_, i) => (
                  <Card key={`ph-${i}`} />
                ))}
              </div>
            </div>

            {gameState.players.map((p) => (
              <DiamondSeat
                key={p.sessionId}
                player={p}
                isMe={p.sessionId === mySessionId}
                myHole={myHole}
                isDealer={p.seatIndex === gameState.dealerSeat}
                isActive={p.sessionId === gameState.activePlayerId}
                diamondSlot={toDisplaySlot(p.seatIndex, mySeatIndex)}
                reveal={augmentReveal?.targetSessionId === p.sessionId ? augmentReveal : null}
                glowKeys={glowKeys}
                community={gameState.community}
                canSwap={canSwap}
                onSwapCard={onSwapCard}
                onAugmentClick={setAugmentPopupId}
              />
            ))}

            <AnimatePresence>{lastResult && <ResultBanner key="result" result={lastResult} />}</AnimatePresence>

            {/* 우측 상단 좌석(마름모 배치의 .mp-diamond-right) 바로 아래 고정 — 그 좌석에
                누가 앉든(내 시점에 따라 상대적으로 바뀌어도) 항상 이 자리에 위치한다 */}
            <InfoPanel myHole={myHole} community={gameState.community} />
          </div>

          <div className={`mp-bottom-panel${isMyTurn ? ' mp-bottom-panel-my-turn' : ''}`}>
            <div className="mp-bottom-action">
              {canAct && myPlayer ? (
                <BettingActionBar gameState={gameState} myPlayer={myPlayer} onAction={onAction} />
              ) : gameState.phase === 'augment_target' ? (
                <p className="mp-waiting-turn">플레이어들이 즉시형 증강 효과 대상을 지정하는 중입니다...</p>
              ) : gameState.phase === 'augment_select' ? (
                <p className="mp-waiting-turn">잠시 후 증강 선택 화면이 열립니다...</p>
              ) : (
                BETTING_PHASES.has(gameState.phase) && (
                  <p className="mp-waiting-turn">
                    {activePlayer ? `${activePlayer.name}님의 차례를 기다리는 중...` : '다음 차례를 기다리는 중...'}
                  </p>
                )
              )}
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {augmentPopup && <AugmentInfoPopup key={augmentPopup.id} augment={augmentPopup} onClose={() => setAugmentPopupId(null)} />}
      </AnimatePresence>
      </div>
      </div>
    </div>
  );
}
