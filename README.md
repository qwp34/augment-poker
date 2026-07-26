# 증강 포커 (Augment Poker)

한게임식 포커 룰(텍사스 홀덤 기반) 위에 **LoL 아레나 스타일 증강(Augment) 시스템**을 결합한
로그라이크형 포커 게임. 매 라운드 시작 전 증강 3개 중 1개를 골라 쌓아가며, 그 증강이 배당·핸드
구성·정보전에 영향을 준다.

**NAN 2026 (NHN Game x AI Hackathon) 사전 과제** 제출용 프로젝트입니다.

- 싱글플레이: AI 봇 1명을 상대로 5라운드 생존
- 멀티플레이: 최대 4인, 링크 공유로 방 입장, 부족한 인원은 AI 봇이 자동으로 채움

## 주요 기능

### ✅ 구현 완료

**텍사스 홀덤 기반 룰**
- 프리플랍 → 플랍 → 턴 → 리버 → 쇼다운의 4스트리트 베팅 진행, 7장 중 최고 5장 핸드 판정(조커 지원)
- 다이(폴드) / 체크·콜 / 레이즈 / 하프팟 / 올인 베팅
- **멀티플레이**: 스몰 블라인드 50 / 빅 블라인드 100, 딜러 좌석 로테이션 — 실제 홀덤에 가까운 구조
- **싱글플레이**: 블라인드 대신 앤티 100 고정, 플레이어가 매 스트리트 선공 (MVP 단순화)

**증강(Augment) 시스템**
- 각 라운드 시작 전 3개 중 1개를 선택해 누적 (선택은 라운드마다 반복, 보유 중인 증강은 후보에서 제외)
- 배당 배율 증강은 동시 발동 시 곱연산으로 콤보
- 즉시형 증강(음침한 눈/카멜레온/당근이세요?)은 선택 즉시 대상(상대 플레이어·카드·숫자/무늬)을
  지정하는 전용 화면(`AugmentTargetScreen`)으로 이어짐 — **멀티플레이 전용**, 싱글플레이 후보에서는
  제외됨(상대가 봇 1명뿐이라 대상 지정의 의미가 약해 현재는 필터링)

구현된 증강 8종:

| 증강 | 등급 | 발동 시점 | 효과 | 모드 |
|---|---|---|---|---|
| 플러시의 축복 | 실버 | 쇼다운 | 플러시 이상으로 승리 시 배당 ×1.5 | 싱글/멀티 |
| 카드 재구성 | 골드 | 핸드 시작 | 핸드당 1회, 내 홀카드 1장을 새 카드로 교체 | 싱글/멀티 |
| 정조준 올인 | 골드 | 쇼다운 | 올인 상태로 승리 시 배당 ×2 | 싱글/멀티 |
| 황금 뒤집개 | 프리즘 | 핸드 시작 | 내 홀카드 1장이 조커가 됨(모든 무늬 인정) | 싱글/멀티 |
| 로열의 예언 | 프리즘 | 셔플 | 셔플 시 낮은 확률로 유리한 카드가 들어올 확률 소폭 상승(연출용) | 싱글/멀티 |
| 음침한 눈 | 골드 | 선택 즉시 | 상대 1명을 지목해 그의 홀카드 1장을 나에게만 공개 (1회성) | 멀티 전용 |
| 카멜레온 | 프리즘 | 선택 즉시 | 내 홀카드 1장을 원하는 숫자/무늬로 자유롭게 변경 (1회성) | 멀티 전용 |
| 당근이세요? | 골드 | 선택 즉시 | 상대 1명을 지목해 내 홀카드 1장과 상대 홀카드 1장을 맞교환 (1회성) | 멀티 전용 |

**멀티플레이 (Colyseus 서버 권위 구조)**
- 방 만들기 + 링크 공유 입장(`/room/:roomId`), 방장만 게임 시작 가능
- 최대 4인, 부족한 좌석은 방장이 시작할 때 AI 봇으로 자동 채움
- 홀카드는 스키마 밖 private 필드로 관리 — 본인에게만 개별 전송, 쇼다운 전까지 서버가 아예 값을 보내지 않음
- 모든 베팅 액션 서버 검증(차례/phase, 레이즈 금액 범위·정수 여부, 스택 초과 여부)
- 턴 30초 / 증강 선택 20초 제한시간 — 초과 시 자동 체크·다이 또는 자동 선택
- 게임 종료 시 최종 순위(standings) 브로드캐스트

**AI 봇**
- 규칙 기반 휴리스틱(핸드 강도 + 랜덤성 + 공격적/신중한 페르소나)으로 베팅 결정
- 실제 LLM 호출이 아님 — `decideBotAction` 인터페이스는 Claude API로 교체하기 쉽게 설계된 상태(TODO, 미구현)

