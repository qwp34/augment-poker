/** UI 표시용 포맷 유틸 — 핸드 이름(한게임식 축약), 카드 라벨 */

import type { HandCategory, HandResult } from '../engine/handEvaluator';
import { rankLabel } from '../engine/types';

/** 한게임 포커식 축약 족보 이름 */
export const CATEGORY_SHORT_KO: Record<HandCategory, string> = {
  high_card: '하이카드',
  pair: '원페어',
  two_pair: '투페어',
  three_of_a_kind: '트리플',
  straight: '스트레이트',
  flush: '플러쉬',
  full_house: '풀하우스',
  four_of_a_kind: '포카드',
  straight_flush: '스티플',
  royal_flush: '로티플',
};

/** 승리 리본 배너용 영문 이름 */
export const CATEGORY_EN: Record<HandCategory, string> = {
  high_card: 'HIGH CARD',
  pair: 'ONE PAIR',
  two_pair: 'TWO PAIR',
  three_of_a_kind: 'TRIPLE',
  straight: 'STRAIGHT',
  flush: 'FLUSH',
  full_house: 'FULL HOUSE',
  four_of_a_kind: 'FOUR OF A KIND',
  straight_flush: 'STRAIGHT FLUSH',
  royal_flush: 'ROYAL STRAIGHT FLUSH',
};

/** "[A,K,Q,J,10] 로티플" 형태의 핸드 라벨 */
export function handLabel(result: HandResult): string {
  const ranks = [...result.bestFive]
    .sort((a, b) => b.rank - a.rank)
    .map((c) => rankLabel(c.rank))
    .join(',');
  return `[${ranks}] ${CATEGORY_SHORT_KO[result.category]}`;
}

/** 플러시 이상이면 "빅 핸드" — 리본/콘페티 연출 대상 */
export function isBigHand(category: HandCategory): boolean {
  return ['flush', 'full_house', 'four_of_a_kind', 'straight_flush', 'royal_flush'].includes(category);
}

export function formatGold(n: number): string {
  return `${n.toLocaleString()} 골드`;
}
