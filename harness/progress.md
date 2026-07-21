# 진행 원장 (Progress Ledger) — ChatStrike

> **규칙(최상위)**: 모든 작업은 시작 전 이 원장에 행을 만들고 상태를 🔄로
> 바꾼 뒤 진행한다. 완료 시 ✅ + 참조 파일/산출물을 기록한다. 원장에 없는
> 작업은 먼저 행을 추가한다 — 원장 밖 작업 금지.
> 상태: ⬜ 대기 · 🔄 진행중 · ✅ 완료 · ⛔ 차단(사유 병기)

---

## 1. 하네스 구축 (2026-07-21)

| 순번 | 작업 | 관련 RQ/ADR | 상태 | 참조 파일 | 비고 |
|---|---|---|---|---|---|
| 1 | 요구사항 EARS 정규화 (`docs/req/` → RQ-01~95) | 전체 RQ | ✅ | `harness/specs/requirements.md` | **v1.0으로 갱신(2026-07-21)** — Deep Interview 완료로 RQ-90~95 🟡→✅ 확정, RQ-03·RQ-04·RQ-81 개정(항목 15 참고). 🟡 잔존 0건 |
| 2 | ADR 초안 0000~0009 | ADR-0001~0009 | ✅ | `harness/adr/`, `harness/adr/README.md` | 10개 파일(0000 템플릿 포함) 전부 작성 완료. **9건 전부 승인**(2026-07-21). 0004·0005·0007은 RQ-90/92/94 확정 후 항목 16에서 전환 완료 |
| 3 | TDD 워크플로우 문서 | — | ✅ | `harness/workflow/tdd.md` | Red→Green→독립평가 파이프라인 명세. 실행 스킬·에이전트 정의는 미스캐폴딩 |
| 4 | 리뷰 게이트 워크플로우 문서 | — | ✅ | `harness/workflow/review-gate.md` | reviewer(Opus) APPROVE를 머지 필요조건으로 명세. 실행 스킬 미스캐폴딩 |
| 5 | FE(클라이언트·HUD·3D) 워크플로우 문서 | RQ-50~55, RQ-42, RQ-70/71 | ✅ | `harness/workflow/fe.md` | netcode→game state→scene→HUD 레이어 분리 규칙. ADR-0001/0003/0007 참조 |
| 6 | 에이전트 로스터 명세 (test-writer/coder/evaluator/reviewer) | — | ✅ | `harness/agent-roster.md` | 4개 에이전트 격리 파이프라인 명세. 실행 스킬(`.claude/agents/*.md`)은 미스캐폴딩 |
| 7 | 센서 카탈로그 | — | ✅ | `harness/sensor-catalog.md` | Guide/Sensor 현황표 + 게임 특화 센서 4종. 항목 대부분 ⬜미구축/🟡계획으로 정직하게 기록(코드 전무 상태 반영) |
| 8 | 메트릭 베이스라인 | — | ✅ | `harness/metrics-baseline.md` | M1~M9 정의. M7(골든 케이스 수)만 실측값 보유(32), 나머지는 "미측정"이 정직한 값 |
| 9 | 골든 evals | 전 RQ | ✅ | `harness/evals/golden/track-a-product.jsonl`(GA-01~25), `track-b-harness.jsonl`(GB-01~07) | **총 32건(GA 25 + GB 7), 전부 `status: todo`.** Deep Interview 확정값으로 GA-17~25 신규 추가(탄퍼짐 시드 결정론·공중가속 미허용·세이프존 사격불가·스폰 로테이션·관전자 정원초과 거부·UUID 통계 2건·금칙어 필터·낙하 데미지)하고 GA-07/08/16을 확정 수치로 정밀화. `blocked_on_spec` 0건. JSONL 라인별 파싱·ID 중복 검증 통과. ※ 과거 원장에 있던 "파일이 실재하지 않는다"는 플래그는 **오탐이었음** — 두 파일 모두 처음부터 존재했다 |
| 10 | 질문 은행(Deep Interview) | RQ-90~95 | ✅ | `harness/specs/interview/question-bank.md` | 37문항(A~G). 모순 플래그 2건(질문 13 관전자 상한, 질문 25 통계-닉네임 식별) 포함. **완료 배너·ADR-0007/0009 staleness 수정 반영(2026-07-21)** |
| 11 | 답변 기록(Deep Interview 결과) | RQ-90~95 | ✅ | `harness/specs/interview/answers.md` | 질문 1~37 전부 답변·근거 기록 완료(2026-07-21). 뱅크가 권장안을 유보했던 질문 4·8과 ★를 기각한 질문 15·30·31은 결정권자의 채택/기각 사유를 원문 그대로 보존 |
| 12 | 하네스 변경 이력 | — | ✅ | `harness/changelog.md` | 2026-07-21 항목 1건 |
| 13 | 하네스 개요(README) | — | ✅ | `harness/README.md` | Guide/Sensor 모델, 문서 지도. **갱신 완료(2026-07-21)** — "지금 상태" 섹션으로 교체, 스펙 동결 게이트 구축 반영 |
| 14 | 진행 원장 | — | ✅ | `harness/progress.md` | 본 파일 |

