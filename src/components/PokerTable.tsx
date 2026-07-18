import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from './Card';
import { AugmentCard } from './AugmentCard';
import augmentsData from '../data/augments.json';
import type { Augment } from '../engine/augmentEngine';
import type { HandCategory } from '../engine/handEvaluator';
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

function findAugment(id: string): Augment | undefined {
  return AUGMENT_POOL.find((a) => a.id === id);
}

/** 네트워크로 전달된 느슨한 카드 타입 → 로컬 엔진의 리터럴 타입으로 캐스팅 (값은 서버가 보장) */
function asEngineCard(c: ClientCard): EngineCard {
  return c as unknown as EngineCard;
}

const SEAT_POSITION_CLASS = ['mp-seat-pos-0', 'mp-seat-pos-1', 'mp-seat-pos-2', 'mp-seat-pos-3'];

interface SeatProps {
  player: ClientPlayer;
  isMe: boolean;
  myHole: ClientCard[];
  isDealer: boolean;
  isActive: boolean;
}

function Seat({ player, isMe, myHole, isDealer, isActive }: SeatProps) {
  const holeCards: ClientCard[] = isMe ? myHole : player.revealedHole.length > 0 ? player.revealedHole : [];
  const showBacks = holeCards.length === 0 && !player.isFolded;

  return (
    <div
      className={[
        'mp-seat',
        SEAT_POSITION_CLASS[player.seatIndex],
        player.isFolded ? 'mp-seat-folded' : '',
        isActive ? 'mp-seat-active' : '',
        isActive && isMe ? 'mp-seat-my-turn' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {isDealer && <span className="mp-dealer-chip">D</span>}
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
        폴드
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
        올인 <em>{myPlayer.stack.toLocaleString()}</em>
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
        <p className="mp-result-line">
          🏆 <strong>{result.winners[0]?.name}</strong> 승리 — 상대 다이
          <span className="mp-result-payout">+{result.winners[0]?.payout.toLocaleString()} 골드</span>
        </p>
      ) : (
        result.winners.map((w) => (
          <div key={w.sessionId} className="mp-result-line">
            🏆 <strong>{w.name}</strong>
            {w.category && (
              <span className="hand-capsule hand-capsule-win">
                {CATEGORY_SHORT_KO[w.category as HandCategory] ?? w.category}
              </span>
            )}
            <span className="mp-result-payout">+{w.payout.toLocaleString()} 골드</span>
            {w.multiplier && w.multiplier > 1 && (
              <span className="mp-result-multiplier">×{w.multiplier} 배당!</span>
            )}
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

interface PokerTableProps {
  gameState: ClientGameState;
  myHole: ClientCard[];
  mySessionId: string;
  lastResult: ShowdownResult | null;
  onAction: (type: BettingActionType, amount?: number) => void;
}

/** 포커 테이블 화면 — 타원형 테이블 둘레에 4석 배치, 하단 베팅 액션, 쇼다운 결과 배너 */
export function PokerTable({ gameState, myHole, mySessionId, lastResult, onAction }: PokerTableProps) {
  const myPlayer = gameState.players.find((p) => p.sessionId === mySessionId) ?? null;
  const isMyTurn = gameState.activePlayerId === mySessionId;
  const activePlayer = gameState.players.find((p) => p.sessionId === gameState.activePlayerId);
  const potTotal = gameState.pot + gameState.players.reduce((sum, p) => sum + p.streetBet, 0);

  return (
    <div className="screen room mp-table-screen">
      <div className="scanlines" />
      <div className="mp-round-badge">
        라운드 {gameState.round}/{gameState.maxRounds}
      </div>

      <div className="mp-table-oval">
        <div className="board">
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
          <Seat
            key={p.sessionId}
            player={p}
            isMe={p.sessionId === mySessionId}
            myHole={myHole}
            isDealer={p.seatIndex === gameState.dealerSeat}
            isActive={p.sessionId === gameState.activePlayerId}
          />
        ))}

        <AnimatePresence>{lastResult && <ResultBanner key="result" result={lastResult} />}</AnimatePresence>
      </div>

      <div className="mp-action-dock">
        {isMyTurn && myPlayer && !myPlayer.isFolded && !myPlayer.allIn ? (
          <BettingActionBar gameState={gameState} myPlayer={myPlayer} onAction={onAction} />
        ) : (
          BETTING_PHASES.has(gameState.phase) && (
            <p className="mp-waiting-turn">
              {activePlayer ? `${activePlayer.name}님의 차례를 기다리는 중...` : '다음 차례를 기다리는 중...'}
            </p>
          )
        )}
      </div>
    </div>
  );
}
