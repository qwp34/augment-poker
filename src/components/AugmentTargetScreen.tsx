import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from './Card';
import augmentsData from '../data/augments.json';
import type { Augment } from '../engine/augmentEngine';
import { CATEGORY_NAMES_KO, HAND_CATEGORY_ORDER } from '../engine/handEvaluator';
import type { Card as EngineCard, Rank } from '../engine/types';
import { RANKS, SUITS, SUIT_SYMBOLS, rankLabel } from '../engine/types';
import type { AugmentTargetRequest, ClientCard } from '../net/useMultiplayerRoom';
import { playSound } from '../utils/sounds';

const AUGMENT_POOL = augmentsData as Augment[];

function findAugment(id: string): Augment | undefined {
  return AUGMENT_POOL.find((a) => a.id === id);
}

function asEngineCard(c: ClientCard): EngineCard {
  return c as unknown as EngineCard;
}

export interface AugmentTargetPayload {
  targetSessionId?: string;
  /** 대풍년으로 홀카드가 3장일 수 있어 0|1로 고정하지 않는다 */
  targetCardIndex?: number;
  ownCardIndex?: number;
  cardIndex?: number;
  rank?: number;
  suit?: string;
  handType?: string;
}

/** "첫 번째 카드"/"두 번째 카드"... — 대풍년으로 3장까지 나올 수 있어 하드코딩 2개로는
 *  부족하다. 정의된 범위를 넘어서면(이론상 발생하지 않지만) "N번째 카드"로 대체한다. */
const ORDINAL_KO = ['첫 번째', '두 번째', '세 번째', '네 번째'];
function cardOrdinalLabel(idx: number): string {
  return `${ORDINAL_KO[idx] ?? `${idx + 1}번째`} 카드`;
}

interface AugmentTargetScreenProps {
  request: AugmentTargetRequest;
  myHole: ClientCard[];
  onSubmit: (payload: AugmentTargetPayload) => void;
  /** 이미 보유한 이 증강을 이번 핸드엔 사용하지 않고 넘어간다(다음 핸드에 다시 재발동될 수 있음) */
  onSkip: () => void;
}

type Step = 'opponent' | 'targetCard' | 'ownCard' | 'rank' | 'suit' | 'handType';

/**
 * 즉시형 증강(음침한 눈/카멜레온/당근이세요?)의 대상 지정 모달 — 이미 보유한 증강이 매 핸드
 * 재발동될 때 뜬다. 우상단 ✕를 누르면 지금 진행 중인 단계와 무관하게 이번 핸드는 이 증강을
 * 사용하지 않고 넘어간다.
 *
 * 단계마다 "먼저 골라서 하이라이트만 표시 → 확인 버튼을 눌러야 다음 단계로 진행"하는
 * 방식이다. 예전엔 옵션을 클릭하는 즉시 확정 + 다음 단계로 넘어가서, 뭘 골랐는지
 * 인지하기도 전에 화면이 휙휙 지나가 버리는 문제가 있었다 — 확인 단계를 하나 끼워 넣어
 * "지금 내가 선택해야 하는 타이밍"임을 명확히 인지하고 실수로 잘못 고르지 않게 한다.
 */
