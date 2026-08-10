# 증강 포커 (Augment Poker)

> 매 라운드 판이 뒤집히는 난장판 홀덤

텍사스 홀덤 규칙 위에 **LoL 아레나 스타일 증강(Augment) 시스템**을 얹은 로그라이크형 포커
게임입니다. 매 라운드 시작 전 증강 3개 중 1개를 골라 계속 쌓아가고, 그렇게 모은 증강들이
배당·핸드 구성·정보전을 라운드마다 뒤흔듭니다.

**NAN 2026 (NHN Game x AI Hackathon) 사전 과제** 제출용 프로젝트입니다.

- 싱글플레이: AI 봇 1명을 상대로 5라운드 생존
- 멀티플레이: 최대 4인, 링크 공유로 방 입장, 부족한 인원은 AI 봇이 자동으로 채움

## 핵심 컨셉

- **텍사스 홀덤 기반**: 프리플랍 → 플랍 → 턴 → 리버 → 쇼다운의 4스트리트 베팅, 7장 중
  최고 5장으로 핸드 판정(조커 지원). 멀티플레이는 스몰 블라인드 50 / 빅 블라인드 100,
  딜러 좌석 로테이션. 싱글플레이는 MVP 단순화로 블라인드 대신 앤티 100 고정, 플레이어가
  매 스트리트 선공.
- **증강 시스템**: 매 라운드 시작 전 증강 3개 중 1개를 선택해 누적합니다(이미 보유한
  증강은 다시 후보로 뜨지 않음). **카멜레온을 제외한 모든 증강은 보유하고 있는 한 매
  라운드 다시 발동**합니다 — 카멜레온만 유일하게 선택 즉시 딱 한 번 발동하고 소모되는
  1회성 증강입니다.
- **서버 권위 구조(멀티플레이)**: 셔플·딜링·모든 베팅 검증·쇼다운 판정을 Colyseus 서버가
  전담합니다. 홀카드는 스키마 밖 private 필드로 관리해 본인에게만 개별 전송하고, 쇼다운
  전까지 서버가 상대 홀카드 값 자체를 클라이언트에 보내지 않습니다.

## 증강 시스템

총 **14종**, **실버 / 골드 / 프리즘** 3등급. 라운드가 올라갈수록 상위 등급이 뜰 확률이
커집니다(`server/src/data/augmentRarityTable.json`):

| 라운드 | 실버 | 골드 | 프리즘 |
|---|---|---|---|
| 1 | 70% | 25% | 5% |
| 2 | 55% | 35% | 10% |
| 3 | 40% | 42% | 18% |
| 4 | 25% | 50% | 25% |
| 5 | 15% | 50% | 35% |

증강 목록(`server/src/data/augments.json`이 유일한 소스 — 클라이언트도 이 파일을 그대로
import해서 쓰므로, 텍스트/등급/확률을 고치려면 이 파일 하나만 수정하면 됩니다):

| 증강 | 등급 | 발동 시점 | 효과 | 모드 |
|---|---|---|---|---|
| 플러시의 축복 | 실버 | 쇼다운 | 플러시 이상으로 승리 시 배당 ×1.5 | 싱글/멀티 |
| 카드 재구성 | 골드 | 핸드 시작 | 매 라운드, 내 핸드 1장을 새 카드로 교체 | 싱글/멀티 |
| 정조준 올인 | 실버 | 쇼다운 | 올인 상태로 승리 시 배당 ×2 | 싱글/멀티 |
| 황금 뒤집개 | 프리즘 | 라운드 시작 | 내 카드 1장이 조커가 됨(모든 무늬 인정) | 싱글/멀티 |
| 로열의 예언 | 골드 | 셔플 | 셔플 시 낮은 확률로 핸드에 좋은 카드가 들어올 확률 15% 증가 | 싱글/멀티 |
| 음침한 눈 | 골드 | 라운드 시작 | 상대 1명을 지목해 그의 핸드 1장을 볼 수 있음 | 멀티 전용 |
| 카멜레온 | 프리즘 | 선택 즉시(1회성) | 내 카드의 무늬와 숫자를 바꿈(딱 한 번) | 멀티 전용 |
| 당근이세요? | 골드 | 핸드 시작 | 상대와 나의 카드를 한 장 교환 | 멀티 전용 |
| 러시안 룰렛 | 프리즘 | 쇼다운 | 바닥 카드 전부 공개 시 무작위로 한 장 파괴 | 멀티 전용 |
| 대풍년 | 프리즘 | 라운드 시작 | **보유한 본인**의 핸드가 3장이 됨 | 멀티 전용 |
| 흔들리는 테이블 | 프리즘 | 라운드 시작 | 모두의 카드가 옆자리로 넘어감 | 멀티 전용 |
| 리셋 버튼 | 프리즘 | 내 턴 | 바닥 카드를 전부 다시 깜 | 멀티 전용 |
| 장고의 시간 | 골드 | 내 턴 | 게임 전체 1회, 내 턴 제한시간을 15초 연장 | 멀티 전용 |
| 예고 홈런 | 프리즘 | 핸드 시작 | 완성할 족보를 미리 선언, 맞히면 배당 ×3 | 멀티 전용 |

