/**
 * Supabase Auth 에러 → 한국어 안내 문구 매핑.
 *
 * 1순위: error.code (supabase-js가 최신 GoTrue 서버와 통신할 때 실려오는 구조화된
 * 에러 코드 — @supabase/auth-js의 ErrorCode 유니언 참고). 이게 없거나(구버전 서버,
 * 응답 전에 실패한 네트워크 에러 등) 매핑에 없는 코드면 2순위로 message 문자열
 * 패턴을 검사한다. 둘 다 실패하면 원문 메시지를 괄호로 붙인 범용 문구를 쓴다 —
 * 무조건 "다시 시도해주세요"로 뭉개면 실제 원인 파악이 안 되기 때문.
 */
interface AuthErrorLike {
  message: string;
  code?: string | null;
}

const CODE_MESSAGES: Record<string, string> = {
  weak_password: '비밀번호는 6자 이상 입력해주세요.',
  email_exists: '이미 가입된 이메일입니다.',
  user_already_exists: '이미 가입된 이메일입니다.',
  identity_already_exists: '이미 가입된 이메일입니다.',
  invalid_credentials: '이메일 또는 비밀번호가 올바르지 않습니다.',
  email_not_confirmed: '이메일 인증을 완료한 뒤 로그인해주세요.',
  email_address_invalid: '이메일 형식이 올바르지 않습니다.',
  email_address_not_authorized: '허용되지 않은 이메일 주소입니다.',
  validation_failed: '입력한 정보를 다시 확인해주세요.',
  user_not_found: '가입되지 않은 이메일입니다.',
  user_banned: '이용이 제한된 계정입니다.',
  signup_disabled: '현재 회원가입을 받지 않고 있습니다.',
  same_password: '이전과 동일한 비밀번호입니다.',
  over_email_send_rate_limit: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
  over_request_rate_limit: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
  session_expired: '로그인 세션이 만료되었습니다. 다시 로그인해주세요.',
  session_not_found: '로그인 세션이 만료되었습니다. 다시 로그인해주세요.',
  refresh_token_not_found: '로그인 세션이 만료되었습니다. 다시 로그인해주세요.',
  captcha_failed: '보안 확인에 실패했습니다. 다시 시도해주세요.',
  bad_json: '요청 형식이 올바르지 않습니다.',
};

const MESSAGE_PATTERNS: [RegExp, string][] = [
  [/password.*at least 6/i, '비밀번호는 6자 이상 입력해주세요.'],
  [/password.*(weak|short|characters)/i, '비밀번호가 너무 약합니다. 6자 이상으로 입력해주세요.'],
  [/user already registered/i, '이미 가입된 이메일입니다.'],
  [/invalid login credentials/i, '이메일 또는 비밀번호가 올바르지 않습니다.'],
  [/email not confirmed/i, '이메일 인증을 완료한 뒤 로그인해주세요.'],
  [/unable to validate email address/i, '이메일 형식이 올바르지 않습니다.'],
  [/rate limit/i, '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.'],
  [/network|fetch/i, '네트워크 연결을 확인해주세요.'],
];

export function describeAuthError(error: AuthErrorLike): string {
  if (error.code && CODE_MESSAGES[error.code]) return CODE_MESSAGES[error.code];
  for (const [pattern, ko] of MESSAGE_PATTERNS) {
    if (pattern.test(error.message)) return ko;
  }
  return `요청을 처리할 수 없습니다. (${error.message})`;
}
