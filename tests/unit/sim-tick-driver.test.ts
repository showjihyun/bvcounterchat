import { describe, expect, it, vi } from 'vitest'
import { createClock, msToTicks } from '@shared/sim/clock'
import { createScheduler } from '@shared/sim/scheduler'
import { createTickDriver } from '@shared/sim/tickDriver'
import { NET } from '@shared/constants'

/**
 * 고정 스텝 누적기(fixed-step accumulator) — RQ-60(30Hz 고정 틱) 결정론 계층.
 *
 * RQ-60 전문: "서버는 30Hz 고정 틱으로 시뮬레이션을 진행해야 한다."
 * 매핑된 골든 케이스 GA-14: "...부하 유무와 무관하게 시뮬레이션 스텝 수는
 * 고정 틱레이트를 따른다(가변 프레임레이트로 시뮬레이션이 흔들리지 않는다)."
 *
 * **레벨 분리 (오케스트레이터 지시)**: GA-14의 then은 두 계층으로 나눠
 * 검증한다. 이 파일이 **A. 결정론 단위 테스트** — "부하 유무와 무관하게
 * 스텝 수 고정"의 실체인 고정 스텝 누적기 로직을 실 타이머·실 경과 없이
 * `advanceByElapsed(elapsedMs)`에 임의 값을 직접 주입해 검증한다.
 * **B. 실 서버 루프의 관대한 통합 테스트**는
 * `tests/integration/rq-60-fixed-tickrate.test.ts`가 맡는다 — GA-14의
 * "평균 33.3ms" 정밀 검증은 이 파일(A)의 책임이고, 통합 테스트는 실 루프가
 * 이 드라이버로 30Hz 근방으로 구동되는지만 관대하게(±50%) 확인한다.
 *
 * **가정(coder에게 — 원장 17e 계약에 없는 신규 모듈이라 test-writer가 지정)**:
 * `src/shared/sim/tickDriver.ts`에 `createTickDriver(clock, scheduler)`를
 * 두고, 그 반환값이 `advanceByElapsed(elapsedMs): number`(전진한 틱 수를
 * 반환)를 제공한다고 가정한다. `clock`은 `@shared/sim/clock`의
 * `MutableTickClock`, `scheduler`는 `@shared/sim/scheduler`의
 * `TickScheduler`다 — 기존 하네스 계약(원장 17e)의 인터페이스를 그대로
 * 재사용하고, 이 모듈은 그 위에 "실 경과 시간(ms) → 정수 틱 수" 환산을
 * 얹는 얇은 어댑터다(실 서버 30Hz 루프가 프레임마다 이 함수를 호출할 것으로
 * 가정 — `tests/integration/rq-60-fixed-tickrate.test.ts` 참고). 다른
 * 모듈 경로·시그니처를 택한다면 이 파일의 import 한 줄만 조정하면 된다.
 *
 * **왜 정확한 수치가 중요한가(단순 왕복 테스트가 아니다)**: "경과 ms → 틱 수"
 * 환산을 "틱마다 누적기에서 `NET.TICK_MS`를 반복해서 빼는" 순진한 뺄셈
 * 누적으로 구현하면, `NET.TICK_MS`(=1000/30)가 부동소수점이라 뺄셈이
 * 반복될수록 오차가 쌓인다 — 실측 확인 결과(2026-07-22) 100ms 입력을 순진한
 * 뺄셈 누적으로 계산하면 3틱이 아니라 2틱이, 1000ms는 30틱이 아니라 29틱이
 * 나온다. 반대로 "총 경과 ms 대비 있어야 할 총 틱 수를 매번 처음부터 다시
 * 계산"하는 방식은 이 오차가 없다. 아래 100ms→3틱·1000ms→30틱 단언은 임의로
 * 고른 값이 아니라 이 드리프트 버그를 직접 잡아내도록 고른 값이다 — "그럴듯
 * 하게 통과"하는 구현과 실제로 옳은 구현을 이 테스트가 구분한다.
 *
 * **결정론 메모**: 이 파일은 실시간 타이머를 전혀 쓰지 않는다 —
 * `advanceByElapsed`가 "경과 시간"을 인자로 직접 받는 순수 함수형 API이므로
 * fake timer조차 필요 없다. 실 경과 시간을 실제로 측정하는 서버 루프는
 * `src/server`에 위치할 것으로 가정하며(ADR-0008: 실시간 API 직접 호출 금지
 * lint는 `src/shared`에만 적용된다), 그 결합은 B 계층(통합 테스트)이 검증한다.
 *
 * **인자 검증 범위**: `elapsedMs`는 실측 경과 시간(본질적으로 소수일 수
 * 있는 실수)이므로 `MutableTickClock.advance(n)`과 달리 정수를 요구하지
 * 않는다 — 음수·NaN만 던지는 대상으로 삼는다(오케스트레이터 지시 원문).
 */
