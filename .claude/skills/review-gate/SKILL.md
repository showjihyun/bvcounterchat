---
name: review-gate
description: PR 머지 전 독립 리뷰 게이트. "리뷰해줘", "머지 전 검토", "PR 리뷰", "머지해도 돼?", "재리뷰", "리뷰 다시" 요청 시, 그리고 tdd-workflow Phase 4에서 PR 준비 시 반드시 이 스킬을 사용하라. 솔로 체제에서 사람 리뷰어를 대체한다 — reviewer 에이전트(Opus)가 격리된 세션에서 diff를 검토해 APPROVE 판정을 내려야 머지할 수 있다. 코드 구현·수정 요청, 하네스 점검, 스펙 인터뷰에는 사용하지 않는다.
---

# Review Gate — 머지 전 독립 리뷰

솔로 체제의 리뷰 게이트. GitHub은 자기 PR을 자기가 승인할 수 없으므로,
**격리된 세션의 reviewer 에이전트(Opus) APPROVE**를 머지의 필요조건으로 삼는다.
CI(`.github/workflows/ci.yml`)와 함께 이중 게이트를 구성한다 — CI가 결정론적
검사를, reviewer가 추론적 검사를 맡는다.

**규칙: reviewer의 APPROVE 없이 머지하지 않는다.** blocker가 있는데 급하다는
이유로 우회하면 이 게이트는 그날로 장식이 된다.

명세: `harness/workflow/review-gate.md` · 에이전트 상세: `harness/agent-roster.md`

## Phase 0: 대상·전제 확인

1. **리뷰 대상 결정**: 현재 브랜치 vs `main`. 사용자가 PR 번호를 지정하면
   그 PR의 head 브랜치.
2. **전제 확인**:
   - 미커밋 변경이 있으면 먼저 커밋을 요청한다 (리뷰 대상이 흔들리면 안 된다)
   - `git diff main...HEAD`가 비어 있으면 "리뷰 대상 없음"으로 중단.
     **게이트 통과가 아니다.**
3. **재리뷰 판별**: `_workspace/review/{브랜치명}.md`가 이미 있으면 재리뷰
   모드 — 이전 보고서를 reviewer 입력에 포함한다.

## Phase 1: 리뷰 패키지 수집 (오케스트레이터가 직접)

```bash
git diff main...HEAD --stat      # 변경 파일 목록
git diff main...HEAD             # diff 전문
git log main..HEAD --format=%s%n%b   # 커밋 메시지에서 RQ-ID/ADR 추출
```

- 커밋 메시지·PR 설명에서 관련 **RQ-ID·ADR 번호**를 추출한다.
- 해당 RQ의 EARS 문장(`harness/specs/requirements.md`)과 ADR 파일 경로를
  목록화한다 — reviewer가 근거를 찾아 헤매지 않도록.
- diff가 크면(대략 1500줄 초과) 전문 대신 **변경 파일 경로 목록 + 읽기 지시**를
  넘긴다. 잘린 diff를 넘기면 reviewer가 못 본 부분을 본 척하게 된다.

## Phase 2: 독립 리뷰 — reviewer (별도 세션, opus)

`Agent(subagent_type: "reviewer", model: "opus")` 호출.

프롬프트에 **포함할 것**:
- diff 전문(또는 파일 경로 목록 + 읽기 지시)
- 관련 RQ-ID 목록과 EARS 문장 인용, 관련 ADR 번호
- 산출 경로: `_workspace/review/{브랜치명}.md`
- 재리뷰면 이전 보고서 경로

프롬프트에 **넣지 말 것**:
- 구현 세션의 대화·의도 설명·"이렇게 한 이유는…"
- 이 변경이 좋다는 평가나 기대하는 판정

> 작성자의 논리를 들으면 작성자의 맹점을 그대로 물려받는다.
> 이 격리가 게이트의 존재 이유다.

## Phase 3: 판정 처리

| 판정 | 처리 |
|---|---|
| **APPROVE** | 보고서 요약과 함께 "머지 가능"을 사용자에게 보고. **머지 실행은 사용자 확인 후** (`gh pr merge`). major/minor가 있으면 함께 보고하고 후속 처리 여부를 확인받는다 |
| **REQUEST_CHANGES** | blocker 목록을 사용자에게 보고. 머지하지 않는다 |

REQUEST_CHANGES 후 라우팅:
- 구현 수정이 필요하면 → `tdd-workflow` 스킬(coder 재호출)
- 스펙·ADR 문제면 → 해당 문서 개정이 먼저 (코드와 **같은 PR**)
- 수정 후 이 스킬을 재실행 (재리뷰 모드)

## CI와의 관계

reviewer APPROVE는 **필요조건이지 충분조건이 아니다.** 머지 전에 CI(`gate` 잡)도
통과해야 한다. 둘 다 통과했는지 확인한다:

```bash
gh pr checks <PR번호>
```

CI 실패 상태에서 reviewer가 APPROVE했다면 그건 reviewer가 결정론적 검사를
대신할 수 없다는 뜻이지 CI를 무시해도 된다는 뜻이 아니다.

## 에러 핸들링

| 상황 | 처리 |
|---|---|
| diff 없음 (main과 동일) | 리뷰 대상 없음 보고. **게이트 통과 아님** |
| 미커밋 변경 존재 | 커밋 먼저 요청 후 중단 |
| reviewer 실행 실패 | 같은 입력으로 1회 재시도. 재실패 시 중단·보고 — **리뷰 생략하고 머지 금지** |
| REQUEST_CHANGES 2회 연속 | 자동 반복 중단 → 사용자 개입 요청 (설계 자체의 재검토 신호) |
| reviewer가 근거 문서 부재를 보고 | 스펙/ADR을 먼저 만든다. 스펙 없는 변경은 그 자체가 문제다 |

## 테스트 시나리오

1. **정상**: `tdd-workflow`가 RQ-16 PASS 후 이 스킬 호출 → reviewer APPROVE →
   CI 통과 확인 → 사용자 확인 → 머지.
2. **에러**: 클라이언트가 명중 판정을 로컬에서 계산하고 서버엔 결과만 통보하는
   코드가 diff에 포함 → reviewer가 서버 권위 위반(RQ-61)으로 blocker 판정 →
   머지 차단 → 재구현 후 재리뷰.
