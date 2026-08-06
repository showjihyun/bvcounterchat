import { describe, expect, it } from 'vitest'
import type { BoxAABB, LadderVolume } from '@shared/sim/movement'
import { LADDER_ALPHA, PRODUCTION_LADDERS } from '@shared/sim/ladders'
import { PRODUCTION_BOXES } from '@shared/sim/boxes'
import { PRODUCTION_PLATFORMS } from '@shared/sim/platforms'

/**
 * RQ-33 고지대 플랫폼 — 순수 데이터 계약(ADR-0008: `src/shared` 정적
 * 지오메트리, 환경 중립 — 서버 기동 없이 프로덕션 배열 자체를 읽는다).
 *
 * 매핑된 골든 케이스 전문(`harness/evals/golden/track-a-product.jsonl`):
 *
 * - **GA-61**: given 맵 지오메트리가 로드된 상태 / when 각 사다리와 플랫폼의
 *   경계를 대조 / then 모든 사다리가 어떤 플랫폼의 측면에 간격 0으로
 *   접하고, 등반 법선이 그 플랫폼을 향한다.
 * - **GA-62**: given 맵 지오메트리가 로드된 상태 / when 플랫폼 윗면 높이와
 *   접한 사다리 상단을 대조 / then 두 값이 같고, 플랫폼 수가 사다리 수와
 *   같다.
 * - **GA-63**(spec: RQ-32): given 맵 지오메트리가 로드된 상태 / when 각
 *   사다리 볼륨의 폭을 측정 / then 폭이 1.5m이고 등반면의 좌우 어느
 *   쪽으로도 치우치지 않는다.
 *
 * RQ-33 전문(`harness/specs/requirements.md`): "맵에는 사다리로만 도달
 * 가능한 고지대 플랫폼이 사다리 개수만큼 배치되어야 한다. 플랫폼 윗면은
 * 서 있을 수 있어야 하며, 그 높이는 접한 사다리의 상단과 같아야 한다.
 * 플랫폼은 점프(RQ-92 1.0m)나 박스 등반(RQ-22)으로는 도달할 수 없어야
 * 한다. 각 사다리는 플랫폼 측면에 접해야 하고, 등반이 끝나는 지점에서
 * 플랫폼 윗면으로 이동할 수 있어야 한다."
 *
 * **현재 상태(그린필드)**: `@shared/sim/platforms`가 아직 존재하지
 * 않는다 — 이 파일의 모든 단언이 오늘 코드베이스에서 **실패한다**(Red,
 * `PRODUCTION_PLATFORMS` 등 임포트 자체가 컴파일 에러). `@shared/sim/ladders`의
 * `LADDER_ALPHA`/`LADDER_BRAVO`도 이 라운드에서 폭이 3m→1.5m로
 * 좁아져야 한다(아래 GA-63) — 오늘 값(3m)으로는 GA-63이 Red다.
 *
 * ---
 *
 * ## 가정(coder에게 — 이 shape으로 구현할 것, 강제 아님. 아래 단언은 이
 * 정확한 리터럴을 검사하지 않고 **구조적 성질**만 검사한다, ADR-0010 정신
 * — 단 GA-63의 "1.5m" 자체는 골든이 명시한 값이라 리터럴로 고정한다)
 *
 * ```ts
 * // src/shared/sim/platforms.ts — walls.ts/boxes.ts/ladders.ts와 동일한 모양.
 * // BoxAABB(minX/maxX/minZ/maxZ/topY)를 그대로 재사용한다 — 플랫폼은
 * // boxesBlockingAt/standingHeight(@shared/sim/movement)가 이미 다루는
 * // "유한 높이 지오메트리" 그 자체이므로 새 타입이 필요 없다.
 * import type { BoxAABB } from '@shared/sim/movement'
 *
 * export const PLATFORM_ALPHA: BoxAABB = { minX: -13, maxX: -9, minZ: 7.5, maxZ: 11.5, topY: 4 }
 * export const PLATFORM_BRAVO: BoxAABB = { minX: -13, maxX: -9, minZ: -11.5, maxZ: -7.5, topY: 4 }
 * export const PRODUCTION_PLATFORMS: readonly BoxAABB[] = [PLATFORM_ALPHA, PLATFORM_BRAVO]
 * ```
 *
 * `@shared/sim/ladders`의 `LADDER_ALPHA`/`LADDER_BRAVO`는 z 폭을 3m→1.5m로
 * 좁힌다(현재 span 중앙 정렬 — `minX`/`maxX`/`normalX`/`minY`/`maxY`는
 * 그대로): `LADDER_ALPHA` `z 8..11` → `z 8.75..10.25`, `LADDER_BRAVO`
 * `z -11..-8` → `z -10.25..-8.75`.
 *
 * ⚠️ **`PRODUCTION_PLATFORMS`를 `PRODUCTION_BOXES`(`@shared/sim/boxes`)에
 * 합치면 안 된다** — 합치면 `tests/unit/map-box-dimensions.test.ts`의
 * GA-53("모든 박스 topY ≤ 1.0m")이 즉시 깨진다(플랫폼 topY=4m). 아래
 * "회귀 안전 대역" describe가 이 비混입을 직접 재확인한다.
 *
 * **`stepMovement`(`@shared/sim/movement`)로의 배선(GA-59/60이 관측)**:
 * `boxesBlockingAt`·`standingHeight`는 이미 임의의 `BoxAABB[]`를 받는다 —
 * 새 판정 로직이 필요 없다. 배선(예: `@shared/sim/geometry`의
 * `PRODUCTION_GEOMETRY.boxes`에 `[...PRODUCTION_BOXES,
 * ...PRODUCTION_PLATFORMS]`를 합치는 방식, 정확한 지점은 coder 자유)이
 * 실제로 플랫폼을 등반 판정에 반영하는지는 이 파일이 시험하지 않는다 —
 * `tests/integration/rq-33-platform-reach.test.ts`(GA-59/60)가 담당한다
 * (레벨 분리, `sim-movement-ladders.test.ts`/`rq-21-ladder-vertical
 * -movement.test.ts` 선례와 동일).
 *
 * **결정론(ADR-0008)**: 이 파일은 `stepMovement`를 호출하지 않는다 —
 * 정적 배열의 구조적 성질(간격·법선·높이·폭)만 검사하는 순수 데이터
 * 검증이라 별도 결정론 증명이 필요 없다(`map-box-dimensions.test.ts`와
 * 동일 근거).
 */

