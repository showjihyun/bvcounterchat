import { describe, expect, it } from 'vitest'
import {
  RESPAWN_TICKS,
  SPAWN_PROTECTION_TICKS,
  applyDamageWithProtection,
  canAct,
  isRespawnDue,
  isSpawnProtected,
} from '@shared/sim/lifecycle'
import { msToTicks } from '@shared/sim/clock'
import { PLAYER } from '@shared/constants'

/**
 * RQ-15(리스폰) · RQ-16(스폰 보호) · 사망자 갭 해소 — 순수 로직 단위 테스트
 * (ADR-0008 §1이 "스폰 보호 타이머(RQ-16)"를 순수 함수/상태 전이 로직의 예로
 * 명시한다. RQ-15 리스폰 타이머는 동일한 "틱 기반 마감시한" 패턴이라 같은
 * 레벨·같은 파일에 둔다. ADR-0011: `src/shared` 전체는 Red-first 영역).
 *
 * **결정론(ADR-0008 핵심)**: 실시간 타이머·`Date.now()`에 의존하지 않는다 —
 * 틱(정수)만 인자로 받는 순수 함수다. `PLAYER.RESPAWN_MS`(3000ms)·
 * `PLAYER.SPAWN_PROTECTION_MS`(3000ms)가 정확히 90틱으로 환산된다는 것은
 * `tests/unit/sim-clock.test.ts`("RQ-15: 리스폰 3000ms는 정확히 90틱이다" ·
 * "RQ-16: 스폰 보호 3000ms는 정확히 90틱이다", 이미 Green)가 고정했다 — 이
 * 파일은 그 값을 재확인하지 않고 **경계 전이 로직**(정확히 N틱째에 무엇이
 * 바뀌는가)만 다룬다. 통합 테스트(`tests/integration/rq-1{5,6}-*.test.ts`)는
 * 이 로직이 실 Colyseus 30Hz 루프에 실제로 결합돼 굴러가는지만 확인한다 —
 * "정확히 90번째 틱"이라는 타이트한 경계 검증은 여기(A계층)의 책임이다
 * (`rq-60-fixed-tickrate.test.ts`가 이미 채택한 A/B 레벨 분리와 동일한 정신).
 *
 * **그린필드 계약(test-writer 지정, `sim-combat.test.ts` 선례와 동일한 권한)**:
 * `src/shared/sim/lifecycle.ts`는 원장에 없는 신규 모듈이다. 아래 계약대로
 * `coder`가 구현하면 이 파일이 Green이 된다.
 *
 * ```ts
 * // src/shared/sim/lifecycle.ts (신규)
 * import { msToTicks } from './clock'
 * import { PLAYER } from '@shared/constants'
 * import { applyDamage, type DamageOutcome } from './combat'
 *
 * // PLAYER.RESPAWN_MS(3000ms)·PLAYER.SPAWN_PROTECTION_MS(3000ms)를 틱으로
 * // 환산한 편의 상수 — 매 호출부가 msToTicks를 반복 계산하지 않도록 한 번만
 * // 계산해 내보낸다(combat-tuning.ts의 DEFAULT_HITBOX/DEFAULT_SPREAD와 동일한
 * // "설정값 상수 export" 패턴).
 * export const RESPAWN_TICKS: number    // = msToTicks(PLAYER.RESPAWN_MS), 현재 90
 * export const SPAWN_PROTECTION_TICKS: number // = msToTicks(PLAYER.SPAWN_PROTECTION_MS), 현재 90
 *
 * // RQ-15: diedAtTick(사망 처리된 틱)부터 currentTick까지 경과가
 * // respawnTicks 이상이면 리스폰 대상이다(경계 포함 — "N틱 이상 지나면"의
 * // 직역, canFire의 "간격 이상이면 허용" 경계 규칙과 동일한 스타일).
 * // respawnTicks를 인자로 받는 이유: canFire(lastFireAtMs, nowMs,
 * // minIntervalMs)와 동일하게 임계값을 상수에 감추지 않는다(순수 함수 재사용성).
 * export function isRespawnDue(diedAtTick: number, currentTick: number, respawnTicks: number): boolean
 *
 * // RQ-16: spawnedAtTick(최초 입장·리스폰 공통 — "스폰된" 시점)부터 경과가
 * // protectionTicks 미만이면 보호 중이다. firedSinceSpawn이 true면 경과와
 * // 무관하게 즉시 false(사격 시 즉시 해제 규칙, RQ-16 "보호 중인 플레이어가
 * // 사격하면... 즉시 해제"). 자연 만료는 경계 미포함(<) — 정확히
 * // protectionTicks가 지난 시점부터는 더 이상 보호가 아니다(isRespawnDue와
 * // 반대 부호처럼 보이지만 "N틱 경과 시점부터 다음 상태"라는 동일 규칙이다).
 * export function isSpawnProtected(
 *   spawnedAtTick: number,
 *   currentTick: number,
 *   protectionTicks: number,
 *   firedSinceSpawn: boolean,
 * ): boolean
 *
 * // RQ-16 피해 무효화: isProtected가 true면 피해를 전혀 적용하지 않고(hp
 * // 그대로, died=false) 반환한다. false면 applyDamage(currentHp, damage)와
 * // 완전히 동일하게 동작한다 — applyDamage 시그니처는 바꾸지 않는 얇은 게이트.
 * export function applyDamageWithProtection(currentHp: number, damage: number, isProtected: boolean): DamageOutcome
 *
 * // RQ-15 사망자 갭: hp가 0 이하인 플레이어는 행동(사격·이동)할 수 없다.
 * export function canAct(hp: number): boolean
 * ```
 *
 * **가정(coder에게 — GameRoom 배선)**: `handleFire`·`stepPlayerMovement`
 * 양쪽 모두 처리 시작 시 `canAct(player.hp)`를 확인해, false면 그 요청을
 * 완전히 무시한다(위치·탄약·발사 상태 어느 것도 갱신하지 않는다). 스폰 보호는
 * 최초 입장(onJoin)과 리스폰(RQ-15) **양쪽 다** 해당 세션의 `spawnedAtTick`을
 * 현재 틱으로, `firedSinceSpawn`을 false로 재설정한다고 가정한다 — `handleFire`가
 * 사격을 실제로 처리(canAct·rate-limit 통과)할 때마다 사수 자신의
 * `firedSinceSpawn`을 true로 갱신한다(명중 여부와 무관 — RQ-16 "사격하면"은
 * 명중이 아니라 발사 행위 자체를 가리킨다, `rq-16-spawn-protection.test.ts`의
 * "빗나가는 방향으로 자기 사격만 해도 보호가 풀린다" 케이스가 이 가정을
 * 직접 확인한다).
 */

