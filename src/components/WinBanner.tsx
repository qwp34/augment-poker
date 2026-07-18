import { useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from '../store/gameStore';
import { CATEGORY_EN, handLabel, isBigHand } from '../ui/format';
import { useCountUp } from '../ui/useCountUp';
import { sfx } from '../ui/sfx';

const CONFETTI_COLORS = ['#f5c542', '#b06ef5', '#4ad9c0', '#e05252', '#f0f0f0'];

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 1.2,
        duration: 2 + Math.random() * 1.6,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        size: 6 + Math.random() * 7,
        rot: Math.random() * 360,
      })),
    [],
  );
  return (
    <div className="confetti-layer">
      {pieces.map((p) => (
        <span
          key={p.id}
          className="confetti"
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.size * 0.6,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            transform: `rotate(${p.rot}deg)`,
          }}
        />
      ))}
    </div>
  );
}

/** 쇼다운 결과 연출 — 빅 핸드는 보라 리본 배너, 그 외엔 컴팩트 토스트 */
export function WinBanner() {
  const phase = useGameStore((s) => s.phase);
  const outcome = useGameStore((s) => s.outcome);
  const round = useGameStore((s) => s.round);

  const show = phase === 'roundResult' && outcome !== null;
  const playerWon = outcome?.winner === 'player';
  const big =
    !!outcome &&
    playerWon &&
    !outcome.byFold &&
    !!outcome.playerHand &&
    (isBigHand(outcome.playerHand.category) || outcome.multiplier > 1);

  const payout = useCountUp(show && playerWon ? outcome.payout : 0, 1100);

  useEffect(() => {
    if (!show) return;
    if (big) sfx.jackpot();
    else if (playerWon) sfx.win();
    else if (outcome?.winner === 'bot') sfx.lose();
  }, [show, big, playerWon, outcome?.winner]);

  if (!show || !outcome) return null;

  // ── 빅 핸드: 보라 리본 잭팟 배너 ──
  if (big && outcome.playerHand) {
    return (
      <AnimatePresence>
        <div className="banner-layer">
          <Confetti />
          <motion.div
            className="ribbon-banner"
            initial={{ scale: 0.3, opacity: 0, rotate: -6 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 16, delay: 0.25 }}
          >
            <div className="ribbon-crown">👑</div>
            <div className="ribbon-royal">Round {round}</div>
            <h2 className="ribbon-title">{CATEGORY_EN[outcome.playerHand.category]}</h2>
            <div className="ribbon-payout">+{payout.toLocaleString()} 골드</div>
            {outcome.appliedAugments.length > 0 && (
              <div className="ribbon-augments">
                {outcome.appliedAugments.map((a) => (
                  <span key={a.id} className={`augment-chip rarity-${a.rarity}`}>
                    ⚡ {a.name} ×{a.effect.value}
                  </span>
                ))}
              </div>
            )}
            <div className="ribbon-jackpot">
              <span className="ribbon-jackpot-label">PAYOUT</span>
              <span className="ribbon-jackpot-value">{payout.toLocaleString()} 골드</span>
            </div>
          </motion.div>
        </div>
      </AnimatePresence>
    );
  }

  // ── 일반 결과: 컴팩트 토스트 ──
  const title = outcome.byFold
    ? playerWon
      ? '상대 다이 — 팟 획득!'
      : '다이 — 팟을 내주었다'
    : playerWon
      ? `승리! +${outcome.payout.toLocaleString()} 골드`
      : outcome.winner === 'tie'
        ? '무승부 — 팟 분배'
        : '패배...';

  return (
    <motion.div
      className={`result-toast ${playerWon ? 'toast-win' : 'toast-lose'}`}
      initial={{ y: -30, opacity: 0, scale: 0.85 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.2 }}
    >
      <strong>{title}</strong>
      {!outcome.byFold && outcome.playerHand && outcome.botHand && (
        <span className="toast-detail">
          나 {handLabel(outcome.playerHand)} vs 봇 {handLabel(outcome.botHand)}
        </span>
      )}
    </motion.div>
  );
}
