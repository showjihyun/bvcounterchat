import { describe, expect, it } from 'vitest'
import type { BoxAABB } from '@shared/sim/movement'
import { MOVEMENT } from '@shared/constants'
import { PRODUCTION_BOXES } from '@shared/sim/boxes'
import { PRODUCTION_LADDERS } from '@shared/sim/ladders'
import { PRODUCTION_WALLS } from '@shared/sim/walls'
import { SPAWN_POINTS } from '@shared/sim/spawn'
import { computeRadialEscape } from '../support/safe-zone'

/**
 * RQ-32 맵 배치 계약 — 사다리 2개·박스 클러스터 3곳(클러스터당 4~6개)·
 * 박스 상단 높이 상한(GA-53). 순수 데이터 검증(ADR-0008: `src/shared`
 * 정적 지오메트리, 환경 중립 — 서버 기동 없이 프로덕션 배열 자체를
 * 읽는다).
 *
 * 매핑된 골든 케이스 **GA-53**(`harness/evals/golden/track-a-product
 * .jsonl:53`, `verify` 필드가 이 파일 경로를 정확히 지정):
 * - given: 맵에 박스 클러스터가 배치되어 있고 점프 높이가 1.0m(RQ-92)
 * - when: 등록된 모든 박스의 콜라이더 상단 높이를 검사
 * - then: 모든 박스의 상단 높이가 1.0m 이하다
 *
 * RQ-32 전문(`harness/specs/requirements.md:148-150`): "맵에는 사다리
 * 2개와 박스 클러스터 3곳(클러스터당 4~6개 박스)이 배치되어야 한다.
 * 박스 높이는 점프 높이 1.0m(RQ-92)로 등반 가능한 치수여야 한다."
 *
 * **현재 상태(팀리드 확인)**: `@shared/sim/boxes`의 `PRODUCTION_BOXES`는
 * 박스 1개(`BOX_ALPHA`), `@shared/sim/ladders`의 `PRODUCTION_LADDERS`는
 * 사다리 1개(`LADDER_ALPHA`)뿐이다 — 이 파일의 카운트·클러스터링 단언은
 * 오늘 코드베이스에서 **실패한다**(Red, 그린필드가 아니라 기존 잠정
 * 배치의 확장).
 *
 * ---
 *
 * ## 제안 좌표(coder에게 — 이 값으로 구현할 것. `PRODUCTION_BOXES`/
 * `PRODUCTION_LADDERS` 확장 제안, 강제 아님 — 아래 단언은 이 정확한
 * 리터럴을 검사하지 않고 **구조적 성질**만 검사한다, ADR-0010 정신)
 *
 * 기존 `BOX_ALPHA`(x:[11,14], z:[8,11], topY:0.4)·`LADDER_ALPHA`
 * (x:[-14,-13], z:[8,11])는 그대로 두고 아래를 더한다:
 *
 * ```ts
 * // src/shared/sim/ladders.ts — LADDER_ALPHA 옆에 추가
 * export const LADDER_BRAVO: LadderVolume = { minX: -14, maxX: -13, minZ: -11, maxZ: -8, minY: 0, maxY: 4, normalX: 1, normalZ: 0 }
 * export const PRODUCTION_LADDERS: readonly LadderVolume[] = [LADDER_ALPHA, LADDER_BRAVO]
 *
 * // src/shared/sim/boxes.ts — BOX_ALPHA를 클러스터 ALPHA의 일부로 포함, 4개 추가
 * export const BOX_ALPHA_2: BoxAABB = { minX: 11, maxX: 14, minZ: 11.3, maxZ: 14.3, topY: 0.5 }
 * export const BOX_ALPHA_3: BoxAABB = { minX: 14.3, maxX: 17.3, minZ: 8, maxZ: 11, topY: 0.6 }
 * export const BOX_ALPHA_4: BoxAABB = { minX: 14.3, maxX: 17.3, minZ: 11.3, maxZ: 14.3, topY: 0.7 }
 * export const BOX_ALPHA_5: BoxAABB = { minX: 11, maxX: 14, minZ: 14.6, maxZ: 17.6, topY: 0.35 }
 *
 * export const BOX_BRAVO_1: BoxAABB = { minX: 11, maxX: 14, minZ: -11, maxZ: -8, topY: 0.4 }
 * export const BOX_BRAVO_2: BoxAABB = { minX: 11, maxX: 14, minZ: -14.3, maxZ: -11.3, topY: 0.5 }
 * export const BOX_BRAVO_3: BoxAABB = { minX: 14.3, maxX: 17.3, minZ: -11, maxZ: -8, topY: 0.6 }
 * export const BOX_BRAVO_4: BoxAABB = { minX: 14.3, maxX: 17.3, minZ: -14.3, maxZ: -11.3, topY: 0.7 }
 * export const BOX_BRAVO_5: BoxAABB = { minX: 11, maxX: 14, minZ: -17.6, maxZ: -14.6, topY: 0.35 }
 *
 * export const BOX_CHARLIE_1: BoxAABB = { minX: -3, maxX: 0, minZ: 8, maxZ: 11, topY: 0.4 }
 * export const BOX_CHARLIE_2: BoxAABB = { minX: 0.3, maxX: 3.3, minZ: 8, maxZ: 11, topY: 0.5 }
 * export const BOX_CHARLIE_3: BoxAABB = { minX: 3.6, maxX: 6.6, minZ: 8, maxZ: 11, topY: 0.6 }
 * export const BOX_CHARLIE_4: BoxAABB = { minX: -3, maxX: 0, minZ: 11.3, maxZ: 14.3, topY: 0.7 }
 * export const BOX_CHARLIE_5: BoxAABB = { minX: 0.3, maxX: 3.3, minZ: 11.3, maxZ: 14.3, topY: 0.35 }
 *
 * export const PRODUCTION_BOXES: readonly BoxAABB[] = [
 *   BOX_ALPHA, BOX_ALPHA_2, BOX_ALPHA_3, BOX_ALPHA_4, BOX_ALPHA_5,       // 클러스터 ALPHA(5)
 *   BOX_BRAVO_1, BOX_BRAVO_2, BOX_BRAVO_3, BOX_BRAVO_4, BOX_BRAVO_5,     // 클러스터 BRAVO(5)
 *   BOX_CHARLIE_1, BOX_CHARLIE_2, BOX_CHARLIE_3, BOX_CHARLIE_4, BOX_CHARLIE_5, // 클러스터 CHARLIE(5)
 * ]
 * ```
 *
 * **클러스터 3곳 구성**: ALPHA(x:[11,17.3], z:[8,17.6], 기존 `BOX_ALPHA`
 * 포함)·BRAVO(x:[11,17.3], z:[-17.6,-8], ALPHA를 z=0 기준으로 반사)·
 * CHARLIE(x:[-3,6.6], z:[8,14.3], 원점 근처 북쪽). **REV(리뷰 minor 1
 * 대응, 실측 재검산)**: 각 클러스터를 연결하는 데 필요한 인접쌍 간격은
 * 0.3~0.4243m(그리드 이웃)이지만, 클러스터 **내부**의 모든 쌍이 그런
 * 것은 아니다 — 비인접(대각선) 쌍의 최댓값은 세 클러스터 전부 동일하게
 * **3.6125m**다(ALPHA: `BOX_ALPHA_3`↔`BOX_ALPHA_5`, BRAVO: `BOX_BRAVO_3`
 * ↔`BOX_BRAVO_5`, CHARLIE: `BOX_CHARLIE_3`↔`BOX_CHARLIE_4`). 클러스터
 * 사이 최소 간격은 4.4m(`BOX_ALPHA`↔`BOX_CHARLIE_3`)다. 그럼에도 아래
 * "클러스터링" 절의 문턱(2m)이 세 그룹을 명확히 가른다 — 각 클러스터는
 * 인접쌍(**0.3m 간선 4개**로 MST 병목이 정확히 0.3m — 세 클러스터 전부
 * 동일, 오케스트레이터 재검산)만으로 이미 최소신장트리가 완성되므로(예: ALPHA는
 * `BOX_ALPHA`-`BOX_ALPHA_2`-`BOX_ALPHA_3`-`BOX_ALPHA_4`,
 * `BOX_ALPHA_2`-`BOX_ALPHA_5`의 4개 간선, 최대 가중치 0.3m로 5개 박스
 * 전부 연결) union-find는 3.6125m 대각선 간선 없이도 전이적으로 하나가
 * 되고, 문턱(2m)은 그 연결 간선(**0.3m**)보다 크면서 클러스터 사이
 * 최소 간격(4.4m)보다는 작은 범위(0.4243m, 4.4m) 안이면 항상 같은
 * 결과를 낸다(문턱 값 자체에 배치가 결합되지 않는다 — 이전 판의 "내부
 * 간격은 항상 0.3m"라는 문구는 이 구분을 흐렸다). 높이는 전부
 * **0.35~0.70m**(모두 GA-53 상한 1.0m 아래, 아래 "GA-53 실효 상한" 절
 * 참고 — 그 상한(≈0.99736660m)에는 의도적으로 닿지 않는다).
 *
 * ## 회귀 안전 대역(런타임 값 기준 재계산, 팀리드 지시 — 리터럴 grep이
 * 아니라 각 파일의 실제 산술로 재계산)
 *
 * - **`PRODUCTION_WALLS`**(`@shared/sim/walls`, x/z 15~16 대역, 각 벽의
 *   수직축은 [-5,5]로 제한): 새 지오메트리는 전부 x∈[-3,17.3]·
 *   z∈[-17.6,17.6] 범위인데, 벽과 겹치려면 겹치는 축(x 또는 z)이 벽의
 *   15~16 대역 **그리고** 수직축이 [-5,5] 안이어야 한다 — 새 클러스터의
 *   z는 항상 |z|≥8(WALL_EAST/WEST의 z 조건 밖) 또는 x는 항상 x≤6.6<15
 *   (WALL_NORTH/SOUTH의 x 조건과 무관, z가 15~16 대역에 걸치는 BOX_ALPHA_5
 *   조차 x∈[11,14]가 WALL_NORTH·SOUTH의 x∈[-5,5] 밖이라 무관) — 아래
 *   "겹치지 않는다" 테스트가 이를 전수 확인한다.
 * - **`SPAWN_POINTS`**(15개, 반경 21.9~22.6m, `@shared/sim/spawn`):
 *   **REV(리뷰 minor 1 대응, 15개 전수 실측 재검산)** — 가장 가까운 것은
 *   인덱스2 `(15,16)`과 인덱스13 `(15,-16)`이 각각 `BOX_ALPHA_5`·
 *   `BOX_BRAVO_5`로부터 **정확히 1.000m로 동률**이다(대칭 배치라 당연 —
 *   이전 판은 인덱스13만 "≈1.8m"로 적고 대칭인 인덱스2를 누락했다).
 *   겹치지는 않는다(거리>0). 그 외 13개는 전부 2.7m 이상 떨어져 있다
 *   (최댓값 인덱스11 `(-2,-22)`≈13.7m) — 아래 테스트가 15개 전부와
 *   `PRODUCTION_BOXES`/`PRODUCTION_LADDERS`의 겹침을 직접 확인한다(정적
 *   리터럴 grep이 아니라 실제 `SPAWN_POINTS` 배열 값으로).
 * - **탈출 지점**(스폰 × 반사방향 6m, `tests/support/safe-zone.ts`
 *   `computeRadialEscape`, 반경 ~28m): 스폰보다 더 바깥이라 위 스폰
 *   확인이 통과하면 탈출 지점은 자동으로 더 안전하지만, 방사 방향이
 *   반드시 "더 바깥"만을 뜻하지는 않으므로(각도가 유지된 채 반경만
 *   커진다) 별도로 전수 확인한다.
 * - **`IN_MAP_SPOOF`**(`{x:12.5, z:-12.5}`, `rq-61-server-authoritative
 *   -position.test.ts`): 이 좌표는 정지 입력(`dirX=dirZ=0`)과 함께
 *   오는 참칭 좌표라 실제로 이동하지 않는다(`@shared/sim/boxes` 기존
 *   docblock과 동일 근거) — `BOX_BRAVO_2`(x:[11,14], z:[-14.3,-11.3])
 *   의 사각형 안에 수치상 들어가지만(x=12.5, z=-12.5), 서버가 그 필드를
 *   읽지 않으므로 이 겹침은 기능에 영향이 없다(무관, 전수 조사 대상이
 *   아니다 — 기존 파일들과 동일한 결론).
 *
 * ## 클러스터링(그룹핑) 방법 — 이 파일 전용, `src/`에 없음
 *
 * "클러스터 3곳"은 `PRODUCTION_BOXES`가 스스로 그룹 라벨을 갖지 않으므로
 * (평평한 `BoxAABB[]`), 이 파일이 순수 기하로 그룹을 재구성한다: 두
 * 박스의 **간격**(사각형이 겹치거나 붙어 있으면 0, 아니면 가장 가까운
 * 변 사이 유클리드 거리)이 `CLUSTER_GAP_THRESHOLD_M`(2m) 미만이면 같은
 * 클러스터로 묶는다(전이적 — union-find). 제안 좌표는 클러스터 내부
 * 간격이 항상 0.3m, 클러스터 사이 최소 간격이 4.4m 이상이라 2m 문턱이
 * 둘을 명확히 가른다(그 사이 어떤 값을 골라도 결과가 같다 — 문턱 값
 * 자체에 배치가 결합되지 않는다).
 *
 * ## GA-53 실효 상한(문면 결함, 고치지 않는다 — 실측만, 팀리드 지시)
 *
 * GA-53의 `then`은 "1.0m **이하**"(`topY <= 1.0`)이지만, 이산 틱(30Hz)
 * 샘플링에서 실제로 도달 가능한 최고 높이는 `t=9/30초` 지점의
 * **0.99736660m**(정밀 계산 — `JUMP_V0_MPS=√(2×20×1.0)=6.324555320336759`,
 * `y(9/30)=6.324555320336759×0.3-10×0.3²=0.9973665961010276` — `t=10/30`은
 * 0.99707400으로 더 낮다, 연속 함수의 진짜 정점 1.0m은 `t=0.316228초`인데
 * 어느 틱도 정확히 이 시각에 오지 않는다). **REV(리뷰 major 1 대응)** —
 * 이전 판(≈0.997368)은 `JUMP_V0_MPS`를 6.32456으로 반올림해 참값보다
 * 1.404×10⁻⁶m **더 큰**(관대한) 값을 썼다 — `topY∈[0.99736660,
 * 0.997368)` 구간의 박스가 그 상수로는 "안전"으로 통과하지만 실제로는
 * 오를 수 없는 사각지대가 있었다(경계를 검사하는 상수가 경계보다 크면
 * 안 된다). 아래 `DISCRETE_CLIMB_CEILING_M`을 참값 이하(`0.9973665`)로
 * 정정했다 — 오케스트레이터 독립 검산 + 평가자의 실제 `stepMovement`
 * 이분 탐색(60회)이 같은 참값에 수렴함을 확인했다.
 * 즉 **topY=1.0m인 박스는 GA-53(≤1.0m)을 통과하지만 실제로는 오를 수
 * 없다**(RQ-32 "등반 가능한 치수"와 모순). **위 제안 좌표는 이 경계에
 * 닿지 않는다** — 가장 높은 박스도 0.7m로, 실효 상한(0.99736660m)에서
 * 0.29736660m(≈0.297m) 여유가 있다(실측: 아래 "GA-53" describe가 이
 * 여유를 직접 확인한다). 이 파일은 GA-53 문면 그대로(`<= MOVEMENT
 * .JUMP_HEIGHT`)만 단언한다 — 문면 개정은 사람 몫이라 이 라운드가
 * 임의로 고치지 않는다(오케스트레이터가 사용자에게 올린다).
 *
 * **결정론(ADR-0008)**: 이 파일은 `stepMovement`를 호출하지 않는다 —
 * 정적 배열의 구조적 성질(개수·상한·간격)만 검사하는 순수 데이터
 * 검증이라 별도 결정론 증명이 필요 없다.
 */

