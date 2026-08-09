/**
 * 클라이언트 전용 Supabase 클라이언트 — anon key로 생성되어 RLS가 항상 적용된다
 * (자기 profiles 행을 읽는 것만 허용, chips 쓰기는 서버(service role)만 가능).
 *
 * env가 비어 있으면(아직 Supabase 프로젝트를 안 만든 개발 초기 상태) createClient를
 * 아예 호출하지 않는다 — 로그인 기능만 비활성화되고 게스트 플레이는 그대로 동작해야
 * 하기 때문에, isSupabaseConfigured로 UI에서 로그인 버튼 자체를 숨긴다.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

if (import.meta.env.DEV) {
  // 로그인 버튼이 안 보일 때 원인을 빠르게 좁히기 위한 진단 로그 — anon key는 공개돼도
  // 안전한 키라 값 자체를 찍어도 되지만, 길이/존재 여부만으로 충분해 잘라서 남긴다.
  console.log('[supabaseClient] env 로드 확인', {
    VITE_SUPABASE_URL: SUPABASE_URL || '(비어있음)',
    VITE_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY ? `${SUPABASE_ANON_KEY.slice(0, 12)}... (길이 ${SUPABASE_ANON_KEY.length})` : '(비어있음)',
    isSupabaseConfigured,
  });
}

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;
