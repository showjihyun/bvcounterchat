import { describe, expect, it } from 'vitest'
import { stepMovement, type BoxAABB, type MoveInput, type MoveState, type StaticGeometry } from '@shared/sim/movement'
import { MOVEMENT, NET } from '@shared/constants'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { BOX_ALPHA } from '@shared/sim/boxes'
import { PLATFORM_ALPHA } from '@shared/sim/platforms'

/**
 * 원장 24ao 명제 2 — 몸 반경 이동 판정: 박스·플랫폼 **모서리** 스침.
 * `24ao-corner-body-radius-walls.test.ts` 상단 docblock의 결함 서술과
 * 동일하다 — `boxesBlockingAt`이 옆면 차단 대상 박스를
 * `clampAgainstWalls`에 벽과 같은 목록으로 합류시키므로(`movement.ts`
 * `groundedOutcome`/`airborneOutcome`), 벽의 모서리 결함이 박스·플랫폼
 * 옆면(상단보다 낮은 높이, `y < topY`)에도 그대로 상속된다.
 *
 * **좌표(ADR-0010 — 리터럴 금지)**: `BOX_ALPHA`(`@shared/sim/boxes`)·
 * `PLATFORM_ALPHA`(`@shared/sim/platforms`) 정본을 그대로 읽는다. 각각을
 * **격리 주입**(`boxes: [BOX_ALPHA]` 등, 클러스터 전체가 아니다)한다 —
 * `24af-body-radius-boxes-platforms.test.ts`와 동일한 이유(인접 박스
 * 간섭 방지, 원장 25a-4 스코프 규율과 동일 정신). ⚠️ **격리 필요성이
 * 이 라운드에서 한 번 더 중요해졌다** — 아래 "영향 분석" 절 참고: 실제
 * `PRODUCTION_BOXES` 클러스터 내부 인접 박스 간격(0.3m)이
 * `2×bodyRadiusM`(0.6m)보다 좁아, 클러스터 전체를 주입하면 이 파일의
 * 관심사(단일 박스 모서리)와 무관한 별도의(그러나 실재하는) 스펙 쟁점과
 * 뒤섞인다 — 그 쟁점은 이 테스트가 판단하지 않는다(보고서 별도 절).
 *
 * **레벨(ADR-0008)**: 순수 산술 — 단위. **결정론**: 정수 틱 반복만 사용,
 * `Math.random()`·`Date.now()` 없음.
 */

const BODY_RADIUS_M = DEFAULT_HITBOX.bodyRadiusM
const TOLERANCE_M = 1e-6
const TICK_SECONDS = NET.TICK_MS / 1000
const SQRT2 = Math.SQRT2
const CORNER_APPROACH_OFFSET_M = 2
const TICKS = 60

function createGroundedState(overrides: Partial<MoveState> = {}): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, ...overrides }
}

/** 점-AABB 최단 유클리드 거리 — `24ao-corner-body-radius-walls.test.ts`의
 * 동명 헬퍼와 동일 로직(자기 완결 복제, 저장소 관례). `BoxAABB`는
 * `WallAABB`의 네 필드(`minX`/`maxX`/`minZ`/`maxZ`)를 상위집합으로
 * 가지므로 같은 함수를 그대로 쓸 수 있다. */
function closestDistanceToAABB(point: { x: number; z: number }, box: { minX: number; maxX: number; minZ: number; maxZ: number }): number {
  const cx = Math.max(box.minX, Math.min(point.x, box.maxX))
  const cz = Math.max(box.minZ, Math.min(point.z, box.maxZ))
  return Math.hypot(point.x - cx, point.z - cz)
}

function runCornerTicks(
  input: MoveInput,
  ticks: number,
  initial: MoveState,
  geometry: StaticGeometry,
  box: BoxAABB,
): { finalState: MoveState; minDistance: number } {
  let state = initial
  let minDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(state, input, geometry)
    const d = closestDistanceToAABB(state, box)
    if (d < minDistance) minDistance = d
  }
  return { finalState: state, minDistance }
}

