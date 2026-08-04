import { describe, expect, it } from 'vitest'
import {
  stepMovement,
  type BoxAABB,
  type LadderVolume,
  type MoveInput,
  type MoveState,
  type StaticGeometry,
} from '@shared/sim/movement'
import { MOVEMENT, NET } from '@shared/constants'
import { PRODUCTION_WALLS } from '@shared/sim/walls'
import { PRODUCTION_BOXES } from '@shared/sim/boxes'
import { LADDER_ALPHA, PRODUCTION_LADDERS } from '@shared/sim/ladders'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'

/**
 * RQ-21 사다리 이동 — 정적 지오메트리(센서 볼륨)를 데이터로, 순수 함수가
 * 주입받아 판정 (원장 25a-7, ADR-0013 결정 2 "센서 질의는 주입된 함수/데이터로
 * 받는다", RQ-21 v1.4).
 *
 * 매핑된 골든 케이스 **GA-54**(`harness/evals/golden/track-a-product.jsonl:54`,
 * `verify` 필드가 `tests/integration/rq-21-ladder-vertical-movement.test.ts`를
 * 지정 — 그래서 GA-54 자체의 "행동 검증"은 통합 레벨 파일이 맡는다.
 * 이 파일(단위)은 `harness/workflow/tdd.md`의 "탄도·데미지·이동·낙하 계산
 * 등 순수 로직 → 단위" 원칙에 따라 그 행동을 뒷받침하는 **순수 틱 함수
 * 계약**을 고정한다, `sim-movement-boxes.test.ts`/`sim-movement-walls.test.ts`
 * 선례와 동일한 레벨 분리):
 * - given: 플레이어가 사다리 볼륨 밖 지면에 서 있음.
 * - when: 사다리 볼륨에 진입한 뒤 이동 입력의 수평 방향을 사다리 면 쪽으로
 *   유지하고, 이어서 반대 방향으로 바꾸고, 마지막으로 입력을 놓음
 *   (`dirX=dirZ=0`).
 * - then: 면 쪽 입력 중에는 일정 속도(3 m/s, 앉기 속도)로 상승, 반대 방향
 *   입력 중에는 같은 속도로 하강, 입력이 없으면 그 높이에 정지 — 볼륨
 *   안에서는 중력이 적용되지 않는다. 볼륨을 벗어나면 즉시 중력이 복귀한다.
 *
 * ---
 *
 * ## 가정(coder에게 — 이 shape으로 구현할 것. 그린필드 계약)
 *
 * ### RQ-21 — `LadderVolume`
 *
 * ```ts
 * // src/shared/sim/movement.ts — BoxAABB 옆에 추가
 * export interface LadderVolume {
 *   minX: number; maxX: number
 *   minZ: number; maxZ: number
 *   /** 사다리가 유효한 수직 범위(m) — 이 구간 밖은 사다리가 아니다. * /
 *   minY: number; maxY: number
 *   /** 사다리 면을 향하는 단위 법선(XZ 평면, 정규화 전제) — 이동 입력의
 *    * (dirX,dirZ)를 이 벡터에 내적한 값이 양수면 상승, 음수면 하강,
 *    * 0이면 정지(RQ-21 v1.4 "서버가 관측 가능한 양으로 방향을 정의"). * /
 *   normalX: number; normalZ: number
 * }
 * ```
 *
 * **포함 판정(제안, 관측되는 성질만 고정 — 구현 자유)**: XZ는 기존
 * `clampAgainstWalls`/`standingHeight`와 동일한 **개방 구간**
 * (`x > minX && x < maxX`), Y는 **폐구간**(`y >= minY && y <= maxY`) —
 * Y가 폐구간인 이유는 지면에서 걸어 들어온 플레이어가 정확히 `y = minY`
 * (사다리 밑동 = 지면 높이)에 서 있는 순간부터 "볼륨 안"으로 인정돼야
 * 진입 자체가 성립하기 때문이다(개방 구간이면 진입 지점 자체가 영원히
 * "볼륨 밖"이 된다). 이 파일의 "경계값" 테스트 2건이 이 결정을 직접 고정한다.
 *
 * ### 25a-7 동시 회수 — 25a-5(`StaticGeometry` 단일 값 주입 계약)
 *
 * 원장 25a-5: `stepMovement(state, input, walls = [], boxes = [])`는
 * 지오메트리를 **기본값 있는 위치 인자**로 받아 주입을 빠뜨려도 타입이
 * 통과한다 — 서버·클라 발산이 이미 **2회 재발**했다(25a-2 F3 벽 ·
 * 25a-4 박스, `_workspace/RQ-22-box-jump` "F1 선례"). 사다리를 세 번째
 * 정적 지오메트리 종류로 얹으면서, 위치 인자를 하나 더 늘리는 대신
 * **단일 값으로 묶어 누락이 타입 에러가 되게** 한다:
 *
 * ```ts
 * // src/shared/sim/movement.ts
 * export interface StaticGeometry {
 *   walls: readonly WallAABB[]
 *   boxes: readonly BoxAABB[]
 *   ladders: readonly LadderVolume[]
 * }
 * export const EMPTY_GEOMETRY: StaticGeometry = { walls: [], boxes: [], ladders: [] }
 *
 * export function stepMovement(
 *   state: MoveState,
 *   input: MoveInput,
 *   geometry: StaticGeometry = EMPTY_GEOMETRY,
 * ): MoveState
 * ```
 *
 * ```ts
 * // src/shared/sim/ladders.ts — 신설, walls.ts/boxes.ts와 동일한 모양
 * export const LADDER_ALPHA: LadderVolume = { minX: -14, maxX: -13, minZ: 8, maxZ: 11, minY: 0, maxY: 4, normalX: 1, normalZ: 0 }
 * export const PRODUCTION_LADDERS: readonly LadderVolume[] = [LADDER_ALPHA]
 * ```
 *
 * ```ts
 * // src/shared/sim/geometry.ts — 신설(25a-5, 파일 배치는 제안일 뿐 강제 아님)
 * export const PRODUCTION_GEOMETRY: StaticGeometry = {
 *   walls: PRODUCTION_WALLS,
 *   boxes: PRODUCTION_BOXES,
 *   ladders: PRODUCTION_LADDERS,
 * }
 * ```
 *
 * `src/server/rooms/GameRoom.ts:1095`와 `src/client/net/prediction.ts:107,118`은
 * `stepMovement(previous, input, PRODUCTION_WALLS, PRODUCTION_BOXES)`
 * (4-인자 위치 인자) 호출을 `stepMovement(previous, input,
 * PRODUCTION_GEOMETRY)`(단일 객체)로 갱신해야 한다 — 이 두 파일이 25a-5가
 * 실제로 막으려는 "지오메트리 주입 누락"의 재발 지점이다(25a-2 F3·25a-4
 * 둘 다 여기서 터졌다).
 *
 * ⚠️ **회귀 위험(반드시 보고서 참고) — 이 계약은 `stepMovement`의 3번째
 * 인자 타입을 "배열"에서 "객체"로 바꾼다.** 아래 기존 파일들의 호출부가
 * 위치 인자로 배열을 직접 넘기고 있어 이 계약 아래에서 컴파일이 깨진다
 * (인자 개수·타입 불일치) — `tests/unit/sim-movement-walls.test.ts`
 * (`stepMovement(state, input, walls)`, 2곳)·`tests/unit/sim-movement-boxes
 * .test.ts`(`stepMovement(state, input, [], boxes)` 형태, 4곳)·`tests/unit/
 * rq-62-prediction.test.ts`(`stepMovement(expected, input, PRODUCTION_WALLS)`·
 * `stepMovement(expected, input, PRODUCTION_WALLS, PRODUCTION_BOXES)` 형태,
 * 6곳). **이 파일은 그 세 파일을 수정하지 않는다**(team-lead 지시 — 기존
 * 테스트를 수정하지 말고 회귀를 보고하라) — 정확한 파일:행 목록과 조치
 * 제안은 `_workspace/RQ-21-ladder/01_test-writer_red.md`를 참고. `tests/unit/
 * sim-movement.test.ts`(전부 2-인자 호출)와 `src/server/rooms/GameRoom.ts`가
 * 아닌 나머지 기존 2-인자 호출부(대다수)는 `EMPTY_GEOMETRY` 기본값으로
 * 무변경이다.
 *
 * ---
 *
 * ## 사다리 결과(제안 — 관측 가능한 행동만 고정, 구현 자유)
 *
 * 매 틱, 이번 틱 시작 시점의 위치(`state.x/y/z` — REV 2026-07-24 "상태는
 * 값의 완전한 스냅샷" 정신, `boxesBlockingAt(state.y, ...)`와 동일하게
 * **직전** 위치로 판정한다)가 사다리 볼륨 안이면, 접지/공중 분기
 * (`stepGrounded`/`stepAirborne`) 대신 사다리 결과를 반환한다:
 * - 입력의 수평 방향(정규화 후, `clampDirection`과 동일한 클램프 전제)을
 *   법선(`normalX, normalZ`)에 내적한 값 `p`를 구한다.
 * - `p > 0`(면을 향함) → 상승: `vy = MOVEMENT.SPEED * MOVEMENT.CROUCH_MULTIPLIER`
 *   (= 3 m/s, RQ-21 v1.4 문면 그대로 — 새 수치 발명 금지, ADR-0010).
 * - `p < 0`(반대 방향) → 하강: `vy = -MOVEMENT.SPEED * MOVEMENT.CROUCH_MULTIPLIER`.
 * - `p === 0`(무입력 포함 — `dirX=dirZ=0`이면 내적이 항상 0이고, 법선과
 *   수직인 입력도 내적이 0이다) → 정지: `vy = 0`.
 * - `y += vy * TICK_SECONDS`, `x`·`z`는 불변(사다리는 수평 이동을 허용하지
 *   않는다 — RQ-21 원문이 규정하는 것은 수직 이동뿐이다).
 * - `vx = vz = 0`(수평 속도 없음 — 사다리 위에서는 수평 관성이라는 개념
 *   자체가 없다).
 * - `grounded: true`.
 *
 * **왜 `grounded: true`인가(설계 결정, "능동 탐색" — RQ-18과의 상호작용)**:
 * `grounded`를 `false`(공중)로 보고하면 `stepAirborne`의 해석적 궤적이
 * 임의의 `(y, vy)` 쌍을 "그 순간의 포물선 상태"로 재해석해 사다리를 벗어난
 * 다음 틱에 물리적으로 자연스럽게 이어지는 장점이 있다(수학적으로,
 * `jumpElapsedSeconds(vy)`가 `jumpVyAt`의 정확한 역함수이므로 임의의 `vy`에
 * 대해 `tookOffFrom + jumpHeightAt(tNext) = y + vy·dt - ½g·dt²`가 항상
 * 성립한다 — 즉 어떤 `(y,vy)`로 진입해도 "그 지점에서 자유낙하를 한 틱
 * 더 적용"과 대수적으로 동일하다). **하지만 이것을 쓰면 RQ-18(`GameRoom
 * .trackFallDamage`)이 깨진다** — `fallPeakY`는 `next.grounded === false`인
 * 동안 러닝 최댓값을 추적하므로, 사다리를 내려오는 동안(`vy < 0`이지만
 * 안전하게 통제된 하강이지 낙하가 아니다) `grounded=false`로 보고하면
 * 진입 높이가 그대로 `peak`으로 잡히고, 바닥에 착지(`grounded` 전이)하는
 * 순간 사다리 전체 높이만큼 **가짜 낙하 데미지**가 적용된다 — RQ-18
 * 원문("낙하 높이에 비례한 낙하 데미지")과 상식(사다리를 안전하게 타고
 * 내려오는 것은 낙하가 아니다) 둘 다에 어긋난다. `grounded: true`를 쓰면
 * `trackFallDamage`가 애초에 `fallPeakY`를 갱신하지 않으므로(코드 변경
 * 없이) 이 오귀속이 구조적으로 발생하지 않는다.
 *
 * **트레이드오프(수용, out-of-scope로 확인됨)**: `grounded: true`를 쓰면
 * 사다리를 벗어난 순간 아래에 지지면이 없으면(예: 꼭대기 위에 발판이
 * 없음) 자유낙하 궤적 대신 `standingHeight`로 즉시 스냅(순간이동)한다.
 * 이것은 "사다리에서 이탈하며 낙하"에 해당하고, 원장 25a-7이 명시적으로
 * 스코프 밖으로 선언했다(`harness/progress.md` 25a-7 "이 라운드가 닫지
 * 않는 것": "사다리에서 이탈하며 점프" · 원장 25a-6 "가장자리 낙하" —
 * 같은 계열의 미지원 지대다). 이 파일의 "꼭대기 이탈" 테스트는 그래서
 * 발판(로컬 `BoxAABB`)을 사다리 상단과 정확히 맞춰 이 트레이드오프가 보이지
 * 않는 배치만 검증한다 — 발판 없는 이탈은 테스트하지 않는다(추측 금지).
 *
 * **다른 ✅ RQ와의 상호작용(능동 탐색, team-lead 지시)**:
 * - **RQ-18(낙하 데미지)**: 위에서 해소 — `grounded`가 사다리 등반
 *   내내(상승·하강·정지 전부) `true`를 유지한다는 것을 아래 모든 테스트가
 *   직접 단언한다(특히 "RQ-18 상호작용" 테스트가 이름으로 명시).
 * - **RQ-20("점프를 지원해야 한다")**: 사다리 위에서 `input.jump`가 무엇을
 *   하는지는 **정하지 않는다** — 이 결과 함수는 `input.jump`를 아예
 *   참조하지 않는다(무시). "사다리에서 이탈하며 점프"는 원장 25a-7이
 *   명시적으로 스코프 밖으로 선언했으므로 이 침묵은 의도된 것이지 누락이
 *   아니다.
 * - **RQ-92(공중 가속 미허용)**: 무관 — `AIR_CONTROL === false`는
 *   `stepAirborne`(공중/낙하) 전용 규칙이고, 사다리는 애초에 `stepAirborne`
 *   경로를 타지 않는다(`grounded: true`). 사다리의 수직 속도는 매 틱
 *   입력에서 직접 결정되는 별개 메커니즘이라 "공중 가속 없음"과 충돌하지
 *   않는다.
 * - **RQ-62(클라이언트 예측)**: 서버·클라 둘 다 같은 `stepMovement` +
 *   같은 `PRODUCTION_GEOMETRY`를 참조하므로(위 25a-5 계약), 사다리 물리가
 *   예측에 자동으로 포함된다 — 벽(RQ-30)·박스(RQ-22) 때와 동일한 패턴,
 *   새로운 예측 로직이 필요 없다. `prediction.ts`의 호출부 갱신(위 "회귀
 *   위험" 절)이 이 재사용의 유일한 전제조건이다.
 *
 * **결정론(ADR-0008)**: 순수 산술, `Math.random()`·`Date.now()`·실 타이머
 * 없음 — 이 파일의 모든 테스트가 완전히 재현 가능한 정수 틱 반복이라는
 * 사실 자체로 증명된다(`sim-movement-boxes.test.ts`·`sim-movement-walls
 * .test.ts`와 동일 근거, 별도 결정론 테스트 중복 추가 없음).
 *
 * **회귀 안전 좌표(런타임 값 기준, 팀리드 지시 — 리터럴 grep이 아니라 각
 * 파일의 실제 산술로 재계산)**: `LADDER_ALPHA`(x:[-14,-13], z:[8,11])는
 * — `PRODUCTION_WALLS`(반경 15.8~16.8m 대역, `@shared/sim/walls`)와
 *   무관(|x|=13~14 < 15.8).
 * — `BOX_ALPHA`(x:[11,14], z:[8,11], `@shared/sim/boxes`)와 z 대역은
 *   같지만 x 부호가 반대(음수)라 겹치지 않는다.
 * — `SPAWN_POINTS`(15개, 반경 21.9~22.6m, `sim-movement-boxes.test.ts`
 *   docblock의 `computeSpawnPoints` 재계산 그대로 재사용) 중 이 대역
 *   (x∈[-14,-13])에 드는 것은 없다(가장 가까운 것은 인덱스5 `(-11,19)`·
 *   인덱스6 `(-18,13)` — 둘 다 x가 [-14,-13] 밖).
 * — `rq-30-play-area-bounds.test.ts`의 스윕은 z=0 또는 x=0 축 고정이라
 *   z∈[8,11] 대역에 들지 않는다(위 두 선례 파일과 동일 근거 재사용).
 * — 이 파일은 **자기 완결 단위 테스트**(다른 파일과 상태를 공유하지 않음)
 *   라 엄밀히는 좌표 충돌 위험이 없지만, `LADDER_ALPHA`를 프로덕션 배치
 *   후보로 제안하는 만큼 위 선례와 동일하게 전수 확인했다. `LADDER_BETA`
 *   (법선 일반성 테스트 전용, 아래)는 프로덕션 후보가 아니라 이 파일에만
 *   있는 로컬 값이라 좌표 충돌 분석 대상이 아니다.
 */

