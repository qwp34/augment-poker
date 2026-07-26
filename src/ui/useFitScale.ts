import { useEffect, useRef, useState } from 'react';

/**
 * 고정 크기로 디자인된 콘텐츠(예: 1650×1000 테이블 캔버스)를 실제 뷰포트에 맞춰
 * 균일하게 축소/확대할 배율을 계산한다. 요소 각각을 반응형으로 재배치하는 대신
 * 전체를 하나의 캔버스로 보고 통째로 scale()하므로, 요소 간 상대적 크기 비율이
 * 뷰포트 크기와 무관하게 항상 그대로 유지된다.
 *
 * 자연 크기(스케일 적용 전 레이아웃 크기)는 offsetWidth/offsetHeight로 측정한다 —
 * getBoundingClientRect()와 달리 CSS transform의 영향을 받지 않아, 우리가 건
 * transform:scale() 때문에 측정값이 왜곡되는 피드백 루프를 피할 수 있다.
 */
export function useFitScale<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const recompute = () => {
      const naturalWidth = el.offsetWidth;
      const naturalHeight = el.offsetHeight;
      if (!naturalWidth || !naturalHeight) return;
      const next = Math.min(window.innerWidth / naturalWidth, window.innerHeight / naturalHeight);
      if (Number.isFinite(next) && next > 0) setScale(next);
    };

    recompute();
    window.addEventListener('resize', recompute);
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => {
      window.removeEventListener('resize', recompute);
      ro.disconnect();
    };
  }, []);

  return { ref, scale };
}
