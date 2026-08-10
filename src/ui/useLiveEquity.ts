/**
 * 내 승률(에퀴티) 실시간 계산 훅.
 *
 * 보안: 계산에 들어가는 카드는 "내 홀카드 + 공개된 커뮤니티 카드"뿐이다.
 * 상대 홀카드는 서버가 쇼다운 전까지 클라이언트에 보내지 않으며, 여기서도
 * 절대 요구하지 않는다 — 상대는 오직 "몇 명 남았는가"라는 공개 정보로만 쓰인다.
 */

import { useMemo } from 'react';
import { calculateEquity } from '../engine/equity';
import type { Card, Rank, Suit } from '../engine/types';

/** 표시용 롤아웃 횟수 — 봇 판단(1200)보다 낮게 잡아 렌더 부담을 줄인다 */
export const EQUITY_DISPLAY_ITERATIONS = 800;

/** 싱글(engine Card)·멀티(ClientCard) 양쪽을 함께 받기 위한 최소 형태 */
export interface EquityCard {
  suit: string;
  rank: number;
  isJoker?: boolean;
}

/**
 * 엔진 덱과 같은 id 체계(`${suit}-${rank}`)로 맞춘다.
 *
 * 멀티플레이 서버는 카드 id에 핸드 번호를 붙여(`spades-8#3`) 내려주는데,
 * calculateEquity는 createDeck()이 만든 id로 제외 카드를 거른다. 서버 id를 그대로
 * 넘기면 어느 것도 매칭되지 않아 내 카드가 덱에 남고, 롤아웃에서 상대에게 같은
 * 카드가 다시 배분된다. 그래서 실제 무늬·랭크로 id를 다시 만들어 넘긴다.
 *
 * (카멜레온·황금 뒤집개로 변형된 카드가 다른 카드와 무늬·랭크까지 같아지면 제외가
 *  한 장으로 합쳐질 수 있으나, 표시용 추정치라 그대로 둔다.)
 */
export function toDeckCard(card: EquityCard): Card {
  return {
    id: `${card.suit}-${card.rank}`,
    suit: card.suit as Suit,
    rank: card.rank as Rank,
    isJoker: card.isJoker,
  };
}

function cardsKey(cards: EquityCard[]): string {
  return cards.map((c) => `${c.suit}-${c.rank}${c.isJoker ? 'J' : ''}`).join(',');
}

/**
 * 내 승률(0~1). 표시할 수 없는 상황이면 null.
 *
 * @param enabled 표시 조건(홀카드 수신·미폴드·쇼다운 이전)을 호출부가 판정해 넘긴다.
 */
export function useLiveEquity(
  hole: EquityCard[],
  board: EquityCard[],
  opponents: number,
  enabled: boolean,
): number | null {
  // 홀카드·보드·상대 수가 실제로 바뀔 때만 롤아웃을 다시 돌리기 위한 키.
  const key = enabled ? `${opponents}|${cardsKey(hole)}|${cardsKey(board)}` : '';

  return useMemo(() => {
    if (!key) return null;
    try {
      return calculateEquity({
        hole: hole.map(toDeckCard),
        board: board.map(toDeckCard),
        opponents,
        iterations: EQUITY_DISPLAY_ITERATIONS,
      }).equity;
    } catch {
      // 대풍년(홀카드 3장)처럼 calculateEquity가 다루지 못하는 입력은 표시하지 않는다.
      return null;
    }
    // key에만 의존하는 것은 의도적이다 — 매 렌더마다 롤아웃을 돌리지 않기 위해서다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * 카운트업용 정수 스케일. useCountUp이 정수만 다루므로 천분율로 올린다
 * (0.632 → 632). 10으로 나누면 소수점 첫째 자리까지 남는다.
 */
export function equityToPerMille(equity: number): number {
  return Math.round(equity * 1000);
}

/** 천분율을 "63.2%" 형태로 — 소수점 첫째 자리까지만 */
export function formatPerMille(perMille: number): string {
  return `${(perMille / 10).toFixed(1)}%`;
}

/**
 * 상대 수 — 자신을 제외하고 아직 폴드하지 않은 플레이어.
 * 서버 PokerRoom.liveOpponentCount와 같은 기준을 쓴다(올인은 쇼다운까지 남으므로 포함).
 * 계산에는 최소 1명이 필요하므로 1로 clamp한다.
 */
export function countLiveOpponents(
  players: { sessionId: string; isFolded: boolean }[],
  mySessionId: string,
): number {
  const opponents = players.filter((p) => p.sessionId !== mySessionId && !p.isFolded).length;
  return Math.max(1, opponents);
}
