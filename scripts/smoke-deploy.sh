#!/usr/bin/env bash
# RQ-80 배포 스모크 — GA-41~43 검증(harness/evals/golden/track-a-product.jsonl,
# 사용자 승인). 이 스크립트가 골든 3건 각각의 `verify` 경로다.
#
#   GA-41: docker compose로 스택 기동 → Nginx가 노출한 포트로 /health 요청
#          → 200 + 공유 상수(@shared/constants NET.TICK_HZ)에서 읽은 값 포함
#          (+ 정적 클라이언트 자산이 실제로 서빙되는지도 이 단계 직후 확인
#          — 리뷰 major 3: ADR-0009 결정 3의 "Nginx가 dist/client를 직접
#          서빙"이 배포 계약의 일부인데 원래 스모크는 이걸 전혀 검증하지
#          않아 `web` 이미지가 깨져도 통과했다)
#   GA-42: 두 클라이언트가 Nginx를 거쳐 WebSocket으로 접속 → 같은 룸에서
#          서로를 상태 스냅샷에서 관측
#   GA-43: app 컨테이너 재시작 → 세션은 소실되지만 /health가 다시 200
#          (골든 `given`인 "클라이언트가 접속해 세션이 생긴 상태"를 실제로
#          충족시키기 위해, 재시작 전 접속 유지 클라이언트를 백그라운드로
#          띄워두고 재시작 후 그 연결이 실제로 끊겼는지까지 단언한다 —
#          리뷰 major 4: 기존엔 GA-42 클라이언트가 이미 leave한 뒤라
#          재시작 시점에 살아있는 연결이 0이었다)
#
# ADR-0011(선별 Red): 인프라는 test-after — 이 스모크가 게이트다.
# ADR-0008(결정론·무한 대기 금지) 정신을 인프라 스크립트에도 적용한다 —
# 모든 대기 단계에 타임아웃 상한을 두고, 상한 초과는 hang이 아니라 즉시
# 실패로 취급한다. 실패 시 컨테이너 로그를 출력한 뒤 non-zero로 종료하고,
# 어느 경로로 끝나든 trap으로 스택(과 백그라운드 프로세스)을 정리한다.
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
STATIC_TIMEOUT_S=15
WS_TIMEOUT_S=30
RESTART_TIMEOUT_S=60

COMPOSE=(docker compose)

# GA-43 접속 유지 클라이언트(리뷰 major 4) — 백그라운드 PID·로그 경로.
# `set -u`가 미선언 변수 참조를 에러로 취급하므로 trap보다 먼저 빈 값으로
# 선언해둔다(스크립트가 그 단계 전에 실패해도 cleanup()이 안전하게 참조).
PERSIST_PID=""
PERSIST_LOG=""

log() { printf '[smoke-deploy] %s\n' "$*"; }

# PID 하나가 종료할 때까지 최대 timeout_s초 폴링으로 기다린다. bash 내장
# `wait`는 타임아웃 인자가 없어 그냥 쓰면 프로세스가 안 죽는 한 무한정
# 블로킹한다(ADR-0008 "모든 대기에 상한" 위반 — 델타 재리뷰 minor D5,
# 이 스크립트에서 유일하게 뚫려 있던 지점). 상한을 넘기면 강제 종료
# (SIGKILL) 후 반환해 좀비를 남기지 않으면서도 상한을 지킨다.
wait_pid_bounded() {
  local pid="$1"
  local timeout_s="$2"
  local deadline=$((SECONDS + timeout_s))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      log "PID ${pid}가 상한(${timeout_s}s) 내 스스로 종료하지 않아 강제 종료합니다."
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
  done
  wait "$pid" 2>/dev/null || true
}

