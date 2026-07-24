import { useMemo, type CSSProperties } from 'react';
import { motion } from 'framer-motion';

interface FanCard {
  rank: string;
  suit: string;
  color: 'red' | 'black';
  left: string;
  offsetY: number;
  rot: number;
}

const FAN_CARDS: FanCard[] = [
  { rank: 'A', suit: '♠', color: 'black', left: '4%', offsetY: 14, rot: -22 },
  { rank: 'A', suit: '♣', color: 'black', left: '28%', offsetY: -4, rot: -7 },
  { rank: 'A', suit: '♦', color: 'red', left: '52%', offsetY: -4, rot: 7 },
  { rank: 'A', suit: '♥', color: 'red', left: '76%', offsetY: 14, rot: 22 },
];

interface Bulb {
  id: number;
  style: CSSProperties;
  variant: 'a' | 'b';
}

/** 마퀴 프레임 테두리를 따라 도는 전구 위치 계산 — 사각형 둘레를 %좌표로 균등 분할 */
function buildBulbs(): Bulb[] {
  const top = 11;
  const side = 4;
  const bottom = 11;
  const points: { x: number; y: number }[] = [];

  for (let i = 0; i < top; i++) points.push({ x: (i / (top - 1)) * 100, y: 0 });
  for (let i = 1; i <= side; i++) points.push({ x: 100, y: (i / (side + 1)) * 100 });
  for (let i = 0; i < bottom; i++) points.push({ x: 100 - (i / (bottom - 1)) * 100, y: 100 });
  for (let i = 1; i <= side; i++) points.push({ x: 0, y: 100 - (i / (side + 1)) * 100 });

  return points.map((p, i) => ({
    id: i,
    variant: i % 2 === 0 ? 'a' : 'b',
    style: {
      left: `${p.x}%`,
      top: `${p.y}%`,
      animationDelay: `${(i % 6) * 0.1}s`,
    },
  }));
}

/**
 * 타이틀 화면 상단 — 카지노 간판(마퀴) 스타일 장식 블록.
 * 전구 테두리 + 에이스 4장 부채꼴 + 금화 장식은 전부 시각적 장식이며,
 * 실제 타이틀 텍스트("증강포커")만 렌더링한다. 버튼/로직은 App.tsx 쪽에서 그대로 유지.
 */
export function TitleMarquee() {
  const bulbs = useMemo(buildBulbs, []);

  return (
    <motion.div
      className="title-marquee-wrap"
      initial={{ y: -40, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 18 }}
    >
      <div className="marquee-fan-cards" aria-hidden="true">
        {FAN_CARDS.map((c, i) => (
          <div
            key={i}
            className={`fan-card fan-card-${c.color}`}
            style={{ left: c.left, transform: `translateY(${c.offsetY}px) rotate(${c.rot}deg)` }}
          >
            <span className="fan-card-rank">{c.rank}</span>
            <span className="fan-card-suit">{c.suit}</span>
            <span className="fan-card-center">{c.suit}</span>
          </div>
        ))}
      </div>

      <div className="marquee-frame">
        <div className="marquee-bulb-layer" aria-hidden="true">
          {bulbs.map((b) => (
            <span key={b.id} className={`marquee-bulb marquee-bulb-${b.variant}`} style={b.style} />
          ))}
        </div>
        <h1 className="game-title neon-title marquee-title">증강포커</h1>

        <div className="marquee-coin marquee-coin-left" aria-hidden="true">
          <span className="coin-circle">
            <span className="coin-circle-glyph">♠</span>
          </span>
          <span className="coin-circle">
            <span className="coin-circle-glyph">♥</span>
          </span>
        </div>
        <div className="marquee-coin marquee-coin-right" aria-hidden="true">
          <span className="coin-circle">
            <span className="coin-circle-glyph">♦</span>
          </span>
          <span className="coin-circle">
            <span className="coin-circle-glyph">♣</span>
          </span>
        </div>
      </div>
    </motion.div>
  );
}
