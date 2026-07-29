import { useState } from 'react';
import { isSoundEnabled, playSound, toggleSoundEnabled } from '../utils/sounds';

/** 화면 구석에 고정되는 작은 사운드 on/off 토글 — 상태는 세션(탭) 안에서만 유지된다 */
export function SoundToggleButton({ className }: { className?: string }) {
  const [enabled, setEnabled] = useState(isSoundEnabled);

  const handleClick = () => {
    const next = toggleSoundEnabled();
    setEnabled(next);
    // 끄는 클릭엔 소리가 안 나는 게 당연하지만, 켜는 클릭은 즉시 피드백을 준다
    if (next) playSound('buttonClick');
  };

  return (
    <button
      type="button"
      className={`mp-sound-toggle${className ? ` ${className}` : ''}`}
      onClick={handleClick}
      title={enabled ? '효과음 끄기' : '효과음 켜기'}
      aria-label={enabled ? '효과음 끄기' : '효과음 켜기'}
      aria-pressed={enabled}
    >
      {enabled ? '🔊' : '🔇'}
    </button>
  );
}
