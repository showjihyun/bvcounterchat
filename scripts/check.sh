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

npx eslint .
npx tsc --noEmit

# 단위 테스트는 하드 게이트 — 재시도 없음. 실패 = 즉시 실패.
npx vitest run tests/unit

# 통합 테스트는 재시도한다 (최대 3회) — 단, **오직 인프라 워커 크래시만**.
# ADR-0008이 허용한 실 WebSocket 통합 테스트에, vitest/Node의 워커 teardown
# 계층에서 발생하는 ~2% 콜드스타트 워커 사망(exit≠0, "Worker exited
# unexpectedly" — 테스트 본문 전 프로세스 사망) flaky가 있다. 근본 원인은
# vitest/Node 내부 black-box로 미규명(3개 세션 규명 실패, RQ-04).
# 경위: harness/progress.md 19a·changelog, ADR-0008 §5.
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
# ~2% 독립 크래시가 3회 연속일 확률 ≈ 0.0008% — 게이트가 실질적으로 안정된다.
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
