import { describe, expect, it } from 'vitest'
import { findClosestWallHit, type Ray, type WallHit } from '@shared/sim/combat'
import type { WallAABB } from '@shared/sim/movement'

/**
 * RQ-70/RQ-71 공통 — 「명중 지점의 출처」 절(`requirements.md` §8 v2.7) +
 * ADR-0016 결정 1 후속 1 — **벽 명중 지점·법선 산출** 순수 산술 단위 테스트
 * (ADR-0008: 순수 함수·결정론·`src/shared` 환경 중립. ADR-0011: `src/shared`
 * 전체가 Red-first 영역).
 *
 * **골든 역참조 없음 — 의도적이다.** GA-96~100(`track-a-product.jsonl`)은
 * 전부 "탄흔·피격 컬렉터의 행동"(FIFO 상한·TTL·이벤트 소비·배선)을
 * 검증한다 — 이 파일이 고정하는 "벽 교차 지점·법선을 어떻게 계산하는가"
 * 자체를 요구하는 골든은 없다. 그런데도 이 파일이 필요한 이유는 ADR-0016이
 * 스스로 못박은 실측 때문이다: "서버는 오늘 벽의 명중 지점을 계산하지
 * 않는다 — 새로 만들어야 한다"(`requirements.md` §8)·"그 산출 경로 신설이
 * 이 라운드 작업량의 대부분이다"(ADR-0016 맥락 절) — GA-98(이벤트 소비)·
 * GA-100(배선)이 딛고 설 지반 자체가 오늘 존재하지 않는다. ADR-0011은
 * "서버 판정 로직"뿐 아니라 `src/shared` 전체를 Red-first로 규정하므로
 * (CLAUDE.md TDD 절), 골든 미매핑과 무관하게 이 신규 로직도 Red가 먼저다.
 *
 * **그린필드 계약(test-writer 지정 — `sim-combat-occlusion.test.ts`가
 * `findClosestHit`에 4번째 인자 `walls`를 추가한 것과 동일한 권한. 기존
 * `findClosestHit`·`intersectWallXZ`(모듈 비공개)는 건드리지 않는다 —
 * 완전히 새로운 export를 더할 뿐이다, 회귀 없음):**
 *
 * ```ts
 * // src/shared/sim/combat.ts (신규 export)
 * export interface WallHit {
 *   distance: number // 레이 원점 ~ 명중 지점 거리(m) — raycastHitbox.distance와 동일 단위
 *   point: Vec3       // origin + direction·distance (direction은 정규화된 단위 벡터 전제)
 *   normal: Vec3       // 벽 표면의 바깥쪽 법선 — 아래 "법선 규칙" 참고
 * }
 *
 * // ray가 지나는 walls 중 가장 가까이 교차하는 벽의 명중 지점·법선.
 * // 교차하는 벽이 없으면(전부 평행 배제·전방 배제 등으로 제외) undefined.
 * // 플레이어 후보와 무관 — 순수 벽 전용 함수다(findClosestHit과 독립).
 * export function findClosestWallHit(ray: Ray, walls: readonly WallAABB[]): WallHit | undefined
 * ```
 *
 * **산출 공식(ADR-0016 결정 1 후속 1·`requirements.md` §8이 이미 못박은
 * 그대로 — 발명이 아니라 직역이다):**
 * - **좌표**: `origin + direction·t`(`t`=슬랩(slab) 교차 진입 거리) — 이는
 *   `raycastHitbox`가 플레이어 명중점을 만드는 식과 **완전히 같은 산술**이다
 *   (`combat.ts` 기존 `raycastHitbox`의 `point` 계산부 참고). 벽의 Y 필드가
 *   필요 없다(`WallAABB`에 `minY`/`maxY`가 없다 — 무한 높이 기둥, `@shared
 *   /sim/walls` "2D(XZ) 전용" 문서와 동일 가정. ⚠️ **여기에 Y를 추가하는
 *   방향으로 구현하지 않는다** — ADR-0013 "벽=무한 기둥/박스=유한" 어휘와
 *   이동 충돌 계층이 걸린다).
 * - **법선**: 최종 `tMin`을 **결정한 축**(x 슬랩 vs z 슬랩, `intersectWallXZ`의
 *   `tMin = Math.max(tMin, Math.min(t1,t2))` 갱신에서 실제로 그 값을 바꾼
 *   쪽)이 x축이면 `normal = (-sign(direction.x), 0, 0)`, z축이면
 *   `normal = (0, 0, -sign(direction.z))`다 — 유도: 레이가 어느 면으로
 *   "먼저" 들어가는지는 그 축의 진행 방향(`direction`의 부호)이 정하고,
 *   진입면의 바깥쪽 법선은 항상 그 진행 방향과 반대다(사수 쪽을 향한다).
 *   아래 각 `it()`이 이 부호 규칙을 두 축·양방향(총 4가지 조합)으로
 *   검산한다.
 * - **전방·평행 배제**는 기존 `intersectWallXZ`(비공개)가 이미 검증된
 *   방식으로 처리한다(`sim-combat-occlusion.test.ts`가 그 산술을 이미
 *   고정) — 이 함수는 그 존재하는 슬랩 교차 산술을 재사용해 **어느 축이
 *   이겼는지**와 **그 지점의 좌표**만 추가로 노출하면 된다(구현 방식은
 *   coder 재량 — 내부에서 `intersectWallXZ`를 리팩터링하든 별도로 두든
 *   이 파일은 규정하지 않는다, 관측 가능한 입출력만 고정).
 *
 * **스코프 밖**: 여러 벽이 정확히 같은 거리에서 교차하는 동률(tie) 케이스,
 * 모서리(x·z 슬랩이 정확히 같은 tMin)의 법선 — RQ-70/71 어느 골든도
 * 이 경계를 요구하지 않는다(YAGNI, CLAUDE.md 스코프 규율).
 *
 * **스펙 질문 — 없음.** ADR-0016·requirements.md §8이 공식을 직접
 * 못박았다(추측이 아니라 직역).
 */

