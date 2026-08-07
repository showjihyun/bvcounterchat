import { describe, expect, it, vi } from 'vitest'
import type { MoveInput } from '@shared/sim/movement'
import type { AimDirection } from '@client/input/aimMath'
import {
  createChatGatedActions,
  gateFireIntent,
  gateMoveInput,
  type ChatGatedConnection,
} from '@client/input/chatInputGate'
import { crosshairGapPx } from '@client/hud/crosshairSpread'
import { CROSSHAIR } from '@client/config/design-tokens'

/**
 * RQ-40 채팅 입력 차단 — 순수 로직 계약 단위 테스트.
 *
 * 골든 매핑 없음(`harness/evals/golden/track-a-product.jsonl`에 이 문면을
 * 다루는 GA 없음) — RQ-40 EARS 문면 근거로 진행한다: "채팅 입력 중에는
 * 이동·사격 입력이 게임에 전달되지 않아야 한다."
 * `harness/workflow/fe.md` "입력 처리" 절: "채팅 입력창이 포커스를 가지면
 * 이동·사격 키 입력을 게임 레이어로 전달하지 않는다. 포커스 상태를 game
 * state(또는 별도 UI 상태)에 두고 **입력 핸들러 최상단에서 게이트**한다 —
 * 개별 핸들러마다 분산 체크하지 않는다(누락 위험)."
 *
 * **범위(team-lead 지시, ADR-0011)**: 클라이언트 모듈은 원칙상 test-after가
 * 허용되지만(ADR-0011 결정 2), 이 계약은 이번 test-writer 라운드에 명시적으로
 * 포함됐다 — "채팅 포커스 상태에서 이동/발사 입력이 산출되지 않는다"는 DOM
 * 결합 없이 순수 함수로 표현 가능한 계약이기 때문이다. DOM 포커스 배선
 * 자체(어떤 `<input>` 엘리먼트가 포커스를 가졌는지 감지하는 리스너)는
 * 렌더 계층 면제 대상이라 이 파일이 다루지 않는다 — 그 배선은 아래 순수
 * 함수를 "핸들러 최상단"에서 호출하기만 하면 된다.
 *
 * **가정(coder에게 — 이 모듈은 아직 없다, test-writer가 계약을 정한다)**:
 * `src/client/input/chatInputGate.ts`(fe.md "DOM 결합부와 순수 함수를
 * 파일로 분리한다" 규칙 — `aimMath.ts`/`fireControl.ts`와 동일한 위치·성격)가
 * 아래 두 순수 함수를 노출한다고 가정한다.
 *
 *   export function gateMoveInput(chatFocused: boolean, input: MoveInput): MoveInput
 *   export function gateFireIntent(chatFocused: boolean, wantsFire: boolean): boolean
 *
 * `gateMoveInput`은 `chatFocused`가 true면 방향·점프가 전부 무입력이고
 * **`mode`도 `'run'`으로 중립화된** `MoveInput`을 반환하고(어떤 방향키·
 * 수식키를 누르고 있었든 무관), false면 `input`을 그대로(값 동일하게)
 * 반환한다. `gateFireIntent`는 동일한 정신으로 사격 의도(boolean)를
 * 게이트한다.
 *
 * **REV(RQ-40 v2.3, 2026-08-07, GA-69 신설) — `mode` 중립화 계약으로
 * 뒤집힘(team-lead 지시, 예외적 기존 계약 변경)**: 이 계약은 원래
 * "`mode` 필드의 정확한 값(무입력 상태에서 'run'인지 다른 값인지)은
 * 이 계약이 규정하지 않는다 — 방향이 0이면 어떤 `mode`든 이동 산술
 * (`@shared/sim/movement`)의 결과는 정지이므로, 이 필드 값에 결합하는
 * 것은 과잉 사양이다"였다. **그 근거가 RQ-92 v2.2로 거짓이 됐다** —
 * `mode`는 더 이상 이동 산술에만 쓰이는 값이 아니다. 서버가
 * `mode==='crouch'`를 관측하면 `hitboxForMode`(`@shared/sim/combat`)로
 * 눈높이·히트박스를 즉시 낮춘다(RQ-92 v2.2, GA-64~67) — 방향·점프가
 * 0(무입력)이어도 `mode`만으로 서버가 판정하는 자세가 바뀐다. 그 결과
 * 채팅 입력 중 크라우치 수식키(Ctrl)를 누른 채 타이핑하면 실제로
 * 서버에서 플레이어가 앉는 결함이 생겼다(evaluator F7 실증 —
 * `_workspace/RQ-92-crouch/03_evaluator_report.md`). RQ-40 원문이
 * "'이동 입력'에는 방향·점프뿐 아니라 자세(`mode`)도 포함된다 — 채팅을
 * 입력하는 동안 누른 수식키가 서버 판정에 반영되어서는 안 된다"로
 * 개정돼(v2.3, `requirements.md`) 이 gap을 직접 막았다 — **`mode`도
 * `'run'`(중립값)으로 치환해야 한다**는 것이 새 계약이다(GA-69,
 * `harness/evals/golden/track-a-product.jsonl`). 다음 사람이 왜
 * 뒤집혔는지 알 수 있도록 원래 문장을 위에 그대로 남긴다.
 *
 * **결정론**: DOM·타이머·네트워크 어디에도 의존하지 않는 순수 함수 호출
 * 뿐이다 — fake timer도 불필요하다.
 */

