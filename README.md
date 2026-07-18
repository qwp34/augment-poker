# 증강 포커 (Augment Poker)

텍사스 홀덤 룰 위에 매 라운드 증강(Augment)을 선택해 쌓아가는 로그라이크형 1인 포커.
NAN 2026 사전 과제 — AI 봇 상대 · 서버 없이 프론트엔드 단독 동작 (기획서 MVP 스코프 기준).

## 실행

```bash
npm install
npm run dev     # http://localhost:5173
npm run build   # 타입체크 + 프로덕션 빌드
```

## 게임 루프

매 라운드: **증강 3개 중 1개 선택 → 핸드 진행 (프리플랍→플랍→턴→리버→쇼다운) → 결과**.
총 5라운드, 증강은 누적. 스택이 바닥나면 게임 오버.

## 폴더 구조

```
src/
├── engine/              # 순수 게임 로직 (UI 무관, 단위 테스트 가능)
│   ├── types.ts         # 카드/페이즈 공통 타입
│   ├── deck.ts          # Fisher-Yates 셔플, 딜링, 셔플 편향(증강 훅)
│   ├── handEvaluator.ts # 7장 중 최고 5장 핸드 판정 (조커 지원)
│   ├── augmentEngine.ts # JSON 기반 증강 룰 엔진
│   └── botAI.ts         # 봇 베팅 결정 (휴리스틱 → Claude API 교체 지점)
├── data/
│   └── augments.json    # 증강 5종 — 여기에 항목 추가만 하면 증강이 늘어남
├── store/
│   └── gameStore.ts     # Zustand — 게임 루프/베팅/쇼다운 상태 머신 + 봇 딜레이 연출
├── ui/
│   ├── format.ts        # 족보 축약 이름(로티플/스티플...), 핸드 라벨
│   ├── sfx.ts           # WebAudio 신디사이저 효과음 (에셋 불필요)
│   └── useCountUp.ts    # 골드/팟 카운트업 훅
└── components/
    ├── Card.tsx         # 카드 — 딜링 진입 + 플립 애니메이션, 조커 글로우
    ├── AugmentCard.tsx  # 증강 선택 카드 + 보유 칩
    ├── BettingPanel.tsx # 다이/체크·콜/레이즈/하프/맥스 버튼 그리드
    ├── WinBanner.tsx    # 빅 핸드 리본 배너 + 콘페티, 일반 결과 토스트
    ├── TopBar.tsx       # 골드 카운터 바 · 게임 정보 · 보유 증강
    └── LogPanel.tsx     # 로그/족보 탭 패널 (채팅창 스타일)
```

## 구현된 증강 5종

| 증강 | 등급 | 트리거 |
|---|---|---|
| 플러시의 축복 — 플러시 계열 승리 배당 ×1.5 | 실버 | 쇼다운 |
| 카드 재구성 — 핸드당 1회 홀카드 교체 (카드 클릭) | 골드 | 핸드 시작 |
| 정조준 올인 — 올인 승리 배당 ×2 | 골드 | 쇼다운 |
| 황금 뒤집개 — 홀카드 1장 조커화 (모든 무늬 인정) | 프리즘 | 핸드 시작 |
| 로열의 예언 — 셔플 편향 (연출용) | 프리즘 | 셔플 |

배당 증강이 동시 발동하면 배율은 곱연산으로 콤보를 이룬다 (`augmentEngine.applyPayoutAugments`).

## 연출 (Framer Motion + WebAudio)

- 카드 딜링 스태거 진입 + 쇼다운 시 봇 카드 3D 플립
- 빅 핸드(플러시 이상 또는 증강 배당 발동) 승리 시 **보라 리본 잭팟 배너** + 콘페티 + 골드 카운트업
- 일반 승/패는 컴팩트 토스트, 플레이어 카드 위 WIN 뱃지
- 봇 고민 딜레이(0.6~1.4초) + 말풍선 대사, 아바타 글로우
- 골드/팟 숫자 카운트업, 조커 카드 상시 글로우
- 효과음 전부 WebAudio 신디사이저 합성 (외부 에셋 0개)

UI는 실제 모바일/PC 포커 게임의 룸 레이아웃(상단 골드 바, 중앙 팟 캡슐, 좌석별
핸드 라벨 캡슐 `[A,K,Q,J,10] 로티플`, 우하단 베팅 그리드 + 채팅형 로그 패널)을 참고했다.

## 멀티플레이 서버 (`server/` — Colyseus + Express)

서버 권위(Server-Authoritative) 구조의 실시간 대전 서버. 클라이언트 연동 전 단계까지 구현됨.

```bash
cd server
npm install
npm run dev     # ws://localhost:2567 (+ GET /health)
npm run smoke   # 2인 클라이언트 자동 플레이 통합 테스트
```

```
server/src/
├── index.ts             # Express(HTTP) + Colyseus(WS) 부트스트랩
├── schema/PokerState.ts # 동기화 스키마 — PokerState / PlayerState / CardSchema
├── rooms/PokerRoom.ts   # 입장/퇴장 · 딜링 · 베팅 · 증강 phase · 쇼다운
├── engine/              # 클라이언트와 동일한 순수 엔진 (복사본)
└── data/augments.json
```

**보안 설계**
- 덱·홀카드는 스키마 밖 private 필드 — 클라이언트에 절대 동기화되지 않음
- 홀카드는 `client.send('hole', ...)`로 본인에게만 전송, 쇼다운 시에만 `revealedHole`로 공개
- 모든 메시지 검증: 차례/phase 확인, 레이즈 금액 정수·최소레이즈·스택 범위 검증, 증강 소유 검증
- 턴 30초/증강 선택 20초 제한시간 — 초과 시 자동 체크·다이/자동 선택

**스모크 테스트가 검증하는 것**: 2명 입장 시 자동 시작, 증강 3택1(보유분 제외),
홀카드 비공개, 조작된 레이즈(-500) 거부, 1라운드 전체 루프 완주 후 라운드 2 진입.

## 다음 단계

- [ ] **클라이언트 연동**: colyseus.js로 프론트엔드를 서버 상태 구독으로 전환 (싱글플레이 모드는 유지)
- [ ] **AI 봇**: `botAI.decideBotAction`을 Claude API 호출로 교체 (현재 휴리스틱은 폴백으로 유지) — TODO 주석 참고
- [ ] (선택) AI 증강 추천 — 플레이 스타일 기반 편향 제시
- [ ] 본선: 사이드 팟, 재접속(reconnection), PostgreSQL(전적)/Redis(룸 상태)

## 단순화한 규칙 (MVP)

- 블라인드 대신 앤티 100 고정, 플레이어가 매 스트리트 선공
- 사이드 팟 없음 (숏 올인 시 초과분 반환 생략)
- 배당 배율로 생기는 추가 칩은 PvE 특성상 팟 외부에서 지급
