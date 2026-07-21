# ChatStrike 하네스

에이전트가 이 저장소에서 일할 때의 **작업 환경**이다. 코드가 아니라 규칙·
가이드·센서·측정의 집합이며, 목적은 하나다: **드리프트를 막는 것** —
스펙에 없는 걸 만들거나, 결정한 것과 다르게 구현하거나, 테스트 없이
"됐다"고 말하는 일을 구조적으로 어렵게 만든다.

> 이 폴더의 문서는 **명세**이고, 실행체는 `.claude/`(hook·에이전트·스킬)와
> `.github/workflows/`(CI)에 있다. 둘이 어긋나면 **실행체를 명세에 맞춘다**.
> 진행 상황은 [`progress.md`](progress.md).
>
> 팀에 새로 합류했다면 여기 말고 [`../docs/ONBOARDING.md`](../docs/ONBOARDING.md)부터.

## 모델

```
        ┌─ Guide (행동 전에 읽는 규칙) ────────────────┐
        │  CLAUDE.md · requirements.md · adr/ · workflow/ │
        └────────────────────┬──────────────────────────┘
                             ↓
                     [ 에이전트 작업 ]
                             ↓
        ┌────────────────────┴──────────────────────────┐
        │  Sensor (행동 후에 관찰·교정)                    │
        │  hook · lint · typecheck · test · 리뷰 게이트 · eval │
        └────────────────────┬──────────────────────────┘
                             ↓
              metrics-baseline.md  (숫자로 회고)
                             ↓
              evals/golden/  ← 이상했던 세션을 케이스로 승격
```

Guide는 실수를 **예방**하고, Sensor는 실수를 **검출**한다. 둘 다 만들면
과잉이다 — 같은 실수가 2번 나오면 **둘 중 하나만** 추가한다.
(원칙 상세: [`sensor-catalog.md`](sensor-catalog.md))

## 문서 지도

| 문서 | 역할 | 언제 읽나 |
|---|---|---|
| [`../docs/ONBOARDING.md`](../docs/ONBOARDING.md) | 신입 온보딩 — 첫 주 가이드 | 팀에 새로 합류했을 때 |
| [`../CLAUDE.md`](../CLAUDE.md) | 헌법 — 최상위 규칙과 포인터 | 세션 시작 시 자동 |
| [`progress.md`](progress.md) | 진행 원장 — 모든 작업의 시작/완료 기록 | **모든 작업 전후** |
| [`specs/requirements.md`](specs/requirements.md) | 요구사항 (EARS, RQ-ID) | 작업 착수 시 |
| [`specs/interview/question-bank.md`](specs/interview/question-bank.md) | 미결 질문 — 🟡 RQ를 푸는 열쇠 | 스펙이 모호할 때 |
| [`specs/interview/answers.md`](specs/interview/answers.md) | 인터뷰 답변 기록 (사람이 작성) | 인터뷰 후 |
| [`adr/`](adr/) | 아키텍처 결정 10건 | 아키텍처·라이브러리 관련 작업 시 |
| [`workflow/tdd.md`](workflow/tdd.md) | RQ 구현 파이프라인 (Red→Green→평가) | RQ 구현 시 |
| [`workflow/fe.md`](workflow/fe.md) | 클라이언트·3D·HUD 구현 규칙 | 클라이언트 작업 시 |
| [`workflow/review-gate.md`](workflow/review-gate.md) | 머지 전 독립 리뷰 게이트 | PR 머지 전 |
| [`agent-roster.md`](agent-roster.md) | 파이프라인 에이전트 4종 명세 | 파이프라인 구축·수정 시 |
| [`../docs/req/`](../docs/req/) | 원본 요구사항 (정규화의 입력) | 스펙의 출처가 궁금할 때 |
| [`sensor-catalog.md`](sensor-catalog.md) | 가드레일 지도 (Guide/Sensor 현황) | 하네스 점검 시 |
| [`metrics-baseline.md`](metrics-baseline.md) | 드리프트 측정 지표 | 주간 회고 |
| [`evals/`](evals/) | 골든 케이스 (트랙 A 제품 / 트랙 B 하네스) | 회고·승격 루프 |
| [`changelog.md`](changelog.md) | 하네스 변경 이력 | 하네스를 바꿀 때 (기록 의무) |

## 지금 상태 (2026-07-21)

**스펙은 열렸다.** Deep Interview 37문항 완료로 `specs/requirements.md`는
v1.0(🟡 0개), ADR 10건 전부 승인이다. 원본 요구사항의 모순 2건(관전자 정원 vs
"무한 접속", 영구 통계 vs 닉네임 식별)도 인터뷰에서 해소했다.

**Sensor가 가동 중이다.** 현황표의 정본은
[`sensor-catalog.md`](sensor-catalog.md)이며 여기에 복제하지 않는다 —
같은 목록을 두 곳에 두면 반드시 갈라진다.

지금 강제되는 것: 🟡가 남은 상태의 구현 착수(hook + CI), lint·typecheck·test
회귀(`npm run check` + CI), 그리고 머지 전 독립 리뷰.

```
npm run check     # 전체 검증 (실측 4.2초)
npm run gate      # 스펙 동결 상태만
```

TDD 파이프라인(test-writer·coder·evaluator)도 실행 가능하지만 **아직 한 번도
돌지 않았다** — RQ-04가 첫 실전이다.

**여전히 없는 것.** 트래젝토리 로그 · 골든 파일 ask 게이트(17g) ·
coder의 `tests/` 쓰기 차단 hook(17f) · PostToolUse 빠른 검사(`check.sh --fast`는
있으나 호출자 미등록) · GitHub 브랜치 보호. 즉 "reviewer APPROVE 없이 머지 금지"도
"테스트 커밋이 먼저"도 지금은 **규율로만** 지켜진다.

→ **다음 단계: 결정론 시뮬레이션 하네스**(`progress.md` 17e) — RQ-04의 선행
   조건이다. 고정 틱 + fake timer 없이는 시간 기반 RQ(재장전·리스폰·AFK·30Hz 틱)를
   결정론적으로 테스트할 수 없다.

## 헌법과의 관계

이 폴더는 `CLAUDE.md`가 가리키는 대상이다. 규칙의 *내용*은 여기 있고,
규칙이 *존재한다는 사실*만 CLAUDE.md에 있다. 헌법을 짧게 유지하는 것이
목적이다 — 길어지면 읽히지 않고, 읽히지 않는 규칙은 규칙이 아니다.
