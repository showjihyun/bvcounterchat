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

# 스펙 동결 게이트를 가장 먼저 — 스펙이 미결이면 나머지 검증은 의미가 없다.
python .claude/hooks/gate_spec_freeze.py --check

# coder 역할 게이트 자체 검증(리뷰 major 2) — 고장 난 센서는 없는 센서보다
# 나쁘다. 이 게이트는 PreToolUse hook일 뿐 CI 게이트가 아니므로(세션 중 도구
# 호출을 막을 뿐, PR 시점엔 관여하지 않는다) --check-paths 대응물은 없다 —
# --selftest만 여기서 돈다.
python .claude/hooks/gate_coder_test_write.py --selftest

npx eslint .
npx tsc --noEmit

# 단위 테스트는 하드 게이트 — 재시도 없음. 실패 = 즉시 실패.
npx vitest run tests/unit

# 통합 테스트는 재시도한다 (최대 3회) — 단, **오직 인프라 워커 크래시만**.
# ADR-0008이 허용한 실 WebSocket 통합 테스트에서 워커 fork가 무성으로 죽는
# flaky("Worker exited unexpectedly")가 있다.
#
# **근본 원인은 2026-07-28에 규명됐다: Node v24다.**
#   - 죽는 워커의 종료 코드는 예외 없이 3221226505 = 0xC0000409
#     (STATUS_STACK_BUFFER_OVERRUN — Windows의 abort(), Linux SIGABRT 상당).
#     signal은 null이고 stderr는 비어 있다. uncaught exception·unhandled
#     rejection·process.exit()·process.abort()는 전부 배제됐다 → 네이티브 abort.
#   - 최소 재현자: buildServer → listen(0) → colyseus.js 클라 2개 join →
#     3초간 30Hz 패치 수신 → leave/close. **살아 있는 Colyseus 클라 세션이
#     필요조건**이다(클라 없는 워크로드 1,204워커·2,126워커-초에서 abort 0).
#   - **런타임 A/B(같은 머신·같은 코드)**: Node v24.15.0은 실 통합 스위트
#     8런 중 2런 실패, Node v22.23.1은 **8런 전부 통과(111/111)**.
#     최소 재현자에서도 v24는 8중 2, v22는 8중 0.
#   - CI가 거의 항상 통과한 이유도 이것이다 — CI는 Node 20을 쓴다.
# 대응: engines를 ">=20 <24"로 좁히고 .nvmrc를 둔다. 아래 재시도는 그럼에도
# v24로 실행하는 경우를 위한 잔여 방어선이다.
# 경위: harness/progress.md 17k·28a, _workspace/infra/worker-crash-rca.md.
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
# 과소평가하고 있었다. 최근 세 라운드에서 한도 초과가 세 번 난 것은 이상
# 현상이 아니라 모형이 처음부터 틀렸던 것이다. 파일 수가 늘수록(≈10→30)
# 악화되므로 재시도 예산 상향은 해법이 아니다 — 위 런타임 대응이 해법이다.
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
