import { describe, expect, it } from 'vitest'
import { findClosestHit, type HitboxConfig, type HitCandidate, type Ray, type Vec3 } from '@shared/sim/combat'
import type { WallAABB } from '@shared/sim/movement'
import { PRODUCTION_WALLS, WALL_EAST } from '@shared/sim/walls'

/**
 * RQ-12 v1.7 사격 차폐(맵 정적 지오메트리에 의한 hitscan 차단) — 순수 산술
 * 단위 테스트 (ADR-0008: 순수 함수·결정론·`src/shared` 환경 중립, ADR-0011:
 * 서버 판정 로직은 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-58** (`harness/evals/golden/track-a-product.jsonl`).
 * 이 파일은 GA-58의 순수 산술 기반(레이 × 벽 AABB 교차 거리 비교)을
 * 고정한다 — **1차 정본 검증은 `tests/integration/rq-12-wall-occlusion.test.ts`**
 * (실 `GameRoom`이 `PRODUCTION_WALLS`를 실제로 hitscan에 주입하는지, GA-58의
 * `verify` 필드가 그 경로를 직접 지정한다). 이 파일은 그 통합 시나리오가
 * 내부적으로 의존하는 순수 함수만 결정론적으로 미리 잠근다
 * (`tests/unit/sim-combat.test.ts`의 레벨 분리 원칙과 동일).
 *
 * **그린필드 계약 확장(test-writer 지정, `eyeOrigin` 추가·RQ-90 시드 배선
 * 선례와 동일한 권한)**: `findClosestHit`(`src/shared/sim/combat.ts:224`,
 * 기존 3-인자 함수)에 4번째 인자 `walls`를 추가한다 — 기존 호출부(3-인자)는
 * 기본값 `[]`로 동작이 완전히 그대로 유지된다(회귀 없음, 아래 "회귀 없음"
 * `it()`가 직접 고정).
 *
 * ```ts
 * // src/shared/sim/combat.ts (확장) — WallAABB는 @shared/sim/movement의
 * // 기존 타입을 그대로 재사용한다(ADR-0010 값 복제 금지 — 벽 형상 계약을
 * // 두 번 정의하지 않는다).
 * import type { WallAABB } from '@shared/sim/movement'
 *
 * export function findClosestHit(
 *   ray: Ray,
 *   candidates: HitCandidate[],
 *   hitbox: HitboxConfig,
 *   walls: readonly WallAABB[] = [],
 * ): ClosestHit | undefined
 * ```
 *
 * **행동 계약**:
 * 1. 각 후보에 대해 기존과 동일하게 `raycastHitbox`로 명중 여부·거리를 구한다.
 * 2. 명중한 후보라도, `walls` 중 어느 하나가 그 후보의 명중 거리보다
 *    **엄격히(strictly) 더 가까운** 거리에서 레이와 교차하면(=벽이 사수와
 *    표적 사이를 막는다) 그 후보는 명중 후보에서 제외된다 — RQ-12 v1.7 원문
 *    "지오메트리가 대상보다 **가까이** 있으면 그 사격은 명중이 아니다"의
 *    직역. 관통·도탄·파편은 스펙 밖이므로(v1.7 원문) 벽에 막힌 후보는 그냥
 *    제외될 뿐, 벽 표면에 별도의 "명중 지점"을 만들지 않는다(그 표면 처리는
 *    이 계약의 범위가 아니다 — 이 함수의 반환 타입 `ClosestHit`은 여전히
 *    플레이어 후보만 가리킨다).
 * 3. 벽과 레이의 교차 거리는 **XZ 평면(수평) 전용**이다 — `WallAABB`에
 *    `minY`/`maxY`가 없다는 것 자체가 "벽은 무한 높이 기둥"이라는 계약이다
 *    (`@shared/sim/walls` 문서 "2D(XZ) 전용 — 높이(Y) 필드 없음"과 동일
 *    가정, `movement.ts`의 `clampAgainstWalls`가 이미 이 가정으로 구현돼
 *    있다). 즉 레이 방향의 y성분과 무관하게, 레이의 (x,z) 성분만으로 벽의
 *    축정렬 사각형(minX/maxX/minZ/maxZ)과의 표준 슬랩(slab) 교차 진입
 *    거리를 계산한다.
 * 4. **경계(벽 거리 == 후보 명중 거리) — 이 계약이 명시적으로 고정하는
 *    결정**: 벽의 진입 거리가 후보의 명중 거리와 **정확히 같으면** 차폐로
 *    보지 않는다(그 후보는 여전히 명중). 근거: RQ-12 v1.7 원문은 "더
 *    가까이"(비교급, 엄격한 부등호)를 요구하지 그 이상을 규정하지 않는다 —
 *    "같은 거리"는 "더 가까움"이 아니므로 차폐가 아니라고 읽는 것이 원문에
 *    더 가깝다. 반대로 정했어도(경계 포함 차폐) 원문과 모순되지는 않지만,
 *    이 파일이 **하나의 결정**을 골라 고정해야 구현이 갈리지 않는다 — 아래
 *    "경계" `it()`가 이 결정을 기계적으로 강제한다.
 *
 * **레벨 분리 참고**: 벽 AABB 자체의 XZ 슬랩 교차 산술은 새 공개 API로
 * 노출하지 않는다(`findClosestHit`의 관측 가능한 입출력만 고정한다 —
 * 내부에서 별도 헬퍼로 쪼개든 인라인으로 두든 이 파일은 규정하지 않는다).
 */

