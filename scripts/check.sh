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
npx vitest run
