/**
 * 칩 로직(바이인 GREATEST 보충, 정산 파산 구제) 검증 — 실제 Supabase 프로젝트에
 * 새로 적용한 SQL(deduct_chips/credit_chips)이 의도대로 동작하는지, 진짜 auth 유저를
 * 하나 만들어(테스트 후 삭제) 서비스 롤로 직접 RPC를 호출해 확인한다.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(url, serviceKey);

const log = (...args: unknown[]) => console.log(...args);

async function getChips(userId: string): Promise<number> {
  const { data, error } = await admin.from('profiles').select('chips').eq('id', userId).single();
  if (error) throw error;
  return data.chips;
}

async function setChips(userId: string, chips: number) {
  const { error } = await admin.from('profiles').update({ chips }).eq('id', userId);
  if (error) throw error;
}

async function main() {
  const email = `chips-test-${Date.now()}@example.com`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: 'Test1234!',
    email_confirm: true,
    user_metadata: { nickname: 'chiptest' },
  });
  if (createErr || !created.user) throw createErr ?? new Error('유저 생성 실패');
  const userId = created.user.id;
  log(`테스트 유저 생성: ${userId} (${email})`);

  const checks: [string, boolean][] = [];

  try {
    // 0) 회원가입 트리거로 기본 5000골드 프로필이 생겼는지
    const initial = await getChips(userId);
    log(`\n[0] 회원가입 직후 chips = ${initial}`);
    checks.push(['회원가입 시 기본 5000골드 지급', initial === 5000]);

    // 1) 정상 잔액(5000)에서 1000 바이인 → 4000이 되어야 함 (기존 정상 케이스가 안 깨졌는지)
    const { data: d1, error: e1 } = await admin.rpc('deduct_chips', { p_user_id: userId, p_amount: 1000 });
    log(`[1] deduct_chips(5000, buyin=1000) →`, d1, e1);
    checks.push(['충분한 잔액에서 정상적으로 1000 차감(5000→4000)', !e1 && d1?.[0]?.new_chips === 4000]);

    // 2) 잔액을 500으로 강제 설정 후 1000 바이인 → GREATEST(500,1000)-1000 = 0 이어야 함
    await setChips(userId, 500);
    const { data: d2, error: e2 } = await admin.rpc('deduct_chips', { p_user_id: userId, p_amount: 1000 });
    log(`[2] deduct_chips(500, buyin=1000) →`, d2, e2);
    checks.push(['500골드(1000 미만)여도 거부되지 않고 0으로 정확히 착지(보충 후 차감)', !e2 && d2?.[0]?.new_chips === 0]);

    // 3) 잔액을 0으로 강제 설정 후 1000 바이인 → GREATEST(0,1000)-1000 = 0 이어야 함(입장은 항상 성공)
    await setChips(userId, 0);
    const { data: d3, error: e3 } = await admin.rpc('deduct_chips', { p_user_id: userId, p_amount: 1000 });
    log(`[3] deduct_chips(0, buyin=1000) →`, d3, e3);
    checks.push(['0골드여도 입장 거부 없이 성공(보충 후 차감, 결과 0)', !e3 && d3?.[0]?.new_chips === 0]);

    // 4) 정산: 현재 0골드 상태에서 finalStack=0으로 정산 → 0+0=0 → 파산 구제로 1000 되어야 함
    const { data: d4, error: e4 } = await admin.rpc('credit_chips', { p_user_id: userId, p_amount: 0 });
    log(`[4] credit_chips(0, finalStack=0) →`, d4, e4);
    checks.push(['정산 결과 0골드면 즉시 1000골드로 파산 구제', !e4 && d4?.[0]?.new_chips === 1000 && d4?.[0]?.bailout_granted === true]);

    // 5) 파산 구제로 1000이 된 상태에서 finalStack=500 정산 → 1000+500=1500, 구제 없어야 함
    const { data: d5, error: e5 } = await admin.rpc('credit_chips', { p_user_id: userId, p_amount: 500 });
    log(`[5] credit_chips(1000, finalStack=500) →`, d5, e5);
    checks.push(['0골드가 아니면 파산 구제가 발동하지 않음(1500, granted=false)', !e5 && d5?.[0]?.new_chips === 1500 && d5?.[0]?.bailout_granted === false]);

    // 6) 완전히 잃은 경우: 300골드에서 finalStack=-300으로 정산(뻥튀기 없이 순수 소진 시뮬레이션)
    //    → 300-300=0 → 파산 구제로 1000
    await setChips(userId, 300);
    const { data: d6, error: e6 } = await admin.rpc('credit_chips', { p_user_id: userId, p_amount: -300 });
    log(`[6] credit_chips(300, 완전소진 -300) →`, d6, e6);
    checks.push(['완전히 잃어 0골드로 정산돼도 즉시 1000골드로 구제', !e6 && d6?.[0]?.new_chips === 1000 && d6?.[0]?.bailout_granted === true]);
  } finally {
    await admin.auth.admin.deleteUser(userId);
    log(`\n테스트 유저 삭제 완료: ${userId}`);
  }

  log('\n' + '─'.repeat(60));
  let allOk = true;
  for (const [name, ok] of checks) {
    log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) allOk = false;
  }
  if (!allOk) {
    console.error('FAILED');
    process.exit(1);
  }
  log('OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('스크립트 실패:', err);
  process.exit(1);
});