const TOLERANCE_M = 1e-6

interface RectAABB {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** 두 사각형 사이의 최소 간격(m) — 겹치거나 붙어 있으면 0
 * (`map-box-dimensions.test.ts`의 `gapDistance`와 동일 로직, 파일 간
 * 순수 함수 공유가 없어 재구현한다 — 이 파일도 자기 완결이다). */
function gapDistance(a: RectAABB, b: RectAABB): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0)
  const dz = Math.max(a.minZ - b.maxZ, b.minZ - a.maxZ, 0)
  return Math.hypot(dx, dz)
}

/**
 * 사다리의 등반 법선이 가리키는 쪽에서, 사다리 볼륨과 간격 0으로 접하고
 * (근접면 좌표 일치) 사다리의 가로 폭이 그 플랫폼의 대응 축 범위 안에
 * 완전히 들어가는(부분집합) 플랫폼을 찾는다. 축 정렬 법선(normalX/normalZ
 * 중 하나만 ±1)만 지원한다 — 현재 프로덕션 사다리는 전부 이 형태다.
 */
function findAdjacentPlatform(ladder: LadderVolume, platforms: readonly BoxAABB[]): BoxAABB | undefined {
  return platforms.find((platform) => {
    if (gapDistance(ladder, platform) > TOLERANCE_M) return false
    if (ladder.normalX > 0) {
      return (
        Math.abs(ladder.maxX - platform.minX) < TOLERANCE_M &&
        ladder.minZ >= platform.minZ - TOLERANCE_M &&
        ladder.maxZ <= platform.maxZ + TOLERANCE_M
      )
    }
    if (ladder.normalX < 0) {
      return (
        Math.abs(ladder.minX - platform.maxX) < TOLERANCE_M &&
        ladder.minZ >= platform.minZ - TOLERANCE_M &&
        ladder.maxZ <= platform.maxZ + TOLERANCE_M
      )
    }
    if (ladder.normalZ > 0) {
      return (
        Math.abs(ladder.maxZ - platform.minZ) < TOLERANCE_M &&
        ladder.minX >= platform.minX - TOLERANCE_M &&
        ladder.maxX <= platform.maxX + TOLERANCE_M
      )
    }
    if (ladder.normalZ < 0) {
      return (
        Math.abs(ladder.minZ - platform.maxZ) < TOLERANCE_M &&
        ladder.minX >= platform.minX - TOLERANCE_M &&
        ladder.maxX <= platform.maxX + TOLERANCE_M
      )
    }
    return false
  })
}

/** 등반 법선에 **수직**인 축의 길이 — 이것이 GA-63의 "사다리 볼륨의 폭"이다
 * (법선 축 자체는 등반 방향이지 폭이 아니다). */
function lateralWidth(ladder: LadderVolume): number {
  return ladder.normalX !== 0 ? ladder.maxZ - ladder.minZ : ladder.maxX - ladder.minX
}

describe('전제 확인 — 플랫폼·사다리가 실제로 배치돼 있다(빈 배열이면 아래 골든이 공허하게 통과한다)', () => {
  it('PRODUCTION_PLATFORMS는 비어 있지 않다', () => {
    expect(PRODUCTION_PLATFORMS.length).toBeGreaterThan(0)
  })

  it('PRODUCTION_LADDERS는 비어 있지 않다(RQ-32 전제, 이미 그린이어야 한다)', () => {
    expect(PRODUCTION_LADDERS.length).toBeGreaterThan(0)
  })
})

