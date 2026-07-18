import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card } from './Card';
import augmentsData from '../data/augments.json';
import type { Augment } from '../engine/augmentEngine';
import type { Card as EngineCard, Rank, Suit } from '../engine/types';
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

/**
 * 즉시형 증강(음침한 눈/카멜레온/당근이세요?)의 대상 지정 모달.
 * 이게 없으면 augment_target phase에서 15초 자동 타임아웃까지 화면이 그냥 멈춘 것처럼
 * 보인다 — 증강 선택 → 대상 플레이어/카드 선택 → 효과 적용까지 이어주는 마지막 연결고리.
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

  if (!augment) return null;

  const targetName = opponents.find((o) => o.sessionId === targetSessionId)?.name ?? '';

  const needsOpponent = effectType === 'reveal_opponent_card' || effectType === 'swap_with_opponent';
  const step: 'opponent' | 'targetCard' | 'ownCard' | 'rank' | 'suit' =
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

  const stepHint: Record<typeof step, string> = {
    opponent: '대상 플레이어를 선택하세요',
    targetCard: `${targetName}의 홀카드 중 확인할 카드를 선택하세요`,
    ownCard: effectType === 'edit_own_card' ? '바꿀 내 카드를 선택하세요' : '내줄 내 카드를 선택하세요',
    rank: '원하는 숫자를 선택하세요',
    suit: '원하는 무늬를 선택하세요',
  };

  const handlePickTargetCard = (idx: 0 | 1) => {
    if (effectType === 'reveal_opponent_card') {
      onSubmit({ targetSessionId: targetSessionId!, targetCardIndex: idx });
      return;
    }
    setTargetCardIndex(idx); // swap — 다음은 내 카드 선택
  };

  const handlePickOwnCard = (idx: 0 | 1) => {
    if (effectType === 'edit_own_card') {
      setOwnCardIndex(idx); // 다음은 숫자 선택
      return;
    }
    // swap — 상대/카드/내 카드까지 다 모였으니 제출
    onSubmit({ targetSessionId: targetSessionId!, targetCardIndex: targetCardIndex!, ownCardIndex: idx });
  };

  const handlePickSuit = (suit: Suit) => {
    onSubmit({ cardIndex: ownCardIndex!, rank: rank!, suit });
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
                <button key={o.sessionId} className="mp-target-choice-btn" onClick={() => setTargetSessionId(o.sessionId)}>
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
                  className="mp-target-card-btn"
                  onClick={() => handlePickTargetCard(idx as 0 | 1)}
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
                <button key={c.id} className="mp-target-card-btn" onClick={() => handlePickOwnCard(idx as 0 | 1)}>
                  <Card card={asEngineCard(c)} size="sm" />
                  <span>{idx === 0 ? '첫 번째 카드' : '두 번째 카드'}</span>
                </button>
              ))}
            </div>
          )}

          {step === 'rank' && (
            <div className="mp-target-rank-grid">
              {RANKS.map((r) => (
                <button key={r} className="mp-target-rank-btn" onClick={() => setRank(r)}>
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
                  className={`mp-target-suit-btn ${s === 'hearts' || s === 'diamonds' ? 'suit-red' : 'suit-black'}`}
                  onClick={() => handlePickSuit(s)}
                >
                  {SUIT_SYMBOLS[s]}
                </button>
              ))}
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