describe('RQ-15 리스폰 타이머 — isRespawnDue(diedAtTick, currentTick, respawnTicks)', () => {
  it('경과 틱이 respawnTicks 미만이면 아직 리스폰 대상이 아니다', () => {
    expect(isRespawnDue(0, 89, 90)).toBe(false)
  })

  it('경과 틱이 정확히 respawnTicks이면 리스폰 대상이다(경계 포함)', () => {
    expect(isRespawnDue(0, 90, 90)).toBe(true)
  })

  it('경과 틱이 respawnTicks를 초과해도 리스폰 대상이다', () => {
    expect(isRespawnDue(0, 200, 90)).toBe(true)
  })

  it('diedAtTick이 0이 아닌 임의 시점이어도 상대 경과로 판정한다', () => {
    expect(isRespawnDue(500, 589, 90)).toBe(false) // 경과 89틱
    expect(isRespawnDue(500, 590, 90)).toBe(true) // 경과 90틱
  })

  it('경과가 정확히 0틱(사망 직후)이면 리스폰 대상이 아니다', () => {
    expect(isRespawnDue(1000, 1000, 90)).toBe(false)
  })

  it('RQ-15 실측값(RESPAWN_TICKS=90, PLAYER.RESPAWN_MS에서 유도)으로도 동일하게 성립한다', () => {
    expect(RESPAWN_TICKS).toBe(90)
    expect(RESPAWN_TICKS).toBe(msToTicks(PLAYER.RESPAWN_MS))
    expect(isRespawnDue(0, 89, RESPAWN_TICKS)).toBe(false)
    expect(isRespawnDue(0, 90, RESPAWN_TICKS)).toBe(true)
  })
})

