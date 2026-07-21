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
})