/** 손으로 검산 가능한 단위 테스트 전용 히트박스(`sim-combat.test.ts`의
 * `TEST_HITBOX`와 동일 값·동일 근거 — 이 파일은 그 파일을 임포트하지
 * 않고 독립적으로 재정의한다, 두 파일이 서로 다른 계약을 검증하므로
 * 결합시키지 않는다). 헤드 구체 하단(2.5-0.5=2.0)이 바디 원통 상단(2.0)과
 * 정확히 맞닿는다(가정 A). */
const TEST_HITBOX: HitboxConfig = {
  bodyRadiusM: 1,
  bodyBottomM: 0,
  bodyTopM: 2,
  headRadiusM: 0.5,
  headCenterM: 2.5,
}

/** `sim-combat.test.ts`의 `findClosestHit` 그룹과 동일한 기준 시나리오 —
 * 원점(0,0,0)에 발이 위치한 대상, 레이는 z=-10에서 +z로 발사(높이 y=1,
 * 바디 범위 [0,2] 안, x=0 중심축). 바디 원통 표면(x²+z²=1²)과의 교차는
 * z=-1(원점에서 가장 먼저 만나는 지점) — 명중 거리는 정확히
 * |z=-1 - z=-10| = 9. 이 파일 전체가 이 하나의 기하를 공유해, 벽 하나만
 * 바꿔가며 "9보다 가까운/먼/같은" 세 경우를 손으로 검산 가능하게 만든다. */
const RAY: Ray = { origin: { x: 0, y: 1, z: -10 }, direction: { x: 0, y: 0, z: 1 } }
const TARGET: HitCandidate = { id: 'target', pose: { position: { x: 0, y: 0, z: 0 } } }
const TARGET_HIT_DISTANCE = 9

/** 사수-표적 사이를 막는 벽 — z 슬랩 진입 거리 = |z=-5 - z=-10| = 5 < 9
 * (표적 명중 거리보다 엄격히 가깝다 → 차폐). x 슬랩은 [-2,2]가 레이의
 * x=0을 항상 포함하므로(레이 방향의 x성분이 0) x축은 진입 거리를
 * 제약하지 않는다 — z 슬랩만으로 진입 거리가 정해진다(위 계약 3). */