/** 사다리 결과 계산에 쓰이는 상승/하강 속도(m/s) — RQ-21 v1.4: 앉기
 * 속도(RQ-92)와 같다. 리터럴 3을 쓰지 않고 상수에서 유도한다(ADR-0010). */
const CLIMB_SPEED_MPS = MOVEMENT.SPEED * MOVEMENT.CROUCH_MULTIPLIER
const TICK_SECONDS = NET.TICK_MS / 1000
/** 1틱 동안 사다리 위에서 오르내리는 높이(m). */
const DY_PER_TICK = CLIMB_SPEED_MPS * TICK_SECONDS

// `LADDER_ALPHA`는 위에서 `@shared/sim/ladders`의 정본을 그대로 임포트한다
// (REV — 리뷰/coder 지적: 이 상수를 로컬에 다시 선언하면 값은 같아도
// 별개 객체 리터럴이 되어, 아래 "PRODUCTION_GEOMETRY는 ... 정본을 그대로
// 포함" 단언(`toContain`, 참조 동등성)이 production 코드가 무엇을
// export하든 통과할 수 없는 구조적 결함이 된다. 정본을 임포트하면 참조
// 동일성이 자동으로 성립하고, 좌표 리터럴 복제도 사라진다(ADR-0010) —
// 이 파일의 다른 모든 `LADDER_ALPHA` 참조는 이 임포트 값을 그대로 쓴다.

