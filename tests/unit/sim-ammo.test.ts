import { describe, expect, it } from 'vitest'
import { RELOAD_TICKS, canFireAmmo, consumeRound, isReloadComplete, isReloading, shouldStartReload } from '@shared/sim/ammo'
import { msToTicks } from '@shared/sim/clock'
import { WEAPON } from '@shared/constants'

/**
 * RQ-10(탄창 10발·예비 무한) · RQ-11(재장전 2초·재장전 중 사격 불가) — 순수
 * 로직 단위 테스트 (ADR-0008 §1: "스폰 보호 타이머(RQ-16)"와 동일한 "틱 기반
 * 마감시한" 패턴이 재장전에도 그대로 적용된다. ADR-0011: `src/shared` 전체는
 * Red-first 영역).
 *
 * **결정론(ADR-0008 핵심)**: 실시간 타이머·`Date.now()`에 의존하지 않는다 —
 * 틱(정수)만 인자로 받는 순수 함수다. `WEAPON.RELOAD_MS`(2000ms)가 정확히
 * 60틱으로 환산된다는 것은 `tests/unit/sim-clock.test.ts`("RQ-11: 재장전
 * 2000ms는 정확히 60틱이다", 이미 Green)가 고정했다 — 이 파일은 그 값을
 * 재확인하지 않고 **경계 전이 로직**(정확히 N틱째에 무엇이 바뀌는가)과
 * 탄약 소모·재장전 시작 판정만 다룬다. 통합 테스트
 * (`tests/integration/rq-1{0,1}-*.test.ts`)는 이 로직이 실 Colyseus 룸에
 * 실제로 결합돼 굴러가는지만 확인한다 — "정확히 60번째 틱"이라는 타이트한
 * 경계 검증은 여기(A계층)의 책임이다(`sim-lifecycle.test.ts`가 RQ-15/16에
 * 채택한 A/B 레벨 분리와 동일한 정신).
 *
 * **그린필드 계약(test-writer 지정, `sim-lifecycle.test.ts`·`sim-combat.test.ts`
 * 선례와 동일한 권한)**: `src/shared/sim/ammo.ts`는 원장에 없는 신규 모듈이다.
 * 아래 계약대로 `coder`가 구현하면 이 파일이 Green이 된다.
 *
 * ```ts
 * // src/shared/sim/ammo.ts (신규)
 * import { msToTicks } from './clock'
 * import { WEAPON } from '@shared/constants'
 *
 * // WEAPON.RELOAD_MS(2000ms)를 틱으로 환산한 편의 상수 — RESPAWN_TICKS·
 * // SPAWN_PROTECTION_TICKS(lifecycle.ts)와 동일한 "설정값 상수 export" 패턴.
 * // 현재 60틱(sim-clock.test.ts "RQ-11: 재장전 2000ms는 정확히 60틱이다"가
 * // 이미 고정).
 * export const RELOAD_TICKS: number // = msToTicks(WEAPON.RELOAD_MS), 현재 60
 *
 * // RQ-11: reloadStartedAtTick(재장전을 시작한 틱)부터 currentTick까지 경과가
 * // reloadTicks 이상이면 재장전이 완료된 것이다(경계 포함 — isRespawnDue와
 * // 동일한 스타일: "N틱 이상 지나면"의 직역). reloadTicks를 인자로 받는 이유도
 * // canFire(lastFireAtMs, nowMs, minIntervalMs)·isRespawnDue와 동일하다 —
 * // 임계값을 상수에 감추지 않는다(순수 함수 재사용성).
 * export function isReloadComplete(
 *   reloadStartedAtTick: number,
 *   currentTick: number,
 *   reloadTicks: number,
 * ): boolean
 *
 * // RQ-11: reloadStartedAtTick이 undefined면(재장전을 시작한 적이 없음) 항상
 * // false. 그 외에는 isReloadComplete의 여집합 — 아직 완료되지 않았으면
 * // (경과 < reloadTicks) true.
 * export function isReloading(
 *   reloadStartedAtTick: number | undefined,
 *   currentTick: number,
 *   reloadTicks: number,
 * ): boolean
 *
 * // RQ-10/RQ-11: 탄창(magazine)이 0이면 재장전 진행 여부와 무관하게 항상
 * // 사격 불가(가장 강한 조건 — "탄창이 비면 쏠 수 없다"). magazine이 1발
 * // 이상이어도 재장전 중이면(isReloading) 사격 불가 — RQ-11 "재장전 중에는
 * // 사격을 허용하지 않아야 한다"가 탄약 잔여와 무관하게 걸리는 잠금이라는
 * // 뜻이다(명시적 재장전 요청은 탄창이 비어있지 않아도 시작될 수 있으므로,
 * // 이 잠금이 magazine>0인 상태에서도 발동해야 한다 — GA-04 given의
 * // "요청함" 갈래).
 * export function canFireAmmo(
 *   magazine: number,
 *   reloadStartedAtTick: number | undefined,
 *   currentTick: number,
 *   reloadTicks: number,
 * ): boolean
 *
 * // RQ-10: 탄창에서 1발 소모한 결과 — 0 미만으로 내려가지 않는다
 * // (`applyDamage`의 `Math.max(0, ...)` 클램프와 동일 정신,
 * // `src/shared/sim/combat.ts:250-253`).
 * export function consumeRound(magazine: number): number
 *
 * // RQ-11: 재장전을 시작해야 하는가 — RQ-11 원문 "재장전을 요청하거나
 * // 탄창이 0이 되면"의 직역. requested(명시적 요청)와 magazine<=0(탄창
 * // 소진, 방어적으로 음수도 포함) 중 하나만 참이어도 true.
 * export function shouldStartReload(magazine: number, requested: boolean): boolean
 * ```
 *
 * **가정(coder에게 — GameRoom 배선)**:
 * 1. 세션별 `magazine`(초기값 `WEAPON.MAGAZINE`=10)과 `reloadStartedAtTick`
 *    (초기 `undefined`)은 GameRoom이 서버 전유 상태로 관리한다 —
 *    `diedAtTick`·`spawnedAtTick`(lifecycle.ts 배선)과 동일한 패턴이다.
 *    `Player` 스키마에 새 필드를 추가할 필요는 없다 — 클라 탄약 HUD(RQ-53)는
 *    이 라운드의 명시적 제외 범위이므로 지금은 관측 가능성이 요구되지 않는다.
 * 2. `handleFire`가 `canAct`·rate-limit(ADR-0005)을 통과한 뒤,
 *    `canFireAmmo(magazine, reloadStartedAtTick, currentTick, RELOAD_TICKS)`가
 *    false면 요청을 완전히 무시한다(레이도 쏘지 않는다 — `sanitizeMoveInput`이
 *    RQ-61 위반 필드를 무시하는 것과 동일한 "조용히 무시" 원칙).
 * 3. canAct·rate-limit·canFireAmmo를 모두 통과해 사격이 실제로 처리될
 *    때마다(명중 여부 무관 — `firedSinceSpawn`과 동일 정신,
 *    `rq-16-spawn-protection.test.ts`의 "빗나가는 방향으로 자기 사격만 해도
 *    보호가 풀린다" 케이스와 동일한 "발사 행위 자체" 판정 기준) `consumeRound`로
 *    1발을 소모한다. 소모 후 `shouldStartReload(newMagazine, false)`가
 *    true(=newMagazine<=0)면 그 시점의 `currentTick`으로
 *    `reloadStartedAtTick`을 설정해 자동 재장전을 시작한다.
 * 4. 새 `'reload'` 메시지(payload 불요 — 빈 객체 `{}`) 수신 시
 *    `shouldStartReload(currentMagazine, true)`(요청 자체가 항상 true를
 *    만드므로 사실상 무조건) — `reloadStartedAtTick`을 현재 tick으로
 *    설정한다. 탄창이 가득 차 있어도 허용한다 — RQ-11 "요청하면" 갈래는
 *    잔여탄과 무관하다(GA-04 given의 첫 번째 갈래).
 * 5. `isReloadComplete(reloadStartedAtTick, currentTick, RELOAD_TICKS)`가
 *    true로 전환되는 시점에 `magazine`을 `WEAPON.MAGAZINE`으로 리필하고
 *    `reloadStartedAtTick`을 지운다 — 그 갱신을 매 틱 사전 판정으로 하든
 *    다음 사격 시도 시 지연 판정으로 하든 이 계약은 트리거를 규정하지
 *    않는다(관측 가능한 결과만 규정 — `tests/integration/rq-11-reload-lockout
 *    .test.ts`가 "재장전 완료 후 사격이 정상 작동하는가"만 블랙박스로 확인).
 * 6. 리스폰 시 탄창 초기화 여부는 스펙이 침묵한다(팀리드 지시) — 이 계약도,
 *    이 RQ의 통합 테스트도 그 경로를 규정하지 않는다.
 */

