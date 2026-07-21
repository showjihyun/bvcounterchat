# 리뷰 게이트 — 머지 전 독립 리뷰 명세

> **구현 상태**: ✅ 2026-07-21 스캐폴딩 완료. 실행체는
> `.claude/skills/review-gate/SKILL.md`(오케스트레이터)와
> `.claude/agents/reviewer.md`(reviewer 정의)다. 이 문서는 그 명세이며,
> 둘 사이에 차이가 생기면 **실행체를 이 문서에 맞춘다**.
> 에이전트 역할 상세는 `harness/agent-roster.md` 참조.

솔로 체제의 리뷰 게이트. GitHub은 자기 PR을 자기가 승인할 수 없으므로,
사람 리뷰 대신 **격리된 세션의 reviewer 에이전트(Opus) APPROVE**를 머지의
필요조건으로 삼는다. 브랜치 보호(status check `gate` 필수)와 함께 이중
게이트를 구성한다: CI가 결정론적 검사를, reviewer가 추론적 검사를 맡는다.

**규칙: reviewer의 APPROVE 없이 머지하지 않는다.** blocker가 있는데 급하다는
이유로 우회하면 이 게이트는 그날로 장식이 된다.

## Phase 0: 대상·전제 확인

1. 리뷰 대상 결정: 현재 브랜치 vs `main` (또는 사용자가 지정한 PR/브랜치)
2. 전제: 작업이 커밋된 상태여야 한다. 미커밋 변경이 있으면 먼저 커밋을 요청
3. **보고서 경로**: `_workspace/review/{브랜치명의 `/`를 `-`로 치환}.md`.
   브랜치 컨벤션이 `feat/<RQ-ID>-<설명>`이라 이름에 항상 슬래시가 들어간다 —
   치환하지 않으면 중첩 디렉토리가 되고, Phase 0의 존재 확인이 빗나가
   **재리뷰가 조용히 1회차 리뷰로 처리된다**(이전 blocker 해소 확인이 통째로
   건너뛰어진다). 예: `feat/RQ-01-scaffolding` → `feat-RQ-01-scaffolding.md`.
4. 치환 후 경로에 파일이 있으면 **재리뷰 모드** — 이전 보고서를 reviewer 입력에 포함한다

## Phase 1: 리뷰 패키지 수집 (오케스트레이터가 직접)

- `git diff main...HEAD` + `--stat` (변경 파일 목록)
- PR 설명·커밋 메시지에서 관련 RQ-ID/ADR 번호 추출
- 관련 스펙 문장(`requirements.md`)과 ADR 파일 경로 목록화

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
| 2 | ADR 모순 | 변경이 승인 ADR(0001~0010)과 모순 | 해당 ADR 번호 | blocker |
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
- **REQUEST_CHANGES** → blocker 목록을 사용자에게 보고.
  - 구현 수정이 필요하면 `tdd.md`(coder 재호출)로 라우팅
  - 스펙·ADR 문제면 해당 문서 개정이 먼저 (같은 PR)
  - 수정 후 이 워크플로우를 재실행 (재리뷰 모드)
- major/minor만 있으면 APPROVE와 동일하게 머지 가능 — 단, 지적 사항을
  사용자에게 보고하고 후속 처리 여부를 확인받는다

## 에러 핸들링

| 상황 | 처리 |
|---|---|
| diff 없음 (main과 동일) | 리뷰 대상 없음 보고, 게이트 통과 아님 |
| reviewer 실행 실패 | 1회 재시도, 재실패 시 중단·보고 (리뷰 생략하고 머지 금지) |
| REQUEST_CHANGES 2회 연속 | 자동 반복 중단 — 사용자 개입 (설계 자체의 재검토 필요 신호) |

## 테스트 시나리오

1. **정상**: `tdd.md` 파이프라인이 RQ-16 PASS 후 이 워크플로우 호출 →
   reviewer APPROVE → 사용자 확인 → 머지 → 배포 트리거.
2. **에러**: 클라이언트가 명중 판정을 로컬에서 계산해 서버에는 결과만
   통보하는 코드가 diff에 포함 → reviewer가 서버 권위 위반(RQ-61)에서
   blocker 판정 → 머지 차단 → 재구현 후 재리뷰.
