import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useMultiplayerRoom } from '../net/useMultiplayerRoom';
import { useAuthStore } from '../store/authStore';
import { AugmentSelectScreen } from './AugmentSelectScreen';
import { AugmentTargetScreen } from './AugmentTargetScreen';
import { BottomDealPrompt } from './BottomDealPrompt';
import { PokerTable } from './PokerTable';
import { SoundToggleButton } from './SoundToggleButton';
import { playSound } from '../utils/sounds';

export function MultiplayerLobby({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState('');
  const authUser = useAuthStore((s) => s.user);
  const authProfile = useAuthStore((s) => s.profile);
  const authAccessToken = useAuthStore((s) => s.session?.access_token);
  const {
    roomId,
    status,
    errorMessage,
    room,
    shareUrl,
    create,
    joinById,
    gameState,
    myHole,
    myAugmentChoices,
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
    extendTurnTimer,
    turnExtendedEvent,
    noticeEvent,
    bigAnnouncement,
  } = useMultiplayerRoom(name, authAccessToken);

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

  // augment_select phase에 막 들어서면 곧바로 선택 UI를 덮어씌우지 않고, 약 3초간 직전
  // 핸드/테이블을 그대로 보여준 뒤(증강 선택 UI 없이) 선택 화면을 띄운다.
  // 단, 게임 시작 직후 첫 라운드(아직 보여줄 직전 핸드가 없음)에는 3초씩이나 기다릴 필요는
  // 없지만, 완전히 즉시 뜨면 너무 갑작스러우니 짧게 0.5초만 뜸을 들인 후 띄운다.
  const [augmentUiReady, setAugmentUiReady] = useState(false);
  useEffect(() => {
    if (phase !== 'augment_select') {
      setAugmentUiReady(false);
      return;
    }
    const waitMs = gameState?.round === 1 ? 500 : 3000;
    const t = setTimeout(() => setAugmentUiReady(true), waitMs);
    return () => clearTimeout(t);
  }, [phase, gameState?.round]);

  const showAugmentScreen = phase === 'augment_select' && augmentUiReady;
  const showTable = phase !== 'waiting' && phase !== 'gameOver' && !showAugmentScreen;

  const handleStartGame = () => {
    playSound('buttonClick');
    setActionError('');
    room?.send('startGame');
  };

  const fallbackCopy = (text: string) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // 화면에 보이지 않게 배치하되 focus/select는 가능해야 한다
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let succeeded = false;
    try {
      succeeded = document.execCommand('copy');
    } catch (err) {
      console.error('[MultiplayerLobby] execCommand copy 실패:', err);
    }
    document.body.removeChild(textarea);
    return succeeded;
  };

  const handleCopy = async () => {
    playSound('buttonClick');
    // HTTPS(또는 localhost)가 아닌 환경(예: 로컬 네트워크 IP로 접속한 http)에서는
    // navigator.clipboard 자체가 존재하지 않거나 호출이 거부될 수 있다.
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        return;
      } catch (err) {
        console.error('[MultiplayerLobby] navigator.clipboard.writeText 실패, fallback 시도:', err);
      }
    }
    if (fallbackCopy(shareUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setActionError('복사에 실패했습니다. 링크 입력창에서 직접 복사해주세요.');
    }
  };

  return (
    <div className="mp-shell">
      <SoundToggleButton />
      <button
        className="mp-close"
        onClick={() => {
          playSound('buttonClick');
          onClose();
        }}
        aria-label="닫기"
      >
        ✕
      </button>

      {status === 'connected' && room && gameState && showAugmentScreen && (
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
                {/* 로그인 유저 — 서버가 endGame()에서 profiles.chips 정산을 마치자마자
                    'chipsSettled'로 보내준 값이 이미 authStore에 반영돼 있다 */}
                {authUser && authProfile && (
                  <p className="mp-hint">정산된 보유 칩: {authProfile.chips.toLocaleString()} 골드</p>
                )}
              </div>
            </>
          )}
          <button
            className="gold-btn gold-btn-large"
            onClick={() => {
              playSound('buttonClick');
              onClose();
            }}
          >
            처음으로
          </button>
        </div>
      )}

      {status === 'connected' && room && gameState && showTable && (
        <PokerTable
          gameState={gameState}
          myHole={myHole}
          mySessionId={room.sessionId}
          lastResult={lastResult}
          augmentReveal={lastAugmentReveal}
          cardChangeEvent={cardChangeEvent}
          noticeEvent={noticeEvent}
          bigAnnouncement={bigAnnouncement}
          turnExtendedEvent={turnExtendedEvent}
          onAction={sendAction}
          onSwapCard={swapHoleCard}
          onResetBoard={resetBoard}
          onExtendTurnTimer={extendTurnTimer}
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

          {status === 'idle' && (
            <div className="mp-form">
              {authUser ? (
                // 로그인 상태면 실제 칩이 걸린 신원(서버가 확인한 프로필 닉네임)으로만
                // 입장한다 — 자유 입력 닉네임으로 바꿔치기(스푸핑)할 수 없게 막는다.
                <p className="mp-hint">
                  {authProfile ? `${authProfile.nickname}님으로 입장합니다` : '로그인 정보를 불러오는 중...'}
                </p>
              ) : (
                <>
                  {roomId && <p className="mp-hint">닉네임을 정하고 이 방에 입장하세요.</p>}
                  <input
                    className="mp-input"
                    placeholder="닉네임 (미입력 시 자동 배정, 최대 8자)"
                    maxLength={8}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </>
              )}
              {roomId ? (
                <button
                  className="gold-btn gold-btn-large"
                  onClick={() => {
                    playSound('buttonClick');
                    joinById(roomId);
                  }}
                >
                  입장하기
                </button>
              ) : (
                <button
                  className="gold-btn gold-btn-large"
                  onClick={() => {
                    playSound('buttonClick');
                    create();
                  }}
                >
                  새 방 만들기
                </button>
              )}
            </div>
          )}

          {status === 'connecting' && <p className="game-subtitle">입장 중...</p>}

          {status === 'error' && (
            <div className="mp-error-box">
              <p className="mp-error">{errorMessage}</p>
              <button
                className="gold-btn"
                onClick={() => {
                  playSound('buttonClick');
                  onClose();
                }}
              >
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

      {/* 즉시형 증강(음침한 눈/카멜레온/당근이세요?) 대상 지정 — 없으면 15초 자동 타임아웃까지
          화면이 멈춘 것처럼 보인다. 어느 화면 위에 있든 최상단 모달로 띄운다. */}
      {pendingAugmentTarget && (
        <AugmentTargetScreen
          request={pendingAugmentTarget}
          myHole={myHole}
          onSubmit={chooseAugmentTarget}
          onSkip={skipAugmentTarget}
        />
      )}

      {/* 밑장빼기 — 플랍/턴/리버 공개 직전, 나에게만 사용 여부를 묻는 모달 */}
      {pendingBottomDealChoice && <BottomDealPrompt onChoose={chooseBottomDeal} />}

      {actionError && <div className="mp-toast-error">{actionError}</div>}
    </div>
  );
}
