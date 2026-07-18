import { useGameStore } from '../store/gameStore';
import { useCountUp } from '../ui/useCountUp';
import { AugmentCard } from './AugmentCard';

/** 상단 바 — 골드 카운터(잭팟 스타일) · 게임 정보 · 보유 증강 */
export function TopBar() {
  const round = useGameStore((s) => s.round);
  const maxRounds = useGameStore((s) => s.maxRounds);
  const playerStack = useGameStore((s) => s.playerStack);
  const ownedAugments = useGameStore((s) => s.ownedAugments);
  const gold = useCountUp(playerStack);

  return (
    <header className="topbar">
      <div className="gold-bar">
        <span className="gold-coin">G</span>
        <span className="gold-amount">{gold.toLocaleString()}</span>
        <span className="gold-unit">골드</span>
      </div>

      <div className="info-bar">
        증강포커 <i>|</i> 라운드 {round}/{maxRounds} <i>|</i> 앤티 100 <i>|</i> AI 봇전
      </div>

      <div className="topbar-augments">
        {ownedAugments.map((a) => (
          <AugmentCard key={a.id} augment={a} compact />
        ))}
      </div>
    </header>
  );
}
