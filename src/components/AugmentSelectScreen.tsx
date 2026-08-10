import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
// 증강 정의는 서버(server/src/data/augments.json)를 단일 소스로 참조한다 —
// 여기 따로 사본을 두지 않는다. 텍스트/효과를 고치려면 그 파일 하나만 수정하면 된다.
import augmentsData from '../../server/src/data/augments.json';
import { RARITY_NAMES_KO, type Augment } from '../engine/augmentEngine';
import { playSound } from '../utils/sounds';

const AUGMENT_POOL = augmentsData as Augment[];

/**
 * 서버(PokerRoom.ts)의 AUGMENT_THINK_MS/AUGMENT_COUNTDOWN_MS를 그대로 미러링한다.
 * 실제 시간 초과 판정은 서버 타이머가 유일한 기준이고(클라이언트가 조작 불가), 여기서는
 * 그 타이밍을 시각적으로 근사 재현할 뿐이다 — 값을 바꿀 땐 서버 쪽도 같이 맞춰야 한다.
 */
const AUGMENT_THINK_MS = 20_000;
const AUGMENT_COUNTDOWN_MS = 10_000;
const AUGMENT_TOTAL_MS = AUGMENT_THINK_MS + AUGMENT_COUNTDOWN_MS;

function findAugment(id: string): Augment | undefined {
  return AUGMENT_POOL.find((a) => a.id === id);
}

interface AugmentSelectScreenProps {
  round: number;
  /** 서버가 뽑아 보낸 이번 라운드 후보 3개 id — 이미 선택했다면 빈 배열 */
  choices: string[];
  onSelect: (id: string) => void;
}

/** 증강 선택 화면 — LoL 아레나 스타일. 설명은 항상 보이고, 호버는 그림자/굵은 글씨/두꺼운 테두리로 강조만 한다 */
export function AugmentSelectScreen({ round, choices, onSelect }: AugmentSelectScreenProps) {
  const augments = choices.map(findAugment).filter((a): a is Augment => !!a);
  const waiting = augments.length === 0;

  // 20초까지는 표시 안 하다가 마지막 10초만 카운트다운 — 내가 이미 선택했다면(waiting)
  // 곧바로 멈추고 다음 렌더에서 이 컴포넌트 자체가 "대기 중" 화면으로 바뀌므로 타이머는
  // 사라진다. round가 바뀌면(새 라운드) 처음부터 다시 잰다.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (waiting) return;
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const elapsed = performance.now() - start;
      setElapsedMs(elapsed);
      if (elapsed < AUGMENT_TOTAL_MS) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round, waiting]);

  const countdownSec =
    waiting || elapsedMs < AUGMENT_THINK_MS ? null : Math.max(0, Math.ceil((AUGMENT_TOTAL_MS - elapsedMs) / 1000));

  return (
    <div className="screen title-screen mp-augment-screen">
      <div className="scanlines" />
      <motion.h2
        className="augment-title"
        initial={{ y: -24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
      >
        라운드 {round} — 증강을 선택하세요
      </motion.h2>

      {waiting ? (
        <motion.p
          className="game-subtitle mp-augment-waiting"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          선택 완료 — 다른 플레이어를 기다리는 중...
        </motion.p>
      ) : (
        <div className="mp-augment-pick-row">
          {augments.map((augment, i) => (
            <motion.button
              key={augment.id}
              type="button"
              className={`mp-augment-pick rarity-${augment.rarity}`}
              initial={{ y: 60, opacity: 0, rotateY: 40 }}
              animate={{ y: 0, opacity: 1, rotateY: 0 }}
              transition={{ delay: 0.12 + i * 0.13, type: 'spring', stiffness: 240, damping: 20 }}
              onClick={() => {
                playSound('augmentSelect');
                onSelect(augment.id);
              }}
            >
              <span className="augment-rarity">{RARITY_NAMES_KO[augment.rarity]}</span>
              <h3 className="augment-name">{augment.name}</h3>
              <p className="mp-augment-pick-desc">{augment.description}</p>
            </motion.button>
          ))}
        </div>
      )}

      {countdownSec !== null && (
        <motion.div
          key={countdownSec}
          className={`mp-augment-timer${countdownSec <= 5 ? ' mp-augment-timer-urgent' : ''}`}
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
        >
          {countdownSec}
        </motion.div>
      )}
    </div>
  );
}