/** 법선 일반성(방향 하드코딩 방지) 전용 — `LADDER_ALPHA`와 반대 부호의
 * 법선(-X)을 가진 별도 사다리. 프로덕션 후보가 아니다(로컬 전용). */
const LADDER_BETA: LadderVolume = { minX: 11, maxX: 12, minZ: -11, maxZ: -8, minY: 0, maxY: 4, normalX: -1, normalZ: 0 }

const LADDER_ALPHA_CENTER_X = (LADDER_ALPHA.minX + LADDER_ALPHA.maxX) / 2
const LADDER_ALPHA_CENTER_Z = (LADDER_ALPHA.minZ + LADDER_ALPHA.maxZ) / 2

function geometryWithLadders(ladders: readonly LadderVolume[], boxes: readonly BoxAABB[] = []): StaticGeometry {
  return { walls: [], boxes, ladders }
}

/** "사다리 안에 이미 서 있다" — GA-54의 사다리 물리 자체를 격리 검증하는
 * 테스트들의 공유 출발점(REV 2026-07-24 "상태는 값의 완전한 스냅샷" 정신
 * — 실제로 걸어 들어온 경로인지와 무관하게 이 상태에서 판정한다. "걸어서
 * 진입"은 통합 레벨(`rq-21-ladder-vertical-movement.test.ts`)이 GA-54의
 * given/when 그대로 재현한다). */
