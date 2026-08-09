import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from './Card';
import { AugmentCard } from './AugmentCard';
import augmentsData from '../data/augments.json';
import { RARITY_NAMES_KO, type Augment } from '../engine/augmentEngine';
import { evaluateBest, CATEGORY_NAMES_KO, type HandCategory } from '../engine/handEvaluator';
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
/** 하이카드 ~ 로열스트레이트플러시, 오름차순(handEvaluator의 내부 랭킹과 동일한 순서) */
const HAND_CATEGORY_ORDER: HandCategory[] = [
  'high_card',
  'pair',
  'two_pair',
  'three_of_a_kind',
  'straight',
  'flush',
  'full_house',
  'four_of_a_kind',
  'straight_flush',
  'royal_flush',
];

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
  /** 카드 재구성 — 내 홀카드 index(0|1)를 새 카드로 교체 요청 (isMe 좌석에서만 의미 있음) */
  onSwapCard: (index: 0 | 1) => void;
  /** 증강 뱃지를 클릭했을 때 — 이름/효과 설명 팝업을 띄우기 위해 상위(PokerTable)로 알린다 */
  onAugmentClick: (augmentId: string) => void;
  /** 현재 차례인 좌석에서만 사용 — 턴 타이머 테두리에 표시할 잔여/총 시간(ms) */
  turnRemainingMs: number;
  turnTotalMs: number;
  /** 대풍년으로 이번 라운드 홀카드가 3장인 상태 — 카드/정보 박스/증강 뱃지를 통째로 축소해
   * 3장이어도 좌석이 테이블 바깥으로 튀어나가지 않게 한다 */
  compact: boolean;
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
}: DiamondSeatProps) {
  const holeCards: ClientCard[] = isMe ? myHole : player.revealedHole.length > 0 ? player.revealedHole : EMPTY_HOLE;
  // 폴드한 플레이어도 카드 자리는 그대로 유지(뒷면을 흐리게 표시)한다 — 그래야 자리마다 높이가
  // 들쭉날쭉해지지 않고, 그 아래/옆의 증강 뱃지가 폴드 여부에 따라 위치를 옮기지 않는다.
  const showBacks = holeCards.length === 0;
  const bestFiveIds = useMemo(() => computeBestFiveIds(holeCards, community), [holeCards, community]);
  const dealFrom = SEAT_DIR[diamondSlot];

  return (
    <div
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
          </div>
          <div className="mp-seat-cards">
            {showBacks
              ? // 대풍년 보유자가 있으면 전원 3장 — 상대방 카드는 쇼다운 전까지 값을 알 수 없으니
                // holeCount(공개 동기화 필드)로 뒷면 자리 개수만 정확히 맞춰 렌더링한다.
                // key에 dealEpoch(라운드 번호)를 포함해 매 핸드 딜링 모션이 다시 재생되게 한다.
                Array.from({ length: player.holeCount || 2 }, (_, idx) => idx).map((idx) =>
                  reveal && reveal.cardIndex === idx ? (
                    // 음침한 눈으로 확인한 카드 — 뒷면 대신 실제 카드 + 눈 표식 (나에게만 렌더됨)
                    <span key={idx} className="mp-revealed-card" title="음침한 눈으로 확인한 카드">
                      <Card card={asEngineCard(reveal.card)} size="sm" />
                      <span className="mp-revealed-eye">👁</span>
                    </span>
                  ) : (
                    <Card
                      key={`${idx}-${dealEpoch}`}
                      hidden
                      size="sm"
                      dealFrom={dealFrom}
                      dealDelay={idx * 0.12}
                      changeFx={glowKeys.has(`${player.sessionId}:${idx}`)}
                    />
                  ),
                )
              : holeCards.map((c, idx) => (
                  <Card
                    key={c.id}
                    card={asEngineCard(c)}
                    size="sm"
                    dealFrom={dealFrom}
                    dealDelay={idx * 0.12}
                    flip={!isMe}
                    clickable={isMe && canSwap}
                    onClick={
                      isMe && canSwap
                        ? () => {
                            playSound('buttonClick');
                            onSwapCard(idx as 0 | 1);
                          }
                        : undefined
                    }
                    changeFx={glowKeys.has(`${player.sessionId}:${idx}`)}
                    highlight={!!bestFiveIds?.has(c.id)}
                  />
                ))}
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

function ResultBanner({ result }: { result: ShowdownResult }) {
  return (
    <motion.div
      className="mp-result-banner"
      // framer-motion은 animate 대상 축(x/y/scale)을 자기가 직접 관리하는 transform으로
      // 합성해 CSS의 transform 선언을 덮어써버린다 — 그래서 가로 중앙 정렬(-50%)도 CSS가
      // 아니라 여기 x 값으로 명시해야 한다(그렇지 않으면 CSS의 translateX(-50%)가 무시돼
      // 박스가 중앙에서 오른쪽으로 치우쳐 보인다).
      initial={{ opacity: 0, x: '-50%', y: -20, scale: 0.9 }}
      animate={{ opacity: 1, x: '-50%', y: 0, scale: 1 }}
      exit={{ opacity: 0, x: '-50%' }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
    >
      {result.byFold ? (
        <div className="mp-result-line">
          <div className="mp-result-winner-name">
            🏆 <strong>{result.winners[0]?.name}</strong> 승리 — 상대 다이
          </div>
          <div className="mp-result-payout-row">
            <span className="mp-result-payout">+{result.winners[0]?.payout.toLocaleString()} 골드</span>
          </div>
        </div>
      ) : (
        result.winners.map((w) => (
          <div key={w.sessionId} className="mp-result-line">
            <div className="mp-result-winner-name">
              🏆 <strong>{w.name}</strong>
            </div>
            {/* 족보 이름 — 한눈에 보이도록 별도 줄에 크고 굵게 표시 */}
            {w.category && (
              <div className="mp-result-category">{CATEGORY_SHORT_KO[w.category as HandCategory] ?? w.category}</div>
            )}
            <div className="mp-result-payout-row">
              <span className="mp-result-payout">+{w.payout.toLocaleString()} 골드</span>
              {w.multiplier && w.multiplier > 1 && (
                <span className="mp-result-multiplier">×{w.multiplier} 배당!</span>
              )}
            </div>
            {w.augments && w.augments.length > 0 && (
              <div className="augment-chip-row">
                {w.augments.map((name) => (
                  <span key={name} className="augment-chip rarity-prismatic">
                    ⚡ {name}
                  </span>
                ))}
              </div>
            )}
          </div>
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
  onAction: (type: BettingActionType, amount?: number) => void;
  /** 카드 재구성 — 내 홀카드 index(0|1)를 새 카드로 교체 요청 */
  onSwapCard: (index: 0 | 1) => void;
  /** 리셋 버튼 — 본인 차례에 현재 커뮤니티 카드를 전부 회수하고 다시 딜링 요청 */
  onResetBoard: () => void;
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
  onAction,
  onSwapCard,
  onResetBoard,
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

  // 러시안 룰렛이 발동한 쇼다운 직후(round_end)에는 서버가 실제 판정에서 커뮤니티 카드
  // 1장을 제외했다 — 하이라이트/족보 계산도 그 카드를 똑같이 빼고 해야, 화면에 표시되는
  // "최고 족보" 카드/텍스트가 서버가 선언한 승자 족보(ResultBanner)와 어긋나지 않는다.
  const communityForEval = useMemo(
    () =>
      lastResult?.removedCommunityCardId
        ? gameState.community.filter((c) => c.id !== lastResult.removedCommunityCardId)
        : gameState.community,
    [gameState.community, lastResult?.removedCommunityCardId],
  );

  // 내 관점에서 실시간(또는 쇼다운) 최고 족보를 구성하는 카드 — 홀카드/보드에 골드 하이라이트
  const myBestFiveIds = useMemo(() => computeBestFiveIds(myHole, communityForEval), [myHole, communityForEval]);

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
  // 데드라인 동기화 없이도 시각적 카운트다운 링을 보여주기 위한 용도).
  const [turnRemainingMs, setTurnRemainingMs] = useState(TURN_TIMEOUT_MS);
  useEffect(() => {
    if (!BETTING_PHASES.has(gameState.phase) || !gameState.activePlayerId) {
      setTurnRemainingMs(TURN_TIMEOUT_MS);
      return;
    }
    const start = performance.now();
    setTurnRemainingMs(TURN_TIMEOUT_MS);
    let raf = 0;
    const tick = () => {
      const elapsed = performance.now() - start;
      const remaining = Math.max(0, TURN_TIMEOUT_MS - elapsed);
      setTurnRemainingMs(remaining);
      if (remaining > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gameState.activePlayerId, gameState.phase]);

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

  // 대풍년처럼 화면 전체에 크게 알려야 하는 이벤트 — 작은 토스트로는 눈에 안 띄어서
  // 별도의 큰 배너로 2.5초간 표시한다 (딜링 연출을 가리지 않도록 테이블 상단에 배치)
  const [visibleBigAnnouncement, setVisibleBigAnnouncement] = useState<BigAnnouncementEvent | null>(null);
  useEffect(() => {
    if (!bigAnnouncement) return;
    setVisibleBigAnnouncement(bigAnnouncement);
    const t = setTimeout(() => setVisibleBigAnnouncement(null), 2500);
    return () => clearTimeout(t);
  }, [bigAnnouncement]);

  // 고정 크기로 디자인된 테이블 전체를 뷰포트에 맞춰 통째로 스케일한다 — 요소 각각을
  // 반응형으로 다시 배치하는 대신 하나의 캔버스로 취급해, 화면 크기와 무관하게 상/좌/우/하
  // 좌석·보드·베팅 바의 상대적 크기 비율이 항상 그대로 유지되고 스크롤 없이 한 화면에 들어온다.
  const { ref: stageRef, scale } = useFitScale<HTMLDivElement>();

  return (
    <div className="mp-scale-viewport">
      <div className="mp-scale-stage" ref={stageRef} style={{ transform: `scale(${scale})` }}>
        <div className="screen room mp-table-screen">
      <div className="scanlines" />
      <div className="mp-round-badge">
        라운드 {gameState.round}/{gameState.maxRounds}
      </div>

      {/* 대풍년처럼 화면 전체에 크게 알려야 하는 이벤트 — 좌석/카드를 가리지 않는 테이블
          상단에 큼직하게 띄운다 (딜링 연출은 그 아래에서 그대로 보임) */}
      <AnimatePresence>
        {visibleBigAnnouncement && (
          <motion.div
            key={visibleBigAnnouncement.id}
            className="mp-big-announcement"
            initial={{ opacity: 0, y: -16, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
          >
            {visibleBigAnnouncement.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 카드 변경 알림 토스트 — "OO님의 카드가 XX 효과로 바뀌었습니다" */}
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
          <div className="mp-table-area">
            <div className="mp-center-board">
              <div className="pot-capsule">
                <span className="pot-value">{potDisplay.toLocaleString()} 골드</span>
                {/* 승리 연출은 POT 표시 위치에 그대로 겹쳐 뜬다 — 특정 좌석(닉네임/칩/핸드)을
                    가리지 않는 유일하게 안전한 중앙 자리라서, POT 캡슐 정중앙에 자체 배경으로
                    덮어씌워 보여준다(POT 숫자 자체는 DOM에 남아있지만 시각적으로 가려진다) */}
                <AnimatePresence>{lastResult && <ResultBanner key="result" result={lastResult} />}</AnimatePresence>
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
              <div className="card-row board-cards">
                {gameState.community.map((c, i) => {
                  const removed = lastResult?.removedCommunityCardId === c.id;
                  return (
                    <span key={c.id} className={`mp-board-card-slot${removed ? ' mp-board-card-removed' : ''}`}>
                      <Card
                        card={asEngineCard(c)}
                        flip
                        dealDelay={(i % 3) * 0.12}
                        highlight={!!myBestFiveIds?.has(c.id)}
                      />
                      {removed && (
                        <span className="mp-removed-x" title="러시안 룰렛으로 판정에서 제외된 카드">
                          ✕
                        </span>
                      )}
                    </span>
                  );
                })}
                {Array.from({ length: 5 - gameState.community.length }).map((_, i) => (
                  <Card key={`ph-${i}`} />
                ))}
              </div>
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
              />
            ))}

            {/* 테이블(.mp-table-area) 우측 하단 모서리에 고정 — 특정 좌석에 종속되지 않으므로
                내 시점에 따라 어느 플레이어가 우측/하단에 오든 항상 같은 자리에 위치한다 */}
            <InfoPanel myHole={myHole} community={communityForEval} />
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
