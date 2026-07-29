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
  /** 증강 효과로 이 카드가 방금 바뀐 순간 — 글로우 + 플립 펄스를 잠깐 재생한다 */
  changeFx?: boolean;
  /** 현재(또는 쇼다운) 최고 족보를 구성하는 카드 — 은은한 골드 하이라이트를 계속 표시 */
  highlight?: boolean;
}

/** 트럼프 카드 — 딜링 진입 애니메이션 + 앞/뒤 플립 */
export function Card({
  card,
  hidden,
  size = 'md',
  clickable,
  onClick,
  dealDelay = 0,
  changeFx,
  highlight,
}: CardProps) {
  // 카드 자체가 아직 없고(딜링 전) 뒷면 표시도 아니면 빈 자리 플레이스홀더.
  // hidden(다른 플레이어의 비공개 카드)은 실제 카드 데이터 없이도 뒷면만 그리면 되므로 여기 해당 없음.
  if (!card && !hidden) {
    return <div className={`pcard pcard-${size} pcard-placeholder`} />;
  }

  const isRed = !!card && (card.suit === 'hearts' || card.suit === 'diamonds');
  const faceClasses = [
    'pcard-face',
    'pcard-front',
    isRed ? 'suit-red' : 'suit-black',
    card?.isJoker ? 'pcard-joker' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // 뒷면(다른 플레이어의 비공개 카드)이 바뀐 경우엔 플립 애니메이션을 재생하지 않는다 —
  // 회전 도중 반대쪽 면이 잠깐 노출돼 실제 카드처럼 오인될 수 있어서, 뒷면일 때는 글로우만
  // 재생해 "이 자리 카드가 바뀌었다"는 신호만 안전하게 전달한다.
  const changeFxClass = changeFx ? (hidden ? 'pcard-changefx-glow' : 'pcard-changefx-flip') : '';

  return (
    <motion.div
      className={`pcard pcard-${size} ${clickable ? 'pcard-clickable' : ''} ${highlight ? 'pcard-highlight-hand' : ''}`}
      initial={{ y: -46, opacity: 0, scale: 0.6 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      transition={{ delay: dealDelay, type: 'spring', stiffness: 320, damping: 22 }}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
    >
      <div
        className={`pcard-inner ${hidden ? 'is-flipped' : ''} ${changeFxClass}`}
        style={{ '--base-rotate': hidden ? '180deg' : '0deg' } as React.CSSProperties}
      >
        {/* 뒷면 상태에서는 실제 카드값을 아예 렌더링하지 않는다 — 플립 전용 CSS(backface-visibility)가
            어떤 이유로든 실패하더라도 화면에 노출될 카드 정보 자체가 DOM에 없도록 이중으로 방지한다. */}
        {!hidden && card && (
          <div className={faceClasses}>
            <span className="pcard-rank">{rankLabel(card.rank)}</span>
            <span className="pcard-pip">{card.isJoker ? '★' : SUIT_SYMBOLS[card.suit]}</span>
            {card.isJoker && <span className="pcard-joker-tag">JOKER</span>}
          </div>
        )}
        <div className="pcard-face pcard-back" />
      </div>
    </motion.div>
  );
}