const FULL_INPUT: MoveInput = { dirX: 1, dirZ: -1, mode: 'crouch', jump: true }

describe('RQ-40 채팅 입력 차단 — gateMoveInput', () => {
  it('RQ-40: 채팅 포커스 중이면 이동 입력이 무입력(dirX·dirZ·jump 전부 0/false)으로 치환된다', () => {
    const gated = gateMoveInput(true, FULL_INPUT)
    expect(gated.dirX).toBe(0)
    expect(gated.dirZ).toBe(0)
    expect(gated.jump).toBe(false)
  })

  it('양성 대조군 — 채팅 포커스가 아니면 이동 입력이 값 그대로 전달된다(과잉 게이팅 방지)', () => {
    const gated = gateMoveInput(false, FULL_INPUT)
    expect(gated).toEqual(FULL_INPUT)
  })

  /**
   * RQ-40 v2.3/GA-69(evaluator F7 대응) — `mode`도 중립화 대상이다. 지금
   * 구현은 방향·점프만 지우고 `mode`는 원본을 그대로 통과시키므로 이
   * 테스트는 **실패해야 정상**이다(Red) — RQ-92 v2.2로 `mode==='crouch'`가
   * 서버 판정(눈높이·히트박스)에 직접 반영되게 되면서, 채팅 중 크라우치
   * 수식키를 누른 채 타이핑하면 서버에서 실제로 앉는 결함이 생겼다.
   */
  it("RQ-40 v2.3/GA-69: 채팅 포커스 중이면 mode도 'run'으로 중립화된다 — 방향·점프가 0이어도 mode만으로 서버 판정(눈높이·히트박스)이 바뀔 수 있다(RQ-92 v2.2)", () => {
    const gated = gateMoveInput(true, FULL_INPUT)
    expect(gated.mode).toBe('run')
  })
})

describe('RQ-40 채팅 입력 차단 — gateFireIntent', () => {
  it('RQ-40: 채팅 포커스 중이면 사격 의도가 항상 false로 치환된다', () => {
    expect(gateFireIntent(true, true)).toBe(false)
    expect(gateFireIntent(true, false)).toBe(false)
  })

  it('양성 대조군 — 채팅 포커스가 아니면 사격 의도가 값 그대로 전달된다(과잉 게이팅 방지)', () => {
    expect(gateFireIntent(false, true)).toBe(true)
    expect(gateFireIntent(false, false)).toBe(false)
  })
})