const CLUSTER_GAP_THRESHOLD_M = 2

/** 두 박스 사각형 사이의 최소 간격(m) — 겹치거나 붙어 있으면 0. */
function gapDistance(a: BoxAABB, b: BoxAABB): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0)
  const dz = Math.max(a.minZ - b.maxZ, b.minZ - a.maxZ, 0)
  return Math.hypot(dx, dz)
}

/** union-find 기반 클러스터링 — `gapDistance`가 `thresholdM` 미만인
 * 박스끼리 전이적으로 묶는다. */
function groupIntoClusters(boxes: readonly BoxAABB[], thresholdM: number): BoxAABB[][] {
  const n = boxes.length
  const parent = Array.from({ length: n }, (_, i) => i)
  function find(i: number): number {
    let root = i
    while (parent[root] !== root) root = parent[root]!
    let cur = i
    while (parent[cur] !== root) {
      const next = parent[cur]!
      parent[cur] = root
      cur = next
    }
    return root
  }
  function union(a: number, b: number): void {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (gapDistance(boxes[i]!, boxes[j]!) < thresholdM) union(i, j)
    }
  }
  const groups = new Map<number, BoxAABB[]>()
  for (let i = 0; i < n; i += 1) {
    const root = find(i)
    const list = groups.get(root) ?? []
    list.push(boxes[i]!)
    groups.set(root, list)
  }
  return [...groups.values()]
}

