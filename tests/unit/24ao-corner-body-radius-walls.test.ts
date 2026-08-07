import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveInput, type MoveState, type StaticGeometry, type WallAABB } from '@shared/sim/movement'
import { MOVEMENT, NET } from '@shared/constants'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { WALL_EAST, WALL_WEST, WALL_NORTH, WALL_SOUTH } from '@shared/sim/walls'

/**
 * 원장 24ao — 몸 반경 이동 판정: 벽 **모서리** 스침(원장 24af 독립 평가
 * 관찰 O4, `_workspace/24af/03_evaluator_report.md` §8 O4, 사용자가
 * 2026-08-07 "이번 라운드에서 마저 고치라"고 결정).
 *
 * **결함**: `clampAgainstWalls`(`src/shared/sim/movement.ts`)의 절단
 * **목표점**(`nearMinX` 등)은 원장 24af가 반경을 반영했지만, **어느
 * 축이 충돌인지 가르는 게이트**(`z > wall.minZ && z < wall.maxZ` — x축
 * 절단용, `x > wall.minX && x < wall.maxX` — z축 절단용)는 여전히
 * **원래 벽 경계 그대로**다. 벽 모서리를 대각으로 스치면(양쪽 축이
 * 동시에 원래 범위 밖) 두 게이트가 **동시에** 거짓이 되어 절단이 전혀
 * 발동하지 않는다 — 평가자 실측(O4): `z = maxZ + 0.05`(반경 0.3m보다
 * 훨씬 안쪽)로 벽 옆을 스치면 중심이 벽면에서 0.05m 거리로 통과한다.
 * 사용자가 보고한 "벽을 통과하는 듯한 느낌"의 원 증상이 이 모서리
 * 경로에서 그대로 재현된다(카메라 `near`=0.1m > 0.05m 간극이므로
 * 근평면이 벽 안을 자른다).
 *
 * **세울 명제**:
 * 1. 벽 모서리를 대각으로 스치는 경로에서도(매 틱 최솟값 누적, O1에서
 *    배운 형태 — 최종 상태만 보면 진동·순간 관통을 놓친다) 중심이 벽
 *    AABB에서 `bodyRadiusM` 이상 떨어져 있다.
 * 3. **보수적 근사(사각 민코프스키)의 대가를 명시적으로 고정한다.** 벽
 *    AABB를 반경만큼 사각으로(축별 독립) 팽창시키는 것이 이 저장소가
 *    이미 확립한 패턴(원장 24af, `nearMinX = wall.minX − R` 등)의
 *    자연스러운 연장이다 — 이렇게 하면 모서리가 **둥글지 않고 각진다**
 *    (민코프스키 합의 사각 근사). 정확히 대각 이등분선으로 모서리를
 *    향하면, 팽창된 두 반직선(사각 목표점)이 만나는 점은 원래 모서리에서
 *    최대 **`R√2`** 거리다 — ⚠️ **상한이지 관측값이 아니다.** 재평가 실측은
 *    대각에서도 **정확히 `R`**(0.300000)로, 몸이 팽창 면을 따라 미끄러져
 *    모서리에 걸리지 않는다. 원 모서리(반경만큼 등거리 원호)였다면
 *    `R`에서 멈췄을 것 — 차이는 `R(√2−1) ≈ 0.1243m`, `R=0.3` 기준). 이
 *    초과분은 **더 일찍 막히는 방향**(통과가 아니라 보수적 방향)이므로
 *    허용된다 — 그 사실을 상한 단언으로 고정해, 다음 사람이 "왜 살짝
 *    더 일찍 걸리지"를 결함으로 오인하지 않게 한다. 상한을 넘는(=
 *    사각 근사보다 **더** 과잉 차단하는) 구현은 이 상한이 잡는다.
 * 4. **기존 계약 유지** — 벽에서 반경보다 **더** 멀리(안전 여유 포함)
 *    스치는 경로는 여전히 막히지 않는다(양성 대조군, 회귀 가드).
 *
 * **명제 2(박스·플랫폼 모서리)는 별도 파일**
 * (`24ao-corner-body-radius-boxes-platforms.test.ts`)이 다룬다 — 이
 * 파일은 벽만 다룬다(파일당 단일 관심사, 24af 선례와 동일 관례).
 *
 * **좌표(ADR-0010 — 리터럴 금지)**: `WALL_EAST`/`WALL_WEST`/`WALL_NORTH`
 * /`WALL_SOUTH`(`@shared/sim/walls`, `PRODUCTION_WALLS`의 구성 요소) 정본을
 * 그대로 읽는다. 각 벽을 **개별로**(`walls: [wall]`) 주입해 벽 4개가
 * 서로 간섭하지 않는 격리된 관측을 만든다(벽끼리 15.8~16.8m 대역에
 * 흩어져 있어 실제로는 간섭할 일이 없지만, 명시적 격리가 더 읽기 쉽다).
 *
 * **접근 경로 설계 — "네 모서리 전부"의 스코프 해석**: 벽 하나당
 * 4개(2×2) 모서리가 있지만, 이 파일은 **벽마다 하나씩(4개 벽 × 1
 * 모서리 = 4케이스)**만 다룬다 — 원장 24af 명제 1이 "네 방향
 * (±X·±Z)"을 벽 4개 각각 하나의 대표 접근으로 다룬 것과 동일한 스코프
 * 판단이다. 근거: `clampAgainstWalls`의 x축 게이트·z축 게이트는 완전히
 * 대칭인 단일 `if` 문 하나씩이라(코드 실측, `movement.ts` 367-386행),
 * 같은 벽의 나머지 3개 모서리는 **같은 게이트 조건을 반대쪽 경계값에서
 * 트리거**할 뿐 새로운 코드 경로를 추가로 검증하지 않는다(예:
 * `WALL_EAST`의 (15,-5) 모서리는 (15,5)와 동일하게 x축 게이트의 같은
 * `if(z>minZ && z<maxZ)` 조건을 반대편에서 트리거한다). 4개 벽을 전부
 * 도는 것은 x축 게이트(EAST/WEST가 트리거)와 z축 게이트(NORTH/SOUTH가
 * 트리거) **양쪽 다** 결함이 있음을 확인하기 위해서다.
 *
 * **REV(검출력 실험 중 발견 — 대각 케이스만으로는 "절반만 고친" 구현을
 * 못 잡는다)**: 격리 워크트리에서 프로토타입 수정(양쪽 게이트를 모두
 * `near*`로 확장)을 심어 위 4개 대각 케이스가 전부 Green이 됨을
 * 확인한 뒤, **한쪽 게이트만** 고친 변형(x축 게이트만 또는 z축 게이트만
 * `near*`로 확장, 반대쪽은 원래 벽 경계 그대로) 두 가지를 각각 심어
 * 봤다 — **둘 다 4개 대각 케이스 전부를 여전히 통과시켰다.** 원인:
 * `clampAgainstWalls`는 x축 절단을 **먼저** 계산하고 z축 절단은 그
 * 결과(이미 절단됐을 수 있는 `x`)를 이어받는다(코드 367-386행 순서) —
 * 정확히 45도 대각(이 파일의 모든 케이스)에서는 두 축이 **같은 틱에**
 * 각자의 목표점을 넘으므로, 먼저 평가되는 x축 절단이 게이트만 맞으면
 * 단독으로 z까지 사실상 막아버려(절단된 x가 다시 z축 게이트의 원래
 * 범위 밖으로 밀려나) **한쪽 게이트만 고쳐도 대각 케이스는 다 통과한다**
 * — 대각 케이스만으로는 "양쪽 다 고쳤는가"를 구분하지 못한다(진짜
 * 검출력 공백, O1·O2와 같은 종류).
 *
 * **대응 — 평가자의 원 재현(직선 스침)을 게이트별로 분리해 추가한다.**
 * 아래 두 번째 `describe`(`24ao 명제 1 보강`)가 그것이다: **긴 축
 * 경계에서 반경 이내로 오프셋한 채 짧은 축으로만 이동**하는 순수
 * 직선(대각 아님) 경로 — 평가자 O4의 정확한 재현 형태(`z = maxZ +
 * 0.05`, `dirZ=0`)를 네 벽으로 일반화한 것이다. 이동축이 하나뿐이라
 * **반대쪽 게이트는 아예 평가되지 않는다**(예: EAST/WEST 스침은
 * `dirZ=0`이라 z가 전혀 안 바뀌므로 z축 절단 자체가 무관하다 — x축
 * 게이트만 시험한다) — 그래서 이 케이스들은 "한쪽만 고친" 변형을
 * **개별로** 정확히 가른다. 격리 워크트리에서 재확인: x축 게이트만
 * 고친 변형은 EAST/WEST 직선 스침에서 Green이지만 **NORTH/SOUTH
 * 직선 스침에서 Red**로 남고, z축 게이트만 고친 변형은 그 반대다 —
 * 두 게이트를 **모두** 고쳐야 4개 직선 스침 전부가 Green이 된다(§Red
 * 실행 출력·§검출력 실험 절 참고).
 *
 * **대각 케이스(첫 `describe`)는 폐기하지 않는다** — 명제 3(사각
 * 근사 상한 `R√2`)을 고정하는 유일한 수단이고, "완전 미수정" 상태는
 * 여전히 정확히 잡는다(오늘 실행 결과 `minDistance=0`, 아래 §Red 실행
 * 출력). 다만 "부분 수정"을 잡는 역할은 직선 스침 쪽으로 넘겼다는 것을
 * 이 문단이 기록한다.
 *
 * **레벨(ADR-0008)**: 순수 산술 — 단위. **결정론**: 정수 틱 반복만 사용,
 * `Math.random()`·`Date.now()` 없음.
 */