---

## 2. Deep Interview 및 후속 조치

| 순번 | 작업 | 관련 RQ/ADR | 상태 | 참조 파일 | 비고 |
|---|---|---|---|---|---|
| 15 | Deep Interview 진행 (RQ-90~95 해소) | RQ-90~95, RQ-03/04/81 개정 | ✅ | `harness/specs/interview/{question-bank,answers}.md`, `harness/specs/requirements.md`(v1.0) | **완료(2026-07-21)**. 37문항 전부 답변 확보 → `answers.md` 기록 → `requirements.md`를 v1.0으로 개정(RQ-90~95 확정 + RQ-03·04·81 정합화). 모순 2건(관전자 상한, 통계-닉네임 식별) 모두 RQ 문구 개정으로 해소. 스펙 동결 게이트가 막던 🟡는 0건. hook·CI 실체는 항목 17에서 구축 완료 |
| 16 | ADR-0004·0005·0007을 "제안"→"승인"으로 전환 | ADR-0004, ADR-0005, ADR-0007 | ✅ | `harness/adr/` | **완료(2026-07-21)**. 세 ADR 모두 승인 전환 + 확정값 본문 반영(0004 이동 파라미터표·공중가속 미허용, 0005 무기 수치·되감기 200ms·`headshot` 플래그, 0007 맵 수치·스프레이 아틀라스). `adr/README.md` 상태표 9건 전부 승인으로 갱신. 단서: 승인 ≠ 전면 검증 — Rapier 30Hz 실측(0004), 히트박스 치수(0005)는 잔존 사항으로 각 `## 결과`에 명시 |
| 17 | **스펙 동결 게이트 구축 (hook + CI)** | 전 RQ (드리프트 방지) | ✅ | `.claude/hooks/gate_spec_freeze.py`, `.claude/settings.json`, `.github/workflows/ci.yml` | **완료(2026-07-21) — 하네스 최초의 실동작 Sensor.** 🟡 존재 시 구현 디렉토리 수정을 PreToolUse exit 2로 차단, CI에서 동일 스크립트로 PR 차단. 판정 로직 단일화(hook·CI가 같은 코드 호출). `--selftest` 내장, CI 첫 스텝으로 실행. 4개 시나리오 실측 검증(구현 차단 / 문서 통과 / CI 실패 / 문서전용 PR 통과). 구축 중 cp949 인코딩 크래시 버그 1건 발견·수정. **후속 필수**: 스캐폴딩에서 레이아웃 확정 시 `BLOCKED_TOP_DIRS` 갱신, git init 후 CI 활성 |
| 17b | **리뷰 게이트 스캐폴딩 (skill + reviewer 에이전트)** | 전 PR (추론적 게이트) | ✅ | `.claude/skills/review-gate/SKILL.md`, `.claude/agents/reviewer.md` | **완료(2026-07-21)**. reviewer=opus, 검토 항목 10건. **첫 실전 가동 결과**: PR #1에서 1차 major 5·minor 8, 재리뷰 major 1(수정이 새로 만든 것)·minor 6 검출 — blocker 0. 실제로 잡은 것: lint 구멍(`import fs from 'node:fs'` 무사통과), 재리뷰 경로 미정규화(재리뷰가 조용히 1회차로 처리됨), 헌법의 저장소 상태 오진술. **미완**: GitHub 브랜치 보호 status check 미설정 — 현재는 규율로만 강제 |
| 17c | **TDD 파이프라인 스캐폴딩 (test-writer·coder·evaluator + skill)** | 전 RQ 구현 | ✅ | `.claude/agents/{test-writer,coder,evaluator}.md`, `.claude/skills/tdd-workflow/SKILL.md` | **완료(2026-07-21)**. 모델: test-writer·coder=sonnet, evaluator=opus. Phase 0 전제조건 5건(git·RQ 확정·ADR 승인·check 통과·GA 케이스 존재)을 실행체에 명시. reviewer 포함 4개 에이전트 전부 실행 가능 |
| 17d | **온보딩 워크플로우 문서 (신규 목표)** | — | ⬜ | `docs/ONBOARDING.md`(미생성) | **2026-07-21 사용자 신규 목표.** 팀에 신입이 들어왔을 때 기본 뼈대가 되는 작업 흐름 문서. 현재 하네스 문서 16개에 사람용 진입점이 없다 — `CLAUDE.md`는 에이전트용 포인터, `progress.md`는 원장이다. **전제 검토 필요**: 리뷰 게이트는 '솔로 체제에서 GitHub이 자기 PR 자기 승인을 막는다'는 이유로 만들어졌다(`review-gate.md`). 사람 팀원이 생기면 이 전제가 바뀌므로 reviewer 에이전트의 역할(대체 vs 보완)을 재정의해야 한다 |
| 17e | **결정론 시뮬레이션 하네스 (고정 틱 + fake timer)** | RQ-11/15/16/43/60, ADR-0008 | ⬜ | `tests/` 지원 모듈 (미생성) | **RQ-04 착수의 선행 조건.** `tdd.md` Phase 0 전제조건이지만 현재 미충족 — `advanceTick`/fake timer 하네스가 저장소에 없다. 없으면 test-writer가 "틱을 수동 전진"시킬 대상이 없어 시간 기반 RQ(재장전 2초·리스폰 3초·스폰보호 3초·AFK 5분·30Hz 틱)에서 실타이머 의존 테스트가 나온다. **2026-07-21 PR #2 리뷰 blocker 1로 검출** |
| 17f | coder 세션의 `tests/` 쓰기 차단 hook (후속) | 파이프라인 무결성 | ⬜ | `.claude/hooks/` (미생성) | **PR #2 리뷰 blocker 2 후속 권고.** coder는 `Edit`·`Bash` 권한이 있어 테스트 파일 수정이 도구 수준에서 막히지 않는다. 현재 방어는 evaluator의 사후 diff 검출 하나뿐 — `gate_spec_freeze.py`가 PreToolUse 경로 차단의 선례이므로 같은 방식으로 프롬프트 강제를 결정론적 게이트로 승격 가능 |
---

