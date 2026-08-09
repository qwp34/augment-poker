import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { sfx } from '../ui/sfx';

interface SettingsPanelProps {
  onLogout: () => void;
  /** 로그인 상태일 때만 전달 — "닉네임 · N 골드" 형태로 패널 상단에 표시 */
  profileLabel?: string;
  /** 로그인 상태일 때만 전달 — 톱니바퀴 아이콘 옆에 "🪙 N" 형태로 상시 표시(정산 즉시 반영) */
  chips?: number;
}

/**
 * 2단계(게임 시작/멀티플레이 버튼 화면) 우측 상단 — 보유 칩 표시 + 톱니바퀴 버튼.
 * 톱니바퀴를 누르면 열리는 작은 드롭다운 패널엔 지금은 "로그아웃" 한 줄뿐이지만,
 * 항목을 더 추가할 수 있게 패널 자체(overlay+popup 구조, .settings-popup-item
 * 한 줄 버튼 스타일)는 그대로 두고 안에 버튼을 더 넣기만 하면 되도록 구성했다.
 */
export function SettingsPanel({ onLogout, profileLabel, chips }: SettingsPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="settings-corner">
        {chips != null && <span className="settings-chip-display">🪙 {chips.toLocaleString()}</span>}
        <button
          type="button"
          className="settings-gear-btn"
          aria-label="설정"
          onClick={() => {
            sfx.click();
            setOpen((v) => !v);
          }}
        >
          ⚙️
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <div className="settings-popup-overlay" onClick={() => setOpen(false)}>
            <motion.div
              className="settings-popup"
              initial={{ opacity: 0, scale: 0.9, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 320, damping: 24 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="settings-popup-title">설정</h3>
              {profileLabel && <p className="settings-popup-profile">{profileLabel}</p>}
              <button
                type="button"
                className="settings-popup-item"
                onClick={() => {
                  sfx.click();
                  setOpen(false);
                  onLogout();
                }}
              >
                로그아웃
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
