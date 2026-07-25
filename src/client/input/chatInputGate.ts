import type { MoveInput } from '@shared/sim/movement'

/**
 * RQ-40 채팅 입력 차단 — 순수 게이트 로직(`_workspace/RQ-40/01_test-writer_
 * red.md` §3.2 계약, ADR-0011 test-after 영역이지만 이번 라운드 test-first).
 * `harness/workflow/fe.md` "입력 처리" 절 — "채팅 입력창이 포커스를 가지면
 * 이동·사격 키 입력을 게임 레이어로 전달하지 않는다... 입력 핸들러 최상단에서
 * 게이트한다." DOM 포커스 감지 자체는 이 파일의 책임이 아니다(렌더 계층 면제
 * 대상) — 배선 계층(`PlayerControls.tsx`)이 포커스 상태를 얻어 아래 두 순수
 * 함수를 핸들러 최상단에서 호출한다. `aimMath.ts`/`fireControl.ts`와 동일한
 * "DOM 결합부와 순수 함수를 파일로 분리한다" 위치·성격.
 */

/** 채팅 포커스 중일 때 이동 입력 대신 쓰는 무입력 값. `mode`는 계약이
 * 규정하지 않는다(방향이 0이면 어떤 `mode`든 이동 산술 결과는 정지 —
 * test-writer §3.2, 과잉 사양 회피) — 호출자가 넘긴 `input.mode`를 그대로
 * 보존한다. */
export function gateMoveInput(chatFocused: boolean, input: MoveInput): MoveInput {
  if (!chatFocused) return input
  return { ...input, dirX: 0, dirZ: 0, jump: false }
}

/** 채팅 포커스 중이면 사격 의도를 항상 false로 치환한다. */
export function gateFireIntent(chatFocused: boolean, wantsFire: boolean): boolean {
  if (chatFocused) return false
  return wantsFire
}
