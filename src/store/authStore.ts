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
 *
 * guest(개발용 게스트 모드)는 위 로그인 흐름과 완전히 분리된 별도 필드다 — Supabase
 * session/user/profile은 전혀 건드리지 않고, 이 스토어 메모리에만 존재하는 로컬 유저
 * 객체를 하나 더 들고 있을 뿐이다. startGuest()로 만들고 clearGuest()로 지운다.
 */
import { create } from 'zustand';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import { describeAuthError } from '../lib/authErrors';

export interface AuthProfile {
  nickname: string;
  chips: number;
}

/**
 * 개발용 게스트 모드 — Supabase 인증을 전혀 거치지 않는 순수 로컬 유저 객체.
 * id/nickname/chips는 이 클라이언트 메모리에만 존재하고 어디에도 영속되지 않는다
 * (새로고침하면 사라짐). 멀티플레이 입장 시 accessToken을 보내지 않으므로(useMultiplayerRoom
 * 참고) 서버는 이 유저를 항상 게스트로 취급해 deduct_chips/credit_chips(칩 차감·정산)를
 * 전부 건너뛴다 — 실제 로그인 유저와 달리 DB에 어떤 흔적도 남기지 않는다.
 */
export interface GuestUser {
  id: string;
  nickname: string;
  chips: number;
}

interface AuthState {
  session: Session | null;
  user: User | null;
  profile: AuthProfile | null;
  /** 앱 시작 시 기존 세션 복원이 끝났는지 — 끝나기 전엔 로그인 UI를 깜빡이지 않도록 */
  authReady: boolean;
  /** 게스트로 시작한 경우에만 값이 있다 — 실제 로그인(user/profile)과는 완전히 별개다 */
  guest: GuestUser | null;
  init: () => void;
  signUp: (email: string, password: string, nickname: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  setChips: (chips: number) => void;
  /** "게스트로 시작" 클릭 시 — 랜덤 id/닉네임에 INITIAL_CHIPS(5000)골드를 채운 로컬 유저를 즉시 만든다 */
  startGuest: () => void;
  /** 게스트 세션 종료(로그아웃) — 다시 타이틀 1단계로 돌아갈 때 호출 */
  clearGuest: () => void;
}

// 멀티플레이 바이인(server/src/rooms/PokerRoom.ts의 INITIAL_CHIPS)과 맞춘다 — 게스트는
// Supabase profiles와 무관한 순수 로컬 표시값이라 여기 숫자를 맞추는 것 외의 의미는 없다.
const INITIAL_CHIPS = 5000;

function randomGuestNickname(): string {
  const suffix = Math.floor(1000 + Math.random() * 9000); // 4자리
  return `플레이어${suffix}`;
}

/**
 * crypto.randomUUID()는 보안 컨텍스트(HTTPS 또는 localhost)에서만 존재한다 — LAN IP로
 * http:// 접속한 환경(비보안 컨텍스트)에서는 crypto.randomUUID가 아예 undefined라 호출
 * 시 TypeError가 난다. 게스트 id는 실제 신원 증명이 아니라 클라이언트 메모리에서만
 * 쓰이는 임시 식별자라 암호학적 무작위성이 필요 없으므로, 이런 환경에서는 Date.now()
 * + Math.random() 기반 폴백으로 대체한다.
 */
function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
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
  guest: null,

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

  startGuest: () => {
    set({
      guest: {
        id: generateId(),
        nickname: randomGuestNickname(),
        chips: INITIAL_CHIPS,
      },
    });
  },

  clearGuest: () => set({ guest: null }),
}));
