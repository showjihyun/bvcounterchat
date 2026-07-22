/**
 * 결정론 시뮬레이션 하네스 — 테스트 지원 조립체 (원장 17e 계약 §4).
 *
 * clock·rng·scheduler를 하나로 묶는다. `advanceTicks`가 시계 전진과
 * 스케줄러 만료 콜백 실행을 한 호출로 묶는 이유: 둘을 따로 호출하게
 * 두면 반드시 누가 잊는다 — 그러면 "시계는 갔는데 타이머는 안 울린" 테스트가
 * 조용히 거짓 신호를 낸다.
 *
 * `advanceTicks(n)`은 **틱 단위 루프**로 돈다 — `clock.advance(n)`을 한 번에
 * 부르고 `scheduler.advanceTo(clock.tick)`를 1회만 호출하면, 마감 틱 3에
 * 걸린 콜백이 실행되는 시점에 이미 `clock.tick`이 목표 틱(예: 10)이 되어
 * 있다. 서버는 시계를 1틱씩 옮기고 그때마다 `advanceTo`를 부르므로(`scheduler.ts`
 * 상단 불변식), 벌크 전진과 틱별 전진은 콜백이 보는 시각과 콜백이 연쇄
 * 예약하는 마감시한이 달라진다 — 하네스가 서버 동작을 보장하지 못하게 되는
 * 결정론 버그다(PR #4 리뷰 blocker).
 */

import { createClock, msToTicks, type MutableTickClock } from '@shared/sim/clock'
import { createRng, type SeededRng } from '@shared/sim/rng'
import { createScheduler, type TickScheduler } from '@shared/sim/scheduler'

// scheduler.ts와 별개로 유지한다(중복은 원장 17e-1로 이월된 별도 이슈,
// 이번 blocker 수정 범위 밖).
function assertNonNegativeInteger(n: number, label: string): void {
  if (!Number.isInteger(n)) {
    throw new TypeError(`${label}은 정수만 받는다 (받은 값: ${n})`)
  }
  if (n < 0) {
    throw new RangeError(`${label}은 음수를 받을 수 없다 (받은 값: ${n})`)
  }
}

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
    // 인자 검증은 루프 앞에서 한다 — 아니면 n=-1은 루프를 0회 돌고 조용히
    // 통과하고, n=1.5는 반올림 없이 소수점 비교로 실제 2틱을 전진시켜 버린다.
    assertNonNegativeInteger(n, 'advanceTicks(n)의 n')
    scheduler.advanceTo(clock.tick) // n=0이어도 밀린 만료는 비운다 — 기존 동작 보존
    for (let i = 0; i < n; i++) {
      clock.advance(1)
      scheduler.advanceTo(clock.tick)
    }
  }

  function advanceMs(ms: number): void {
    advanceTicks(msToTicks(ms))
  }

  return { clock, rng, scheduler, advanceTicks, advanceMs }
}