function createLadderState(overrides: Partial<MoveState> = {}): MoveState {
  return { x: LADDER_ALPHA_CENTER_X, y: 1.5, z: LADDER_ALPHA_CENTER_Z, vx: 0, vy: 0, vz: 0, grounded: true, ...overrides }
}

/** 같은 입력을 n틱 유지하며 전체 궤적(매 틱 상태)을 기록한다 — `sim
 * -movement-boxes.test.ts`의 `runSequence`/`runConstant`와 동일 정신(마지막
 * 값만이 아니라 과정 전체를 관찰해야 "가속됨"·"1틱만 반영됨" 같은 결함을
 * 잡는다). */
function runConstant(input: MoveInput, ticks: number, start: MoveState, geometry: StaticGeometry): MoveState[] {
  const trajectory: MoveState[] = []
  let state = start
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(state, input, geometry)
    trajectory.push(state)
  }
  return trajectory
}

const TOWARD_FACE: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
const AWAY_FROM_FACE: MoveInput = { dirX: -1, dirZ: 0, mode: 'run', jump: false }
const NO_INPUT: MoveInput = { dirX: 0, dirZ: 0, mode: 'run', jump: false }
/** 법선(1,0)과 수직인 입력 — 내적이 0이라 "면 쪽도 반대쪽도 아니다". */
const PERPENDICULAR_INPUT: MoveInput = { dirX: 0, dirZ: 1, mode: 'run', jump: false }

const TOLERANCE_M = 1e-9