const WALL_BETWEEN: WallAABB = { minX: -2, maxX: 2, minZ: -5, maxZ: -4 }

/** 표적보다 뒤(사수로부터 더 먼 곳)에 있는 벽 — 진입 거리 =
 * |z=5 - z=-10| = 15 > 9. RQ-12 v1.7 원문 "표적보다 뒤에 있는 배치는
 * 차폐가 아니다"를 직접 고정한다. */
const WALL_BEHIND: WallAABB = { minX: -2, maxX: 2, minZ: 5, maxZ: 6 }

/** 표적과 정확히 같은 거리(9)에서 레이와 교차하는 벽 — 진입 거리 =
 * |z=-1 - z=-10| = 9 === TARGET_HIT_DISTANCE. 위 계약 4(경계 결정)를
 * 고정하는 전용 벽. */
const WALL_EXACTLY_AT_TARGET_DISTANCE: WallAABB = { minX: -2, maxX: 2, minZ: -1, maxZ: 3 }

describe('RQ-12 v1.7/GA-58 findClosestHit 벽 차폐 — 벽이 사격 판정에 벽 목록으로 주입되는 계약', () => {
  it('GA-58 차폐: 사수-표적 사이의 벽이 표적보다 가까우면 명중하지 않는다(undefined)', () => {
    const result = findClosestHit(RAY, [TARGET], TEST_HITBOX, [WALL_BETWEEN])

    expect(result).toBeUndefined()
  })

  it('GA-58 양성 대조군: 같은 배치에서 벽만 없으면(walls=[]) 같은 레이가 정상 명중한다 — 차폐가 사격 자체를 죽인 것이 아니다', () => {
    const result = findClosestHit(RAY, [TARGET], TEST_HITBOX, [])

    expect(result?.id).toBe('target')
    expect(result?.result.hit).toBe(true)
    expect(result?.result.region).toBe('body')
    expect(result?.result.distance).toBeCloseTo(TARGET_HIT_DISTANCE, 6)
  })

  it('회귀 없음: walls 인자를 아예 생략해도(4-인자 미도입 이전 호출부와 동일한 3-인자 호출) walls=[]과 완전히 동일하게 동작한다', () => {
    const result = findClosestHit(RAY, [TARGET], TEST_HITBOX)

    expect(result?.id).toBe('target')
    expect(result?.result.hit).toBe(true)
    expect(result?.result.distance).toBeCloseTo(TARGET_HIT_DISTANCE, 6)
  })

  it('GA-58 "벽이 표적보다 뒤": 벽이 표적 너머(더 먼 거리)에 있으면 차폐가 아니므로 정상 명중한다', () => {
    const result = findClosestHit(RAY, [TARGET], TEST_HITBOX, [WALL_BEHIND])

    expect(result?.id).toBe('target')
    expect(result?.result.hit).toBe(true)
    expect(result?.result.distance).toBeCloseTo(TARGET_HIT_DISTANCE, 6)
  })

  it('경계 결정(계약 4): 벽의 교차 거리가 표적의 명중 거리와 정확히 같으면 차폐로 보지 않는다(엄격히 더 가까운 벽만 차폐) — 반대로 구현하려면 이 단언을 먼저 바꿔야 한다', () => {
    const result = findClosestHit(RAY, [TARGET], TEST_HITBOX, [WALL_EXACTLY_AT_TARGET_DISTANCE])

    expect(result?.id).toBe('target')
    expect(result?.result.hit).toBe(true)
    expect(result?.result.distance).toBeCloseTo(TARGET_HIT_DISTANCE, 6)
  })
})

