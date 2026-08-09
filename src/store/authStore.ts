/**
 * 로그인 상태 관리 (Zustand) — Supabase Auth 세션 + profiles(닉네임/칩) 캐시.
 *
 * 로그인은 완전히 선택사항이다: `supabase`가 null(env 미설정)이거나 세션이 없으면
 * 그냥 게스트로 플레이할 수 있어야 하므로, 이 스토어의 상태는 항상 "없어도 되는"
 * 부가 정보로만 취급된다(useMultiplayerRoom은 accessToken이 없으면 기존 게스트 흐름
 * 그대로 동작).
 *
 * chips는 게임 종료 시 서버가 정산한 뒤 'chipsSettled' 메시지로 알려주는 값을
 * setChips()로 즉시 반영한다 — Supabase를 다시 읽어오면(refreshProfile) 서버의
 * credit_chips RPC가 아직 커밋되기 전 값을 먼저 받아올 레이스가 있어, 정산 직후
 * 갱신은 재조회가 아니라 서버가 보내주는 값을 그대로 신뢰한다.
 */
import { create } from 'zustand';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import { describeAuthError } from '../lib/authErrors';

export interface AuthProfile {
  nickname: string;
  chips: number;
}

interface AuthState {
  session: Session | null;
  user: User | null;
  profile: AuthProfile | null;
  /** 앱 시작 시 기존 세션 복원이 끝났는지 — 끝나기 전엔 로그인 UI를 깜빡이지 않도록 */
  authReady: boolean;
  init: () => void;
  signUp: (email: string, password: string, nickname: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  setChips: (chips: number) => void;
}

async function fetchProfile(userId: string): Promise<AuthProfile | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('profiles').select('nickname, chips').eq('id', userId).single();
  if (error || !data) return null;
  return { nickname: data.nickname, chips: data.chips };
}

let initialized = false;

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  profile: null,
  authReady: !supabase, // Supabase 자체가 미설정이면 복원할 세션도 없으니 곧바로 ready

  // App.tsx 최상위에서 한 번만 호출 — 기존 세션 복원 + 이후 로그인/로그아웃을 구독한다
  init: () => {
    if (initialized || !supabase) return;
    initialized = true;

    supabase.auth.onAuthStateChange((_event, session) => {
      set({ session, user: session?.user ?? null });
      if (session?.user) {
        fetchProfile(session.user.id).then((profile) => set({ profile }));
      } else {
        set({ profile: null });
      }
      set({ authReady: true });
    });
  },

  signUp: async (email, password, nickname) => {
    if (!supabase) return { error: 'Supabase가 설정되지 않았습니다' };
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { nickname: nickname.trim().slice(0, 8) } },
    });
    return { error: error ? describeAuthError(error) : null };
  },

  signIn: async (email, password) => {
    if (!supabase) return { error: 'Supabase가 설정되지 않았습니다' };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error ? describeAuthError(error) : null };
  },

  signOut: async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  },

  refreshProfile: async () => {
    const userId = get().user?.id;
    if (!userId) return;
    const profile = await fetchProfile(userId);
    if (profile) set({ profile });
  },

  setChips: (chips) => {
    const profile = get().profile;
    if (profile) set({ profile: { ...profile, chips } });
  },
}));
