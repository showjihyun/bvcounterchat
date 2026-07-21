/**
 * 결정론 시뮬레이션 하네스 — 틱 시계 (원장 17e 계약 §1).
 *
 * 시간의 정본은 틱(정수)이다. `NET.TICK_MS`(1000/30 = 33.333…ms)는
 * 부동소수점이라 ms를 누적하면 오차가 쌓인다 — 그래서 내부 상태는 tick
 * 정수만 보관하고, timeMs는 매번 tick에서 새로 계산한다. ms는 API 경계
 * (스펙 상수·표시)에서만 등장한다.
 */

import { NET } from '@shared/constants'

export interface TickClock {
  /** 현재 틱 (정수, 0부터). 시간의 정본. */
  readonly tick: number
  /** 현재 시각(ms). tick에서 유도된 값 — 저장하지 않고 계산한다. */
  readonly timeMs: number
}

export interface MutableTickClock extends TickClock {
  /** n틱 전진 (기본 1). n은 0 이상의 정수. */
  advance(n?: number): void
}

/** 틱을 ms로 환산. */
export function ticksToMs(ticks: number): number {
  return ticks * NET.TICK_MS
}

/** ms를 틱으로 환산. 올림(ceil) — 마감시한은 "그 시각 이후"에 만료돼야 한다. */
export function msToTicks(ms: number): number {
  return Math.ceil(ms / NET.TICK_MS)
}

function assertNonNegativeInteger(n: number, label: string): void {
  if (!Number.isInteger(n)) {
    throw new TypeError(`${label}은 정수만 받는다 (받은 값: ${n})`)
  }
  if (n < 0) {
    throw new RangeError(`${label}은 음수를 받을 수 없다 (받은 값: ${n})`)
  }
}

export function createClock(startTick = 0): MutableTickClock {
  let tick = startTick

  return {
    get tick() {
      return tick
    },
    get timeMs() {
      return ticksToMs(tick)
    },
    advance(n = 1) {
      assertNonNegativeInteger(n, 'advance(n)의 n')
      tick += n
    },
  }
}