const BODY_RADIUS_M = DEFAULT_HITBOX.bodyRadiusM
const TOLERANCE_M = 1e-6
const TICK_SECONDS = NET.TICK_MS / 1000
/** 대각 시작 오프셋(각 축 방향으로 이만큼 떨어진 지점에서 출발해 정확히
 * 모서리를 45도로 향한다) — 반경(0.3m)보다 훨씬 커서 접근 전 구간과
 * 모서리 통과 후 구간을 모두 관측할 여유가 있다. */
const CORNER_APPROACH_OFFSET_M = 2
/** 대각 이동 거리(`CORNER_APPROACH_OFFSET_M`×√2 ≈ 2.83m)를 지나 벽
 * 반대편까지 넘어가고도 남을 여유(0.2m/틱 × 60 = 12m). */
const TICKS = 60
/** 정확히 대각 이등분선 위(±X·±Z 성분 크기가 같음)를 향하는 안전 마진
 * 배수 — 명제 3의 상한(`R√2`) 계산과 일치한다. */
const SQRT2 = Math.SQRT2

function createGroundedState(overrides: Partial<MoveState> = {}): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, ...overrides }
}

/** 점-AABB 최단 유클리드 거리 — `24af-spawn-clearance.test.ts`의 동명
 * 헬퍼와 동일 로직(자기 완결 복제, 저장소 관례). 열린/닫힌 구간 구분
 * 없이 가장 단순한 폐구간 기준 — 이 파일의 관측 지점 어디도 그 구분이
 * 결과를 좌우할 만큼 경계에 정확히 놓이지 않는다. */
