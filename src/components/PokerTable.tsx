import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from './Card';
import { AugmentCard } from './AugmentCard';
import augmentsData from '../data/augments.json';
import { RARITY_NAMES_KO, type Augment } from '../engine/augmentEngine';
import { evaluateBest, CATEGORY_NAMES_KO, HAND_CATEGORY_ORDER, type HandCategory } from '../engine/handEvaluator';
import type { Card as EngineCard } from '../engine/types';
import { CATEGORY_SHORT_KO } from '../ui/format';
import { useFitScale } from '../ui/useFitScale';
import { useCountUp } from '../ui/useCountUp';
import { playSound } from '../utils/sounds';
import type {
  AugmentRevealInfo,
  BettingActionType,
  BigAnnouncementEvent,
  CardChangeEvent,
  ClientCard,
  ClientGameState,
  ClientPlayer,
  NoticeEvent,
  ShowdownResult,
  TurnExtendedEvent,
} from '../net/useMultiplayerRoom';

const AUGMENT_POOL = augmentsData as Augment[];
const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);
/** 서버 PokerRoom.ts의 TURN_TIMEOUT_MS와 반드시 동일한 값으로 유지 — 턴 타이머 테두리은
 * 서버가 실제로 재는 시간이 아니라 이 값 기준으로 클라이언트가 근사 재현한 것이다. */
const TURN_TIMEOUT_MS = 30_000;
/** 턴 타이머 테두리이 위급(빨강 + 깜빡임)으로 바뀌는 잔여시간 기준 */
const TURN_URGENT_MS = 5_000;
/** 마름모 좌석(0=하단/1=우측/2=상단/3=좌측) → "이 좌석에서 테이블 중앙 방향"의 오프셋(px).
 * 카드 딜링(중앙→좌석) 진입 방향과 베팅 칩(좌석→중앙) 이동 방향에 공용으로 쓰인다 —
 * .mp-table-area가 1650×1000 고정 캔버스라서 좌표계가 항상 동일하다. */
const SEAT_DIR: Record<number, { x: number; y: number }> = {
  0: { x: 0, y: -260 },
  1: { x: -320, y: 0 },
  2: { x: 0, y: 260 },
  3: { x: 320, y: 0 },
};
// ── 쇼다운 순차 공개 + 러시안 룰렛 연출 타이밍(ms) ──────────────────────────────
// 서버 PokerRoom.ts의 SHOWDOWN_RESULT_DELAY_MS(12000)/ROULETTE_RESULT_DELAY_MS(18000),
// useMultiplayerRoom.ts의 lastResult 안전장치 타이머(13000/19000)는 이 타임라인이 전부
// 끝날 때까지 다음 라운드로 넘어가거나 배너가 지워지지 않도록 여유를 두고 맞춰져 있다 —
// 아래 값을 크게 바꾸면(특히 SD_TURN_DELAY_MS/SD_RIVER_DELAY_MS/SD_RESULT_DELAY_MS나
// RR_* 상수) 세 곳 모두 함께 조정해야 한다.
const SD_ALLIN_STAGGER_MS = 500;
const SD_TEXT_MS = 1300;
const SD_TEXT_GAP_MS = 150;
const SD_BOARD_STAGGER_MS = 450;
const SD_BOARD_SETTLE_MS = 350;
const SD_HOLE_STAGGER_MS = 500;
// 홀카드 공개 → 턴 → 리버 → 결과 표시 사이의 간격 — 서버가 알려주는 revealedBoardCount(올인
// 확정 시점에 이미 정상 공개돼 있던 보드 카드 수)부터 이어서 공개하므로, 이미 봤던 스트리트
// (예: 플랍까지 베팅하다 올인)는 다시 리캡되지 않고 이 간격도 그 지점부터 적용된다.
const SD_TURN_DELAY_MS = 1200;
const SD_RIVER_DELAY_MS = 1400;
const SD_RESULT_DELAY_MS = 1600;
const RR_ORIGINAL_MS = 2000;
const RR_COUNTDOWN_SLOW_MS = 1300;
const RR_COUNTDOWN_FAST_MS = 1000;
const RR_COUNTDOWN_TICK_SLOW_MS = 500;
const RR_COUNTDOWN_TICK_FAST_MS = 200;
const RR_TRIGGER_MS = 900;
const RR_BULLET_MS = 1200;

type RouletteStage = 'none' | 'original' | 'countdown-slow' | 'countdown-fast' | 'trigger' | 'bullet';

function findAugment(id: string): Augment | undefined {
  return AUGMENT_POOL.find((a) => a.id === id);
}

/** 네트워크로 전달된 느슨한 카드 타입 → 로컬 엔진의 리터럴 타입으로 캐스팅 (값은 서버가 보장) */
function asEngineCard(c: ClientCard): EngineCard {
  return c as unknown as EngineCard;
}

/**
 * 홀카드 + 커뮤니티 카드로 현재(또는 쇼다운) 최고 족보를 구성하는 5장의 카드 id를 계산한다.
 * handEvaluator.evaluateBest()의 bestFive를 그대로 활용 — 최소 5장이 안 모이면(프리플랍 등)
 * null을 반환해 하이라이트를 표시하지 않는다.
 */
function computeBestFiveIds(hole: ClientCard[], community: ClientCard[]): Set<string> | null {
  if (hole.length + community.length < 5) return null;
  const best = evaluateBest([...hole, ...community].map(asEngineCard));
  return new Set(best.bestFive.map((c) => c.id));
}

/** 카드 재구성 증강(card_swap 효과)을 보유했는지 */
function hasCardSwapAugment(player: ClientPlayer | null): boolean {
  if (!player) return false;
  return player.augmentIds.some((id) => findAugment(id)?.effect.type === 'card_swap');
}

/** 리셋 버튼 증강(reset_board 효과)을 보유했는지 */
function hasResetButtonAugment(player: ClientPlayer | null): boolean {
  if (!player) return false;
  return player.augmentIds.some((id) => findAugment(id)?.effect.type === 'reset_board');
}

/** 장고의 시간 증강(extend_timer 효과)을 보유했는지 */
function hasExtendTimerAugment(player: ClientPlayer | null): boolean {
  if (!player) return false;
  return player.augmentIds.some((id) => findAugment(id)?.effect.type === 'extend_timer');
}

/** 카드 변경 브로드캐스트를 짧은 한글 알림 문구로 변환 */
function describeCardChange(event: CardChangeEvent): string {
  if (event.augmentId === 'aug_shaky_table') {
    return '🌀 테이블이 흔들렸습니다! 모두의 홀카드가 옆 사람에게 넘어갔습니다';
  }
  if (event.augmentId === 'aug_carrot' && event.changes.length >= 2) {
    const [a, b] = event.changes;
    return `🔄 ${a.playerName}님과 ${b.playerName}님의 카드가 맞바뀌었습니다`;
  }
  const name = event.changes[0]?.playerName ?? '';
  return `✨ ${name}님의 카드가 '${event.augmentName}' 효과로 바뀌었습니다`;
}

/**
 * 서버의 seatIndex(턴 순서 등 게임 로직)는 그대로 두고, 화면에 어디(상/좌/우/하)에 그릴지만
 * "내 seatIndex가 항상 하단 중앙"이 되도록 상대적으로 재계산한다 — 마름모(다이아몬드) 배치.
 * 슬롯 순서 0→하단(나), 1→우측, 2→상단, 3→좌측 — 시계 방향 순서는 그대로 유지된다.
 * 예: 내가 seat 2면 2→하단, 3→우측, 0→상단, 1→좌측.
 */
function toDisplaySlot(seatIndex: number, mySeatIndex: number): number {
  return (seatIndex - mySeatIndex + 4) % 4;
}

const DIAMOND_CLASS = ['mp-diamond-bottom', 'mp-diamond-right', 'mp-diamond-top', 'mp-diamond-left'];
/** 안 보이는 홀카드 자리를 위한 고정 참조 — 매 렌더 새 배열 리터럴을 만들면 아래 useMemo가 매번 무효화된다 */
const EMPTY_HOLE: ClientCard[] = [];

/**
 * 현재 차례인 좌석의 정보 박스(닉네임+칩) 테두리 자체를 따라 시간이 줄어드는 카운트다운.
 * 순환형 원형 게이지(SVG circle)는 박스 위에 겹쳐 텍스트를 가려버리는 문제가 있었다 —
 * 대신 박스 "바깥"에 얇은 테두리 링을 두르고, conic-gradient로 그 테두리만 채워서
 * 텍스트 영역은 절대 건드리지 않는다. content-box를 마스킹으로 도려내 순수 테두리
 * 모양만 남기는 방식이라 박스 크기(닉네임 길이 등)가 달라져도 자동으로 맞는다.
 * conic-gradient의 0deg는 상단(12시) 방향이고 각도가 커질수록 시계방향으로 진행되므로
 * "상단 중앙에서 시작해 시계방향으로 줄어듦" 요구사항과 정확히 맞아떨어진다.
 */