/** 손으로 검산 가능한 벽 4종 — 원점(사수)에서 각 축·부호로 쏘아 4가지 법선
 * 부호 조합을 모두 덮는다. 두께 1m(교차 거리 계산과 무관 — 진입면만 본다),
 * 폭 4m(레이가 항상 중앙을 지나 슬랩 안쪽으로 들어가게 여유를 둔다). */
const WALL_PLUS_X: WallAABB = { minX: 5, maxX: 6, minZ: -2, maxZ: 2 }
const WALL_MINUS_X: WallAABB = { minX: -6, maxX: -5, minZ: -2, maxZ: 2 }
const WALL_PLUS_Z: WallAABB = { minX: -2, maxX: 2, minZ: 5, maxZ: 6 }
const WALL_MINUS_Z: WallAABB = { minX: -2, maxX: 2, minZ: -6, maxZ: -5 }

/** 사수 원점 — y=1(임의의 눈높이 대역, 벽은 무한 높이라 y는 그대로 레이를
 * 따라간다는 것만 확인하면 된다). */
const ORIGIN = { x: 0, y: 1, z: 0 }

describe('RQ-70/71 신규 — findClosestWallHit: 벽 명중 지점·법선 산출(순수 산술, 골든 미매핑 — 파일 상단 근거)', () => {
  it('x 슬랩이 tMin을 결정(+x 방향 사격) — 점은 origin+dir·t, 법선은 (-1,0,0)', () => {
    const ray: Ray = { origin: ORIGIN, direction: { x: 1, y: 0, z: 0 } }
    const hit = findClosestWallHit(ray, [WALL_PLUS_X])

    expect(hit).toBeDefined()
    expect((hit as WallHit).distance).toBeCloseTo(5, 9)
    expect((hit as WallHit).point).toEqual({ x: 5, y: 1, z: 0 })
    expect((hit as WallHit).normal).toEqual({ x: -1, y: 0, z: 0 })
  })

  it('x 슬랩이 tMin을 결정(-x 방향 사격, 부호 반전) — 법선이 (+1,0,0)으로 뒤집힌다', () => {
    const ray: Ray = { origin: ORIGIN, direction: { x: -1, y: 0, z: 0 } }
    const hit = findClosestWallHit(ray, [WALL_MINUS_X])

    expect(hit).toBeDefined()
    expect((hit as WallHit).distance).toBeCloseTo(5, 9)
    expect((hit as WallHit).point).toEqual({ x: -5, y: 1, z: 0 })
    expect((hit as WallHit).normal).toEqual({ x: 1, y: 0, z: 0 })
  })

  it('z 슬랩이 tMin을 결정(+z 방향 사격) — 점은 origin+dir·t, 법선은 (0,0,-1)', () => {
    const ray: Ray = { origin: ORIGIN, direction: { x: 0, y: 0, z: 1 } }
    const hit = findClosestWallHit(ray, [WALL_PLUS_Z])

    expect(hit).toBeDefined()
    expect((hit as WallHit).distance).toBeCloseTo(5, 9)
    expect((hit as WallHit).point).toEqual({ x: 0, y: 1, z: 5 })
    expect((hit as WallHit).normal).toEqual({ x: 0, y: 0, z: -1 })
  })

  it('z 슬랩이 tMin을 결정(-z 방향 사격, 부호 반전) — 법선이 (0,0,+1)으로 뒤집힌다', () => {
    const ray: Ray = { origin: ORIGIN, direction: { x: 0, y: 0, z: -1 } }
    const hit = findClosestWallHit(ray, [WALL_MINUS_Z])

    expect(hit).toBeDefined()
    expect((hit as WallHit).distance).toBeCloseTo(5, 9)
    expect((hit as WallHit).point).toEqual({ x: 0, y: 1, z: -5 })
    expect((hit as WallHit).normal).toEqual({ x: 0, y: 0, z: 1 })
  })

  it('대각선 레이 — x 슬랩이 z 슬랩보다 늦게 열려(tMin) x면이 이긴다(축 판별이 "레이 방향"이 아니라 "실제로 tMin을 만든 슬랩"에서 나온다는 것을 검산)', () => {
    // wall: x∈[4,6], z∈[2,10]. dir=(1/√2,0,1/√2)일 때
    // x 슬랩 tMin=4/(1/√2)=4√2≈5.657, z 슬랩 tMin=2/(1/√2)=2√2≈2.828 → x가 더 크다(늦게 열림, tMin 결정).
    const wall: WallAABB = { minX: 4, maxX: 6, minZ: 2, maxZ: 10 }
    const s = Math.SQRT1_2
    const ray: Ray = { origin: { x: 0, y: 1, z: 0 }, direction: { x: s, y: 0, z: s } }

    const hit = findClosestWallHit(ray, [wall])

    expect(hit).toBeDefined()
    expect((hit as WallHit).distance).toBeCloseTo(4 * Math.SQRT2, 9)
    expect((hit as WallHit).point.x).toBeCloseTo(4, 9) // minX 면에 정확히 진입
    expect((hit as WallHit).point.z).toBeCloseTo(4, 9)
    expect((hit as WallHit).point.y).toBeCloseTo(1, 9)
    expect((hit as WallHit).normal).toEqual({ x: -1, y: 0, z: 0 })
  })

  it('대각선 레이 — z 슬랩이 x 슬랩보다 늦게 열려(tMin) z면이 이긴다(위 케이스의 축 반전 대조군)', () => {
    // wall: x∈[2,10], z∈[4,6]. 같은 대각선 방향에서 이번엔 z 슬랩이 늦게 열린다.
    const wall: WallAABB = { minX: 2, maxX: 10, minZ: 4, maxZ: 6 }
    const s = Math.SQRT1_2
    const ray: Ray = { origin: { x: 0, y: 1, z: 0 }, direction: { x: s, y: 0, z: s } }

    const hit = findClosestWallHit(ray, [wall])

    expect(hit).toBeDefined()
    expect((hit as WallHit).distance).toBeCloseTo(4 * Math.SQRT2, 9)
    expect((hit as WallHit).point.x).toBeCloseTo(4, 9)
    expect((hit as WallHit).point.z).toBeCloseTo(4, 9) // minZ 면에 정확히 진입
    expect((hit as WallHit).normal).toEqual({ x: 0, y: 0, z: -1 })
  })

  it('여러 벽 중 가장 가까운 것만 반환한다(관통 없음 — findClosestHit의 "가정 F"와 동일 정신)', () => {
    const near: WallAABB = WALL_PLUS_X // distance 5
    const far: WallAABB = { minX: 10, maxX: 11, minZ: -2, maxZ: 2 } // distance 10
    const ray: Ray = { origin: ORIGIN, direction: { x: 1, y: 0, z: 0 } }

    // 배열 순서를 뒤집어도(far가 먼저) 결과가 바뀌지 않는다 — 순서 의존
    // 구현(첫 교차만 채택 등)을 배제한다.
    const hitFarFirst = findClosestWallHit(ray, [far, near])
    const hitNearFirst = findClosestWallHit(ray, [near, far])

    expect(hitFarFirst).toEqual(hitNearFirst)
    expect((hitFarFirst as WallHit).distance).toBeCloseTo(5, 9)
    expect((hitFarFirst as WallHit).point).toEqual({ x: 5, y: 1, z: 0 })
  })

  it('교차하는 벽이 없으면(레이가 벽의 z 범위를 지나지 않음) undefined다', () => {
    const wall: WallAABB = { minX: 5, maxX: 6, minZ: 20, maxZ: 21 }
    const ray: Ray = { origin: ORIGIN, direction: { x: 1, y: 0, z: 0 } }

    expect(findClosestWallHit(ray, [wall])).toBeUndefined()
  })

  it('벽이 레이 뒤쪽(사수 뒤)에 있으면 undefined다(가정 B와 동일 정신 — intersectWallXZ가 이미 검증한 tMax<=0 배제)', () => {
    const wall: WallAABB = WALL_MINUS_X // x∈[-6,-5], 사수가 +x로 쏘면 뒤쪽이다
    const ray: Ray = { origin: ORIGIN, direction: { x: 1, y: 0, z: 0 } }

    expect(findClosestWallHit(ray, [wall])).toBeUndefined()
  })

  it('빈 벽 목록이면 undefined다(회귀 없음 — 기존 findClosestHit의 walls=[] 기본값과 동일 정신)', () => {
    const ray: Ray = { origin: ORIGIN, direction: { x: 1, y: 0, z: 0 } }

    expect(findClosestWallHit(ray, [])).toBeUndefined()
  })

  /**
   * **평가자 03 보고서 O1/M5 대응**(`_workspace/RQ-70-71/03_evaluator_report.md`
   * — "벽 명중점 y가 `origin.y` 고정" 변이가 1075/1075를 통과했다. 지금까지
   * 이 파일의 모든 케이스가 `dir.y=0`이라 `point.y === origin.y`가 "우연히"도
   * 성립해, `point.y`가 실제로 `origin.y + dir.y·t`로 레이에서 유도되는지가
   * 무검증이었다).
   *
   * `dir.y≠0`인 레이로 같은 벽(x 슬랩 진입)을 맞힌다 — XZ 평면상 교차 지점·
   * 진입 거리는 `dir.y`와 무관하므로(파일 상단 계약 "좌표=origin+dir·t", x·z
   * 슬랩 산술 자체가 y를 참조하지 않는다) x는 여전히 `WALL_PLUS_X.minX`(5)에서
   * 진입하지만, `point.y`는 `origin.y=5`가 **아니라** `5 + (-2/√5)·(5√5)=5-10=-5`여야
   * 한다 — `origin.y`로 고정하는 변이라면 5가 나와 이 단언이 즉시 죽는다.
   */
  it('O1/M5: dir.y≠0인 레이 — 명중점의 y는 origin.y로 고정되지 않고 origin.y + dir.y·t로 레이를 따라간다', () => {
    const ray: Ray = { origin: { x: 0, y: 5, z: 0 }, direction: { x: 1, y: -2, z: 0 } }
    const hit = findClosestWallHit(ray, [WALL_PLUS_X])

    expect(hit).toBeDefined()
    expect((hit as WallHit).distance).toBeCloseTo(5 * Math.sqrt(5), 6)
    expect((hit as WallHit).point).toEqual({ x: 5, y: -5, z: 0 }) // origin.y(5)가 아니라 -5 — dir.y가 실제로 반영됐다
    expect((hit as WallHit).normal).toEqual({ x: -1, y: 0, z: 0 })
  })
})