function closestDistanceToAABB(point: { x: number; z: number }, box: WallAABB): number {
  const cx = Math.max(box.minX, Math.min(point.x, box.maxX))
  const cz = Math.max(box.minZ, Math.min(point.z, box.maxZ))
  return Math.hypot(point.x - cx, point.z - cz)
}

/** 매 틱 중심-AABB 거리를 계산해 누적 최솟값과 최종 상태를 함께 반환한다
 * (O1에서 배운 형태 — `24af-body-radius-walls.test.ts`의
 * `runTicksTrackingMinClearance`와 동일 정신, 이 파일은 벽 하나만
 * 격리 주입하고 유클리드 거리를 직접 재는 점이 다르다). */
function runCornerTicks(
  input: MoveInput,
  ticks: number,
  initial: MoveState,
  wall: WallAABB,
): { finalState: MoveState; minDistance: number; trajectory: MoveState[] } {
  let state = initial
  const geometry: StaticGeometry = { walls: [wall], boxes: [], ladders: [] }
  let minDistance = Number.POSITIVE_INFINITY
  const trajectory: MoveState[] = []
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(state, input, geometry)
    trajectory.push(state)
    const d = closestDistanceToAABB(state, wall)
    if (d < minDistance) minDistance = d
  }
  return { finalState: state, minDistance, trajectory }
}

