#!/usr/bin/env bash
# 검증 일괄 스크립트 — ADR-0008 속도 예산에 따라 두 모드로 나눈다.
#   --fast : 파일 수정 직후 hook에서 호출. 예산 5초 — 변경 파일만 lint.
#   (없음) : 전체 검증 (게이트 + lint + typecheck + test). CI와 동일. 예산 3분.
#
# typecheck를 --fast에 넣지 않는 이유: tsc는 프로그램 그래프 전역을 보므로
# 파일 단위로 쪼갤 수 없다 (ADR-0008, tsconfig.json 주석 참조).
set -euo pipefail


if [ "${1:-}" = "--fast" ]; then
  # 클론 직후 등 node_modules 부재 시 조용히 통과 — 환경 문제는 전체 검증이 잡는다
  [ -d node_modules ] || exit 0
  CHANGED=$( { git diff --name-only HEAD -- '*.ts' '*.tsx' 2>/dev/null;
               git ls-files --others --exclude-standard -- '*.ts' '*.tsx'; } | sort -u )
  FILES=""
  for f in $CHANGED; do [ -f "$f" ] && FILES="$FILES $f"; done
  [ -z "$FILES" ] && exit 0
  # shellcheck disable=SC2086
  npx eslint --cache $FILES
  exit 0
fi

# --- 런타임 가드 (원장 28a) -------------------------------------------------
# npm의 `engines`는 경고일 뿐 강제가 아니고, 이 라운드가 세 번 겪은 통증은
# 설치 시점이 아니라 **테스트 시점**에 났다(Node v24에서 통합 워커가 네이티브
# abort로 죽는다 — 0xC0000409). 그래서 검증 진입점인 여기서 직접 막는다.
# `.nvmrc`가 권장 버전을, `package.json`의 engines가 허용 범위를 정의한다.
#
# **위치**: `--fast` 분기 **뒤**다. `--fast`는 파일 저장마다 hook에서 도는
# 5초 예산 경로이고 통합 테스트를 돌리지 않으므로 이 위험에 노출되지 않는다
# — 거기서 막으면 편집 흐름만 끊는 과차단이다(독립 평가 판정).
node_major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$node_major" -ge 24 ]; then
  echo "" >&2
  echo "  ✗ Node v$(node -v | sed 's/^v//') 는 이 저장소의 검증에 쓸 수 없다." >&2
  echo "" >&2
  echo "    통합 테스트 워커가 네이티브 abort(0xC0000409)로 죽는다 — 테스트" >&2
  echo "    로직이 아니라 런타임 문제이며, 누적 12런 중 6런이 실패한다" >&2
  echo "    (v22.23.1은 같은 머신 12런 전부 통과). 근거: harness/progress.md 28a," >&2
  echo "    harness/infra/worker-crash-rca.md" >&2
  echo "" >&2
  echo "    조치: .nvmrc 버전을 쓰라 — nvm/fnm 사용 시 \`nvm use\` 또는 \`fnm use\`." >&2
  echo "" >&2
  exit 1
fi
# ---------------------------------------------------------------------------

# 스펙 동결 게이트를 가장 먼저 — 스펙이 미결이면 나머지 검증은 의미가 없다.
python .claude/hooks/gate_spec_freeze.py --check

# coder 역할 게이트 자체 검증(리뷰 major 2) — 고장 난 센서는 없는 센서보다
# 나쁘다. 이 게이트는 PreToolUse hook일 뿐 CI 게이트가 아니므로(세션 중 도구
# 호출을 막을 뿐, PR 시점엔 관여하지 않는다) --check-paths 대응물은 없다 —
# --selftest만 여기서 돈다.
python .claude/hooks/gate_coder_test_write.py --selftest
python .claude/hooks/gate_map_asset_provenance.py --selftest

npx eslint .
npx tsc --noEmit

# 단위 테스트는 하드 게이트 — 재시도 없음. 실패 = 즉시 실패.
npx vitest run tests/unit

