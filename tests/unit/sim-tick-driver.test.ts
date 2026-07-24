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

  // 20a-1 개정(2026-07-24, 사용자 승인): catch-up clamp(`harness/sim/README.md`
  // §5, RQ-60 v1.1) 도입으로 한 호출의 전진 상한(기본 15틱)이 생겨, 예전처럼
  // "1000ms를 한 번의 호출로 따라잡으면 30틱"은 더 이상 성립하지 않는다 —
  // 계약이 명시적으로 바뀐 데 따른 정당한 개정이며 테스트 약화가 아니다
  // (`_workspace/20a-1/01_test-writer_red.md` 참고). "정지 후 유실 없이
  // 따라잡는다"는 원 의도는 그대로 유지하되, 단언을 "여러 호출 합산"으로
  // 바꿨다. 1000ms는 정확히 30틱 밀림이라 `maxBacklogTicks`(기본 30)와
  // 정확히 같다 — 계약상 "넘으면"(==는 제외)만 버리므로 이 경계는 정상
  // 캐치업 대상이다(버려지지 않는다).
  it(
    'RQ-60/GA-14: 오래 정지했다가(1000ms=정확히 maxBacklogTicks) 여러 호출에 걸쳐 따라잡아도 30틱을 유실 없이 전진한다 ' +
      '(20a-1 개정: clamp 도입으로 "한 번에"였던 원 단언을 "여러 호출 합산"으로 개정 — 유실 없음 의도는 그대로)',
    () => {
      const clock = createClock()
      const scheduler = createScheduler(clock)
      const driver = createTickDriver(clock, scheduler)

      const firstCall = driver.advanceByElapsed(1000) // 30틱 밀림 — maxBacklogTicks와 정확히 같아(==) 버려지지 않는다

      expect(firstCall).toBe(15) // 기본 maxTicksPerAdvance 상한

      let total = firstCall
      let guard = 0
      while (total < 30 && guard < 10) {
        total += driver.advanceByElapsed(0)
        guard += 1
      }

      expect(total).toBe(30) // 여러 호출 합산은 유실 없이 30 — 원 테스트의 의도(무손실 캐치업) 유지
      expect(clock.tick).toBe(30)
    },
  )

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

/**
 * catch-up clamp(하이브리드) — 원장 20a-1, `harness/sim/README.md` §5
 * "catch-up clamp" 항목, RQ-60 v1.1 개정.
 *
 * `TickDriverOptions { maxTicksPerAdvance?=15, maxBacklogTicks?=30, onOverflow? }`.
 * 위 describe 블록의 10건은 **그대로 둔다** — 이 블록만 추가한다.
 *
 * **틱 수 계산은 `msToTicks`(올림, 스케줄러 마감시한용)가 아니라 tickDriver
 * 자신의 내부 산식(`Math.floor(accumulatedMs / TICK_MS + DRIFT_EPSILON_MS)`,
 * `src/shared/sim/tickDriver.ts` 참고)을 그대로 따른다** — "경과 ms 대비
 * 완료된 틱 수"는 내림이 맞다(올림은 스케줄러의 "마감 이후" 의미론 전용).
 * 그래서 990ms는 29틱(990/33.333=29.7→내림 29), 200ms는 6틱, 5000ms는
 * 150틱, 1000ms는 30틱이다 — 기존 describe 블록의 100ms→3틱·1000ms→30틱
 * 단언과 같은 산식이다.
 *
 * **시나리오 3(밀림 상한 초과) 해석 — 채택 근거 명시**: 계약 문면
 * "긴 정지 후 **빨리감기 없이** 그 구간만 유실한다"를 "초과분(상한을 넘는
 * 부분)만 즉시 이 호출에서 캐치업하고 나머지는 남긴다"로 읽으면, 남는
 * maxBacklogTicks(30)를 이 호출 안에서 그대로 소화해야 다음 호출이 정확히
 * 1틱만 전진한다는 계약의 구체 예시("다음 33.33ms 경과에서 정확히 1틱")와
 * 충돌한다 — 그 즉시-소화 자체가 "빨리감기"이기 때문이다. 유일하게 두
 * 요구를 동시에 만족하는 해석은 **"상한을 넘는 순간 그 호출에서 계산된
 * 밀림 전체(초과분 포함 전량)를 버리고 0틱 전진, clock은 그대로, 다음
 * 호출부터 백로그 0에서 재출발"**이다. 이 파일은 이 해석으로 단언한다.
 * **스펙 확정 반영(v1.1, 2026-07-24)**: 계약 문면의 "초과분"이라는 단어가
 * "전량"과 다르게 읽힐 수 있다는 점을 당시 스펙 질문으로 별도 보고했고,
 * 사용자 결정으로 이 "전량 버림" 해석이 그대로 채택돼 RQ-60 v1.1 개정
 * (`harness/specs/requirements.md`)에 명문화됐다 — 더 이상 열린 질문이
 * 아니다.
 *
 * **결정론 메모**: 모든 호출은 `advanceByElapsed(elapsedMs)`에 리터럴 ms를
 * 직접 주입한다 — 실 타이머 없음. "여러 호출에 걸쳐 따라잡기"는 `while`
 * 루프로 표현하되, 구현이 잘못돼 수렴하지 않는 경우까지 대비해 `guard`
 * 상한(10회, 기본 clamp 15/30 조합상 실제로는 최대 2회면 충분하므로
 * 넉넉한 여유)을 둬 무한 루프 대신 단언 실패로 죽게 한다.
 */
