-- augment-poker — Supabase 스키마 (로그인 + 칩 영속성, 최소 스코프)
--
-- 사용법: Supabase 대시보드 > SQL Editor에 이 파일 전체를 붙여넣고 실행.
-- 이 파일은 저장소에 재현 가능성(reproducibility) 목적으로만 보관하며, 마이그레이션
-- 도구로 자동 실행되지 않는다 (이 개발 환경엔 Supabase CLI/Docker가 없어 로컬로 적용해볼
-- 수단이 없다 — 실제 프로젝트에 수동으로 한 번 실행하면 된다).
--
-- 신뢰 경계: 클라이언트(anon/authenticated 롤)는 자기 프로필을 "읽기"만 할 수 있다.
-- chips를 바꾸는 모든 쓰기(회원가입 시 초기화, 입장 시 차감, 정산 시 환급)는 서비스 롤
-- 키를 쥔 Colyseus 서버만 호출 가능하도록 강제한다 — RLS에 update/insert 정책을 아예
-- 두지 않고, RPC 함수는 anon/authenticated 롤의 실행 권한을 명시적으로 회수(revoke)한다.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null,
  chips integer not null default 5000,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

-- insert/update 정책은 의도적으로 없음 — 아래 트리거/RPC(둘 다 security definer)로만 기록된다.

-- 회원가입(auth.users insert) 즉시 프로필 행을 만든다. 닉네임은 signUp() 호출 시
-- options.data.nickname 으로 실어 보낸 값(raw_user_meta_data)을 쓰고, 없으면 이메일
-- 아이디 부분으로 대체한다.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, nickname, chips)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'nickname', split_part(new.email, '@', 1)),
    5000
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 게임 입장 시 바이인 차감 — "확인 후 차감"이 아니라 단일 원자적 UPDATE로 처리해
-- 동시 입장(멀티 탭 등)에도 잔액을 이중으로 쓰지 못하게 한다. 잔액이 바이인보다
-- 적으면(0골드 포함) 먼저 바이인 금액(GREATEST)으로 채운 뒤 그 금액을 그대로 차감한다
-- — 그래서 "바이인(현재 5000) 미만이면 무조건 그만큼으로 보충 후 입장"이 한 statement로 끝나고,
-- 입장이 잔액 부족으로 거부되는 경우 자체가 없어진다(항상 성공, 항상 0행 이상 반환).
create or replace function public.deduct_chips(p_user_id uuid, p_amount integer)
returns table (new_chips integer, nickname text)
language plpgsql
security definer set search_path = public
as $$
begin
  return query
    update public.profiles
    set chips = greatest(chips, p_amount) - p_amount
    where id = p_user_id
    returning profiles.chips, profiles.nickname;
end;
$$;

-- REVOKE FROM PUBLIC은 Postgres가 함수 생성 시 기본으로 PUBLIC에 부여하는 EXECUTE
-- 권한을 없앤다 — 그런데 이 기본 권한이 없어지면 service_role도 함께 잃는다.
-- service_role은 RLS만 우회(BYPASSRLS)할 뿐, 함수 EXECUTE 권한은 별개의 grant이므로
-- 아래처럼 명시적으로 다시 내려줘야 한다(안 그러면 "permission denied for function
-- deduct_chips" 에러가 난다 — 실제로 겪은 문제).
revoke all on function public.deduct_chips(uuid, integer) from public, anon, authenticated;
grant execute on function public.deduct_chips(uuid, integer) to service_role;

-- ⚠️ 이미 credit_chips(uuid, integer) returns integer로 배포된 프로젝트에 적용할 땐,
-- 반환 타입이 바뀌어서(integer → table) CREATE OR REPLACE가 실패한다 — 먼저
-- `drop function if exists public.credit_chips(uuid, integer);`를 실행한 뒤 아래를 실행할 것.
--
-- 게임 종료(정산) 시 최종 스택을 그대로 돌려준다. 차감은 이미 입장 시 끝났으므로,
-- 여기서 finalStack을 더해주면 순효과가 정확히 "이번 판에서 딴/잃은 만큼"이 된다.
-- 정산 결과가 정확히 0골드면(완전히 파산) 그 자리에서 즉시 5000골드(= 서버
-- INITIAL_CHIPS/입장 바이인과 동일한 값)로 채워준다(파산 구제) — bailout_granted를
-- true로 반환해 서버가 전용 알림을 보낼 수 있게 한다.
-- (p_amount=0으로 호출하면 정산 없이 "지금 0골드인지"만 확인해 구제하는 용도로도 쓸 수 있다.)
create or replace function public.credit_chips(p_user_id uuid, p_amount integer)
returns table (new_chips integer, bailout_granted boolean)
language plpgsql
security definer set search_path = public
as $$
declare
  v_new integer;
  v_bailout boolean := false;
begin
  update public.profiles
  set chips = chips + p_amount
  where id = p_user_id
  returning chips into v_new;

  if v_new = 0 then
    update public.profiles set chips = 5000 where id = p_user_id returning chips into v_new;
    v_bailout := true;
  end if;

  return query select v_new, v_bailout;
end;
$$;

revoke all on function public.credit_chips(uuid, integer) from public, anon, authenticated;
grant execute on function public.credit_chips(uuid, integer) to service_role;
