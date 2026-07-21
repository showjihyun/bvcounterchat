# 센서 카탈로그 — 가드레일 지도 한 장

모델: Guide(행동 **전** 읽는 규칙) / Sensor(행동 **후** 관찰·교정).
실행: Comp(결정론적·빠름) / Inf(추론적·느림·비결정).
원칙: "반드시"는 hook·CI로 강제, "권장"은 Guide로.

> 이 프로젝트는 코드가 전무한 상태(greenfield)에서 하네스 문서부터 세운다.
> 아래 표의 상태는 **지금 실제로 존재하는 것만** ✅로 표기한다. 2026-07-21
> Deep Interview 완료로 CLAUDE.md·harness/adr/(0001~0009)·workflow 문서가
> 갖춰졌고, 같은 날 **첫 Sensor(스펙 동결 게이트)가 실제로 구축**됐다
> — `.claude/hooks/gate_spec_freeze.py` + `.claude/settings.json` +
> `.github/workflows/ci.yml`. 나머지 Sensor는 검증할 코드 자체가 없어
> 그대로 ⬜미구축이다.
>
> "규칙이 문서에 쓰여 있다"와 "규칙이 강제된다"는 다르다는 것이 이 표의
> 요점이며, 지금 그 경계선은 **Sensor 1개**다.

## Guides (feed-forward)

| 이름 | 실행 | 배치 | 상태 |
|---|---|---|---|
| CLAUDE.md (헌법) | — | 세션 시작 시 로드 | ✅ |
| harness/specs/requirements.md | — | 작업 착수 시 참조 | ✅ (v1.0, 🟡 0개) |
| harness/adr/ | — | 아키텍처 관련 작업 시 | ✅ (0001~0009 존재 — 0001·0002·0003·0006·0008·0009 승인, 0004·0005·0007은 아직 제안) |
| plan mode 승인 (3스텝 이상 작업 전) | — | 작업 착수 전 | ✅ (CLAUDE.md 최상위 규칙) |

## Sensors (feedback)

| 이름 | 실행 | 배치 | 강제 수단 | 상태 |
|---|---|---|---|---|
| 트래젝토리 로그 | Comp | 세션 종료(Stop) | hook (.claude/hooks) | ⬜미구축 |
| 스펙 동결 게이트 (🟡 존재 시 구현 차단) | Comp | 구현 파일 수정 직전(PreToolUse) + PR(CI fail) | `.claude/hooks/gate_spec_freeze.py` exit 2 + `.github/workflows/ci.yml` | ✅ **2026-07-21 구축.** 판정 로직은 스크립트 1개에 있고 hook·CI가 **같은 코드**를 호출한다 — 로컬과 CI가 다르게 판정하는 게이트는 신뢰를 잃으므로 정규식을 CI에 따로 두지 않았다. `--selftest`가 게이트 자신을 검증하며 CI 첫 스텝으로 돈다. 차단 대상 디렉토리는 스크립트 상단 `BLOCKED_TOP_DIRS` — **스캐폴딩에서 실제 레이아웃이 정해지면 갱신 필요**(빠뜨린 디렉토리 = 게이트의 구멍). CI는 git 저장소 초기화 후 활성 |
| 골든 정답 수정 승인 게이트 | Comp | harness/evals/golden/** Edit·Write 시 | permissions (ask) | ⬜미구축 (.claude/settings.json 자체가 없음) |
| 파일 수정 후 빠른 검사 | Comp | 수정 직후(PostToolUse) | hook → check 스크립트 | ⬜미구축 (스크립트·package.json 없음) |
| lint / typecheck | Comp | CI (check 스크립트) | eslint + tsc --noEmit | ⬜미구축 (package.json 없음, 스택 세팅 전) |
| 단위·통합 테스트 (트랙 A) | Comp | CI, PR 머지 게이트 | ci.yml → Vitest(ADR-0008 승인 — 러너 확정) | ⬜미구축 (package.json·ci.yml 자체가 없음, 러너 선택만 확정) |
| 테스트-코드 동행 검사 (M3 프록시) | Comp | CI, PR | ci.yml (경고) | ⬜미구축 |
| 독립 평가 에이전트 (evaluator) | Inf | 각 RQ 구현 직후 (tdd-workflow Phase 3) | 오케스트레이터 스킬 `.claude/skills/tdd-workflow/SKILL.md` | ✅ **2026-07-21 구축.** `.claude/agents/evaluator.md`(opus). 검증 항목 6건(스위트 재실행·골든 커버리지·Colyseus 경계면 필드 대조·결정론·테스트 약화·스코프). 격리: RQ-ID·`_workspace/{RQ-ID}/` 경로·테스트 커밋 SHA만 받고 coder 대화는 받지 않는다 — 자기 채점 방지. ⚠️ 이 게이트는 **규율로만 강제된다** — 파이프라인을 건너뛰고 직접 구현하는 것을 막는 hook·CI는 없다 |
| 트랙 B rubric 체크 | Inf | 하네스 변경 시·주간 | 사람 (수동) | ✅ 절차만 (harness/evals/README.md + track-b 시드 완료) |
| PR 리뷰 게이트 (reviewer, 솔로 대체) | Inf | PR 머지 전 | APPROVE 없이 머지 금지 + 브랜치 보호(status check 필수) | ✅ **2026-07-21 구축.** `.claude/skills/review-gate/SKILL.md` + `.claude/agents/reviewer.md`(opus). 검토 항목 10건(스코프 이탈·ADR 모순·서버 권위·결정론·테스트 약화·렌더 루프 할당·shared 환경오염·값 복제·문서 동행·틱 예산). 격리 규칙: 구현 세션의 대화를 reviewer에 넘기지 않는다. ⚠️ 브랜치 보호(status check 필수) 설정은 **아직 안 됨** — 지금은 규율로만 지켜진다 |
| 배포 후 스모크 | Comp | main 머지 → 배포 직후 | deploy.yml → smoke.sh | 🟡 RQ-80·RQ-81(배포·저장소) 구현 후 |

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
