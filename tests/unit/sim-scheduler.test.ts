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
 *
 * `createScheduler(clock, options)`의 2번째 인자(`SchedulerOptions`)는
 * 계약에만 있고 아직 `src/shared/sim/scheduler.ts`에는 없다. 그래서 아래
 * 호출은 `npx tsc --noEmit`에서 인자 개수 불일치(TS2554)로 실패한다 —
 * 정당한 Red다. vitest는 esbuild로 타입 없이 트랜스파일하므로 런타임에는
 * 2번째 인자가 조용히 무시되고 `createScheduler(clock)`과 똑같이 동작한다
 * (상한이 전혀 걸리지 않는다). 그 상태로 재예약 시나리오를 그대로 실행하면
 * `advanceTo`가 **진짜 무한 루프**에 빠진다(단일 스레드 동기 루프라 vitest의
 * `testTimeout`으로도 못 끊는다) — 그래서 `installRunawayCallback`이 자체
 * 안전판(`safetyLimit`)을 두어, 상한이 아직 구현되지 않았을 때도 유한한
 * 횟수 안에서 (상한이 아닌 다른) 에러로 안전하게 멈추게 한다. Red가 hang이
 * 아니라 fail로 나오게 하는 장치다 — 상한이 구현되면 진짜 `RangeError`가
 * 이 안전판(테스트 cap의 5배)보다 훨씬 먼저 던져진다.
 */
function installRunawayCallback(scheduler: TickScheduler, safetyLimit: number): void {
  let callCount = 0
  function reschedule(): void {
    callCount++
    if (callCount > safetyLimit) {
      throw new Error(
        `[테스트 안전판] 상한이 아직 구현되지 않아 ${safetyLimit}회를 넘어 계속 재예약됐다`,
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
      // createScheduler의 2번째 인자(SchedulerOptions)는 계약에만 있고 아직
      // 구현에 없다 — 그래서 이 호출 자체가 tsc에서 인자 개수 불일치(TS2554)로
      // 실패한다. 그게 이 테스트가 증명하려는 Red이므로 그대로 둔다(우회하지 않는다).
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
      // 위와 같은 이유(SchedulerOptions 미구현)로 tsc에서 TS2554가 난다 — 의도한 Red다.
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
      // 위와 같은 이유(SchedulerOptions 미구현)로 tsc에서 TS2554가 난다 — 의도한 Red다.
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
