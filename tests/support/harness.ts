/**
 * 결정론 시뮬레이션 하네스 — 테스트 지원 조립체 (원장 17e 계약 §4).
 *
 * clock·rng·scheduler를 하나로 묶는다. `advanceTicks`가 시계 전진과
 * 스케줄러 만료 콜백 실행을 한 호출로 묶는 이유: 둘을 따로 호출하게
 * 두면 반드시 누가 잊는다 — 그러면 "시계는 갔는데 타이머는 안 울린" 테스트가
 * 조용히 거짓 신호를 낸다.
 */

import { createClock, msToTicks, type MutableTickClock } from '@shared/sim/clock'
import { createRng, type SeededRng } from '@shared/sim/rng'
import { createScheduler, type TickScheduler } from '@shared/sim/scheduler'

export interface SimHarness {
  clock: MutableTickClock
  rng: SeededRng
  scheduler: TickScheduler
  /** n틱 전진 — 시계를 옮기고 스케줄러를 그 틱까지 몰아준다. */
  advanceTicks(n: number): void
  /** ms만큼 전진 (올림으로 틱 환산). */
  advanceMs(ms: number): void
}

/** seed 미지정 시 쓰는 고정 기본값 — 테스트가 실행마다 달라지면 안 된다. */
const DEFAULT_SEED = 42

export function createSimHarness(options?: { seed?: number }): SimHarness {
  const clock = createClock()
  const rng = createRng(options?.seed ?? DEFAULT_SEED)
  const scheduler = createScheduler(clock)

  function advanceTicks(n: number): void {
    clock.advance(n)
    scheduler.advanceTo(clock.tick)
  }

  function advanceMs(ms: number): void {
    advanceTicks(msToTicks(ms))
  }

  return { clock, rng, scheduler, advanceTicks, advanceMs }
}
