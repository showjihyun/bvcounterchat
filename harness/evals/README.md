# 골든 eval 세트

가볍게 시작한다. 무거운 eval 프레임워크·LLM judge 파이프라인은 만들지 않는다.

- **트랙 A** (`golden/track-a-product.jsonl`): 제품 행동. 스택 확정 후 각 케이스를
  통합 테스트 코드로 구현하고 `verify` 필드에 테스트 파일 경로를 적는다.
  `blocked_on_spec` 케이스는 인터뷰 완료 후 then을 확정하고 todo로 바꾼다.
  (RQ-90 무기 수치, RQ-92 이동 수치처럼 🟡 PENDING인 정확한 값에 의존하는
  케이스만 blocked_on_spec으로 표시한다 — 관계·순서·권위 같은 이미 ✅확정된
  규칙은 임의 수치 없이도 검증 가능하므로 todo로 둔다.)
  **예외(RQ-80, GA-41~43, 리뷰 minor 7)**: 배포 인프라(Docker/Nginx) 검증은
  vitest 통합 테스트 경계 밖이라 `verify`가 테스트 파일이 아니라 **셸
  스크립트**(`scripts/smoke-deploy.sh`)다. 이 스크립트는 `scripts/check.sh`·
  CI 워크플로 어디에도 연결돼 있지 않다(ADR-0008 §7의 3분 예산상 실 Docker
  빌드·기동을 CI에 넣는 건 부적절 — 제외가 의도적 설계). 즉 **사람이 배포
  전 수동으로 실행**해야 하는 게이트이며, `nginx.conf`·`Dockerfile`의 회귀는
  일반 PR의 `check.sh`가 잡지 못한다 — 이 인프라 파일을 건드리는 PR은
  리뷰어가 별도로 `bash scripts/smoke-deploy.sh` 실행을 요구해야 한다.
- **트랙 B** (`golden/track-b-harness.jsonl`): 하네스 행동. CLAUDE.md·hook·skill을
  바꿨을 때 새 세션에서 태스크를 던져보고 rubric을 사람이 체크한다.
  (자동화하고 싶어지면 그때 LLM judge를 붙인다 — 지금은 수동으로 충분)

## 승격 루프

주간 회고에서 `.harness/logs/trajectory.jsonl`을 훑고,
이상했던 세션의 입력을 여기 새 케이스로 추가한다.
골든 파일을 편집할 때는 **전체 재직렬화 금지** — 바꿀 필드(status 등)만
in-place로 수정해 diff를 최소화한다. 승인 게이트 대상 파일이라 diff가
부풀면 사람이 실제 변경을 대조하기 어려워진다(PR #6 리뷰 minor에서 검출 —
status 4건 변경에 29행 공백 리포맷이 섞였다).

**정답(then/rubric)의 저자는 사람이다.** 다만 **파일 쓰기 자체는 에이전트에게 열려 있다**
(2026-08-07 사용자 결정, 원장 24ax) — 상태 전환(`todo`→`done`), `verify` 경로 채우기,
형식·오탈자, 그리고 **사용자가 이미 결정한 수치를 골든 문장으로 옮기는 일**은 묻지 않고 한다.

⚠️ **열린 것은 쓰기 권한이지 저자 자격이 아니다.** 에이전트가 **새 판정 기준을 창작할 때는**
그 given/when/then을 **사용자에게 그대로 보여준 뒤** 진행한다 — 막지는 않되 보이게 둔다.
이 구분이 필요한 이유는 골든이 평가의 정답지이기 때문이다: 정답과 구현을 같은 주체가 쓰면
평가가 자기 채점이 된다(검증을 격리 세션에 맡기는 것과 같은 이유, CLAUDE.md).

~~강제 수단: `.claude/settings.json` `permissions.ask`에
`Edit(./harness/evals/golden/**)` 규칙이 있다(2026-07-26, 원장 17g).~~
**→ 2026-08-07 사용자 결정으로 그 규칙을 제거했다**(원장 24ax). 아래 실측 서술은
그 규칙이 있던 동안의 관측이며 **이력으로 남긴다** — 되돌릴 때 다시 유효하다.
Claude Code 2.1.220 실측: `Edit(path)` 규칙 하나가 **Write 툴을 포함한 모든
파일 편집 툴**을 커버한다(Claude Code 자신의 안내 문구 — "Edit rules cover
all file-editing tools"). 대조 실험: 같은 세션에서 다른 경로에 대한 Write는
자동 승인 모드에서 그대로 통과하고, golden 경로에 대한 Write는 승인 없이는
막힌다(비대화형 세션은 승인할 사람이 없어 그대로 실패한다).

⚠️ **정직한 한계**: 이 규칙은 `Edit`·`Write`·`MultiEdit` **툴 호출 경로만**
본다. `Bash` 툴로 golden 파일에 직접 쓰는 경로(셸 리다이렉트, python/node
heredoc 등)는 이 permission 표가 전혀 보지 못한다 — `Bash(...)`에 대한
별도 규칙이 없다. 즉 "표준 편집 툴로 실수하는 것"만 막고, 의도적으로
Bash를 경유하면 여전히 통과한다. 파이프라인 실전에서 골든 편집이 주로
Bash heredoc으로 이뤄져 왔다면 이 게이트는 그 경로에서는 발화하지 않으며,
**규율이 여전히 주 방어선**이다.
