# 센서 카탈로그 — 가드레일 지도 한 장

모델: Guide(행동 **전** 읽는 규칙) / Sensor(행동 **후** 관찰·교정).
실행: Comp(결정론적·빠름) / Inf(추론적·느림·비결정).
원칙: "반드시"는 hook·CI로 강제, "권장"은 Guide로.

> **이 문서가 Sensor 현황의 정본이다.** 다른 문서(`README.md` 등)는 여기로
> 위임하며 표를 복제하지 않는다.
>
> 아래 표의 상태는 **지금 실제로 존재하는 것만** ✅로 표기한다.
> 아래 Sensors 표에 ✅는 **11행**이지만, **기계가 머지를 막는 것은 5개**다 —
> 스펙 동결 게이트 · lint/typecheck · 단위·통합 테스트 · **맵 에셋 출처 게이트** ·
> **원장 표 무결성 게이트**. 테스트-코드 동행 검사는
> 경고일 뿐이고, evaluator·PR 리뷰 게이트·트랙 B rubric은 규율로 지켜진다.
> **세는 기준: 상태 열이 그 기호로 시작하는 행**(비고 안의 기호는 세지 않는다 —
> 🟡인 골든 승인 게이트 행이 비고에 "완전 강제(✅)로 올리려면"을 담고 있어,
> 행 단위로 포함 여부를 세면 ✅가 1 많아진다).
> (2026-07-30 정정 — 앞서 "✅ 8행 / 막는 것 3개"였고 맵 에셋 출처 게이트가 등재
> 누락이었다. **정정 자체도 한 번 틀렸다**: 처음 고칠 때 12행/직전 10행이라 적었는데
> 기준대로 세면 11행/직전 9행이다. "세는 기준을 함께 둔다"고 쓰면서 기준과 다른
> 방식으로 센 것이고, PR #39 리뷰가 잡았다. 이 문서가 스스로 "Sensor 현황의 정본"이라
> 선언하므로 무게가 있다.)
> coder tests/ 기존 단언 접촉 차단 게이트(17f)는 이 셋과 다른 층위다 —
> **세션 중 특정 역할(coder)의 Write/Edit/MultiEdit 툴 호출 중 ADR-0011이
> 금지한 부분(기존 단언 접촉)만** 막을 뿐, PR·머지 시점에 걸리는 게이트가
> 아니다(Bash 경유는 못 막고, 그 경로는 여전히 evaluator 사후 diff가 PR
> 시점에 잡는다) — 그래서 "3개"에 포함하지 않는다.
> (숫자만 적으면 다음 개정에서 어긋나므로 세는 기준을 함께 둔다.)
>
> "규칙이 문서에 쓰여 있다"와 "규칙이 강제된다"는 다르다는 것이 이 표의
> 요점이다. ⚠️가 붙은 항목은 **규율로만 지켜진다** — 우회를 막는 장치가 없다.

## Guides (feed-forward)

| 이름 | 실행 | 배치 | 상태 |
|---|---|---|---|
| CLAUDE.md (헌법) | — | 세션 시작 시 로드 | ✅ |
| harness/specs/requirements.md | — | 작업 착수 시 참조 | ✅ (v1.0, 🟡 0개) |
| harness/adr/ | — | 아키텍처 관련 작업 시 | ✅ ADR-0001~0010 — 승인 상태의 정본은 `harness/adr/README.md` 상태표다(여기 복제하지 않는다) |
| plan mode 승인 (3스텝 이상 작업 전) | — | 작업 착수 전 | ✅ (CLAUDE.md 최상위 규칙) |

## Sensors (feedback)