> **모드 열은 "실제 효과 로직이 구현된 범위" 기준입니다.** 싱글플레이 엔진
> (`src/store/gameStore.ts`)에는 배당 배율 / 카드 재구성 / 조커화 / 셔플 편향, 이 4가지
> 효과 타입만 구현되어 있습니다. 대상 지정이 필요한 증강 4종(음침한 눈·카멜레온·
> 당근이세요?·예고 홈런)뿐 아니라 대풍년·흔들리는 테이블·리셋 버튼·장고의 시간·러시안
> 룰렛도 아직 싱글플레이에서는 동작하지 않고, 멀티플레이 서버(`server/src/rooms/PokerRoom.ts`)
> 에만 구현되어 있습니다.

## 기술 스택

**Frontend** (루트, `package.json`)

| 패키지 | 버전 | 용도 |
|---|---|---|
| react / react-dom | ^19.2.7 | UI 렌더링 |
| typescript | ~6.0.2 | 타입 체크 |
| vite / @vitejs/plugin-react | ^8.1.1 / ^6.0.3 | 빌드 · dev 서버 |
| [zustand](https://github.com/pmndrs/zustand) | ^5.0.14 | 싱글플레이 게임 상태 머신 |
| [framer-motion](https://www.framer.com/motion/) | ^12.42.2 | 애니메이션 |
| [colyseus.js](https://colyseus.io/) | ^0.16.22 | 멀티플레이 서버 연결 클라이언트 |
| [@supabase/supabase-js](https://supabase.com/docs/reference/javascript) | ^2.111.0 | 로그인(Auth), 내 프로필 읽기(RLS) |
| [oxlint](https://oxc.rs/) | ^1.71.0 | 린트 |
| concurrently | ^10.0.3 | `pnpm dev`로 클라이언트+서버 동시 실행 |
| gsap | ^3.15.0 | 설치는 돼 있으나 현재 코드에서는 미사용 |
| 폰트 (Google Fonts CDN) | — | 타이틀/버튼: Black Han Sans, 본문: Noto Sans KR |

**Backend** (`server/package.json`)

| 패키지 | 버전 | 용도 |
|---|---|---|
| [colyseus](https://colyseus.io/) | ^0.16.5 | 서버 권위 멀티플레이 프레임워크 |
| @colyseus/schema | ^3.0.76 | 상태 동기화 스키마 |
| @colyseus/ws-transport | ^0.16.5 | WebSocket 트랜스포트 |
| @colyseus/monitor | ^0.16.7 | 방 상태 모니터링 대시보드(`/colyseus`) |
| express | ^5.2.1 | HTTP 헬스체크(`/health`) |
| @supabase/supabase-js | ^2.111.0 | 로그인 검증, 칩 차감/정산 RPC 호출(service role) |
| [tsx](https://github.com/privatenumber/tsx) | ^4.23.1 | TypeScript 즉시 실행 (dev/스크립트) |
| typescript | ^6.0.3 | 타입 체크 · 빌드 |
| dotenv | ^17.4.2 | 환경변수 로드 |
| cors | ^2.8.6 | CORS 허용 |

## 프로젝트 구조

pnpm 워크스페이스로 묶여 있지만 `pnpm-workspace.yaml`에 `packages` 목록이 없어
**실질적으로는 독립된 두 개의 Node 프로젝트**입니다. 게임 로직(`engine/`)은 클라이언트·
서버 양쪽에 파일이 각각 복사돼 있고(`types.ts`/`deck.ts`/`handEvaluator.ts`/`equity.ts`는
사실상 동일본, `augmentEngine.ts`/`botAI.ts`는 서버 쪽에 멀티플레이 전용 로직이 더 있어
내용이 다름), 증강 정의(`augments.json`)만은 예외적으로 `server/src/data/augments.json`
하나를 클라이언트가 그대로 import해서 단일 소스로 씁니다.

```
augment-poker/
├── src/                        # 클라이언트 (React + Vite)
│   ├── engine/                   # 순수 게임 로직 (UI 무관)
│   │   ├── types.ts                # 카드/페이즈 공통 타입
│   │   ├── deck.ts                 # 셔플·딜링
│   │   ├── handEvaluator.ts        # 7장 중 최고 5장 판정 (조커 지원)
│   │   ├── equity.ts               # 몬테카를로 승률 계산 (봇 판단 + 화면 표시 공용)
│   │   ├── augmentEngine.ts        # JSON 기반 증강 룰 엔진
│   │   └── botAI.ts                # 싱글플레이 봇 베팅 결정 (에퀴티 vs 팟오즈)
│   ├── data/augmentRarityTable.json  # 라운드별 등급 등장 확률 (augments.json은 서버 것을 import)
│   ├── store/                    # Zustand
│   │   ├── gameStore.ts             # 싱글플레이 상태 머신
│   │   └── authStore.ts             # 로그인/칩 상태
│   ├── net/                      # 멀티플레이 연결
│   │   ├── colyseusClient.ts        # Colyseus 클라이언트 싱글톤, 방 공유 링크 유틸
│   │   └── useMultiplayerRoom.ts    # 룸 상태 구독 훅 (phase/베팅/증강/결과)
│   ├── lib/                      # supabaseClient.ts, authErrors.ts
│   ├── ui/                       # format/sfx/카운트업 등 프레젠테이션 헬퍼
│   │   └── useLiveEquity.ts         # 실시간 승률 훅 (내 카드만 사용)
│   └── components/               # 화면 & 위젯 (Card, BettingPanel, TopBar, LogPanel, WinBanner,
│                                    #  MultiplayerLobby, AugmentSelectScreen, AugmentTargetScreen,
│                                    #  PokerTable, MenuStage, TitleSplash 등)
│
└── server/                     # 멀티플레이 서버 (Colyseus + Express)
    ├── src/
    │   ├── index.ts               # Express(HTTP) + Colyseus(WS) 부트스트랩
    │   ├── schema/PokerState.ts   # 동기화 스키마 (PokerState/PlayerState/CardSchema)
    │   ├── rooms/PokerRoom.ts     # 입장/퇴장·블라인드·딜링·베팅·증강 phase·쇼다운·타임아웃 (핵심 로직)
    │   ├── lib/supabaseAdmin.ts   # service role 클라이언트 (칩 차감/정산 RPC)
    │   ├── engine/                 # 서버 측 게임 로직 (+ *.test.ts 유닛 테스트)
    │   │   ├── settlement.ts        # SettlementTracker — 세션당 정확히 한 번만 정산
    │   │   └── betSizing.ts         # 따당/쿼터/하프 등 고정 비율 베팅 계산
    │   └── data/augments.json, augmentRarityTable.json  # 증강 정의 — 클라이언트도 여기서 직접 import
    └── scripts/
        ├── smoke.ts               # 클라이언트 2명을 실제로 접속시켜 전체 루프를 검증하는 통합 테스트
        └── selfplay.ts            # 봇끼리 자동 대전시켜 임계값을 측정하는 튜닝 하네스
```

## 실행 방법

클라이언트(루트)와 서버(`server/`)는 별도 프로젝트라 **설치를 각각** 해줘야 합니다 — pnpm
워크스페이스에 `server`가 연결돼 있지 않고, `server/`는 자체 `package-lock.json`으로
npm 설치되어 있습니다.

### 1. 설치

```bash
pnpm install          # 클라이언트 (루트)
cd server && npm install   # 서버
```

### 2. 환경 변수

```bash
cp .env.example .env               # 클라이언트
cp server/.env.example server/.env # 서버
```

| 변수 | 위치 | 필수 | 설명 |
|---|---|---|---|
| `VITE_SERVER_URL` | `.env` | 아니오 | 비워두면(주석 유지) 접속한 호스트명 기준 자동 결정. LAN의 다른 기기에서 접속할 걸 고려하면 비워두는 걸 권장 |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | `.env` | 아니오 | 로그인/칩 영속성용. 비워두면 로그인 버튼이 안 보이고 게스트 플레이만 됨 |
| `PORT` | `server/.env` | 아니오 (기본 2567) | 서버 포트 |
| `HOST` | `server/.env` | 아니오 (기본 `0.0.0.0`) | 바인딩 인터페이스 |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | `server/.env` | 아니오 | 로그인 검증, 칩 차감/정산. service role 키는 절대 커밋/클라이언트 노출 금지 |

Supabase 값을 채우려면 [supabase.com](https://supabase.com)에서 프로젝트를 만들고 SQL
Editor에 [`supabase/schema.sql`](supabase/schema.sql)을 실행한 뒤 프로젝트 설정 > API의
값을 넣으면 됩니다 — 완전히 선택 사항이라 비워둬도 게스트로 정상 플레이됩니다.

### 3. 실행

```bash
pnpm dev
```

`concurrently`가 클라이언트(Vite, `http://localhost:5173`)와 서버(Colyseus,
`ws://localhost:2567`)를 한 번에 띄웁니다. 브라우저에서 **http://localhost:5173** 으로
접속하세요.

싱글플레이(AI 봇전)는 서버 없이 클라이언트만으로 완전히 동작합니다 — `pnpm dev:client`로
클라이언트만 켜도 됩니다. 서버는 멀티플레이를 테스트할 때만 필요합니다
(`pnpm dev:server`로 서버만 켤 수도 있습니다).

### 기타 명령어

```bash
pnpm build                # 클라이언트: 타입체크 + 프로덕션 빌드
pnpm lint                 # 클라이언트: oxlint

cd server
npm run build              # 서버: 타입체크 + 빌드
npm test                   # 서버: 엔진 유닛 테스트 (handEvaluator/augmentEngine/equity/botAI/showdownFlow 등)
npm run smoke               # 서버: 클라이언트 2명 자동 플레이 통합 테스트 (전체 게임 루프 검증)
npm run selfplay            # 서버: 봇끼리 자동 대전(기본 2000판) 후 판단 지표 리포트 출력
```

## AI 봇

- 매 액션마다 몬테카를로 롤아웃(`engine/equity.ts`)으로 자기 승률을 계산해 팟오즈와
  비교하는 방식으로 베팅을 결정합니다 — 콜에 필요한 승률보다 실제 승률이 낮으면 접고,
  충분히 높으면 레이즈합니다. 공격적/신중한 페르소나는 그 판단 임계값의 오프셋으로
  표현되고, 소폭의 랜덤 흔들림과 저빈도 블러핑이 얹혀 있습니다.
- 임계값은 감이 아니라 `server/scripts/selfplay.ts`로 봇끼리 수천 판 자동 대전시켜
  측정한 값입니다.
- **빈자리는 AI 봇이 자동으로 채웁니다.** 방장이 게임을 시작하면 4석 중 비어 있는 좌석이
  전부 봇으로 채워지므로(`PokerRoom.fillWithBots`), **혼자 접속해도 4인 게임을 처음부터
  끝까지 완주할 수 있습니다.**
- 실제 LLM 호출은 아직 아닙니다 — `decideBotAction`은 휴리스틱 구현이고, Claude API로
  교체하기 쉽도록 인터페이스만 그렇게 설계해 둔 상태(TODO)입니다.

## 팀 소개

| 이름 | 역할 |
|---|---|
| 박은정 | 클라이언트 / UI / 서버 |
| 손태영 | 기획 / 게임 로직 / AI 워크플로 |
