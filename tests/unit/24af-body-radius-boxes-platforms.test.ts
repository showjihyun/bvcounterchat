import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveInput, type MoveState, type StaticGeometry } from '@shared/sim/movement'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { BOX_ALPHA } from '@shared/sim/boxes'
import { PLATFORM_ALPHA } from '@shared/sim/platforms'

/**
 * 원장 24af 명제 2 — 몸 반경 이동 판정: 박스·플랫폼(RQ-22/RQ-32/RQ-33,
 * 골든 GA-53/GA-55/GA-59/GA-60 인접 영역 — **이 결함을 직접 겨냥한 전용
 * GA는 없다**, 근거는 `24af-body-radius-walls.test.ts` 상단 "골든 부재"
 * 절과 동일).
 *
 * **결함 근거**: `24af-body-radius-walls.test.ts` 상단 docblock 전문 참고
 * — `boxesBlockingAt`이 옆면 차단 대상 박스를 `clampAgainstWalls`에 벽과
 * 같은 목록으로 합류시키므로(`movement.ts` `groundedOutcome`/
 * `airborneOutcome`), 벽의 결함(반경 미적용)이 박스·플랫폼에도 그대로
 * 상속된다 — 박스도 몸통 0.3m가 옆면 안에 박힐 수 있다.
 *
 * **사용자 결정(2026-08-06)**: 반경을 박스·플랫폼에도 도입한다. **단,
 * 상단(topY)보다 높거나 같은 높이(y >= topY, "서 있는" 상태)에서는 그
 * 박스가 애초에 차단 목록(`boxesBlockingAt`)에서 빠지므로 이 반경 적용과
 * 무관하게 계속 막히지 않아야 한다** — 이 계약을 이 라운드가 깨서는 안
 * 된다(RQ-22 "박스 위에 설 수 있어야 한다"는 무조건절, `sim-movement
 * -boxes.test.ts` "접지 지속"/"질문1 경계" 테스트가 이미 고정한 계약).
 *
 * **좌표(ADR-0010 — 리터럴 금지)**: `BOX_ALPHA`(`@shared/sim/boxes`)·
 * `PLATFORM_ALPHA`(`@shared/sim/platforms`) 정본을 그대로 읽는다. "윗면에
 * 서 있을 때 막히지 않는다" 회귀 가드는 클러스터 내 인접 박스
 * (`BOX_ALPHA_3`, 근접 간격 0.3m)와의 간섭을 피하기 위해 `boxes: [BOX_ALPHA]`
 * 하나만 주입한다(`PRODUCTION_BOXES` 전체가 아니다) — 이 라운드가 시험하는
 * 것은 "이 박스 자신의 상단 위는 막히지 않는다"이지 클러스터 간 상호작용이
 * 아니다(스코프 밖, 원장 25a-4 "명시적으로 정하지 않는 것" 절과 동일 정신).
 *
 * **레벨(ADR-0008)**: 순수 산술 — 단위. **결정론**: 정수 틱 반복만 사용,
 * `Math.random()`·`Date.now()` 없음.
 */

const BODY_RADIUS_M = DEFAULT_HITBOX.bodyRadiusM
const TOLERANCE_M = 1e-6
/** `24af-body-radius-walls.test.ts`의 `APPROACH_MARGIN_M`과 동일 값·동일
 * 근거(정지 전략을 규정하지 않는 넉넉한 여유). */
const APPROACH_MARGIN_M = 2
/** 이 파일이 쓰는 시작점~근접면 거리(5m 이상)를 6m/s로 걷기 충분한 여유. */
const TICKS = 60

function createGroundedState(overrides: Partial<MoveState> = {}): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, ...overrides }
}

function runTicks(input: MoveInput, ticks: number, initial: MoveState, geometry: StaticGeometry): MoveState {
  let state = initial
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(state, input, geometry)
  }
  return state
}

