import { useMemo, type CSSProperties } from 'react';
import { StageCanvas } from './StageCanvas';

interface TitleSplashProps {
  /** 로그인 완료 상태에서만 쓰인다 — 아무 곳이나 클릭하면 2단계 메뉴로 전환 */
  onEnter: () => void;
  /** 로그인 여부 — false면 클릭-입장 대신 로그인 버튼을 보여주고, 클릭 자체를 막는다 */
  loggedIn: boolean;
  /** 로그인 버튼 클릭 시 로그인/회원가입 모달을 띄우기 위한 콜백 */
  onLoginClick: () => void;
}

const FRAME_LEFT = 320;
const FRAME_TOP = 265;
const FRAME_W = 640;
const FRAME_H = 190;

interface BulbItem {
  id: number;
  style: CSSProperties;
}

/** 네온 액자 안쪽 판 둘레를 따라 도는 전구 위치 계산 */
function buildFrameBulbs(): BulbItem[] {
  const width = FRAME_W - 18;
  const height = FRAME_H - 18;
  const spacing = 26;
  const inset = 8;
  const points: [number, number][] = [];
  for (let x = inset; x <= width - inset; x += spacing) {
    points.push([x, inset]);
    points.push([x, height - inset]);
  }
  for (let y = inset + spacing; y <= height - inset - spacing; y += spacing) {
    points.push([inset, y]);
    points.push([width - inset, y]);
  }
  return points.map((pt, i) => ({ id: i, style: { left: pt[0], top: pt[1] } }));
}

interface AceCard {
  suit: string;
  color: 'black' | 'red';
  dx: number;
  top: number;
  rot: number;
}

const ACE_FAN: AceCard[] = [
  { suit: '♠', color: 'black', dx: -195, top: 185, rot: -22 },
  { suit: '♣', color: 'black', dx: -65, top: 153, rot: -7 },
  { suit: '♦', color: 'red', dx: 65, top: 153, rot: 7 },
  { suit: '♥', color: 'red', dx: 195, top: 185, rot: 22 },
];

interface SideChip {
  left: number;
  top: number;
  size: number;
  variant: 'gold' | 'red' | 'black';
  rot: number;
}

const SIDE_CHIPS: SideChip[] = [
  { left: 150, top: 325, size: 70, variant: 'red', rot: -12 },
  { left: 225, top: 275, size: 86, variant: 'gold', rot: 8 },
  { left: 969, top: 275, size: 86, variant: 'gold', rot: -8 },
  { left: 1060, top: 325, size: 70, variant: 'black', rot: 12 },
];

interface MiniCard {
  rank: string;
  suit: string;
  color: 'black' | 'red';
  left: number;
  top: number;
  rot: number;
}

const RIGHT_MINI_FAN: MiniCard[] = [
  { rank: 'K', suit: '♠', color: 'black', left: 986, top: 480, rot: -14 },
  { rank: 'Q', suit: '♥', color: 'red', left: 1058, top: 508, rot: 2 },
  { rank: 'J', suit: '♣', color: 'black', left: 1130, top: 480, rot: 14 },
];

const RIGHT_FALL_CHIPS: { left: number; top: number; variant: 'gold' | 'red' | 'black'; fallClass: string }[] = [
  { left: 950, top: 410, variant: 'gold', fallClass: 'chip-fall-1' },
  { left: 1060, top: 390, variant: 'red', fallClass: 'chip-fall-2' },
  { left: 1160, top: 430, variant: 'black', fallClass: 'chip-fall-3' },
];

/**
 * 1단계: 앱 최초 진입 화면 — 아무 곳이나 클릭하면 2단계(메뉴) 화면으로 전환된다.
 * 레이어 순서(아래→위): 배경 장식(칩/카드) < 에이스 카드 < 네온 액자 < 스포트라이트.
 * 카드가 액자 뒤에서 살짝 삐져나오고, 스포트라이트는 반투명하게 맨 위에서 전체를 은은히 덮는다.
 */
export function TitleSplash({ onEnter, loggedIn, onLoginClick }: TitleSplashProps) {
  const bulbs = useMemo(buildFrameBulbs, []);

  return (
    <StageCanvas onClick={loggedIn ? onEnter : undefined} clickable={loggedIn}>
      <div className="title-splash-fx" aria-hidden="true">
        {SIDE_CHIPS.map((c, i) => (
          <div
            key={`side-chip-${i}`}
            className={`title-chip title-chip-${c.variant}`}
            style={{ left: c.left, top: c.top, width: c.size, height: c.size, transform: `rotate(${c.rot}deg)` }}
          />
        ))}

        {RIGHT_MINI_FAN.map((c, i) => (
          <div
            key={`mini-card-${i}`}
            className={`fan-card fan-card-sm fan-card-${c.color}`}
            style={{ left: c.left, top: c.top, transform: `rotate(${c.rot}deg)` }}
          >
            <span className="fan-card-rank">{c.rank}</span>
            <span className="fan-card-suit">{c.suit}</span>
            <span className="fan-card-center">{c.suit}</span>
          </div>
        ))}

        {RIGHT_FALL_CHIPS.map((c, i) => (
          <div
            key={`fall-chip-${i}`}
            className={`title-chip title-chip-${c.variant} ${c.fallClass}`}
            style={{ left: c.left, top: c.top }}
          />
        ))}
      </div>

      {/* 에이스 카드 — 액자보다 아래 레이어. 액자에 가려 위쪽 절반만 삐져나온다 */}
      <div className="ace-fan-layer">
        {ACE_FAN.map((c, i) => (
          <div
            key={`ace-${i}`}
            className={`fan-card fan-card-${c.color}`}
            style={{ left: 640 + c.dx - 54, top: c.top, transform: `rotate(${c.rot}deg)` }}
          >
            <span className="fan-card-rank">A</span>
            <span className="fan-card-suit">{c.suit}</span>
            <span className="fan-card-center">{c.suit}</span>
          </div>
        ))}
      </div>

      {/* 네온 액자 — 카드보다 위 레이어 */}
      <div
        className="neon-frame"
        style={{ left: FRAME_LEFT, top: FRAME_TOP, width: FRAME_W, height: FRAME_H }}
      >
        <div className="neon-frame-inner">
          <div className="neon-bulb-layer" aria-hidden="true">
            {bulbs.map((b) => (
              <span key={b.id} className="neon-bulb" style={b.style} />
            ))}
          </div>
          <h1 className="neon-title">증강포커</h1>
        </div>
      </div>

      {loggedIn ? (
        <p className="title-splash-hint">시작하려면 아무곳이나 클릭하세요</p>
      ) : (
        <button
          type="button"
          className="gold-btn title-splash-login-btn"
          onClick={(e) => {
            e.stopPropagation();
            onLoginClick();
          }}
        >
          로그인
        </button>
      )}

      {/* 스포트라이트 — 반투명, 모든 요소 위 최상단 레이어 */}
      <div className="spotlight" aria-hidden="true" />
    </StageCanvas>
  );
}
