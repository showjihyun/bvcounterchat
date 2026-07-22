import { describe, expect, it } from 'vitest'
import { msToTicks } from '@shared/sim/clock'
import { PLAYER, WEAPON } from '@shared/constants'
import { createSimHarness } from '../support/harness'

/**
 * 결정론 시뮬레이션 하네스 — 테스트 지원 하네스 자체의 동작 (원장 17e 계약 §4).
 *
 * `tests/support/harness.ts`는 이 위에 쌓일 모든 시간 기반 RQ 테스트의
 * 기반이다. "고장 난 하네스는 없는 하네스보다 나쁘다"(계약 §「테스트 위치」) —
 * clock·scheduler를 각자 옳게 구현해도 이 결합이 어긋나면 그 위의 모든
 * 테스트가 거짓 신호를 낸다.
 */
describe('SimHarness (원장 17e §4)', () => {
  it('seed 미지정 시 고정 기본값을 쓴다 — 실행마다 rng 수열이 같다', () => {
    const a = createSimHarness()
    const b = createSimHarness()
    const seqA = [a.rng.nextU32(), a.rng.nextU32(), a.rng.nextU32()]
    const seqB = [b.rng.nextU32(), b.rng.nextU32(), b.rng.nextU32()]
    expect(seqA).toEqual(seqB)
  })

  it('seed 옵션을 지정하면 그 시드로 rng가 초기화된다', () => {
    const withSeedA = createSimHarness({ seed: 111 })
    const withSeedB = createSimHarness({ seed: 222 })
    expect(withSeedA.rng.nextU32()).not.toBe(withSeedB.rng.nextU32())
  })

  it('advanceTicks(n)은 clock을 n틱 전진시키고 그 사이 만료된 스케줄러 콜백을 전부 실행한다', () => {
    const h = createSimHarness()
    const order: number[] = []
    h.scheduler.scheduleAt(3, () => order.push(3))
    h.scheduler.scheduleAt(7, () => order.push(7))
    h.advanceTicks(10)
    expect(h.clock.tick).toBe(10)
    expect(order).toEqual([3, 7])
  })

  it('advanceTicks(n)은 목표 틱을 넘는 예약은 실행하지 않는다', () => {
    const h = createSimHarness()
    let fired = false
    h.scheduler.scheduleAt(20, () => {
      fired = true
    })
    h.advanceTicks(10)
    expect(h.clock.tick).toBe(10)
    expect(fired).toBe(false)
  })

  it('advanceTicks에 음수·비정수를 주면 던진다 (틱 정수성)', () => {
    const h = createSimHarness()
    expect(() => h.advanceTicks(-1)).toThrow()
    expect(() => h.advanceTicks(1.5)).toThrow()
  })

  it('advanceMs(ms)는 advanceTicks(msToTicks(ms))와 같다', () => {
    const h1 = createSimHarness()
    const h2 = createSimHarness()
    h1.advanceMs(2000)
    h2.advanceTicks(msToTicks(2000))
    expect(h1.clock.tick).toBe(h2.clock.tick)
    expect(h1.clock.tick).toBe(60)
  })

  it('RQ-15: 리스폰 3000ms(90틱) 예약은 89틱까지 실행되지 않고 90틱에 실행된다', () => {
    const h = createSimHarness()
    let respawned = false
    h.scheduler.scheduleIn(PLAYER.RESPAWN_MS, () => {
      respawned = true
    })
    h.advanceTicks(89)
    expect(respawned).toBe(false)
    h.advanceTicks(1)
    expect(respawned).toBe(true)
  })

  it('RQ-11: 재장전 2000ms(60틱)를 advanceMs로 한 번에 건너뛰어도 그 시점에 실행된다', () => {
    const h = createSimHarness()
    let reloaded = false
    h.scheduler.scheduleIn(WEAPON.RELOAD_MS, () => {
      reloaded = true
    })
    h.advanceMs(WEAPON.RELOAD_MS)
    expect(reloaded).toBe(true)
  })

  /**
   * 회귀 테스트 (PR #4 blocker 대응, 계약 §4 「전진 단위 불변식」).
   *
   * `advanceTicks(10)`이 clock을 한 번에 옮기고 `scheduler.advanceTo`를 1회만
   * 부르면, 마감 틱 3의 콜백이 실행되는 시점에 이미 clock.tick이 최종
   * 목표(10)여서 콜백이 "미래"를 관측하는 버그가 있었다. 이 아래 세 테스트가
   * 그 회귀를 고정한다 — 통과만 확인하는 테스트가 아니라, 불변식 자체
   * ("콜백이 관측하는 tick == 자신의 마감 틱", "벌크·틱별 두 경로의 연쇄
   * 예약 마감시한이 같다")를 직접 단언한다.
   */
  it('회귀(PR #4): advanceTicks(n) 한 번으로 여러 콜백이 실행돼도, 각 콜백이 관측한 clock.tick은 자신의 마감 틱과 같다 (최종 틱이 아니라)', () => {
    const h = createSimHarness()
    const observedTicks: number[] = []
    h.scheduler.scheduleAt(3, () => observedTicks.push(h.clock.tick))
    h.scheduler.scheduleAt(7, () => observedTicks.push(h.clock.tick))
    h.advanceTicks(10)
    expect(observedTicks).toEqual([3, 7])
    expect(h.clock.tick).toBe(10) // 최종 틱은 10이 맞다 — 콜백이 그걸 조기에 보면 안 된다는 것이 요점
  })

  it('회귀(PR #4): 벌크 advanceTicks(n) 한 번과 advanceTicks(1) 반복이 연쇄 예약(scheduleIn)의 마감 틱을 같게 낸다', () => {
    const runScenario = (driver: (h: ReturnType<typeof createSimHarness>) => void): number => {
      const h = createSimHarness()
      let chainDeadlineTick = -1
      h.scheduler.scheduleAt(3, () => {
        h.scheduler.scheduleIn(WEAPON.RELOAD_MS, () => {
          chainDeadlineTick = h.clock.tick
        })
      })
      driver(h)
      return chainDeadlineTick
    }

    const bulkResult = runScenario((h) => h.advanceTicks(70))
    const stepwiseResult = runScenario((h) => {
      for (let i = 0; i < 70; i++) h.advanceTicks(1)
    })

    // 두 경로를 서로 비교한다 — 상수(WEAPON.RELOAD_MS)가 바뀌어도 이 불변식은
    // 유지되어야 하므로 하드코딩한 값이 아니라 두 경로의 결과를 맞댄다.
    expect(bulkResult).toBe(stepwiseResult)
    // 두 경로가 "같은 값으로 함께 틀렸을" 가능성까지 배제하기 위해, 그 공통값이
    // 실제로 옳은 계산식(마감 틱 3 + RELOAD_MS 환산 틱)과도 일치하는지 확인한다.
    expect(bulkResult).toBe(3 + msToTicks(WEAPON.RELOAD_MS))
  })

  it('회귀(PR #4): advanceMs(ms)도 같은 불변식을 만족한다 — 콜백이 관측한 clock.tick이 마감 틱과 같다', () => {
    const h = createSimHarness()
    let observedTick = -1
    h.scheduler.scheduleAt(3, () => {
      observedTick = h.clock.tick
    })
    h.advanceMs(WEAPON.RELOAD_MS) // 2000ms → 60틱, 마감 3은 그 안에 있다
    expect(observedTick).toBe(3)
    expect(h.clock.tick).toBe(msToTicks(WEAPON.RELOAD_MS)) // 최종 틱은 60
  })
})
