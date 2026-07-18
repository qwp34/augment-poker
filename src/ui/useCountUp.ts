import { useEffect, useRef, useState } from 'react';

/** 숫자 변경 시 이징 카운트업 애니메이션 (골드/팟 연출용) */
export function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(target);
  const prev = useRef(target);

  useEffect(() => {
    const from = prev.current;
    prev.current = target;
    if (from === target) return;

    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}