interface CornerCase {
  label: string
  wall: WallAABB
  /** 목표 모서리 좌표(진단·전제 확인용 — 실제 판정은 `closestDistanceToAABB`가
   * 지오메트리에서 직접 계산하므로 이 좌표를 판정식에 다시 쓰지 않는다). */
  cornerX: number
  cornerZ: number
  approachDirX: 1 | -1
  approachDirZ: 1 | -1
}

const CASES: CornerCase[] = [
  // x축 게이트(z 범위 확인)가 결함의 원인인 벽 — EAST/WEST.
  { label: 'WALL_EAST 모서리(minX,maxZ)', wall: WALL_EAST, cornerX: WALL_EAST.minX, cornerZ: WALL_EAST.maxZ, approachDirX: 1, approachDirZ: -1 },
  { label: 'WALL_WEST 모서리(maxX,maxZ)', wall: WALL_WEST, cornerX: WALL_WEST.maxX, cornerZ: WALL_WEST.maxZ, approachDirX: -1, approachDirZ: -1 },
  // z축 게이트(x 범위 확인)가 결함의 원인인 벽 — NORTH/SOUTH.
  { label: 'WALL_NORTH 모서리(maxX,minZ)', wall: WALL_NORTH, cornerX: WALL_NORTH.maxX, cornerZ: WALL_NORTH.minZ, approachDirX: -1, approachDirZ: 1 },
  { label: 'WALL_SOUTH 모서리(maxX,maxZ)', wall: WALL_SOUTH, cornerX: WALL_SOUTH.maxX, cornerZ: WALL_SOUTH.maxZ, approachDirX: -1, approachDirZ: -1 },
]

