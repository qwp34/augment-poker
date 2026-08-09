import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from './store/gameStore';
import { useAuthStore } from './store/authStore';
import { isSupabaseConfigured } from './lib/supabaseClient';
import { Card } from './components/Card';
import { AugmentCard } from './components/AugmentCard';
import { BettingPanel } from './components/BettingPanel';
import { WinBanner } from './components/WinBanner';
import { TopBar } from './components/TopBar';
import { LogPanel } from './components/LogPanel';
import { MultiplayerLobby } from './components/MultiplayerLobby';
import { TitleSplash } from './components/TitleSplash';
import { MenuStage } from './components/MenuStage';
import { ChipButton } from './components/ChipButton';
import { AuthModal } from './components/AuthModal';
import { SettingsPanel } from './components/SettingsPanel';
import { findByEffect } from './engine/augmentEngine';
import { evaluateBest } from './engine/handEvaluator';
import { handLabel } from './ui/format';
import { useCountUp } from './ui/useCountUp';
import { sfx } from './ui/sfx';
import { getRoomIdFromPath } from './net/colyseusClient';
import './App.css';

export default function App() {
  // 1단계(타이틀 스플래시) / 2단계(게임 시작·멀티플레이 메뉴) 전환 상태
  const [stage, setStage] = useState<'title' | 'menu'>('title');
  const [started, setStarted] = useState(false);
  // 공유 링크(/room/:roomId)로 들어온 경우 곧바로 멀티플레이 로비를 연다
  const [multiplayerOpen, setMultiplayerOpen] = useState(() => !!getRoomIdFromPath());
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const authUser = useAuthStore((s) => s.user);
  const authProfile = useAuthStore((s) => s.profile);
  const authInit = useAuthStore((s) => s.init);
  const authSignOut = useAuthStore((s) => s.signOut);
  const authGuest = useAuthStore((s) => s.guest);
  const startGuest = useAuthStore((s) => s.startGuest);
  const clearGuest = useAuthStore((s) => s.clearGuest);

  // 솔로/멀티 모두 로그인 필수 — 예외는 두 가지: ①Supabase가 아예 설정 안 된 개발
  // 환경(isSupabaseConfigured false), ②"게스트로 시작"으로 로컬 게스트 유저를 만든 경우.
  // 게스트는 Supabase 세션이 전혀 없으므로 멀티플레이 입장 시 accessToken도 보내지
  // 않는다 — 서버가 항상 게스트로 취급해 칩 차감/정산(DB 저장)을 전부 건너뛴다.
  const canEnterGame = !isSupabaseConfigured || !!authUser || !!authGuest;

  // Supabase 세션 복원/구독은 앱 전체에서 딱 한 번만 연결한다
  useEffect(() => {
    authInit();
  }, [authInit]);

  // 공유 링크(/room/:roomId)로 들어왔는데 아직 로그인 전이면, 방으로 바로 들여보내는 대신
  // 타이틀 화면(로그인 버튼)을 먼저 보여주고 로그인 모달을 자동으로 띄운다 — 로그인이
  // 끝나 canEnterGame이 true가 되는 순간 아래 멀티플레이 진입 분기가 다시 평가되어
  // 별도 조작 없이 곧바로 그 방으로 들어간다.
  useEffect(() => {
    if (multiplayerOpen && !canEnterGame) setAuthModalOpen(true);
  }, [multiplayerOpen, canEnterGame]);

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

  // 족보를 구성하는 카드 5장 하이라이트 — 진행 중엔 실시간 최고 족보, 결과 화면에선 실제 판정 결과를 사용
  const playerBestFiveIds = useMemo(() => {
    const hand = showResult ? outcome?.playerHand : liveHand;
    return hand ? new Set(hand.bestFive.map((c) => c.id)) : null;
  }, [showResult, outcome?.playerHand, liveHand]);
  const botBestFiveIds = useMemo(() => {
    if (!showResult || !outcome?.botHand) return null;
    return new Set(outcome.botHand.bestFive.map((c) => c.id));
  }, [showResult, outcome?.botHand]);

  const closeMultiplayer = () => {
    window.history.pushState(null, '', '/');
    setMultiplayerOpen(false);
  };

  // ── 멀티플레이 로비 (링크 공유 입장 / 방 생성) — 로그인 전이면 아래 타이틀 화면으로
  // 흘려보내 로그인부터 시키고, canEnterGame이 true가 되는 순간 여기서 바로 입장시킨다 ──
  if (multiplayerOpen && canEnterGame) {
    return <MultiplayerLobby onClose={closeMultiplayer} />;
  }

  // ── 1단계(타이틀 스플래시) / 2단계(게임 시작·멀티플레이 메뉴) — 0.55초 페이드 전환 ──
  if (stage === 'title' || !started) {
    return (
      <>
        <AnimatePresence>
          {stage === 'title' ? (
            <motion.div
              key="title"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.55 }}
            >
              <TitleSplash
                loggedIn={canEnterGame}
                onEnter={() => {
                  sfx.click();
                  setStage('menu');
                }}
                onLoginClick={() => {
                  sfx.click();
                  setAuthModalOpen(true);
                }}
                onGuestClick={() => {
                  sfx.click();
                  startGuest();
                  // 게스트는 별도 확인 절차가 없으니 로그인 모달 대신 바로 2단계로 진입
                  setStage('menu');
                }}
              />
            </motion.div>
          ) : (
            <motion.div
              key="menu"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.55 }}
            >
              <button
                type="button"
                className="back-to-title-btn"
                onClick={() => {
                  sfx.click();
                  setStage('title');
                }}
              >
                ← 타이틀로 돌아가기
              </button>

              <SettingsPanel
                profileLabel={
                  authUser && authProfile
                    ? `${authProfile.nickname} · ${authProfile.chips.toLocaleString()} 골드`
                    : authGuest
                      ? `${authGuest.nickname} (게스트) · ${authGuest.chips.toLocaleString()} 골드`
                      : undefined
                }
                chips={authUser && authProfile ? authProfile.chips : authGuest ? authGuest.chips : undefined}
                onLogout={() => {
                  if (authUser) authSignOut();
                  if (authGuest) clearGuest();
                  // 로그아웃하면 타이틀(1단계) 비로그인 상태로 돌아간다
                  setStage('title');
                }}
              />

              <MenuStage>
                <ChipButton
                  title="게임 시작"
                  subtitle="혼자서 플레이"
                  onClick={() => {
                    sfx.click();
                    startGame();
                    setStarted(true);
                  }}
                />
                <ChipButton
                  title="멀티플레이"
                  subtitle="친구와 함께"
                  onClick={() => setMultiplayerOpen(true)}
                />
              </MenuStage>
            </motion.div>
          )}
        </AnimatePresence>
        {authModalOpen && <AuthModal onClose={() => setAuthModalOpen(false)} />}
      </>
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
                <Card
                  key={c.id}
                  card={c}
                  hidden={phase === 'betting'}
                  dealDelay={0.1 + i * 0.12}
                  highlight={!!botBestFiveIds?.has(c.id)}
                />
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
              <Card
                key={c.id}
                card={c}
                dealDelay={i >= community.length - 3 ? (i % 3) * 0.15 : 0}
                highlight={!!(playerBestFiveIds?.has(c.id) || botBestFiveIds?.has(c.id))}
              />
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
                  highlight={!!playerBestFiveIds?.has(c.id)}
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
