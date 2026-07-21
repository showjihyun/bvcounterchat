---
name: tdd-workflow
description: ChatStrike의 RQ 구현 파이프라인. RQ·기능 구현, 코딩, 테스트 작성, 테스트 실행, 구현 평가·검증·QA 요청 시 반드시 이 스킬을 사용하라. "RQ-XX 구현해줘", "테스트부터 짜줘", "구현 평가/검증해줘", "다시 실행", "재실행", "수정", "보완", "이전 구현 개선" 요청 포함. Red(test-writer)→Green(coder)→독립 평가(evaluator)를 각각 별도 에이전트 세션으로 실행한다. 스펙 인터뷰, ADR 작성, 하네스 구성·점검, 단순 문서 편집에는 사용하지 않는다.
---

# TDD Workflow — Red → Green → 독립 평가 파이프라인

스펙(RQ) 1건을 별도 에이전트 세션 3개로 구현·검증하는 오케스트레이터.

**실행 모드: 서브 에이전트 (파이프라인 + 생성-검증 패턴).**
팀 모드를 쓰지 않는 이유는 이 파이프라인의 가치가 **세션 격리**이기 때문이다.
테스트 작성자가 구현을 보면 구현에 맞춘 테스트가 되고, 평가자가 구현 세션의
맥락을 공유하면 자기 채점이 된다. 팀 통신은 이 격리를 깨므로 구조적으로 해롭다.
데이터는 `_workspace/{RQ-ID}/` 파일로만 전달한다.

명세: `harness/workflow/tdd.md` · 에이전트 상세: `harness/agent-roster.md`

## 모델 정책

| 에이전트 | model | 이유 |
|---|---|---|
| test-writer | `sonnet` | 코딩·테스트 작업 |
| coder | `sonnet` | 코딩·테스트 작업 |
| evaluator | `opus` | 판정 품질이 파이프라인 신뢰도의 상한 |

`Agent` 호출 시 `model`을 명시한다 (frontmatter와 이중 지정).

## Phase 0: 전제조건·컨텍스트 확인

**하나라도 미충족이면 파이프라인을 시작하지 않고 사용자에게 보고한다.**

1. git 저장소가 초기화되어 있다 (커밋 순서 = M3 측정의 전제)
2. 대상 RQ가 ✅ 확정 상태다. 🟡면 Deep Interview가 먼저 —
   스펙 동결 게이트(`npm run gate`)가 구현 수정을 물리적으로 차단한다
3. 관련 ADR이 승인 상태다 (전송 ADR-0002, 넷코드 ADR-0003, 테스트 ADR-0008,
   레이아웃 ADR-0010은 항상 확인)
4. `npm run check`가 통과한다 (착수 시점이 Green이어야 회귀를 식별할 수 있다)
5. 대상 RQ에 매핑된 GA-* 골든 케이스가 존재한다
   (`harness/evals/golden/track-a-product.jsonl`). 없으면 사용자에게 신설을 요청 —
   정답은 사람이 쓴다

**실행 모드 판별**
- `_workspace/{RQ-ID}/` 없음 → 초기 실행 (Phase 1부터)
- 존재 + 부분 수정 요청 → 해당 Phase 에이전트만 재호출, 기존 산출물을 입력으로
- 존재 + 새로 시작 요청 → 기존 폴더를 `_workspace_prev/`로 옮긴 뒤 초기 실행

**브랜치**: `feat/{RQ-ID}-{짧은설명}` 생성. **원장 기록**: `harness/progress.md`에
행을 만들고 🔄로 바꾼다 (CLAUDE.md 최상위 규칙).

## Phase 1: Red — test-writer (별도 세션, sonnet)

`Agent(subagent_type: "test-writer", model: "sonnet")`.

프롬프트에 포함:
- RQ-ID + **EARS 문장 전문**(`requirements.md`에서 인용)
- 매핑된 **GA-* 골든 케이스 전문**(jsonl에서 인용)
- ADR-0008 요약(테스트 레벨·더블 허용 범위·결정론 규칙)
- 산출 경로: `_workspace/{RQ-ID}/01_test-writer_red.md`