export function AugmentTargetScreen({ request, myHole, onSubmit, onSkip }: AugmentTargetScreenProps) {
  const augment = findAugment(request.augmentId);
  const { effectType, opponents } = request;

  const [targetSessionId, setTargetSessionId] = useState<string | null>(
    opponents.length === 1 ? opponents[0].sessionId : null,
  );
  const [targetCardIndex, setTargetCardIndex] = useState<number | null>(null);
  const [ownCardIndex, setOwnCardIndex] = useState<number | null>(null);
  const [rank, setRank] = useState<Rank | null>(null);

  // 현재 단계에서 "골랐지만 아직 확정하지 않은" 값 — 확인을 눌러야 실제로 반영된다
  const [draft, setDraft] = useState<string | number | null>(null);

  const selectDraft = (value: string | number) => {
    playSound('buttonClick');
    setDraft(value);
  };

  const needsOpponent = effectType === 'reveal_opponent_card' || effectType === 'swap_with_opponent';
  const step: Step =
    effectType === 'declare_hand'
      ? 'handType' // 예고 홈런 — 대상/카드 없이 목표 족보 하나만 고르는 단일 단계
      : needsOpponent && targetSessionId === null
        ? 'opponent'
        : needsOpponent && targetCardIndex === null
          ? 'targetCard'
          : effectType === 'edit_own_card' && ownCardIndex === null
            ? 'ownCard'
            : effectType === 'edit_own_card' && rank === null
              ? 'rank'
              : effectType === 'edit_own_card'
                ? 'suit'
                : 'ownCard'; // swap의 마지막 단계 — 내 카드 선택

  // 단계가 바뀌면(직전 확인으로 다음 단계 진입) 드래프트를 비운다
  useEffect(() => {
    setDraft(null);
  }, [step]);

  if (!augment) return null;

  const targetOpponent = opponents.find((o) => o.sessionId === targetSessionId);
  const targetName = targetOpponent?.name ?? '';
  // 대풍년으로 상대 홀카드가 3장일 수 있어, "몇 번째 카드" 선택지도 실제 장수만큼 그린다
  const targetHoleCount = targetOpponent?.holeCount ?? 2;

  const stepHint: Record<Step, string> = {
    opponent: '대상 플레이어를 고른 뒤 확인을 누르세요',
    targetCard: `${targetName}의 홀카드 중 확인할 카드를 고른 뒤 확인을 누르세요`,
    ownCard: `${effectType === 'edit_own_card' ? '바꿀' : '내줄'} 내 카드를 고른 뒤 확인을 누르세요`,
    rank: '원하는 숫자를 고른 뒤 확인을 누르세요',
    suit: '원하는 무늬를 고른 뒤 확인을 누르세요',
    handType: '이번 판에 완성할 목표 족보를 고른 뒤 확인을 누르세요',
  };

  /** 확인 클릭 — 이번 단계의 드래프트를 확정한다. 마지막 단계였다면 곧바로 서버에 제출한다 */
  const handleConfirm = () => {
    if (draft === null) return;
    switch (step) {
      case 'opponent':
        setTargetSessionId(draft as string);
        return;
      case 'targetCard': {
        const idx = draft as number;
        if (effectType === 'reveal_opponent_card') {
          onSubmit({ targetSessionId: targetSessionId!, targetCardIndex: idx });
          return;
        }
        setTargetCardIndex(idx);
        return;
      }
      case 'ownCard': {
        const idx = draft as number;
        if (effectType === 'edit_own_card') {
          setOwnCardIndex(idx);
          return;
        }
        onSubmit({ targetSessionId: targetSessionId!, targetCardIndex: targetCardIndex!, ownCardIndex: idx });
        return;
      }
      case 'rank':
        setRank(draft as Rank);
        return;
      case 'suit':
        onSubmit({ cardIndex: ownCardIndex!, rank: rank!, suit: draft as string });
        return;
      case 'handType':
        onSubmit({ handType: draft as string });
        return;
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        className="mp-target-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <motion.div
          className={`mp-target-modal rarity-${augment.rarity}`}
          initial={{ scale: 0.85, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 22 }}
        >
          <button
            type="button"
            className="mp-target-skip"
            aria-label="이 증강 사용하지 않기"
            title="이번 핸드엔 사용 안 함"
            onClick={() => {
              playSound('buttonClick');
              onSkip();
            }}
          >
            ✕
          </button>
          <h2 className="mp-target-title">{augment.name}</h2>
          <p className="mp-target-desc">{augment.description}</p>
          <p className="mp-target-hint">{stepHint[step]}</p>

          {step === 'opponent' && (
            <div className="mp-target-choice-row">
              {opponents.map((o) => (
                <button
                  key={o.sessionId}
                  className={`mp-target-choice-btn${draft === o.sessionId ? ' mp-target-selected' : ''}`}
                  onClick={() => selectDraft(o.sessionId)}
                >
                  {o.name}
                </button>
              ))}
            </div>
          )}

          {step === 'targetCard' && (
            <div className="mp-target-choice-row">
              {Array.from({ length: targetHoleCount }, (_, idx) => idx).map((idx) => (
                <button
                  key={idx}
                  className={`mp-target-card-btn${draft === idx ? ' mp-target-selected' : ''}`}
                  onClick={() => selectDraft(idx)}
                >
                  <Card hidden size="sm" />
                  <span>{cardOrdinalLabel(idx)}</span>
                </button>
              ))}
            </div>
          )}

          {step === 'ownCard' && (
            <div className="mp-target-choice-row">
              {myHole.map((c, idx) => (
                <button
                  key={c.id}
                  className={`mp-target-card-btn${draft === idx ? ' mp-target-selected' : ''}`}
                  onClick={() => selectDraft(idx)}
                >
                  <Card card={asEngineCard(c)} size="sm" />
                  <span>{cardOrdinalLabel(idx)}</span>
                </button>
              ))}
            </div>
          )}

          {step === 'rank' && (
            <div className="mp-target-rank-grid">
              {RANKS.map((r) => (
                <button
                  key={r}
                  className={`mp-target-rank-btn${draft === r ? ' mp-target-selected' : ''}`}
                  onClick={() => selectDraft(r)}
                >
                  {rankLabel(r)}
                </button>
              ))}
            </div>
          )}

          {step === 'suit' && (
            <div className="mp-target-choice-row">
              {SUITS.map((s) => (
                <button
                  key={s}
                  className={`mp-target-suit-btn ${s === 'hearts' || s === 'diamonds' ? 'suit-red' : 'suit-black'}${
                    draft === s ? ' mp-target-selected' : ''
                  }`}
                  onClick={() => selectDraft(s)}
                >
                  {SUIT_SYMBOLS[s]}
                </button>
              ))}
            </div>
          )}

          {step === 'handType' && (
            <div className="mp-target-handtype-grid">
              {HAND_CATEGORY_ORDER.map((cat) => (
                <button
                  key={cat}
                  className={`mp-target-handtype-btn${draft === cat ? ' mp-target-selected' : ''}`}
                  onClick={() => selectDraft(cat)}
                >
                  {CATEGORY_NAMES_KO[cat]}
                </button>
              ))}
            </div>
          )}

          <button
            className="mp-target-confirm-btn"
            disabled={draft === null}
            onClick={() => {
              playSound('buttonClick');
              handleConfirm();
            }}
          >
            확인
          </button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
