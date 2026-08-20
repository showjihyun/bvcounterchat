import { describe, expect, it } from 'vitest'
import {
  advanceHitFeedback,
  applyHitReaction,
  createHitFeedbackState,
  type HitEvent,
} from '@client/effects/hitFeedback'
import { deriveHitDirectionEdge } from '@client/hud/hitDirectionEdge'

/**
 * RQ-57(히트마커)·RQ-58(피격 방향) — 원장 24cv, ADR-0016 결정 1 개정.
 * ADR-0011상 이 영역(`src/client/`)은 test-after가 허용된다(server 판정
 * 로직·`src/shared`가 아니다) — coder(이 세션)가 구현과 함께 작성한다.
 * 기존 파일(`rq-70-71-hit-feedback.test.ts`·`rq-57-59-hit-relation.test.ts`)의
 * 기존 단언은 건드리지 않는다 — 이 파일은 신규 파일이다(순증).
 *
 * EARS 문면(`harness/specs/requirements.md`):
 * - RQ-57: "자신이 쏜 총알이 **다른 플레이어에 명중하면**, 시스템은 그
 *   사수에게 **히트마커**를 표시해야 한다 … 명중이 **벽**인 경우에는
 *   표시하지 않는다. 히트마커는 **자신의 명중에만** 뜬다."
 * - RQ-58: "자신이 **총알에 맞으면**, 시스템은 피격자에게 **피격 방향**을
 *   표시해야 한다 … 방향은 **서버가 보낸 명중 이벤트의 표면 법선에서만**
 *   유도해야 한다 — 클라이언트가 자기 스냅샷의 **사수 좌표로 방향을
 *   재구성하지 않는다**."
 *
 * 매핑된 골든: **GA-122**(벽 명중 미표시) · **GA-123**(방향 — 법선만,
 * 이동 중인 사수와 무관) — `harness/evals/golden/track-a-product.jsonl`.
 *
 * **레벨 분리**: 컴포넌트 렌더(`HitMarker.tsx`·`HitDirectionIndicator.tsx`)는
 * ADR-0008 §6 렌더 계층 면제 대상이라 이 파일의 대상이 아니다 — 스크린샷이
 * 대신한다(`harness/workflow/fe.md`). 이 파일은 판단 층만 값으로 검증한다:
 * `applyHitReaction`(관계+대상 종류로 신호를 켤지) · `advanceHitFeedback`
 * (TTL) · `deriveHitDirectionEdge`(카메라 yaw로 가장자리를 고르는 산술).
 *
 * **결정론**: 모든 시각 값은 리터럴이다 — `Date.now()`·`performance.now()`
 * 어디서도 호출하지 않는다(ADR-0008).
 */

const SHOOTER_ID = 'session-shooter-9a1'
const VICTIM_ID = 'session-victim-4f2'
const BYSTANDER_ID = 'session-bystander-c73'

const MARKER_DURATION_MS = 250
const DIRECTION_DURATION_MS = 600

function playerHitEvent(): HitEvent {
  return {
    point: { x: 4, y: 1.2, z: -3 },
    normal: { x: 0, y: 1, z: 0 },
    target: 'player',
    shooterId: SHOOTER_ID,
    victimId: VICTIM_ID,
  }
}

function wallHitEvent(): HitEvent {
  return {
    point: { x: 15.4, y: 0.9, z: 2 },
    normal: { x: -1, y: 0, z: 0 },
    target: 'wall',
    shooterId: SHOOTER_ID,
  }
}