describe('RQ-21 사다리 이동 — 순수 틱 함수 주입 계약 (GA-54 뒷받침, 골든 자체 검증은 통합 레벨)', () => {
  describe('GA-54① — 면 쪽 입력을 유지하면 앉기 속도(3 m/s)로 상승한다', () => {
    const TICKS = 10
    const trajectory = runConstant(TOWARD_FACE, TICKS, createLadderState(), geometryWithLadders([LADDER_ALPHA]))

    it('매 틱 정확히 DY_PER_TICK만큼 상승하고, 수평 위치·접지 상태는 불변이다', () => {
      let previousY = createLadderState().y
      for (const s of trajectory) {
        expect(s.y).toBeCloseTo(previousY + DY_PER_TICK, 9)
        expect(s.x).toBeCloseTo(LADDER_ALPHA_CENTER_X, 9)
        expect(s.z).toBeCloseTo(LADDER_ALPHA_CENTER_Z, 9)
        expect(s.grounded).toBe(true)
        expect(s.vy).toBeCloseTo(CLIMB_SPEED_MPS, 9)
        expect(s.vx).toBe(0)
        expect(s.vz).toBe(0)
        previousY = s.y
      }
    })

    it(`${TICKS}틱 후 총 상승량이 CLIMB_SPEED_MPS × 경과시간과 일치한다`, () => {
      const last = trajectory[trajectory.length - 1]!
      expect(last.y).toBeCloseTo(createLadderState().y + CLIMB_SPEED_MPS * TICKS * TICK_SECONDS, 9)
    })
  })

  describe('GA-54② — 반대 방향 입력을 유지하면 같은 속도로 하강한다', () => {
    const TICKS = 10
    const trajectory = runConstant(AWAY_FROM_FACE, TICKS, createLadderState(), geometryWithLadders([LADDER_ALPHA]))

    it('매 틱 정확히 DY_PER_TICK만큼 하강한다', () => {
      let previousY = createLadderState().y
      for (const s of trajectory) {
        expect(s.y).toBeCloseTo(previousY - DY_PER_TICK, 9)
        expect(s.grounded).toBe(true)
        expect(s.vy).toBeCloseTo(-CLIMB_SPEED_MPS, 9)
        previousY = s.y
      }
    })
  })

  describe('GA-54③ — 입력이 없으면(dirX=dirZ=0) 그 높이에 정지한다', () => {
    const TICKS = 10
    const trajectory = runConstant(NO_INPUT, TICKS, createLadderState(), geometryWithLadders([LADDER_ALPHA]))

    it('y가 전혀 변하지 않고, vy는 0이다', () => {
      for (const s of trajectory) {
        expect(s.y).toBeCloseTo(createLadderState().y, 9)
        expect(s.vy).toBe(0)
        expect(s.grounded).toBe(true)
      }
    })
  })

  it('GA-54 전체 시퀀스 — 상승 후 하강 후 정지를 순서대로 그대로 반영한다(골든의 when 문장 그대로)', () => {
    const UP_TICKS = 8
    const DOWN_TICKS = 5
    const STOP_TICKS = 5
    const start = createLadderState()
    const geometry = geometryWithLadders([LADDER_ALPHA])

    let state = start
    for (let i = 0; i < UP_TICKS; i += 1) state = stepMovement(state, TOWARD_FACE, geometry)
    const afterUp = state
    expect(afterUp.y).toBeCloseTo(start.y + UP_TICKS * DY_PER_TICK, 9)
    expect(afterUp.grounded).toBe(true)

    for (let i = 0; i < DOWN_TICKS; i += 1) state = stepMovement(state, AWAY_FROM_FACE, geometry)
    const afterDown = state
    expect(afterDown.y).toBeCloseTo(afterUp.y - DOWN_TICKS * DY_PER_TICK, 9)
    expect(afterDown.grounded).toBe(true)

    for (let i = 0; i < STOP_TICKS; i += 1) state = stepMovement(state, NO_INPUT, geometry)
    const afterStop = state
    expect(afterStop.y).toBeCloseTo(afterDown.y, 9) // 정지 — 더 내려가지도 올라가지도 않는다
    expect(afterStop.grounded).toBe(true)
  })

  it('RQ-18 상호작용 — 사다리를 오르내리는 동안(상승·하강·정지 전부) grounded가 한 번도 false가 되지 않는다(GameRoom.trackFallDamage의 fallPeakY는 grounded===false일 때만 갱신되므로, 이 불변식이 사다리 등반을 낙하로 오귀속하지 않게 만드는 유일한 전제다)', () => {
    const geometry = geometryWithLadders([LADDER_ALPHA])
    let state = createLadderState({ y: 0.5 })
    const observed: boolean[] = []
    for (let i = 0; i < 15; i += 1) {
      state = stepMovement(state, TOWARD_FACE, geometry)
      observed.push(state.grounded)
    }
    for (let i = 0; i < 15; i += 1) {
      state = stepMovement(state, AWAY_FROM_FACE, geometry)
      observed.push(state.grounded)
    }
    for (let i = 0; i < 5; i += 1) {
      state = stepMovement(state, NO_INPUT, geometry)
      observed.push(state.grounded)
    }
    expect(observed.every((g) => g === true)).toBe(true)
    expect(observed.length).toBe(35) // 전제 확인 — 실제로 35틱을 관찰했다
  })

  it('중력 미적용 — 상승을 오래(40틱) 유지해도 속도가 가속되지 않는다(중력을 받는 점프 궤적과 달리 매 틱 변위가 일정하다)', () => {
    const TICKS = 40
    const trajectory = runConstant(TOWARD_FACE, TICKS, createLadderState({ y: 0 }), geometryWithLadders([LADDER_ALPHA]))
    // 사다리 범위(minY=0, maxY=4)를 벗어나지 않도록 y가 4를 넘기 전까지만
    // 검사한다 — 40틱×0.1m/틱=4.0m로 정확히 경계에 닿으므로, 경계 이후는
    // 별도 "볼륨 이탈" 테스트의 몫이다(관심사 분리).
    const insideVolume = trajectory.filter((s) => s.y <= LADDER_ALPHA.maxY + TOLERANCE_M)
    expect(insideVolume.length).toBeGreaterThan(30) // 전제 확인 — 대부분의 틱이 아직 볼륨 안이다
    for (const s of insideVolume) {
      expect(s.vy).toBeCloseTo(CLIMB_SPEED_MPS, 9) // 가속됐다면 이 값이 틱마다 달라진다
    }
    // 인접 틱 간 변위(Δy)가 처음부터 끝까지(볼륨 안에 있는 한) 완전히
    // 동일하다 — 점프 궤적(`y(t)=v0t-½gt²`)이었다면 Δy가 매 틱 줄어든다.
    const deltas: number[] = []
    for (let i = 1; i < insideVolume.length; i += 1) {
      deltas.push(insideVolume[i]!.y - insideVolume[i - 1]!.y)
    }
    for (const d of deltas) {
      expect(d).toBeCloseTo(DY_PER_TICK, 9)
    }
  })

  it('법선과 수직인 입력(투영 0)은 상승도 하강도 아니다 — dirZ만 있는 입력도 그 높이에 정지한다', () => {
    const trajectory = runConstant(PERPENDICULAR_INPUT, 10, createLadderState(), geometryWithLadders([LADDER_ALPHA]))
    for (const s of trajectory) {
      expect(s.y).toBeCloseTo(createLadderState().y, 9)
      expect(s.vy).toBe(0)
    }
  })

  describe('경계값 — Y 범위는 폐구간이다(minY·maxY 정확히 그 값에서도 사다리 안으로 취급)', () => {
    it('정확히 minY(바닥)에서 상승 입력을 주면 사다리 물리가 적용된다(진입 지점 자체가 "볼륨 밖"이 되지 않는다)', () => {
      const atBottom = createLadderState({ y: LADDER_ALPHA.minY })
      const next = stepMovement(atBottom, TOWARD_FACE, geometryWithLadders([LADDER_ALPHA]))
      expect(next.y).toBeCloseTo(LADDER_ALPHA.minY + DY_PER_TICK, 9)
      expect(next.grounded).toBe(true)
    })

    it('정확히 maxY(꼭대기)에서도 여전히 사다리 물리가 적용된다(예: 무입력이면 그 높이에 정지 — "이상"으로 취급해 이미 이탈한 것으로 보지 않는다)', () => {
      const atTop = createLadderState({ y: LADDER_ALPHA.maxY })
      const next = stepMovement(atTop, NO_INPUT, geometryWithLadders([LADDER_ALPHA]))
      expect(next.y).toBeCloseTo(LADDER_ALPHA.maxY, 9)
      expect(next.grounded).toBe(true)
    })
  })

  describe('볼륨을 벗어나면 즉시 중력이 복귀한다(RQ-21 v1.4 마지막 문장)', () => {
    it('바닥 아래로는 내려가지 않는다 — 계속 하강 입력을 줘도 y가 지면(0) 밑으로 내려가지 않고, 사다리 지배가 끝난 뒤에도 접지 상태를 유지한다', () => {
      // minY(0)가 실제 지면(맨지면 standingHeight=0)과 같은 높이인 production
      // 배치 전제 — 사다리 최하단은 걸어서 도달 가능한 지면과 일치해야
      // "이탈 즉시 중력 복귀"가 관측 가능한 불연속 없이 성립한다.
      const geometry = geometryWithLadders([LADDER_ALPHA])
      const trajectory = runConstant(AWAY_FROM_FACE, 20, createLadderState({ y: 0.5 }), geometry)
      const last = trajectory[trajectory.length - 1]!
      expect(last.y).toBeCloseTo(0, 9) // 지면에 고정 — 음수로 내려가지 않았다
      expect(last.grounded).toBe(true)
      // 전제 확인 — 실제로 바닥(minY)까지 도달한 뒤 여러 틱을 더 하강
      // 입력으로 눌러본 것이다(경계에서 즉시 멈춘 것이 아니라 클램프가
      // 반복적으로 작동했다).
      const atOrBelowBottom = trajectory.filter((s) => s.y <= LADDER_ALPHA.minY + TOLERANCE_M)
      expect(atOrBelowBottom.length).toBeGreaterThan(1)
    })

    it('꼭대기 위(발판 있음) — 사다리 지배가 끝나고 그 지지 높이에서 접지 이동으로 전환된다. 같은 방향(이전엔 상승) 입력이 더 이상 y를 올리지 않고 대신 수평 이동을 일으킨다', () => {
      // 발판(topY = maxY)을 사다리 상단과 정확히 맞춘다 — "이탈 시 지지면
      // 없음"(원장 25a-7이 스코프 밖으로 선언한 "사다리에서 이탈하며 낙하")
      // 은 이 테스트가 다루지 않는다(위 docblock "트레이드오프" 절 참고).
      const platform: BoxAABB = {
        minX: LADDER_ALPHA.minX,
        maxX: LADDER_ALPHA.maxX,
        minZ: LADDER_ALPHA.minZ,
        maxZ: LADDER_ALPHA.maxZ,
        topY: LADDER_ALPHA.maxY,
      }
      const geometry = geometryWithLadders([LADDER_ALPHA], [platform])

      // 꼭대기 바로 아래(y=maxY-0.5)에서 출발해 상승을 유지 — 6틱이면
      // 0.6m 상승해 maxY(4)를 넘어선다(볼륨 이탈).
      let state = createLadderState({ y: LADDER_ALPHA.maxY - 0.5 })
      for (let i = 0; i < 6; i += 1) {
        state = stepMovement(state, TOWARD_FACE, geometry)
      }
      // 이탈 이후: 지지 높이(발판 topY=maxY)에 스냅되어 접지, 더 이상
      // 사다리 속도(DY_PER_TICK)로 계속 오르지 않는다.
      expect(state.y).toBeCloseTo(LADDER_ALPHA.maxY, 6)
      expect(state.grounded).toBe(true)

      // 이제 같은 입력(dirX=1)을 유지하면 — 사다리 지배 아래였다면 계속
      // 상승했겠지만, 이탈했으므로 수평 이동(x 증가)으로 해석된다.
      const beforeX = state.x
      const afterHorizontal = stepMovement(state, TOWARD_FACE, geometry)
      expect(afterHorizontal.x).toBeGreaterThan(beforeX)
      expect(afterHorizontal.y).toBeCloseTo(LADDER_ALPHA.maxY, 6) // 발판 위에 그대로 서 있다
    })
  })

  describe('법선 일반성 — 방향은 하드코딩된 축이 아니라 사다리별 법선이 결정한다', () => {
    it('법선이 반대(-X)인 사다리에서는 같은 dirX=1 입력이 하강으로 해석된다', () => {
      const center: MoveState = {
        x: (LADDER_BETA.minX + LADDER_BETA.maxX) / 2,
        y: 1.5,
        z: (LADDER_BETA.minZ + LADDER_BETA.maxZ) / 2,
        vx: 0,
        vy: 0,
        vz: 0,
        grounded: true,
      }
      const next = stepMovement(center, TOWARD_FACE, geometryWithLadders([LADDER_BETA])) // TOWARD_FACE = dirX:1
      expect(next.y).toBeCloseTo(center.y - DY_PER_TICK, 9) // LADDER_ALPHA였다면 상승했을 입력이 여기선 하강
      expect(next.vy).toBeCloseTo(-CLIMB_SPEED_MPS, 9)
    })

    it('법선이 반대(-X)인 사다리에서는 반대 입력(dirX=-1)이 상승으로 해석된다', () => {
      const center: MoveState = {
        x: (LADDER_BETA.minX + LADDER_BETA.maxX) / 2,
        y: 1.5,
        z: (LADDER_BETA.minZ + LADDER_BETA.maxZ) / 2,
        vx: 0,
        vy: 0,
        vz: 0,
        grounded: true,
      }
      const next = stepMovement(center, AWAY_FROM_FACE, geometryWithLadders([LADDER_BETA])) // AWAY_FROM_FACE = dirX:-1
      expect(next.y).toBeCloseTo(center.y + DY_PER_TICK, 9)
      expect(next.vy).toBeCloseTo(CLIMB_SPEED_MPS, 9)
    })
  })

  describe('양성 대조군 — 사다리 볼륨 밖(또는 사다리가 주입되지 않음)에서는 사다리 물리가 전혀 적용되지 않는다', () => {
    it('사다리와 같은 y 범위지만 XZ가 볼륨 밖인 지점은 평지 물리 그대로다(수평 이동, y=0 유지)', () => {
      const outside = createLadderState({ x: LADDER_ALPHA.maxX + 5, y: 0 }) // XZ가 밖(x가 근접면을 5m 넘어섬)
      const next = stepMovement(outside, TOWARD_FACE, geometryWithLadders([LADDER_ALPHA]))
      expect(next.x).toBeGreaterThan(outside.x) // 수평 이동이 일어났다(사다리였다면 x 불변)
      expect(next.y).toBeCloseTo(0, 9) // 접지 평지 — 상승하지 않았다
    })

    it('사다리가 XZ 범위 안이지만 Y가 minY/maxY 밖인 지점은 평지 물리 그대로다', () => {
      const belowLadder = createLadderState({ y: LADDER_ALPHA.minY - 0.5 })
      const next = stepMovement(belowLadder, TOWARD_FACE, geometryWithLadders([LADDER_ALPHA]))
      expect(next.x).toBeGreaterThan(belowLadder.x) // 수평 이동(사다리 물리가 아니다)
    })

    it('사다리를 아예 주입하지 않으면(ladders: []) 같은 위치에서도 사다리 물리가 적용되지 않는다', () => {
      const inside = createLadderState()
      const next = stepMovement(inside, TOWARD_FACE, geometryWithLadders([]))
      expect(next.x).toBeGreaterThan(inside.x) // 수평 이동으로 해석됐다
      expect(next.y).toBeCloseTo(0, 9) // 사다리가 없으니 평지(standingHeight=0)로 취급
    })
  })

  describe('25a-5 계약 — StaticGeometry 완전성(누락이 타입 에러가 되게)', () => {
    it('세 필드(walls·boxes·ladders) 중 하나라도 빠진 객체 리터럴은 StaticGeometry에 대입할 수 없다(타입 에러) — 이 줄 자체가 실제로 에러가 나지 않으면 아래 @ts-expect-error가 "사용되지 않는 지시문" 에러를 내 tsc가 실패한다', () => {
      // @ts-expect-error — ladders 필드 누락은 반드시 타입 에러여야 한다(25a-5 계약 핵심).
      const incomplete: StaticGeometry = { walls: [], boxes: [] }
      expect(incomplete).toBeDefined() // 도달 자체는 런타임 관심사가 아니다 — 위 타입 에러가 이 테스트의 본체다.
    })

    it('PRODUCTION_GEOMETRY는 walls·boxes·ladders 세 정본을 그대로 포함한 완전한 값이다(리터럴 복제가 아니라 배선 확인, ADR-0010)', () => {
      expect(PRODUCTION_GEOMETRY.walls).toBe(PRODUCTION_WALLS)
      expect(PRODUCTION_GEOMETRY.boxes).toBe(PRODUCTION_BOXES)
      expect(PRODUCTION_GEOMETRY.ladders).toBe(PRODUCTION_LADDERS)
      expect(PRODUCTION_GEOMETRY.ladders).toContain(LADDER_ALPHA)
    })
  })

  describe('기본값 호환 — geometry 인자를 생략하거나 빈 값을 넘기면 기존 동작(사다리 없음) 그대로다(ADR-0010 하위 호환)', () => {
    it('geometry 인자를 아예 생략한 2-인자 호출은 사다리가 전혀 없는 것처럼 동작한다', () => {
      const inside = createLadderState()
      const next = stepMovement(inside, TOWARD_FACE) // 2-인자 — geometry 생략
      expect(next.x).toBeGreaterThan(inside.x) // 수평 이동 — 사다리 물리가 아니다
    })

    it('walls·boxes·ladders를 전부 빈 배열로 명시해도 생략과 동일하다', () => {
      const inside = createLadderState()
      const next = stepMovement(inside, TOWARD_FACE, geometryWithLadders([]))
      expect(next.x).toBeGreaterThan(inside.x)
    })
  })
})