function TurnBorder({ remainingMs, totalMs }: { remainingMs: number; totalMs: number }) {
  const frac = Math.max(0, Math.min(1, remainingMs / totalMs));
  const urgent = remainingMs <= TURN_URGENT_MS;
  return (
    <span
      className={`mp-turn-border${urgent ? ' mp-turn-border-urgent' : ''}`}
      style={{ '--turn-progress': frac } as React.CSSProperties}
      aria-hidden="true"
    />
  );
}

interface DiamondSeatProps {
  player: ClientPlayer;
  isMe: boolean;
  myHole: ClientCard[];
  isDealer: boolean;
  isActive: boolean;
  diamondSlot: number;
  /** 이번 핸드를 구분하는 값(라운드 번호) — 뒷면 카드가 매 핸드 "중앙→좌석" 딜링 모션을
   * 다시 재생하도록, 값이 바뀔 때마다 뒷면 카드 엘리먼트를 새로 마운트시키는 키로 쓰인다. */
  dealEpoch: number;
  /** 음침한 눈으로 확인한 이 좌석의 카드 (나에게만 보임) — 없으면 null */
  reveal: AugmentRevealInfo | null;
  /** 이 좌석의 어느 홀카드가 방금 바뀌었는지 — "sessionId:0"/"sessionId:1" 키, 잠깐만 유지된다 */
  glowKeys: Set<string>;
  /** 족보 판정용 커뮤니티 카드 (쇼다운 후 공개된 홀카드와 조합해 하이라이트할 5장을 계산) */
  community: ClientCard[];
  /** 카드 재구성 증강으로 지금 내 홀카드를 클릭해 교체할 수 있는 상태인지 (isMe 좌석에서만 의미 있음) */
  canSwap: boolean;
  /** 카드 재구성 — 내 홀카드 index를 새 카드로 교체 요청(대풍년이면 0~2, isMe 좌석에서만 의미 있음) */
  onSwapCard: (index: number) => void;
  /** 증강 뱃지를 클릭했을 때 — 이름/효과 설명 팝업을 띄우기 위해 상위(PokerTable)로 알린다 */
  onAugmentClick: (augmentId: string) => void;
  /** 현재 차례인 좌석에서만 사용 — 턴 타이머 테두리에 표시할 잔여/총 시간(ms) */
  turnRemainingMs: number;
  turnTotalMs: number;
  /** 대풍년으로 이번 라운드 홀카드가 3장인 상태 — 카드/정보 박스/증강 뱃지를 통째로 축소해
   * 3장이어도 좌석이 테이블 바깥으로 튀어나가지 않게 한다 */
  compact: boolean;
  /** 내 좌석(isMe)일 때만 전달 — 승리 연출이 실제로 이 좌석과 겹치는지 런타임에 측정하기 위한 DOM 참조 */
  rootRef?: Ref<HTMLDivElement>;
  /** 쇼다운 순차 공개 연출 중 이 좌석의 홀카드를 "지금" 보여줘도 되는지 — isMe는 항상 true.
   * 상대 좌석은 서버가 revealedHole을 채워도, 연출 타임라인이 이 좌석 차례에 도달하기 전까지는
   * 뒷면을 유지한다(PokerTable의 showdown 시퀀스가 순서대로 true로 바꿔준다). */
  revealedForShowdown: boolean;
}