# 통합 테스트는 재시도한다 (최대 3회) — 단, **오직 인프라 워커 크래시만**.
# ADR-0008이 허용한 실 WebSocket 통합 테스트에서 워커 fork가 무성으로 죽는
# flaky("Worker exited unexpectedly")가 있다.
#
# **근본 원인은 2026-07-28에 규명됐다: Node v24다(Windows 실측 기준).**
#   ⚠ 범위: 같은 Windows 머신에서 런타임만 바꾼 A/B로 확정했다. **Linux+v24는
#   미검증**이고(CI는 v20→v22만 써 왔다) abort를 호출하는 네이티브 프레임도
#   미특정이다 — 남은 후보는 Windows 전용 `__fastfail` 계열이다.
#   - 죽는 워커의 종료 코드는 예외 없이 3221226505 = 0xC0000409
#     (STATUS_STACK_BUFFER_OVERRUN — Windows의 abort(), Linux SIGABRT 상당).
#     signal은 null이고 stderr는 비어 있다. uncaught exception·unhandled
#     rejection·process.exit()·process.abort()는 전부 배제됐다 → 네이티브 abort.
#   - 최소 재현자: buildServer → listen(0) → colyseus.js 클라 2개 join →
#     3초간 30Hz 패치 수신 → leave/close. **살아 있는 Colyseus 클라 세션이
#     필요조건**이다(클라 없는 워크로드 1,204워커·2,126워커-초에서 abort 0).
#   - **런타임 A/B(같은 머신·같은 코드)**: Node v24.15.0은 실 통합 스위트
#     **누적 12런 중 6런 실패**(워커당 2.2%), Node v22.23.1은 **12런 전부 통과**
#     (Fisher 런 p=0.0137, 워커 p=0.0075, 단언 실패 0).
#     최소 재현자에서도 v24는 8중 2, v22는 8중 0.
#   - CI가 거의 항상 통과해 온 이유도 이것이다 — CI는 **이 PR 전까지** Node 20을
#     썼다(지금은 `.nvmrc`를 따라 22.23.1).
# 대응: engines를 "^22.13.0"으로 좁히고 .nvmrc(22.23.1)를 둔다.
# (범위 하한은 **2026-07-28 이전에는** 의존성이 정했다 — rolldown/vite는
#  ^20.19.0 || >=22.12.0, @eslint/*는 ^20.19.0 || ^22.13.0 || >=24. 20.0~
#  20.18과 21.x는 어느 절도 만족하지 않아 rolldown 네이티브 바인딩이
#  설치되지 않는다. **RQ-81(통계 영속)부터는 하한을 정하는 것이 의존성이
#  아니라 런타임 API다** — `node:sqlite`(`DatabaseSync`)가 Node 22.5+
#  내장이라 20.x에는 아예 없다(20.19.0은 npm 설치는 성공하지만 서버가
#  기동 즉시 `ERR_UNKNOWN_BUILTIN_MODULE`로 죽는다 — 평가 blocker 1
#  실측). 그래서 이번에 `20.19.0` 절 자체를 제거했다(기존 하한 20.19.0은
#  이제 의미가 없다 — 22.13.0 하나로 22.5+ 요구를 이미 만족하고도 남는다).
#  상한(24 배제)은 여전히 아래 abort가 정한다. npm engines는 경고일 뿐
#  강제가 아니다 — 실효는 문서·메타데이터 가치이며 .nvmrc가 권장 버전을
#  고정한다.) 아래 재시도는 그럼에도 v24로 실행하는 경우를 위한 잔여
# 방어선이다.
# 경위: harness/progress.md 17k·28a, harness/infra/worker-crash-rca.md,
# _workspace/RQ-81/04_evaluator_report.md §5.2·5.3(node:sqlite 하한 실측).
#
# **이 재시도는 테스트 약화가 아니다** — 재시도 대상을 크래시 시그니처로
# 게이팅하기 때문이다. 실패 출력을 분류한다:
#   - assertion 실패("Failed Tests"/"AssertionError")  → 즉시 하드 실패. 재시도 안 함.
#     (결정적이든 GA-29 락 레이스처럼 비결정적이든, 단언 실패는 절대 은폐하지 않는다.)
#   - 알려진 워커 크래시("Worker exited unexpectedly"/"Unhandled Error")만 재시도.
#   - 그 외 미지의 실패 → 하드 실패(보수적 — 모르는 것을 재시도로 숨기지 않는다).
# 즉 재시도는 인프라 스폰 크래시만 흡수하고, 검증(단언)은 전부 그대로 강제된다.
# (PR #5 리뷰 major 대응: "nonzero면 무조건 재시도"는 단언 flaky를 은폐할 수
#  있었다 — 크래시 시그니처 게이팅으로 그 구멍을 닫는다.)
#
# ⚠ 이전 주석의 "~2% 독립 크래시가 3회 연속일 확률 ≈ 0.0008%"는 **틀렸다**.
# 그 2%는 런 단위가 아니라 **워커 단위**였다(워커당 2.82% = 22/780 실측).
# 런 실패율 = 1-(1-p)^n 이고 통합 파일이 30개이므로 **런 실패 52.5%**(실측
# 21/40), 3회 연속 소진 확률은 0.525³ ≈ **14.5%** — 문서가 약 2만 배
# 과소평가하고 있다(오늘 기준). 다만 **작성 시점에는 통합 파일이 2개**였고
# 그때 실제 3연속 확률은 0.0556³ ≈ 0.0172% — 구주장 대비 21.5배 과소평가로,
# "처음부터 크게 틀렸다"기보다 **파일이 2 → 30으로 늘면서 어긋난 것**이다.
# 런 실패율이 1-(1-p)^n 이라 파일 수에 지수적으로 악화되므로 재시도 예산
# 상향은 해법이 아니다 — 위 런타임 대응이 해법이다.
#
# 잔여 취약점(리뷰 minor, 17h④): 아래 크래시 판별은 vitest **기본 리포터의
# 출력 문자열**에 결합돼 있다 — 실제로 매칭에 쓰는 다섯 패턴 전부: 단언 쪽
# 아래 `grep -qE 'Failed Tests|AssertionError|FAIL +tests/'`(3중), 크래시 쪽
# 아래 `grep -qE 'Worker exited unexpectedly|Unhandled Error'`(2중). 이
# 문자열은 vitest의 공개 API가 아니라 리포터 구현 세부다 — 리포터를
# 바꾸거나(예: json/verbose 리포터로 전환) vitest를 메이저 업그레이드하면
# 문구가 바뀌어 판별이 조용히 어긋날 수 있다(단언 실패를 크래시로 오분류해
# 재시도로 은폐하거나, 반대로 알려진 크래시를 미지의 실패로 오분류해
# 불필요하게 하드 실패시킬 수 있다). 단언 쪽은 3중 중복이라 한 문구만
# 바뀌어도 나머지가 방어하지만, 크래시 쪽은 2중이라 상대적으로 더 취약하다
# — 다만 크래시 쪽이 매칭에 실패하는 방향은 바로 아래 "미지의 실패 → 하드
# 실패" 분기로 떨어지므로 안전한 실패 방향이다(검증을 몰래 통과시키는 쪽이
# 아니라 불필요하게 막는 쪽으로 어긋난다). vitest 업그레이드 시에는 이 다섯
# grep 패턴 전부가 여전히 실제 리포터 출력과 일치하는지 반드시 재검증할 것.
integration_attempts=3
for attempt in $(seq 1 "$integration_attempts"); do
  set +e
  integration_out=$(npx vitest run tests/integration 2>&1)
  integration_code=$?
  set -e
  printf '%s\n' "$integration_out"
  [ "$integration_code" -eq 0 ] && break

  # 단언 실패는 재시도 대상이 아니다 — 즉시 하드 실패.
  if printf '%s' "$integration_out" | grep -qE 'Failed Tests|AssertionError|FAIL +tests/'; then
    echo "통합 테스트 단언 실패 — flaky가 아니라 실제 결함이다. 재시도하지 않는다." >&2
    exit 1
  fi
  # 알려진 워커 크래시 시그니처가 아니면 하드 실패 (미지의 실패를 숨기지 않는다).
  if ! printf '%s' "$integration_out" | grep -qE 'Worker exited unexpectedly|Unhandled Error'; then
    echo "통합 테스트가 알 수 없는 사유로 실패(단언·알려진 크래시 모두 아님) — 하드 실패." >&2
    exit 1
  fi
  if [ "$attempt" -eq "$integration_attempts" ]; then
    echo "통합 워커 크래시 ${integration_attempts}회 연속 — 인프라 flaky 한도 초과, 하드 실패." >&2
    exit 1
  fi
  echo "통합 워커 크래시(시도 ${attempt}/${integration_attempts}) — 인프라 flaky, 재시도한다." >&2
done
