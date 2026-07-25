import { describe, expect, it } from 'vitest'
import type { MoveInput } from '@shared/sim/movement'
import { gateFireIntent, gateMoveInput } from '@client/input/chatInputGate'

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
 * `gateMoveInput`은 `chatFocused`가 true면 방향·점프가 전부 무입력인
 * `MoveInput`을 반환하고(어떤 방향키를 누르고 있었든 무관), false면 `input`을
 * 그대로(값 동일하게) 반환한다. `mode` 필드의 정확한 값(무입력 상태에서
 * 'run'인지 다른 값인지)은 이 계약이 규정하지 않는다 — 방향이 0이면 어떤
 * `mode`든 이동 산술(`@shared/sim/movement`)의 결과는 정지이므로, 이 필드
 * 값에 결합하는 것은 과잉 사양이다. `gateFireIntent`는 동일한 정신으로
 * 사격 의도(boolean)를 게이트한다.
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
