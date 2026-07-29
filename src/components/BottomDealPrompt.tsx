import { motion, AnimatePresence } from 'framer-motion';
import { playSound } from '../utils/sounds';

interface BottomDealPromptProps {
  onChoose: (use: boolean) => void;
}

/**
 * 밑장빼기 — 플랍/턴/리버 공개 직전, 보유자에게 "사용하시겠습니까?" 를 묻는 모달.
 * AugmentTargetScreen(.mp-target-overlay/.mp-target-modal)과 같은 시각 언어를 그대로
 * 재사용한다 — 이미 있는 "즉시형 증강 대상 지정" 모달과 같은 계열의 UI이기 때문이다.
 * "사용 안 함"은 스킵(X)과 동일하게 이번 스트리트엔 쓰지 않고 넘어가되, 라운드당 1회
 * 제한은 그대로 소모된다(다음 스트리트에서 다시 물어보지 않음).
 */
export function BottomDealPrompt({ onChoose }: BottomDealPromptProps) {
  return (
    <AnimatePresence>
      <motion.div className="mp-target-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        <motion.div
          className="mp-target-modal rarity-silver"
          initial={{ scale: 0.85, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 22 }}
        >
          <h2 className="mp-target-title">🃏 밑장빼기</h2>
          <p className="mp-target-desc">공개될 카드를 버리고 다음 카드를 대신 공개할까요?</p>
          <p className="mp-target-hint">라운드당 1회만 사용할 수 있습니다</p>
          <div className="mp-target-choice-row">
            <button
              className="mp-target-choice-btn mp-target-selected"
              onClick={() => {
                playSound('buttonClick');
                onChoose(true);
              }}
            >
              사용한다
            </button>
            <button
              className="mp-target-choice-btn"
              onClick={() => {
                playSound('buttonClick');
                onChoose(false);
              }}
            >
              사용 안 함
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
