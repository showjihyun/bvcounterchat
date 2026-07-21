# 골든 eval 세트

가볍게 시작한다. 무거운 eval 프레임워크·LLM judge 파이프라인은 만들지 않는다.

- **트랙 A** (`golden/track-a-product.jsonl`): 제품 행동. 스택 확정 후 각 케이스를
  통합 테스트 코드로 구현하고 `verify` 필드에 테스트 파일 경로를 적는다.
  `blocked_on_spec` 케이스는 인터뷰 완료 후 then을 확정하고 todo로 바꾼다.
  (RQ-90 무기 수치, RQ-92 이동 수치처럼 🟡 PENDING인 정확한 값에 의존하는
  케이스만 blocked_on_spec으로 표시한다 — 관계·순서·권위 같은 이미 ✅확정된
  규칙은 임의 수치 없이도 검증 가능하므로 todo로 둔다.)
- **트랙 B** (`golden/track-b-harness.jsonl`): 하네스 행동. CLAUDE.md·hook·skill을
  바꿨을 때 새 세션에서 태스크를 던져보고 rubric을 사람이 체크한다.
  (자동화하고 싶어지면 그때 LLM judge를 붙인다 — 지금은 수동으로 충분)

## 승격 루프

주간 회고에서 `.harness/logs/trajectory.jsonl`을 훑고,
이상했던 세션의 입력을 여기 새 케이스로 추가한다.
정답(then/rubric)은 반드시 사람이 쓴다 — 에이전트가 자기 정답을 쓰게 하지 않는다.

강제 수단(계획): `.claude/settings.json` permissions가 `harness/evals/golden/**`
수정을 승인(ask) 게이트로 막는다 — 에이전트가 초안을 쓰더라도 사람 승인을 거친다.

⚠️ **현재 이 ask 게이트는 없다.** `.claude/settings.json`은 존재하지만
`permissions`에 `deny` 3건(시크릿 파일)만 있고 골든 파일 항목이 없다 —
**지금 이 규칙은 규율로만 지켜진다.** 등재: `harness/progress.md` 항목 17g.
파이프라인 실전(RQ 구현) 전에 넣는 편이 낫다 — 에이전트가 자기 정답을 쓰는
것을 막는 장치이기 때문이다.
