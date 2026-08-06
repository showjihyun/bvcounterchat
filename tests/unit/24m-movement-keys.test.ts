import { describe, expect, it } from 'vitest'
import { createMovementInputTracker } from '@client/input/movementInput'
import { KEYMAP } from '@client/input/keymap'

/**
 * 원장 24m — 이동 키 바인딩(WASD + 방향키).
 *
 * **왜 테스트가 가능한가**: `createMovementInputTracker`가 리스너 대상을 인자로
 * 받아(`target: Window = window`) 브라우저 없이 가짜 대상으로 부를 수 있다.
 * 이 파일은 렌더 계층이 아니라 **순수 입력 누적 로직**이라 ADR-0008 §6 면제
 * 대상이 아니다(ADR-0011 클라 모듈 test-after, `tests/` 순증).
 *
 * ⚠️ **기대값을 키 코드 리터럴로 적지 않는다**(ADR-0010) — `KEYMAP`에서 읽는다.
 * 리터럴로 적으면 바인딩을 바꿀 때 이 테스트가 "옛 배정을 지키는" 방향으로
 * 거짓 실패한다. 대신 **액션 단위의 명제**를 고정한다: 그 액션에 배정된
 * **어떤 코드로도** 같은 결과가 나와야 한다.
 */

interface FakeTarget {
  addEventListener(type: string, fn: (event: KeyboardEvent) => void): void
  removeEventListener(type: string, fn: (event: KeyboardEvent) => void): void
}

function createFakeWindow() {
  const listeners = new Map<string, Set<(event: KeyboardEvent) => void>>()
  const target: FakeTarget = {
    addEventListener(type, fn) {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
  }
  return {
    target: target as unknown as Window,
    press(code: string) {
      listeners.get('keydown')?.forEach((fn) => fn({ code } as KeyboardEvent))
    },
    release(code: string) {
      listeners.get('keyup')?.forEach((fn) => fn({ code } as KeyboardEvent))
    },
    listenerCount() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
    },
  }
}

describe('24m: 이동 키는 액션당 여러 코드를 받는다', () => {
  it('전진 액션의 모든 코드가 각각 dirZ=+1을 낸다 — WASD와 방향키가 동등하다', () => {
    for (const code of KEYMAP.moveForward) {
      const win = createFakeWindow()
      const tracker = createMovementInputTracker(win.target)
      win.press(code)
      expect(tracker.getMoveInput().dirZ, `code=${code}`).toBe(1)
      tracker.dispose()
    }
    // 배정이 실제로 둘 이상이어야 이 루프가 의미를 갖는다 — 하나로 줄면
    // 위 단언이 공허하게 통과하므로 여기서 막는다.
    expect(KEYMAP.moveForward.length).toBeGreaterThan(1)
  })

  it('네 방향 각각, 배정된 모든 코드가 같은 축·부호를 낸다', () => {
    const cases = [
      { codes: KEYMAP.moveForward, axis: 'dirZ', sign: 1 },
      { codes: KEYMAP.moveBackward, axis: 'dirZ', sign: -1 },
      { codes: KEYMAP.moveRight, axis: 'dirX', sign: 1 },
      { codes: KEYMAP.moveLeft, axis: 'dirX', sign: -1 },
    ] as const
    for (const { codes, axis, sign } of cases) {
      for (const code of codes) {
        const win = createFakeWindow()
        const tracker = createMovementInputTracker(win.target)
        win.press(code)
        expect(tracker.getMoveInput()[axis], `${axis} via ${code}`).toBe(sign)
        tracker.dispose()
      }
    }
  })

  it('같은 액션의 두 코드를 동시에 눌러도 1이다 — 중복 가산이 없다', () => {
    const win = createFakeWindow()
    const tracker = createMovementInputTracker(win.target)
    for (const code of KEYMAP.moveForward) win.press(code)
    expect(tracker.getMoveInput().dirZ).toBe(1)
    tracker.dispose()
  })

  it('반대 액션을 서로 다른 코드로 눌러도 상쇄된다 — W + ArrowDown = 0', () => {
    const win = createFakeWindow()
    const tracker = createMovementInputTracker(win.target)
    // 일부러 **다른 종류의 키**를 고른다 — 전진은 첫 배정(WASD), 후진은 마지막
    // 배정(방향키). 같은 종류끼리만 상쇄되는 구현이면 여기서 걸린다.
    const forwardCode = KEYMAP.moveForward[0]!
    const backwardCode = KEYMAP.moveBackward[KEYMAP.moveBackward.length - 1]!
    win.press(forwardCode)
    win.press(backwardCode)
    expect(tracker.getMoveInput().dirZ).toBe(0)
    tracker.dispose()
  })

  it('keyup은 그 코드만 해제한다 — 같은 액션의 다른 코드는 살아 있다', () => {
    const win = createFakeWindow()
    const tracker = createMovementInputTracker(win.target)
    const [first, second] = KEYMAP.moveForward
    win.press(first!)
    win.press(second!)
    win.release(first!)
    expect(tracker.getMoveInput().dirZ).toBe(1)
    win.release(second!)
    expect(tracker.getMoveInput().dirZ).toBe(0)
    tracker.dispose()
  })

  it('점프는 엣지 트리거다 — 한 번 읽으면 소진된다', () => {
    const win = createFakeWindow()
    const tracker = createMovementInputTracker(win.target)
    win.press(KEYMAP.jump[0])
    expect(tracker.getMoveInput().jump).toBe(true)
    expect(tracker.getMoveInput().jump).toBe(false)
    tracker.dispose()
  })

  it('방향키는 점프를 발생시키지 않는다 — 액션 배정이 새지 않는다', () => {
    const win = createFakeWindow()
    const tracker = createMovementInputTracker(win.target)
    for (const codes of [KEYMAP.moveForward, KEYMAP.moveBackward, KEYMAP.moveLeft, KEYMAP.moveRight]) {
      for (const code of codes) win.press(code)
    }
    expect(tracker.getMoveInput().jump).toBe(false)
    tracker.dispose()
  })

  it('mode는 crouch가 walk보다 우선한다 — 둘 다 눌린 경우', () => {
    const win = createFakeWindow()
    const tracker = createMovementInputTracker(win.target)
    expect(tracker.getMoveInput().mode).toBe('run')
    win.press(KEYMAP.walk[0])
    expect(tracker.getMoveInput().mode).toBe('walk')
    win.press(KEYMAP.crouch[0])
    expect(tracker.getMoveInput().mode).toBe('crouch')
    tracker.dispose()
  })

  it('dispose가 리스너를 전부 뗀다 — 언마운트 후 입력이 남지 않는다', () => {
    const win = createFakeWindow()
    const tracker = createMovementInputTracker(win.target)
    expect(win.listenerCount()).toBeGreaterThan(0)
    tracker.dispose()
    expect(win.listenerCount()).toBe(0)
  })
})
