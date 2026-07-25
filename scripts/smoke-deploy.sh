#!/usr/bin/env bash
# RQ-80 배포 스모크 — GA-41~43 검증(harness/evals/golden/track-a-product.jsonl,
# 사용자 승인). 이 스크립트가 골든 3건 각각의 `verify` 경로다.
#
#   GA-41: docker compose로 스택 기동 → Nginx가 노출한 포트로 /health 요청
#          → 200 + 공유 상수(@shared/constants NET.TICK_HZ)에서 읽은 값 포함
#   GA-42: 두 클라이언트가 Nginx를 거쳐 WebSocket으로 접속 → 같은 룸에서
#          서로를 상태 스냅샷에서 관측
#   GA-43: app 컨테이너 재시작 → 세션은 소실되지만 /health가 다시 200
#
# ADR-0011(선별 Red): 인프라는 test-after — 이 스모크가 게이트다.
# ADR-0008(결정론·무한 대기 금지) 정신을 인프라 스크립트에도 적용한다 —
# 모든 대기 단계에 타임아웃 상한을 두고, 상한 초과는 hang이 아니라 즉시
# 실패로 취급한다. 실패 시 컨테이너 로그를 출력한 뒤 non-zero로 종료하고,
# 어느 경로로 끝나든 trap으로 스택을 정리한다.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# docker-compose.yml의 기본값(8080)과 반드시 일치해야 한다 — 여기서
# export해 compose가 같은 값을 쓰게 한다.
HOST_HTTP_PORT="${HOST_HTTP_PORT:-8080}"
export HOST_HTTP_PORT
BASE_URL="http://127.0.0.1:${HOST_HTTP_PORT}"
WS_ENDPOINT="ws://127.0.0.1:${HOST_HTTP_PORT}"

# 각 단계 상한(초). "무한 대기 금지"의 구체적 수치 — 로컬 첫 빌드(콜드
# 캐시)가 가장 오래 걸리는 단계라 넉넉히 잡는다.
BUILD_TIMEOUT_S=600
UP_TIMEOUT_S=120
HEALTH_TIMEOUT_S=60
WS_TIMEOUT_S=30
RESTART_TIMEOUT_S=60

COMPOSE=(docker compose)

log() { printf '[smoke-deploy] %s\n' "$*"; }

# EXIT 트랩 — 성공·실패 어느 경로로 끝나든 반드시 실행된다(bash 트랩 의미).
# 실패로 끝나는 경우에만 로그를 먼저 남긴 뒤, 항상 스택을 내린다.
cleanup() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    log "종료 코드 ${exit_code} — 정리 전 컨테이너 상태·로그를 출력합니다."
    "${COMPOSE[@]}" ps || true
    "${COMPOSE[@]}" logs --no-color --tail=200 || true
  fi
  log "스택 정리 중 (docker compose down)..."
  "${COMPOSE[@]}" down --remove-orphans --timeout 20 || true
  exit "$exit_code"
}
trap cleanup EXIT

log "설정: HOST_HTTP_PORT=${HOST_HTTP_PORT} BASE_URL=${BASE_URL}"

log "1/6 이미지 빌드 (상한 ${BUILD_TIMEOUT_S}s)"
if ! timeout "${BUILD_TIMEOUT_S}s" "${COMPOSE[@]}" build; then
  log "빌드 실패"
  exit 1
fi

log "2/6 스택 기동 (상한 ${UP_TIMEOUT_S}s)"
if ! timeout "${UP_TIMEOUT_S}s" "${COMPOSE[@]}" up -d; then
  log "기동 실패"
  exit 1
fi

log "3/6 GA-41: /health 200 + 공유 상수(tickHz) 대기 (상한 ${HEALTH_TIMEOUT_S}s)"
health_response=""
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while [ "$SECONDS" -lt "$deadline" ]; do
  if response="$(curl -fsS --max-time 5 "${BASE_URL}/health" 2>/dev/null)"; then
    if printf '%s' "$response" | grep -q '"tickHz"'; then
      health_response="$response"
      break
    fi
  fi
  sleep 2
done

if [ -z "$health_response" ]; then
  log "GA-41 실패 — /health가 상한 내 200(+tickHz 포함)을 반환하지 않았습니다."
  exit 1
fi
log "GA-41 통과 — ${health_response}"

log "4/6 GA-42: 두 클라이언트 WS 왕복 — 같은 룸에서 서로 관측 (상한 ${WS_TIMEOUT_S}s)"
node_inner_timeout_ms=$(((WS_TIMEOUT_S - 5) * 1000))
if ! timeout "${WS_TIMEOUT_S}s" node "${ROOT_DIR}/scripts/smoke-ws-check.mjs" "${WS_ENDPOINT}" "${node_inner_timeout_ms}"; then
  log "GA-42 실패"
  exit 1
fi
log "GA-42 통과"

log "5/6 GA-43: app 컨테이너 재시작 → /health 복구 대기 (상한 ${RESTART_TIMEOUT_S}s)"
if ! timeout "${RESTART_TIMEOUT_S}s" "${COMPOSE[@]}" restart app; then
  log "app 재시작 명령 실패"
  exit 1
fi

restart_health_response=""
deadline=$((SECONDS + RESTART_TIMEOUT_S))
while [ "$SECONDS" -lt "$deadline" ]; do
  if response="$(curl -fsS --max-time 5 "${BASE_URL}/health" 2>/dev/null)"; then
    restart_health_response="$response"
    break
  fi
  sleep 2
done

if [ -z "$restart_health_response" ]; then
  log "GA-43 실패 — 재시작 후 상한 내 /health 200 복구가 없었습니다."
  exit 1
fi
log "GA-43 통과 — ${restart_health_response}"

log "6/6 골든 GA-41~43 전부 통과"
