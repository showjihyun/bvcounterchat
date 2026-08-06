/**
 * 고정 키 바인딩(`harness/workflow/fe.md` "키 바인딩 소스" — 재바인딩 UI는
 * 스펙에 없다. 사용자 설정 가능한 리바인딩이 필요해지면 별도 RQ·ADR 대상).
 *
 * `KeyboardEvent.code`(물리적 키 위치, 키보드 레이아웃 무관) 값을 쓴다 —
 * `event.key`는 Shift 등 조합에 따라 값이 바뀌어 이동처럼 지속적으로 눌림
 * 상태를 추적해야 하는 입력에 부적합하다.
 *
 * 앉기(crouch)·천천히 걷기(walk, RQ-92 "조용한 이동")·달리기(run 기본값)
 * 배정은 스펙이 정하지 않은 구현 선택값이다 — Half-Life/Source 계열 FPS의
 * 관례(Shift=walk, Ctrl=crouch)를 따랐다. `movementInput.ts`는 둘 다 눌리면
 * crouch를 우선한다(임의 선택 — 스펙 미기재).
 *
 * **액션 하나에 코드 여럿**(원장 24m). 이동 4방향은 WASD와 **방향키를 함께**
 * 받는다 — 사용자 요구이고, 스펙이 키 바인딩을 정하지 않으므로(실측:
 * `requirements.md`·`docs/req/` 전체에 `WASD`·`방향키` 언급 0건) 구현 선택값
 * 범위 안이다. Source 계열도 방향키를 기본 대체 바인딩으로 둔다.
 *
 * ⚠️ 배열이지 문자열이 아니다 — 소비처(`movementInput.ts`)는 **포함 여부**로
 * 판정해야 하고, `===` 비교로 되돌리면 첫 코드만 동작하면서 타입은 통과한다.
 */
export const KEYMAP = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBackward: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft'],
  walk: ['ShiftLeft'],
} as const satisfies Record<string, readonly string[]>