/** 상/좌/우/하 마름모 형태로 배치되는 좌석 카드 — 이름/칩/미니 홀카드/보유 증강(항상 공개) */
function DiamondSeat({
  player,
  isMe,
  myHole,
  isDealer,
  isActive,
  diamondSlot,
  dealEpoch,
  reveal,
  glowKeys,
  community,
  canSwap,
  onSwapCard,
  onAugmentClick,
  turnRemainingMs,
  turnTotalMs,
  compact,
  rootRef,
  revealedForShowdown,
}: DiamondSeatProps) {
  // 폴드한 플레이어/아직 순서가 오지 않은 상대는 revealedHole이 있어도 EMPTY_HOLE로 취급해
  // 뒷면을 유지한다 — 자리마다 카드 개수가 들쭉날쭉해지지 않아 그 아래/옆의 증강 뱃지 위치도 안정적이다.
  // isFolded는 별도로 한 번 더 확인한다 — revealedForShowdown이 폴백 규칙(연출이 이 라운드를
  // 다루지 않을 때 즉시 공개)으로 true가 되는 경우에도, 폴드한 플레이어의 카드는 쇼다운
  // 참가자가 아니므로 절대 앞면으로 보이면 안 된다(정보 박스는 그대로, 카드만 뒷면 유지).
  const holeCards: ClientCard[] =
    isMe || (revealedForShowdown && !player.isFolded) ? (isMe ? myHole : player.revealedHole) : EMPTY_HOLE;
  const bestFiveIds = useMemo(() => computeBestFiveIds(holeCards, community), [holeCards, community]);
  const dealFrom = SEAT_DIR[diamondSlot];

  return (
    <div
      ref={rootRef}
      className={[
        'mp-diamond-seat',
        DIAMOND_CLASS[diamondSlot],
        player.isFolded ? 'mp-seat-folded' : '',
        isActive ? 'mp-seat-active' : '',
        isActive && isMe ? 'mp-seat-my-turn' : '',
        compact ? 'mp-seat-compact' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* 홀카드 오른쪽에 보유 증강을 나란히 배치 — 개수가 늘어나면 이 열만 세로 스크롤된다.
          닉네임 박스는 이 열이 아니라 카드 2장하고만 짝지어 쌓아서, 항상 카드 2장의 정중앙
          위쪽에 오도록 한다(증강 칩 열의 폭에 영향받지 않음). */}
      <div className="mp-seat-body">
        <div className="mp-seat-cards-col">
          <div className="mp-seat-info">
            {isActive && <TurnBorder remainingMs={turnRemainingMs} totalMs={turnTotalMs} />}
            {isDealer && <span className="mp-dealer-chip">D</span>}
            <span className="seat-name">
              {player.name}
              {isMe ? ' (나)' : ''}
              {player.isBot ? ' 🤖' : ''}
            </span>
            <span className="seat-gold">{player.stack.toLocaleString()}</span>
            {player.streetBet > 0 && <span className="seat-bet">베팅 {player.streetBet.toLocaleString()}</span>}
            {player.lastAction && <span className="mp-seat-last-action">{player.lastAction}</span>}
            {/* 예고 홈런 — 다른 플레이어에게도 공개되는 선언(심리전 요소) */}
            {player.declaredHandCategory && (
              <span className="mp-seat-prophecy" title="예고 홈런으로 선언한 목표 족보">
                🎯 예고: {CATEGORY_SHORT_KO[player.declaredHandCategory as HandCategory] ?? player.declaredHandCategory}
              </span>
            )}
          </div>
          <div className="mp-seat-cards">
            {isMe
              ? holeCards.map((c, idx) => (
                  <Card
                    key={c.id}
                    card={asEngineCard(c)}
                    size="sm"
                    dealFrom={dealFrom}
                    dealDelay={idx * 0.12}
                    clickable={canSwap}
                    onClick={
                      canSwap
                        ? () => {
                            playSound('buttonClick');
                            onSwapCard(idx);
                          }
                        : undefined
                    }
                    changeFx={glowKeys.has(`${player.sessionId}:${idx}`)}
                    highlight={!!bestFiveIds?.has(c.id)}
                  />
                ))
              : // 대풍년 보유자가 있으면 전원 3장 — 상대방 카드는 쇼다운 전까지 값을 알 수 없으니
                // holeCount(공개 동기화 필드)로 자리 개수만 정확히 맞춘다. 같은 key(idx-dealEpoch)를
                // 유지한 채 card/hidden만 바꾸므로, 값이 채워지는 순간 마운트/언마운트 없이
                // CSS 플립 전환(.pcard-inner)이 자연스럽게 재생된다 — 쇼다운 순차 공개의 핵심.
                Array.from({ length: player.holeCount || 2 }, (_, idx) => idx).map((idx) => {
                  const c = holeCards[idx];
                  if (reveal && reveal.cardIndex === idx && !c) {
                    // 음침한 눈으로 확인한 카드 — 뒷면 대신 실제 카드 + 눈 표식 (나에게만 렌더됨)
                    return (
                      <span key={idx} className="mp-revealed-card" title="음침한 눈으로 확인한 카드">
                        <Card card={asEngineCard(reveal.card)} size="sm" />
                        <span className="mp-revealed-eye">👁</span>
                      </span>
                    );
                  }
                  return (
                    <Card
                      key={`${idx}-${dealEpoch}`}
                      card={c ? asEngineCard(c) : undefined}
                      hidden={!c}
                      size="sm"
                      dealFrom={dealFrom}
                      dealDelay={idx * 0.12}
                      flip={!!c}
                      changeFx={glowKeys.has(`${player.sessionId}:${idx}`)}
                      highlight={!!c && !!bestFiveIds?.has(c.id)}
                    />
                  );
                })}
          </div>
        </div>
        {/* 보유 증강 — 상대방 것도 항상 공개 표시(숨김 정보 아님) + 클릭하면 이름/효과 팝업 */}
        {player.augmentIds.length > 0 && (
          <div className="mp-seat-augments">
            {player.augmentIds.map((id) => {
              const augment = findAugment(id);
              return augment ? (
                <AugmentCard
                  key={id}
                  augment={augment}
                  compact
                  onSelect={() => {
                    playSound('buttonClick');
                    onAugmentClick(id);
                  }}
                />
              ) : null;
            })}
          </div>
        )}
      </div>
      {isMe && canSwap && <span className="mp-swap-hint">🔄 카드를 클릭해 1장 교체 가능</span>}
    </div>
  );
}

/** 증강 뱃지 클릭 시 뜨는 이름/효과 설명 팝업 — 바깥(배경) 클릭 시 닫힌다 */
function AugmentInfoPopup({ augment, onClose }: { augment: Augment; onClose: () => void }) {
  return (
    <div className="mp-augment-popup-overlay" onClick={onClose}>
      <motion.div
        className={`mp-augment-popup rarity-${augment.rarity}`}
        initial={{ opacity: 0, scale: 0.85, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 22 }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="mp-augment-popup-rarity">{RARITY_NAMES_KO[augment.rarity]}</span>
        <h3 className="mp-augment-popup-name">{augment.name}</h3>
        <p className="mp-augment-popup-desc">{augment.description}</p>
        <button
          type="button"
          className="mp-augment-popup-close"
          onClick={() => {
            playSound('buttonClick');
            onClose();
          }}
        >
          닫기
        </button>
      </motion.div>
    </div>
  );
}

/**
 * 한게임 스타일 정형 배팅 버튼 그리드. 자유 금액 입력은 없다 — 각 버튼이 낼 금액은 서버(PokerRoom)가
 * 팟/현재 베팅액 기준으로 최종 계산하고, 여기서는 그 값을 그대로 미리보기로 표시만 한다(서버 공식과
 * 반드시 동일해야 함: 삥=빅블라인드, 따당=현재 베팅액의 2배, 쿼터/하프=화면 표시 POT의 25%/50%+콜).
 * 순서(왼→오): 다이 / 삥·따당(양자택일) / 콜·체크(양자택일) / 쿼터 / 하프 / 맥스.
 */
function BettingActionBar({
  gameState,
  myPlayer,
  onAction,
}: {
  gameState: ClientGameState;
  myPlayer: ClientPlayer;
  onAction: (type: BettingActionType) => void;
}) {
  const { toCall, stack, bbAmount, doubleAmount, quarterAmount, halfAmount } = useMemo(() => {
    const toCall = Math.max(0, gameState.currentBet - myPlayer.streetBet);
    const stack = myPlayer.stack;
    const potTotal = gameState.pot + gameState.players.reduce((sum, p) => sum + p.streetBet, 0);
    const bbAmount = Math.min(gameState.bigBlind, stack);
    const doubleAmount = Math.min(Math.max(0, gameState.currentBet * 2 - myPlayer.streetBet), stack);
    const sizeAt = (ratio: number) => Math.min(toCall + Math.round(potTotal * ratio), stack);
    return {
      toCall,
      stack,
      bbAmount,
      doubleAmount,
      quarterAmount: sizeAt(0.25),
      halfAmount: sizeAt(0.5),
    };
  }, [gameState.currentBet, gameState.bigBlind, gameState.pot, gameState.players, myPlayer.streetBet, myPlayer.stack]);

  const isOpenStreet = gameState.currentBet === 0;
  // 쿼터/하프가 실질적으로 콜보다 더 내는 게 없으면(팟이 0에 가까워 반올림이 0인 경우) 무의미한 레이즈이므로 비활성화
  const quarterEnabled = quarterAmount > toCall || (isOpenStreet && quarterAmount > 0);
  const halfEnabled = halfAmount > toCall || (isOpenStreet && halfAmount > 0);

  const act = (type: BettingActionType) => {
    playSound('buttonClick');
    onAction(type);
  };

  return (
    <div className="mp-action-bar">
      <button className="bet-btn bet-die" onClick={() => act('fold')}>
        다이
      </button>

      {isOpenStreet ? (
        <button className="bet-btn" disabled={bbAmount <= 0} onClick={() => act('bet_bb')}>
          삥 <em>{bbAmount.toLocaleString()}</em>
        </button>
      ) : (
        <button className="bet-btn" disabled={doubleAmount <= 0} onClick={() => act('bet_double')}>
          따당 <em>{doubleAmount.toLocaleString()}</em>
        </button>
      )}

      <button className="bet-btn bet-call" onClick={() => act(toCall > 0 ? 'call' : 'check')}>
        {toCall > 0 ? (
          <>
            콜 <em>{Math.min(toCall, stack).toLocaleString()}</em>
          </>
        ) : (
          '체크'
        )}
      </button>

      <button className="bet-btn" disabled={!quarterEnabled} onClick={() => act('bet_quarter')}>
        쿼터 <em>{quarterAmount.toLocaleString()}</em>
      </button>

      <button className="bet-btn" disabled={!halfEnabled} onClick={() => act('bet_half')}>
        하프 <em>{halfAmount.toLocaleString()}</em>
      </button>

      <button className="bet-btn bet-max" disabled={stack <= 0} onClick={() => act('allin')}>
        맥스 <em>{stack.toLocaleString()}</em>
      </button>
    </div>
  );
}

/**
 * 승리 연출 한 줄 — "🏆 닉네임 · 족보 · +골드"를 절대 줄바꿈되지 않는 한 줄로 표시한다
 * (텍스트 요소들은 각자 다른 방향에서 순차적으로 날아 들어온다: 트로피는 팝, 닉네임은
 * 왼쪽에서, 족보는 팝, 골드는 오른쪽에서). 반투명 검정 박스(.mp-result-banner) 위에
 * 얹히므로 커뮤니티 카드와 겹쳐도 잘리지 않고 또렷이 읽힌다. delayBase는 스플릿 팟 등
 * 여러 줄이 겹칠 때 줄마다 등장을 살짝 어긋나게 밀어주는 용도.
 */
function ResultWinnerLine({
  name,
  suffix,
  category,
  payout,
  multiplier,
  augments,
  prophecyBonus,
  delayBase = 0,
}: {
  name: string;
  suffix?: string;
  category?: string;
  payout: number;
  multiplier?: number;
  augments?: string[];
  prophecyBonus?: number;
  delayBase?: number;
}) {
  // "AI 봇 4 · 원 페어 · +200 골드" 처럼 한 줄로 고정 표시 — 승자명/족보(또는 폴드 문구)/획득
  // 골드를 "·"로 구분해 이어붙인다. 배율·예고 보너스는 짧은 보조 정보라 같은 줄에 이어 붙이고,
  // 증강 칩 목록만 길어질 수 있어 줄바꿈 가능한 별도 행으로 뺀다(.mp-result-line 자체는 nowrap).
  const middle = suffix ?? category;
  return (
    <div className="mp-result-line-group">
      <div className="mp-result-line">
        <motion.span
          className="mp-result-trophy"
          initial={{ opacity: 0, scale: 0.3, rotate: -20 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          transition={{ delay: delayBase, type: 'spring', stiffness: 380, damping: 15 }}
        >
          🏆
        </motion.span>
        <motion.span
          className="mp-result-winner-name"
          initial={{ opacity: 0, x: -90 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: delayBase + 0.08, type: 'spring', stiffness: 280, damping: 24 }}
        >
          {name}
        </motion.span>
        {middle && (
          <>
            <span className="mp-result-dot">·</span>
            <motion.span
              className={suffix ? 'mp-result-suffix' : 'mp-result-category'}
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: delayBase + 0.2, type: 'spring', stiffness: 260, damping: 13 }}
            >
              {middle}
            </motion.span>
          </>
        )}
        <span className="mp-result-dot">·</span>
        <motion.span
          className="mp-result-payout"
          initial={{ opacity: 0, x: 90 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: delayBase + 0.32, type: 'spring', stiffness: 280, damping: 24 }}
        >
          +{payout.toLocaleString()} 골드
        </motion.span>
        {multiplier && multiplier > 1 && (
          <motion.span
            className="mp-result-multiplier"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: delayBase + 0.42, type: 'spring', stiffness: 320, damping: 16 }}
          >
            ×{multiplier} 배당!
          </motion.span>
        )}
        {!!prophecyBonus && prophecyBonus > 0 && (
          <motion.span
            className="mp-result-prophecy"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: delayBase + 0.46, type: 'spring', stiffness: 320, damping: 16 }}
          >
            🎯 예고 적중! +{prophecyBonus.toLocaleString()} 보너스
          </motion.span>
        )}
      </div>
      {augments && augments.length > 0 && (
        <motion.div
          className="augment-chip-row"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: delayBase + 0.5, duration: 0.3 }}
        >
          {augments.map((name) => (
            <span key={name} className="augment-chip rarity-prismatic">
              ⚡ {name}
            </span>
          ))}
        </motion.div>
      )}
    </div>
  );
}

