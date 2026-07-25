/**
 * RQ-15(리스폰) · RQ-16(스폰 보호) · 사망자 갭(`canAct`) — 순수 로직
 * (ADR-0008: 순수 함수, 결정론, `src/shared` 환경 중립. ADR-0008 §1이
 * "스폰 보호 타이머(RQ-16)"를 순수 함수/상태 전이 로직의 예로 명시한다).
 *
 * 그린필드 계약은 `tests/unit/sim-lifecycle.test.ts` 상단 docblock
 * (test-writer 지정)이 정본이다 — 이 파일은 그 계약을 그대로 구현한다.
 *
 * 임계값(`respawnTicks`·`protectionTicks`)을 상수에 감추지 않고 인자로
 * 받는 이유: `canFire(lastFireAtMs, nowMs, minIntervalMs)`(`combat.ts`)와
 * 동일한 설계 원칙 — 순수 함수 재사용성·테스트 편의.
 */

import { msToTicks } from '@shared/sim/clock'
import { PLAYER } from '@shared/constants'
import { applyDamage, type DamageOutcome } from '@shared/sim/combat'

/** `PLAYER.RESPAWN_MS`(3000ms)를 틱으로 환산한 편의 상수 — 매 호출부가
 * `msToTicks`를 반복 계산하지 않도록 한 번만 계산해 내보낸다. */
export const RESPAWN_TICKS: number = msToTicks(PLAYER.RESPAWN_MS)
/** `PLAYER.SPAWN_PROTECTION_MS`(3000ms)를 틱으로 환산한 편의 상수. */
export const SPAWN_PROTECTION_TICKS: number = msToTicks(PLAYER.SPAWN_PROTECTION_MS)

/** RQ-15: `diedAtTick`(사망 처리된 틱)부터 `currentTick`까지 경과가
 * `respawnTicks` 이상이면 리스폰 대상이다(경계 포함). */
export function isRespawnDue(diedAtTick: number, currentTick: number, respawnTicks: number): boolean {
  return currentTick - diedAtTick >= respawnTicks
}

/** RQ-16: `firedSinceSpawn`이 true면 경과와 무관하게 즉시 false(사격 시
 * 즉시 해제 규칙). 그 외에는 `spawnedAtTick`부터 경과가 `protectionTicks`
 * 미만이면 보호 중이다 — 자연 만료는 경계 미포함(정확히 `protectionTicks`가
 * 지난 시점부터는 더 이상 보호가 아니다). */
export function isSpawnProtected(
  spawnedAtTick: number,
  currentTick: number,
  protectionTicks: number,
  firedSinceSpawn: boolean,
): boolean {
  if (firedSinceSpawn) return false
  return currentTick - spawnedAtTick < protectionTicks
}

/** RQ-16 피해 무효화 — `isProtected`가 true면 피해를 전혀 적용하지 않고
 * (hp 그대로, died=false) 반환한다. false면 `applyDamage`와 완전히
 * 동일하게 동작하는 얇은 게이트다(시그니처를 바꾸지 않는다). */
export function applyDamageWithProtection(currentHp: number, damage: number, isProtected: boolean): DamageOutcome {
  if (isProtected) return { hp: currentHp, died: false }
  return applyDamage(currentHp, damage)
}

/** RQ-15 사망자 갭: hp가 0 이하인 플레이어는 행동(사격·이동)할 수 없다. */
export function canAct(hp: number): boolean {
  return hp > 0
}