describe('TickDriver — 고정 스텝 누적기 (RQ-60, GA-14)', () => {
  it('RQ-60/GA-14: NET.TICK_MS만큼 경과하면 정확히 1틱 전진한다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const driver = createTickDriver(clock, scheduler)

    const advanced = driver.advanceByElapsed(NET.TICK_MS)

    expect(advanced).toBe(1)
    expect(clock.tick).toBe(1)
  })

  it('RQ-60/GA-14: 100ms 경과하면 3틱 전진하고 나머지는 다음 호출로 이월된다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const driver = createTickDriver(clock, scheduler)

    const advanced = driver.advanceByElapsed(100)

    expect(advanced).toBe(3)
    expect(clock.tick).toBe(3)
  })

  it(
    'RQ-60/GA-14: 10ms씩 10회로 쪼개 호출해도(합계 100ms) 한 번에 100ms를 넘긴 것과 같은 3틱이 나온다 ' +
      '— 쪼개기 무관(하네스 §4 전진 단위 불변식과 동일 정신)',
    () => {
      const clock = createClock()
      const scheduler = createScheduler(clock)
      const driver = createTickDriver(clock, scheduler)

      let total = 0
      for (let i = 0; i < 10; i += 1) {
        total += driver.advanceByElapsed(10)
      }

      expect(total).toBe(3)
      expect(clock.tick).toBe(3)
    },
  )

  it('RQ-60/GA-14: 오래 정지했다가(1000ms) 한 번에 따라잡아도 30틱을 유실 없이 전진한다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const driver = createTickDriver(clock, scheduler)

    const advanced = driver.advanceByElapsed(1000)

    expect(advanced).toBe(30)
    expect(clock.tick).toBe(30)
  })

  it('RQ-60/GA-14: 경과 시간이 0이면 0틱 전진한다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const driver = createTickDriver(clock, scheduler)

    const advanced = driver.advanceByElapsed(0)

    expect(advanced).toBe(0)
    expect(clock.tick).toBe(0)
  })

  it('RQ-60: advanceByElapsed의 인자가 음수·NaN이면 던진다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const driver = createTickDriver(clock, scheduler)

    expect(() => driver.advanceByElapsed(-1)).toThrow()
    expect(() => driver.advanceByElapsed(NaN)).toThrow()
  })

  it('RQ-60: 잘못된 인자에 대한 에러는 RangeError 또는 TypeError다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const driver = createTickDriver(clock, scheduler)
    const captureError = (fn: () => void): unknown => {
      try {
        fn()
        return undefined
      } catch (e) {
        return e
      }
    }

    const negativeError = captureError(() => driver.advanceByElapsed(-1))
    const nanError = captureError(() => driver.advanceByElapsed(NaN))

    expect(negativeError instanceof RangeError || negativeError instanceof TypeError).toBe(true)
    expect(nanError instanceof RangeError || nanError instanceof TypeError).toBe(true)
  })

  it(
    'RQ-60/GA-14: NET.TICK_MS를 3000회 누적해도 부동소수점 드리프트 없이 총 틱 수가 msToTicks 기대와 일치한다',
    () => {
      const clock = createClock()
      const scheduler = createScheduler(clock)
      const driver = createTickDriver(clock, scheduler)

      let total = 0
      for (let i = 0; i < 3000; i += 1) {
        total += driver.advanceByElapsed(NET.TICK_MS)
      }

      expect(total).toBe(msToTicks(3000 * NET.TICK_MS))
      expect(clock.tick).toBe(total)
    },
  )

  it(
    'RQ-60: 여러 틱 분량이 한 번에 경과해도 scheduler.advanceTo가 틱마다 개별 호출된다 ' +
      '(한꺼번에 최종 틱으로 건너뛰지 않는다)',
    () => {
      const clock = createClock()
      const scheduler = createScheduler(clock)
      const driver = createTickDriver(clock, scheduler)
      const advanceToSpy = vi.spyOn(scheduler, 'advanceTo')

      const advanced = driver.advanceByElapsed(100) // 위 테스트에서 3틱으로 확인됨

      expect(advanced).toBe(3)
      expect(advanceToSpy.mock.calls).toEqual([[1], [2], [3]])
    },
  )

  it(
    'RQ-60: 콜백이 관측하는 clock.tick은 벌크 전진 후의 최종 틱이 아니라 자신의 마감 틱과 같다 ' +
      '(하네스 §4 전진 단위 불변식·PR #4 회귀와 동일 정신)',
    () => {
      const clock = createClock()
      const scheduler = createScheduler(clock)
      const driver = createTickDriver(clock, scheduler)
      const observedTicks: number[] = []
      scheduler.scheduleAt(1, () => observedTicks.push(clock.tick))
      scheduler.scheduleAt(3, () => observedTicks.push(clock.tick))

      driver.advanceByElapsed(100) // 3틱 분량 — scheduleAt(3)까지 전부 만료

      expect(observedTicks).toEqual([1, 3])
      expect(clock.tick).toBe(3)
    },
  )
})
