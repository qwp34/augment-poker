import { useGameStore } from '../store/gameStore';
import { sfx } from '../ui/sfx';

/** 한게임 스타일 베팅 버튼 그리드 — 다이 / 체크·콜 / 레이즈 / 맥스 */
export function BettingPanel() {
  const phase = useGameStore((s) => s.phase);
  const streetBets = useGameStore((s) => s.streetBets);
  const playerStack = useGameStore((s) => s.playerStack);
  const pot = useGameStore((s) => s.pot);
  const botThinking = useGameStore((s) => s.botThinking);
  const playerAct = useGameStore((s) => s.playerAct);

  if (phase !== 'betting') return null;

  const toCall = Math.max(0, streetBets.bot - streetBets.player);
  const potTotal = pot + streetBets.player + streetBets.bot;
  const canRaise = playerStack > toCall;
  const raiseSmall = Math.min(200, playerStack - toCall);
  const raisePot = Math.min(Math.max(200, Math.round(potTotal / 50) * 50), playerStack - toCall);

  // 이미 올인 상태 — 자동 진행 대기
  if (playerStack === 0 && toCall === 0) return null;

  const act = (action: Parameters<typeof playerAct>[0], amount?: number) => {
    sfx.chip();
    playerAct(action, amount);
  };

  return (
    <div className={`bet-grid ${botThinking ? 'bet-locked' : ''}`}>
      <button className="bet-btn bet-die" disabled={botThinking} onClick={() => act('fold')}>
        다이
      </button>
      <button className="bet-btn bet-call" disabled={botThinking} onClick={() => act('checkcall')}>
        {toCall > 0 ? (
          <>
            콜 <em>{Math.min(toCall, playerStack).toLocaleString()}</em>
          </>
        ) : (
          '체크'
        )}
      </button>
      <button
        className="bet-btn"
        disabled={botThinking || !canRaise}
        onClick={() => act('raise', raiseSmall)}
      >
        레이즈 <em>{Math.max(0, raiseSmall).toLocaleString()}</em>
      </button>
      <button
        className="bet-btn"
        disabled={botThinking || !canRaise || raisePot <= 0}
        onClick={() => act('raise', raisePot)}
      >
        하프 <em>{Math.max(0, raisePot).toLocaleString()}</em>
      </button>
      <button className="bet-btn bet-max" disabled={botThinking} onClick={() => act('allin')}>
        맥스 <em>{playerStack.toLocaleString()}</em>
      </button>
      {botThinking && <div className="bet-thinking">봇이 고민 중…</div>}
    </div>
  );
}