describe('RQ-16 스폰 보호 — isSpawnProtected(spawnedAtTick, currentTick, protectionTicks, firedSinceSpawn)', () => {
  it('경과 틱이 0(스폰 직후, 아직 사격 안 함)이면 보호 중이다', () => {
    expect(isSpawnProtected(100, 100, 90, false)).toBe(true)
  })

  it('경과 틱이 protectionTicks 미만이고 사격하지 않았으면 보호 중이다', () => {
    expect(isSpawnProtected(0, 89, 90, false)).toBe(true)
  })

  it('경과 틱이 정확히 protectionTicks이면 자연 만료로 더 이상 보호되지 않는다(경계 — 사격 없이도)', () => {
    expect(isSpawnProtected(0, 90, 90, false)).toBe(false)
  })

  it('경과 틱이 protectionTicks를 초과해도 보호되지 않는다', () => {
    expect(isSpawnProtected(0, 500, 90, false)).toBe(false)
  })

  it('firedSinceSpawn이 true면 경과가 0이어도(스폰 직후 즉시 사격) 보호가 해제된다(RQ-16 "사격하면 즉시 해제")', () => {
    expect(isSpawnProtected(100, 100, 90, true)).toBe(false)
  })

  it('firedSinceSpawn이 true면 경과가 protectionTicks 미만이라도 보호가 해제된다', () => {
    expect(isSpawnProtected(0, 10, 90, true)).toBe(false)
  })

  it('RQ-16 실측값(SPAWN_PROTECTION_TICKS=90)으로도 동일하게 성립한다', () => {
    expect(SPAWN_PROTECTION_TICKS).toBe(90)
    expect(SPAWN_PROTECTION_TICKS).toBe(msToTicks(PLAYER.SPAWN_PROTECTION_MS))
    expect(isSpawnProtected(0, 89, SPAWN_PROTECTION_TICKS, false)).toBe(true)
    expect(isSpawnProtected(0, 90, SPAWN_PROTECTION_TICKS, false)).toBe(false)
  })
})

describe('RQ-16 피해 무효화 — applyDamageWithProtection(currentHp, damage, isProtected)', () => {
  it('보호 중이면 피해가 전혀 적용되지 않는다(hp 불변, died=false) — GA-10 (1)', () => {
    expect(applyDamageWithProtection(100, 25, true)).toEqual({ hp: 100, died: false })
  })

  it('보호 중이면 치명적인 피해량을 줘도 사망하지 않는다(완전 무효화)', () => {
    expect(applyDamageWithProtection(100, 9999, true)).toEqual({ hp: 100, died: false })
  })

  it('보호 중이 아니면 applyDamage와 완전히 동일하게 동작한다(일반 피해) — GA-10 (2)(3)', () => {
    expect(applyDamageWithProtection(100, 25, false)).toEqual({ hp: 75, died: false })
  })

  it('보호 중이 아니면 오버킬도 정상적으로 사망 처리한다(applyDamage와 동일 클램프)', () => {
    expect(applyDamageWithProtection(10, 25, false)).toEqual({ hp: 0, died: true })
  })
})

describe('RQ-15 사망자 갭 — canAct(hp)', () => {
  it('hp가 양수면 행동 가능하다', () => {
    expect(canAct(100)).toBe(true)
    expect(canAct(1)).toBe(true)
  })

  it('hp가 0이면 행동 불가능하다(사망 상태)', () => {
    expect(canAct(0)).toBe(false)
  })

  it('hp가 음수여도(방어적) 행동 불가능하다', () => {
    expect(canAct(-1)).toBe(false)
  })
})