function rectsOverlap(
  a: { minX: number; maxX: number; minZ: number; maxZ: number },
  b: { minX: number; maxX: number; minZ: number; maxZ: number },
): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ
}

/** 개방구간 포함 — `standingHeight`/`clampAgainstWalls`(`@shared/sim
 * /movement`)와 동일한 관례(경계 값은 "안"이 아니다). */
function pointInOpenRect(p: { x: number; z: number }, r: { minX: number; maxX: number; minZ: number; maxZ: number }): boolean {
  return p.x > r.minX && p.x < r.maxX && p.z > r.minZ && p.z < r.maxZ
}

describe('GA-53 — 박스 상단 높이 상한 (RQ-32, MOVEMENT.JUMP_HEIGHT)', () => {
  it('전제 확인 — 박스 클러스터가 실제로 배치돼 있다(빈 배열이면 이 골든이 공허하게 통과한다)', () => {
    expect(PRODUCTION_BOXES.length).toBeGreaterThan(0)
  })

  it('등록된 모든 박스의 상단 높이(topY)가 점프 높이(1.0m) 이하다', () => {
    for (const box of PRODUCTION_BOXES) {
      expect(box.topY).toBeLessThanOrEqual(MOVEMENT.JUMP_HEIGHT)
    }
  })

  /** 이산 틱 실효 등반 상한(위 docblock "GA-53 실효 상한" 절, 참값
   * 0.9973665961010276 — 오케스트레이터 독립 검산 + 평가자의 실제
   * `stepMovement` 이분 탐색 60회가 같은 값에 수렴함을 확인). `movement
   * .ts`의 `JUMP_GRAVITY_MPS2`(20)는 비공개 구현값이라 이 파일이 직접
   * 참조할 수 없다 — GA-53 문면 자체가 "구현 자유"로 남긴 값이므로,
   * 이 테스트는 그 정확한 상수를 재도출하지 않고 **참값 이하**의
   * 안전측 상수(`0.9973665`, 리뷰어 제안값 — 경계를 검사하는 상수가
   * 참값보다 크면(관대하면) 그 사이 구간의 박스를 잘못 "안전"으로
   * 통과시킨다, 리뷰 major 1 정정)에 대해 "이 배치가 그 경계에
   * 닿는지"만 확인한다. */
  it('제안 배치는 GA-53의 문면 결함(정확히 1.0m는 통과하지만 못 오르는 경계, 실효 상한 ≈0.99736660m)에 닿지 않는다 — 모든 박스가 그 상한보다 여유 있게 낮다', () => {
    // 리뷰 major 1 정정 — 참값(0.9973665961010276) 이하로 재조정한다.
    // 이전 값(0.997368)은 `JUMP_V0_MPS`를 6.32456으로 반올림해 참값보다
    // 1.404e-6m 커서, 그 사이 구간의 topY를 "안전(경계 밖)"으로
    // 오판할 수 있었다(위 docblock "GA-53 실효 상한" REV 절 참고).
    const DISCRETE_CLIMB_CEILING_M = 0.9973665
    for (const box of PRODUCTION_BOXES) {
      expect(box.topY).toBeLessThan(DISCRETE_CLIMB_CEILING_M)
    }
  })
})

