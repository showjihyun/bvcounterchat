import type { MoveInput } from '@shared/sim/movement'
import type { AimDirection } from '@client/input/aimMath'

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

/**
 * `createChatGatedActions`가 실제로 쓰는 최소 구조적 타입 —
 * `GameConnection`(`@client/net/connection`) 전체가 아니라 여기서 호출하는
 * 두 멤버만 요구한다. 이 파일이 netcode 모듈을 몰라도 되게 하고(순수 입력
 * 계층 성격 유지), 가드 테스트가 실 Colyseus `Room`·WebSocket 없이 스텁
 * 객체(`{ sendMoveInput: vi.fn(), room: { send: vi.fn() } }`류)만으로
 * 호출을 검증할 수 있게 한다.
 */
export interface ChatGatedConnection {
  sendMoveInput(input: MoveInput): void
  room: { send(type: string, message?: unknown): void }
}

/** `createChatGatedActions`가 반환하는 게이트 적용된 전송 함수 묶음. */
export interface ChatGatedActions {
  /** 채팅 포커스 중이면 `gateMoveInput`으로 무입력 치환 후 전송한다 —
   * 항상 전송은 하되(정지 상태를 서버에 알려야 함), 값만 게이트한다. */
  sendMoveInput(input: MoveInput): void
  /** 채팅 포커스 중이면 아예 `'fire'` 메시지를 보내지 않는다
   * (`gateFireIntent`). */
  fire(direction: AimDirection): void
}

/**
 * RQ-40 입력 차단(리뷰 M4, `_workspace/review/feat-RQ-40-chat.md`) — 게임
 * 레이어로 나가는 두 출구(이동 전송·발사 전송)에 게이트를 적용하는
 * **단일 choke point**. 이전엔 `PlayerControls.tsx`의 발사 핸들러·이동
 * 전송 루프 각각에 `gateFireIntent`/`gateMoveInput` 호출이 복제돼 있었다
 * — fe.md "입력 핸들러 최상단에서 게이트한다, 개별 핸들러마다 분산
 * 체크하지 않는다"를 문면상으로는 지켰지만(각 핸들러 최상단에 있었다),
 * 호출 자체가 두 곳에 복제된 상태라 새 입력 경로(RQ-42 스프레이, RQ-10/11
 * 재장전 등)가 이 함수 호출을 빠뜨려도 어떤 테스트도 잡지 못했다 — 순수
 * 함수 단위 테스트는 `gateMoveInput`/`gateFireIntent` 자체만 검증하고
 * `PlayerControls.tsx`를 임포트하지 않기 때문이다.
 *
 * 해법은 22b `@client/input/cameraLook`의 `applyLookToCamera`와 동일한
 * 형태(복제가 아니라 공유) — 배선(`PlayerControls.tsx`)과 향후 가드
 * 테스트가 **같은 함수**를 호출해야, 배선이 이 함수 호출 자체를 빼먹는
 * 회귀를 테스트가 실제로 붙잡는다. `isChatFocused`를 콜백(값이 아니라
 * 함수)으로 받는 이유: `PlayerControls.tsx`가 매 호출 시점의 최신
 * `uiStore.getState().chatFocused`를 읽어야 하고(스냅샷 값을 한 번만
 * 캡처하면 이후 포커스 변화를 못 따라간다), 이 모듈은 `uiStore`의 구체
 * 타입을 몰라도 되게 한다(가드 테스트가 `() => true`/`() => false`만
 * 넘기면 되어 zustand store를 만들 필요가 없다).
 */
export function createChatGatedActions(
  isChatFocused: () => boolean,
  connection: ChatGatedConnection,
): ChatGatedActions {
  return {
    sendMoveInput(input: MoveInput): void {
      connection.sendMoveInput(gateMoveInput(isChatFocused(), input))
    },
    fire(direction: AimDirection): void {
      if (!gateFireIntent(isChatFocused(), true)) return
      connection.room.send('fire', direction)
    },
  }
}
