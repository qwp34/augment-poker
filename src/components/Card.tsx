import { motion } from 'framer-motion';
import type { Card as CardType } from '../engine/types';
import { SUIT_SYMBOLS, rankLabel } from '../engine/types';

interface CardProps {
  card?: CardType;
  hidden?: boolean;
  size?: 'sm' | 'md' | 'lg';
  clickable?: boolean;
  onClick?: () => void;
  /** 딜링 스태거 연출용 지연 (초) */
  dealDelay?: number;
}

/** 트럼프 카드 — 딜링 진입 애니메이션 + 앞/뒤 플립 */
export function Card({ card, hidden, size = 'md', clickable, onClick, dealDelay = 0 }: CardProps) {
  if (!card) {
    return <div className={`pcard pcard-${size} pcard-placeholder`} />;
  }

  const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
  const faceClasses = [
    'pcard-face',
    'pcard-front',
    isRed ? 'suit-red' : 'suit-black',
    card.isJoker ? 'pcard-joker' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <motion.div
      className={`pcard pcard-${size} ${clickable ? 'pcard-clickable' : ''}`}
      initial={{ y: -46, opacity: 0, scale: 0.6 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      transition={{ delay: dealDelay, type: 'spring', stiffness: 320, damping: 22 }}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
    >
      <div className={`pcard-inner ${hidden ? 'is-flipped' : ''}`}>
        <div className={faceClasses}>
          <span className="pcard-rank">{rankLabel(card.rank)}</span>
          <span className="pcard-pip">{card.isJoker ? '★' : SUIT_SYMBOLS[card.suit]}</span>
          {card.isJoker && <span className="pcard-joker-tag">JOKER</span>}
        </div>
        <div className="pcard-face pcard-back" />
      </div>
    </motion.div>
  );
}