describe('RQ-32 — 배치 카운트(사다리 2개, 박스 12~18개 = 클러스터 3곳 × 4~6개)', () => {
  it('사다리는 정확히 2개다', () => {
    expect(PRODUCTION_LADDERS.length).toBe(2)
  })

  it('박스는 12~18개다(클러스터 3곳 × 클러스터당 4~6개의 하한·상한)', () => {
    expect(PRODUCTION_BOXES.length).toBeGreaterThanOrEqual(3 * 4)
    expect(PRODUCTION_BOXES.length).toBeLessThanOrEqual(3 * 6)
  })
})

describe('RQ-32 — 박스 클러스터는 정확히 3곳이고, 클러스터당 4~6개다', () => {
  it('간격 기반 그룹핑 결과가 정확히 3개 그룹이고, 각 그룹의 박스 수가 4~6개다', () => {
    const clusters = groupIntoClusters(PRODUCTION_BOXES, CLUSTER_GAP_THRESHOLD_M)

    expect(clusters.length).toBe(3)
    for (const cluster of clusters) {
      expect(cluster.length).toBeGreaterThanOrEqual(4)
      expect(cluster.length).toBeLessThanOrEqual(6)
    }
  })

  it('양성 대조군 — 문턱을 클러스터 내부 최대 간격보다도 작게(0.05m) 줄이면 그룹 수가 3보다 많아진다(문턱이 실제로 그룹핑에 영향을 준다는 것 자체를 확인 — 항상 3을 반환하는 무성 구현을 배제)', () => {
    const clustersWithTinyThreshold = groupIntoClusters(PRODUCTION_BOXES, 0.05)
    expect(clustersWithTinyThreshold.length).toBeGreaterThan(3)
  })
})