describe('RQ-57/GA-122 파생: applyHitReaction — 히트마커는 "내 총알이 플레이어에 명중"에만 켜진다', () => {
  it('사수 자신이 플레이어 명중 이벤트를 받으면 hitMarker가 켜진다(만료 시각 = nowMs + durationMs)', () => {
    const state = applyHitReaction(
      createHitFeedbackState(),
      playerHitEvent(),
      1000,
      SHOOTER_ID,
      MARKER_DURATION_MS,
      DIRECTION_DURATION_MS,
    )
    expect(state.hitMarker).toEqual({ expiresAtMs: 1000 + MARKER_DURATION_MS })
    expect(state.hitDirection).toBeNull() // 사수 자신은 피격자가 아니다
  })

  it('GA-122: 사수 자신이 받아도 대상이 벽이면 hitMarker가 켜지지 않는다(shooterId는 벽 명중에도 항상 채워지므로 target도 함께 확인해야 한다)', () => {
    const state = applyHitReaction(
      createHitFeedbackState(),
      wallHitEvent(),
      1000,
      SHOOTER_ID,
      MARKER_DURATION_MS,
      DIRECTION_DURATION_MS,
    )
    expect(state.hitMarker).toBeNull()
    expect(state.hitDirection).toBeNull()
  })

  it('피격자 자신이 이벤트를 받으면 hitMarker는 켜지지 않고 hitDirection만 켜진다 — normal은 이벤트 값 그대로다(재계산 금지)', () => {
    const event = playerHitEvent()
    const state = applyHitReaction(createHitFeedbackState(), event, 2000, VICTIM_ID, MARKER_DURATION_MS, DIRECTION_DURATION_MS)
    expect(state.hitMarker).toBeNull()
    expect(state.hitDirection).toEqual({ normal: event.normal, expiresAtMs: 2000 + DIRECTION_DURATION_MS })
  })

  it('요구 "히트마커는 자신의 명중에만 뜬다" — 제3자(사수도 피격자도 아님)가 같은 이벤트를 받으면 아무 신호도 켜지지 않는다', () => {
    const state = applyHitReaction(
      createHitFeedbackState(),
      playerHitEvent(),
      1000,
      BYSTANDER_ID,
      MARKER_DURATION_MS,
      DIRECTION_DURATION_MS,
    )
    expect(state.hitMarker).toBeNull()
    expect(state.hitDirection).toBeNull()
  })

  it('자격 없는 이벤트(제3자 관측)가 도착해도 이미 켜져 있던 신호를 지우지 않는다 — TTL 만료는 advanceHitFeedback만의 책임이다', () => {
    const afterShot = applyHitReaction(
      createHitFeedbackState(),
      playerHitEvent(),
      1000,
      SHOOTER_ID,
      MARKER_DURATION_MS,
      DIRECTION_DURATION_MS,
    )
    expect(afterShot.hitMarker).not.toBeNull()

    // 다른 이벤트(벽 명중, 나와 무관 — bystander)가 뒤이어 도착한다.
    const afterUnrelated = applyHitReaction(afterShot, wallHitEvent(), 1050, BYSTANDER_ID, MARKER_DURATION_MS, DIRECTION_DURATION_MS)
    expect(afterUnrelated.hitMarker).toEqual(afterShot.hitMarker) // 그대로 살아있다
  })

  it('참조 안정성 — 자격 없는 이벤트는 새 객체를 만들지 않고 기존 state 참조를 그대로 반환한다', () => {
    const state = createHitFeedbackState()
    const result = applyHitReaction(state, playerHitEvent(), 1000, BYSTANDER_ID, MARKER_DURATION_MS, DIRECTION_DURATION_MS)
    expect(result).toBe(state)
  })
})

describe('RQ-57·58/원장 24cv: advanceHitFeedback — hitMarker·hitDirection도 같은 갱신 함수가 TTL을 진행한다', () => {
  it('hitMarker는 지속 시간 이전에는 남아 있고, 지속 시간을 넘기면 사라진다', () => {
    const START_MS = 1000
    const withMarker = applyHitReaction(
      createHitFeedbackState(),
      playerHitEvent(),
      START_MS,
      SHOOTER_ID,
      MARKER_DURATION_MS,
      DIRECTION_DURATION_MS,
    )
    expect(advanceHitFeedback(withMarker, START_MS + MARKER_DURATION_MS - 1).hitMarker).not.toBeNull()
    expect(advanceHitFeedback(withMarker, START_MS + MARKER_DURATION_MS + 1).hitMarker).toBeNull()
  })

  it('hitDirection은 지속 시간 이전에는 남아 있고, 지속 시간을 넘기면 사라진다', () => {
    const START_MS = 1000
    const withDirection = applyHitReaction(
      createHitFeedbackState(),
      playerHitEvent(),
      START_MS,
      VICTIM_ID,
      MARKER_DURATION_MS,
      DIRECTION_DURATION_MS,
    )
    expect(advanceHitFeedback(withDirection, START_MS + DIRECTION_DURATION_MS - 1).hitDirection).not.toBeNull()
    expect(advanceHitFeedback(withDirection, START_MS + DIRECTION_DURATION_MS + 1).hitDirection).toBeNull()
  })

  it('hitMarker(250ms)·hitDirection(600ms)은 서로 다른 지속 시간으로 독립적으로 만료된다(둘 다 0시각에 켜진 상태에서, 마커만 만료되는 시각을 확인)', () => {
    let state = createHitFeedbackState()
    state = applyHitReaction(state, playerHitEvent(), 0, SHOOTER_ID, MARKER_DURATION_MS, DIRECTION_DURATION_MS)
    state = applyHitReaction(state, playerHitEvent(), 0, VICTIM_ID, MARKER_DURATION_MS, DIRECTION_DURATION_MS)
    expect(state.hitMarker).not.toBeNull()
    expect(state.hitDirection).not.toBeNull()

    const midway = advanceHitFeedback(state, MARKER_DURATION_MS + 1) // 마커 만료, 방향은 아직
    expect(midway.hitMarker).toBeNull()
    expect(midway.hitDirection).not.toBeNull()
  })

  it('hitMarker·hitDirection이 만료돼도 bulletHoles·hitEffects는 건드리지 않는다(컬렉션 독립성, GA-97과 같은 정신)', () => {
    let state = createHitFeedbackState()
    state = applyHitReaction(state, playerHitEvent(), 0, SHOOTER_ID, MARKER_DURATION_MS, DIRECTION_DURATION_MS)
    const advanced = advanceHitFeedback(state, MARKER_DURATION_MS + 1)
    expect(advanced.hitMarker).toBeNull()
    expect(advanced.bulletHoles).toBe(state.bulletHoles) // 참조 그대로
    expect(advanced.hitEffects).toBe(state.hitEffects) // 참조 그대로
  })

  it('참조 안정성(이월 24cg 확장) — hitEffects·hitMarker·hitDirection 어느 것도 만료 대상이 없으면 advanceHitFeedback은 state 참조를 그대로 반환한다', () => {
    let state = createHitFeedbackState()
    state = applyHitReaction(state, playerHitEvent(), 0, SHOOTER_ID, MARKER_DURATION_MS, DIRECTION_DURATION_MS)
    const stillActive = advanceHitFeedback(state, MARKER_DURATION_MS - 1) // 아직 만료 전
    expect(stillActive).toBe(state)
  })
})

