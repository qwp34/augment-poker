/**
 * 로그인 유저의 칩 정산이 세션당 정확히 한 번만 일어나도록 보장하는 순수 추적 로직.
 * Supabase/Colyseus에 의존하지 않아(생성자 인자 없음, 부수효과 없음) 유닛테스트가 쉽다.
 *
 * 왜 필요한가: 같은 sessionId에 대해 정산 호출이 여러 경로에서 들어올 수 있다 —
 * 예를 들어 게임이 끝나 endGame()에서 전원을 정산했는데, 그 직후 클라이언트가 방을
 * 나가면서 onLeave의 "waiting/gameOver 정리" 분기가 다시 같은 sessionId를 정산하려
 * 시도할 수 있다. consume()은 두 번째 호출부터 null을 반환해 이중 지급/이중 차감 반영을
 * 막는다.
 */
export class SettlementTracker {
  private entries = new Map<string, { userId: string; settled: boolean }>();

  /** 인증된 플레이어가 입장(=바이인 차감)에 성공했을 때 등록한다 */
  track(sessionId: string, userId: string): void {
    this.entries.set(sessionId, { userId, settled: false });
  }

  /**
   * 정산 대상 userId를 반환하며 즉시 settled로 표시한다 — 추적 안 된 세션이거나
   * 이미 정산된 세션이면 null (호출부는 이 경우 아무것도 하지 않아야 한다).
   */
  consume(sessionId: string): string | null {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.settled) return null;
    entry.settled = true;
    return entry.userId;
  }
}
