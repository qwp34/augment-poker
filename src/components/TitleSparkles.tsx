import { useMemo } from 'react';

/** LED 간판 느낌의 반짝이 팔레트 — 빨강/초록/파랑 + 우리 테마 골드/화이트 */
const SPARKLE_COLORS = ['#ff5252', '#4ad9c0', '#5b8cff', '#f5c542', '#ffffff'];

interface SparkleDot {
  left: string;
  top: string;
  color: string;
  size: number;
  delay: number;
  duration: number;
}

/** 타이틀 프레임 바깥 둘레(위/아래/좌/우 변)를 따라 점 위치를 흩어 놓는다 — 글자 위에는 안 찍음 */
function buildSparkles(): SparkleDot[] {
  const edgePositions: { left: number; top: number }[] = [];
  const topCount = 8;
  const bottomCount = 8;
  const sideCount = 3;

  for (let i = 0; i < topCount; i++) {
    edgePositions.push({ left: (i / (topCount - 1)) * 100, top: -20 });
  }
  for (let i = 0; i < bottomCount; i++) {
    edgePositions.push({ left: (i / (bottomCount - 1)) * 100, top: 120 });
  }
  for (let i = 0; i < sideCount; i++) {
    const t = ((i + 1) / (sideCount + 1)) * 100;
    edgePositions.push({ left: -10, top: t });
    edgePositions.push({ left: 110, top: t });
  }

  return edgePositions.map((pos, i) => ({
    left: `${pos.left}%`,
    top: `${pos.top}%`,
    color: SPARKLE_COLORS[i % SPARKLE_COLORS.length],
    size: 5 + Math.random() * 4,
    delay: Math.random() * 2,
    duration: 1.1 + Math.random() * 1.2,
  }));
}

/**
 * LED 간판처럼 타이틀 둘레를 따라 무작위로 깜빡이는 점들.
 * 텍스트 가독성을 해치지 않도록 프레임 바깥쪽(음수/100% 초과 좌표)에만 배치한다.
 */
export function TitleSparkles() {
  const sparkles = useMemo(buildSparkles, []);

  return (
    <div className="title-sparkle-layer" aria-hidden="true">
      {sparkles.map((s, i) => (
        <span
          key={i}
          className="title-sparkle-dot"
          style={{
            left: s.left,
            top: s.top,
            width: s.size,
            height: s.size,
            background: s.color,
            boxShadow: `0 0 6px ${s.color}, 0 0 12px ${s.color}`,
            animationDelay: `${s.delay}s`,
            animationDuration: `${s.duration}s`,
          }}
        />
      ))}
    </div>
  );
}
