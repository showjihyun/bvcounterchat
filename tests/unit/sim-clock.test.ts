import { describe, expect, it } from 'vitest'
import { createClock, msToTicks, ticksToMs } from '@shared/sim/clock'
import { NET, PLAYER, WEAPON } from '@shared/constants'

/**
 * 결정론 시뮬레이션 하네스 — 틱 시계 (원장 17e 계약 §1).
 *
 * 시간의 정본은 틱(정수)이고 ms는 경계에서만 쓴다는 설계를 검증한다.
 * `NET.TICK_MS`(33.333…ms)는 부동소수점이라, "누적 오차 없이 항상
 * tick → ms를 그때그때 계산"하는지가 이 하네스 전체의 결정론을 좌우한다
 * (계약 §「핵심 설계 판단」).
 */
describe('TickClock (원장 17e §1)', () => {
  it('createClock()의 초기 tick은 0, timeMs는 0이다', () => {
    const clock = createClock()
    expect(clock.tick).toBe(0)
    expect(clock.timeMs).toBe(0)
  })

  it('createClock(startTick)은 지정한 틱에서 시작한다', () => {
    const clock = createClock(5)
    expect(clock.tick).toBe(5)
  })

  it('advance(n)은 tick을 정확히 n 증가시킨다', () => {
    const clock = createClock()
    clock.advance(7)
    expect(clock.tick).toBe(7)
    clock.advance(3)
    expect(clock.tick).toBe(10)
  })

  it('advance()는 advance(1)과 같다', () => {
    const clock = createClock()
    clock.advance()
    expect(clock.tick).toBe(1)
  })

  it('advance(0)은 아무 변화가 없다', () => {
    const clock = createClock()
    clock.advance(5)
    clock.advance(0)
    expect(clock.tick).toBe(5)
  })

  it('음수 인자는 던진다 — 조용히 반올림하면 결정론이 깨진 것을 아무도 모른다', () => {
    const clock = createClock()
    expect(() => clock.advance(-1)).toThrow()
  })

  it('비정수 인자는 던진다', () => {
    const clock = createClock()
    expect(() => clock.advance(1.5)).toThrow()
    expect(() => clock.advance(NaN)).toThrow()
  })

  it('던지는 에러는 RangeError 또는 TypeError다', () => {
    const clock = createClock()
    const captureError = (fn: () => void): unknown => {
      try {
        fn()
        return undefined
      } catch (e) {
        return e
      }
    }

    const negativeError = captureError(() => clock.advance(-1))
    const fractionError = captureError(() => clock.advance(1.5))

    expect(negativeError instanceof RangeError || negativeError instanceof TypeError).toBe(true)
    expect(fractionError instanceof RangeError || fractionError instanceof TypeError).toBe(true)
  })

  it('timeMs는 ticksToMs(tick)과 항상 같다', () => {
    const clock = createClock()
    expect(clock.timeMs).toBe(ticksToMs(clock.tick))
    clock.advance(37)
    expect(clock.timeMs).toBe(ticksToMs(clock.tick))
    clock.advance(1)
    expect(clock.timeMs).toBe(ticksToMs(clock.tick))
  })

  it('advance(1)을 90번 반복한 결과는 advance(90) 1회와 같은 tick·timeMs를 낸다 (누적 오차 없음)', () => {
    const stepwise = createClock()
    for (let i = 0; i < 90; i++) stepwise.advance(1)

    const bulk = createClock()
    bulk.advance(90)

    expect(stepwise.tick).toBe(bulk.tick)
    expect(stepwise.timeMs).toBe(bulk.timeMs)
  })

  it('msToTicks는 올림이다', () => {
    expect(msToTicks(0)).toBe(0)
    expect(msToTicks(1)).toBe(1)
    expect(msToTicks(2000)).toBe(60)
    expect(msToTicks(3000)).toBe(90)
  })

  it('msToTicks는 TICK_MS 경계에서도 올림이다 — 정확히 한 틱 분량이면 1틱, 조금이라도 넘으면 2틱', () => {
    expect(msToTicks(NET.TICK_MS)).toBe(1)
    expect(msToTicks(NET.TICK_MS + 0.001)).toBe(2)
  })

  it('ticksToMs(ticks)는 ticks * NET.TICK_MS와 정확히 같다', () => {
    expect(ticksToMs(60)).toBe(60 * NET.TICK_MS)
    expect(ticksToMs(90)).toBe(90 * NET.TICK_MS)
    expect(ticksToMs(9000)).toBe(9000 * NET.TICK_MS)
  })

  it('RQ-11: 재장전 2000ms는 정확히 60틱이다', () => {
    expect(msToTicks(WEAPON.RELOAD_MS)).toBe(60)
  })

  it('RQ-15: 리스폰 3000ms는 정확히 90틱이다', () => {
    expect(msToTicks(PLAYER.RESPAWN_MS)).toBe(90)
  })

  it('RQ-16: 스폰 보호 3000ms는 정확히 90틱이다', () => {
    expect(msToTicks(PLAYER.SPAWN_PROTECTION_MS)).toBe(90)
  })

  it('RQ-43: AFK 타임아웃 300000ms는 정확히 9000틱이다', () => {
    expect(msToTicks(PLAYER.AFK_TIMEOUT_MS)).toBe(9000)
  })
})