describe('RQ-11 재장전 완료 판정 — isReloadComplete(reloadStartedAtTick, currentTick, reloadTicks)', () => {
  it('경과 틱이 reloadTicks 미만이면 아직 완료되지 않았다', () => {
    expect(isReloadComplete(0, 59, 60)).toBe(false)
  })

  it('경과 틱이 정확히 reloadTicks이면 완료된다(경계 포함)', () => {
    expect(isReloadComplete(0, 60, 60)).toBe(true)
  })

  it('경과 틱이 reloadTicks를 초과해도 완료된 상태다', () => {
    expect(isReloadComplete(0, 200, 60)).toBe(true)
  })

  it('reloadStartedAtTick이 0이 아닌 임의 시점이어도 상대 경과로 판정한다', () => {
    expect(isReloadComplete(500, 559, 60)).toBe(false) // 경과 59틱
    expect(isReloadComplete(500, 560, 60)).toBe(true) // 경과 60틱
  })

  it('경과가 정확히 0틱(재장전 시작 직후)이면 아직 완료되지 않았다', () => {
    expect(isReloadComplete(1000, 1000, 60)).toBe(false)
  })

  it('RQ-11 실측값(RELOAD_TICKS=60, WEAPON.RELOAD_MS에서 유도)으로도 동일하게 성립한다', () => {
    expect(RELOAD_TICKS).toBe(60)
    expect(RELOAD_TICKS).toBe(msToTicks(WEAPON.RELOAD_MS))
    expect(isReloadComplete(0, 59, RELOAD_TICKS)).toBe(false)
    expect(isReloadComplete(0, 60, RELOAD_TICKS)).toBe(true)
  })
})