/**
 * F1 재현 — 사다리 꼭대기 이탈이 RQ-18을 우회한다(독립 평가 FAIL,
 * `_workspace/RQ-21-ladder/03_evaluator_report.md` F1 절, ADR-0011 결정 1
 * "결함 수정 라운드의 재현 테스트" — `src/shared` 결함 재현은 test-writer
 * 전유물).
 *
 * **결함(평가자 실측 그대로 재현)**: 발판 없는 프로덕션 사다리(`LADDER_ALPHA`,
 * `maxY=4`)에서 상승을 유지해 꼭대기를 넘기면, 현재 `stepMovement`는
 * 사다리 이탈 폴백에서 원래 `state`(꼭대기 넘기 **직전**, 여전히 사다리
 * 볼륨 안) 기준으로 `stepGrounded`를 호출한다 — `standingHeight`가 0(발판
 * 없음)이라 **그 자리에서 즉시 `y=0`으로 스냅**된다(`grounded` 유지 `true`,
 * 중간 낙하 구간 없음). `GameRoom.trackFallDamage`는 `next.grounded ===
 * false`인 동안에만 `fallPeakY`를 갱신하므로(`GameRoom.ts:857-862`), 이
 * 스냅은 착지 전이 자체가 아니라서 낙하 데미지가 전혀 적용되지 않는다.
 * 그리고 스냅된 위치(x는 그 틱의 접지 이동으로 0.2m 전진, y=0)가 여전히
 * 사다리 XZ·Y 범위 안이라 **다음 틱에 다시 사다리에 붙잡혀 재상승** —
 * 4↔0 무한 순환(요요)이 된다(평가자 PROBE_A/PROBE_E 실측과 정확히 일치,
 * 아래 각 `it()`이 그 재현이다).
 *
 * **RQ-21 v1.4 마지막 문장("볼륨을 벗어나면 즉시 중력이 복귀한다")이 이
 * 경로에서 거짓이다** — 실제로 복귀하는 것은 중력(자유낙하)이 아니라
 * 즉각적인 접지 스냅이다.
 *
 * **이 파일이 고정하는 것(관측 가능한 행동만, 구현 자유)**:
 * 1. 꼭대기를 넘기는 바로 그 틱의 결과는 `grounded: true`(접지 스냅)가
 *    아니라 `grounded: false`(공중)여야 한다 — "즉시 중력이 복귀한다"의
 *    직접 번역.
 * 2. 그 전이 이후 궤적에 순간이동(한 틱 사이 y가 사다리 범위의 상당 부분을
 *    건너뛰는 불연속)이 없어야 한다 — 물리적으로 연속적인 낙하여야 한다.
 * 3. (양성 대조군 — 과잉수정 방지) 경계에 닿지 않는 등반·하강·정지 중에는
 *    여전히 `grounded: true`가 유지돼야 한다 — 기존 "RQ-18 상호작용" 절의
 *    명제가 이 수정으로 깨지지 않는지 확인한다.
 *
 * **고정하지 않는 것(coder 구현 자유)**: 정확한 이탈 시점의 `y`·`vy` 값,
 * 정점 높이, 착지까지 걸리는 정확한 틱 수, 착지 이후 같은 입력을 계속
 * 유지했을 때 사다리에 다시 붙잡혀 재등반하는지 여부(그것은 "요요 버그"가
 * 아니라 플레이어가 계속 오르려는 정상적 반복이다 — 각 이탈이 실제 낙하와
 * 데미지를 동반하는 한 문제가 아니다). 데미지 적용 자체(HP 감소)는 통합
 * 레벨(`tests/integration/rq-21-ladder-vertical-movement.test.ts`)이 맡는다
 * — `trackFallDamage`가 `GameRoom`에 있어 이 파일(순수 함수)에서는 관측할
 * 수 없다.
 *
 * **결정론(ADR-0008)**: 순수 산술, `Math.random()`·`Date.now()`·실 타이머
 * 없음.
 */
