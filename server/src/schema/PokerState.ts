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
  @type('int32') stack = 0;
  /** 이번 스트리트에 낸 칩 (스트리트 종료 시 pot으로 이동) */
  @type('int32') streetBet = 0;
  @type('boolean') folded = false;
  @type('boolean') allIn = false;
  @type('boolean') hasActed = false;
  @type('boolean') connected = true;
  /** 카드 재구성 증강 사용 여부 (핸드당 1회) */
  @type('boolean') swapUsed = false;
  /** 마지막 액션 표시용 ("콜 200", "레이즈 +500"...) */
  @type('string') lastAction = '';
  /** 쇼다운 시에만 채워지는 공개 홀카드 */
  @type([CardSchema]) revealedHole = new ArraySchema<CardSchema>();
  /** 보유 증강 id 목록 */
  @type(['string']) augmentIds = new ArraySchema<string>();
  /** 이번 라운드 증강 선택지 id (선택 완료 시 비움) */
  @type(['string']) augmentChoices = new ArraySchema<string>();
}

export type Phase = 'waiting' | 'augment' | 'betting' | 'showdown' | 'roundResult' | 'gameOver';

export class PokerState extends Schema {
  @type('string') phase: Phase = 'waiting';
  @type('string') street = 'preflop';
  @type('uint8') round = 0;
  @type('uint8') maxRounds = 5;
  @type('int32') pot = 0;
  /** 이번 스트리트의 최고 베팅액 (콜 기준) */
  @type('int32') currentBet = 0;
  /** 최소 레이즈 금액 */
  @type('int32') minRaise = 100;
  /** 현재 행동할 플레이어 sessionId */
  @type('string') activePlayerId = '';
  @type([CardSchema]) community = new ArraySchema<CardSchema>();
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