**UI/연출**
- 실시간 족보 하이라이트 (`[A,K,Q,J,10] 로열 스트레이트 플러시` 형태 캡슐, 플랍 이후 매 액션마다 갱신) — 싱글/멀티 공통
- 카드 딜링 스태거 진입, 쇼다운 3D 플립, 빅 핸드 승리 시 리본 배너 + 콘페티
- 타이틀 화면: LED 간판풍 반짝이 파티클, 카지노 칩 스타일 원형 버튼
- 효과음 전부 WebAudio 신디사이저 합성 (외부 오디오 에셋 0개)
- 폰트: 타이틀/버튼 등 임팩트가 필요한 짧은 텍스트는 Black Han Sans, 증강 설명 등 읽기 위주
  본문 텍스트는 Noto Sans KR로 분리 적용

### 🚧 미구현 / 진행 중

- **빠른대전(랜덤 매칭)**: 현재는 방 만들기·링크 입장만 있고, 매치메이킹 큐는 없음
- **AI 봇의 실제 LLM 연동**: 현재는 휴리스틱 폴백만 존재, Claude API 호출부는 TODO 주석만 있음
- **재접속(reconnection)**: 연결이 끊기면 해당 좌석은 `connected: false`로 표시될 뿐 복귀 수단 없음
- **사이드 팟**: 숏 올인 시 초과분 반환 로직 없음
- 전적 저장(PostgreSQL)·룸 상태 영속화(Redis) 등 백엔드 확장은 본선 스코프

## 기술 스택

