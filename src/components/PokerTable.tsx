import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from './Card';
import { AugmentCard } from './AugmentCard';
import augmentsData from '../data/augments.json';
import type { Augment } from '../engine/augmentEngine';
import { evaluateBest, CATEGORY_NAMES_KO, type HandCategory } from '../engine/handEvaluator';
import type { Card as EngineCard } from '../engine/types';
import { CATEGORY_SHORT_KO } from '../ui/format';
import type {
  BettingActionType,
  ClientCard,
  ClientGameState,
  ClientPlayer,
  ShowdownResult,
} from '../net/useMultiplayerRoom';

const AUGMENT_POOL = augmentsData as Augment[];
const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);
/** 뒷면 카드 연출용 — suit/rank 값은 화면에 노출되지 않는다(뒤집힌 상태로만 렌더) */
const CARD_BACK: ClientCard = { id: 'back', suit: 'spades', rank: 2, isJoker: false };
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
 * 서버의 seatIndex(턴 순서 등 게임 로직)는 그대로 두고, 화면에 어디(상/좌/우/하)에 그릴지만
 * "내 seatIndex가 항상 하단 중앙"이 되도록 상대적으로 재계산한다 — 마름모(다이아몬드) 배치.
 * 슬롯 순서 0→하단(나), 1→우측, 2→상단, 3→좌측 — 시계 방향 순서는 그대로 유지된다.
 * 예: 내가 seat 2면 2→하단, 3→우측, 0→상단, 1→좌측.
 */
function toDisplaySlot(seatIndex: number, mySeatIndex: number): number {
  return (seatIndex - mySeatIndex + 4) % 4;
}

const DIAMOND_CLASS = ['mp-diamond-bottom', 'mp-diamond-right', 'mp-diamond-top', 'mp-diamond-left'];

interface DiamondSeatProps {
  player: ClientPlayer;
  isMe: boolean;
  myHole: ClientCard[];
  isDealer: boolean;
  isActive: boolean;
  diamondSlot: number;
}

/** 상/좌/우/하 마름모 형태로 배치되는 좌석 카드 — 이름/칩/미니 홀카드/보유 증강(항상 공개) */
function DiamondSeat({ player, isMe, myHole, isDealer, isActive, diamondSlot }: DiamondSeatProps) {
  const holeCards: ClientCard[] = isMe ? myHole : player.revealedHole.length > 0 ? player.revealedHole : [];
  const showBacks = holeCards.length === 0 && !player.isFolded;

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
      {isDealer && <span className="mp-dealer-chip">D</span>}
      <div className="mp-seat-info">
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
        {showBacks ? (
          <>
            <Card card={asEngineCard(CARD_BACK)} hidden size="sm" />
            <Card card={asEngineCard(CARD_BACK)} hidden size="sm" />
          </>
        ) : (
          holeCards.map((c) => <Card key={c.id} card={asEngineCard(c)} size="sm" />)
        )}
      </div>
      {/* 보유 증강 — 상대방 것도 항상 공개 표시 (숨김 정보 아님) */}
      {player.augmentIds.length > 0 && (
        <div className="mp-seat-augments">
          {player.augmentIds.map((id) => {
            const augment = findAugment(id);
            return augment ? <AugmentCard key={id} augment={augment} compact /> : null;
          })}
        </div>
      )}
    </div>
  );
}

