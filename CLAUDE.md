# ChatStrike — 프로젝트 헌법 (포인터 인덱스)

채팅이 중심인 웹 기반 3D FPS 소셜 게임. 최대 10명, 브라우저 전용, 개인전.
이 파일은 최소한의 규칙과 **참조 경로**만 담는다 — 상세는 참조 파일에서 읽는다.

## 진실 공급원 (충돌 시 위가 이김)

1. `harness/specs/requirements.md` — 요구사항(EARS). 여기 없는 기능은 만들지 않는다.
2. `harness/adr/` — 아키텍처 결정. 모순 구현 금지, 변경은 새 ADR 먼저.
3. 이 파일 — 최상위 규칙. 모호하면 추측하지 말고 질문한다.
4. `docs/design/DESIGN.md` — UI 디자인 (🟡 아직 없음. UI 작업 착수 전 필요).
5. `docs/req/` — 사용자가 제공한 원본 요구사항. requirements.md의 **입력**이며,
   정규화 이후에는 requirements.md가 이긴다. 원본이 바뀌면 requirements.md를 개정한다.

## 참조 맵 — 작업 유형별 읽을 파일

| 작업 | 먼저 읽을 파일 |
|---|---|
| **모든 개발 작업 시작·완료** | `harness/progress.md` — 진행 원장, 갱신 의무 |
| 하네스 전체 조망 | `harness/README.md` |
| 스펙 인터뷰 | `harness/specs/interview/question-bank.md` |
| RQ 구현·테스트·평가 | `harness/workflow/tdd.md` |
| 클라이언트·HUD·3D 작업 | `harness/workflow/fe.md` |
| PR 머지 전 | `harness/workflow/review-gate.md` — APPROVE 없이 머지 금지 |
| 골든 케이스·평가 | `harness/evals/README.md` |
| 하네스 점검·이력 | `harness/sensor-catalog.md`, `harness/changelog.md` |

## 최상위 규칙

- **원장 우선**: 작업 시작 전 `harness/progress.md`에 요구사항·참조 파일을
  확인·기록(🔄)하고, 완료 시 체크(✅)한다. 원장에 없는 작업은 행을 추가한 뒤 시작한다.
- **🟡 미결 스펙에는 착수하지 않는다**: `requirements.md`에 🟡가 있는 RQ는
  Deep Interview가 먼저다. 특히 RQ-90·RQ-92(무기·이동 수치)는 게임의 감각
  그 자체이므로 추측 구현이 곧 재작업이다.
- **단계 전환은 대화식으로**: 다음 단계 진입 전 최소 3개 선택지를 제시하고
  결정을 받는다. 첫 번째가 권장안 "(Recommended)".
- 읽지 않은 파일·검증하지 않은 사실에 대해 단정하지 않는다 — 판단의 근거는
  직접 확인한 증거(파일 내용·실행 출력)다.
- 스펙 항목 1개 = 브랜치 1개 = PR 1개. 스펙 변경은 코드와 같은 PR에.
  (예외 — **구현 게이트 이전**: 해당 RQ의 코드가 아직 없으면 스펙 신설·개정을
  코드 없이 할 수 있다. 게이트는 **RQ 단위로 판정**하며 이 문서가 유일한 정의처다.
  ADR·하네스·디자인 전용 PR도 드리프트가 아니라 백로그 추가다.)
- **테스트·비판적 점검은 반드시 별도 에이전트 세션에서 한다.** 검증·평가·리뷰·
  QA를 작업한 세션이 직접 수행하지 않는다 — 컨텍스트를 공유하는 순간 자기 채점이
  되고, 작업자의 맹점이 검증자에게 그대로 옮겨간다. 데이터는 파일로만 전달하고
  대화·의도 설명은 넘기지 않는다. (해당: `tdd-workflow`의 evaluator,
  `review-gate`의 reviewer, 그리고 그 밖의 모든 검증 요청)
  ↔ 진행을 위한 단순 실행(설치·빌드·git 조작)은 여기 해당하지 않는다.
- TDD (Red→Green→Refactor). 완료 주장에는 테스트 실행 출력을 증거로.
- 3스텝 이상 작업은 plan mode 승인 먼저. 탐색·조사는 서브에이전트에게.
- 하네스 변경 시 `harness/changelog.md`에 기록.

## 게임 특화 불변식 (위반은 리뷰 blocker)

- **서버 권위**(RQ-61): 클라이언트 코드가 HP·킬·명중·최종 위치를 확정하지 않는다.
  클라이언트는 예측(RQ-62)과 표현만 한다. 서버가 보낸 값과 다르면 서버가 이긴다.
- **결정론**(ADR-0008): 시뮬레이션 코드에서 `Math.random()`·`Date.now()`를 직접
  호출하지 않는다. 난수는 시드 주입, 시간은 틱에서 받는다 — 그래야 테스트된다.
- **프레임 예산**(ADR-0001): 렌더 루프(`useFrame`) 안에서 객체를 할당하지 않는다.
  벡터·행렬은 재사용한다.
- **틱 예산**(RQ-60): 서버 틱 1회는 33ms를 넘지 않는다.

## 금지

- 스펙에 없는 기능 추가 (스코프 크리프)
- 🟡 PENDING이 남은 상태에서 `src/`·`tests/` 구현 착수
- 실패 테스트를 스킵/삭제로 "해결" · ADR 없는 라이브러리/아키텍처 변경
- Dust2 원본 지오메트리·텍스처·에셋의 복제·반입 (RQ-30 — 오리지널 맵만)
- 시크릿·환경 파일 읽기/커밋

## 명령어·컨벤션

- 커밋: `feat|fix|chore|test|docs(scope): 설명` · 브랜치: `feat/<RQ-ID>-<설명>`
- 검증 일괄: `npm run check` (= `scripts/check.sh` — 게이트 → lint → typecheck → test)
- 개별: `npm run lint` · `npm run typecheck` · `npm test` · `npm run build`
- 스펙 동결 상태 확인: `npm run gate`
