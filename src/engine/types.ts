/** 카드/게임 공통 타입 정의 */

export type Suit = 'spades' | 'hearts' | 'diamonds' | 'clubs';

/** 2~10, J=11, Q=12, K=13, A=14 */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  id: string;
  suit: Suit;
  rank: Rank;
  /** 황금 뒤집개 증강: 모든 무늬로 인정되는 조커 카드 */
  isJoker?: boolean;
}

export const SUITS: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];

export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export const SUIT_SYMBOLS: Record<Suit, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
};

export function rankLabel(rank: Rank): string {
  if (rank === 14) return 'A';
  if (rank === 13) return 'K';
  if (rank === 12) return 'Q';
  if (rank === 11) return 'J';
  return String(rank);
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export type GamePhase =
  | 'augment'      // 라운드 시작 전 증강 선택
  | 'betting'      // 베팅 진행 중 (street 필드로 세부 구분)
  | 'showdown'     // 쇼다운 연출
  | 'roundResult'  // 라운드 결과 확인
  | 'gameOver';    // 최종 결과
