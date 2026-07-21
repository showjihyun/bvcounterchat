/**
 * 결정론 시뮬레이션 하네스 — 틱 스케줄러 (원장 17e 계약 §3).
 *
 * `setTimeout`을 대체하는 틱 기반 마감시한 큐. `advanceTo`가 콜백 실행의
 * 유일한 지점이다 — `scheduleAt`/`scheduleIn`은 마감시한을 등록할 뿐 절대
 * 즉시 실행하지 않는다. 그래야 "언제 실행됐는가"가 오직 틱으로 결정된다.
 *
 * 마감시한별로 이진 최소 힙을 쓴다 — 서버는 이 `advanceTo`를 매 틱(RQ-60,
 * 33ms 예산) 호출하므로, 대기 중인 예약 수에 비례해 매번 선형 탐색하는
 * 구현은 틱 경로에 O(n²) 패턴을 심는 것과 같다. 힙은 다음 마감시한 조회·
 * 추가가 O(log n)이라 이를 피한다.
 *
 * **불변식**: `advanceTo`는 시계를 옮긴 직후 틱마다 1회 호출한다. 여러
 * 틱을 한 번에 넘기면(예: `advanceTo(clock.tick + 10)`을 한 번만 호출)
 * 콜백이 보는 시각이 자신의 마감 틱이 아니게 되어, 콜백 안에서 연쇄
 * 예약(`scheduleIn`)한 마감시한이 실제 전진 단위에 종속된다 — 즉 같은
 * 시뮬레이션이 "몇 틱씩 건너뛰었는지"에 따라 다른 결과를 낸다. 이는
 * 결정론 자체를 무너뜨리므로 `advanceTo`의 호출자(서버 30Hz 루프,
 * `tests/support/harness.ts`)는 반드시 이 규율을 지켜야 한다.
 */

import { msToTicks, type TickClock } from './clock'

export type TimerHandle = number

export interface TickScheduler {
  /** delayMs 후 실행 예약. 내부적으로 틱 마감시한으로 환산(올림). */
  scheduleIn(delayMs: number, callback: () => void): TimerHandle
  /** 특정 틱에 실행 예약. */
  scheduleAt(tick: number, callback: () => void): TimerHandle
  /** 예약 취소. 이미 실행됐거나 없는 handle이면 false. */
  cancel(handle: TimerHandle): boolean
  /** targetTick까지(포함) 만료된 콜백을 전부 실행. */
  advanceTo(targetTick: number): void
  /** 대기 중인 예약 수. */
  readonly pending: number
}

interface Timer {
  handle: TimerHandle
  deadlineTick: number
  callback: () => void
}

/**
 * (deadlineTick, handle) 오름차순 최소 힙.
 * handle은 예약 순서대로 증가하므로, 같은 틱에 여러 콜백이 걸리면
 * 이 순서가 자연히 "예약한 순서대로"를 보장하는 동점 기준이 된다.
 */
class TimerHeap {
  private readonly items: Timer[] = []

  get size(): number {
    return this.items.length
  }

  peek(): Timer | undefined {
    return this.items[0]
  }

  push(timer: Timer): void {
    this.items.push(timer)
    this.bubbleUp(this.items.length - 1)
  }

  pop(): Timer | undefined {
    const top = this.items[0]
    const last = this.items.pop()
    if (top === undefined) return undefined
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last
      this.bubbleDown(0)
    }
    return top
  }

  remove(handle: TimerHandle): boolean {
    const index = this.items.findIndex((t) => t.handle === handle)
    if (index === -1) return false
    const last = this.items.pop()
    if (index < this.items.length && last !== undefined) {
      this.items[index] = last
      this.bubbleDown(index)
      this.bubbleUp(index)
    }
    return true
  }

  private isBefore(a: Timer, b: Timer): boolean {
    return a.deadlineTick !== b.deadlineTick ? a.deadlineTick < b.deadlineTick : a.handle < b.handle
  }

  private bubbleUp(startIndex: number): void {
    let index = startIndex
    while (index > 0) {
      const parentIndex = (index - 1) >> 1
      const current = this.items[index]
      const parent = this.items[parentIndex]
      if (current === undefined || parent === undefined || !this.isBefore(current, parent)) break
      this.items[index] = parent
      this.items[parentIndex] = current
      index = parentIndex
    }
  }

  private bubbleDown(startIndex: number): void {
    let index = startIndex
    const size = this.items.length
    for (;;) {
      const left = index * 2 + 1
      const right = index * 2 + 2
      let smallest = index
      if (left < size && this.isBefore(this.items[left]!, this.items[smallest]!)) smallest = left
      if (right < size && this.isBefore(this.items[right]!, this.items[smallest]!)) smallest = right
      if (smallest === index) break
      const current = this.items[index]!
      this.items[index] = this.items[smallest]!
      this.items[smallest] = current
      index = smallest
    }
  }
}

function assertNonNegativeInteger(n: number, label: string): void {
  if (!Number.isInteger(n)) {
    throw new TypeError(`${label}은 정수만 받는다 (받은 값: ${n})`)
  }
  if (n < 0) {
    throw new RangeError(`${label}은 음수를 받을 수 없다 (받은 값: ${n})`)
  }
}

export function createScheduler(clock: TickClock): TickScheduler {
  const heap = new TimerHeap()
  let nextHandle = 1

  function scheduleAt(tick: number, callback: () => void): TimerHandle {
    assertNonNegativeInteger(tick, 'scheduleAt의 tick')
    const handle = nextHandle++
    heap.push({ handle, deadlineTick: tick, callback })
    return handle
  }

  function scheduleIn(delayMs: number, callback: () => void): TimerHandle {
    assertNonNegativeInteger(delayMs, 'scheduleIn의 delayMs')
    return scheduleAt(clock.tick + msToTicks(delayMs), callback)
  }

  function cancel(handle: TimerHandle): boolean {
    return heap.remove(handle)
  }

  function advanceTo(targetTick: number): void {
    const errors: unknown[] = []

    for (;;) {
      const next = heap.peek()
      if (next === undefined || next.deadlineTick > targetTick) break
      heap.pop()
      try {
        next.callback()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length}개의 스케줄러 콜백이 예외를 던졌다`)
    }
  }

  return {
    scheduleIn,
    scheduleAt,
    cancel,
    advanceTo,
    get pending() {
      return heap.size
    },
  }
}