describe('TickDriver — catch-up clamp (20a-1, RQ-60 v1.1, harness/sim/README.md §5)', () => {
  it('20a-1 항목1: 한 호출은 maxTicksPerAdvance까지만 전진하고, 남은 밀림은 다음 호출로 이월된다(스텝 유실 없음)', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const driver = createTickDriver(clock, scheduler, { maxTicksPerAdvance: 4 })

    const firstCall = driver.advanceByElapsed(200) // 6틱 밀림, 한 호출 상한 4

    expect(firstCall).toBe(4)
    expect(clock.tick).toBe(4)

    const secondCall = driver.advanceByElapsed(0) // 추가 경과 없이 이월된 2틱만 소화

    expect(secondCall).toBe(2)
    expect(clock.tick).toBe(6)
  })

  it('20a-1 항목2: 이월 정확성 — 한 호출 상한이 있어도 여러 호출에 걸친 총 틱 수는 clamp 없는 기대치(200ms→6틱)와 같다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const driver = createTickDriver(clock, scheduler, { maxTicksPerAdvance: 4 })

    let total = driver.advanceByElapsed(200)
    expect(total).toBeLessThanOrEqual(4) // 첫 호출 자체는 clamp되어 전체(6)를 넘지 않아야 한다

    let guard = 0
    while (total < 6 && guard < 10) {
      total += driver.advanceByElapsed(0)
      guard += 1
    }

    expect(total).toBe(6) // 여러 호출 합산은 clamp 없는 기대치와 같다 — 스텝 유실 없음
    expect(clock.tick).toBe(6)
  })

  it(
    '20a-1 항목3: 밀림이 maxBacklogTicks(기본 30틱)를 넘으면(5000ms→150틱) 이번 호출은 0틱 전진하고 ' +
      'onOverflow가 버린 틱 수와 함께 호출되며, 재정렬 이후 다음 호출은 정확히 1틱(NET.TICK_MS 경과)만 전진한다',
    () => {
      const clock = createClock()
      const scheduler = createScheduler(clock)
      const onOverflow = vi.fn()
      const driver = createTickDriver(clock, scheduler, { onOverflow })

      const overflowCall = driver.advanceByElapsed(5000) // 150틱 밀림 — 상한(30) 초과

      expect(overflowCall).toBe(0) // 빨리감기 없이 그 구간만 유실 — 이번 호출은 전진하지 않는다
      expect(clock.tick).toBe(0)
      expect(onOverflow).toHaveBeenCalledTimes(1)
      expect(onOverflow).toHaveBeenCalledWith(150) // 버린 틱 수(해석 채택 근거는 위 블록 코멘트 참고)

      const nextCall = driver.advanceByElapsed(NET.TICK_MS) // 재정렬 이후 정확히 1틱분 경과

      expect(nextCall).toBe(1)
      expect(clock.tick).toBe(1)
    },
  )

  it('20a-1 항목4: 버림 이후에도 드리프트 없이 기본 산술(100ms→3틱)이 유지된다 — 버림이 누적기 상태를 오염시키지 않는다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const onOverflow = vi.fn()
    const driver = createTickDriver(clock, scheduler, { onOverflow })

    driver.advanceByElapsed(5000) // 150틱 밀림 — 전량 버려지고 clock.tick=0으로 재정렬

    const advanced = driver.advanceByElapsed(100) // 재정렬 이후 신규 100ms 경과

    expect(advanced).toBe(3)
    expect(clock.tick).toBe(3) // 버림 이전 누적치가 오염되지 않았다면 0+3
  })

  it('20a-1 항목5: 밀림이 상한 미만(990ms→29틱)이면 clamp를 지키며 여러 호출에 걸쳐 전부 따라잡고 onOverflow가 불리지 않는다', () => {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const onOverflow = vi.fn()
    const driver = createTickDriver(clock, scheduler, { onOverflow })

    let total = driver.advanceByElapsed(990) // 29틱 밀림 (990/33.333=29.7 → 내림 29, 상한 30 미만)
    expect(total).toBeLessThanOrEqual(15) // 기본 maxTicksPerAdvance 상한 준수

    let guard = 0
    while (total < 29 && guard < 10) {
      total += driver.advanceByElapsed(0)
      guard += 1
    }

    expect(total).toBe(29)
    expect(clock.tick).toBe(29)
    expect(onOverflow).not.toHaveBeenCalled()
  })

  it(
    '20a-1 항목5 경계값: 밀림이 정확히 maxBacklogTicks(1000ms→30틱)이면 상한을 "넘은" 것이 아니므로 ' +
      '버려지지 않고 여러 호출에 걸쳐 전부 따라잡는다 (v1.1이 "==는 정상 캐치업"을 명문화 — 확정된 계약 근거)',
    () => {
      const clock = createClock()
      const scheduler = createScheduler(clock)
      const onOverflow = vi.fn()
      const driver = createTickDriver(clock, scheduler, { onOverflow })

      let total = driver.advanceByElapsed(1000) // 정확히 30틱 밀림 (경계값)
      expect(total).toBeLessThanOrEqual(15)

      let guard = 0
      while (total < 30 && guard < 10) {
        total += driver.advanceByElapsed(0)
        guard += 1
      }

      expect(total).toBe(30)
      expect(clock.tick).toBe(30)
      expect(onOverflow).not.toHaveBeenCalled()
    },
  )

  it(
    '20a-1 항목6: maxTicksPerAdvance·maxBacklogTicks에 0·음수·비정수·NaN을 주면 던진다 ' +
      '(하네스 §1 원칙과 동일 — 조용한 보정 금지)',
    () => {
      const clock = createClock()
      const scheduler = createScheduler(clock)
      const invalidValues = [0, -1, 1.5, NaN]

      for (const bad of invalidValues) {
        expect(() => createTickDriver(clock, scheduler, { maxTicksPerAdvance: bad })).toThrow()
        expect(() => createTickDriver(clock, scheduler, { maxBacklogTicks: bad })).toThrow()
      }
    },
  )
})
