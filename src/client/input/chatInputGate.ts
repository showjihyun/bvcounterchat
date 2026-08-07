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

/**
 * 채팅 포커스 중일 때 이동 입력 대신 쓰는 무입력 값.
 *
 * **REV(RQ-40 v2.3, 2026-08-07, GA-69) — `mode`도 중립화한다.** 원래 이
 * 자리는 "`mode`는 계약이 규정하지 않는다(방향이 0이면 어떤 `mode`든 이동
 * 산술 결과는 정지 — test-writer §3.2, 과잉 사양 회피)"였고 호출자가 넘긴
 * `input.mode`를 그대로 통과시켰다. **그 전제가 RQ-92 v2.2로 거짓이
 * 됐다** — `mode`는 더 이상 이동 산술에만 쓰이는 값이 아니다. 서버가
 * `mode==='crouch'`를 관측하면 `hitboxForMode`(`@shared/sim/combat`)로
 * 눈높이·히트박스를 즉시 낮춘다(RQ-92 v2.2) — 방향·점프가 0(무입력)이어도
 * `mode`만으로 서버가 판정하는 자세가 바뀐다. 게이트하지 않으면 채팅 중
 * 크라우치 수식키(Ctrl)를 누른 채 타이핑하는 것만으로 서버에서 실제로
 * 앉는다(evaluator F7 실증). RQ-40 원문이 "'이동 입력'에는 방향·점프뿐
 * 아니라 자세(`mode`)도 포함된다"로 개정돼(v2.3) 이 gap을 직접 막았다 —
 * `mode`도 `'run'`(중립값)으로 치환한다(GA-69).
 */
export function gateMoveInput(chatFocused: boolean, input: MoveInput): MoveInput {
  if (!chatFocused) return input
  return { ...input, dirX: 0, dirZ: 0, mode: 'run', jump: false }
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
   * 항상 전송은 하되(정지 상태를 서버에 알려야 함), 값만 게이트한다.
   *
   * **실제로 전송한 값을 반환한다**(PR #61 리뷰 blocker). 게이트를 통과한 뒤의
   * 입력이 필요한 소비처가 서버 전송 말고도 있다 — 크로스헤어 확산(RQ-54)이
   * 그렇다. 반환하지 않으면 호출자가 게이트 이전의 원시 입력을 쓰게 되고,
   * 실제로 그렇게 됐다: 채팅창에 "wasd"를 치는 동안 화면의 크로스헤어만 이동
   * tier로 벌어지고 서버가 보는 입력은 0이었다. 호출자가 `gateMoveInput`을
   * 다시 부르게 하는 것은 **분산 체크의 부활**이라(fe.md "개별 핸들러마다 분산
   * 체크하지 않는다", 원장 23a M4) 이 choke point가 결과를 내주는 쪽이 옳다. */
  sendMoveInput(input: MoveInput): MoveInput
  /** 채팅 포커스 중이면 아예 `'fire'` 메시지를 보내지 않는다
   * (`gateFireIntent`). `rttMs`(RQ-64 랙 보상, 평가 F1 대응 —
   * `_workspace/RQ-64/03_evaluator_report.md`)는 사수의 RTT 추정값
   * (`@client/net/rttEstimator`, `connection.getRttMs()`)을 그대로 받아
   * payload에 병합해 보낸다 — 이 함수는 값을 만들지 않고 전달만 한다. */
  fire(direction: AimDirection, rttMs: number): void
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
    sendMoveInput(input: MoveInput): MoveInput {
      const gated = gateMoveInput(isChatFocused(), input)
      connection.sendMoveInput(gated)
      return gated
    },
    fire(direction: AimDirection, rttMs: number): void {
      if (!gateFireIntent(isChatFocused(), true)) return
      connection.room.send('fire', { ...direction, rttMs })
    },
  }
}
