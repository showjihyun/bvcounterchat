# TDD 워크플로우 명세 — Red → Green → 독립 평가

> **구현 상태**: ✅ 2026-07-21 스캐폴딩 완료. 실행체는
> `.claude/skills/tdd-workflow/SKILL.md`(오케스트레이터)와
> `.claude/agents/{test-writer,coder,evaluator}.md`다.
> 이 문서는 그 명세이며, 둘 사이에 차이가 생기면 **실행체를 이 문서에 맞춘다**.
> 에이전트 역할 상세는 `harness/agent-roster.md` 참조.

스펙(RQ) 1건을 별도 에이전트 세션 3개로 구현·검증하는 오케스트레이터.

**실행 모드: 서브 에이전트 (파이프라인 + 생성-검증 패턴).**
팀 모드를 쓰지 않는 이유: 이 파이프라인의 가치는 세션 격리다. 테스트 작성자가
구현을 보면 구현에 맞춘 테스트가 되고, 평가자가 구현 세션의 맥락을 공유하면
자기 채점이 된다. 팀 통신(SendMessage)은 이 격리를 깨므로 구조적으로 해롭다.
데이터는 `_workspace/` 파일로만 전달한다.

**모델 정책:**

| 에이전트 | model | 이유 |
|---|---|---|
| test-writer | `sonnet` | 코딩·테스트 작업 |
| coder | `sonnet` | 코딩·테스트 작업 |
| evaluator | `opus` | 판정 품질이 파이프라인 신뢰도의 상한 |

Agent 도구 호출 시 `model` 파라미터를 명시한다 (에이전트 frontmatter와 이중 지정).

## Phase 0: 전제조건·컨텍스트 확인

1. **전제조건** — 하나라도 미충족이면 파이프라인을 시작하지 않고 사용자에게 보고:
   - git 저장소가 초기화되어 있다 (커밋 순서 = 테스트 선행률 측정의 전제)
   - ADR-0002(전송)·ADR-0003(네트코드)·ADR-0008(테스트 전략)이 승인 상태다
   - 결정론적 시뮬레이션 하네스(고정 틱 + fake timer)가 존재한다 — 아래
     "결정론 규칙" 참조. 없으면 test-writer가 쓸 하네스가 없으므로 선행 작업.
   - `scripts/check.sh`에 실제 테스트 명령이 채워져 있다 (`npm run check`로 확인 —
     Phase 0 통과 전 확인 필수)
   - 대상 RQ에 매핑된 GA-* 골든 케이스가 존재한다
     (`harness/evals/golden/track-a-product.jsonl`). 없으면 중단하고 사용자에게
     신설을 요청한다 — 정답은 사람이 쓴다(`harness/evals/README.md`).
     ※ `requirements.md`의 RQ 44건 중 현재 매핑된 것은 19건이므로, 다수 RQ가
     여기서 한 번 멈춘다. 의도된 정책이다 — 검증 기준 없이 구현하지 않는다.
   - ADR-0010(프로젝트 레이아웃)이 승인 상태다 — 구현 파일의 배치를 규정한다
   - 대상 RQ가 ✅ 확정 상태다 (`harness/specs/requirements.md`). 🟡 PENDING이면
     Deep Interview가 먼저 — 스펙 동결 게이트가 `src/`·`tests/` 수정을 차단한다
     (`harness/sensor-catalog.md`)
2. **실행 모드 판별**:
   - `_workspace/{RQ-ID}/` 없음 → 초기 실행 (Phase 1부터)
   - 존재 + 부분 수정 요청 → 부분 재실행 (해당 Phase의 에이전트만 재호출,
     기존 산출물을 입력으로 전달)
   - 존재 + 새로 시작 요청 → 기존 폴더를 `_workspace_prev/`로 이동 후 초기 실행
3. **브랜치**: `feat/{RQ-ID}-{짧은설명}` 생성

## 무엇을 어떤 레벨로 테스트하는가

게임 도메인은 레이어마다 검증 방법이 다르다. 레벨을 잘못 고르면(예: 렌더링을
단위 테스트로 검증 시도) 깨지기 쉽고 느린 테스트가 쌓인다.

| 레이어 | 테스트 레벨 | 대상 RQ 예 | 도구 |
|---|---|---|---|
| 탄도·데미지 계산 | 단위 | RQ-12(hitscan)·RQ-13(헤드샷)·RQ-14(HP/사망)·RQ-18(낙하 데미지)·RQ-64(래그 보상 되감기) | vitest |
| 네트코드·룸 동작 | Colyseus 경계 통합 | RQ-03(정원/관전 전환)·RQ-40(채팅 순서)·RQ-43(AFK 퇴장)·RQ-60(30Hz 틱)·RQ-61(서버 권위) | `@colyseus/testing` + fake timer |
| 렌더링(R3F) | 테스트 대상 아님 | RQ-50~55(HUD)·RQ-70/71(효과) | 스모크(부팅 크래시 확인) + 수동 확인 — `harness/workflow/fe.md` 검증 절 참조 |

렌더링 레이어는 evaluator의 PASS/FAIL 판정 대상에서 제외한다. HUD·이펙트
변경은 이 파이프라인이 아니라 `fe.md`의 검증 절차를 따른다.

## 결정론 규칙

게임 서버 로직 대부분이 시간 기반이다 (재장전 RQ-11 2초, 리스폰 RQ-15 3초,
스폰 보호 RQ-16 3초, AFK RQ-43 5분, 30Hz 틱 RQ-60). 실시간으로 기다리는
테스트는 느리고 CI에서 flaky해진다.