/**
 * 결함 재현 — 벽에 밀착한 사수는 어느 방향으로 쏴도 전탄이 무효화된다
 * (PR #48 리뷰 blocker, team-lead 04_test-writer_flush 지시).
 *
 * **근본 원인**: `intersectWallXZ`(`src/shared/sim/combat.ts:267`)의
 * `if (tMax < tMin || tMax < -FORWARD_EPS) return undefined` 가드는, 레이
 * 원점이 벽 슬랩 **경계 위**에 있고 방향이 벽에서 **멀어질 때** `tMax`가
 * `-0`이 되는 경우를 배제하지 못한다 — `-0 < -1e-9`가 거짓이라 그대로
 * 통과해 `Math.max(tMin, 0) = 0`이 진입 거리로 나간다. 진입 거리 0은 어떤
 * 후보의 명중 거리(양수)보다도 작으므로(`isOccludedByWall`) **전 후보가
 * 차폐 제외**된다.
 *
 * **이 좌표는 우연이 아니다**: `clampAgainstWalls`(`src/shared/sim/movement
 * .ts:214`)가 이동 클램프 후 x를 `wall.minX`로 정확히 스냅하고,
 * `GameRoom.ts:1092`(`stepPlayerMovement`)가 그 값을 `moveStates`에 넣고,
 * `handleFire`(`GameRoom.ts:681`)가 반올림 없이 그 값을 레이 원점
 * (`eyeOrigin`)에 그대로 쓴다 — "벽에 붙어 엄폐한다"는 평범한 조작이 매 번
 * 이 경계 좌표를 만들어낸다. 네 벽 대칭이고, 벽 대역(15.8~16.8m)은 Safe
 * Zone(18~26m) 밖이라 RQ-31 게이트도 가리지 않는다.
 *
 * 아래 명제는 **관측 가능한 행동(명중/미명중)만** 단언한다 — 수정 방향
 * (리뷰어 제안 `tMax <= 0` 등)은 구현자에게 넘긴다. `WALL_EAST`·
 * `PRODUCTION_WALLS`는 `@shared/sim/walls`에서 그대로 임포트한다(ADR-0010
 * 값 복제 금지 — `15`·`16` 리터럴을 이 파일에 새로 쓰지 않는다).
 */
