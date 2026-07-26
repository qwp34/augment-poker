import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from './Card';
import augmentsData from '../data/augments.json';
import type { Augment } from '../engine/augmentEngine';
import type { Card as EngineCard, Rank } from '../engine/types';
import { RANKS, SUITS, SUIT_SYMBOLS, rankLabel } from '../engine/types';
import type { AugmentTargetRequest, ClientCard } from '../net/useMultiplayerRoom';

const AUGMENT_POOL = augmentsData as Augment[];
const CARD_BACK: ClientCard = { id: 'back', suit: 'spades', rank: 2, isJoker: false };

function findAugment(id: string): Augment | undefined {
  return AUGMENT_POOL.find((a) => a.id === id);
}

function asEngineCard(c: ClientCard): EngineCard {
  return c as unknown as EngineCard;
}

export interface AugmentTargetPayload {
  targetSessionId?: string;
  targetCardIndex?: 0 | 1;
  ownCardIndex?: 0 | 1;
  cardIndex?: 0 | 1;
  rank?: number;
  suit?: string;
}

interface AugmentTargetScreenProps {
  request: AugmentTargetRequest;
  myHole: ClientCard[];
  onSubmit: (payload: AugmentTargetPayload) => void;
}

type Step = 'opponent' | 'targetCard' | 'ownCard' | 'rank' | 'suit';

/**
 * 즉시형 증강(음침한 눈/카멜레온/당근이세요?)의 대상 지정 모달.
 *
 * 단계마다 "먼저 골라서 하이라이트만 표시 → 확인 버튼을 눌러야 다음 단계로 진행"하는
 * 방식이다. 예전엔 옵션을 클릭하는 즉시 확정 + 다음 단계로 넘어가서, 뭘 골랐는지
 * 인지하기도 전에 화면이 휙휙 지나가 버리는 문제가 있었다 — 확인 단계를 하나 끼워 넣어
 * "지금 내가 선택해야 하는 타이밍"임을 명확히 인지하고 실수로 잘못 고르지 않게 한다.
 */
export function AugmentTargetScreen({ request, myHole, onSubmit }: AugmentTargetScreenProps) {
  const augment = findAugment(request.augmentId);
  const { effectType, opponents } = request;

  const [targetSessionId, setTargetSessionId] = useState<string | null>(
    opponents.length === 1 ? opponents[0].sessionId : null,
  );
  const [targetCardIndex, setTargetCardIndex] = useState<0 | 1 | null>(null);
  const [ownCardIndex, setOwnCardIndex] = useState<0 | 1 | null>(null);
  const [rank, setRank] = useState<Rank | null>(null);

  // 현재 단계에서 "골랐지만 아직 확정하지 않은" 값 — 확인을 눌러야 실제로 반영된다
  const [draft, setDraft] = useState<string | number | null>(null);

  const needsOpponent = effectType === 'reveal_opponent_card' || effectType === 'swap_with_opponent';
  const step: Step =
    needsOpponent && targetSessionId === null
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

  const targetName = opponents.find((o) => o.sessionId === targetSessionId)?.name ?? '';

  const stepHint: Record<Step, string> = {
    opponent: '대상 플레이어를 고른 뒤 확인을 누르세요',
    targetCard: `${targetName}의 홀카드 중 확인할 카드를 고른 뒤 확인을 누르세요`,
    ownCard: `${effectType === 'edit_own_card' ? '바꿀' : '내줄'} 내 카드를 고른 뒤 확인을 누르세요`,
    rank: '원하는 숫자를 고른 뒤 확인을 누르세요',
    suit: '원하는 무늬를 고른 뒤 확인을 누르세요',
  };

  /** 확인 클릭 — 이번 단계의 드래프트를 확정한다. 마지막 단계였다면 곧바로 서버에 제출한다 */
  const handleConfirm = () => {
    if (draft === null) return;
    switch (step) {
      case 'opponent':
        setTargetSessionId(draft as string);
        return;
      case 'targetCard': {
        const idx = draft as 0 | 1;
        if (effectType === 'reveal_opponent_card') {
          onSubmit({ targetSessionId: targetSessionId!, targetCardIndex: idx });
          return;
        }
        setTargetCardIndex(idx);
        return;
      }
      case 'ownCard': {
        const idx = draft as 0 | 1;
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
          <h2 className="mp-target-title">{augment.name}</h2>
          <p className="mp-target-desc">{augment.description}</p>
          <p className="mp-target-hint">{stepHint[step]}</p>

          {step === 'opponent' && (
            <div className="mp-target-choice-row">
              {opponents.map((o) => (
                <button
                  key={o.sessionId}
                  className={`mp-target-choice-btn${draft === o.sessionId ? ' mp-target-selected' : ''}`}
                  onClick={() => setDraft(o.sessionId)}
                >
                  {o.name}
                </button>
              ))}
            </div>
          )}

          {step === 'targetCard' && (
            <div className="mp-target-choice-row">
              {[0, 1].map((idx) => (
                <button
                  key={idx}
                  className={`mp-target-card-btn${draft === idx ? ' mp-target-selected' : ''}`}
                  onClick={() => setDraft(idx)}
                >
                  <Card card={asEngineCard(CARD_BACK)} hidden size="sm" />
                  <span>{idx === 0 ? '첫 번째 카드' : '두 번째 카드'}</span>
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
                  onClick={() => setDraft(idx)}
                >
                  <Card card={asEngineCard(c)} size="sm" />
                  <span>{idx === 0 ? '첫 번째 카드' : '두 번째 카드'}</span>
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
                  onClick={() => setDraft(r)}
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
                  onClick={() => setDraft(s)}
                >
                  {SUIT_SYMBOLS[s]}
                </button>
              ))}
            </div>
          )}

          <button className="mp-target-confirm-btn" disabled={draft === null} onClick={handleConfirm}>
            확인
          </button>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
