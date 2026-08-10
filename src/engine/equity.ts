/** 몬테카를로 방식의 텍사스 홀덤 에퀴티 계산 */

import { createDeck } from './deck';
import { compareHands, evaluateBest } from './handEvaluator';
import type { Card } from './types';

export interface EquityInput {
  hole: Card[];
  board: Card[];
  opponents: number;
  deadCards?: Card[];
  iterations?: number;
  rng?: () => number;
}

export interface EquityResult {
  /** 승리 지분을 포함한 평균 팟 지분 (0~1) */
  equity: number;
  /** 단독 승리한 롤아웃 횟수 */
  win: number;
  /** 최고 핸드가 무승부였던 롤아웃 횟수 */
  tie: number;
  iterations: number;
}

export const DEFAULT_ITERATIONS = {
  preflop: 2000,
  flopOrTurn: 1200,
  river: 600,
} as const;

/**
 * 조커가 끼면 handEvaluator가 무늬 배정을 전부 전개하느라 롤아웃 비용이 크게 뛴다.
 * 그래서 기준 반복 수를 이 값으로 나눈다 — 기본값이든 호출부가 명시한 값이든
 * 똑같이 적용되므로, 어디서 부르든 조커 비용이 일관되게 억제된다.
 */
export const JOKER_ITERATION_DIVISOR = 2;

/** 스트리트별 기준 반복 수 (조커 감축 적용 전) */
function defaultIterations(boardLength: number): number {
  return boardLength === 0
    ? DEFAULT_ITERATIONS.preflop
    : boardLength < 5
      ? DEFAULT_ITERATIONS.flopOrTurn
      : DEFAULT_ITERATIONS.river;
}

/**
 * 배열을 복사하지 않고 앞쪽 count개만 부분 Fisher-Yates로 선택한다.
 * available은 롤아웃 사이에 재사용되지만, 매 롤아웃마다 앞쪽을 다시 교환하므로
 * 이전 롤아웃의 순서가 다음 표본에 누적 오염되지 않는다.
 */
function partialShuffle<T>(available: T[], count: number, rng: () => number): void {
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (available.length - i));
    [available[i], available[j]] = [available[j], available[i]];
  }
}

export function calculateEquity(input: EquityInput): EquityResult {
  const { hole, board, opponents, deadCards = [], rng = Math.random } = input;

  if (hole.length === 0 || hole.length > 2) {
    throw new Error(`에퀴티 계산에는 홀카드 1~2장이 필요합니다 (현재 ${hole.length}장)`);
  }
  if (board.length > 5) {
    throw new Error(`커뮤니티 카드는 최대 5장입니다 (현재 ${board.length}장)`);
  }
  if (!Number.isInteger(opponents) || opponents < 1) {
    throw new Error(`상대 플레이어 수는 1 이상의 정수여야 합니다 (현재 ${opponents})`);
  }

  const requested = input.iterations ?? defaultIterations(board.length);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`반복 횟수는 1 이상의 정수여야 합니다 (현재 ${requested})`);
  }

  // 기준값을 먼저 정한 뒤 조커 감축을 적용한다 — 명시적으로 넘긴 iterations도 동일하게 줄어든다.
  const hasJoker = [...hole, ...board, ...deadCards].some((card) => card.isJoker === true);
  const iterations = hasJoker ? Math.max(1, Math.floor(requested / JOKER_ITERATION_DIVISOR)) : requested;

  const excludedIds = new Set([...hole, ...board, ...deadCards].map((card) => card.id));
  const available = createDeck().filter((card) => !excludedIds.has(card.id));
  const missingBoard = 5 - board.length;
  const cardsNeeded = opponents * 2 + missingBoard;
  if (available.length < cardsNeeded) {
    throw new Error(`롤아웃에 필요한 카드가 부족합니다 (필요 ${cardsNeeded}장, 현재 ${available.length}장)`);
  }

  let win = 0;
  let tie = 0;
  let equityTotal = 0;

  for (let iteration = 0; iteration < iterations; iteration++) {
    partialShuffle(available, cardsNeeded, rng);
    const completedBoard = [...board, ...available.slice(opponents * 2, cardsNeeded)];
    const playerHand = evaluateBest([...hole, ...completedBoard]);

    let opponentBeatsPlayer = false;
    let tiedOpponents = 0;
    for (let opponent = 0; opponent < opponents; opponent++) {
      const start = opponent * 2;
      const opponentHand = evaluateBest([
        available[start],
        available[start + 1],
        ...completedBoard,
      ]);
      const comparison = compareHands(playerHand, opponentHand);
      if (comparison < 0) opponentBeatsPlayer = true;
      else if (comparison === 0) tiedOpponents++;
    }

    if (!opponentBeatsPlayer && tiedOpponents === 0) {
      win++;
      equityTotal += 1;
    } else if (!opponentBeatsPlayer) {
      tie++;
      equityTotal += 1 / (tiedOpponents + 1);
    }
  }

  return {
    equity: equityTotal / iterations,
    win,
    tie,
    iterations,
  };
}