describe('F1 재현 — 사다리 꼭대기 이탈이 즉시 접지 스냅(요요)이 아니라 공중 전이여야 한다', () => {
  /** 평가자 재현 값과 동일(`LADDER_ALPHA.maxY - 0.15` = 3.85, 상수에서
   * 유도 — ADR-0010, 리터럴 금지) — 몇 틱 만에 꼭대기를 넘겨 재현 창을
   * 짧게 유지한다. */
  const EXIT_TEST_START_Y = LADDER_ALPHA.maxY - 0.15
  /** 이탈 이후 궤적을 관찰하는 틱 수 — 평가자 실측(자연 정점~착지)보다
   * 넉넉한 여유(위 docblock 계산 근거: 상승 잔여+낙하 도합 약 24틱 예상,
   * 2배 이상 여유). */
  const POST_EXIT_OBSERVE_TICKS = 50
  /** 한 틱 사이 "물리적으로 그럴듯한" 최대 변위(m) — 사다리 전체 수직
   * 범위의 절반. 결함의 순간이동(≈3.95m, 범위의 거의 전체)과 정상 낙하
   * 궤적(중력 가속 하 한 틱 변위, 이 높이대에서는 이 값보다 훨씬 작다)을
   * 명확히 가르는 문턱이다 — 정확한 중력 상수 없이도(그 상수는
   * `movement.ts` 비공개 구현값이라 이 파일이 참조할 수 없다) 리터럴을
   * 새로 발명하지 않고 `LADDER_ALPHA`에서 유도한다(ADR-0010). */
  const MAX_PLAUSIBLE_TICK_DELTA_M = (LADDER_ALPHA.maxY - LADDER_ALPHA.minY) / 2

  function climbToExit(): MoveState[] {
    const start = createLadderState({ y: EXIT_TEST_START_Y })
    const geometry = geometryWithLadders([LADDER_ALPHA])
    const trajectory: MoveState[] = []
    let state: MoveState = start
    for (let i = 0; i < POST_EXIT_OBSERVE_TICKS; i += 1) {
      state = stepMovement(state, TOWARD_FACE, geometry)
      trajectory.push(state)
    }
    return trajectory
  }

  it('꼭대기를 넘기는 틱은 grounded:false(공중)를 반환한다 — grounded:true로 접지 스냅되지 않는다', () => {
    const trajectory = climbToExit()
    // 전제 확인 — 실제로 꼭대기(maxY)를 넘어서는 지점이 있었다(그 전까지는
    // 정상 등반이라 이 명제와 무관하다).
    const exitIndex = trajectory.findIndex((s) => s.y > LADDER_ALPHA.maxY)
    expect(exitIndex).toBeGreaterThanOrEqual(0)

    const atExit = trajectory[exitIndex]!
    // 결함 재현 — 현재 구현은 이 틱에서 y=0, grounded=true로 스냅된다.
    // 고쳐지면 grounded:false(공중)여야 한다.
    expect(atExit.grounded).toBe(false)
  })

  it('이탈 이후 궤적에 순간이동(한 틱 사이 사다리 범위 절반을 넘는 불연속 낙하)이 없다 — 물리적으로 연속적인 낙하다', () => {
    const trajectory = climbToExit()
    const exitIndex = trajectory.findIndex((s) => s.y > LADDER_ALPHA.maxY)
    expect(exitIndex).toBeGreaterThanOrEqual(0)

    for (let i = exitIndex + 1; i < trajectory.length; i += 1) {
      const delta = Math.abs(trajectory[i]!.y - trajectory[i - 1]!.y)
      expect(delta).toBeLessThan(MAX_PLAUSIBLE_TICK_DELTA_M)
    }
  })

  it('궤적은 결국 접지 상태로 안정된다(무한 공중이 아니다) — 착지 후 y는 지지 높이(발판 없음, 0)와 같다', () => {
    const trajectory = climbToExit()
    const settled = trajectory[trajectory.length - 1]!
    expect(settled.grounded).toBe(true)
    expect(settled.y).toBeCloseTo(0, 6)
  })

  it('양성 대조군(과잉수정 방지) — 경계에 닿지 않는 등반·하강·정지 중에는 여전히 grounded:true가 유지된다(기존 "RQ-18 상호작용" 명제 재확인)', () => {
    const geometry = geometryWithLadders([LADDER_ALPHA])
    let state = createLadderState({ y: EXIT_TEST_START_Y - 1 }) // 꼭대기에서 충분히 먼 지점
    const observed: boolean[] = []
    for (let i = 0; i < 5; i += 1) {
      state = stepMovement(state, TOWARD_FACE, geometry) // 상승, 경계 접근 안 함
      observed.push(state.grounded)
    }
    for (let i = 0; i < 5; i += 1) {
      state = stepMovement(state, AWAY_FROM_FACE, geometry) // 하강
      observed.push(state.grounded)
    }
    for (let i = 0; i < 5; i += 1) {
      state = stepMovement(state, NO_INPUT, geometry) // 정지
      observed.push(state.grounded)
    }
    expect(observed.every((g) => g === true)).toBe(true)
    expect(observed.length).toBe(15) // 전제 확인
  })
})
