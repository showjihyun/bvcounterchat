import { describe, expect, it, vi } from 'vitest'
import { createClock } from '@shared/sim/clock'
import { createScheduler, type TickScheduler } from '@shared/sim/scheduler'
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
 *
 * **연쇄 폭주 상한** (계약 §3 「연쇄 폭주 상한」, PR #4 재평가에서 evaluator가
 * 실증): 콜백이 `scheduleIn(0)`으로 자기 자신을 재예약하면 마감이 항상
 * "현재 틱"이라 같은 `advanceTo` 호출 안에서 끝없이 pop된다. `advanceTo`는
 * 서버 30Hz 틱 경로(RQ-60)이므로 상한이 없으면 서버가 그 틱에서 영원히
 * 멈춘다 — 상한은 이 조용한 정지를 원인이 특정되는 `RangeError`로 바꾼다.
 * `createScheduler(clock, options)`의 2번째 인자(`SchedulerOptions`)로
 * 조정 가능하며(기본 100,000), `d18c11e`에서 구현됐다.
 *
 * 아래 `installRunawayCallback`은 재예약 콜백이 자체 호출 횟수를 세다가
 * `safetyLimit`을 넘으면 스스로 별도 에러를 던지는 **회귀 방어 장치**다 —
 * 상한이 나중에 실수로 사라지거나 우회되면(예: 옵션이 무시되도록 리팩터링돼
 * 회귀하면), 이 테스트가 진짜 무한 루프(단일 스레드 동기 루프라 vitest의
 * `testTimeout`으로도 못 끊는다)에 빠지는 대신 이 안전판이 먼저 걸려
 * hang 대신 fail로 끝난다. `safetyLimit`은 테스트 cap(100)의 5배(500)로
 * 잡아, 상한이 정상 동작할 때는 진짜 `RangeError`가 이 안전판보다 훨씬
 * 먼저(약 100회 근방) 던져지도록 여유를 뒀다.
 *
 * (이력: 이 테스트를 처음 작성한 Red 단계에서는 `SchedulerOptions`가 계약에만
 * 있고 구현에는 없어, 아래 `createScheduler(clock, { maxCallbacksPerAdvance })`
 * 호출이 `npx tsc --noEmit`에서 TS2554로 실패했고, vitest 런타임에서는 2번째
 * 인자가 조용히 무시돼 상한 없이 재예약이 그대로 실행되다 이 안전판이 실제로
 * 발동해 `AggregateError`로 실패했다. `d18c11e`로 구현된 뒤에는 tsc가 통과하고
 * 진짜 `RangeError`가 던져진다 — 아래 안전판은 지우지 않고 회귀 방어로 남겼다.)
 */
function installRunawayCallback(scheduler: TickScheduler, safetyLimit: number): void {
  let callCount = 0
  function reschedule(): void {
    callCount++
    if (callCount > safetyLimit) {
      throw new Error(
        `[테스트 안전판] 연쇄 폭주 상한이 걸리지 않아 ${safetyLimit}회를 넘어 계속 재예약됐다 — 상한 로직이 없거나 회귀로 우회됐을 가능성이 있다`,
      )
    }
    scheduler.scheduleIn(0, reschedule)
  }
  scheduler.scheduleIn(0, reschedule)
}

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

  it(
    '연쇄 폭주 상한: scheduleIn(0)으로 자기를 재예약하는 콜백은 advanceTo가 무한 루프 대신 RangeError를 던진다',
    () => {
      const clock = createClock()
      const cap = 100
      // SchedulerOptions는 d18c11e에서 구현되어 이 2번째 인자가 실제로
      // 적용된다(기본 100,000, 여기서는 검증을 빠르게 하려고 cap으로 축소).
      // 파일 상단 주석 참고 — 최초 Red 단계에서는 미구현이라 tsc가 TS2554를 냈었다.
      const scheduler = createScheduler(clock, { maxCallbacksPerAdvance: cap })
      installRunawayCallback(scheduler, cap * 5)

      expect(() => scheduler.advanceTo(clock.tick)).toThrow(RangeError)
    },
    2000,
  )

  it(
    '연쇄 폭주 에러 메시지는 원인을 특정한다 — 상한값과 재예약 진단을 담는다',
    () => {
      const clock = createClock()
      const cap = 100
      // SchedulerOptions는 이미 구현되어 있다(파일 상단 주석 참고).
      const scheduler = createScheduler(clock, { maxCallbacksPerAdvance: cap })
      installRunawayCallback(scheduler, cap * 5)

      let thrown: unknown
      try {
        scheduler.advanceTo(clock.tick)
      } catch (e) {
        thrown = e
      }

      expect(thrown).toBeInstanceOf(RangeError)
      // 정확한 문구가 아니라 원인 추적에 필요한 키워드만 확인한다 — 메시지
      // 전체를 하드코딩해 비교하면 사소한 표현 변경에도 테스트가 깨진다.
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      expect(message).toContain(String(cap))
      expect(message).toMatch(/연쇄 폭주/)
      expect(message).toMatch(/재예약/)
    },
    2000,
  )

  it(
    '연쇄 폭주 상한 미만의 정상적인 유한 연쇄 예약은 상한에 걸리지 않고 전부 실행된다',
    () => {
      const clock = createClock()
      // SchedulerOptions는 이미 구현되어 있다(파일 상단 주석 참고).
      const scheduler = createScheduler(clock, { maxCallbacksPerAdvance: 100 })
      const CHAIN_LENGTH = 20
      const executed: number[] = []

      function chainNext(step: number): void {
        executed.push(step)
        if (step < CHAIN_LENGTH) {
          scheduler.scheduleAt(step + 1, () => chainNext(step + 1))
        }
      }
      scheduler.scheduleAt(1, () => chainNext(1))

      // 상한(100)보다 한참 적은 20단계 연쇄이므로, 상한이 실제로 구현된
      // 뒤에도 이 테스트는 계속 통과해야 한다 — 상한이 정상 동작까지
      // 깨뜨리지 않는지 확인하는 보험성 회귀 테스트다.
      expect(() => scheduler.advanceTo(CHAIN_LENGTH)).not.toThrow()
      expect(executed).toEqual(Array.from({ length: CHAIN_LENGTH }, (_, i) => i + 1))
    },
    2000,
  )
})
