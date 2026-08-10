# 리뷰 게이트 — 머지 전 독립 리뷰 명세

> **구현 상태**: ✅ 2026-07-21 스캐폴딩 완료. 실행체는
> `.claude/skills/review-gate/SKILL.md`(오케스트레이터)와
> `.claude/agents/reviewer.md`(reviewer 정의)다.
> **정본 분담**(PR #25 이후): 게이트 **규범**(APPROVE 필요조건·격리·검토 항목)은
> 이 문서가, **절차**는 SKILL이, **minor 처리·재검증·CI 선행 정책**은 ADR-0012가
> 정본이다. 규범이 실행체와 어긋나면 실행체를 이 문서에 맞추고, 절차·정책이
> 어긋나면 이 문서가 각 정본을 가리키게 고친다 — 같은 규칙을 두 곳에 복제하지
> 않는다(복제가 명세와 실행체를 서로 반대 방향으로 낡게 만든 사고가 두 번 났다).
> 에이전트 역할 상세는 `harness/agent-roster.md` 참조.

솔로 체제의 리뷰 게이트. GitHub은 자기 PR을 자기가 승인할 수 없으므로,
사람 리뷰 대신 **격리된 세션의 reviewer 에이전트(Opus) APPROVE**를 머지의
필요조건으로 삼는다. 브랜치 보호(status check `gate` 필수)와 함께 이중
게이트를 구성한다: CI가 결정론적 검사를, reviewer가 추론적 검사를 맡는다.

**규칙: reviewer의 APPROVE 없이 머지하지 않는다.** blocker가 있는데 급하다는
이유로 우회하면 이 게이트는 그날로 장식이 된다.

## Phase 0~1: 대상 확정·패키지 수집 → **정본은 `.claude/skills/review-gate/SKILL.md`**

구체적 절차(전제 확인 순서, diff 기준, 보고서 경로 산출, 재리뷰 판별)는
**실행체가 정본**이다. 이 문서는 그 절차를 복제하지 않는다 — 정책 규칙에
적용한 것과 같은 이유이며, PR #25에서 명세와 실행체가 서로 반대 방향으로 낡는
사고가 두 번 났다.

이 문서가 규정하는 것은 **절차가 지켜야 할 규범**뿐이다:

- **대상이 흔들리면 안 된다** — 미커밋 변경 상태로 리뷰하지 않는다
- **기준은 원격이다** — 로컬 `main`이 뒤처지면 이미 머지된 코드가 리뷰 범위에
  섞여 범위가 조용히 부푼다(PR #25에서 실제 발생)
- **재리뷰를 1회차로 처리하지 않는다** — 브랜치명의 `/`를 치환하지 않으면
  보고서 경로가 중첩 디렉토리가 되어 존재 확인이 빗나가고, **이전 blocker 해소
  확인이 통째로 건너뛰어진다**
- **잘린 diff를 넘기지 않는다** — reviewer가 못 본 부분을 본 척하게 된다

## Phase 2: 독립 리뷰 — reviewer (별도 세션, opus)

`Agent(subagent_type: "reviewer", model: "opus")` 호출. 프롬프트에 포함:
- diff 전문(또는 대용량이면 파일 경로 목록 + 읽기 지시), 관련 RQ/ADR 목록
- 산출 경로: `_workspace/review/{브랜치명}.md`
- **구현 세션의 대화·의도 설명은 전달하지 않는다** — 작성자 논리와의 격리가
  이 게이트의 존재 이유다

### 검토 항목 (이 프로젝트 기준)

| # | 항목 | 내용 | 근거 | 기본 심각도 |
|---|---|---|---|---|
| 1 | 스코프 이탈 | 스펙 밖 기능 추가 (팀전·구매 시스템·Pistol 외 무기·계정/로그인·모바일 조작·음성 채팅·매치메이킹·안티치트 등) | requirements.md §11 | blocker |
| 2 | ADR 모순 | 변경이 승인 ADR **전체**(정본: `harness/adr/README.md` 상태표)와 모순 | 해당 ADR 번호 | blocker |
| 3 | 서버 권위 위반 | 클라이언트가 위치·HP·킬·명중을 최종 결정하는 코드 | RQ-61 | blocker |
| 4 | 결정론 위반 | 시뮬레이션 코드의 `Math.random()`·`Date.now()`·`performance.now()` 직접 호출 | ADR-0008 | blocker |
| 5 | 테스트 약화 | 테스트 diff에 기대값 완화·케이스 삭제·skip/only 추가 | CLAUDE.md 금지 | blocker |
| 6 | 렌더 루프 할당 | `useFrame`/렌더 루프 안에서 매 프레임 객체 생성 | `fe.md` 프레임 예산 | major (반복적·명백하면 blocker) |
| 7 | shared 환경 오염 | `src/shared`에서 브라우저 전용(`window`·`document`) 또는 Node 전용(`process`·`fs`) 참조·임포트 | ADR-0010 | major |
| 8 | 값 복제 | 클라이언트·서버가 `src/shared/constants.ts` 값을 자기 쪽에 복제 | ADR-0010 | major |
| 9 | 문서 동행 | 스펙·ADR 변경이 코드와 같은 PR에 있는가 | CLAUDE.md, 지표 M2 | major |
| 10 | 틱 예산 | 서버 틱 경로의 O(n²)·동기 I/O·무제한 루프 | RQ-60 | major |

과잉/과소 설계 지적(더 단순한 방법이 있는가, 반대로 확장 지점을 막았는가)은
근거 문서가 없는 취향 판단이므로 minor로만 남긴다.

## Phase 3: 판정 처리

- **APPROVE** → 사용자에게 보고서 요약과 함께 "머지 가능"을 보고.
  머지 실행은 사용자 확인 후 (`gh pr merge`)

  ⚠️ **`--auto`를 쓰지 않는다.** `main`에 **브랜치 보호가 없어**(실측 2026-08-10:
  `gh api repos/OWNER/REPO/branches/main/protection` → **404 Branch not protected**)
  필수 상태 검사가 하나도 등록돼 있지 않고, `gh pr merge --auto`는 mergeable만
  보고 **CI 완료를 기다리지 않고 즉시 머지한다**. PR #76에서 실제로 발생했다 —
  ADR-0012의 「CI 선행」이 낱말 하나로 빠졌다(원장 28af). 머지 직전 순서를
  **명령으로** 고정한다:

  ```bash
  gh pr checks <PR번호>                      # run id와 headSha를 얻는다
  gh run view <run-id> --json status,conclusion,headSha
  # status=completed · conclusion=success · headSha가 머지할 커밋과 일치할 때만
  gh pr merge <PR번호> --squash --delete-branch
  ```

  ⚠️ **`gh pr checks --watch`로 갈음하지 않는다** — 새 커밋을 push한 직후에는
  **직전 run이 끝나는 순간 종료**해서 새 run을 못 본 채 초록으로 읽힌다
  (PR #76에서 실제로 그렇게 빠져나왔다). **headSha 대조가 유일한 그물이다.**
- **REQUEST_CHANGES** → blocker 목록을 사용자에게 보고.
  - 구현 수정이 필요하면 `tdd.md`(coder 재호출)로 라우팅
  - 스펙·ADR 문제면 해당 문서 개정이 먼저 (같은 PR)
  - 수정 후 이 워크플로우를 재실행 (재리뷰 모드)
- major/minor만 있으면 APPROVE와 동일하게 머지 가능 — 단, 각 지적의 처리는
  아래 ADR-0012 규칙을 따른다

## minor 처리·재검증·CI 선행 → **정본은 ADR-0012**

`harness/adr/0012-review-tail-slim.md`가 정본이다. **이 문서는 규칙을 복제하지
않는다** — 복제하면 갈라지고, 이 저장소는 그 대가를 이미 여러 번 치렀다
(PR #25 리뷰에서 실제로 발생: 명세와 실행체가 서로 반대 방향으로 낡았다).

요지만 적는다. 충돌하면 **ADR-0012가 이긴다**:

- **CI 선행** — PR 생성 → CI 통과 확인 → 리뷰 의뢰. CI가 빨간 상태에서 리뷰를
  시작하지 않는다 (ADR-0012 결정 1)
- **minor 기본 이월** — in-PR은 (a) 계약·스펙 위반 (b) 1줄급+회귀 위험 0.
  **분류 주체는 reviewer**이고 오케스트레이터는 더 가벼운 쪽으로 바꾸지 못한다
  (결정 2)
- **델타 재검증** — blocker·major **또는 (a) 또는 CI 실패 대응 수정**에 필요.
  (b)만이면 `npm run check` + CI로 종결 (결정 3)
- **"즉시 조치 불요" 자동 이월** — 리뷰어가 원장 행 초안(근거·수정안·**착수
  트리거**)을 함께 낸 경우에만. 없으면 되묻는다 (결정 4)

## 에러 핸들링

| 상황 | 처리 |
|---|---|
| diff 없음 (`origin/main`과 동일) | 리뷰 대상 없음 보고, 게이트 통과 아님 |
| reviewer 실행 실패 | 1회 재시도, 재실패 시 중단·보고 (리뷰 생략하고 머지 금지) |
| REQUEST_CHANGES 2회 연속 | 자동 반복 중단 — 사용자 개입 (설계 자체의 재검토 필요 신호) |

## 테스트 시나리오

1. **정상**: `tdd.md` 파이프라인이 RQ-16 PASS → PR 생성 → **CI 통과 확인**
   (ADR-0012 CI 선행) → 이 워크플로우 호출 → reviewer APPROVE → 사용자 확인 →
   머지 → 배포 트리거.
2. **에러**: 클라이언트가 명중 판정을 로컬에서 계산해 서버에는 결과만
   통보하는 코드가 diff에 포함 → reviewer가 서버 권위 위반(RQ-61)에서
   blocker 판정 → 머지 차단 → 재구현 후 재리뷰.
