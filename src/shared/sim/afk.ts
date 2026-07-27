/**
 * RQ-43 AFK 자동 퇴장 — 순수 판정 로직 (ADR-0008: 순수 함수, 결정론,
 * `src/shared` 환경 중립. ADR-0011: `src/shared` 전체가 Red-first 영역).
 *
 * 그린필드 계약은 `tests/unit/sim-afk.test.ts` 상단 docblock(test-writer
 * 지정)이 정본이다 — `src/shared/sim/lifecycle.ts`의 `isRespawnDue` 선례와
 * 동일한 부호 규칙(`>=`, 경계 포함)·임계값을 상수에 감추지 않고 인자로
 * 받는 재사용성 원칙을 그대로 따른다.
 */

import { msToTicks } from '@shared/sim/clock'
import { PLAYER } from '@shared/constants'

/** `PLAYER.AFK_TIMEOUT_MS`(5분=300000ms)를 틱으로 환산한 편의 상수 —
 * `lifecycle.ts`의 `RESPAWN_TICKS`/`SPAWN_PROTECTION_TICKS`와 동일한
 * "설정값 상수 export" 패턴. 300000ms / (1000/30)ms = 정확히 9000틱
 * (나머지 없음 — `msToTicks`의 ceil이 이 값에는 영향을 주지 않는다). */
export const AFK_TICKS: number = msToTicks(PLAYER.AFK_TIMEOUT_MS)

/** RQ-43: `lastInputAtTick`(해당 세션의 마지막 **활동** 틱 — `fire`/`chat`/
 * `reload` 수신, 또는 실제 조작이 담긴 `move`. 유휴 `move` 하트비트는
 * 활동이 아니다 — 호출자 `GameRoom` 참고)부터 `currentTick`까지 경과가
 * `afkTicks` 이상이면 AFK 퇴장 대상이다(경계 포함 — `isRespawnDue`와
 * 동일한 부호 규칙). */
export function isAfkDue(lastInputAtTick: number, currentTick: number, afkTicks: number): boolean {
  return currentTick - lastInputAtTick >= afkTicks
}
