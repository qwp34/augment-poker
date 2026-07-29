import type { Augment, AugmentRarity } from '../engine/augmentEngine';
import { RARITY_NAMES_KO } from '../engine/augmentEngine';

/** 등급별 아이콘 — 이미지 에셋 없이 희귀도를 한눈에 구분하기 위한 기호 */
const RARITY_ICON: Record<AugmentRarity, string> = {
  silver: '◆',
  gold: '★',
  prismatic: '✦',
};

interface AugmentCardProps {
  augment: Augment;
  onSelect?: (id: string) => void;
  compact?: boolean;
}

/** 증강 선택 카드 — LoL 아레나 스타일 (3장 중 1장, 희귀도 컬러 등급) */
export function AugmentCard({ augment, onSelect, compact }: AugmentCardProps) {
  if (compact) {
    const content = (
      <>
        <span className="augment-chip-icon">{RARITY_ICON[augment.rarity]}</span> {augment.name}
      </>
    );
    // onSelect가 있을 때만(예: 좌석 증강 뱃지 클릭 → 설명 팝업) 실제 버튼으로 렌더한다 —
    // 그 외(최종 결산 화면 등 단순 진열용)는 예전처럼 클릭 불가능한 표시 전용 칩으로 유지한다.
    if (!onSelect) {
      return (
        <div className={`augment-chip rarity-${augment.rarity}`} title={augment.description}>
          {content}
        </div>
      );
    }
    return (
      <button
        type="button"
        className={`augment-chip augment-chip-btn rarity-${augment.rarity}`}
        title={augment.description}
        onClick={() => onSelect(augment.id)}
      >
        {content}
      </button>
    );
  }

  return (
    <button className={`augment-card rarity-${augment.rarity}`} onClick={() => onSelect?.(augment.id)}>
      <span className="augment-rarity">{RARITY_NAMES_KO[augment.rarity]}</span>
      <h3 className="augment-name">{augment.name}</h3>
      <p className="augment-desc">{augment.description}</p>
    </button>
  );
}
