/**
 * 서버 전용 Supabase 클라이언트 — service role 키로 생성되어 RLS를 완전히 우회한다.
 * 절대 클라이언트로 노출하지 말 것 (환경변수는 server/.env, dotenv로 로드됨).
 *
 * 로그인 유저의 chips 확인/차감/정산은 이 클라이언트로만 이뤄진다 — anon/authenticated
 * 롤에는 RPC 실행 권한이 없으므로(schema.sql에서 revoke), 클라이언트가 직접 Supabase에
 * 요청해도 자기 chips를 바꿀 방법이 없다.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

/** 둘 다 설정된 경우에만 true — 미설정 시 로그인 관련 기능은 전부 게스트 경로로 통과시킨다 */
export const isSupabaseConfigured = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

export const supabaseAdmin: SupabaseClient | null = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;
