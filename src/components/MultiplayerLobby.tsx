import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useMultiplayerRoom } from '../net/useMultiplayerRoom';
import { AugmentSelectScreen } from './AugmentSelectScreen';
import { PokerTable } from './PokerTable';

export function MultiplayerLobby({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState('');
  const {
    roomId,
    status,
    errorMessage,
    room,
    shareUrl,
    create,
    gameState,
    myHole,
    myAugmentChoices,
    chooseAugment,
    sendAction,
    lastResult,
    gameOver,
  } = useMultiplayerRoom(name);

  // 서버 거부 메시지(방장 아님, 잘못된 레이즈 금액 등)는 화면에 상관없이 토스트로 띄운다
  useEffect(() => {
    if (!room) return;
    const offError = room.onMessage('error', (e: { message: string }) =>
      setActionError(e?.message || '요청을 처리할 수 없습니다'),
    );
    return () => {
      offError?.();
    };
  }, [room]);

  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(''), 3000);
    return () => clearTimeout(t);
  }, [actionError]);

  const phase = gameState?.phase ?? 'waiting';
  const playerCount = gameState?.players.length ?? 0;
  const isHost = !!room && !!gameState && room.sessionId === gameState.hostSessionId;

  const handleStartGame = () => {
    setActionError('');
    room?.send('startGame');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드 API 미지원 시 무시 — 링크 입력창에서 직접 복사 가능
    }
  };

  return (
    <div className="mp-shell">
      <button className="mp-close" onClick={onClose} aria-label="닫기">
        ✕
      </button>

      {status === 'connected' && room && gameState && phase === 'augment_select' && (
        <AugmentSelectScreen round={gameState.round} choices={myAugmentChoices} onSelect={chooseAugment} />
      )}

      {status === 'connected' && room && gameState && phase === 'gameOver' && (
        <div className="screen title-screen mp-lobby">
          <div className="scanlines" />
          <motion.h1
            className="game-title mp-title"
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 220, damping: 16 }}
          >
            🏆 게임 종료
          </motion.h1>
          {gameOver && (
            <>
              <p className="game-subtitle">{gameOver.reason}</p>
              <div className="mp-connected">
                {gameOver.standings.map((s, i) => (
                  <p key={s.sessionId} className="mp-hint">
                    {i + 1}위 — {s.name} · {s.stack.toLocaleString()} 골드
                    {!s.connected ? ' (퇴장)' : ''}
                  </p>
                ))}
              </div>
            </>
          )}
          <button className="gold-btn gold-btn-large" onClick={onClose}>
            처음으로
          </button>
        </div>
      )}

      {status === 'connected' &&
        room &&
        gameState &&
        phase !== 'waiting' &&
        phase !== 'augment_select' &&
        phase !== 'gameOver' && (
          <PokerTable
            gameState={gameState}
            myHole={myHole}
            mySessionId={room.sessionId}
            lastResult={lastResult}
            onAction={sendAction}
          />
        )}

      {(status !== 'connected' || phase === 'waiting') && (
        <div className="screen title-screen mp-lobby">
          <div className="scanlines" />

          <motion.h1
            className="game-title mp-title"
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 18 }}
          >
            🌐 친구와 함께 플레이
          </motion.h1>

          {status === 'idle' && !roomId && (
            <div className="mp-form">
              <input
                className="mp-input"
                placeholder="닉네임 (선택)"
                maxLength={12}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <button className="gold-btn gold-btn-large" onClick={() => create()}>
                새 방 만들기
              </button>
            </div>
          )}

          {status === 'connecting' && <p className="game-subtitle">입장 중...</p>}

          {status === 'error' && (
            <div className="mp-error-box">
              <p className="mp-error">{errorMessage}</p>
              <button className="gold-btn" onClick={onClose}>
                처음으로
              </button>
            </div>
          )}

          {status === 'connected' && room && (
            <div className="mp-connected">
              <p className="game-subtitle">✅ 방에 입장했습니다 ({playerCount}/4명)</p>
              <div className="mp-link-row">
                <input
                  className="mp-input mp-link-input"
                  readOnly
                  value={shareUrl}
                  onFocus={(e) => e.target.select()}
                />
                <button className="gold-btn" onClick={handleCopy}>
                  {copied ? '복사됨!' : '링크 복사'}
                </button>
              </div>
              <p className="mp-hint">이 링크를 공유하면 친구가 바로 이 방에 입장할 수 있어요.</p>

              {isHost ? (
                <>
                  <button className="gold-btn gold-btn-large" onClick={handleStartGame}>
                    게임 시작
                  </button>
                  {playerCount < 4 && <p className="mp-hint">사람이 부족한 자리는 AI 봇이 자동으로 채워요.</p>}
                </>
              ) : (
                <p className="mp-hint">방장이 게임을 시작하길 기다리는 중...</p>
              )}
            </div>
          )}
        </div>
      )}

      {actionError && <div className="mp-toast-error">{actionError}</div>}
    </div>
  );
}