# EXIT 트랩 — 성공·실패 어느 경로로 끝나든 반드시 실행된다(bash 트랩 의미).
# 실패로 끝나는 경우에만 로그를 먼저 남긴 뒤, 항상 스택과 백그라운드
# 프로세스를 정리한다.
cleanup() {
  local exit_code=$?

  if [ -n "$PERSIST_PID" ] && kill -0 "$PERSIST_PID" 2>/dev/null; then
    log "정리 — 아직 살아있는 접속 유지 클라이언트(PID ${PERSIST_PID}) 종료"
    kill "$PERSIST_PID" 2>/dev/null || true
    wait_pid_bounded "$PERSIST_PID" 10
  fi

  if [ "$exit_code" -ne 0 ]; then
    log "종료 코드 ${exit_code} — 정리 전 컨테이너 상태·로그를 출력합니다."
    "${COMPOSE[@]}" ps || true
    "${COMPOSE[@]}" logs --no-color --tail=200 || true
    if [ -n "$PERSIST_LOG" ] && [ -f "$PERSIST_LOG" ]; then
      log "접속 유지 클라이언트(GA-43) 로그:"
      cat "$PERSIST_LOG" || true
    fi
  fi

  [ -n "$PERSIST_LOG" ] && [ -f "$PERSIST_LOG" ] && rm -f "$PERSIST_LOG"

  log "스택 정리 중 (docker compose down)..."
  "${COMPOSE[@]}" down --remove-orphans --timeout 20 || true
  exit "$exit_code"
}
trap cleanup EXIT

log "설정: HOST_HTTP_PORT=${HOST_HTTP_PORT} BASE_URL=${BASE_URL}"

log "1/7 이미지 빌드 (상한 ${BUILD_TIMEOUT_S}s)"
if ! timeout "${BUILD_TIMEOUT_S}s" "${COMPOSE[@]}" build; then
  log "빌드 실패"
  exit 1
fi

log "2/7 스택 기동 (상한 ${UP_TIMEOUT_S}s)"
if ! timeout "${UP_TIMEOUT_S}s" "${COMPOSE[@]}" up -d; then
  log "기동 실패"
  exit 1
fi

# GA-41 "공유 상수에서 읽은 값이 응답에 포함된다"는 키 존재가 아니라 값
# 일치를 요구한다(리뷰 minor 6) — 이 스크립트가 숫자를 따로 하드코딩하는
# 대신 단일 진실 공급원(src/shared/constants.ts)에서 직접 읽어 대조한다.
expected_tick_hz="$(grep -oE 'TICK_HZ: [0-9]+' "${ROOT_DIR}/src/shared/constants.ts" | grep -oE '[0-9]+' | head -1)"
if [ -z "$expected_tick_hz" ]; then
  log "사전 확인 실패 — src/shared/constants.ts에서 NET.TICK_HZ를 읽지 못했습니다."
  exit 1
fi

log "3/7 GA-41: /health 200 + 공유 상수(tickHz=${expected_tick_hz}) 값 대조 (상한 ${HEALTH_TIMEOUT_S}s)"
health_response=""
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while [ "$SECONDS" -lt "$deadline" ]; do
  if response="$(curl -fsS --max-time 5 "${BASE_URL}/health" 2>/dev/null)"; then
    if printf '%s' "$response" | grep -q "\"tickHz\":${expected_tick_hz}"; then
      health_response="$response"
      break
    fi
  fi
  sleep 2
done

if [ -z "$health_response" ]; then
  log "GA-41 실패 — /health가 상한 내 200(+tickHz=${expected_tick_hz})을 반환하지 않았습니다."
  exit 1
fi
log "GA-41 통과 — ${health_response}"

log "4/7 정적 자산 서빙 확인 (리뷰 major 3, 상한 ${STATIC_TIMEOUT_S}s) — web 이미지가 깨지면 여기서 잡혀야 한다"
if ! index_body="$(curl -fsS --max-time "${STATIC_TIMEOUT_S}" "${BASE_URL}/")"; then
  log "정적 자산 확인 실패 — GET / 요청 자체가 실패했습니다."
  exit 1
fi
if ! printf '%s' "$index_body" | grep -q 'id="root"'; then
  log "정적 자산 확인 실패 — GET / 응답에 id=\"root\"가 없습니다(dist/client 복사 누락/손상 가능성)."
  exit 1
fi
asset_path="$(printf '%s' "$index_body" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1)"
if [ -z "$asset_path" ]; then
  log "정적 자산 확인 실패 — GET / 응답에서 /assets/*.js 참조를 찾지 못했습니다."
  exit 1
