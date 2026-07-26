import type { MouseEventHandler, ReactNode } from 'react';
import { useFitScale } from '../ui/useFitScale';

export const STAGE_WIDTH = 1280;
export const STAGE_HEIGHT = 720;

interface StageCanvasProps {
  children: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  clickable?: boolean;
}

/**
 * 타이틀 스플래시(1단계)와 메뉴(2단계)가 공유하는 무대 래퍼.
 * 1280x720 고정 좌표 캔버스를 통째로 scale()해 화면 크기에 맞춰 중앙 배치하므로,
 * 두 화면의 장식 요소 간 상대적 크기·위치 비율이 뷰포트 크기와 무관하게 유지된다.
 */
export function StageCanvas({ children, onClick, clickable }: StageCanvasProps) {
  const { ref, scale } = useFitScale<HTMLDivElement>();

  return (
    <div className={`stage-viewport${clickable ? ' stage-viewport-clickable' : ''}`} onClick={onClick}>
      <div className="stage-backdrop" />
      <div className="stage-vignette" />
      <div
        ref={ref}
        className="stage-canvas"
        style={{
          width: STAGE_WIDTH,
          height: STAGE_HEIGHT,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
