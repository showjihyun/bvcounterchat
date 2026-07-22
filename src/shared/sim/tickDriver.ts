/**
 * RQ-60(30Hz 고정 틱) — 실 경과 시간(ms)을 정수 틱으로 환산해
 * `MutableTickClock`·`TickScheduler`(원장 17e 계약, `./clock`·`./scheduler`)
 * 를 전진시키는 얇은 어댑터. 원장 17e 계약에는 없는 신규 모듈이라
 * test-writer가 이 shape(`createTickDriver(clock, scheduler)` →
 * `{ advanceByElapsed(elapsedMs): number }`)을 지정했다
 * (`tests/unit/sim-tick-driver.test.ts` 상단 코멘트·
 * `_workspace/RQ-60/01_test-writer_red.md` 참고).
 *
 * **드리프트 방지가 이 모듈의 핵심이다.** "틱마다 누적기에서 `NET.TICK_MS`를
 * 반복해서 빼는" 순진한 뺄셈 누적은 `NET.TICK_MS`(=1000/30, 부동소수점)의
 * 오차가 반복될수록 쌓여 100ms 입력에 2틱, 1000ms 입력에 29틱을 내고,
 * 1000ms를 여러 조각으로 쪼개 넣으면 결과가 달라진다(결정론 붕괴, 실측
 * 확인은 위 Red 보고서 참고). 그래서 이 모듈은 매 호출마다 "총 경과 ms 대비
 * 있어야 할 총 틱 수"를 처음부터 다시 계산한다 — 누적 뺄셈이 아니라 누적
 * 나눗셈이다. `DRIFT_EPSILON_MS`는 그 나눗셈 자체가 부동소수점이라 정확히
 * 정수 배수인 입력(예: `NET.TICK_MS`를 그대로 다시 넣는 경우)에서 결과가
 * 한 틱 모자라게 내림되는 것을 막는 안전 여유다.
 *
 * **전진 단위 불변식 (`harness/sim/README.md` §4와 동일 정신)**: 여러 틱
 * 분량이 한 번에 경과해도 절대 벌크로 건너뛰지 않는다 — 틱마다
 * `clock.advance(1)` 후 `scheduler.advanceTo(clock.tick)`을 개별 호출해야
 * 콜백이 관측하는 `clock.tick`이 자신의 마감 틱과 같다(벌크 전진 후의 최종
 * 틱이 아니라).
 *
 * `src/shared` 환경 중립·결정론 제약(ADR-0008/0010): 이 모듈은 "경과
 * 시간"을 인자로 받을 뿐 시간을 직접 재지 않는다 — 실 시간 측정(`Date.now`
 * 등)은 `src/server`의 구동 루프 책임이다.
 */

import type { MutableTickClock } from './clock'
import type { TickScheduler } from './scheduler'
import { NET } from '@shared/constants'

export interface TickDriver {
  /**
   * `elapsedMs`만큼 경과했다고 알린다. 있어야 할 틱까지 하나씩 개별
   * 전진시키고, 이번 호출로 전진한 틱 수를 반환한다. 나머지(다음 틱까지
   * 못 미친 잔여 ms)는 내부 누적치에 남아 다음 호출로 이월된다.
   */
  advanceByElapsed(elapsedMs: number): number
}

/**
 * 정수 배수 경과(예: `NET.TICK_MS` 그대로)가 부동소수점 나눗셈 오차로
 * 한 틱 모자라게 내림되는 것을 막는 여유. 스펙 상수가 아니라 부동소수점
 * 안전 여유이므로 `@shared/constants`가 아니라 여기 둔다(스케줄러의
 * `DEFAULT_MAX_CALLBACKS_PER_ADVANCE`와 같은 성격).
 */
const DRIFT_EPSILON_MS = 1e-9

function assertValidElapsed(elapsedMs: number): void {
  if (Number.isNaN(elapsedMs)) {
    throw new TypeError(`advanceByElapsed(elapsedMs)의 elapsedMs는 NaN을 받을 수 없다 (받은 값: ${elapsedMs})`)
  }
  if (elapsedMs < 0) {
    throw new RangeError(`advanceByElapsed(elapsedMs)의 elapsedMs는 음수를 받을 수 없다 (받은 값: ${elapsedMs})`)
  }
}

export function createTickDriver(clock: MutableTickClock, scheduler: TickScheduler): TickDriver {
  // 총 경과 ms 누적치 — 여기서 뺄셈으로 소모하지 않는다(그게 드리프트의
  // 원인이다). targetTick은 매번 이 누적치 전체에서 새로 계산한다.
  let accumulatedMs = 0

  function advanceByElapsed(elapsedMs: number): number {
    assertValidElapsed(elapsedMs)
    accumulatedMs += elapsedMs
    const targetTick = Math.floor(accumulatedMs / NET.TICK_MS + DRIFT_EPSILON_MS)

    let advanced = 0
    while (clock.tick < targetTick) {
      clock.advance(1)
      scheduler.advanceTo(clock.tick)
      advanced += 1
    }
    return advanced
  }

  return { advanceByElapsed }
}
