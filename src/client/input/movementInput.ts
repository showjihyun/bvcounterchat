import type { MoveInput } from '@shared/sim/movement'
import { KEYMAP } from '@client/input/keymap'

/**
 * 키보드 상태 → `MoveInput` 변환(DOM 이벤트 리스너 — `harness/workflow
 * /fe.md` 렌더 계층 면제 대상: 테스트 없음, tsc·lint·빌드·수동 확인이
 * 게이트다).
 *
 * 카메라 회전을 반영하지 않는 월드축 방향이다 — 조준·시점 회전(look)은
 * 이 RQ의 스코프 밖이다(team-lead 지시 — RQ-62는 이동 입력 전송+포인터
 * 락 배선까지, 사격·HUD는 후속).
 *
 * 점프는 엣지 트리거다(`@shared/sim/movement`의 `MoveInput.jump` 주석 —
 * "이번 틱의 점프 시도"). 키를 누르고 있어도 `getMoveInput()` 호출 1회에만
 * `jump: true`를 반환하고 즉시 소비한다 — 그렇지 않으면 착지 직후 키를
 * 계속 누르고 있는 것만으로 자동 연속 점프(버니합류 입력)가 발생한다.
 */
export interface MovementInputTracker {
  getMoveInput(): MoveInput
  dispose(): void
}

/** 리스너를 붙일 대상(테스트 시 대체 가능하도록 매개변수화 — 기본값
 * `window`). 이 파일 자체는 렌더 게이트 대상이라 단위 테스트를 요구하지
 * 않지만, 구조적으로 결합을 낮춰 둔다. */
export function createMovementInputTracker(target: Window = window): MovementInputTracker {
  const pressed = new Set<string>()
  let jumpPending = false

  function onKeyDown(event: KeyboardEvent): void {
    pressed.add(event.code)
    if (event.code === KEYMAP.jump) {
      jumpPending = true
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    pressed.delete(event.code)
  }

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)

  return {
    getMoveInput(): MoveInput {
      const forward = pressed.has(KEYMAP.moveForward) ? 1 : 0
      const backward = pressed.has(KEYMAP.moveBackward) ? 1 : 0
      const left = pressed.has(KEYMAP.moveLeft) ? 1 : 0
      const right = pressed.has(KEYMAP.moveRight) ? 1 : 0

      const jump = jumpPending
      jumpPending = false

      return {
        dirX: right - left,
        dirZ: forward - backward,
        mode: pressed.has(KEYMAP.crouch) ? 'crouch' : pressed.has(KEYMAP.walk) ? 'walk' : 'run',
        jump,
      }
    },
    dispose(): void {
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
    },
  }
}