describe('RQ-58/GA-123: deriveHitDirectionEdge — 표면 법선과 자신의 카메라 yaw만으로 가장자리를 고른다(사수 좌표 입력 없음)', () => {
  it('GA-123: 사수가 피격자의 왼쪽에 있으면(카메라 정면 yaw=0, 법선이 -X쪽) "left"가 나온다 — 사수의 이동 여부는 이 함수의 입력에 아예 없다', () => {
    // yaw=0일 때 카메라 정면은 -Z(관례), 오른쪽은 +X다 — 즉 -X가 "왼쪽".
    // normal.y·약간의 z 잡음을 섞어도(사수가 "이동 중"이라 정확히 축상에
    // 있지 않은 상황을 흉내) 결과가 흔들리지 않음을 함께 확인한다.
    expect(deriveHitDirectionEdge({ x: -1, y: 0.2, z: 0.05 }, 0)).toBe('left')
  })

  it('사수가 피격자의 오른쪽에 있으면(법선이 +X쪽) "right"가 나온다', () => {
    expect(deriveHitDirectionEdge({ x: 1, y: 0, z: 0 }, 0)).toBe('right')
  })

  it('사수가 피격자의 정면에 있으면(법선이 카메라 정면과 같은 쪽) "top"이 나온다', () => {
    // yaw=0일 때 정면은 -Z이므로, 정면에서 쐈다는 것은 법선이 -Z쪽이라는 뜻이다.
    expect(deriveHitDirectionEdge({ x: 0, y: 0, z: -1 }, 0)).toBe('top')
  })

  it('사수가 피격자의 뒤에 있으면(법선이 카메라 정면 반대쪽) "bottom"이 나온다', () => {
    expect(deriveHitDirectionEdge({ x: 0, y: 0, z: 1 }, 0)).toBe('bottom')
  })

  it('같은 월드 방향(법선)이라도 피격자 자신의 카메라 yaw가 다르면 다른 가장자리가 나온다 — 화면 가장자리는 카메라 상대값이다', () => {
    const worldNormal = { x: 0, y: 0, z: -1 } // 항상 월드 -Z쪽에서 맞았다
    expect(deriveHitDirectionEdge(worldNormal, 0)).toBe('top') // 카메라가 -Z를 볼 때
    expect(deriveHitDirectionEdge(worldNormal, -Math.PI / 2)).toBe('left') // 카메라가 +X를 볼 때(90도 돌림)
  })

  it('normal.y는 가장자리 선택에 영향을 주지 않는다(수평 성분만 쓴다)', () => {
    const low = deriveHitDirectionEdge({ x: -1, y: -5, z: 0 }, 0)
    const high = deriveHitDirectionEdge({ x: -1, y: 5, z: 0 }, 0)
    expect(low).toBe(high)
    expect(low).toBe('left')
  })
})