describe('결함 재현 — 벽 밀착 사수의 전탄 무효화 (PR #48 리뷰 blocker)', () => {
  /** 밀착 사수 원점 — `WALL_EAST.minX`(경계) 정확히 위, z=0은 벽의 z
   * 범위(`WALL_EAST.minZ`~`WALL_EAST.maxZ` = -5~5) 안이라 x축 슬랩 배제
   * 분기(`intersectWallXZ`의 평행 분기)를 타지 않는다(위 결함 설명의
   * 전제 조건). */
  const FLUSH_ORIGIN: Vec3 = { x: WALL_EAST.minX, y: 1, z: 0 }
  /** 표적을 사수로부터 이 거리(월드 미터)만큼 띄운다 —
   * `TEST_HITBOX.bodyRadiusM`(1)을 빼면 손으로 검산 가능한 명중 거리가
   * 나온다(아래 `EXPECTED_HIT_DISTANCE`). */
  const TARGET_OFFSET_M = 6
  const EXPECTED_HIT_DISTANCE = TARGET_OFFSET_M - TEST_HITBOX.bodyRadiusM

  it('밀착 + 벽 반대 방향(서쪽, 벽에서 멀어짐) 사격은 명중해야 한다 — 지금은 자기 벽에 차폐돼 Red', () => {
    const ray: Ray = { origin: FLUSH_ORIGIN, direction: { x: -1, y: 0, z: 0 } }
    const target: HitCandidate = {
      id: 'target',
      pose: { position: { x: FLUSH_ORIGIN.x - TARGET_OFFSET_M, y: 0, z: 0 } },
    }

    const result = findClosestHit(ray, [target], TEST_HITBOX, [WALL_EAST])

    expect(result?.id).toBe('target')
    expect(result?.result.hit).toBe(true)
    expect(result?.result.distance).toBeCloseTo(EXPECTED_HIT_DISTANCE, 6)
  })

  it('밀착 + 벽면과 나란한 방향(북쪽, z축 — 벽을 관통하지 않음) 사격도 명중해야 한다 — 지금은 자기 벽에 차폐돼 Red', () => {
    const ray: Ray = { origin: FLUSH_ORIGIN, direction: { x: 0, y: 0, z: 1 } }
    const target: HitCandidate = {
      id: 'target',
      pose: { position: { x: FLUSH_ORIGIN.x, y: 0, z: FLUSH_ORIGIN.z + TARGET_OFFSET_M } },
    }

    const result = findClosestHit(ray, [target], TEST_HITBOX, [WALL_EAST])

    expect(result?.id).toBe('target')
    expect(result?.result.hit).toBe(true)
    expect(result?.result.distance).toBeCloseTo(EXPECTED_HIT_DISTANCE, 6)
  })

  it('양성 대조군 — 밀착 + 벽 쪽 방향(동쪽, 실제로 벽을 관통하는 경로)은 여전히 차폐돼야 한다(과잉수정 방지)', () => {
    const ray: Ray = { origin: FLUSH_ORIGIN, direction: { x: 1, y: 0, z: 0 } }
    const target: HitCandidate = {
      id: 'target',
      pose: { position: { x: WALL_EAST.maxX + TARGET_OFFSET_M, y: 0, z: 0 } },
    }

    const result = findClosestHit(ray, [target], TEST_HITBOX, [WALL_EAST])

    expect(result).toBeUndefined()
  })

  interface FlushWallCase {
    wall: WallAABB
    label: string
    origin: Vec3
    awayDirection: Vec3
  }

  /** 벽의 두께가 더 얇은 축을 "두께 축"으로 판별해, 그 축에서 맵 중심
   * (원점)에 더 가까운 면("안쪽 면")과 거기서 멀어지는 방향을 유도한다 —
   * 좌표 리터럴을 하드코딩하지 않고 `WallAABB` 필드값만으로 계산한다
   * (ADR-0010). 네 벽(`PRODUCTION_WALLS`) 전수를 이 하나의 함수로 덮어
   * 조합 폭발 없이 대칭을 확인한다(팀리드 지시). */
  function flushWallCase(wall: WallAABB): FlushWallCase {
    const xThicknessM = wall.maxX - wall.minX
    const zThicknessM = wall.maxZ - wall.minZ
    if (xThicknessM < zThicknessM) {
      const isEastSide = wall.minX > 0
      const flushX = isEastSide ? wall.minX : wall.maxX
      return {
        wall,
        label: isEastSide ? '동' : '서',
        origin: { x: flushX, y: 1, z: 0 },
        awayDirection: { x: isEastSide ? -1 : 1, y: 0, z: 0 },
      }
    }
    const isNorthSide = wall.minZ > 0
    const flushZ = isNorthSide ? wall.minZ : wall.maxZ
    return {
      wall,
      label: isNorthSide ? '북' : '남',
      origin: { x: 0, y: 1, z: flushZ },
      awayDirection: { x: 0, y: 0, z: isNorthSide ? -1 : 1 },
    }
  }

  it.each(PRODUCTION_WALLS.map(flushWallCase))(
    '네 벽 대칭($label): 안쪽 면 밀착 + 벽 반대 방향 사격은 명중해야 한다 — 지금은 자기 벽에 차폐돼 Red',
    ({ wall, origin, awayDirection }) => {
      const target: HitCandidate = {
        id: 'target',
        pose: {
          position: {
            x: origin.x + awayDirection.x * TARGET_OFFSET_M,
            y: 0,
            z: origin.z + awayDirection.z * TARGET_OFFSET_M,
          },
        },
      }

      const result = findClosestHit({ origin, direction: awayDirection }, [target], TEST_HITBOX, [wall])

      expect(result?.id).toBe('target')
      expect(result?.result.hit).toBe(true)
      expect(result?.result.distance).toBeCloseTo(EXPECTED_HIT_DISTANCE, 6)
    },
  )
})
