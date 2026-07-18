import { useState } from 'react';
import { useGameStore } from '../store/gameStore';

const HAND_RANKING: { name: string; desc: string }[] = [
  { name: '로티플', desc: '같은 무늬 A,K,Q,J,10' },
  { name: '스티플', desc: '같은 무늬 연속 5장' },
  { name: '포카드', desc: '같은 숫자 4장' },
  { name: '풀하우스', desc: '트리플 + 원페어' },
  { name: '플러쉬', desc: '같은 무늬 5장' },
  { name: '스트레이트', desc: '연속 숫자 5장' },
  { name: '트리플', desc: '같은 숫자 3장' },
  { name: '투페어', desc: '페어 2개' },
  { name: '원페어', desc: '같은 숫자 2장' },
  { name: '하이카드', desc: '가장 높은 카드' },
];

/** 우하단 패널 — 채팅창 스타일 게임 로그 + 족보 탭 */
export function LogPanel() {
  const [tab, setTab] = useState<'log' | 'ranking'>('log');
  const log = useGameStore((s) => s.log);

  return (
    <div className="log-panel">
      <div className="log-tabs">
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
          로그
        </button>
        <button className={tab === 'ranking' ? 'active' : ''} onClick={() => setTab('ranking')}>
          족보
        </button>
      </div>

      {tab === 'log' ? (
        <div className="log-body">
          {[...log].reverse().map((msg, i) => (
            <p key={log.length - i} className="log-line">
              {msg}
            </p>
          ))}
        </div>
      ) : (
        <div className="log-body">
          {HAND_RANKING.map((h, i) => (
            <p key={h.name} className="log-line ranking-line">
              <strong>
                {i + 1}. {h.name}
              </strong>{' '}
              — {h.desc}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