describe('24ao 명제 1·3 — 벽 모서리를 대각으로 스쳐도 중심이 AABB에서 bodyRadiusM 이상 떨어지고, 과잉 차단은 사각 근사 상한(R√2) 이내다', () => {
  it('전제 확인 — 대각 케이스 목록이 비어있지 않다', () => {
    expect(CASES.length).toBeGreaterThan(0)
  })

  it.each(CASES)(
    '24ao/RQ-30: $label 대각 스침 경로(매 틱 관측, $wall.minX)에서 중심-AABB 거리가 bodyRadiusM(0.3m) 미만으로 좁혀지지 않는다',
    ({ wall, cornerX, cornerZ, approachDirX, approachDirZ }) => {
      const start = createGroundedState({
        x: cornerX - approachDirX * CORNER_APPROACH_OFFSET_M,
        z: cornerZ - approachDirZ * CORNER_APPROACH_OFFSET_M,
      })
      const input: MoveInput = { dirX: approachDirX, dirZ: approachDirZ, mode: 'run', jump: false }

      // 전제 확인 — 출발점이 실제로 두 축 모두 벽의 원래 범위 **밖**이다
      // (진짜 "모서리" 경로다 — 어느 한 축이라도 이미 범위 안이면 이건
      // 정면 접근이지 모서리 스침이 아니다).
      const outsideX = start.x < wall.minX || start.x > wall.maxX
      const outsideZ = start.z < wall.minZ || start.z > wall.maxZ
      expect(outsideX && outsideZ).toBe(true)

      const { minDistance } = runCornerTicks(input, TICKS, start, wall)

      // 명제 1 — 핵심 Red 단언. 오늘 구현은 게이트가 반경을 반영하지
      // 않아 대각 접근이 사실상 무저항으로 모서리를 통과한다(실측은
      // 아래 Red 실행 출력 참고 — 관측값은 0에 가깝거나, 게이트가
      // 동시에 열리는 틱에 위치가 벽 내부로 그대로 넘어가 버리는 사례도
      // 있다).
      expect(minDistance).toBeGreaterThanOrEqual(BODY_RADIUS_M - TOLERANCE_M)

      // 명제 3 — 사각 민코프스키 근사가 만드는 과잉 차단의 상한
      // (`R√2`). 대각 이등분선을 정확히 따르므로 이 상한이 이론값과
      // 정확히 맞아떨어진다(위 파일 docblock "세울 명제 3" 절 유도).
      // 상한을 넘으면(예: 반경을 두 번 합산하는 등 더 심한 과잉수정)
      // 이 단언이 잡는다.
      expect(minDistance).toBeLessThanOrEqual(BODY_RADIUS_M * SQRT2 + TOLERANCE_M)
    },
  )
})

/** 긴 축 경계 오프셋(평가자 O4 재현값 그대로 — `z = maxZ + 0.05` 등) —
 * 반경(0.3m)보다 훨씬 안쪽이라 "게이트가 반경을 반영했다면 막혔어야
 * 한다"는 것이 명백하다. */
const SKIM_OFFSET_M = 0.05

interface StraightSkimCase {
  label: string
  wall: WallAABB
  /** 오프셋을 주는 축("긴 축" 경계) — 'z'면 z를 `wall.maxZ + SKIM_OFFSET_M`
   * 등으로 고정하고 x로 스친다(EAST/WEST). 'x'면 그 반대(NORTH/SOUTH). */
  offsetAxis: 'x' | 'z'
  /** 오프셋 부호 — +면 `max*+offset`, -면 `min*-offset`. */
  offsetSign: 1 | -1
  moveDir: 1 | -1
}

const STRAIGHT_SKIM_CASES: StraightSkimCase[] = [
  // x축 게이트(z 범위 확인)만 시험 — dirZ=0이라 z축 절단은 무관.
  { label: 'WALL_EAST 곁 스침(z=maxZ+0.05, x축 게이트 단독 시험)', wall: WALL_EAST, offsetAxis: 'z', offsetSign: 1, moveDir: 1 },
  { label: 'WALL_WEST 곁 스침(z=maxZ+0.05, x축 게이트 단독 시험)', wall: WALL_WEST, offsetAxis: 'z', offsetSign: 1, moveDir: -1 },
  // z축 게이트(x 범위 확인)만 시험 — dirX=0이라 x축 절단은 무관.
  { label: 'WALL_NORTH 곁 스침(x=maxX+0.05, z축 게이트 단독 시험)', wall: WALL_NORTH, offsetAxis: 'x', offsetSign: 1, moveDir: 1 },
  { label: 'WALL_SOUTH 곁 스침(x=maxX+0.05, z축 게이트 단독 시험)', wall: WALL_SOUTH, offsetAxis: 'x', offsetSign: 1, moveDir: -1 },
]