function ResultBanner({ result, maxHeight }: { result: ShowdownResult; maxHeight: number | null }) {
  return (
    <motion.div
      className="mp-result-banner"
      style={maxHeight != null ? { maxHeight } : undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.6 } }}
      transition={{ duration: 0.15 }}
    >
      {result.byFold ? (
        <ResultWinnerLine
          name={result.winners[0]?.name ?? ''}
          suffix="승리 — 상대 다이"
          payout={result.winners[0]?.payout ?? 0}
        />
      ) : (
        result.winners.map((w, i) => (
          <ResultWinnerLine
            key={w.sessionId}
            delayBase={i * 0.55}
            name={w.name}
            category={w.category ? (CATEGORY_SHORT_KO[w.category as HandCategory] ?? w.category) : undefined}
            payout={w.payout}
            multiplier={w.multiplier}
            augments={w.augments}
            prophecyBonus={w.prophecyBonus}
          />
        ))
      )}
    </motion.div>
  );
}

/**
 * 내 홀카드 + 공개된 커뮤니티 카드만으로 현재 최고 족보를 계산한다. handEvaluator.ts의
 * evaluateBest는 최소 5장이 필요해서 그것만으로는 프리플랍(홀카드 2장뿐)을 다룰 수 없다 —
 * 프리플랍은 페어 여부만 별도로 즉석 판정하고, 플랍 이후(5장 이상)는 evaluateBest를 그대로 쓴다.
 */
function computeCurrentCategory(myHole: ClientCard[], community: ClientCard[]): HandCategory | null {
  const totalCards = myHole.length + community.length;
  if (totalCards >= 5) {
    return evaluateBest([...myHole, ...community].map(asEngineCard)).category;
  }
  // 프리플랍(커뮤니티 없음)은 evaluateBest가 다룰 수 없으니 페어 여부만 즉석 판정한다.
  // 대풍년으로 홀카드가 3장이어도(2장 중 하나라도 랭크가 같으면) 동일하게 적용된다.
  if (myHole.length >= 2 && community.length === 0) {
    const hasPair = myHole.some((a, i) => myHole.some((b, j) => i < j && a.rank === b.rank));
    return hasPair ? 'pair' : 'high_card';
  }
  return null;
}

/**
 * 족보 진행 상황 패널(정보 패널의 "족보" 탭) — 내 홀카드 + 공개된 커뮤니티 카드만으로
 * handEvaluator.ts를 재사용해 클라이언트에서 계산한다. 상대 카드는 애초에 클라이언트에
 * 오지 않으므로(서버가 쇼다운 전까지 보내지 않음) 이 계산엔 절대 섞일 수 없다.
 */
function HandProgressPanel({ myHole, community }: { myHole: ClientCard[]; community: ClientCard[] }) {
  const current = computeCurrentCategory(myHole, community);
  // 현재 달성한 족보를 목록 맨 위로 끌어올려, 스크롤 없이도 항상 바로 보이게 한다 —
  // 나머지 항목은 원래(하이카드→로열플러시) 순서 그대로 그 아래에 이어진다.
  const orderedCategories = current
    ? [current, ...HAND_CATEGORY_ORDER.filter((cat) => cat !== current)]
    : HAND_CATEGORY_ORDER;

  return (
    <div className="mp-hand-progress">
      <p className="mp-hand-progress-hint">
        {current ? `현재 최고 족보 — ${CATEGORY_NAMES_KO[current]}` : '홀카드를 받으면 표시됩니다'}
      </p>
      <ul className="mp-hand-progress-list">
        {orderedCategories.map((cat) => (
          <li
            key={cat}
            className={`mp-hand-progress-item${cat === current ? ' mp-hand-progress-active' : ''}`}
          >
            {CATEGORY_NAMES_KO[cat]}
          </li>
        ))}
      </ul>
    </div>
  );
}

const STRAIGHT_RANK = HAND_CATEGORY_ORDER.indexOf('straight');

function isBigHandCategory(current: HandCategory | null): boolean {
  return current !== null && HAND_CATEGORY_ORDER.indexOf(current) >= STRAIGHT_RANK;
}

/**
 * 족보 목록 패널 — 항상 화면 옆에 떠 있는 상시 표시 패널(팝업 아님). 작고 컴팩트한 고정
 * 크기 박스 안에서 10개 항목을 세로 스크롤로 확인한다. 텍스트가 항상 선명하게 보이도록
 * 블러 없이 opacity만 낮춰 평소엔 은은하게 두다가, 내 현재 최고 족보가 스트레이트 이상으로
 * 올라가는 순간 완전히 또렷해진다(.mp-info-panel-focused, App.css 참고).
 */
function InfoPanel({ myHole, community }: { myHole: ClientCard[]; community: ClientCard[] }) {
  const current = computeCurrentCategory(myHole, community);
  const isBigHand = isBigHandCategory(current);

  return (
    <div className={`mp-info-panel${isBigHand ? ' mp-info-panel-focused' : ''}`}>
      <div className="mp-info-header">족보</div>
      <div className="mp-info-content">
        <HandProgressPanel myHole={myHole} community={community} />
      </div>
    </div>
  );
}

interface PokerTableProps {
  gameState: ClientGameState;
  myHole: ClientCard[];
  mySessionId: string;
  lastResult: ShowdownResult | null;
  /** 음침한 눈으로 확인한 상대 카드 — 이번 핸드 동안 해당 좌석에 표시 */
  augmentReveal: AugmentRevealInfo | null;
  /** 카드가 바뀌는 증강(카드 재구성/카멜레온/당근이세요?/흔들리는 테이블) 발동 시 오는 공개 브로드캐스트 */
  cardChangeEvent: CardChangeEvent | null;
  /** 서버의 짧은 시스템 알림(밑장빼기 사용/보드 리셋 등) — 토스트로 표시 */
  noticeEvent: NoticeEvent | null;
  /** 대풍년처럼 화면 전체에 크게 알려야 하는 이벤트 — 큰 배너로 2~3초 표시 */
  bigAnnouncement: BigAnnouncementEvent | null;
  /** 장고의 시간 사용 — 전원에게 오는 공개 브로드캐스트(턴 타이머 링 연장 반영용) */
  turnExtendedEvent: TurnExtendedEvent | null;
  onAction: (type: BettingActionType, amount?: number) => void;
  /** 카드 재구성 — 내 홀카드 index를 새 카드로 교체 요청(대풍년이면 0~2) */
  onSwapCard: (index: number) => void;
  /** 리셋 버튼 — 본인 차례에 현재 커뮤니티 카드를 전부 회수하고 다시 딜링 요청 */
  onResetBoard: () => void;
  /** 장고의 시간 — 본인 차례에 턴 제한시간을 15초 연장 요청 */
  onExtendTurnTimer: () => void;
}

/** 토스트 알림 1건 (화면에 잠깐 떴다가 사라짐) */
interface CardChangeToast {
  id: number;
  text: string;
}

const CARD_CHANGE_FX_MS = 1600;
const CARD_CHANGE_TOAST_MS = 3000;

