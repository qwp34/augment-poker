import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from './store/gameStore';
import { Card } from './components/Card';
import { AugmentCard } from './components/AugmentCard';
import { BettingPanel } from './components/BettingPanel';
import { WinBanner } from './components/WinBanner';
import { TopBar } from './components/TopBar';
import { LogPanel } from './components/LogPanel';
import { MultiplayerLobby } from './components/MultiplayerLobby';
import { findByEffect } from './engine/augmentEngine';
import { evaluateBest } from './engine/handEvaluator';
import { handLabel } from './ui/format';
import { useCountUp } from './ui/useCountUp';
import { sfx } from './ui/sfx';
import { getRoomIdFromPath } from './net/colyseusClient';
import './App.css';

export default function App() {
  const [started, setStarted] = useState(false);
  // 공유 링크(/room/:roomId)로 들어온 경우 곧바로 멀티플레이 로비를 연다
  const [multiplayerOpen, setMultiplayerOpen] = useState(() => !!getRoomIdFromPath());
  const phase = useGameStore((s) => s.phase);
  const playerStack = useGameStore((s) => s.playerStack);
  const botStack = useGameStore((s) => s.botStack);
  const pot = useGameStore((s) => s.pot);
  const streetBets = useGameStore((s) => s.streetBets);
  const playerHole = useGameStore((s) => s.playerHole);
  const botHole = useGameStore((s) => s.botHole);
  const community = useGameStore((s) => s.community);
  const ownedAugments = useGameStore((s) => s.ownedAugments);
  const augmentChoices = useGameStore((s) => s.augmentChoices);
  const swapUsedThisHand = useGameStore((s) => s.swapUsedThisHand);
  const botSpeech = useGameStore((s) => s.botSpeech);
  const botThinking = useGameStore((s) => s.botThinking);
  const outcome = useGameStore((s) => s.outcome);
  const round = useGameStore((s) => s.round);
  const maxRounds = useGameStore((s) => s.maxRounds);
  const startGame = useGameStore((s) => s.startGame);
  const chooseAugment = useGameStore((s) => s.chooseAugment);
  const swapHoleCard = useGameStore((s) => s.swapHoleCard);
  const nextRound = useGameStore((s) => s.nextRound);

  const potDisplay = useCountUp(pot + streetBets.player + streetBets.bot, 500);

  const canSwap =
    phase === 'betting' && !swapUsedThisHand && !!findByEffect(ownedAugments, 'card_swap');

  // 봇 말풍선 자동 숨김
  const [speechVisible, setSpeechVisible] = useState(false);
  useEffect(() => {
    if (!botSpeech) return;
    setSpeechVisible(true);
    const t = setTimeout(() => setSpeechVisible(false), 3200);
    return () => clearTimeout(t);
  }, [botSpeech]);

  // 플레이어 현재 완성 핸드 (플랍 이후 실시간 표시)
  const liveHand = useMemo(() => {
    if (playerHole.length < 2 || community.length < 3) return null;
    return evaluateBest([...playerHole, ...community]);
  }, [playerHole, community]);

  const playerWon = outcome?.winner === 'player';
  const showResult = phase === 'roundResult';

  const closeMultiplayer = () => {
    window.history.pushState(null, '', '/');
    setMultiplayerOpen(false);
  };

  // ── 멀티플레이 로비 (링크 공유 입장 / 방 생성) ──
  if (multiplayerOpen) {
    return <MultiplayerLobby onClose={closeMultiplayer} />;
  }

  // ── 타이틀 화면 ──
  if (!started) {
    return (
      <div className="screen title-screen">
        <div className="scanlines" />
        <motion.h1
          className="game-title"
          initial={{ y: -40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 18 }}
        >
          ♠ 증강 포커 ♠
        </motion.h1>
        <motion.p
          className="game-subtitle"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          매 라운드 증강을 쌓아 봇을 무너뜨려라
        </motion.p>
        <motion.button
          className="gold-btn gold-btn-large"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.5, type: 'spring', stiffness: 260 }}
          onClick={() => {
            sfx.click();
            startGame();
            setStarted(true);
          }}
        >
          게임 시작
        </motion.button>
        <motion.button
          className="mp-multiplayer-btn"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7 }}
          onClick={() => setMultiplayerOpen(true)}
        >
          🌐 친구와 함께 플레이
        </motion.button>
      </div>
    );
  }

  // ── 게임 오버 화면 ──
  if (phase === 'gameOver') {
    const won = playerStack > botStack;
    return (
      <div className="screen title-screen">
        <div className="scanlines" />
        <motion.h1
          className="game-title"
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 16 }}
        >
          {playerStack <= 0 ? '💀 파산...' : won ? '🏆 최종 승리!' : '게임 종료'}
        </motion.h1>
        <p className="game-subtitle">
          최종 골드 — 나 {playerStack.toLocaleString()} · 봇 {botStack.toLocaleString()}
        </p>
        {ownedAugments.length > 0 && (
          <div className="final-augments">
            <span className="final-label">획득한 증강 조합</span>
            <div className="augment-chip-row">
              {ownedAugments.map((a) => (
                <AugmentCard key={a.id} augment={a} compact />
              ))}
            </div>
          </div>
        )}
        <button
          className="gold-btn gold-btn-large"
          onClick={() => {
            sfx.click();
            startGame();
          }}
        >
          다시 하기
        </button>
      </div>
    );
  }

  return (
    <div className="screen room">
      <div className="scanlines" />
      <TopBar />

      <main className="table-area">
        {/* ── 봇 좌석 ── */}
        <section className="seat seat-bot">
          <div className="avatar-wrap">
            <div className={`avatar ${botThinking ? 'avatar-thinking' : ''}`}>🤖</div>
            <AnimatePresence>
              {speechVisible && botSpeech && phase === 'betting' && (
                <motion.div
                  className="speech-bubble"
                  initial={{ opacity: 0, y: 8, scale: 0.85 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                >
                  {botSpeech}
                </motion.div>
              )}
            </AnimatePresence>
            <div className="seat-name">봇</div>
            <div className="seat-gold">{botStack.toLocaleString()} 골드</div>
          </div>
          <div className="seat-cards">
            <div className="card-row">
              {botHole.map((c, i) => (
                <Card key={c.id} card={c} hidden={phase === 'betting'} dealDelay={0.1 + i * 0.12} />
              ))}
            </div>
            {showResult && outcome?.botHand && !outcome.byFold && (
              <motion.div
                className="hand-capsule"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
              >
                {handLabel(outcome.botHand)}
              </motion.div>
            )}
            {streetBets.bot > 0 && <div className="seat-bet">베팅 {streetBets.bot.toLocaleString()}</div>}
          </div>
        </section>

        {/* ── 중앙 보드 ── */}
        <section className="board">
          <div className="pot-capsule">
            <span className="pot-label">POT</span>
            <span className="pot-value">{potDisplay.toLocaleString()} 골드</span>
          </div>
          <div className="card-row board-cards">
            {community.map((c, i) => (
              <Card key={c.id} card={c} dealDelay={i >= community.length - 3 ? (i % 3) * 0.15 : 0} />
            ))}
            {Array.from({ length: 5 - community.length }).map((_, i) => (
              <Card key={`ph-${i}`} />
            ))}
          </div>
        </section>

        {/* ── 플레이어 좌석 ── */}
        <section className="seat seat-player">
          <div className="avatar-wrap">
            <div className="avatar avatar-player">😎</div>
            <div className="seat-name">나</div>
            <div className="seat-gold">{playerStack.toLocaleString()} 골드</div>
          </div>
          <div className="seat-cards">
            <div className="card-row player-cards">
              {playerHole.map((c, i) => (
                <Card
                  key={c.id}
                  card={c}
                  size="lg"
                  dealDelay={0.25 + i * 0.12}
                  clickable={canSwap}
                  onClick={canSwap ? () => swapHoleCard(i) : undefined}
                />
              ))}
              <AnimatePresence>
                {showResult && playerWon && (
                  <motion.div
                    className="win-badge"
                    initial={{ scale: 2.4, opacity: 0, rotate: -10 }}
                    animate={{ scale: 1, opacity: 1, rotate: -6 }}
                    exit={{ opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 15, delay: 0.15 }}
                  >
                    WIN
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {showResult && outcome?.playerHand && !outcome.byFold ? (
              <div className={`hand-capsule ${playerWon ? 'hand-capsule-win' : ''}`}>
                {handLabel(outcome.playerHand)}
                {playerWon && ` +${outcome.payout.toLocaleString()} 골드`}
              </div>
            ) : (
              liveHand && <div className="hand-capsule hand-capsule-live">{handLabel(liveHand)}</div>
            )}
            {canSwap && <div className="swap-hint">🔄 카드를 클릭해 1장 교체 가능</div>}
            {streetBets.player > 0 && (
              <div className="seat-bet">베팅 {streetBets.player.toLocaleString()}</div>
            )}
          </div>
        </section>

        <WinBanner />

        {/* 다음 라운드 버튼 */}
        {showResult && (
          <motion.button
            className="gold-btn next-round-btn"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.1 }}
            onClick={() => {
              sfx.click();
              nextRound();
            }}
          >
            {round >= maxRounds || playerStack <= 0 || botStack <= 0
              ? '최종 결과 보기'
              : '다음 라운드 →'}
          </motion.button>
        )}

        {/* 우하단 도킹: 베팅 그리드 + 로그 패널 */}
        <div className="betting-dock">
          <BettingPanel />
        </div>
        <div className="log-dock">
          <LogPanel />
        </div>
      </main>

      {/* ── 증강 선택 오버레이 ── */}
      <AnimatePresence>
        {phase === 'augment' && (
          <motion.div
            className="augment-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.h2
              className="augment-title"
              initial={{ y: -24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
            >
              라운드 {round} — 증강을 선택하세요
            </motion.h2>
            <div className="augment-choices">
              {augmentChoices.map((a, i) => (
                <motion.div
                  key={a.id}
                  initial={{ y: 60, opacity: 0, rotateY: 40 }}
                  animate={{ y: 0, opacity: 1, rotateY: 0 }}
                  transition={{ delay: 0.15 + i * 0.13, type: 'spring', stiffness: 240, damping: 20 }}
                >
                  <AugmentCard
                    augment={a}
                    onSelect={(id) => {
                      sfx.augment();
                      chooseAugment(id);
                    }}
                  />
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
