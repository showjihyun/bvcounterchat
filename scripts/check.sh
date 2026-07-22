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

# 통합 테스트는 재시도한다 (최대 3회). ADR-0008이 허용한 실 WebSocket 통합
# 테스트에, vitest/Node의 워커 teardown 계층에서 발생하는 ~2% 콜드스타트
# 워커 사망(exit≠0, "Worker exited unexpectedly" — 테스트 본문 전 프로세스
# 사망) flaky가 있다. 근본 원인은 vitest/Node 내부 black-box로 미규명(3개
# 세션 규명 실패, RQ-04). 자세한 경위: harness/progress.md 19a·changelog.
#
# **이 재시도는 테스트 약화가 아니다.** 핵심은 결정론 구분이다:
#   - flaky = 비결정적 인프라 크래시(독립 ~2%) → 재시도가 복구한다.
#   - 진짜 실패 = 결정적 assertion 실패(매번) → 재시도해도 3회 전부 실패 → 하드 실패.
# 즉 재시도는 인프라 스폰 크래시만 흡수하고, 실제 결함은 그대로 잡는다.
# assertion은 손대지 않는다 — 통합 테스트가 검증하는 것은 전부 그대로 강제된다.
#
# ~2% 독립 크래시가 3회 연속일 확률 ≈ 0.0008% — 게이트가 실질적으로 안정된다.
integration_attempts=3
for attempt in $(seq 1 "$integration_attempts"); do
  if npx vitest run tests/integration; then
    break
  fi
  if [ "$attempt" -eq "$integration_attempts" ]; then
    echo "통합 테스트가 ${integration_attempts}회 연속 실패 — flaky가 아니라 실제 결함이다." >&2
    exit 1
  fi
  echo "통합 테스트 실패(시도 ${attempt}/${integration_attempts}) — 인프라 flaky 가능성, 재시도한다." >&2
done
