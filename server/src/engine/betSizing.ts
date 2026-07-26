/**
 * 한게임 스타일 정형 배팅 버튼(삥/따당/쿼터/하프) 금액 계산 — 순수 함수로 분리해
 * PokerRoom.ts(실제 반영)과 테스트에서 동일한 공식을 공유한다.
 */

export type FixedBetType = 'bet_bb' | 'bet_double' | 'bet_quarter' | 'bet_half';

export interface BetSizingContext {
  /** 이번 스트리트의 최고 베팅액(콜 기준) */
  currentBet: number;
  /** 화면에 표시되는 POT과 동일한 기준 — 정산된 팟 + 이번 스트리트에 각자 낸 베팅 합계 */
  potTotal: number;
  bigBlind: number;
  /** 행동하는 플레이어가 이번 스트리트에 이미 낸 금액 */
  streetBet: number;
  /** 행동하는 플레이어의 남은 칩 */
  stack: number;
}

export interface BetSizingResult {
  /** 이번 액션으로 추가로 내야 하는 칩(스택 초과 시 이미 스택으로 캡되어 자동 올인) */
  pay: number;
  /** 결과적으로 currentBet을 끌어올리는 레이즈인지 — 재행동 오픈/minRaise 갱신 여부 판단용 */
  raises: boolean;
}

/**
 * 삥/따당/쿼터/하프 각각의 최종 지불액을 계산한다.
 *  - 삥: currentBet === 0(이번 스트리트에 아직 아무도 베팅 안 함)일 때만, 빅블라인드만큼
 *  - 따당: currentBet > 0일 때만, 그 금액의 정확히 2배로 레이즈
 *  - 쿼터/하프: 현재 팟(potTotal)의 25%/50%를 콜 위에 얹어 베팅·레이즈
 * 유효하지 않으면(조건 불충족·낼 칩 없음) 에러 메시지 문자열을 반환한다.
 */
export function computeFixedBet(type: FixedBetType, ctx: BetSizingContext): BetSizingResult | string {
  switch (type) {
    case 'bet_bb': {
      if (ctx.currentBet !== 0) return '이미 베팅이 있어 삥을 낼 수 없습니다';
      const pay = Math.min(ctx.bigBlind, ctx.stack);
      if (pay <= 0) return '베팅할 칩이 없습니다';
      return { pay, raises: ctx.streetBet + pay > ctx.currentBet };
    }

    case 'bet_double': {
      if (ctx.currentBet <= 0) return '베팅이 없어 따당을 낼 수 없습니다';
      const desired = Math.max(0, ctx.currentBet * 2 - ctx.streetBet);
      const pay = Math.min(desired, ctx.stack);
      if (pay <= 0) return '베팅할 칩이 없습니다';
      return { pay, raises: ctx.streetBet + pay > ctx.currentBet };
    }

    case 'bet_quarter':
    case 'bet_half': {
      const ratio = type === 'bet_quarter' ? 0.25 : 0.5;
      const toCall = Math.max(0, ctx.currentBet - ctx.streetBet);
      const sizeAmount = Math.round(ctx.potTotal * ratio);
      if (sizeAmount <= 0) return '베팅 금액이 올바르지 않습니다';
      const pay = Math.min(toCall + sizeAmount, ctx.stack);
      if (pay <= 0) return '베팅할 칩이 없습니다';
      return { pay, raises: ctx.streetBet + pay > ctx.currentBet };
    }
  }
}