describe('GA-61 — 모든 사다리가 어떤 플랫폼의 측면에 간격 0으로 접하고, 등반 법선이 그 플랫폼을 향한다', () => {
  it('각 사다리에 대해 법선 방향으로 간격 0 접촉하는 플랫폼이 존재한다', () => {
    for (const ladder of PRODUCTION_LADDERS) {
      const platform = findAdjacentPlatform(ladder, PRODUCTION_PLATFORMS)
      expect(platform, `사다리(normalX=${ladder.normalX}, normalZ=${ladder.normalZ}, x:[${ladder.minX},${ladder.maxX}], z:[${ladder.minZ},${ladder.maxZ}])에 접한 플랫폼을 찾지 못했다`).toBeDefined()
    }
  })

  it('음성 대조군 — 법선이 반대 방향인 가상 사다리는 어떤 프로덕션 플랫폼과도 이 조건을 만족하지 않는다(헬퍼가 실제로 방향을 구분한다는 증거, 항상 참을 반환하는 무성 구현을 배제)', () => {
    const reversed: LadderVolume = { ...LADDER_ALPHA, normalX: -LADDER_ALPHA.normalX, normalZ: -LADDER_ALPHA.normalZ }
    // 전제 확인 — 실제로 원래 법선과 반대다(항등이면 이 대조군이 무의미해진다).
    expect(reversed.normalX).not.toBe(LADDER_ALPHA.normalX)
    expect(findAdjacentPlatform(reversed, PRODUCTION_PLATFORMS)).toBeUndefined()
  })

  it('회귀 안전 대역 — 어떤 플랫폼도 PRODUCTION_BOXES(점프 등반용, GA-53: topY ≤ 1.0m)와 참조 동일하지 않다(별도 컬렉션이어야 한다)', () => {
    for (const platform of PRODUCTION_PLATFORMS) {
      expect(PRODUCTION_BOXES).not.toContain(platform)
    }
  })
})

describe('GA-62 — 플랫폼 윗면 높이가 접한 사다리 상단과 같고, 플랫폼 수가 사다리 수와 같다', () => {
  it('플랫폼 개수가 사다리 개수와 정확히 같다', () => {
    expect(PRODUCTION_PLATFORMS.length).toBe(PRODUCTION_LADDERS.length)
  })

  it('각 사다리에 대해, 접한 플랫폼의 topY가 그 사다리의 maxY와 같다', () => {
    for (const ladder of PRODUCTION_LADDERS) {
      const platform = findAdjacentPlatform(ladder, PRODUCTION_PLATFORMS)
      expect(platform).toBeDefined()
      expect(platform!.topY).toBeCloseTo(ladder.maxY, 9)
    }
  })
})

describe('GA-63(spec: RQ-32) — 사다리 볼륨의 폭은 1.5m이고, 접한 플랫폼 측면의 좌우 어느 쪽으로도 치우치지 않는다', () => {
  /** 골든이 명시한 값 자체 — 리터럴 허용(작업 지시 예외). */
  const EXPECTED_LADDER_WIDTH_M = 1.5

  it('각 사다리의 폭(법선에 수직인 축의 길이)이 정확히 1.5m다', () => {
    for (const ladder of PRODUCTION_LADDERS) {
      expect(lateralWidth(ladder)).toBeCloseTo(EXPECTED_LADDER_WIDTH_M, 9)
    }
  })

  it('그 폭이 접한 플랫폼의 대응 축 범위 안에서 좌우 대칭으로 위치한다(양쪽 여유가 같다 — 어느 한쪽으로도 치우치지 않는다)', () => {
    for (const ladder of PRODUCTION_LADDERS) {
      const platform = findAdjacentPlatform(ladder, PRODUCTION_PLATFORMS)
      expect(platform).toBeDefined()

      if (ladder.normalX !== 0) {
        const marginMin = ladder.minZ - platform!.minZ
        const marginMax = platform!.maxZ - ladder.maxZ
        // 전제 확인 — 플랫폼이 사다리보다 실제로 넓어 "치우침"을 구별할
        // 여지가 있다(둘 다 폭이 같으면 여유가 항상 0=0으로 이 단언이
        // 공허해진다).
        expect(marginMin).toBeGreaterThan(0)
        expect(marginMax).toBeGreaterThan(0)
        expect(marginMin).toBeCloseTo(marginMax, 6)
      } else {
        const marginMin = ladder.minX - platform!.minX
        const marginMax = platform!.maxX - ladder.maxX
        expect(marginMin).toBeGreaterThan(0)
        expect(marginMax).toBeGreaterThan(0)
        expect(marginMin).toBeCloseTo(marginMax, 6)
      }
    }
  })
})
