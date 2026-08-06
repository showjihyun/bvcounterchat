import type { MoveInput } from '@shared/sim/movement'
import { KEYMAP } from '@client/input/keymap'

/**
 * 키보드 상태 → `MoveInput` 변환(DOM 이벤트 리스너).
 *
 * ⚠️ **렌더 계층 면제 대상이 아니다**(원장 24m). ADR-0008 §6이 면제한 것은
 * 렌더링(R3F)·WebGL·씬 그래프이고 DOM 키 리스너는 거기 없다. 리스너 대상을
 * 인자로 받으므로(`target: Window = window`) 브라우저 없이 단위 테스트된다 —
 * `tests/unit/24m-movement-keys.test.ts`.
 *
 * 카메라 회전을 반영하지 않는 월드축 방향이다 — 조준·시점 회전(look)은
 * 이 RQ의 스코프 밖이다(team-lead 지시 — RQ-62는 이동 입력 전송+포인터
 * 락 배선까지, 사격·HUD는 후속).
 *
 * 점프는 엣지 트리거다(`@shared/sim/movement`의 `MoveInput.jump` 주석 —
 * "이번 틱의 점프 시도"). `getMoveInput()`은 `jumpPending`을 **호출 1회에만**
 * `jump: true`로 반환하고 즉시 소비한다 — **`keydown` 1회당 전송 1회**가
 * 이 소비의 의도이며, 그러지 않으면 착지 직후 키를 계속 누르고 있는 것만으로
 * 자동 연속 점프(버니합류 입력)가 발생한다.
 *
 * ⚠️ **그 의도는 지금 달성되지 않는다 — `onKeyDown`에 `event.repeat` 가드가
 * 없다**(`src` 전체 참조 0건). 브라우저는 키를 누르고 있으면 OS 반복 지연 뒤
 * `keydown`을 **반복 발생**시키므로 `jumpPending`이 계속 재무장되고, 30Hz
 * 전송 루프(`PlayerControls.tsx`)가 그것을 싣는다. 따라서 **"키를 누르고
 * 있어도 1회만 보낸다"는 거짓이다** — 이 문장이 원래 그렇게 적혀 있었고,
 * 서버 주석·테스트 docblock 세 곳이 이 파일을 근거로 지목하며 같은 거짓을
 * 옮겼다(PR #41 평가 F-A → 델타 리뷰 major → 2차 델타 minor 4).
 *
 * 가드를 넣을지는 **게임 감각 변경이라 스펙 결정**이며 원장 **22f-3**에
 * 이월돼 있다(수동 스모크 포함). 자동 반복 자체는 **브라우저 실측 전**이고
 * 근거는 코드 참조 검색 + DOM 표준뿐이다.
 */
export interface MovementInputTracker {
  getMoveInput(): MoveInput
  dispose(): void
}

/** 리스너를 붙일 대상 — 기본값 `window`. 매개변수화한 덕에
 * `tests/unit/24m-movement-keys.test.ts`가 가짜 대상으로 이 함수를 직접
 * 시험한다(원장 24m). */
export function createMovementInputTracker(target: Window = window): MovementInputTracker {
  const pressed = new Set<string>()
  let jumpPending = false

  /** 액션에 배정된 코드 중 **하나라도** 눌려 있는가(원장 24m — 액션당 복수
   * 코드). `pressed.has(KEYMAP.moveForward)`처럼 배열을 그대로 넘기는 형태로
   * 되돌리면 **타입 오류가 나서 빌드가 깨진다**(실측) — 조용히 틀리지 않는다. */
  function isDown(codes: readonly string[]): boolean {
    return codes.some((code) => pressed.has(code))
  }

  function onKeyDown(event: KeyboardEvent): void {
    pressed.add(event.code)
    // 리터럴 튜플을 `readonly string[]`으로 **넓히기만** 한다 — `as never`는
    // 인자 검사를 통째로 꺼서 나중에 엉뚱한 값을 넣어도 통과한다(리뷰 minor).
    if ((KEYMAP.jump as readonly string[]).includes(event.code)) {
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
      const forward = isDown(KEYMAP.moveForward) ? 1 : 0
      const backward = isDown(KEYMAP.moveBackward) ? 1 : 0
      const left = isDown(KEYMAP.moveLeft) ? 1 : 0
      const right = isDown(KEYMAP.moveRight) ? 1 : 0

      const jump = jumpPending
      jumpPending = false

      return {
        dirX: right - left,
        dirZ: forward - backward,
        mode: isDown(KEYMAP.crouch) ? 'crouch' : isDown(KEYMAP.walk) ? 'walk' : 'run',
        jump,
      }
    },
    dispose(): void {
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
    },
  }
}