/**
 * RQ-40 리뷰 major M4 — **배선 가드**(`_workspace/review/feat-RQ-40-chat.md`).
 *
 * 위 두 describe는 `gateMoveInput`/`gateFireIntent` 자체만 검사한다 —
 * `PlayerControls.tsx`를 임포트하지 않으므로, 배선(그 두 함수를 실제로
 * 호출하는 코드)이 통째로 빠지거나 우회돼도 위 테스트는 계속 초록이다.
 * 22b `applyLookToCamera` 가드(`22b-aim-camera-binding.test.ts`)에서 이미
 * 겪은 문제(변이 6/6 생존)와 같은 구멍 — 그때의 해법(배선과 테스트가
 * **같은 함수**를 호출)을 여기도 그대로 적용한다.
 *
 * `PlayerControls.tsx`는 `createChatGatedActions(() => uiStore.getState()
 * .chatFocused, connection)`가 반환한 `gatedActions.sendMoveInput`/
 * `gatedActions.fire`만 호출한다(그 자체는 렌더 계층이라 면제 대상,
 * `PlayerControls.tsx` 모듈 코멘트 "RQ-40 M4" 참고). 이 테스트는 배선이
 * 아니라 `createChatGatedActions`가 만드는 **choke point 자체**의 계약을
 * 검사한다 — 배선이 이 함수를 호출하는 한(그 자체는 코드 정독·브라우저
 * 스모크가 게이트), choke point 내부가 계약을 지키는지는 여기서 실 회귀로
 * 잡힌다.
 *
 * **REV(RQ-64/F1, `_workspace/RQ-64/03_evaluator_report.md`) — `fire()`
 * 시그니처 확장**: 평가가 "클라이언트가 `rttMs`를 전혀 보내지 않는다"는
 * blocker를 지적했다 — 유일한 발사 송신 경로(`PlayerControls.tsx` →
 * `gatedActions.fire`)가 방향 3필드만 보냈기 때문이다. `fire(direction:
 * AimDirection): void`를 `fire(direction: AimDirection, rttMs: number):
 * void`로 확장하고, `connection.room.send('fire', { ...direction, rttMs
 * })`로 병합해 보낸다 — 아래 각 `it()`의 `gated.fire(...)` 호출과
 * `send` 단언을 이 새 시그니처에 맞춰 갱신했다(기존 단언의 검증 대상 —
 * "포커스 시 차단"·"비포커스 시 원본 그대로 전달"·"choke point 단일화"
 * — 는 그대로 유지하며, 페이로드에 `rttMs` 필드가 추가된 형태만 반영했다.
 * 단언을 약화한 곳은 없다 — `not.toHaveBeenCalled()`·`toHaveBeenCalledTimes`
 * 류의 호출 여부/횟수 단언은 페이로드 shape과 무관해 그대로다).
 */
function createConnectionStub(): { connection: ChatGatedConnection; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const connection: ChatGatedConnection = {
    sendMoveInput: vi.fn(),
    room: { send },
  }
  return { connection, send }
}

const RAW_INPUT: MoveInput = { dirX: 1, dirZ: -1, mode: 'crouch', jump: true }
const RAW_DIRECTION: AimDirection = { dirX: 0.6, dirY: 0, dirZ: 0.8 }
/** RQ-64/F1(`_workspace/RQ-64/03_evaluator_report.md`) — `fire()`가 RTT를
 * 함께 실어 보내도록 시그니처가 확장됐다(`fire(direction, rttMs)`). 이
 * 값 자체(RTT 추정)는 `@client/net/rttEstimator`의 책임이고, 이 파일은
 * 그 결과값을 그대로 전달하기만 하는지만 검사한다 — 임의의 리터럴로
 * 충분하다(가터가 값을 변형하지 않는지가 관심사). */
const RAW_RTT_MS = 42

