import type { ReactNode } from 'react';
import { StageCanvas } from './StageCanvas';

interface MenuStageProps {
  children: ReactNode;
}

interface ScatterChip {
  left: number;
  top: number;
  size: number;
  variant: 'gold' | 'red' | 'black';
  rot: number;
}

const BOTTOM_LEFT_CHIPS: ScatterChip[] = [
  { left: 46, top: 560, size: 64, variant: 'gold', rot: -18 },
  { left: 120, top: 610, size: 78, variant: 'red', rot: 10 },
  { left: 60, top: 490, size: 54, variant: 'black', rot: 24 },
  { left: 190, top: 540, size: 60, variant: 'red', rot: -6 },
  { left: 200, top: 630, size: 48, variant: 'gold', rot: 30 },
];

interface FanCardSpec {
  rank: string;
  suit: string;
  color: 'black' | 'red';
  left: number;
  top: number;
  rot: number;
}

const RIGHT_FAN: FanCardSpec[] = [
  { rank: 'A', suit: '♠', color: 'black', left: 1000, top: 150, rot: -18 },
  { rank: 'K', suit: '♥', color: 'red', left: 1075, top: 128, rot: -6 },
  { rank: 'Q', suit: '♦', color: 'red', left: 1150, top: 128, rot: 6 },
  { rank: 'J', suit: '♣', color: 'black', left: 1225, top: 150, rot: 18 },
];

/** 2단계: 게임 시작 / 멀티플레이 버튼 화면 — 좌하단 칩 장식 + 우측 카드 부채꼴 + 중앙 버튼 2개. */
export function MenuStage({ children }: MenuStageProps) {
  return (
    <StageCanvas>
      <div className="title-splash-fx" aria-hidden="true">
        {BOTTOM_LEFT_CHIPS.map((c, i) => (
          <div
            key={`scatter-chip-${i}`}
            className={`title-chip title-chip-${c.variant}`}
            style={{ left: c.left, top: c.top, width: c.size, height: c.size, transform: `rotate(${c.rot}deg)` }}
          />
        ))}

        {RIGHT_FAN.map((c, i) => (
          <div
            key={`right-fan-${i}`}
            className={`fan-card fan-card-${c.color}`}
            style={{ left: c.left, top: c.top, transform: `rotate(${c.rot}deg)` }}
          >
            <span className="fan-card-rank">{c.rank}</span>
            <span className="fan-card-suit">{c.suit}</span>
            <span className="fan-card-center">{c.suit}</span>
          </div>
        ))}
      </div>

      <div className="menu-buttons">{children}</div>
    </StageCanvas>
  );
}
