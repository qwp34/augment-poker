import { useMemo, type CSSProperties } from 'react';

interface NotchItem {
  id: number;
  style: CSSProperties;
}

/** 버튼 테두리의 금속 노치 8개를 45도 간격으로 배치 */
function buildNotches(): NotchItem[] {
  return Array.from({ length: 8 }, (_, i) => ({
    id: i,
    style: {
      transform: `translate(-50%, -50%) rotate(${i * 45}deg) translateY(-170px)`,
    },
  }));
}

interface ChipButtonProps {
  title: string;
  subtitle: string;
  onClick: () => void;
}

/** 2단계 메뉴 화면의 원형 칩 버튼 — 호버 시 확대 + 골드 링 글로우 + 스포트라이트 페이드인. */
export function ChipButton({ title, subtitle, onClick }: ChipButtonProps) {
  const notches = useMemo(buildNotches, []);

  return (
    <button type="button" className="chip-btn" onClick={onClick}>
      <span className="btn-spot" aria-hidden="true" />
      <span className="chip-btn-notches" aria-hidden="true">
        {notches.map((n) => (
          <span key={n.id} className="chip-btn-notch" style={n.style} />
        ))}
      </span>
      <span className="chip-btn-dashring" aria-hidden="true" />
      <span className="chip-btn-text">
        <span className="chip-btn-title">{title}</span>
        <span className="chip-btn-pill">{subtitle}</span>
      </span>
    </button>
  );
}