function BettingActionBar({
  gameState,
  myPlayer,
  onAction,
}: {
  gameState: ClientGameState;
  myPlayer: ClientPlayer;
  onAction: (type: BettingActionType, amount?: number) => void;
}) {
  const toCall = Math.max(0, gameState.currentBet - myPlayer.streetBet);
  const maxRaise = myPlayer.stack - toCall;
  const [raiseAmount, setRaiseAmount] = useState(Math.min(gameState.minRaise, Math.max(maxRaise, 0)));

  const canRaise = maxRaise >= gameState.minRaise;
  const handleRaiseChange = (value: number) => {
    setRaiseAmount(Math.min(Math.max(value, gameState.minRaise), maxRaise));
  };

  return (
    <div className="mp-action-bar">
      <button className="bet-btn bet-die" onClick={() => onAction('fold')}>
        다이
      </button>
      <button className="bet-btn bet-call" onClick={() => onAction(toCall > 0 ? 'call' : 'check')}>
        {toCall > 0 ? (
          <>
            콜 <em>{Math.min(toCall, myPlayer.stack).toLocaleString()}</em>
          </>
        ) : (
          '체크'
        )}
      </button>
      {canRaise && (
        <div className="mp-raise-group">
          <input
            type="number"
            className="mp-raise-input"
            min={gameState.minRaise}
            max={maxRaise}
            step={gameState.bigBlind}
            value={raiseAmount}
            onChange={(e) => handleRaiseChange(Number(e.target.value) || gameState.minRaise)}
          />
          <button className="bet-btn" onClick={() => onAction('raise', raiseAmount)}>
            레이즈
          </button>
        </div>
      )}
      <button className="bet-btn bet-max" onClick={() => onAction('allin')}>
        맥스 <em>{myPlayer.stack.toLocaleString()}</em>
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

type InfoTab = 'chat' | 'hands' | 'history';

function InfoPanel({ myHole, community }: { myHole: ClientCard[]; community: ClientCard[] }) {
  const [tab, setTab] = useState<InfoTab>('hands');

  return (
    <div className="mp-info-panel">
      <div className="mp-info-tabs">
        <button
          type="button"
          className={`mp-info-tab-btn${tab === 'chat' ? ' mp-info-tab-active' : ''}`}
          onClick={() => setTab('chat')}
        >
          채팅
        </button>
        <button
          type="button"
          className={`mp-info-tab-btn${tab === 'hands' ? ' mp-info-tab-active' : ''}`}
          onClick={() => setTab('hands')}
        >
          족보
        </button>
        <button
          type="button"
          className={`mp-info-tab-btn${tab === 'history' ? ' mp-info-tab-active' : ''}`}
          onClick={() => setTab('history')}
        >
          내기록
        </button>
      </div>
      <div className="mp-info-content">
        {tab === 'hands' && <HandProgressPanel myHole={myHole} community={community} />}
        {tab === 'chat' && <p className="mp-info-placeholder">채팅 기능은 준비 중입니다.</p>}
        {tab === 'history' && <p className="mp-info-placeholder">전적 기록 기능은 준비 중입니다.</p>}
      </div>
    </div>
  );
}

interface PokerTableProps {
  gameState: ClientGameState;
  myHole: ClientCard[];
  mySessionId: string;
  lastResult: ShowdownResult | null;
  onAction: (type: BettingActionType, amount?: number) => void;
}

/** 포커 테이블 화면 — 상/좌/우/하 마름모 좌석 + 상단 중앙 커뮤니티/팟 + 하단 중앙 내 카드/액션 + 우측 정보 패널 */
export function PokerTable({ gameState, myHole, mySessionId, lastResult, onAction }: PokerTableProps) {
  const myPlayer = gameState.players.find((p) => p.sessionId === mySessionId) ?? null;
  const isMyTurn = gameState.activePlayerId === mySessionId;
  const activePlayer = gameState.players.find((p) => p.sessionId === gameState.activePlayerId);
  const potTotal = gameState.pot + gameState.players.reduce((sum, p) => sum + p.streetBet, 0);
  // 서버의 seatIndex/턴 순서는 건드리지 않고, 내 자리를 항상 하단으로 보이게 하는 표시 슬롯만 계산
  const mySeatIndex = myPlayer?.seatIndex ?? 0;
  const canAct = isMyTurn && myPlayer && !myPlayer.isFolded && !myPlayer.allIn;

  return (
    <div className="screen room mp-table-screen">
      <div className="scanlines" />
      <div className="mp-round-badge">
        라운드 {gameState.round}/{gameState.maxRounds}
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
                  <Card key={c.id} card={asEngineCard(c)} />
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
              />
            ))}

            <AnimatePresence>{lastResult && <ResultBanner key="result" result={lastResult} />}</AnimatePresence>
          </div>

          <div className={`mp-bottom-panel${isMyTurn ? ' mp-bottom-panel-my-turn' : ''}`}>
            <div className="mp-bottom-cards">
              {myHole.length > 0 ? (
                myHole.map((c, i) => <Card key={c.id} card={asEngineCard(c)} size="lg" dealDelay={i * 0.08} />)
              ) : (
                <>
                  <Card size="lg" />
                  <Card size="lg" />
                </>
              )}
            </div>
            <div className="mp-bottom-action">
              {canAct && myPlayer ? (
                <BettingActionBar gameState={gameState} myPlayer={myPlayer} onAction={onAction} />
              ) : gameState.phase === 'augment_target' ? (
                <p className="mp-waiting-turn">플레이어들이 즉시형 증강 효과 대상을 지정하는 중입니다...</p>
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

        <InfoPanel myHole={myHole} community={gameState.community} />
      </div>
    </div>
  );
}
