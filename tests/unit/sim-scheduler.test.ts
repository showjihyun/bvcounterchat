import { describe, expect, it, vi } from 'vitest'
import { createClock } from '@shared/sim/clock'
import { createScheduler } from '@shared/sim/scheduler'
import { WEAPON } from '@shared/constants'

/**
 * 결정론 시뮬레이션 하네스 — 틱 스케줄러 (원장 17e 계약 §3).
 *
 * `setTimeout`을 틱 기반 마감시한으로 대체한다. 조기 실행 금지·건너뛴 만료
 * 유실 금지·콜백 예외 격리가 이 스케줄러의 존재 이유이므로 세 가지 모두
 * 직접 검증한다.
 *
 * 이미 지난 마감시한(`scheduleAt`에 현재 틱 이하, `scheduleIn(0)`)은 오류가
 * 아니라 정상 사용이다 — 다만 예약 시점에 즉시 실행하지 않고 `advanceTo`가
 * 유일한 실행 지점이라는 규칙은 유지된다(계약 §3 보강).
 */
describe('TickScheduler (원장 17e §3)', () => {
  it('마감 틱 이전에는 콜백이 실행되지 않는다 (조기 실행 금지)', () => {
    const scheduler = createScheduler(createClock())
    let fired = false
    scheduler.scheduleAt(5, () => {
      fired = true
    })
    scheduler.advanceTo(4)
    expect(fired).toBe(false)
    scheduler.advanceTo(5)
    expect(fired).toBe(true)
  })

  it('scheduleAt에 현재 틱 이하(이미 지난 마감시한)를 넘겨도 예약 시점에는 던지지 않는다', () => {
    const clock = createClock()
    clock.advance(5)
    const scheduler = createScheduler(clock)
    expect(() => scheduler.scheduleAt(5, () => {})).not.toThrow() // 현재 틱과 동일
    expect(() => scheduler.scheduleAt(2, () => {})).not.toThrow() // 이미 지난 틱
    expect(() => scheduler.scheduleAt(0, () => {})).not.toThrow() // 훨씬 과거
  })

  it('scheduleIn(0)은 정상 사용이며 던지지 않는다 — "현재 틱 마감"을 의미한다', () => {
    const scheduler = createScheduler(createClock())
    expect(() => scheduler.scheduleIn(0, () => {})).not.toThrow()
  })

  it('이미 지난 마감시한 예약은 예약 시점에 즉시 실행되지 않고, 다음 advanceTo 호출에서 실행된다', () => {
    const clock = createClock()
    clock.advance(5)
    const scheduler = createScheduler(clock)
    let fired = false
    scheduler.scheduleAt(2, () => {
      fired = true
    }) // 이미 지난 틱(2 < 5) — advanceTo가 유일한 실행 지점이라는 규칙은 유지된다
    expect(fired).toBe(false)
    scheduler.advanceTo(5)
    expect(fired).toBe(true)
  })

  it('scheduleIn(0)으로 예약한 콜백도 예약 시점에는 실행되지 않고, 다음 advanceTo 호출에서 실행된다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    let fired = false
    scheduler.scheduleIn(0, () => {
      fired = true
    })
    expect(fired).toBe(false)
    scheduler.advanceTo(clock.tick)
    expect(fired).toBe(true)
  })

  it('scheduleAt(현재 틱)은 예약 시점 이후 첫 advanceTo(현재 틱) 호출에서 실행된다', () => {
    const clock = createClock()
    clock.advance(5)
    const scheduler = createScheduler(clock)
    let fired = false
    scheduler.scheduleAt(5, () => {
      fired = true
    })
    expect(fired).toBe(false)
    scheduler.advanceTo(5)
    expect(fired).toBe(true)
  })

  it('advanceTo가 여러 틱을 한 번에 건너뛰어도 그 사이 만료된 콜백을 전부, 마감 틱 순서대로 실행한다', () => {
    const scheduler = createScheduler(createClock())
    const order: number[] = []
    scheduler.scheduleAt(7, () => order.push(7))
    scheduler.scheduleAt(3, () => order.push(3))
    scheduler.scheduleAt(5, () => order.push(5))
    scheduler.advanceTo(10)
    expect(order).toEqual([3, 5, 7])
  })

  it('같은 틱에 여러 콜백이 있으면 예약한 순서대로 실행한다', () => {
    const scheduler = createScheduler(createClock())
    const order: number[] = []
    scheduler.scheduleAt(5, () => order.push(1))
    scheduler.scheduleAt(5, () => order.push(2))
    scheduler.scheduleAt(5, () => order.push(3))
    scheduler.advanceTo(5)
    expect(order).toEqual([1, 2, 3])
  })

  it('cancel된 예약은 실행되지 않는다', () => {
    const scheduler = createScheduler(createClock())
    let fired = false
    const handle = scheduler.scheduleAt(5, () => {
      fired = true
    })
    expect(scheduler.cancel(handle)).toBe(true)
    scheduler.advanceTo(10)
    expect(fired).toBe(false)
  })

  it('이미 실행됐거나 존재하지 않는 handle의 cancel은 false를 반환한다', () => {
    const scheduler = createScheduler(createClock())
    const handle = scheduler.scheduleAt(1, () => {})
    scheduler.advanceTo(1)
    expect(scheduler.cancel(handle)).toBe(false)
    expect(scheduler.cancel(999_999)).toBe(false)
  })

  it('콜백 안에서 새로 예약한 것이 같은 advanceTo 안에서 만료되면 그것도 실행된다 (연쇄 예약)', () => {
    const scheduler = createScheduler(createClock())
    const order: number[] = []
    scheduler.scheduleAt(3, () => {
      order.push(3)
      scheduler.scheduleAt(4, () => order.push(4))
    })
    scheduler.advanceTo(5)
    expect(order).toEqual([3, 4])
  })

  it('콜백 하나가 던져도 나머지 콜백은 계속 실행되고, 던진 에러는 advanceTo 종료 후 AggregateError로 다시 던져진다', () => {
    const scheduler = createScheduler(createClock())
    const ran: string[] = []
    scheduler.scheduleAt(1, () => {
      ran.push('a')
      throw new Error('boom-a')
    })
    scheduler.scheduleAt(1, () => ran.push('b'))
    scheduler.scheduleAt(2, () => {
      ran.push('c')
      throw new Error('boom-c')
    })

    let thrown: unknown
    try {
      scheduler.advanceTo(2)
    } catch (e) {
      thrown = e
    }

    expect(ran).toEqual(['a', 'b', 'c'])
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toHaveLength(2)
  })

  it('pending은 대기 중인 예약 수를 반영한다', () => {
    const scheduler = createScheduler(createClock())
    expect(scheduler.pending).toBe(0)

    const handle = scheduler.scheduleAt(5, () => {})
    scheduler.scheduleAt(6, () => {})
    expect(scheduler.pending).toBe(2)

    scheduler.cancel(handle)
    expect(scheduler.pending).toBe(1)

    scheduler.advanceTo(6)
    expect(scheduler.pending).toBe(0)
  })

  it('scheduleIn(delayMs)은 clock의 현재 틱을 기준으로 마감시한을 올림 환산한다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    let fired = false
    scheduler.scheduleIn(WEAPON.RELOAD_MS, () => {
      fired = true
    }) // 2000ms → 60틱 (RQ-11)
    scheduler.advanceTo(59)
    expect(fired).toBe(false)
    scheduler.advanceTo(60)
    expect(fired).toBe(true)
  })

  it('scheduleIn(delayMs)은 clock이 0이 아닌 틱에 있어도 그 시점 기준으로 계산한다', () => {
    const clock = createClock()
    clock.advance(10)
    const scheduler = createScheduler(clock)
    let fired = false
    scheduler.scheduleIn(WEAPON.RELOAD_MS, () => {
      fired = true
    }) // 10 + 60 = 70
    scheduler.advanceTo(69)
    expect(fired).toBe(false)
    scheduler.advanceTo(70)
    expect(fired).toBe(true)
  })

  it('scheduleAt의 tick이 음수·비정수·NaN이면 던진다', () => {
    const scheduler = createScheduler(createClock())
    expect(() => scheduler.scheduleAt(-1, () => {})).toThrow()
    expect(() => scheduler.scheduleAt(1.5, () => {})).toThrow()
    expect(() => scheduler.scheduleAt(NaN, () => {})).toThrow()
  })

  it('scheduleIn의 delayMs가 음수·비정수·NaN이면 던진다', () => {
    const scheduler = createScheduler(createClock())
    expect(() => scheduler.scheduleIn(-1, () => {})).toThrow()
    expect(() => scheduler.scheduleIn(1.5, () => {})).toThrow()
    expect(() => scheduler.scheduleIn(NaN, () => {})).toThrow()
  })

  it('scheduleAt·scheduleIn의 잘못된 인자에 대한 에러는 RangeError 또는 TypeError다', () => {
    const scheduler = createScheduler(createClock())
    const captureError = (fn: () => void): unknown => {
      try {
        fn()
        return undefined
      } catch (e) {
        return e
      }
    }

    const atError = captureError(() => scheduler.scheduleAt(-1, () => {}))
    const inError = captureError(() => scheduler.scheduleIn(-1, () => {}))

    expect(atError instanceof RangeError || atError instanceof TypeError).toBe(true)
    expect(inError instanceof RangeError || inError instanceof TypeError).toBe(true)
  })

  it('setTimeout을 쓰지 않는다', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const scheduler = createScheduler(createClock())
    scheduler.scheduleIn(100, () => {})
    scheduler.scheduleAt(5, () => {})
    scheduler.advanceTo(10)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
