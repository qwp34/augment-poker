/** 내 승률 표시 캡슐 — 기존 족보 캡슐 옆에 붙는다 */

import { useCountUp } from '../ui/useCountUp';
import { equityToPerMille, formatPerMille } from '../ui/useLiveEquity';

/** 승률을 "승률 63.2%" 형태로 보여준다. equity가 null이면 아무것도 그리지 않는다. */
export function EquityBadge({ equity }: { equity: number | null }) {
  // 훅 호출 순서를 지키기 위해 숨기는 경우에도 항상 호출한다.
  const perMille = useCountUp(equity === null ? 0 : equityToPerMille(equity));
  if (equity === null) return null;
  return <span className="equity-capsule">승률 {formatPerMille(perMille)}</span>;
}
