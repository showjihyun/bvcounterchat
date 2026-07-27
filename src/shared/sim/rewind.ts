/**
 * RQ-64 랙 보상(Lag Compensation) — 위치 이력 링버퍼 + RTT→틱 되감기 순수
 * 로직 (ADR-0005 "랙보상 확정" 절, ADR-0008: 순수 함수·결정론·`src/shared`
 * 환경 중립. ADR-0011: `src/shared` 전체가 Red-first 영역).
 *
 * 그린필드 계약은 `tests/unit/sim-rewind.test.ts` 상단 docblock(test-writer
 * 지정, `fallDamage.ts`/`afk.ts` 선례와 동일한 권한)이 정본이다 — 이 파일은
 * 그 계약을 그대로 구현한다.
 *
 * **설계 포크(test-writer 결정)**: 되감기 양의 출처는 사수의 RTT(ms) —
 * `_workspace/RQ-64/01_test-writer_red.md` §1 참고. 이 파일은 그 RTT를
 * 받아 틱 수로 환산·클램프하는 산술만 다룬다(RTT를 어떻게 측정·보고하는지는
 * 스코프 밖).
 */

import { msToTicks } from '@shared/sim/clock'
import { NET } from '@shared/constants'

/**
 * `NET.REWIND_CAP_MS`(200ms)를 틱으로 환산한 편의 상수 — `lifecycle.ts`의
 * `RESPAWN_TICKS`·`afk.ts`의 `AFK_TICKS`와 동일한 "설정값을 틱 상수로 미리
 * 환산해 export"하는 패턴. 200 / (1000/30) = 정확히 6.0(나머지 없음 —
 * `msToTicks`의 ceil이 이 값에는 영향을 주지 않는다).
 */
export const REWIND_CAP_TICKS: number = msToTicks(NET.REWIND_CAP_MS)

/**
 * RQ-64: 사수가 보고한 RTT(ms)를 되감기 틱 수로 환산한다.
 *
 * - `+Infinity`는 상한(`REWIND_CAP_TICKS`)으로 곧장 절단한다 — 특례로 먼저
 *   걸러낸다(자연값 경로를 타면 `msToTicks(Infinity)`도 `Infinity`라
 *   `Math.min`으로 결국 같은 결과에 도달하지만, 의도를 명시적으로 남긴다).
 * - 그 외 유한하지 않은 값(`NaN`·`-Infinity`) 또는 0 이하(변조·미보고)는
 *   0틱(되감기 없음)으로 방어한다. `NaN`은 타입이 `'number'`라
 *   `sanitizeFireInput`의 `typeof` 방어를 그대로 통과하는 값이라(22l
 *   전례), 여기서 `Number.isFinite` 가드로 별도로 막는다.
 * - 그 외(유한하고 양수)는 ms→틱 환산 후 상한에서 클램프한다 — RQ-61 방어:
 *   되감기 양은 클라이언트 공급값이므로 서버가 상한에서 절단해야 임의로
 *   먼 과거를 요구하는 변조 클라이언트를 막는다.
 */
export function rewindTicksFor(rttMs: number): number {
  if (rttMs === Number.POSITIVE_INFINITY) return REWIND_CAP_TICKS
  if (!Number.isFinite(rttMs) || rttMs <= 0) return 0
  return Math.min(msToTicks(rttMs), REWIND_CAP_TICKS)
}

/** 되감기 링버퍼의 스냅샷 1건 — 서버가 매 틱 살아있는 플레이어의 발
 * 위치(RQ-20 `moveStates`)를 이 형태로 적립한다. */
export interface PositionSnapshot {
  tick: number
  x: number
  y: number
  z: number
}

/** `REWIND_CAP_TICKS`(6틱 전)까지의 되감기 요청을 항상 만족하려면 "현재
 * 틱" 스냅샷까지 포함해 최소 7개(0~6틱 전)를 보관해야 한다. */
export const POSITION_HISTORY_CAPACITY: number = REWIND_CAP_TICKS + 1

/**
 * 링버퍼에 새 스냅샷을 추가하고 `capacity`를 초과하면 가장 오래된(tick이
 * 가장 작은) 것부터 버려 길이를 `capacity`로 유지한다(무한정 증가 방지).
 * `history`가 이미 tick 오름차순이라고 가정하지 않는다 — 매 틱 끝에 push하는
 * 정상 호출 패턴이면 자연히 오름차순이 되지만, 이 함수 자체는 순서를
 * 가정하지 않고 그저 "가장 최근 `capacity`개"만 남긴다(길이 기준 트림).
 *
 * **새 배열을 반환하는 이유(재사용 구조가 아님)**: 이 시그니처는
 * `tests/unit/sim-rewind.test.ts`가 고정한 순수 함수 계약이다(호출자가
 * `history = appendPositionSnapshot(history, ...)`로 재할당). 호출 빈도는
 * "플레이어당 매 틱 1회"(`GameRoom.stepPlayerMovement`)뿐이고, 정원
 * (`CAPACITY.PLAYERS`=10) × `POSITION_HISTORY_CAPACITY`(7)=최대 70개
 * 엘리먼트 복사라 같은 틱 루프 안의 `afkSessionIds` 배열 재구성(GameRoom
 * 코멘트 "정원 10 상한이라 매 틱 배열 하나를 새로 만들어도 틱 예산에 부담을
 * 주지 않는다")과 동일한 자릿수다 — 틱 예산(RQ-60, 33ms)에 영향을 주지
 * 않는다.
 */
export function appendPositionSnapshot(
  history: readonly PositionSnapshot[],
  snapshot: PositionSnapshot,
  capacity: number,
): PositionSnapshot[] {
  const appended = [...history, snapshot]
  return appended.length > capacity ? appended.slice(appended.length - capacity) : appended
}

/**
 * `history`(순서 무관 — 임의 순서의 스냅샷 배열)에서 `currentTick -
 * rewindTicks`(목표 틱) **이하**인 스냅샷 중 tick이 가장 큰(목표 틱에 가장
 * 가까운) 것을 반환한다(내림/floor). 목표 틱 이하인 스냅샷이 하나도
 * 없으면(접속 직후 등 버퍼가 아직 덜 찼을 때) 버퍼 전체에서 가장 오래된
 * 스냅샷으로 절단한다(크래시·undefined 없이 항상 "가장 가까운 유효값"을
 * 반환). `history`가 비어 있으면 undefined(호출자가 폴백을 결정한다 — 예:
 * 현재 `moveStates`).
 */
export function sampleRewoundPosition(
  history: readonly PositionSnapshot[],
  currentTick: number,
  rewindTicks: number,
): PositionSnapshot | undefined {
  if (history.length === 0) return undefined

  const targetTick = currentTick - rewindTicks
  let best: PositionSnapshot | undefined
  let oldest: PositionSnapshot | undefined
  for (const snapshot of history) {
    if (oldest === undefined || snapshot.tick < oldest.tick) oldest = snapshot
    if (snapshot.tick <= targetTick && (best === undefined || snapshot.tick > best.tick)) {
      best = snapshot
    }
  }
  return best ?? oldest
}