describe('회귀 안전 대역 — 새 박스·사다리가 기존 벽·스폰 지점·탈출 지점과 겹치지 않는다(런타임 값 기준)', () => {
  it('어떤 박스도 PRODUCTION_WALLS의 어떤 벽과도 겹치지 않는다', () => {
    for (const box of PRODUCTION_BOXES) {
      for (const wall of PRODUCTION_WALLS) {
        expect(rectsOverlap(box, wall)).toBe(false)
      }
    }
  })

  it('어떤 사다리도 PRODUCTION_WALLS의 어떤 벽과도 겹치지 않는다', () => {
    for (const ladder of PRODUCTION_LADDERS) {
      for (const wall of PRODUCTION_WALLS) {
        expect(rectsOverlap(ladder, wall)).toBe(false)
      }
    }
  })

  it('SPAWN_POINTS(15개) 중 어느 것도 박스·사다리의 XZ 범위(개방구간) 안에 있지 않다', () => {
    for (const spawn of SPAWN_POINTS) {
      for (const box of PRODUCTION_BOXES) {
        expect(pointInOpenRect(spawn, box)).toBe(false)
      }
      for (const ladder of PRODUCTION_LADDERS) {
        expect(pointInOpenRect(spawn, ladder)).toBe(false)
      }
    }
  })

  it('각 스폰 지점의 방사 탈출 지점(computeRadialEscape, 기본 오프셋 6m)도 어느 것도 박스·사다리의 XZ 범위 안에 있지 않다', () => {
    for (const spawn of SPAWN_POINTS) {
      const escape = computeRadialEscape(spawn)
      for (const box of PRODUCTION_BOXES) {
        expect(pointInOpenRect(escape, box)).toBe(false)
      }
      for (const ladder of PRODUCTION_LADDERS) {
        expect(pointInOpenRect(escape, ladder)).toBe(false)
      }
    }
  })
})
