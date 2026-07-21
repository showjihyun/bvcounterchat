# ChatStrike 하네스

에이전트가 이 저장소에서 일할 때의 **작업 환경**이다. 코드가 아니라 규칙·
가이드·센서·측정의 집합이며, 목적은 하나다: **드리프트를 막는 것** —
스펙에 없는 걸 만들거나, 결정한 것과 다르게 구현하거나, 테스트 없이
"됐다"고 말하는 일을 구조적으로 어렵게 만든다.

> 현재 상태: **문서만 존재한다.** 실행 가능한 hook·skill·CI·코드는 아직
> 없다. 이 폴더의 문서들이 그것들의 명세다. 구축 순서는
> [`progress.md`](progress.md)를 따른다.

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
| [`../CLAUDE.md`](../CLAUDE.md) | 헌법 — 최상위 규칙과 포인터 | 세션 시작 시 자동 |
| [`progress.md`](progress.md) | 진행 원장 — 모든 작업의 시작/완료 기록 | **모든 작업 전후** |
| [`specs/requirements.md`](specs/requirements.md) | 요구사항 (EARS, RQ-ID) | 작업 착수 시 |
| [`specs/interview/question-bank.md`](specs/interview/question-bank.md) | 미결 질문 — 🟡 RQ를 푸는 열쇠 | 스펙이 모호할 때 |
| [`specs/interview/answers.md`](specs/interview/answers.md) | 인터뷰 답변 기록 (사람이 작성) | 인터뷰 후 |
| [`adr/`](adr/) | 아키텍처 결정 9건 | 아키텍처·라이브러리 관련 작업 시 |
| [`workflow/tdd.md`](workflow/tdd.md) | RQ 구현 파이프라인 (Red→Green→평가) | RQ 구현 시 |
| [`workflow/fe.md`](workflow/fe.md) | 클라이언트·3D·HUD 구현 규칙 | 클라이언트 작업 시 |
| [`workflow/review-gate.md`](workflow/review-gate.md) | 머지 전 독립 리뷰 게이트 | PR 머지 전 |
| [`agent-roster.md`](agent-roster.md) | 파이프라인 에이전트 4종 명세 | 파이프라인 구축·수정 시 |
| [`sensor-catalog.md`](sensor-catalog.md) | 가드레일 지도 (Guide/Sensor 현황) | 하네스 점검 시 |
| [`metrics-baseline.md`](metrics-baseline.md) | 드리프트 측정 지표 | 주간 회고 |
| [`evals/`](evals/) | 골든 케이스 (트랙 A 제품 / 트랙 B 하네스) | 회고·승격 루프 |
| [`changelog.md`](changelog.md) | 하네스 변경 이력 | 하네스를 바꿀 때 (기록 의무) |

## 지금 상태 (2026-07-21)

**스펙은 열렸다.** Deep Interview 37문항이 완료되어 `specs/requirements.md`는
v1.0(🟡 0개), ADR 9건은 전부 승인이다. 원본 요구사항의 모순 2건(관전자
정원 vs "무한 접속", 영구 통계 vs 닉네임 식별)도 인터뷰에서 해소했다.
근거는 `specs/interview/answers.md`.

**첫 Sensor가 섰다.** 스펙 동결 게이트가 실제로 동작한다 —
`.claude/hooks/gate_spec_freeze.py`(PreToolUse, exit 2로 차단) +
`.github/workflows/ci.yml`(PR 게이트). 🟡가 남은 상태에서 구현 디렉토리를
건드리면 도구 호출 자체가 막힌다. 판정 로직은 스크립트 한 곳에 있고 hook과
CI가 같은 코드를 호출한다.

```
python .claude/hooks/gate_spec_freeze.py --check      # 지금 동결 상태
python .claude/hooks/gate_spec_freeze.py --selftest   # 게이트 자체 검증
```

**나머지 Sensor는 여전히 없다.** lint·typecheck·test·트래젝토리 로그는
검증할 코드가 없어 미구축이다. 즉 현재 강제되는 규칙은 "🟡면 구현 금지"
하나뿐이고, 나머지는 전부 읽혀야 지켜지는 Guide다.

→ **다음 단계: 로드맵 1단계(프로젝트 초기화)** — `progress.md` 참조.
   스캐폴딩으로 실제 디렉토리 레이아웃이 정해지면 게이트의
   `BLOCKED_TOP_DIRS`를 그에 맞게 갱신해야 한다(빠뜨린 디렉토리는
   게이트에 뚫린 구멍이다). CI는 git 저장소 초기화 후 활성화된다.

## 헌법과의 관계

이 폴더는 `CLAUDE.md`가 가리키는 대상이다. 규칙의 *내용*은 여기 있고,
규칙이 *존재한다는 사실*만 CLAUDE.md에 있다. 헌법을 짧게 유지하는 것이
목적이다 — 길어지면 읽히지 않고, 읽히지 않는 규칙은 규칙이 아니다.