describe('RQ-11 재장전 진행 중 판정 — isReloading(reloadStartedAtTick, currentTick, reloadTicks)', () => {
  it('reloadStartedAtTick이 undefined면(재장전을 시작한 적 없음) 재장전 중이 아니다', () => {
    expect(isReloading(undefined, 100, 60)).toBe(false)
  })

  it('재장전 시작 직후(경과 0틱)에는 재장전 중이다', () => {
    expect(isReloading(100, 100, 60)).toBe(true)
  })

  it('경과가 reloadTicks 미만이면 계속 재장전 중이다', () => {
    expect(isReloading(100, 159, 60)).toBe(true)
  })

  it('경과가 정확히 reloadTicks이면 더 이상 재장전 중이 아니다(완료 — isReloadComplete와 반대 부호)', () => {
    expect(isReloading(100, 160, 60)).toBe(false)
  })

  it('경과가 reloadTicks를 초과해도 재장전 중이 아니다', () => {
    expect(isReloading(100, 500, 60)).toBe(false)
  })

  it('RQ-11 실측값(RELOAD_TICKS=60)으로도 동일하게 성립한다', () => {
    expect(isReloading(0, 59, RELOAD_TICKS)).toBe(true)
    expect(isReloading(0, 60, RELOAD_TICKS)).toBe(false)
  })
})

