import { motion } from 'framer-motion';
import augmentsData from '../data/augments.json';
import { RARITY_NAMES_KO, type Augment } from '../engine/augmentEngine';

const AUGMENT_POOL = augmentsData as Augment[];

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
              onClick={() => onSelect(augment.id)}
            >
              <span className="augment-rarity">{RARITY_NAMES_KO[augment.rarity]}</span>
              <h3 className="augment-name">{augment.name}</h3>
              <p className="mp-augment-pick-desc">{augment.description}</p>
            </motion.button>
          ))}
        </div>
      )}
    </div>
  );
}