describe('24ao 명제 2 — 박스: 상단보다 낮은 높이에서 모서리를 대각으로 스쳐도 중심이 AABB에서 bodyRadiusM 이상 떨어진다', () => {
  it('24ao/RQ-22: BOX_ALPHA 모서리(minX,minZ) 대각 스침 경로(매 틱 관측)에서 중심-AABB 거리가 bodyRadiusM(0.3m) 미만으로 좁혀지지 않는다', () => {
    const cornerX = BOX_ALPHA.minX
    const cornerZ = BOX_ALPHA.minZ
    const start = createGroundedState({
      x: cornerX - 1 * CORNER_APPROACH_OFFSET_M,
      z: cornerZ - 1 * CORNER_APPROACH_OFFSET_M,
      y: 0, // 상단(topY)보다 낮다 — 이 박스가 옆면(벽 성질)으로 차단해야 하는 구간.
    })
    const input: MoveInput = { dirX: 1, dirZ: 1, mode: 'run', jump: false }
    const geometry: StaticGeometry = { walls: [], boxes: [BOX_ALPHA], ladders: [] }

    // 전제 확인 — 출발점이 실제로 두 축 모두 박스의 원래 범위 밖이다.
    expect(start.x < BOX_ALPHA.minX || start.x > BOX_ALPHA.maxX).toBe(true)
    expect(start.z < BOX_ALPHA.minZ || start.z > BOX_ALPHA.maxZ).toBe(true)

    const { minDistance } = runCornerTicks(input, TICKS, start, geometry, BOX_ALPHA)

    // 명제 2 핵심 Red 단언.
    expect(minDistance).toBeGreaterThanOrEqual(BODY_RADIUS_M - TOLERANCE_M)
    // 명제 3(사각 근사 상한) — 벽과 동일한 유도(`24ao-corner-body-radius
    // -walls.test.ts` docblock 참고).
    expect(minDistance).toBeLessThanOrEqual(BODY_RADIUS_M * SQRT2 + TOLERANCE_M)
  })

  it('24ao/RQ-22 회귀 가드 — 박스 밖에서 반경보다 더 멀리(직선) 스치면 여전히 막히지 않는다', () => {
    const SAFE_SKIM_OFFSET_M = BODY_RADIUS_M + 0.05
    const start = createGroundedState({ x: BOX_ALPHA.minX - 5, z: BOX_ALPHA.minZ - SAFE_SKIM_OFFSET_M, y: 0 })
    const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
    const geometry: StaticGeometry = { walls: [], boxes: [BOX_ALPHA], ladders: [] }
    const ticks = 60 // x: minX-5 → minX+7 — 박스 x범위(11~14)를 훌쩍 지난다

    const { finalState } = runCornerTicks(input, ticks, start, geometry, BOX_ALPHA)

    const expectedX = start.x + MOVEMENT.SPEED * ticks * TICK_SECONDS
    expect(finalState.x).toBeCloseTo(expectedX, 6)
    expect(finalState.z).toBeCloseTo(start.z, 6)
  })
})

describe('24ao 명제 2 — 플랫폼: 상단보다 낮은 높이에서 모서리를 대각으로 스쳐도 중심이 AABB에서 bodyRadiusM 이상 떨어진다', () => {
  it('24ao/RQ-33: PLATFORM_ALPHA 모서리(maxX,minZ) 대각 스침 경로(매 틱 관측)에서 중심-AABB 거리가 bodyRadiusM(0.3m) 미만으로 좁혀지지 않는다', () => {
    const cornerX = PLATFORM_ALPHA.maxX
    const cornerZ = PLATFORM_ALPHA.minZ
    const start = createGroundedState({
      x: cornerX + 1 * CORNER_APPROACH_OFFSET_M,
      z: cornerZ - 1 * CORNER_APPROACH_OFFSET_M,
      y: 0, // 상단(topY=4)보다 낮다 — 옆면 차단 구간.
    })
    const input: MoveInput = { dirX: -1, dirZ: 1, mode: 'run', jump: false }
    // stepMovement가 호출 시점에 platforms를 boxes에 합쳐 boxesBlockingAt/
    // standingHeight에 넘긴다(`@shared/sim/movement` "원장 25a-5" 절).
    const geometry: StaticGeometry = { walls: [], boxes: [], ladders: [], platforms: [PLATFORM_ALPHA] }

    expect(start.x < PLATFORM_ALPHA.minX || start.x > PLATFORM_ALPHA.maxX).toBe(true)
    expect(start.z < PLATFORM_ALPHA.minZ || start.z > PLATFORM_ALPHA.maxZ).toBe(true)

    const { minDistance } = runCornerTicks(input, TICKS, start, geometry, PLATFORM_ALPHA)

    expect(minDistance).toBeGreaterThanOrEqual(BODY_RADIUS_M - TOLERANCE_M)
    expect(minDistance).toBeLessThanOrEqual(BODY_RADIUS_M * SQRT2 + TOLERANCE_M)
  })

  it('24ao/RQ-33 회귀 가드 — 플랫폼 밖에서 반경보다 더 멀리(직선) 스치면 여전히 막히지 않는다', () => {
    const SAFE_SKIM_OFFSET_M = BODY_RADIUS_M + 0.05
    const start = createGroundedState({ x: PLATFORM_ALPHA.maxX + 5, z: PLATFORM_ALPHA.minZ - SAFE_SKIM_OFFSET_M, y: 0 })
    const input: MoveInput = { dirX: -1, dirZ: 0, mode: 'run', jump: false }
    const geometry: StaticGeometry = { walls: [], boxes: [], ladders: [], platforms: [PLATFORM_ALPHA] }
    const ticks = 60

    const { finalState } = runCornerTicks(input, ticks, start, geometry, PLATFORM_ALPHA)

    const expectedX = start.x - MOVEMENT.SPEED * ticks * TICK_SECONDS
    expect(finalState.x).toBeCloseTo(expectedX, 6)
    expect(finalState.z).toBeCloseTo(start.z, 6)
  })
})
