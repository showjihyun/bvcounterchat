import { accumulateLook, type LookAngles } from '@client/input/aimMath'
import { MOUSE_SENSITIVITY_RAD_PER_PX } from '@client/config/look-tuning'

/**
 * 포인터 락 중 마우스 이동 → yaw/pitch 누적 배선(22b, `harness/workflow
 * /fe.md` 입력 처리 규칙). 순수 누적 산술은 `@client/input/aimMath`의
 * `accumulateLook`에 위임한다 — 이 모듈은 DOM 이벤트 리스너 배선만 한다
 * (렌더 계층 면제 대상 — 테스트 없음, tsc·lint·빌드·수동 확인이 게이트다.
 * `pointerLock.ts`·`movementInput.ts`와 동일한 분리 패턴: 순수 로직은
 * 별도 모듈, DOM 결합은 이 파일).
 *
 * 포인터 락이 걸려 있지 않을 때(`document.pointerLockElement !== canvas`)
 * 발생하는 mousemove는 무시한다 — 락 해제 상태의 일반 마우스 이동이
 * 시점을 돌리면 안 된다(예: 브라우저 밖 다른 창으로 마우스가 나갔다 온
 * 경우, ESC로 락 해제 후 UI 조작 중인 경우).
 */
export interface MouseLookController {
  getAngles(): LookAngles
  dispose(): void
}

export function createMouseLookController(canvas: HTMLCanvasElement, doc: Document = document): MouseLookController {
  let angles: LookAngles = { yaw: 0, pitch: 0 }

  function onMouseMove(event: MouseEvent): void {
    if (doc.pointerLockElement !== canvas) return
    angles = accumulateLook(angles, event.movementX, event.movementY, MOUSE_SENSITIVITY_RAD_PER_PX)
  }

  doc.addEventListener('mousemove', onMouseMove)

  return {
    getAngles(): LookAngles {
      return angles
    },
    dispose(): void {
      doc.removeEventListener('mousemove', onMouseMove)
    },
  }
}