**완료 조건**: Red 실행 출력이 산출물에 존재한다.
스펙 질문이 반환되면 파이프라인을 중단하고 질문을 사용자에게 전달한다
(추측으로 진행 금지). **테스트 커밋을 여기서 만든다** — 구현 커밋보다
선행해야 M3가 측정된다.

## Phase 2: Green — coder (별도 세션, sonnet)

`Agent(subagent_type: "coder", model: "sonnet")`.

프롬프트에 포함:
- `_workspace/{RQ-ID}/01_test-writer_red.md` 경로 + 테스트 파일 목록
- **테스트 파일 수정 금지** 규칙 재명시
- 산출 경로: `_workspace/{RQ-ID}/02_coder_green.md`

**완료 조건**: 전체 스위트 Green 출력이 산출물에 존재한다.
테스트-스펙 모순 보고가 반환되면 중단하고 사용자 판단을 받는다.

## Phase 3: 독립 평가 — evaluator (별도 세션, opus)

`Agent(subagent_type: "evaluator", model: "opus")`.

프롬프트에는 **RQ-ID와 `_workspace/{RQ-ID}/` 경로만** 전달한다.
coder의 대화·설명·"이렇게 구현한 이유"를 전달하지 않는다 — 평가자는 파일과
코드만 본다. 산출: `03_evaluator_report.md` (PASS/FAIL/BLOCKED + 증거).

## Phase 4: 종합

- **PASS** → 구현 커밋 확인, 원장(`progress.md`) ✅ 갱신, PR 준비
  (스펙 변경이 있으면 같은 PR에 포함). **머지 전에 `review-gate` 스킬을
  호출한다** — reviewer APPROVE가 머지의 필요조건이다.
- **FAIL** → 보고서를 입력으로 coder 1회 재호출(Phase 2) → evaluator
  재평가(Phase 3). **다시 FAIL이면 자동 반복을 멈추고** 보고서를 첨부해 사용자에게
  보고한다. 테스트 약화로 우회하지 않는다.
- **BLOCKED** → 환경 문제가 먼저다. 수정 대상(hook·check.sh·러너)을 명시해 보고.

## 데이터 전달 프로토콜

`_workspace/{RQ-ID}/{순번}_{에이전트}_{산출물}.md` + 반환값(요약만).
**중간 파일은 삭제하지 않는다** — 감사 추적이자 부분 재실행의 입력이다.
`_workspace/`는 gitignore 대상이라 저장소를 오염시키지 않는다.

## 에러 핸들링

| 상황 | 처리 |
|---|---|
| 에이전트 실행 실패 (예외·미완성 반환) | 같은 입력으로 1회 재시도, 재실패 시 중단·보고 |
| coder가 테스트 수정을 요구 | 수정 금지. 모순 근거를 받아 사용자 판단으로 (스펙 개정은 같은 PR) |
| evaluator FAIL 2회 연속 | 자동 반복 중단 — 사람 개입 요청 |
| 스펙 모호 발견 (어느 Phase든) | 파이프라인 중단, 질문 목록 반환 (추측 구현 금지) |
| GA 골든 케이스 부재 | Phase 0에서 중단, 사용자에게 케이스 신설 요청 |

## 테스트 시나리오

1. **정상**: "RQ-03 구현해줘" → Phase 0 전제조건 통과 → test-writer가 GA-21
   기반 실패 테스트 작성 + 테스트 커밋 → coder가 최소 구현으로 Green →
   evaluator PASS → PR 준비 → `review-gate` 호출.
   트랙 B GB-02 rubric(테스트 커밋 선행, 완료 주장에 테스트 출력 포함)을 충족해야 한다.
2. **에러**: coder가 통과를 위해 테스트 기대값을 수정 → evaluator가 검증 항목 5
   (테스트 약화 감지)에서 `git diff`로 적발 → FAIL 보고 → 사용자 개입.
