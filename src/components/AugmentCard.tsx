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
    return (
      <div className={`augment-chip rarity-${augment.rarity}`} title={augment.description}>
        <span className="augment-chip-icon">{RARITY_ICON[augment.rarity]}</span> {augment.name}
      </div>
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