/** 포커 테이블 화면 — 상/좌/우/하 마름모 좌석 + 상단 중앙 커뮤니티/팟 + 하단 중앙 내 카드/액션 + 우측 정보 패널 */
export function PokerTable({
  gameState,
  myHole,
  mySessionId,
  lastResult,
  augmentReveal,
  cardChangeEvent,
  noticeEvent,
  bigAnnouncement,
  turnExtendedEvent,
  onAction,
  onSwapCard,
  onResetBoard,
  onExtendTurnTimer,
}: PokerTableProps) {
  const myPlayer = gameState.players.find((p) => p.sessionId === mySessionId) ?? null;
  const isMyTurn = gameState.activePlayerId === mySessionId;
  const activePlayer = gameState.players.find((p) => p.sessionId === gameState.activePlayerId);
  const potTotal = gameState.pot + gameState.players.reduce((sum, p) => sum + p.streetBet, 0);
  // 서버의 seatIndex/턴 순서는 건드리지 않고, 내 자리를 항상 하단으로 보이게 하는 표시 슬롯만 계산
  const mySeatIndex = myPlayer?.seatIndex ?? 0;
  // 대풍년 — 누구 한 명이라도 홀카드가 3장이면(모두에게 동일 적용) 좌석 전체를 축소해
  // 3장이 되어도 좌석이 테이블 바깥으로 튀어나가지 않게 한다
  const compactHands = gameState.players.some((p) => p.holeCount > 2);
  const canAct = isMyTurn && myPlayer && !myPlayer.isFolded && !myPlayer.allIn;
  const canSwap =
    BETTING_PHASES.has(gameState.phase) &&
    !!myPlayer &&
    !myPlayer.isFolded &&
    !myPlayer.swapUsed &&
    hasCardSwapAugment(myPlayer);
  // 리셋 버튼 — "본인 차례에 사용 가능한 버튼"이 스펙이라 canAct(내 턴 + 미폴드 + 미올인)를
  // 그대로 재사용한다. 버튼 자체는 플랍이 뜬 순간부터 라운드가 끝날 때까지(이미 썼거나
  // 프리플랍이 아닌 한) 계속 보여주되, 사용 가능 여부(enabled)만 "플랍 단계인가"로 별도
  // 판정한다 — 턴 공개 이후에는 버튼이 사라지는 대신 회색으로 비활성화되어야
  // "왜 안 보이지"가 아니라 "지금은 쓸 수 없다"는 게 명확히 전달된다.
  const resetBoardVisible =
    !!canAct && gameState.phase !== 'preflop' && !!myPlayer && !myPlayer.resetBoardUsed && hasResetButtonAugment(myPlayer);
  const resetBoardEnabled = resetBoardVisible && gameState.phase === 'flop';

  // 장고의 시간 — "자신의 턴 타이머가 도는 중"이 스펙이라 canAct 그대로 재사용. 이미
  // 사용했어도(deepThinkUsed) 버튼은 계속 보이되 비활성화된다("왜 안 보이지" 방지, 리셋
  // 버튼과 동일한 원칙) — 게임 전체 1회라 라운드가 지나도 다시 활성화되지 않는다.
  const extendTimerVisible = !!canAct && !!myPlayer && hasExtendTimerAugment(myPlayer);
  const extendTimerEnabled = extendTimerVisible && !!myPlayer && !myPlayer.deepThinkUsed;

  // 러시안 룰렛이 발동한 쇼다운 직후(round_end)에는 서버가 실제 판정에서 커뮤니티 카드
  // 1장을 제외했다 — 하이라이트/족보 계산도 그 카드를 똑같이 빼고 해야, 화면에 표시되는
  // "최고 족보" 카드/텍스트가 서버가 선언한 승자 족보(ResultBanner)와 어긋나지 않는다.
  //
  // lastResult는 phase가 augment_select/augment_target/preflop로 넘어가는 순간 + 6초
  // 안전 타이머로 지워지긴 하지만(useMultiplayerRoom.ts), 혹시라도 그 타이밍을 놓쳐 이전
  // 핸드의 lastResult가 살아남는 경우를 대비해 이중으로 막는다:
  //   1) 결과가 "지금 이 라운드"의 것인지(result.round === gameState.round)
  //   2) 지금이 실제로 결과를 보여줄 시점(showdown/round_end)인지
  // 카드 id 자체(`suit-rank#핸드번호`)는 핸드마다 달라지므로 다른 핸드의 카드와 절대
  // 우연히 일치하지 않지만, round까지 함께 확인해 상태 전이 타이밍 버그에도 안전하게 한다.
  const removedCardId =
    lastResult?.removedCommunityCardId &&
    (lastResult.round === undefined || lastResult.round === gameState.round) &&
    (gameState.phase === 'round_end' || gameState.phase === 'showdown')
      ? lastResult.removedCommunityCardId
      : undefined;

  const communityForEval = useMemo(
    () => (removedCardId ? gameState.community.filter((c) => c.id !== removedCardId) : gameState.community),
    [gameState.community, removedCardId],
  );

  // 내 관점에서 실시간(또는 쇼다운) 최고 족보를 구성하는 카드 — 홀카드/보드에 골드 하이라이트
  const myBestFiveIds = useMemo(() => computeBestFiveIds(myHole, communityForEval), [myHole, communityForEval]);

  // ── 쇼다운 순차 공개 + 러시안 룰렛 연출 ─────────────────────────────────────
  // 서버는 쇼다운 시점에 전원의 홀카드/최종 보드를 한 번에 다 채워서 보내지만(gameState는
  // 항상 "완성된" 스냅샷), 화면에는 곧바로 다 보여주지 않는다 — 아래 상태들이 "지금 이
  // 데이터 중 어디까지 보여줄지"를 로컬에서 순서대로 열어가며 연출한다. gameState 자체를
  // 지연시키는 게 아니라 "보여줄지 여부"만 로컬 타이머로 제어하는 방식이라, 서버 재동기화나
  // 재접속과도 안전하게 맞물린다(아래 sequenceCoversThisRound 참고).
  const [revealedHoleIds, setRevealedHoleIds] = useState<Set<string>>(new Set());
  const [showdownTextOn, setShowdownTextOn] = useState(false);
  const [boardRevealCount, setBoardRevealCount] = useState(0);
  const [boardReplaying, setBoardReplaying] = useState(false);
  const [rouletteStage, setRouletteStage] = useState<RouletteStage>('none');
  const [bulletRevealed, setBulletRevealed] = useState(false);
  const [resultVisible, setResultVisible] = useState(false);

  const seqTokenRef = useRef(0);
  // 지금 진행 중(또는 이미 끝난) 연출이 "어느 라운드"의 것인지 — gameState.round와 다르면
  // (다음 핸드로 넘어갔거나, 애초에 이 클라이언트가 result 브로드캐스트를 못 받고 중간
  // 접속한 경우) 아래 gate들은 전부 "즉시 공개"로 안전하게 폴백한다.
  const sequenceRoundRef = useRef<number | null>(null);
  const latestGameStateRef = useRef(gameState);
  latestGameStateRef.current = gameState;

  useEffect(() => {
    if (!lastResult || lastResult.byFold) return;
    const token = ++seqTokenRef.current;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => {
      timers.push(
        setTimeout(() => {
          if (seqTokenRef.current === token) fn();
        }, ms),
      );
    };

    const gs = latestGameStateRef.current;
    sequenceRoundRef.current = lastResult.round ?? gs.round;

    // 누가 쇼다운 참가자인지는 lastResult.hands(메시지 본문)로 판단한다 — gameState.players[].
    // revealedHole은 같은 'result' 브로드캐스트라도 상태 패치가 별도 프레임으로 도착해
    // 이 이펙트가 실행되는 시점엔 아직 반영 전일 수 있다(관찰된 레이스: 메시지가 먼저,
    // 스키마 패치가 나중에 도착해 필터링 결과가 매번 빈 배열이 되어 아무도 공개되지 않았다).
    // hands는 메시지 자체에 실려 오므로 이 시점에 100% 존재를 보장한다. seatIndex/allIn은
    // 쇼다운보다 훨씬 이전(베팅 단계)에 이미 확정된 값이라 gameState에서 읽어도 레이스가 없다.
    const contenderIds = new Set((lastResult.hands ?? []).map((h) => h.sessionId));
    // 좌석 표시 순서(하단→우→상→좌)로 훑어야 화면에서 보는 방향과 공개 순서가 일치한다
    const mySeat = gs.players.find((p) => p.sessionId === mySessionId)?.seatIndex ?? 0;
    const bySeatOrder = (a: ClientPlayer, b: ClientPlayer) =>
      toDisplaySlot(a.seatIndex, mySeat) - toDisplaySlot(b.seatIndex, mySeat);
    const contenders = gs.players.filter((p) => contenderIds.has(p.sessionId)).sort(bySeatOrder);
    const allIn = contenders.filter((p) => p.allIn).map((p) => p.sessionId);
    const rest = contenders.filter((p) => !p.allIn).map((p) => p.sessionId);
    const hasRoulette = !!lastResult.removedCommunityCardId;
    // 쇼다운은 항상 5장이 갖춰진 뒤에만 일어난다(runoutAndShowdown이 보장) — gameState.community도
    // 같은 레이스 대상이라 길이를 직접 재는 대신 고정값을 쓴다.
    const boardCount = 5;
    // 전원 올인 등으로 남은 스트리트를 건너뛰고 온 쇼다운인지(서버 runoutAndShowdown 판정을
    // 그대로 전달받음) — 이때만 "SHOW DOWN" 텍스트 + 보드 순차 공개(리캡 플립)를 재생한다.
    // 정상적으로 리버까지 매 스트리트 베팅하며 도달한 쇼다운은 보드가 이미 전부 공개돼
    // 있으므로 리플레이 없이 홀카드만 공개한다.
    const isRunout = !!lastResult.runout;
    // 올인이 확정된 시점에 이미 정상 공개돼 있던 보드 카드 수(서버가 계산해 보내준 값) —
    // 이 장수는 다시 리캡하지 않고 그대로 유지한 채, 그 이후(턴/리버)만 새로 공개한다.
    // 구버전 서버(필드 미포함) 호환을 위해 없으면 0(기존처럼 전체 리캡)으로 취급.
    const preRevealedBoardCount = Math.max(0, Math.min(boardCount, lastResult.revealedBoardCount ?? 0));

    setRevealedHoleIds(new Set());
    setShowdownTextOn(false);
    setBoardRevealCount(isRunout ? preRevealedBoardCount : boardCount);
    setBoardReplaying(isRunout);
    setRouletteStage('none');
    setBulletRevealed(false);
    setResultVisible(false);

    let t = 0;

    if (isRunout) {
      // a) "SHOW DOWN" 텍스트 — 순차 공개가 시작됨을 먼저 알린다
      at(t, () => {
        playSound('showdownSting');
        setShowdownTextOn(true);
      });
      t += SD_TEXT_MS;
      at(t, () => setShowdownTextOn(false));
      t += SD_TEXT_GAP_MS;

      // b) 생존 플레이어들의 홀카드부터 공개(올인한 쪽 먼저, 이어서 콜만 하고 살아남은 쪽) —
      // 턴/리버보다 먼저 보여줘 "이제 무슨 패로 겨루는지"가 카드 공개보다 앞서 드러나게 한다.
      allIn.forEach((id) => {
        at(t, () => {
          playSound('cardDeal');
          setRevealedHoleIds((prev) => new Set(prev).add(id));
        });
        t += SD_ALLIN_STAGGER_MS;
      });
      if (allIn.length > 0) t += 200;
      rest.forEach((id) => {
        at(t, () => {
          playSound('cardDeal');
          setRevealedHoleIds((prev) => new Set(prev).add(id));
        });
        t += SD_HOLE_STAGGER_MS;
      });
      t += allIn.length + rest.length > 0 ? 250 : 100;

      // c) 프리플랍 올인 등으로 플랍조차 아직 공개된 적이 없으면(preRevealedBoardCount < 3),
      // "플랍까지는 공개된" 기준선을 맞추기 위해 플랍 3장만 먼저 빠르게 공개한다 — 이 구간은
      // 아래 턴/리버 딜레이(SD_TURN_DELAY_MS/SD_RIVER_DELAY_MS)에 포함되지 않는 별도 준비 단계.
      if (preRevealedBoardCount < 3) {
        for (let i = preRevealedBoardCount; i < 3; i++) {
          const idx = i;
          at(t, () => {
            playSound('cardDeal');
            setBoardRevealCount((c) => Math.max(c, idx + 1));
          });
          t += SD_BOARD_STAGGER_MS;
        }
        t += SD_BOARD_SETTLE_MS;
      }

      // d) 턴 → 리버 — 이미 플랍까지 공개된 지점부터, 아직 안 나온 카드만 순서대로 공개한다.
      // 플랍 올인(preRevealedBoardCount===3)이면 턴/리버 둘 다, 턴 올인(===4)이면 리버 한 장만
      // 이 구간에서 새로 나온다. 첫 번째 신규 카드는 SD_TURN_DELAY_MS, 두 번째는 SD_RIVER_DELAY_MS
      // 뒤에 공개된다.
      const remainingDelays = [SD_TURN_DELAY_MS, SD_RIVER_DELAY_MS];
      for (let idx = Math.max(preRevealedBoardCount, 3); idx < boardCount; idx++) {
        t += remainingDelays[idx - Math.max(preRevealedBoardCount, 3)] ?? SD_RIVER_DELAY_MS;
        const revealIdx = idx;
        at(t, () => {
          playSound('cardDeal');
          setBoardRevealCount((c) => Math.max(c, revealIdx + 1));
        });
      }
      at(t, () => setBoardReplaying(false));
    } else {
      // 일반 쇼다운(리버까지 정상 베팅) — SHOW DOWN 연출/보드 리플레이 없이 홀카드만 공개
      contenders.forEach(({ sessionId }) => {
        at(t, () => {
          playSound('cardDeal');
          setRevealedHoleIds((prev) => new Set(prev).add(sessionId));
        });
        t += SD_HOLE_STAGGER_MS;
      });
      t += contenders.length > 0 ? 250 : 100;
    }

    if (hasRoulette) {
      // 1a) 원래 족보(러시안 룰렛 적용 전, 5장 커뮤니티 기준) 잠깐 노출
      at(t, () => setRouletteStage('original'));
      t += RR_ORIGINAL_MS;

      // 1b) "째깍... 째깍..." 카운트다운 — 점점 빨라진다
      at(t, () => setRouletteStage('countdown-slow'));
      for (let tt = 0; tt < RR_COUNTDOWN_SLOW_MS; tt += RR_COUNTDOWN_TICK_SLOW_MS) at(t + tt, () => playSound('tick'));
      t += RR_COUNTDOWN_SLOW_MS;
      at(t, () => setRouletteStage('countdown-fast'));
      for (let tt = 0; tt < RR_COUNTDOWN_FAST_MS; tt += RR_COUNTDOWN_TICK_FAST_MS) at(t + tt, () => playSound('tick'));
      t += RR_COUNTDOWN_FAST_MS;

      // 1c) "러시안 룰렛 발동!"
      at(t, () => {
        setRouletteStage('trigger');
        playSound('rouletteAlarm');
      });
      t += RR_TRIGGER_MS;

      // 1d) 무작위 커뮤니티 카드에 총알 구멍
      at(t, () => {
        setRouletteStage('bullet');
        setBulletRevealed(true);
        playSound('gunshot');
      });
      t += RR_BULLET_MS;

      at(t, () => setRouletteStage('none'));
      t += 250;
    } else if (isRunout) {
      // 리버 공개 후 결과 배너가 뜨기까지의 여유 — 룰렛이 없을 때만 적용(있으면 위 룰렛
      // 시퀀스 전체가 이 자리를 대신한다)
      t += SD_RESULT_DELAY_MS;
    } else {
      // 정상적으로 리버까지 베팅하며 도달한 쇼다운 — 보드 리플레이가 없어 홀카드 공개
      // 직후 곧바로 결과를 보여줘도 자연스러우니 기존과 동일하게 짧게 둔다.
      t += 150;
    }

    // e) 최종 족보 재판정 및 승자 발표
    at(t, () => setResultVisible(true));

    return () => {
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastResult]);

  const sequenceCoversThisRound = sequenceRoundRef.current !== null && sequenceRoundRef.current === gameState.round;
  /** 상대 좌석의 홀카드를 지금 공개해도 되는지 — 연출이 이 라운드를 다루고 있지 않으면
   * (아직 결과가 없거나, 이 클라이언트가 브로드캐스트를 놓치고 중간 접속한 경우) 안전하게 즉시 공개한다. */
  const isRevealedForShowdown = (sessionId: string) =>
    sessionId === mySessionId || !sequenceCoversThisRound || revealedHoleIds.has(sessionId);
  /** 총알 구멍을 지금 보여줘도 되는지 — 같은 폴백 규칙 */
  const showBulletHole = bulletRevealed || !sequenceCoversThisRound;
  /** 보드 카드를 리캡 플립 중 뒷면으로 잠깐 가려도 되는지 */
  const boardCardVisible = (i: number) => !boardReplaying || !sequenceCoversThisRound || i < boardRevealCount;

  // 러시안 룰렛 "원래 족보" — 실제 발동 전, 5장 커뮤니티 전체 기준으로 각 참가자가 무슨
  // 족보였는지. 이미 revealedHole(전원)과 community(5장)가 gameState에 다 와 있으므로
  // 서버 추가 통신 없이 클라이언트에서 그대로 재계산한다.
  const originalHands = useMemo(() => {
    if (rouletteStage !== 'original') return [];
    return gameState.players
      .filter((p) => p.revealedHole.length > 0)
      .map((p) => ({
        sessionId: p.sessionId,
        name: p.name,
        category: evaluateBest([...p.revealedHole, ...gameState.community].map(asEngineCard)).category,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rouletteStage, gameState.players, gameState.community]);

  // 카드가 바뀐 좌석/인덱스("sessionId:0"/"sessionId:1") — 잠깐 글로우를 재생하고 자동으로 사라진다
  const [glowKeys, setGlowKeys] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<CardChangeToast[]>([]);
  const toastIdRef = useRef(0);
  // 클릭해서 이름/효과 설명을 다시 확인 중인 증강 — null이면 팝업 닫힘
  const [augmentPopupId, setAugmentPopupId] = useState<string | null>(null);
  const augmentPopup = augmentPopupId ? findAugment(augmentPopupId) : null;
  const glowTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = glowTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // 팟 숫자 카운트업 — 값이 바뀔 때 스르륵 올라가듯 보이게 한다
  const potDisplay = useCountUp(potTotal, 500);

  // ── 효과음 + 칩 이동 연출 ──────────────────────────────────────────────

  // cardDeal — 내 홀카드가 새로 도착(0장→N장, 매 핸드 시작)하거나 커뮤니티 카드가
  // 새로 공개(3/4/5장째)될 때마다 짧은 딜링 사운드를 재생한다.
  const prevHoleLenRef = useRef(0);
  const prevCommunityLenRef = useRef(0);
  useEffect(() => {
    if (prevHoleLenRef.current === 0 && myHole.length > 0) playSound('cardDeal');
    prevHoleLenRef.current = myHole.length;
  }, [myHole]);
  useEffect(() => {
    if (gameState.community.length > prevCommunityLenRef.current) playSound('cardDeal');
    prevCommunityLenRef.current = gameState.community.length;
  }, [gameState.community]);

  // myTurn — 내 차례가 새로 시작되는 순간(다른 사람 차례 → 내 차례)에만 알림음
  const wasMyTurnRef = useRef(false);
  useEffect(() => {
    if (isMyTurn && !wasMyTurnRef.current) playSound('myTurn');
    wasMyTurnRef.current = isMyTurn;
  }, [isMyTurn]);

  // chipBet — 누군가의 이번 스트리트 베팅액이 늘어날 때마다(블라인드 포함) 칩 소리를
  // 재생한다. 베팅 시 좌석→팟으로 미끄러지는 칩 이동 애니메이션은 제거했다(요청) —
  // 팟→승자 방향 애니메이션(payoutFlights)은 그대로 유지.
  const prevStreetBetsRef = useRef(new Map<string, number>());
  useEffect(() => {
    let bumped = false;
    for (const p of gameState.players) {
      const prev = prevStreetBetsRef.current.get(p.sessionId) ?? 0;
      if (p.streetBet > prev) bumped = true;
      prevStreetBetsRef.current.set(p.sessionId, p.streetBet);
    }
    if (bumped) playSound('chipBet');
  }, [gameState.players]);

  // win — 이번 라운드 결과가 도착했고 내가 승자 목록에 있으면 승리 팡파레 + 팟에서
  // 승자 좌석 쪽으로 칩이 흘러가는 연출을 재생한다(승자가 여럿이면 좌석마다 각각).
  const payoutFlightNonceRef = useRef(0);
  const [payoutFlights, setPayoutFlights] = useState<{ key: number; dir: { x: number; y: number } }[]>([]);
  useEffect(() => {
    if (!lastResult) return;
    const winnerIds = lastResult.byFold
      ? [lastResult.winners[0]?.sessionId].filter((v): v is string => !!v)
      : lastResult.winners.map((w) => w.sessionId);
    if (winnerIds.includes(mySessionId)) playSound('win');

    const flights = winnerIds.map((sessionId) => {
      const p = gameState.players.find((pp) => pp.sessionId === sessionId);
      const slot = p ? toDisplaySlot(p.seatIndex, mySeatIndex) : 0;
      const base = SEAT_DIR[slot];
      return { key: ++payoutFlightNonceRef.current, dir: { x: -base.x * 0.5, y: -base.y * 0.5 } };
    });
    setPayoutFlights(flights);
    const t = setTimeout(() => setPayoutFlights([]), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastResult]);

  // 턴 타이머 — 서버의 TURN_TIMEOUT_MS를 클라이언트에서 근사 재현한다(정확한 서버
  // 데드라인 동기화 없이도 시각적 카운트다운 링을 보여주기 위한 용도). 장고의 시간으로
  // 연장되면(turnExtendedEvent) "총 시간"에 그만큼을 더한다 — 시작 시각(start)은 그대로
  // 두고 remaining 계산에만 반영하면 되므로 진행 중인 애니메이션을 끊지 않고 자연스럽게 늘어난다.
  const [turnRemainingMs, setTurnRemainingMs] = useState(TURN_TIMEOUT_MS);
  const turnExtraMsRef = useRef(0);
  useEffect(() => {
    if (!BETTING_PHASES.has(gameState.phase) || !gameState.activePlayerId) {
      setTurnRemainingMs(TURN_TIMEOUT_MS);
      turnExtraMsRef.current = 0;
      return;
    }
    const start = performance.now();
    turnExtraMsRef.current = 0;
    setTurnRemainingMs(TURN_TIMEOUT_MS);
    let raf = 0;
    const tick = () => {
      const elapsed = performance.now() - start;
      const remaining = Math.max(0, TURN_TIMEOUT_MS + turnExtraMsRef.current - elapsed);
      setTurnRemainingMs(remaining);
      if (remaining > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gameState.activePlayerId, gameState.phase]);

  // 장고의 시간 — 이 브로드캐스트가 올 때마다 진행 중인 카운트다운의 총 시간을 늘린다
  useEffect(() => {
    if (!turnExtendedEvent) return;
    turnExtraMsRef.current += turnExtendedEvent.extendMs;
    playSound('myTurn');
  }, [turnExtendedEvent]);

  const pushToast = (text: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), CARD_CHANGE_TOAST_MS);
  };

  useEffect(() => {
    if (!cardChangeEvent) return;
    playSound('cardSwap');
    const keys = cardChangeEvent.changes.map((c) => `${c.sessionId}:${c.cardIndex}`);
    setGlowKeys((prev) => new Set([...prev, ...keys]));
    for (const key of keys) {
      const existing = glowTimers.current.get(key);
      if (existing) clearTimeout(existing);
      glowTimers.current.set(
        key,
        setTimeout(() => {
          setGlowKeys((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
          glowTimers.current.delete(key);
        }, CARD_CHANGE_FX_MS),
      );
    }

    pushToast(describeCardChange(cardChangeEvent));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardChangeEvent]);

  // 서버의 짧은 시스템 알림(밑장빼기 사용/보드 리셋 등) — 카드 변경 토스트와 같은 자리에 띄운다
  useEffect(() => {
    if (!noticeEvent) return;
    pushToast(noticeEvent.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeEvent]);

  // 대풍년 — 예전엔 별도의 큰 배너(mp-big-announcement)로 화면 상단에 독립적으로 띄웠는데,
  // 카드 교체/재구성 토스트와 표시 위치(둘 다 상단 중앙)가 겹쳐서 같은 라운드에 동시 발동하면
  // 서로 가려 안 보이는 문제가 있었다 — 다른 증강 알림과 동일한 토스트 큐에 합류시켜 같은
  // 스타일/위치로, 같은 스택 안에서 순서대로 쌓이도록 통일한다.
  useEffect(() => {
    if (!bigAnnouncement) return;
    pushToast(bigAnnouncement.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bigAnnouncement]);

  // 고정 크기로 디자인된 테이블 전체를 뷰포트에 맞춰 통째로 스케일한다 — 요소 각각을
  // 반응형으로 다시 배치하는 대신 하나의 캔버스로 취급해, 화면 크기와 무관하게 상/좌/우/하
  // 좌석·보드·베팅 바의 상대적 크기 비율이 항상 그대로 유지되고 스크롤 없이 한 화면에 들어온다.
  const { ref: stageRef, scale } = useFitScale<HTMLDivElement>();

  // 승리 연출이 내 정보칸을 가리지 않도록 — 보드(커뮤니티 카드 줄)와 내 좌석 사이의 실제
  // 틈을 매번 DOM에서 직접 측정해 그 안에서만 자라도록 max-height를 계산한다. 이전엔 CSS에
  // 고정된 max-height 추정치(140px)를 썼는데, 실측해보면 이 틈은 라운드/화면 크기에 따라
  // 그보다 좁을 수 있어(대풍년으로 좌석이 커지는 경우 등) 추정치만으로는 계속 겹치는
  // 문제가 있었다 — getBoundingClientRect는 useFitScale의 transform:scale() 영향을 받으므로
  // 화면 픽셀 차이를 다시 scale로 나눠 실제 CSS 픽셀 값으로 환산한다.
  const boardCardsRef = useRef<HTMLDivElement>(null);
  const mySeatRef = useRef<HTMLDivElement>(null);
  const [resultBannerMaxHeight, setResultBannerMaxHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!lastResult) return;
    const recompute = () => {
      const boardEl = boardCardsRef.current;
      const seatEl = mySeatRef.current;
      if (!boardEl || !seatEl) return;
      const boardBottom = boardEl.getBoundingClientRect().bottom;
      const seatTop = seatEl.getBoundingClientRect().top;
      const gapCssPx = (seatTop - boardBottom) / (scale || 1);
      // marginTop(10px) + 여유(10px)를 뺀 나머지만큼만 배너가 자랄 수 있다. 최소 32px은
      // 보장해 극단적으로 좁은 화면에서도 최소 한 줄은 보이게 한다.
      setResultBannerMaxHeight(Math.max(32, gapCssPx - 20));
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [lastResult, scale]);

  return (
    <div className="mp-scale-viewport">
      <div className="mp-scale-stage" ref={stageRef} style={{ transform: `scale(${scale})` }}>
        <div className="screen room mp-table-screen">
      <div className="scanlines" />
      <div className="mp-round-badge">
        라운드 {gameState.round}/{gameState.maxRounds}
      </div>

      {/* 카드 변경/대풍년 등 증강 알림 토스트 — 전부 같은 스택에 쌓여 순서대로 표시된다
          ("OO님의 카드가 XX 효과로 바뀌었습니다", "🌾 대풍년 발동!" 등) */}
      <div className="mp-cardchange-toast-stack">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              className="mp-cardchange-toast"
              initial={{ opacity: 0, y: -10, scale: 0.7 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 320, damping: 18 }}
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="mp-game-layout">
        <div className="mp-table-main">
          <div
            className={`mp-table-area${
              rouletteStage === 'countdown-fast'
                ? ' mp-roulette-shake'
                : rouletteStage === 'countdown-slow'
                  ? ' mp-roulette-shake-soft'
                  : ''
            }`}
          >
            <div className="mp-center-board">
              <div className="pot-capsule">
                <span className="pot-value">{potDisplay.toLocaleString()} 골드</span>
                <AnimatePresence>
                  {payoutFlights.map((f) => (
                    <motion.span
                      key={f.key}
                      className="mp-chip-fly mp-chip-fly-payout"
                      initial={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                      animate={{ opacity: 0, x: f.dir.x, y: f.dir.y, scale: 0.7 }}
                      transition={{ duration: 0.6, ease: 'easeIn' }}
                    >
                      🪙
                    </motion.span>
                  ))}
                </AnimatePresence>
              </div>
              <div className="card-row board-cards" ref={boardCardsRef}>
                {gameState.community.map((c, i) => {
                  const isRemoved = removedCardId === c.id;
                  const showBullet = isRemoved && showBulletHole;
                  const visible = boardCardVisible(i);
                  return (
                    <span key={c.id} className={`mp-board-card-slot${showBullet ? ' mp-board-card-removed' : ''}`}>
                      <Card
                        card={asEngineCard(c)}
                        hidden={!visible}
                        flip
                        dealDelay={(i % 3) * 0.12}
                        highlight={!!myBestFiveIds?.has(c.id)}
                      />
                      {showBullet && (
                        <span className="mp-bullet-hole" title="러시안 룰렛으로 판정에서 제외된 카드" aria-hidden="true" />
                      )}
                    </span>
                  );
                })}
                {Array.from({ length: 5 - gameState.community.length }).map((_, i) => (
                  <Card key={`ph-${i}`} />
                ))}
              </div>
              {/* 승리 연출은 보드(팟+커뮤니티 카드)와 하단 내 좌석 사이의 빈 공간에 띄운다 —
                  .mp-center-board(position:relative)는 팟 캡슐+커뮤니티 카드 두 줄로만 높이가
                  정해지고 이 배너는 absolute라 그 높이 계산에서 빠지므로, top:100%는 정확히
                  "커뮤니티 카드 줄 바로 아래"를 가리킨다. 그 아래로는 내 좌석의 닉네임/칩 박스가
                  있으므로, CSS 추정치 대신 resultBannerMaxHeight(실측값)로 이 틈 안에서만
                  자라도록 제한한다(넘치면 내부 스크롤 — 절대 내 좌석을 침범하지 않는다).
                  쇼다운 순차 공개 연출 중에는(byFold가 아닌 결과) resultVisible이 될 때까지
                  기다렸다가 등장한다 — 폴드 승은 연출이 없으니 즉시 보여준다. */}
              <AnimatePresence>
                {lastResult && (lastResult.byFold || resultVisible) && (
                  <ResultBanner key="result" result={lastResult} maxHeight={resultBannerMaxHeight} />
                )}
              </AnimatePresence>
            </div>

            {gameState.players.map((p) => (
              <DiamondSeat
                key={p.sessionId}
                player={p}
                isMe={p.sessionId === mySessionId}
                myHole={myHole}
                isDealer={p.seatIndex === gameState.dealerSeat}
                isActive={p.sessionId === gameState.activePlayerId}
                diamondSlot={toDisplaySlot(p.seatIndex, mySeatIndex)}
                dealEpoch={gameState.round}
                reveal={augmentReveal?.targetSessionId === p.sessionId ? augmentReveal : null}
                glowKeys={glowKeys}
                community={communityForEval}
                canSwap={canSwap}
                onSwapCard={onSwapCard}
                onAugmentClick={setAugmentPopupId}
                turnRemainingMs={turnRemainingMs}
                turnTotalMs={TURN_TIMEOUT_MS}
                compact={compactHands}
                rootRef={p.sessionId === mySessionId ? mySeatRef : undefined}
                revealedForShowdown={isRevealedForShowdown(p.sessionId)}
              />
            ))}

            {/* 테이블(.mp-table-area) 우측 하단 모서리에 고정 — 특정 좌석에 종속되지 않으므로
                내 시점에 따라 어느 플레이어가 우측/하단에 오든 항상 같은 자리에 위치한다 */}
            <InfoPanel myHole={myHole} community={communityForEval} />

            {/* 쇼다운 "SHOW DOWN" 텍스트 + 러시안 룰렛 원래 족보/카운트다운/발동 텍스트 —
                테이블 전체를 덮는 중앙 오버레이. pointer-events:none이라 아래 좌석/버튼 클릭을 막지 않는다. */}
            <div className="mp-showdown-overlay">
              <AnimatePresence>
                {showdownTextOn && (
                  <motion.div
                    key="showdown-text"
                    className="mp-showdown-text"
                    initial={{ opacity: 0, scale: 0.4, rotate: -6 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    exit={{ opacity: 0, scale: 1.3 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 16 }}
                  >
                    SHOW DOWN
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {rouletteStage === 'original' && (
                  <motion.div
                    key="roulette-original"
                    className="mp-original-hands-panel"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <div className="mp-original-hands-title">원래 족보</div>
                    <div className="mp-original-hands-list">
                      {originalHands.map((h) => (
                        <div key={h.sessionId} className="mp-original-hand-row">
                          <span className="mp-original-hand-name">{h.name}</span>
                          {CATEGORY_NAMES_KO[h.category]}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {(rouletteStage === 'countdown-slow' || rouletteStage === 'countdown-fast') && (
                  <motion.div
                    key="roulette-countdown"
                    className={`mp-roulette-countdown-text ${
                      rouletteStage === 'countdown-fast' ? 'mp-tick-fast' : 'mp-tick-slow'
                    }`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    째깍... 째깍...
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {rouletteStage === 'trigger' && (
                  <motion.div
                    key="roulette-trigger"
                    className="mp-roulette-trigger-text"
                    initial={{ opacity: 0, scale: 0.3 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 1.4 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 14 }}
                  >
                    🔫 러시안 룰렛 발동!
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className={`mp-bottom-panel${isMyTurn ? ' mp-bottom-panel-my-turn' : ''}`}>
            <div className="mp-bottom-action">
              {canAct && myPlayer ? (
                <div className="mp-action-with-extra">
                  <BettingActionBar gameState={gameState} myPlayer={myPlayer} onAction={onAction} />
                  {resetBoardVisible && (
                    <button
                      type="button"
                      className={`bet-btn mp-reset-board-btn${resetBoardEnabled ? '' : ' mp-reset-board-btn-disabled'}`}
                      disabled={!resetBoardEnabled}
                      title={
                        resetBoardEnabled
                          ? '현재 커뮤니티 카드를 전부 회수하고 다시 딜링합니다 (라운드당 1회)'
                          : '플랍(3번째 보드 카드) 공개 시점까지만 사용할 수 있습니다'
                      }
                      onClick={
                        resetBoardEnabled
                          ? () => {
                              playSound('buttonClick');
                              onResetBoard();
                            }
                          : undefined
                      }
                    >
                      🔄 리셋
                    </button>
                  )}
                  {extendTimerVisible && (
                    <button
                      type="button"
                      className={`bet-btn mp-extend-timer-btn${extendTimerEnabled ? '' : ' mp-extend-timer-btn-disabled'}`}
                      disabled={!extendTimerEnabled}
                      title={
                        extendTimerEnabled
                          ? '내 턴 제한시간을 15초 연장합니다 (게임 전체 1회)'
                          : '이미 사용했습니다 (게임 전체 1회)'
                      }
                      onClick={
                        extendTimerEnabled
                          ? () => {
                              playSound('buttonClick');
                              onExtendTurnTimer();
                            }
                          : undefined
                      }
                    >
                      ⏳ 시간 연장
                    </button>
                  )}
                </div>
              ) : gameState.phase === 'augment_target' ? (
                <p className="mp-waiting-turn">플레이어들이 즉시형 증강 효과 대상을 지정하는 중입니다...</p>
              ) : gameState.phase === 'street_reveal_choice' ? (
                <p className="mp-waiting-turn">밑장빼기 사용 여부를 확인하는 중입니다...</p>
              ) : gameState.phase === 'augment_select' ? (
                <p className="mp-waiting-turn">잠시 후 증강 선택 화면이 열립니다...</p>
              ) : (
                BETTING_PHASES.has(gameState.phase) && (
                  <p className="mp-waiting-turn">
                    {activePlayer ? `${activePlayer.name}님의 차례를 기다리는 중...` : '다음 차례를 기다리는 중...'}
                  </p>
                )
              )}
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {augmentPopup && <AugmentInfoPopup key={augmentPopup.id} augment={augmentPopup} onClose={() => setAugmentPopupId(null)} />}
      </AnimatePresence>
      </div>
      </div>
    </div>
  );
}
