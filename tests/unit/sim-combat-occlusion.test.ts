import { describe, expect, it } from 'vitest'
import { findClosestHit, type HitboxConfig, type HitCandidate, type Ray } from '@shared/sim/combat'
import type { WallAABB } from '@shared/sim/movement'

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
