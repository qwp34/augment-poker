import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { useAuthStore } from '../store/authStore';
import { sfx } from '../ui/sfx';

/**
 * 로그인/회원가입 모달 — 타이틀 2단계 화면의 작은 "로그인" 버튼에서 열린다.
 * 로그인은 선택사항이라 이 모달을 닫아도(또는 아예 열지 않아도) 게스트로 계속 플레이할 수 있다.
 */
export function AuthModal({ onClose }: { onClose: () => void }) {
  const signIn = useAuthStore((s) => s.signIn);
  const signUp = useAuthStore((s) => s.signUp);

  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [signupDone, setSignupDone] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    sfx.click();
    setError('');
    if (!email.trim() || !password) {
      setError('이메일과 비밀번호를 입력해주세요.');
      return;
    }
    if (mode === 'signup' && !nickname.trim()) {
      setError('닉네임을 입력해주세요.');
      return;
    }
    setLoading(true);
    const { error: err } =
      mode === 'login' ? await signIn(email.trim(), password) : await signUp(email.trim(), password, nickname);
    setLoading(false);
    if (err) {
      setError(err);
      return;
    }
    if (mode === 'signup') {
      // 이메일 확인이 켜져 있는 프로젝트라면 세션이 곧바로 생기지 않을 수 있어,
      // 자동으로 로그인 상태가 되는 대신 안내 문구를 보여주고 로그인 탭으로 돌려보낸다.
      setSignupDone(true);
      setMode('login');
      return;
    }
    onClose();
  };

  return (
    <div className="auth-modal-overlay" onClick={onClose}>
      <motion.div
        className="auth-modal"
        initial={{ opacity: 0, scale: 0.9, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 22 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="auth-modal-tabs">
          <button
            type="button"
            className={`auth-modal-tab${mode === 'login' ? ' auth-modal-tab-active' : ''}`}
            onClick={() => {
              sfx.click();
              setMode('login');
              setError('');
            }}
          >
            로그인
          </button>
          <button
            type="button"
            className={`auth-modal-tab${mode === 'signup' ? ' auth-modal-tab-active' : ''}`}
            onClick={() => {
              sfx.click();
              setMode('signup');
              setError('');
              setSignupDone(false);
            }}
          >
            회원가입
          </button>
        </div>

        {signupDone && (
          <p className="mp-hint">회원가입이 완료됐어요. 로그인해주세요.</p>
        )}

        <form className="mp-form" onSubmit={handleSubmit}>
          <input
            className="mp-input"
            type="email"
            placeholder="이메일"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {mode === 'signup' && (
            <input
              className="mp-input"
              placeholder="닉네임 (최대 8자)"
              maxLength={8}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
          )}
          <input
            className="mp-input"
            type="password"
            placeholder="비밀번호 (6자 이상)"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="mp-error">{error}</p>}
          <button type="submit" className="gold-btn gold-btn-large" disabled={loading}>
            {loading ? '처리 중...' : mode === 'login' ? '로그인' : '회원가입'}
          </button>
        </form>

        <button
          type="button"
          className="auth-modal-close"
          onClick={() => {
            sfx.click();
            onClose();
          }}
        >
          닫기
        </button>
      </motion.div>
    </div>
  );
}