**Frontend** (루트, `package.json`)
- React 19 + TypeScript + Vite 8
- [Zustand](https://github.com/pmndrs/zustand) — 싱글플레이 게임 상태 머신
- [Framer Motion](https://www.framer.com/motion/) — 애니메이션
- [colyseus.js](https://colyseus.io/) — 멀티플레이 서버 연결 클라이언트
- [oxlint](https://oxc.rs/) — 린트
- 폰트: [Black Han Sans](https://fonts.google.com/specimen/Black+Han+Sans), [Noto Sans KR](https://fonts.google.com/noto/specimen/Noto+Sans+KR) (Google Fonts CDN)

**Backend** (`server/package.json`)
- Node.js + TypeScript, [tsx](https://github.com/privatenumber/tsx)로 dev 실행
- [Colyseus](https://colyseus.io/) 0.16 — 서버 권위 멀티플레이 프레임워크 (`@colyseus/schema`, `@colyseus/ws-transport`, `@colyseus/monitor`)
- Express 5 — HTTP 헬스체크(`/health`)
- dotenv, cors

## 프로젝트 구조

pnpm 워크스페이스로 묶여 있지만 **실질적으로는 독립된 두 개의 Node 프로젝트**입니다.
`shared` 패키지는 없고, 게임 로직(`engine/`)은 클라이언트·서버 양쪽에 파일이 각각 복사돼 있습니다
(`types.ts`/`deck.ts`/`handEvaluator.ts`는 사실상 동일본, `augmentEngine.ts`/`botAI.ts`는
서버 쪽에 멀티플레이 전용 로직이 더 있어 내용이 다릅니다). 룰을 고치면 양쪽을 함께 수정해야 합니다.

```
augment-poker/
├── src/                      # 클라이언트 (React + Vite)
│   ├── engine/                # 순수 게임 로직 (UI 무관)
│   │   ├── types.ts             # 카드/페이즈 공통 타입
│   │   ├── deck.ts              # 셔플·딜링
│   │   ├── handEvaluator.ts     # 7장 중 최고 5장 판정 (조커 지원)
│   │   ├── augmentEngine.ts     # JSON 기반 증강 룰 엔진
│   │   └── botAI.ts             # 싱글플레이 봇 베팅 결정 (휴리스틱)
│   ├── data/augments.json     # 증강 8종 정의 — 여기 항목 추가만으로 증강이 늘어남
│   ├── store/gameStore.ts     # Zustand — 싱글플레이 상태 머신
│   ├── net/                   # 멀티플레이 연결
│   │   ├── colyseusClient.ts    # Colyseus 클라이언트 싱글톤, 방 공유 링크 유틸
│   │   └── useMultiplayerRoom.ts# 룸 상태 구독 훅 (phase/베팅/증강/결과)
│   ├── ui/                    # format/sfx/카운트업 등 프레젠테이션 헬퍼
│   └── components/            # 화면 & 위젯
│       ├── Card.tsx, AugmentCard.tsx, BettingPanel.tsx, TopBar.tsx, LogPanel.tsx, WinBanner.tsx
│       ├── TitleSparkles.tsx           # 타이틀 화면 반짝이 파티클
│       ├── MultiplayerLobby.tsx        # 방 만들기/입장, 대기실, 게임오버 화면 통합
│       ├── AugmentSelectScreen.tsx     # 멀티플레이 증강 3택1 화면
│       ├── AugmentTargetScreen.tsx     # 즉시형 증강 대상 지정 모달
│       └── PokerTable.tsx              # 멀티플레이 테이블(좌석/베팅/쇼다운) 렌더링
│
└── server/                   # 멀티플레이 서버 (Colyseus + Express)
    ├── src/
    │   ├── index.ts             # Express(HTTP) + Colyseus(WS) 부트스트랩
    │   ├── schema/PokerState.ts # 동기화 스키마 (PokerState/PlayerState/CardSchema)
    │   ├── rooms/PokerRoom.ts   # 입장/퇴장·블라인드·딜링·베팅·증강 phase·쇼다운·타임아웃 (핵심 로직)
    │   ├── engine/               # 서버 측 게임 로직 (+ *.test.ts 유닛 테스트)
    │   └── data/augments.json
    └── scripts/smoke.ts        # 클라이언트 2명을 실제로 접속시켜 전체 루프를 검증하는 통합 테스트
```

## 로컬 실행 방법

클라이언트(루트)와 서버(`server/`)는 별도 프로젝트라 **설치와 실행을 각각** 해줘야 합니다.
(`pnpm-workspace.yaml`에 `packages` 목록이 없어 `server`가 워크스페이스에 연결되어 있지 않고,
`server/`에는 자체 `package-lock.json`이 있어 실제로는 npm으로 설치되어 있습니다.)

### 1. 설치

```bash
# 클라이언트 (루트)
pnpm install

# 서버
cd server
npm install
```

### 2. 환경 변수

```bash
# 클라이언트 — VITE_SERVER_URL (기본값 ws://localhost:2567)
cp .env.example .env

# 서버 — PORT (기본값 2567)
cp server/.env.example server/.env
```

### 3. 실행

```bash
pnpm dev
```

루트에서 `pnpm dev` 한 번이면 `concurrently`가 클라이언트(vite, `http://localhost:5173`)와
서버(colyseus, `ws://localhost:2567`, GET /health·/colyseus 모니터 포함)를 동시에 띄우고
`[client]`/`[server]` 접두사로 로그를 구분해 보여준다. 터미널 하나만 있으면 된다.

싱글플레이(AI 봇전)만 테스트할 땐 서버가 필요 없으니 클라이언트만 따로 켜도 된다:

```bash
pnpm dev:client   # 클라이언트만 — http://localhost:5173
pnpm dev:server   # 서버만 — ws://localhost:2567
```

> 싱글플레이(AI 봇전)는 서버 없이 클라이언트만으로 완전히 동작합니다. 서버는 "친구와 함께
> 플레이"(멀티플레이)를 테스트할 때만 필요합니다.

> **같은 Wi-Fi(LAN)의 다른 기기(휴대폰 등)에서 접속하기**: `vite`가 `server.host: true`로
> 설정되어 있어 `pnpm dev` 실행 시 터미널에 `Network: http://<PC의 LAN IP>:5173` 형태로
> URL이 함께 출력된다 — 그 주소로 접속하면 된다. `VITE_SERVER_URL`을 `.env`에 따로 설정하지
> 않았다면 클라이언트는 페이지를 연 호스트명을 그대로 재사용해 자동으로 같은 PC의
> `:2567`(서버) 포트로 붙는다. 서버(`npm run dev`)도 호스트명 없이 `listen`하므로 기본적으로
> 모든 인터페이스에 바인딩된다 — 그래도 연결이 안 되면 Windows 방화벽이 5173/2567 포트의
> 인바운드 연결을 막고 있는지 확인한다.

### 기타 명령어

```bash
pnpm build               # 클라이언트: 타입체크 + 프로덕션 빌드
pnpm lint                # 클라이언트: oxlint

cd server
npm run build             # 서버: 타입체크 + 빌드
npm test                  # 서버: 엔진 유닛 테스트 (handEvaluator/augmentEngine/showdownFlow)
npm run smoke              # 서버: 클라이언트 2명 자동 플레이 통합 테스트 (전체 게임 루프 검증)
```

## 팀 소개

| 이름 | 역할 |
|---|---|
| 은정 | 클라이언트 / UI |
| 태영 | 서버 / 게임 로직, AI 봇 |