describe('RQ-10/RQ-11 사격 가능 판정 — canFireAmmo(magazine, reloadStartedAtTick, currentTick, reloadTicks)', () => {
  it('탄창에 실탄이 있고 재장전 중이 아니면 사격 가능하다', () => {
    expect(canFireAmmo(5, undefined, 100, 60)).toBe(true)
  })

  it('탄창이 0이고 재장전을 시작하지 않았어도(방어적 상태) 사격 불가하다', () => {
    expect(canFireAmmo(0, undefined, 100, 60)).toBe(false)
  })

  it('탄창이 0이고 재장전 중이면 사격 불가하다(RQ-11 GA-04, 탄창 0 갈래)', () => {
    expect(canFireAmmo(0, 100, 120, 60)).toBe(false)
  })

  it('탄창에 실탄이 남아 있어도(명시적 요청 재장전 중) 사격 불가하다(RQ-11 GA-04, 요청 갈래 — 잔여탄과 무관한 잠금)', () => {
    expect(canFireAmmo(9, 80, 100, 60)).toBe(false) // 경과 20틱 < 60, 재장전 중
  })

  it('재장전이 완료되고 탄창에 실탄이 남아 있으면 다시 사격 가능하다', () => {
    expect(canFireAmmo(9, 80, 140, 60)).toBe(true) // 경과 60틱, 완료
  })

  it('재장전이 완료돼도 탄창이 0이면(리필 반영 전 상태 방어) 여전히 사격 불가하다', () => {
    expect(canFireAmmo(0, 80, 140, 60)).toBe(false)
  })

  it('탄창이 음수여도(방어적) 사격 불가하다', () => {
    expect(canFireAmmo(-1, undefined, 0, 60)).toBe(false)
  })
})

describe('RQ-10 탄약 소모 — consumeRound(magazine)', () => {
  it('탄창에서 1발이 줄어든다', () => {
    expect(consumeRound(10)).toBe(9)
    expect(consumeRound(5)).toBe(4)
  })

  it('탄창이 1발일 때 소모하면 0이 된다', () => {
    expect(consumeRound(1)).toBe(0)
  })

  it('탄창이 이미 0이면 음수로 내려가지 않는다(클램프)', () => {
    expect(consumeRound(0)).toBe(0)
  })
})

describe('RQ-11 재장전 시작 판정 — shouldStartReload(magazine, requested)', () => {
  it('탄창이 남아 있고 요청도 없으면 재장전을 시작하지 않는다', () => {
    expect(shouldStartReload(5, false)).toBe(false)
  })

  it('탄창이 남아 있어도 명시적으로 요청하면 재장전을 시작한다(GA-04 given, 요청 갈래)', () => {
    expect(shouldStartReload(5, true)).toBe(true)
  })

  it('탄창이 가득 차 있어도(WEAPON.MAGAZINE) 명시적 요청이면 재장전을 시작한다', () => {
    expect(shouldStartReload(WEAPON.MAGAZINE, true)).toBe(true)
  })

  it('요청이 없어도 탄창이 0이면 재장전을 시작한다(GA-04 given, 탄창 0 갈래 — RQ-11 자동 트리거)', () => {
    expect(shouldStartReload(0, false)).toBe(true)
  })

  it('탄창이 0이고 요청도 있으면(중복 조건) 당연히 재장전을 시작한다', () => {
    expect(shouldStartReload(0, true)).toBe(true)
  })

  it('탄창이 음수여도(방어적) 재장전을 시작한다', () => {
    expect(shouldStartReload(-1, false)).toBe(true)
  })
})