| 이름 | 실행 | 배치 | 강제 수단 | 상태 |
|---|---|---|---|---|
| 트래젝토리 로그 | Comp | 세션 종료(Stop) | hook (.claude/hooks) | ⬜미구축 |
| 스펙 동결 게이트 (🟡 존재 시 구현 차단) | Comp | 구현 파일 수정 직전(PreToolUse) + PR(CI fail) | `.claude/hooks/gate_spec_freeze.py` exit 2 + `.github/workflows/ci.yml` | ✅ **2026-07-21 구축.** 판정 로직은 스크립트 1개에 있고 hook·CI가 **같은 코드**를 호출한다 — 로컬과 CI가 다르게 판정하는 게이트는 신뢰를 잃으므로 정규식을 CI에 따로 두지 않았다. `--selftest`가 게이트 자신을 검증하며 CI 첫 스텝으로 돈다. 차단 대상 디렉토리는 스크립트 상단 `BLOCKED_TOP_DIRS` — ADR-0010으로 레이아웃이 확정되어 **갱신 불요**로 판정됐다(`progress.md` 18). CI는 활성 상태이며 PR #1~#3이 그 위에서 돌았다. ⚠️ 레이아웃을 바꾸는 ADR은 반드시 이 집합의 갱신을 동반해야 한다 |
| coder tests/ 기존 단언 접촉 차단 게이트 | Comp | Write/Edit/MultiEdit 직전(PreToolUse), coder 역할 한정 | `.claude/hooks/gate_coder_test_write.py` exit 2 | ✅ **2026-07-26 구축, 같은 날 델타 리뷰 blocker로 범위 재작업.** stdin JSON의 `agent_type` 필드(Claude Code 2.1.220 실측)로 coder만 식별한다. **1차 버전은 coder의 tests/ 쓰기 전체를 막아 ADR-0011 결정 3(test-after 영역의 coder 순증 허용)과 충돌했다** — coder가 신규 테스트 파일을 만드는 표준 경로(원장 22b)의 첫 Write에서 파이프라인이 죽는 blocker였다. **재작업**: `Write`+신규 파일(미존재 경로)=허용, `Write`+기존 파일 덮어쓰기=차단, `Edit`/`MultiEdit`=`old_string`이 `new_string`에 그대로 포함되는 "순수 삽입"만 허용, 그 외(기존 단언 치환·삭제)는 차단. `agent_type`이 `"coder"`가 아니면(test-writer·evaluator·reviewer·메인 세션) 무조건 fail-open. 라이브 6케이스로 확인: coder 신규 파일 Write 허용/coder 기존 파일 Write 차단/coder 순수 삽입 Edit 허용/coder 치환 Edit 차단/test-writer 통과/evaluator 통과. `--selftest` 내장(CI·`check.sh` 양쪽에 배선 — major 2 대응). ⚠️ **matcher가 Write\|Edit\|MultiEdit뿐이라 Bash 경유 쓰기는 못 막는다** — 그 경로는 기존 evaluator 사후 diff 검출(SHA 사슬)이 계속 담당. ⚠️ `MultiEdit`의 실제 payload 형태(`edits` 배열)는 라이브로 확인하지 못했다(이 Claude Code 버전은 MultiEdit을 permission 엔진이 "알려진 툴 아님"으로 취급 — 17g 조사) — 형태가 예상과 다르면 fail-open |
| 맵 에셋 출처 게이트 (Dust2 원본 반입 차단) | Comp | 파일 쓰기 직전(PreToolUse) + PR(CI fail) | `.claude/hooks/gate_map_asset_provenance.py` exit 2 + `ci.yml`·`check.sh`의 `--check-paths` | ✅ **2026-07-29 구축(PR #37, 원장 26r).** 두 층이다 — 훅이 **쓰기 전 경로**를, CI·`check.sh`의 `--check-paths`가 **커밋된 파일의 내용까지** 훑는다(훅만으로는 파일이 아직 없어 내용 검사가 성립하지 않는다). selftest 내장(차단 5·허용 5) — 작성 중 그 selftest가 정규식 결함을 실제로 잡았다. ⚠️ **이 게이트는 실수·부주의만 막는다** — 리토폴로지·트레이싱·재저장은 원리적으로 검출 불가이며 **통과가 결백의 증명이 아니다**(훅 docblock에 명시). 등재 누락이었다가 2026-07-30에 추가됐다 |
| 원장 표 무결성 게이트 (열 수·집계 오염 차단) | Comp | 원장 수정 직전(PreToolUse) + `check.sh`·PR(CI fail) | `.claude/hooks/gate_ledger_table.py` exit 2 + `--check` | ✅ **2026-07-30 구축(원장 26ag).** 이월을 원장으로 몰아주는 정책의 안전성은 원장 무결성에 정비례하는데(ADR-0012) **표가 깨져도 아무것도 실패하지 않았다** — 7행이 깨진 채 CI를 통과했고 그중 `26l`은 ⬜ 집계를 97로 만들었다(참값 98). **이스케이프-인식 분할**로 센다 — naive 파이프 분할은 정상 4행을 오탐하며, 그 오탐이 이 결함의 최초 진단을 틀리게 만들었다. 부족·초과를 나눠 보고하고 상태 열 앞 파이프를 별도 검사한다(집계 오염 경로는 필드 수만으로 안 드러난다). 훅은 **코드 스팬 안 맨 파이프만** 본다 — 정상 셀 경계 파이프는 백틱 밖이라 오탐이 없다. selftest 차단 6·허용 8(허용에 "이스케이프 파이프가 상태 열 뒤" 형태를 넣어 오탐 회귀를 못박았다). ⚠️ **열 수와 상태 열 위치만** 본다 — 셀 내용의 정확성(수치가 최신인가)은 보지 않는다 |
| 골든 정답 수정 승인 게이트 | Comp | harness/evals/golden/** Edit·Write 시 | permissions (ask) | 🟡 **부분 구축(2026-07-26)** — `permissions.ask`에 `Edit(./harness/evals/golden/**)` 1건(라이브 실측: Edit 규칙이 Write까지 커버, `evals/README.md` 참고). `Edit`·`Write`·`MultiEdit` 툴 경로만 막고 **`Bash` 경유 쓰기는 못 막는다** — Bash heredoc·리다이렉트로 골든 파일을 고치면 이 표를 그대로 통과한다. 완전 강제(✅)로 올리려면 Bash까지 보는 별도 장치(hook)가 필요 — 등재: `progress.md` 17g |
| 파일 수정 후 빠른 검사 | Comp | 수정 직후(PostToolUse) | hook → `scripts/check.sh --fast` | ⬜미구축 — **스크립트는 있으나 호출자가 없다.** `.claude/settings.json`에 PostToolUse hook 미등록 |
| lint / typecheck | Comp | 로컬 `npm run check` + CI | eslint + `tsc --noEmit` | ✅ **2026-07-21 구축.** `scripts/check.sh`가 로컬·CI 공통 진입점. `src/shared` 전용 규칙(환경 중립·결정론)도 lint로 강제 |
| 단위·통합 테스트 (트랙 A) | Comp | CI, PR 머지 게이트 | `ci.yml` → Vitest | ✅ **2026-07-21 구축.** `tests/{unit,integration}` 14건 통과, 실측 4.2초. GA 골든 케이스와의 대응은 RQ 구현 시 채워진다 |
| 테스트-코드 동행 검사 (M3 프록시) | Comp | CI, PR | `ci.yml` (경고) | ✅ 구축 — 단 **경고일 뿐 머지를 막지 않는다.** 커밋 *순서*가 아니라 같은 PR에 테스트가 함께 바뀌었는지만 본다. ⚠️ 커밋 순서를 강제하는 게이트는 없다 |
| 독립 평가 에이전트 (evaluator) | Inf | 각 RQ 구현 직후 (tdd-workflow Phase 3) | 오케스트레이터 스킬 `.claude/skills/tdd-workflow/SKILL.md` | ✅ **2026-07-21 구축.** `.claude/agents/evaluator.md`(opus). 검증 항목 6건(스위트 재실행·골든 커버리지·Colyseus 경계면 필드 대조·결정론·테스트 약화·스코프). 격리: RQ-ID·`_workspace/{RQ-ID}/` 경로·테스트 커밋 SHA만 받고 coder 대화는 받지 않는다 — 자기 채점 방지. ⚠️ 이 게이트는 **규율로만 강제된다** — 파이프라인을 건너뛰고 직접 구현하는 것을 막는 hook·CI는 없다 |
| 트랙 B rubric 체크 | Inf | 하네스 변경 시·주간 | 사람 (수동) | ✅ 절차만 (harness/evals/README.md + track-b 시드 완료) |
| PR 리뷰 게이트 (reviewer, 솔로 대체) | Inf | PR 머지 전 | APPROVE 없이 머지 금지 + 브랜치 보호(status check 필수) | ✅ **2026-07-21 구축.** `.claude/skills/review-gate/SKILL.md` + `.claude/agents/reviewer.md`(opus). 검토 항목 10건(스코프 이탈·ADR 모순·서버 권위·결정론·테스트 약화·렌더 루프 할당·shared 환경오염·값 복제·문서 동행·틱 예산). 격리 규칙: 구현 세션의 대화를 reviewer에 넘기지 않는다. ⚠️ 브랜치 보호(status check 필수) 설정은 **아직 안 됨** — 지금은 규율로만 지켜진다 |
| 배포 후 스모크 | Comp | main 머지 → 배포 직후 | deploy.yml → smoke.sh | 🟡 RQ-80·RQ-81(배포·저장소) 구현 후 |
| 런타임 가드(Node ≥24 차단) | Comp | 전체 검증(`npm run check`)·CI — `--fast` 제외 | `scripts/check.sh` exit 1 (major ≥ 24) | ✅ 2026-07-28 구축 — 통합 워커가 v24에서 네이티브 abort(`0xC0000409`). `engines`는 npm 경고일 뿐이라 검증 진입점에서 직접 막는다. 근거: 원장 28a |

## 게임 특화 센서

채팅 앱에는 없던 종류의 실패 모드 — 실시간 시뮬레이션·서버 권위·프레임
예산이 걸린 프로젝트라서 필요하다. CLAUDE.md §게임 특화 불변식이 이미 이
넷을 리뷰 blocker로 선언했다(Guide 쪽은 ✅). 그런데도 넷 중 어느 것도
자동 강제(Sensor) 장치는 아직 없다 — 서버·클라이언트 코드 자체가 없어서다.
지금은 전부 "사람이 CLAUDE.md를 읽고 지킨다"에 의존한다.

**우선순위 변경**: 결정론 위반 감지를 1순위로 올린다. RQ-90 확정 전에는
"시뮬레이션이 언젠가 난수를 쓰겠지"라는 추상적 위험이었지만, RQ-90이
탄퍼짐을 "서버 시드 기반 랜덤 콘"으로 확정하고 `requirements.md`가
`Math.random()` 직접 호출 금지를 명문화(ADR-0008 인용)하면서 **실제로
감시해야 할 첫 코드(사격 판정 탄퍼짐 계산)가 생겼다** — 더 이상 가상의
사전 대비가 아니라 곧 작성될 코드에 바로 적용돼야 하는 규칙이다.

| 이름 | 실행 | 배치 | 강제 수단 | 상태 |
|---|---|---|---|---|
| 결정론 위반 감지 **(우선순위 상향)** | Comp | CI lint 단계 | eslint no-restricted-globals(Date.now, Math.random) — src/server/sim/** 스코프. 시드 가능한 RNG 사용 강제. ADR-0008(테스트 전략, 승인)·CLAUDE.md §게임 특화 불변식이 이미 요구를 선언했고, RQ-90(탄퍼짐 랜덤 콘)이 첫 실제 대상이다 | ⬜미구축 — 규칙 자체는 근거(ADR-0008·RQ-90)가 갖춰졌으니 lint 규칙 작성이 다음 단계 |
| 틱 예산 초과 감지 | Comp | 서버 런타임(틱 루프 내 자체 계측) | 틱마다 소요시간 측정(perf 타이머) → 로그/카운터, 33ms(RQ-60, 30Hz 예산, 총 20 연결 브로드캐스트 조건 — RQ-03) 초과 시 경고. 추후 부하 테스트 CI 게이트 후보 | ⬜미구축 — 서버 틱 루프 자체가 없음 |
| 프레임 예산 회귀 | Comp/Inf | PR 리뷰(렌더 루프 코드) + 수동 프로파일링 | 코드 리뷰 체크리스트("useFrame/렌더 루프 내 할당 금지", ADR-0001·CLAUDE.md §게임 특화 불변식) + Chrome DevTools/Playwright 트레이스 수동 확인. 목표는 RQ-01 확정치(내장 GPU Iris Xe급 기준 30fps=33.3ms 예산) — 애초에 60fps를 가정했던 이전 초안은 폐기. 자동 CI 게이트는 브라우저 렌더링이 필요해 후순위 | ⬜미구축 — 클라이언트 렌더 루프 자체가 없음 |
| 서버 권위 위반 정적 검사 | Comp | CI lint 단계 | eslint custom rule 후보 — src/client/** 안에서 HP·킬·위치를 확정 대입하는 패턴(RQ-61 위반, CLAUDE.md §게임 특화 불변식) 탐지. 규칙 자체가 아직 설계 안 됨(패턴 정의 필요) | ⬜미구축 |

## 운영 규칙

1. 센서는 가능한 한 왼쪽(수정 직후 > pre-commit > CI > 리뷰)에 배치한다.
2. 센서 에러 메시지에는 "어떻게 고치는지"를 담는다 — 에이전트가 읽고
   자기 교정하는 것이 목적이다.
3. 같은 실수가 2회 반복되면: 그 실수를 잡는 센서를 추가하거나,
   Guide 한 줄을 추가한다. (둘 다는 과잉 — 하나만)
4. 분기마다 이 표를 갱신한다. 상태가 전부 ✅면 이 문서가 곧 회고 자료다.
