/**
 * Colyseus 동기화 스키마 — 클라이언트에 브로드캐스트되는 상태.
 *
 * 보안 원칙: 홀카드와 덱은 스키마에 넣지 않는다 (서버 전용).
 *  - 각자의 홀카드는 room이 client.send('hole', ...)로 개별 전송
 *  - revealedHole은 쇼다운 시점에만 채워져 전체 공개
 */

import { Schema, ArraySchema, MapSchema, type } from '@colyseus/schema';
import type { Card } from '../engine/types';

export class CardSchema extends Schema {
  @type('string') id = '';
  @type('string') suit = '';
  @type('uint8') rank = 0;
  @type('boolean') isJoker = false;
}

export function toCardSchema(card: Card): CardSchema {
  const c = new CardSchema();
  c.id = card.id;
  c.suit = card.suit;
  c.rank = card.rank;
  c.isJoker = !!card.isJoker;
  return c;
}

export class PlayerState extends Schema {
  @type('string') sessionId = '';
  @type('string') name = '';
  /** 좌석 번호 (0~3), 입장 시 빈 좌석 중 가장 낮은 번호로 배정 */
  @type('uint8') seatIndex = 0;
  @type('boolean') isBot = false;
  @type('int32') stack = 0;
  /** 이번 스트리트에 낸 칩 (스트리트 종료 시 pot으로 이동) */
  @type('int32') streetBet = 0;
  @type('boolean') isFolded = false;
  @type('boolean') allIn = false;
  @type('boolean') hasActed = false;
  @type('boolean') connected = true;
  /** 카드 재구성 증강 사용 여부 (핸드당 1회) */
  @type('boolean') swapUsed = false;
  /** 밑장빼기 증강 사용 여부 (라운드당 1회) */
  @type('boolean') bottomDealUsed = false;
  /** 리셋 버튼 증강 사용 여부 (라운드당 1회) */
  @type('boolean') resetBoardUsed = false;
  /** 이번 핸드 홀카드 매수 — 평소 2장, 대풍년 보유자가 있으면 전원 3장 (뒷면 카드 개수 렌더링에 사용) */
  @type('uint8') holeCount = 2;
  /** 마지막 액션 표시용 ("콜 200", "레이즈 +500"...) */
  @type('string') lastAction = '';
  /** 쇼다운 시에만 채워지는 공개 홀카드 */
  @type([CardSchema]) revealedHole = new ArraySchema<CardSchema>();
  /** 보유 증강 id 목록 — 라운드가 지나도 비워지지 않고 누적된다 */
  @type(['string']) augmentIds = new ArraySchema<string>();
  /**
   * 일회성 증강(trigger: 'on_pick' — 카멜레온)이 이미 한 번 발동해 소모된 id 목록.
   * 라운드가 바뀌어도 절대 비워지지 않는다 — 여기 담긴 id는 계속 보유하고 있어도
   * 다시는 대상 지정 큐에 들어가지 않는다(효과 소모 처리).
   */
  @type(['string']) usedOneShotAugmentIds = new ArraySchema<string>();
  /** 이번 라운드 증강 선택지 id (선택 완료 시 비움) */
  @type(['string']) augmentChoices = new ArraySchema<string>();
  /**
   * 대상 지정이 필요한 증강(음침한 눈/카멜레온/당근이세요?/예고 홈런)을 보유하고 있으면,
   * 매 핸드 시작 시 이 값이 현재 대상 지정을 기다리는 증강 id로 채워진다. 한 플레이어가
   * 그런 증강을 여러 개 보유했다면 획득 순서대로 하나씩 채워지고, 전부 해소되면 빈
   * 문자열로 돌아간다 — 다음 핸드가 시작되면 같은 증강이라도 다시 채워진다(1회성 아님).
   */
  @type('string') pendingTargetAugment = '';
  /** 프리즘 청구서 — 지금 동결 중인 골드(0이면 보유 중이 아니거나 이미 정산됨) */
  @type('int32') frozenGold = 0;
  /** 프리즘 청구서 — 완료 목표(누적 베팅액). frozenGold와 함께 0이면 진행 중 아님 */
  @type('int32') frozenGoldTarget = 0;
  /** 프리즘 청구서 — 지금까지 누적된 베팅액 (게임 내내 유지, 라운드 넘어가도 안 비워짐) */
  @type('int32') frozenGoldProgress = 0;
  /** 장고의 시간 — 게임 전체 1회 사용 여부 (라운드가 지나도 절대 초기화되지 않음) */
  @type('boolean') deepThinkUsed = false;
  /** 예고 홈런 — 이번 핸드에 선언한 목표 족보 (빈 문자열이면 미선언). 매 핸드 시작 시 초기화 */
  @type('string') declaredHandCategory = '';
}

/**
 * 라운드 진행 순서:
 *   waiting → augment_select → augment_target → preflop → flop → turn → river
 *   → showdown → round_end → (다음 라운드는 다시 augment_select로 순환)
 * 베팅은 더 이상 하나의 'betting' phase가 아니라 preflop/flop/turn/river 각각이
 * 곧 phase 값이다 — 별도 street 필드를 두지 않고 phase 자체가 스트리트를 표현한다.
 * augment_target: 대상 지정이 필요한 증강(음침한 눈/카멜레온/당근이세요?)을 보유한
 * 플레이어가 있을 때만 거치는 단계 — 매 핸드, 홀카드가 갓 딜링된 직후·베팅 시작 전에
 * 대상(플레이어/카드)을 지정해 효과(카드 확인/변경/교환)를 해소한다. 그런 증강을 보유한
 * 플레이어가 아무도 없으면 건너뛴다. 보유하고 있는 한 이 phase는 라운드마다 반복된다.
 * street_reveal_choice: 밑장빼기를 아직 사용하지 않은 보유자가 있을 때만 거치는 단계 —
 * 플랍/턴/리버로 넘어가기 직전, 그 카드를 공개하기 전에 사용 여부(예/아니오)를 순서대로
 * 묻는다. 아무도 해당 증강을 보유하지 않았거나 전원 이미 사용했으면 건너뛴다.
 */
export type Phase =
  | 'waiting'
  | 'augment_select'
  | 'augment_target'
  | 'preflop'
  | 'flop'
  | 'turn'
  | 'river'
  | 'street_reveal_choice'
  | 'showdown'
  | 'round_end'
  | 'gameOver';

export class PokerState extends Schema {
  @type('string') phase: Phase = 'waiting';
  @type('uint8') round = 0;
  @type('uint8') maxRounds = 5;
  @type('int32') pot = 0;
  /** 이번 스트리트의 최고 베팅액 (콜 기준) */
  @type('int32') currentBet = 0;
  /** 최소 레이즈 금액 */
  @type('int32') minRaise = 100;
  /** 스몰 블라인드 금액 */
  @type('int32') smallBlind = 50;
  /** 빅 블라인드 금액 */
  @type('int32') bigBlind = 100;
  /** 현재 행동할 플레이어 sessionId */
  @type('string') activePlayerId = '';
  /** 방장 sessionId — "게임 시작" 버튼을 누를 수 있는 유일한 플레이어 */
  @type('string') hostSessionId = '';
  /** 딜러 버튼 좌석 (0~3, 미배정 시 -1) */
  @type('int8') dealerSeat = -1;
  /** 현재 턴 좌석 (0~3, activePlayerId와 동기, 없으면 -1) */
  @type('int8') currentTurnSeat = -1;
  /** 공개된 커뮤니티 카드 — 길이(community.length)가 곧 "공개된 카드 개수" */
  @type([CardSchema]) community = new ArraySchema<CardSchema>();
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