describe('24ao 명제 1 보강 — 평가자 O4의 직선 스침 재현을 게이트별로 분리해 확인한다(위 파일 docblock REV 절)', () => {
  it('전제 확인 — 직선 스침 케이스 목록이 비어있지 않다', () => {
    expect(STRAIGHT_SKIM_CASES.length).toBeGreaterThan(0)
  })

  it.each(STRAIGHT_SKIM_CASES)(
    '24ao/RQ-30: $label — 반경(0.3m)보다 안쪽(0.05m)으로 벽 곁을 직선으로 스쳐도(매 틱 관측) 중심-AABB 거리가 bodyRadiusM 미만으로 좁혀지지 않는다',
    ({ wall, offsetAxis, offsetSign, moveDir }) => {
      const offsetValue =
        offsetSign === 1
          ? (offsetAxis === 'z' ? wall.maxZ : wall.maxX) + SKIM_OFFSET_M
          : (offsetAxis === 'z' ? wall.minZ : wall.minX) - SKIM_OFFSET_M

      const start = createGroundedState(
        offsetAxis === 'z' ? { x: moveDir > 0 ? wall.minX - 5 : wall.maxX + 5, z: offsetValue } : { z: moveDir > 0 ? wall.minZ - 5 : wall.maxZ + 5, x: offsetValue },
      )
      const input: MoveInput = offsetAxis === 'z' ? { dirX: moveDir, dirZ: 0, mode: 'run', jump: false } : { dirX: 0, dirZ: moveDir, mode: 'run', jump: false }

      // 전제 확인 — 오프셋 축은 실제로 벽의 원래 범위 **밖**이면서
      // 반경보다는 **안쪽**(진짜 "게이트가 안 걸리면 뚫린다"는 상황을
      // 만든다).
      const trueGap = offsetAxis === 'z' ? Math.min(Math.abs(offsetValue - wall.maxZ), Math.abs(offsetValue - wall.minZ)) : Math.min(Math.abs(offsetValue - wall.maxX), Math.abs(offsetValue - wall.minX))
      expect(trueGap).toBeCloseTo(SKIM_OFFSET_M, 6)
      expect(trueGap).toBeLessThan(BODY_RADIUS_M)

      const { minDistance } = runCornerTicks(input, TICKS, start, wall)

      expect(minDistance).toBeGreaterThanOrEqual(BODY_RADIUS_M - TOLERANCE_M)
      // 상한 — **`R` 단독이 아니다**(초안의 오류, 격리 워크트리 검출력
      // 실험 중 발견). 오프셋 축(`SKIM_OFFSET_M`)은 이동 중 전혀 바뀌지
      // 않고 벽의 원래 범위 **밖**에 고정돼 있으므로, 클램프가 정상
      // 작동해도(주 이동축이 정확히 `R`만큼 떨어져 멈춰도) AABB의
      // **최근접점은 면이 아니라 모서리**가 된다(두 축 모두 원래 범위
      // 밖이므로) — 실제 거리는 피타고라스로
      // `hypot(R, SKIM_OFFSET_M)`이다(실측: `R=0.3`·`SKIM_OFFSET_M=0.05`
      // 기준 정확히 `0.30413...`). 초안은 이를 놓치고 상한을 `R`로만
      // 잡아 **정상 동작(x축 게이트만 고친 부분 수정)까지 오탐**했다 —
      // `24ao-corner-body-radius-walls.test.ts` 자체가 "깨진 테스트"였던
      // 사례로 남긴다(§검출력 실험 절 참고).
      expect(minDistance).toBeLessThanOrEqual(Math.hypot(BODY_RADIUS_M, SKIM_OFFSET_M) + TOLERANCE_M)
    },
  )
})

