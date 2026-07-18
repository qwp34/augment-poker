const NOTCH_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
const RING_RADIUS = 76;
const NOTCH_WIDTH = 22;
const NOTCH_HEIGHT = 11;

/**
 * 카지노 칩 참고 이미지 스타일의 바깥 노치 링.
 * repeating-conic-gradient로 흉내내지 않고, 실제 사각 탭 8개를 각도별로 배치해
 * 링 가장자리에서 바깥으로 살짝 튀어나온 형태를 그대로 재현한다.
 */
export function ChipRing() {
  return (
    <span className="chip-btn-ring" aria-hidden="true">
      {NOTCH_ANGLES.map((angle) => {
        const rad = (angle * Math.PI) / 180;
        const x = Math.sin(rad) * RING_RADIUS;
        const y = -Math.cos(rad) * RING_RADIUS;
        return (
          <span
            key={angle}
            className="chip-btn-notch"
            style={{
              left: `calc(50% + ${x}px - ${NOTCH_WIDTH / 2}px)`,
              top: `calc(50% + ${y}px - ${NOTCH_HEIGHT / 2}px)`,
              transform: `rotate(${angle}deg)`,
            }}
          />
        );
      })}
    </span>
  );
}