- **실시간 타이머·RAF·실 네트워크에 의존하는 테스트를 금지한다.** `setTimeout`
  실경과, `requestAnimationFrame`, 실제 소켓 연결에 의존하는 assertion은 반려.
- **틱을 수동으로 전진시킨다.** 고정 틱 하네스(`advanceTick(n)` 또는 동등물)로
  30Hz 틱을 n회 강제 진행시켜 시간 기반 로직을 검증한다. AFK 5분처럼 긴
  구간은 fake timer로 즉시 전진한다.
- **모든 대기에 timeout 상한을 둔다.** 비동기 assertion(`waitFor` 류)에는
  반드시 상한을 명시한다 — 상한 없는 대기는 실패를 무한 행으로 바꾼다.

## Phase 1: Red — test-writer (별도 세션, sonnet)

`Agent(subagent_type: "test-writer", model: "sonnet")` 호출. 프롬프트에 포함:
- RQ-ID + EARS 문장 전문 (`requirements.md`에서 인용)
- 관련 ADR 요약 (해당 RQ가 네트코드/물리/히트판정에 걸리면 ADR-0003/0004/0005)
- ADR-0008(테스트 전략) 요약 — 테스트 레벨·더블 허용 범위
- 위 "결정론 규칙" 전문
- 산출 경로: `_workspace/{RQ-ID}/01_test-writer_red.md`

완료 조건: Red 실행 출력이 산출물에 존재. 스펙 질문이 반환되면 파이프라인을
중단하고 질문을 사용자에게 전달한다 (추측으로 진행 금지).
**테스트 커밋을 여기서 만든다** — 구현 커밋보다 선행해야 테스트 선행률이 측정된다.

## Phase 2: Green — coder (별도 세션, sonnet)

`Agent(subagent_type: "coder", model: "sonnet")` 호출. 프롬프트에 포함:
- `_workspace/{RQ-ID}/01_test-writer_red.md` 경로 + 테스트 파일 목록
- 테스트 파일 수정 금지 규칙 재명시
- 산출 경로: `_workspace/{RQ-ID}/02_coder_green.md`

완료 조건: 전체 스위트 Green 출력이 산출물에 존재. 테스트-스펙 모순 보고가
반환되면 중단하고 사용자 판단을 받는다.

## Phase 3: 독립 평가 — evaluator (별도 세션, opus)

`Agent(subagent_type: "evaluator", model: "opus")` 호출. 프롬프트에는
**RQ-ID와 `_workspace/{RQ-ID}/` 경로만** 전달한다 — coder의 대화 내용·설명을
전달하지 않는다 (평가자는 파일과 코드만 본다). 검증 항목은
`harness/agent-roster.md`의 evaluator 스펙을 따른다.
산출: `_workspace/{RQ-ID}/03_evaluator_report.md` (PASS/FAIL/BLOCKED + 증거)

## Phase 4: 종합

- **PASS** → 구현 커밋 확인, PR 준비 (스펙 변경이 있으면 같은 PR에 포함),
  사용자에게 테스트 출력 증거와 함께 보고. **머지 전에 `review-gate` 워크플로우
  (`harness/workflow/review-gate.md`)를 호출한다** — reviewer(Opus) APPROVE가
  머지의 필요조건
- **FAIL** → 보고서를 입력으로 coder 1회 재호출(Phase 2) → evaluator
  재평가(Phase 3). 다시 FAIL이면 자동 반복을 멈추고 보고서 첨부하여 사용자 보고.
  테스트 약화로 우회하지 않는다.
- **BLOCKED** → 환경 문제가 먼저다. 수정 대상(하네스·`check.sh`·러너)을 명시해 보고

## 데이터 전달 프로토콜

- 파일 기반: `_workspace/{RQ-ID}/{순번}_{에이전트}_{산출물}.md` + 반환값(요약만)
- 중간 파일은 삭제하지 않고 보존한다 (감사 추적·부분 재실행의 입력)

## 에러 핸들링

| 상황 | 처리 |
|---|---|
| 에이전트 실행 실패 (예외·미완성 반환) | 같은 입력으로 1회 재시도, 재실패 시 중단·보고 |
| coder가 테스트 수정을 요구 | 수정 금지. 테스트-스펙 모순 근거를 받아 사용자 판단으로 (스펙 개정은 같은 PR) |
| evaluator FAIL 2회 연속 | 자동 반복 중단 — 사람 개입 요청 |
| 스펙 모호 발견 (어느 Phase든) | 파이프라인 중단, 질문 목록 반환 (추측 구현 금지) |
| 결정론 규칙 위반 테스트 발견 (실시간 타이머·RAF·실 네트워크 의존) | test-writer 반려·재작성 — 고정 틱/fake timer로 대체 |

## 테스트 시나리오

1. **정상 흐름**: "RQ-16 구현해줘" (스폰 보호) → Phase 0 전제조건 통과 →
   test-writer가 고정 틱 하네스로 3초 경과를 시뮬레이션하는 실패 테스트 작성
   (실시간 대기 없음) + 테스트 커밋 → coder가 최소 구현으로 Green →
   evaluator PASS → review-gate 호출.
2. **에러 흐름**: coder가 재장전(RQ-11) 테스트를 통과시키려 실제
   `setTimeout(2000)` 경과에 의존하는 구현을 추가 → evaluator가 결정론 규칙
   위반을 적발 → FAIL 보고 → coder 재호출.