describe('24ao 명제 4 — 기존 계약 유지: 벽에서 반경보다 더 멀리 스치는 경로는 여전히 막히지 않는다(회귀 가드)', () => {
  /** 반경(0.3m)보다 넉넉히 큰 여유(0.35m, `24af-body-radius-boxes
   * -platforms.test.ts`의 `JUST_OUTSIDE_NEAR_TARGET_M` 계열과 동일
   * 설계 정신 — 목표점 계산과 무관하게 명백히 안전권임을 보장). 대각이
   * 아니라 **직선**(단일 축 오프셋) 스침이다 — 이 케이스는 모서리(두
   * 축 동시 이탈)와 무관하게 "충분히 멀면 안 막힌다"는 계약만 확인하는
   * 것이 목적이라, 사각/원 근사 차이(명제 3)가 끼어들지 않는 가장 단순한
   * 형태로 골랐다. */
  const SAFE_SKIM_OFFSET_M = BODY_RADIUS_M + 0.05

  /**
   * **REV(독립 재평가 P1 대응, `_workspace/24af/07_evaluator_delta.md`
   * §9 P1) — 시작점을 `WALL_EAST.minX − 5`로 옮긴다(박스·플랫폼 형제
   * 가드와 동일 패턴).** 최초본은 `x: 0`에서 출발해 60틱(0.2m/틱)
   * 이동해도 `x`가 **12까지만** 갔다 — `WALL_EAST`의 팽창 구간은
   * `[14.70, 16.30]`(`nearMinX`~`nearMaxX`)이라 궤적이 그 구간에
   * **진입조차 못 했다**(`enteredExpanded=false`, 평가자 실측 §9 P1).
   * 주석은 "구간(15~16)을 훌쩍 지난다"고 적었지만 `12 < 15`라 사실이
   * 아니었다 — 두 번째 독립 확인으로 평가자가 변이 N4(반경을 `1.4×R`로
   * 부풀리는 과잉수정)를 심었을 때 **박스·플랫폼의 동일 가드는 죽는데
   * 이 벽 가드만 살아남는 것**으로 공허함을 재확인했다. 지금은
   * `WALL_EAST.minX − 5`(=10)에서 출발해 60틱 뒤 `x = 22`(=`minX+7`)에
   * 도달한다 — 팽창 구간 `[14.70, 16.30]`을 실제로 관통한다(§`08
   * _test-writer_p1.md`의 N4 재검증이 이제 이 가드가 죽는 것으로
   * 확인한다). 커버리지를 **넓히는** 방향의 수정이다 — 기존에 통과하던
   * 조건을 좁히지 않는다(시작점이 바뀌었을 뿐 단언 형태·강도는 그대로,
   * 여전히 "정확한 미차단 기대값"을 정확한 값으로 확인한다). */
  it('24ao/RQ-30 회귀 가드: WALL_EAST 옆을 반경+0.05m 여유로 직선 스치면(팽창 구간 [14.70,16.30]을 실제로 관통해도) 막히지 않고 예상 변위 그대로 이동한다', () => {
    const start = createGroundedState({ x: WALL_EAST.minX - 5, z: WALL_EAST.maxZ + SAFE_SKIM_OFFSET_M })
    const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
    const ticks = 60 // x: minX-5(=10) → minX+7(=22) — WALL_EAST 구간(15~16)과 팽창 구간(14.70~16.30)을 실제로 지난다

    // 전제 확인 — 이 궤적이 실제로 팽창 구간에 진입한다(공허한 그물
    // 방지, P1 재발 방지). 진입하지 않으면 아래 본 단언이 아무것도
    // 시험하지 않는다.
    const nearMinX = WALL_EAST.minX - BODY_RADIUS_M
    const nearMaxX = WALL_EAST.maxX + BODY_RADIUS_M
    const finalXIfUnblocked = start.x + MOVEMENT.SPEED * ticks * TICK_SECONDS
    expect(finalXIfUnblocked).toBeGreaterThan(nearMaxX) // 팽창 구간을 지나 반대편까지 갔어야 한다
    expect(start.x).toBeLessThan(nearMinX) // 출발점 자체는 팽창 구간 밖(바깥)이었다

    const { finalState } = runCornerTicks(input, ticks, start, WALL_EAST)

    const expectedX = start.x + MOVEMENT.SPEED * ticks * TICK_SECONDS
    expect(finalState.x).toBeCloseTo(expectedX, 6) // 전혀 막히지 않았다 — 팽창 구간을 관통했는데도
    expect(finalState.z).toBeCloseTo(start.z, 6) // dirZ=0이라 표류 없음(전제 확인)
  })
})
