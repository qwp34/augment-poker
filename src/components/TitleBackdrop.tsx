import { useMemo, type CSSProperties } from 'react';

const SUITS = ['♠', '♥', '♦', '♣'];
const DECO_COLORS = ['rgba(217,166,46,0.85)', 'rgba(220,232,255,0.8)', 'rgba(140,180,255,0.8)'];

interface Deco {
  id: number;
  style: CSSProperties;
  char: string;
}

/** 화면 전체에 은은하게 흩뿌려진 카드무늬 장식 — 순전히 배경 장식용, 클릭/상태와 무관 */
function buildDecor(): Deco[] {
  const spots: [number, number][] = [
    [4, 8], [14, 24], [7, 46], [12, 70], [4, 90],
    [30, 6], [50, 3], [70, 6], [90, 8],
    [92, 26], [95, 48], [90, 70], [93, 88],
    [30, 92], [66, 93], [22, 55], [78, 55],
    [18, 14], [82, 14], [50, 96],
  ];
  return spots.map((pt, i) => {
    const x = pt[0] + (Math.random() * 3 - 1.5);
    const y = pt[1] + (Math.random() * 3 - 1.5);
    const rot = Math.floor(Math.random() * 70 - 35);
    const op = (0.08 + Math.random() * 0.08).toFixed(2);
    const size = 26 + Math.floor(Math.random() * 34);
    return {
      id: i,
      char: SUITS[i % SUITS.length],
      style: {
        left: `${x}%`,
        top: `${y}%`,
        fontSize: size,
        color: DECO_COLORS[i % DECO_COLORS.length],
        opacity: Number(op),
        transform: `rotate(${rot}deg)`,
      },
    };
  });
}

/** 타이틀 화면 맨 뒤에 깔리는 은은한 카드무늬/반짝임 배경 레이어 */
export function TitleBackdrop() {
  const decor = useMemo(buildDecor, []);

  return (
    <div className="title-backdrop" aria-hidden="true">
      {decor.map((d) => (
        <span key={d.id} className="backdrop-suit" style={d.style}>
          {d.char}
        </span>
      ))}
    </div>
  );
}