## 3. 로드맵 (`docs/req/07_Roadmap.md` 10단계, v1 = **전체 10단계** — 질문 34 확정)

Deep Interview 완료로 RQ 단위 스펙 동결 게이트가 전부 해제됐다. 아래 표의
⬜는 이제 순수하게 **작업 순서 대기**이며, 이전 버전에 있던 ⛔(스펙 미확정
차단)는 더 이상 없다. 마감일은 없음(질문 33) — 순서는 로드맵 순서를 따른다.

| 순번 | 로드맵 단계 | 관련 RQ | 상태 | 참조 파일 | 비고 |
|---|---|---|---|---|---|
| 18 | 1. 프로젝트 초기화 | RQ-01, ADR-0001~0003, ADR-0010 | ✅ | `package.json`, `tsconfig.json`, `vite*.config.ts`, `src/{client,server,shared}`, `tests/{unit,integration}`, `scripts/check.sh` | **완료(2026-07-21)**. ADR-0010 신설(단일 패키지 + src 하위분할). 검증 실측: typecheck 0에러, lint 0에러, 테스트 14건 통과, `check.sh` 4.2초(예산 3분), 빌드 성공, **빌드된 서버 실행 후 `/health`가 공유 상수를 반환하는 것까지 확인**. 게이트 `BLOCKED_TOP_DIRS`는 src/tests를 이미 포함해 갱신 불요(주석만 보강). CI에 lint·typecheck·test·build 추가 |
| 19 | 2. 서버 | RQ-01~04 | 🔄 | `docs/req/07_Roadmap.md` §2 | ADR-0002(실시간 전송)·ADR-0006(신원·영속성) 기반. RQ-03(정원 10+10)·RQ-04(세션 수명 무제한)·RQ-02(닉네임 자동 접미사) 모두 확정. **PR #1 리뷰 이월(minor)**: ① `colyseus.js`(클라이언트 SDK) 미설치 — ADR-0008이 통합 테스트에 요구하므로 착수 시 필요. ② `vite.config.ts` 개발 프록시가 `/matchmake`만 잡음 — Colyseus WS 업그레이드용 `ws: true` 추가 필요. ③ `colyseus`·`@colyseus/schema`·`rapier3d-compat`이 1단계에서 코드 없이 설치돼 현재 어떤 빌드·테스트도 검증하지 않음 |
| 20 | 3. 네트워킹 | RQ-60~64 | ⬜ | `docs/req/07_Roadmap.md` §3 | ADR-0002/0003(전송·넷코드)·ADR-0005(히트판정, 승인) 기반. RQ-64 되감기 상한 **200ms**, 허용 RTT **150ms**로 확정(질문 28·29) |
| 21 | 4. 플레이어 이동 | RQ-20~22, RQ-92 | ⬜ | `docs/req/07_Roadmap.md` §4 | ADR-0004(물리/충돌, 승인) 기반. RQ-92 확정: 이동 6m/s·앉기 50%·천천히 걷기 70%·점프 1.0m·낙하데미지(3m 초과 1m당 10)·에어 스트레이프 미허용(질문 5~9) |
| 22 | 5. 전투 | RQ-10~18, RQ-70~71, RQ-90 | ⬜ | `docs/req/07_Roadmap.md` §5 | ADR-0005(히트판정, 승인) 기반. RQ-90 확정: 바디25/헤드50, 400RPM, 감쇠없음, 랜덤 콘 탄퍼짐(질문 1~4) |
| 23 | 6. 채팅 | RQ-40~43, RQ-94, RQ-95 | ⬜ | `docs/req/07_Roadmap.md` §6 | RQ-94(스프레이 AI 생성 100종, 질문 21)·RQ-95(기본 금칙어 필터만, 질문 22) 확정. ADR-0007(맵 에셋 파이프라인, 스프레이 로딩 전략 포함) 승인 |
| 24 | 7. HUD | RQ-50~55, RQ-91, RQ-93 | ⬜ | `docs/req/07_Roadmap.md` §7 | RQ-91(관전 카메라: 자유시점+1인칭 추적, 질문 10~13)·RQ-93(Top Scorer = 서버 가동 이후 누적, 질문 24·26) 확정 |
| 25 | 8. 맵 | RQ-30~32 | ⬜ | `docs/req/07_Roadmap.md` §8 | ADR-0007(맵 에셋 파이프라인, 승인) 기반. 확정: 60×60m 소형, 색조·재질만 Dust2 유사(레이아웃 독자설계), 스폰 14~16개 순환 로테이션, Safe Zone 반경5m·사격불가, 사다리2·박스클러스터3(질문 14~19) |
| 26 | 9. 최적화 | RQ-60(틱 예산), CLAUDE.md 프레임 예산 불변식 | ⬜ | `docs/req/07_Roadmap.md` §9 | `metrics-baseline.md` M8(틱 초과율)·M9(프레임 예산 준수율) 계측 인프라 구축과 병행. 목표 하한 사양(질문 37: 내장 GPU 30fps)이 M9 목표치 근거 |
| 27 | 10. Docker 배포 | RQ-80~81 | ⬜ | `docs/req/07_Roadmap.md` §10 | ADR-0009(배포, **승인**) 기반. 확정: 사내망/로컬 전용, HTTP/WS(TLS 불요), 무중단 목표 없음(질문 27·30~32). RQ-81 통계 키는 UUID(질문 25, ADR-0006) — SQLite 스키마 설계가 이 답변에 의존 |

> v1 컷라인: 질문 34 답변에 따라 **로드맵 10단계 전부**가 v1 범위다(최적화·
> Docker 배포까지 포함) — 별도로 잘라낼 단계 없음. 마감일 없음(질문 33).