describe('24af 명제 2 — 박스: 상단보다 낮은 높이에서 밀착해도 중심이 옆면에서 bodyRadiusM만큼 떨어진다', () => {
  it('24af/RQ-22: BOX_ALPHA 방향으로 걸어서(비점프) 접근해도(60틱) 중심-근접면(minX) 간극이 bodyRadiusM(0.3m) 이상이다', () => {
    const centerZ = (BOX_ALPHA.minZ + BOX_ALPHA.maxZ) / 2
    const start = createGroundedState({ x: BOX_ALPHA.minX - 5, z: centerZ })
    const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
    const geometry: StaticGeometry = { walls: [], boxes: [BOX_ALPHA], ladders: [] }

    const state = runTicks(input, TICKS, start, geometry)
    const clearance = BOX_ALPHA.minX - state.x

    // 핵심 Red 단언 — 오늘 구현은 clearance≈0.
    expect(clearance).toBeGreaterThanOrEqual(BODY_RADIUS_M - TOLERANCE_M)
    expect(clearance).toBeLessThan(BODY_RADIUS_M + APPROACH_MARGIN_M)
    expect(state.x).toBeGreaterThan(start.x) // 고착 아님 — 실제로 전진했다
    // 차단됐으니(근접면을 넘지 못했으니) 지지 높이도 여전히 맨 지면이다.
    expect(state.grounded).toBe(true)
    expect(state.y).toBeCloseTo(0, 6)
  })

  it('24af/RQ-22 회귀 가드(과잉수정 방지) — 박스 윗면(y>=topY)에 서 있으면 반경과 무관하게 계속 막히지 않는다(원장 25a-4 계약 유지)', () => {
    const center = { x: (BOX_ALPHA.minX + BOX_ALPHA.maxX) / 2, z: (BOX_ALPHA.minZ + BOX_ALPHA.maxZ) / 2 }
    const start = createGroundedState({ x: center.x, y: BOX_ALPHA.topY, z: center.z })
    const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
    const geometry: StaticGeometry = { walls: [], boxes: [BOX_ALPHA], ladders: [] }

    let state = start
    let crossedFarFace = false
    const CROSS_TICKS = 20 // 중심→원면(1.5m)을 6m/s(0.2m/틱)로 넘기 충분한 여유
    for (let i = 0; i < CROSS_TICKS; i += 1) {
      state = stepMovement(state, input, geometry)
      if (state.x > BOX_ALPHA.maxX) crossedFarFace = true
    }
    // 전제 확인이자 본 단언 — 반경이 옆면 차단(y<topY)에만 적용된다면, 윗면에
    // 선 채로는 원면(maxX)을 자유롭게 넘어야 한다(walls-only 결함처럼 박스
    // 자체를 통째로 넓혀버리는 과잉수정이면 이 단언이 깨진다).
    expect(crossedFarFace).toBe(true)
  })
})

describe('24af 명제 2 — 플랫폼: 상단보다 낮은 높이에서 밀착해도 중심이 옆면에서 bodyRadiusM만큼 떨어진다(GA-60 인접면)', () => {
  it('24af/RQ-33/GA-60 인접: PLATFORM_ALPHA의 사다리 없는 면(동쪽, maxX)으로 접근해도(60틱) 중심-근접면 간극이 bodyRadiusM(0.3m) 이상이다', () => {
    const centerZ = (PLATFORM_ALPHA.minZ + PLATFORM_ALPHA.maxZ) / 2
    const start = createGroundedState({ x: PLATFORM_ALPHA.maxX + 5, z: centerZ })
    const input: MoveInput = { dirX: -1, dirZ: 0, mode: 'run', jump: false }
    // stepMovement가 호출 시점에 platforms를 boxes에 합쳐 boxesBlockingAt/
    // standingHeight에 넘긴다(`@shared/sim/movement` docblock "원장 25a-5"
    // 절) — boxes는 비워 platforms 경로 자체를 시험한다.
    const geometry: StaticGeometry = { walls: [], boxes: [], ladders: [], platforms: [PLATFORM_ALPHA] }

    const state = runTicks(input, TICKS, start, geometry)
    const clearance = state.x - PLATFORM_ALPHA.maxX

    expect(clearance).toBeGreaterThanOrEqual(BODY_RADIUS_M - TOLERANCE_M)
    expect(clearance).toBeLessThan(BODY_RADIUS_M + APPROACH_MARGIN_M)
    expect(state.x).toBeLessThan(start.x) // 고착 아님 — 실제로 전진했다
    expect(state.grounded).toBe(true)
    expect(state.y).toBeCloseTo(0, 6) // 오르지 못했다(GA-60과 동일 귀결)
  })

  it('24af/RQ-33 회귀 가드(과잉수정 방지) — 플랫폼 윗면(y>=topY)에 서 있으면 반경과 무관하게 계속 막히지 않는다(GA-59 전이 이후 이동 자유)', () => {
    const center = { x: (PLATFORM_ALPHA.minX + PLATFORM_ALPHA.maxX) / 2, z: (PLATFORM_ALPHA.minZ + PLATFORM_ALPHA.maxZ) / 2 }
    const start = createGroundedState({ x: center.x, y: PLATFORM_ALPHA.topY, z: center.z })
    const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
    const geometry: StaticGeometry = { walls: [], boxes: [], ladders: [], platforms: [PLATFORM_ALPHA] }

    let state = start
    let crossedFarFace = false
    const CROSS_TICKS = 20 // 중심→원면(2m)을 6m/s(0.2m/틱)로 넘기 충분한 여유
    for (let i = 0; i < CROSS_TICKS; i += 1) {
      state = stepMovement(state, input, geometry)
      if (state.x > PLATFORM_ALPHA.maxX) crossedFarFace = true
    }
    expect(crossedFarFace).toBe(true)
  })
})
