/**
 * RQ-10(탄창 10발·예비 무한) · RQ-11(재장전 2초·재장전 중 사격 불가) — 순수
 * 로직(ADR-0008: 순수 함수, 결정론, `src/shared` 환경 중립).
 *
 * 그린필드 계약은 `tests/unit/sim-ammo.test.ts` 상단 docblock(test-writer
 * 지정)이 정본이다 — 이 파일은 그 계약을 그대로 구현한다. `lifecycle.ts`
 * (RQ-15/16)의 "틱 기반 마감시한" 패턴과 동일한 양식이다.
 *
 * 임계값(`reloadTicks`)을 상수에 감추지 않고 인자로 받는 이유:
 * `canFire(lastFireAtMs, nowMs, minIntervalMs)`(`combat.ts`)·
 * `isRespawnDue`(`lifecycle.ts`)와 동일한 설계 원칙 — 순수 함수 재사용성·
 * 테스트 편의.
 */

import { msToTicks } from '@shared/sim/clock'
import { WEAPON } from '@shared/constants'

/** `WEAPON.RELOAD_MS`(2000ms)를 틱으로 환산한 편의 상수 — `RESPAWN_TICKS`·
 * `SPAWN_PROTECTION_TICKS`(lifecycle.ts)와 동일한 "설정값 상수 export"
 * 패턴. 현재 60틱(`sim-clock.test.ts` "RQ-11: 재장전 2000ms는 정확히
 * 60틱이다"가 이미 고정). */
export const RELOAD_TICKS: number = msToTicks(WEAPON.RELOAD_MS)

/** RQ-11: `reloadStartedAtTick`(재장전을 시작한 틱)부터 `currentTick`까지
 * 경과가 `reloadTicks` 이상이면 재장전이 완료된 것이다(경계 포함 —
 * `isRespawnDue`와 동일한 스타일: "N틱 이상 지나면"의 직역). */
export function isReloadComplete(reloadStartedAtTick: number, currentTick: number, reloadTicks: number): boolean {
  return currentTick - reloadStartedAtTick >= reloadTicks
}

/** RQ-11: `reloadStartedAtTick`이 `undefined`면(재장전을 시작한 적이 없음)
 * 항상 false. 그 외에는 `isReloadComplete`의 여집합 — 아직 완료되지
 * 않았으면(경과 < reloadTicks) true. */
export function isReloading(reloadStartedAtTick: number | undefined, currentTick: number, reloadTicks: number): boolean {
  if (reloadStartedAtTick === undefined) return false
  return !isReloadComplete(reloadStartedAtTick, currentTick, reloadTicks)
}

/** RQ-10/RQ-11: 탄창(`magazine`)이 0 이하면 재장전 진행 여부와 무관하게
 * 항상 사격 불가(가장 강한 조건). `magazine`이 1발 이상이어도 재장전
 * 중이면(`isReloading`) 사격 불가 — 명시적 재장전 요청은 탄창이 비어있지
 * 않아도 시작될 수 있으므로, 이 잠금이 magazine>0인 상태에서도 발동해야
 * 한다(GA-04 given의 "요청함" 갈래). */
export function canFireAmmo(
  magazine: number,
  reloadStartedAtTick: number | undefined,
  currentTick: number,
  reloadTicks: number,
): boolean {
  if (magazine <= 0) return false
  return !isReloading(reloadStartedAtTick, currentTick, reloadTicks)
}

/** RQ-10: 탄창에서 1발 소모한 결과 — 0 미만으로 내려가지 않는다
 * (`applyDamage`의 `Math.max(0, ...)` 클램프와 동일 정신,
 * `src/shared/sim/combat.ts`). */
export function consumeRound(magazine: number): number {
  return Math.max(0, magazine - 1)
}

/** RQ-11: 재장전을 시작해야 하는가 — RQ-11 원문 "재장전을 요청하거나
 * 탄창이 0이 되면"의 직역. `requested`(명시적 요청)와 `magazine<=0`(탄창
 * 소진, 방어적으로 음수도 포함) 중 하나만 참이어도 true. */
export function shouldStartReload(magazine: number, requested: boolean): boolean {
  return requested || magazine <= 0
}