describe('RQ-40 배선 가드 — createChatGatedActions(리뷰 M4, choke point 자체)', () => {
  it('채팅 포커스 중이면 sendMoveInput이 게이트된(무입력) 값으로 스텁에 전달된다', () => {
    const { connection } = createConnectionStub()
    const gated = createChatGatedActions(() => true, connection)

    gated.sendMoveInput(RAW_INPUT)

    expect(connection.sendMoveInput).toHaveBeenCalledTimes(1)
    const sent = (connection.sendMoveInput as ReturnType<typeof vi.fn>).mock.calls[0]![0] as MoveInput
    expect(sent.dirX).toBe(0)
    expect(sent.dirZ).toBe(0)
    expect(sent.jump).toBe(false)
  })

  /**
   * RQ-40 v2.3/GA-69(evaluator F7 대응) — **두 층 다 덮는다**는 지시:
   * 순수 함수(`gateMoveInput`) 하나만 고정하면 `createChatGatedActions`
   * 배선이 그 함수를 호출하지 않아도(또는 `mode`만 빠뜨려도) 위 순수
   * 함수 테스트는 여전히 초록이다 — 22b `applyLookToCamera` 가드가
   * 이미 겪은 것과 같은 구멍(이 파일 상단 "리뷰 major M4" 절). choke
   * point(`createChatGatedActions`)가 실제로 `sendMoveInput`에 실어
   * 보내는 값까지 관측해야 배선 누락을 잡는다. 지금 구현은 이 테스트가
   * **실패해야 정상**이다(Red).
   */
  it("RQ-40 v2.3/GA-69(서버까지 가는 경로): 채팅 포커스 중이면 sendMoveInput으로 전달되는 mode도 'run'이다", () => {
    const { connection } = createConnectionStub()
    const gated = createChatGatedActions(() => true, connection)

    gated.sendMoveInput(RAW_INPUT)

    const sent = (connection.sendMoveInput as ReturnType<typeof vi.fn>).mock.calls[0]![0] as MoveInput
    expect(sent.mode).toBe('run')
  })

  it('채팅 포커스 중이면 fire() 호출이 스텁 room.send까지 도달하지 않는다', () => {
    const { connection, send } = createConnectionStub()
    const gated = createChatGatedActions(() => true, connection)

    gated.fire(RAW_DIRECTION, RAW_RTT_MS)

    expect(send).not.toHaveBeenCalled()
  })

  it('양성 대조군 — 채팅 포커스가 아니면 sendMoveInput·fire 둘 다 원본 인자 그대로 스텁에 전달된다(RQ-64/F1: rttMs가 payload에 함께 실린다)', () => {
    const { connection, send } = createConnectionStub()
    const gated = createChatGatedActions(() => false, connection)

    gated.sendMoveInput(RAW_INPUT)
    gated.fire(RAW_DIRECTION, RAW_RTT_MS)

    expect(connection.sendMoveInput).toHaveBeenCalledWith(RAW_INPUT)
    expect(send).toHaveBeenCalledWith('fire', { ...RAW_DIRECTION, rttMs: RAW_RTT_MS })
  })

  it('포커스 상태는 생성 시점이 아니라 호출 시점마다 평가된다 — 토글이 다음 호출에 즉시 반영된다', () => {
    // `isChatFocused`를 값이 아니라 콜백으로 받는 이유(chatInputGate.ts
    // 모듈 코멘트) 그 자체를 검사한다 — 생성 시점에 스냅샷을 한 번만 읽고
    // 고정하는 회귀(예: `const focused = isChatFocused()`로 캡처)가 생기면
    // 이 테스트가 잡는다.
    let focused = false
    const { connection, send } = createConnectionStub()
    const gated = createChatGatedActions(() => focused, connection)

    gated.sendMoveInput(RAW_INPUT)
    gated.fire(RAW_DIRECTION, RAW_RTT_MS)
    expect(connection.sendMoveInput).toHaveBeenNthCalledWith(1, RAW_INPUT)
    expect(send).toHaveBeenCalledWith('fire', { ...RAW_DIRECTION, rttMs: RAW_RTT_MS })

    focused = true
    gated.sendMoveInput(RAW_INPUT)
    gated.fire(RAW_DIRECTION, RAW_RTT_MS)
    const secondSent = (connection.sendMoveInput as ReturnType<typeof vi.fn>).mock.calls[1]![0] as MoveInput
    expect(secondSent.dirX).toBe(0)
    expect(secondSent.dirZ).toBe(0)
    expect(secondSent.jump).toBe(false)
    expect(send).toHaveBeenCalledTimes(1) // 두 번째 fire()는 게이트돼 추가 호출 없음

    focused = false
    gated.fire(RAW_DIRECTION, RAW_RTT_MS)
    expect(send).toHaveBeenCalledTimes(2) // 다시 풀리면 즉시 통과
  })

  it('이동·사격 둘 다 같은 choke point가 덮는다 — 한쪽만 게이트되는 회귀를 방지', () => {
    const { connection, send } = createConnectionStub()
    const gated = createChatGatedActions(() => true, connection)

    gated.sendMoveInput(RAW_INPUT)
    gated.fire(RAW_DIRECTION, RAW_RTT_MS)

    const sent = (connection.sendMoveInput as ReturnType<typeof vi.fn>).mock.calls[0]![0] as MoveInput
    expect(sent).not.toEqual(RAW_INPUT) // 이동도 게이트됨
    expect(send).not.toHaveBeenCalled() // 사격도 게이트됨
  })

  it('RQ-64/F1 회귀 가드 — rttMs 값 자체가 그대로 전달된다(가터가 값을 변형·고정하지 않는다)', () => {
    const { connection, send } = createConnectionStub()
    const gated = createChatGatedActions(() => false, connection)

    gated.fire(RAW_DIRECTION, 137)

    expect(send).toHaveBeenCalledWith('fire', { ...RAW_DIRECTION, rttMs: 137 })
  })

  /**
   * PR #61 리뷰 blocker 회귀 가드 — 크로스헤어가 게이트를 우회한 원시 입력으로
   * 계산되던 결함. `movementInput`은 `window`에 리스너를 걸고 포커스를 보지
   * 않으므로 채팅창에 "wasd"를 치면 원시 입력이 이동 tier가 되는데, 서버가 받는
   * 값은 게이트로 0이다. 두 값이 갈라지는 그 구간에서 화면만 콘 배율을 부풀렸다.
   *
   * 여기서 고정하는 것은 **choke point가 전송값을 돌려준다**는 계약이다 — 이것이
   * 있어야 새 소비처가 `gateMoveInput`을 다시 부르지 않고도(분산 체크 부활 없이,
   * fe.md) 게이트된 값을 얻는다.
   */
  describe('PR #61 blocker: 게이트가 실제 전송값을 반환한다', () => {
    it('채팅 포커스 중 반환값은 전송된 값과 같고 방향이 0이다', () => {
      const { connection } = createConnectionStub()
      const gated = createChatGatedActions(() => true, connection)

      const returned = gated.sendMoveInput(RAW_INPUT)

      const sent = (connection.sendMoveInput as ReturnType<typeof vi.fn>).mock.calls[0]![0] as MoveInput
      expect(returned).toEqual(sent)
      expect(returned.dirX).toBe(0)
      expect(returned.dirZ).toBe(0)
    })

    it('포커스가 없으면 반환값이 입력 그대로다 — 게이트가 평상시를 건드리지 않는다', () => {
      const { connection } = createConnectionStub()
      const gated = createChatGatedActions(() => false, connection)

      expect(gated.sendMoveInput(RAW_INPUT)).toEqual(RAW_INPUT)
    })

    it('그 반환값으로 계산한 크로스헤어 간격은 정지 tier와 같다 — 화면과 서버가 갈라지지 않는다', () => {
      const { connection } = createConnectionStub()
      const gated = createChatGatedActions(() => true, connection)

      const returned = gated.sendMoveInput({ ...RAW_INPUT, dirX: 1, dirZ: 1, mode: 'run' })

      // 결함이 있던 형태: 원시 입력으로 계산하면 이동 tier가 되어 이 단언이 깨진다.
      expect(crosshairGapPx(returned, true)).toBe(CROSSHAIR.gapPx)
    })
  })
})