fi
if ! curl -fsS --max-time "${STATIC_TIMEOUT_S}" -o /dev/null "${BASE_URL}${asset_path}"; then
  log "정적 자산 확인 실패 — ${asset_path} 요청이 200을 반환하지 않았습니다."
  exit 1
fi
log "정적 자산 확인 통과 — index.html + ${asset_path}"

log "5/7 GA-42: 두 클라이언트 WS 왕복 — 같은 룸에서 서로 관측 (상한 ${WS_TIMEOUT_S}s)"
pair_inner_timeout_ms=$(((WS_TIMEOUT_S - 5) * 1000))
if ! timeout "${WS_TIMEOUT_S}s" node "${ROOT_DIR}/scripts/smoke-ws-check.mjs" pair "${WS_ENDPOINT}" "${pair_inner_timeout_ms}"; then
  log "GA-42 실패"
  exit 1
fi
log "GA-42 통과"

log "6/7 GA-43 준비: 접속 유지 클라이언트를 백그라운드로 기동 (리뷰 major 4 — 재시작 시점에 실제 세션이 있어야 '소실'을 검증할 수 있다)"
PERSIST_LOG="$(mktemp)"
persist_max_lifetime_ms=$(((RESTART_TIMEOUT_S + 30) * 1000))
node "${ROOT_DIR}/scripts/smoke-ws-check.mjs" persist "${WS_ENDPOINT}" "$((WS_TIMEOUT_S * 1000))" "${persist_max_lifetime_ms}" \
  >"$PERSIST_LOG" 2>&1 &
PERSIST_PID=$!

persist_joined=""
join_deadline=$((SECONDS + WS_TIMEOUT_S))
while [ "$SECONDS" -lt "$join_deadline" ]; do
  if grep -q '\[smoke-ws:persist\] JOINED' "$PERSIST_LOG" 2>/dev/null; then
    persist_joined=1
    break
  fi
  if ! kill -0 "$PERSIST_PID" 2>/dev/null; then
    break # 프로세스가 이미 종료됨 — 접속 실패로 취급
  fi
  sleep 1
done

if [ -z "$persist_joined" ]; then
  log "GA-43 준비 실패 — 접속 유지 클라이언트가 상한 내 접속하지 못했습니다."
  exit 1
fi
log "GA-43 준비 완료 — $(grep '\[smoke-ws:persist\] JOINED' "$PERSIST_LOG")"

log "7/7 GA-43: app 컨테이너 재시작 → ① /health 복구 ② 접속 유지 클라이언트 연결 종료 확인 (상한 ${RESTART_TIMEOUT_S}s)"
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
log "GA-43 — /health 복구 확인: ${restart_health_response}"

persist_left=""
leave_deadline=$((SECONDS + RESTART_TIMEOUT_S))
while [ "$SECONDS" -lt "$leave_deadline" ]; do
  if grep -q '\[smoke-ws:persist\] LEFT' "$PERSIST_LOG" 2>/dev/null; then
    persist_left=1
    break
  fi
  if ! kill -0 "$PERSIST_PID" 2>/dev/null; then
    break # 로그에 LEFT 없이 죽었다면 타임아웃/에러 — 실패로 취급
  fi
  sleep 1
done
# 위 폴링 루프가 상한(leave_deadline) 초과로 빠져나왔는데 프로세스가 아직
# 살아있을 수 있다 — 그 경우를 포함해 이 대기도 반드시 상한이 있어야
# 한다(리뷰 델타 minor D5). 10초는 이미 최대 RESTART_TIMEOUT_S만큼 기다린
# 뒤의 추가 유예일 뿐이라 짧게 잡는다.
wait_pid_bounded "$PERSIST_PID" 10
PERSIST_PID=""

if [ -z "$persist_left" ]; then
  log "GA-43 실패 — 재시작 후에도 접속 유지 클라이언트의 연결 종료(LEFT)가 감지되지 않았습니다(골든 given이 요구하는 '세션 소실'을 확인할 수 없음)."
  exit 1
fi
log "GA-43 통과 — $(grep '\[smoke-ws:persist\] LEFT' "$PERSIST_LOG")"

log "골든 GA-41~43 전부 통과"
