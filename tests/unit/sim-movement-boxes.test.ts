import { describe, expect, it } from 'vitest'
import { stepMovement, type BoxAABB, type MoveInput, type MoveState } from '@shared/sim/movement'
import { MOVEMENT, NET } from '@shared/constants'

/**
 * RQ-22 박스 점프 — 정적 지오메트리(유한 높이)를 데이터로, 순수 함수가
 * 주입받아 판정 (원장 25a-4, ADR-0013 결과 절 "박스 등반은 명시적 점프").
 *
 * 매핑된 골든 케이스 **GA-55**(`harness/evals/golden/track-a-product.jsonl:55`,
 * `verify` 필드가 `tests/integration/rq-22-box-jump.test.ts`를 지정 — 그래서
 * GA-55 자체의 "행동 검증"은 통합 레벨 파일이 맡는다. 이 파일은 그 행동을
 * 뒷받침하는 **순수 틱 함수 계약**을 고정한다, `harness/workflow/tdd.md`의
 * "탄도·데미지·이동·낙하 계산 등 순수 로직 → 단위" 원칙):
 * - given: 플레이어가 박스 옆 지면에 서 있고 점프 높이가 1.0m(RQ-92), 박스
 *   상단 높이는 1.0m보다 낮으며, 공중 가속은 허용되지 않음.
 * - when: ① 박스 방향으로 이동하며 점프 ② 정지 상태에서 제자리 점프.
 * - then: ①에서는 박스 상단에 착지해 접지 상태가 되고 y가 박스 높이와
 *   같다. ②에서는 박스에 올라서지 못하고 원래 지면으로 돌아온다 —
 *   수평 관성 없이는 등반이 불가능하다.
 *
 * **GA-53(박스 치수 상한, `tests/unit/map-box-dimensions.test.ts`)은 이
 * 라운드가 다루지 않는다** — 실제 맵 `.glb` 클러스터 배치가 아직 없다
 * (team-lead 지시, 25a-4 착수 메모).
 *
 * **가정(coder에게 — 이 shape으로 구현할 것. 그린필드 계약)**:
 *
 * ```ts
 * // src/shared/sim/movement.ts — WallAABB 옆에 추가
 * export interface BoxAABB {
 *   minX: number; maxX: number
 *   minZ: number; maxZ: number
 *   /** 상단 높이(m) — RQ-32: 점프 높이(1.0m)보다 낮아야 등반 가능. * /
 *   topY: number
 * }
 * export function stepMovement(
 *   state: MoveState,
 *   input: MoveInput,
 *   walls?: readonly WallAABB[],   // 기존 계약(RQ-30), 그대로 유지
 *   boxes?: readonly BoxAABB[],    // 신규 — 기본값 [] (생략 시 박스 없음)
 * ): MoveState
 *
 * // src/shared/sim/boxes.ts — walls.ts와 동일한 모양의 신규 모듈(제안, 강제 아님)
 * export const BOX_ALPHA: BoxAABB = { minX: 11, maxX: 14, minZ: 8, maxZ: 11, topY: 0.4 }
 * export const PRODUCTION_BOXES: readonly BoxAABB[] = [BOX_ALPHA]
 * ```
 *
 * **행동 계약 — "지지 높이"만 정한다(수평 차단은 아래 별도 절 참고)**:
 * 어느 틱이든(접지·공중 모두) 플레이어의 수평 위치 `(x,z)`가 박스의 XZ
 * 범위 안이면, 그 지점의 **지지 높이**(standing height)는
 * `max(0, 그 지점을 포함하는 모든 박스의 topY)`다 — 범위 밖이면 기존과
 * 동일하게 0(맨지면)이다.
 * - **공중(하강 중)**: 해석적 궤적 높이가 지지 높이 이하로 내려가는 순간
 *   착지로 스냅한다(기존 `airborneOutcome`의 "height<=0 → 착지"를
 *   "height<=지지 높이 → 착지, y=지지 높이"로 일반화 — 박스가 없으면
 *   지지 높이가 항상 0이라 기존 동작과 완전히 동일하다).
 * - **접지(이미 서 있음)**: `groundedOutcome`도 매 틱 y를 하드코딩된 0이
 *   아니라 현재 `(x,z)`의 지지 높이로 재계산해야 한다. **이것이 없으면
 *   착지 다음 틱에 y가 도로 0으로 꺼지는 "1틱 반짝임" 결함이 생긴다**
 *   (아래 "접지 지속" 테스트가 정확히 이 결함을 잡는다) — 박스 위에
 *   서서 한 틱이라도 더 있으면 `stepGrounded`→`groundedOutcome` 경로를
 *   타므로, 그 경로가 박스를 모르면 즉시 바닥으로 떨어진다.
 *
 * **REV(팀리드 결정, 질문 1 회신) — 박스는 고체다: 상단보다 낮은 높이에서는
 * 옆면이 수평 이동을 막는다.** 최초본은 이 질문을 열어 두고 테스트하지
 * 않았다 — 팀리드가 "RQ-22의 '충돌 형상을 구성해야 한다'가 근거. 충돌
 * 형상이 수평으로 충돌하지 않으면 그건 충돌 형상이 아니다"로 확정했다.
 * 규칙(경계 조건까지 이 파일이 확정, 아래 테스트가 그대로 문서화한다):
 * - 어느 틱이든 플레이어의 **직전 높이**(`state.y`, REV 2026-07-24 "상태는
 *   값의 완전한 스냅샷" 정신 — 위치가 아니라 상태 값 자체가 판정 기준)가
 *   박스의 `topY`**보다 낮으면**, 그 박스는 `clampAgainstWalls`
 *   (`movement.ts`, RQ-30)와 **같은 성질**(근접면 통과 금지 + 고착 금지 —
 *   벽에 막혀 멈춘 뒤 반대 입력은 정상 반영)로 수평 이동을 막는다. 재사용
 *   여부(같은 함수 vs 별도 경로)는 구현 자유 — 이 파일은 **관측되는 성질**만
 *   고정한다.
 * - **직전 높이가 `topY` "이상"이면 차단이 없다** — 박스 위(또는 그 위를
 *   지나는 공중 궤적)를 자유롭게 가로지른다. "정확히 `topY`"는 **"위"에
 *   포함**(차단 없음)으로 정한다 — 박스 표면에 이미 서 있는 상태(y=topY,
 *   접지)와 그 표면을 걸어 다니는 것을 같은 취급으로 두는 것이 "상단 위는
 *   막지 않는다"는 문면과 가장 정합적이다(아래 "경계값" 테스트가 이
 *   결정을 합성 상태로 직접 고정한다 — REV 2026-07-24 정신과 동일하게
 *   실제로 그 상태에 도달하는 경로의 자연스러움과 무관하게 상태 값만으로
 *   판정한다).
 *
 * **명시적으로 정하지 않는 것(스코프 밖, team-lead 지시 — "위 두 결정을
 * 덮는 최소한이면 된다. 넓히지 마라")**:
 * - 박스 가장자리에서 걸어 나가는 낙하 물리, RQ-18 낙하 데미지와의 상호작용,
 *   사격 차폐에 박스 포함 여부, 다중 박스 겹침/조합 — 전부 원장 25a-4가
 *   비스코프로 선언했다.
 * - **레벨 선택**: 수평 차단은 벽 충돌(`clampAgainstWalls`)과 동일하게
 *   순수 로직(`harness/workflow/tdd.md` "탄도·데미지·이동·낙하 계산 →
 *   단위")이라 이 파일(단위)에서만 고정한다. `PRODUCTION_BOXES`가
 *   `stepMovement`에 실제로 주입되는지는 기존 GA-55①·②(통합 레벨,
 *   `rq-22-box-jump.test.ts`)가 이미 관측한다 — 같은 박스 데이터를 쓰는
 *   같은 주입 경로이므로 "수평 차단 배선"을 위한 별도 통합 테스트는
 *   중복이다(`sim-movement-walls.test.ts`가 `clampAgainstWalls` 세부를
 *   단위 레벨에만 두고 배선 확인은 `rq-30-wall-collision-wiring.test.ts`
 *   1건으로 충분히 한 선례와 동일).
 *
 * **좌표 선택 — 회귀 안전 대역(런타임 값 기준 재계산, 팀리드 지시)**:
 * `PRODUCTION_WALLS`가 이미 반경 15.8~16.8m를 점유하고, `SPAWN_POINTS`
 * (15개, 반경 21.9~22.6m, 좌표 전수 재계산 — 아래 `computeSpawnPoints`
 * 참고)와 탈출 지점(반경 ~28m)도 점유돼 있다. 이 파일은 **자기 완결
 * 단위 테스트**(다른 파일과 상태를 공유하지 않는다)라 엄밀히는 좌표 충돌
 * 위험이 없지만(각 `it()`이 로컬 상태만 다룬다), `sim-movement-walls
 * .test.ts` 선례와 동일하게 이 좌표를 **프로덕션 배치 후보**로 그대로
 * 제안한다 — `GameRoom.stepPlayerMovement`가 이 값을 실제로 상시 주입하게
 * 되면 기존 통합 테스트 47개 파일이 같은 좌표 대역의 영향을 받기 때문이다.
 * 전수 조사 결과(아래, 리터럴 grep이 아니라 각 파일의 실제 산술로 재계산 —
 * `sim-movement-walls.test.ts` 선례가 "리터럴 grep은 계산 좌표를 놓친다"고
 * 이미 경고했다):
 *
 * - **정적 배치 리터럴** — `tests/integration/rq-12-wall-occlusion.test.ts`의
 *   `TARGET_BEHIND_WALL_POS`(17,0,0)·`TARGET_BEFORE_WALL_POS`(10,0,0),
 *   `rq-31-safe-zone-blocks-bullets.test.ts`의 `ORIGIN`(0,0,0),
 *   `rq-61-server-authoritative-position.test.ts`의 `IN_MAP_SPOOF`
 *   (12.5,1.5,-12.5) — **전부 z가 0 또는 음수**다. 이 파일의 박스는
 *   z∈[8,11](양수, 0에서 8m 이상)이라 전부 무관하다.
 * - **동적 드리프트(점프 + 수평 이동)** — `stepMovement`를 호출하는 jump 관련
 *   파일 5개(`22f-jump-input-loss`·`rq-18-fall-damage`·`rq-30-play-area
 *   -bounds`·`rq-92-fall-damage-curve`·`rq-92-no-air-acceleration`) 중
 *   실제로 수평 이동을 동반한 점프는 단 둘: (a) `rq-92-no-air-acceleration
 *   .test.ts` — 스폰 인덱스 0(유일한 참가자라 `nextSpawnIndex(undefined,15)`
 *   =0 확정, `SPAWN_POINTS[0]`=(22,0), 아래 `computeSpawnPoints` 재계산)에서
 *   dirX=1로 이함, z는 공중 가속 미허용(RQ-92)이라 0 그대로 고정 — x는
 *   자연 착지 시각(≈19틱, 아래 §점프 궤적)보다 오래 걸리면 이미 그 테스트
 *   자체가 `grounded===false`를 잃어 실패하므로 x는 넉넉히 잡아도 22~26을
 *   못 넘는다. 이 파일의 박스(x:[11,14])와 전혀 겹치지 않는다(22>14).
 *   (b) `rq-30-play-area-bounds.test.ts`의 점프 케이스 — 시작 x=29(세계
 *   경계 근접), 더 바깥쪽으로만 이동 — x:[11,14]와 무관.
 *   그 외 3개 파일은 전부 `dirX:0,dirZ:0`(제자리 점프)만 보낸다(전수 확인,
 *   `jumpAndObserveLanding`류 헬퍼가 공통으로 이 패턴을 쓴다) — 수평 이동이
 *   없으므로 좌표 무관.
 * - **순수 접지(비점프) 대규모 스윕** — `rq-30-play-area-bounds.test.ts`의
 *   4방향·대각선·중앙 스윕은 전부 z=0 또는 x=0을 축으로 고정한 채 이동한다
 *   (예: 중앙→가장자리 스윕은 z=0 고정, dirX=1). 아래 "접지 지속" 요구
 *   (groundedOutcome도 지지 높이를 본다) 때문에 **비점프 이동도 이론상
 *   박스 지지 높이의 영향을 받을 수 있지만**, 이 파일의 박스 z 범위([8,11])
 *   가 이 스윕들의 고정축(z=0/x=0)과 겹치지 않아 무관하다.
 *
 * `computeSpawnPoints`(재계산, `@shared/sim/spawn`의 `buildSpawnPoints`와
 * 동일 산식 — 반경 22, 15개 등간격, 정수 반올림): 0:(22,0)·1:(20,9)·
 * 2:(15,16)·3:(7,21)·4:(-2,22)·5:(-11,19)·6:(-18,13)·7:(-22,5)·8:(-22,-5)·
 * 9:(-18,-13)·10:(-11,-19)·11:(-2,-22)·12:(7,-21)·13:(15,-16)·14:(20,-9).
 * 이 박스(x:[11,14],z:[8,11])와 정확히 겹치는 지점은 없다(최근접은 인덱스1
 * (20,9), 거리 6 이상).
 *
 * **점프 궤적(현재 구현값, `movement.ts`의 `JUMP_GRAVITY_MPS2=20`·
 * `JUMP_V0_MPS=√(2·20·1.0)≈6.3246` 기준 — 중력은 "구현 자유값"이라 이
 * 라운드가 바꿀 이유가 없으므로 그대로 관측값을 쓴다, `t=n/30`초 매 틱
 * `y(t)=v0·t-10t²`)**: 상승 구간(대략 tick1~9)은 항상 상승, tick9~10
 * 부근(≈0.997m)이 최고점, 이후 하강. topY=0.4m를 하강 중 통과하는 지점은
 * tick16(h≈0.529, 아직 topY 위)과 tick17(h≈0.373, topY 아래) 사이 —
 * 그래서 착지는 tick17에 일어난다(박스가 있든 없든 이 관측은 동일 —
 * 박스가 있으면 tick17에 y=0.4로 스냅, 없으면 tick19에 y=0으로 스냅).
 * **이 파일은 "정확히 tick17에 착지한다"를 단언하지 않는다** — 대신 시작점
 * (x=8)에서 박스 근접면(x=11)까지 3m 여유를 두고, hold 구간을 tick25까지
 * (박스 원면(14)에서 1m 여유가 남는 x=13까지) 유지해 중력 상수가 달라져도
 * (예: 착지가 tick12~tick23 사이 어디서 일어나도) 이 파일의 검증이 깨지지
 * 않도록 여유를 크게 잡았다(구현 자유값에 대한 강한 결합 회피).
 *
 * **결정론(ADR-0008)**: 순수 산술, `Math.random()`·`Date.now()`·실 타이머
 * 없음 — 이 파일의 모든 테스트가 완전히 재현 가능한 정수 틱 반복이라는
 * 사실 자체로 증명된다(`sim-movement-walls.test.ts`와 동일 근거, 별도
 * 결정론 테스트 중복 추가 없음).
 */

/** 이 라운드의 잠정 박스 1개 — 실제 프로덕션 후보 좌표(위 docblock "좌표
 * 선택" 참고). 3m×3m, 상단 0.4m(< `MOVEMENT.JUMP_HEIGHT`=1.0m, GA-55
 * given). */
const BOX_ALPHA: BoxAABB = { minX: 11, maxX: 14, minZ: 8, maxZ: 11, topY: 0.4 }
const TEST_BOXES: readonly BoxAABB[] = [BOX_ALPHA]

/** 부동소수점 허용치 — `sim-movement-walls.test.ts`의 `WALL_TOLERANCE_M`과
 * 동일 값·동일 근거. */
const TOLERANCE_M = 1e-6

function createGroundedState(overrides: Partial<MoveState> = {}): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, ...overrides }
}

/** 매 틱 입력을 갈아 끼우며 전체 궤적(매 틱 상태)을 기록한다 — F2 규약
 * (`sim-movement-walls.test.ts`의 `runJumpSequence`)과 동일하게 마지막
 * 값만이 아니라 **비행 전체**를 관찰해야 "1틱 반짝임" 결함을 잡을 수
 * 있다. `inputAt(i)`는 0-based 틱 인덱스(i=0이 첫 틱)를 받는다. */
function runSequence(start: MoveState, ticks: number, inputAt: (tickIndex: number) => MoveInput, boxes: readonly BoxAABB[]): MoveState[] {
  const trajectory: MoveState[] = []
  let state = start
  for (let i = 0; i < ticks; i += 1) {
    // 25a-5 REV(원장 25a-7 동시 회수) — `stepMovement`의 3번째 인자가
    // 위치 인자(walls, boxes)에서 `StaticGeometry` 단일 객체로 바뀌었다.
    // 이 함수의 단언·기대값·좌표는 전혀 바뀌지 않는다 — 호출 구문만
    // 바뀐다.
    state = stepMovement(state, inputAt(i), { walls: [], boxes, ladders: [] })
    trajectory.push(state)
  }
  return trajectory
}

/** 같은 입력을 n틱 유지 — 질문1(수평 차단) 테스트는 방향 전환이 없는
 * 단순 반복이라 `runSequence`(틱별 입력 함수)보다 이 형태가 더 읽기
 * 쉽다. */
function runConstant(input: MoveInput, ticks: number, start: MoveState, boxes: readonly BoxAABB[]): MoveState {
  let state = start
  for (let i = 0; i < ticks; i += 1) {
    // 25a-5 REV — 위 `runSequence`와 동일한 호출 구문 변경(단언·기대값 무변경).
    state = stepMovement(state, input, { walls: [], boxes, ladders: [] })
  }
  return state
}

/** GA-55 given의 공유 시작점 — 박스(근접면 x=11) 3m 앞, z는 박스 z범위
 * 한가운데(9, [8,11] 중앙 부근)에 서 있다("박스 옆 지면에 서 있고"). */
const START: MoveState = createGroundedState({ x: 8, z: 9 })

/** 질문1(수평 차단) 테스트의 접근 여유 — `sim-movement-walls.test.ts`의
 * `WALL_APPROACH_MARGIN_M`과 동일 값·동일 근거(히트박스 반지름 0.3m보다
 * 넉넉해 반지름 처리 여부와 무관하게 통과한다). */
const APPROACH_MARGIN_M = 2
/** 걸어서(비점프) 접근 시 근접면까지 도달하기 충분한 틱 수 — 3m 거리를
 * 6m/s(0.2m/틱)로 걸으면 15틱, 정지·고착 여부까지 관찰할 여유를 크게
 * 얹었다. */
const WALK_APPROACH_TICKS = 60

/** hold 구간(박스 방향으로 이동 유지) 종료 틱 수 — 위 docblock "점프
 * 궤적" 절의 여유 계산 참고. 이 틱에서 x=8+0.2×25=13(박스 원면 14에서
 * 1m 여유). */
const HOLD_TICKS = 25
/** hold 종료 후 정지 상태를 몇 틱 더 관찰해 "접지 지속"(1틱 반짝임 아님)을
 * 확인할지. */
const SETTLE_TICKS = 5
const TOTAL_TICKS = HOLD_TICKS + SETTLE_TICKS

/** ①: 첫 틱만 이함(엣지 트리거) + 박스 방향(dirX=1) 유지, hold 종료 후
 * 정지(dirX=0)로 전환 — "착지 후에도 계속 그 자리에 서 있다"를 관찰하기
 * 위해서다(계속 박스 원면 밖으로 걸어 나가면 가장자리 낙하라는 별도
 * 스코프를 건드리게 된다, 위 docblock "명시적으로 정하지 않는 것" 참고). */
function inputTowardBox(tickIndex: number): MoveInput {
  const jump = tickIndex === 0
  const dirX = tickIndex < HOLD_TICKS ? 1 : 0
  return { dirX, dirZ: 0, mode: 'run', jump }
}

/** ②: 첫 틱만 이함 + 이후 전부 무입력(제자리) — 수평 관성이 전혀 없다. */
function inputInPlace(tickIndex: number): MoveInput {
  return { dirX: 0, dirZ: 0, mode: 'run', jump: tickIndex === 0 }
}

describe('RQ-22 박스 점프 — 순수 틱 함수 주입 계약 (GA-55 뒷받침, 골든 자체 검증은 통합 레벨)', () => {
  describe('GA-55①: 박스 방향으로 이동하며 점프 — 박스 상단에 착지해 접지 상태가 되고 y가 박스 높이와 같다', () => {
    const trajectory = runSequence(START, TOTAL_TICKS, inputTowardBox, TEST_BOXES)

    it('전제 확인 — 실제로 공중에 뜬 구간이 존재한다(즉시 스냅한 것이 아니라 진짜 비행)', () => {
      expect(trajectory.some((s) => !s.grounded)).toBe(true)
      // 초반(예: 6번째 틱, x=8+0.2×6=9.2 — 아직 박스 근접면(11) 훨씬 못
      // 미침)에는 공중이면서 박스 지지 높이보다 훨씬 높다 — 즉시 착지로
      // 스냅하는 오구현이 아님을 확인.
      const early = trajectory[5]
      expect(early).toBeDefined()
      expect(early!.grounded).toBe(false)
      expect(early!.y).toBeGreaterThan(BOX_ALPHA.topY)
    })

    it('결국 접지 상태가 되고, 그 y가 박스 상단 높이(topY)와 같다(0이 아니다)', () => {
      const landed = trajectory.find((s) => s.grounded)
      expect(landed).toBeDefined()
      expect(landed!.y).toBeCloseTo(BOX_ALPHA.topY, 6)
      expect(landed!.y).not.toBeCloseTo(0, 6) // 맨 지면(0)으로 꺼지지 않았다
      // 실제로 박스 XZ 범위 "위"에서 착지했다 — 우연히 다른 이유로 y가
      // 같아진 것이 아니라는 위치 증거.
      const landedIndex = trajectory.indexOf(landed!)
      expect(landed!.x).toBeGreaterThanOrEqual(BOX_ALPHA.minX - TOLERANCE_M)
      expect(landed!.x).toBeLessThanOrEqual(BOX_ALPHA.maxX + TOLERANCE_M)
      expect(landed!.z).toBeGreaterThanOrEqual(BOX_ALPHA.minZ - TOLERANCE_M)
      expect(landed!.z).toBeLessThanOrEqual(BOX_ALPHA.maxZ + TOLERANCE_M)
      expect(landedIndex).toBeLessThan(HOLD_TICKS) // hold 구간 안에서 일어났다(여유 계산 전제 확인)
    })

    it('접지 지속(1틱 반짝임 아님) — 착지 이후 hold를 유지하는 동안도, 정지한 뒤(settle)에도 y는 계속 박스 높이다', () => {
      const landedIndex = trajectory.findIndex((s) => s.grounded)
      expect(landedIndex).toBeGreaterThanOrEqual(0)
      // 착지 이후 끝까지(hold 잔여 + settle 전체) 단 한 틱도 y가 0으로
      // 꺼지지 않는다 — `groundedOutcome`이 하드코딩된 0을 쓰면 바로 다음
      // 틱에 이 단언이 깨진다(위 docblock "접지 지속" 절의 결함 재현).
      for (let i = landedIndex; i < trajectory.length; i += 1) {
        expect(trajectory[i]!.grounded).toBe(true)
        expect(trajectory[i]!.y).toBeCloseTo(BOX_ALPHA.topY, 6)
      }
    })

    it('정지(settle) 구간에서는 더 이상 수평으로 이동하지 않는다(박스 원면을 넘어가지 않는다 — 가장자리 낙하는 별도 스코프)', () => {
      const atHoldEnd = trajectory[HOLD_TICKS - 1]
      const atEnd = trajectory[trajectory.length - 1]
      expect(atHoldEnd).toBeDefined()
      expect(atEnd).toBeDefined()
      expect(atEnd!.x).toBeCloseTo(atHoldEnd!.x, 6)
      expect(atEnd!.x).toBeLessThan(BOX_ALPHA.maxX) // 원면을 넘지 않았다(여유 계산 전제 확인)
    })

    it('질문1 경계(팀리드 결정) — 박스 상단보다 높은 고도에서는 수평 이동이 막히지 않는다(박스 위를 그냥 지나간다)', () => {
      // 이 궤적은 근접면(x=11)을 tick15에서 넘어서고(x=11.0), topY(0.4)
      // 아래로 내려가는 것은 tick17(§파일 상단 "점프 궤적" 절)이다 —
      // 그 사이(tick15~16, 아직 공중이면서 y>topY)는 이미 박스 XZ 범위
      // 안이지만 아직 위쪽이라 차단되면 안 되는 구간이다. 옆면 차단이
      // (잘못) 높이를 안 보고 항상 걸리면 이 구간의 x가 근접면(11.0)에서
      // 멈춰 아래 등식이 깨진다.
      const tickSeconds = NET.TICK_MS / 1000
      let checkedAtLeastOne = false
      for (let i = 0; i < trajectory.length; i += 1) {
        const s = trajectory[i]!
        if (!s.grounded && s.y > BOX_ALPHA.topY) {
          checkedAtLeastOne = true
          const expectedUnblockedX = START.x + MOVEMENT.SPEED * (i + 1) * tickSeconds
          expect(s.x).toBeCloseTo(expectedUnblockedX, 6)
        }
      }
      // 전제 확인 — 위 조건(공중 + topY보다 높음)을 만족하는 틱이 실제로
      // 있었다(반복문이 공허하게 통과한 것이 아니다).
      expect(checkedAtLeastOne).toBe(true)
    })
  })

  describe('GA-55②: 정지 상태에서 제자리 점프 — 박스에 올라서지 못하고 원래 지면(y=0)으로 돌아온다', () => {
    const trajectory = runSequence(START, TOTAL_TICKS, inputInPlace, TEST_BOXES)

    it('수평 관성이 없어 박스 방향으로 전혀 이동하지 않는다(x·z 불변)', () => {
      for (const s of trajectory) {
        expect(s.x).toBeCloseTo(START.x, 6)
        expect(s.z).toBeCloseTo(START.z, 6)
      }
    })

    it('결국 접지 상태로 돌아오고, y는 박스 높이가 아니라 원래 지면(0)이다', () => {
      const settled = trajectory[trajectory.length - 1]
      expect(settled).toBeDefined()
      expect(settled!.grounded).toBe(true)
      expect(settled!.y).toBeCloseTo(0, 6)
      expect(settled!.y).not.toBeCloseTo(BOX_ALPHA.topY, 6)
    })

    it('전제 확인 — 실제로 공중에 뜬 구간은 있었다(제자리에서도 점프 자체는 일어난다)', () => {
      expect(trajectory.some((s) => !s.grounded)).toBe(true)
    })
  })

  describe('양성 대조군 — 박스가 주입돼 있어도 궤적이 박스 XZ 범위를 지나지 않으면 영향이 전혀 없다', () => {
    it('박스와 반대쪽(z=-9)에서 같은 이동+점프를 반복하면 박스 없는 물리와 동일하다(최고점≈JUMP_HEIGHT, 결국 y=0 복귀)', () => {
      const farStart = createGroundedState({ x: 8, z: -9 })
      const trajectory = runSequence(farStart, TOTAL_TICKS, inputTowardBox, TEST_BOXES)

      expect(Math.max(...trajectory.map((s) => s.y))).toBeCloseTo(MOVEMENT.JUMP_HEIGHT, 1)
      const settled = trajectory[trajectory.length - 1]
      expect(settled).toBeDefined()
      expect(settled!.grounded).toBe(true)
      expect(settled!.y).toBeCloseTo(0, 6) // 박스 지지 높이(0.4)가 아니라 맨 지면
    })

    it('같은 좌표·같은 입력이라도 박스를 아예 주지 않으면(boxes=[]) 결과가 동일하다(박스 목록 자체가 결과를 좌우하지 않는 경로)', () => {
      const withEmptyBoxes = runSequence(START, TOTAL_TICKS, inputTowardBox, [])
      const settled = withEmptyBoxes[withEmptyBoxes.length - 1]
      expect(settled).toBeDefined()
      expect(settled!.grounded).toBe(true)
      expect(settled!.y).toBeCloseTo(0, 6) // 박스가 없으니 맨 지면에 착지
    })
  })

  describe('질문1(팀리드 결정, 원장 회신) — 박스는 고체다: 상단(topY)보다 낮은 높이에서는 옆면이 수평 이동을 막는다', () => {
    it('걸어서(점프 없이) 박스로 접근하면 근접면을 넘지 않는다(통과 금지) — 올라타지 못해 y는 0에 머문다', () => {
      const towardBox: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
      const state = runConstant(towardBox, WALK_APPROACH_TICKS, START, TEST_BOXES)

      // 통과 금지 — 근접면(minX=11)을 넘지 않았다(부동소수 오차만 허용).
      expect(state.x).toBeLessThanOrEqual(BOX_ALPHA.minX + TOLERANCE_M)
      // 고착이 아니라 실제로 근접면까지 밀렸다(근접면 2m 이내까지는 접근).
      expect(state.x).toBeGreaterThan(BOX_ALPHA.minX - APPROACH_MARGIN_M)
      // 박스 범위에 들어가지 못했으니 지지 높이도 여전히 맨 지면(0)이다
      // — "차단 없이 걸어 들어가 y가 솟아오른다"는 대안(질문1의 (b))이
      // 아니라는 것을 직접 확인.
      expect(state.grounded).toBe(true)
      expect(state.y).toBeCloseTo(0, 6)
    })

    it('고착 금지 — 박스 옆면에 막혀 멈춘 뒤 반대 방향 입력은 정상 반영되어 위치가 박스에서 멀어진다', () => {
      const towardBox: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
      const atBox = runConstant(towardBox, WALK_APPROACH_TICKS, START, TEST_BOXES)
      // 전제 확인 — 실제로 근접면 근처까지 밀렸어야 다음 단계가 의미를 갖는다.
      expect(atBox.x).toBeLessThanOrEqual(BOX_ALPHA.minX + TOLERANCE_M)
      expect(atBox.x).toBeGreaterThan(BOX_ALPHA.minX - APPROACH_MARGIN_M)

      const RELEASE_TICKS = 30
      const awayFromBox: MoveInput = { dirX: -1, dirZ: 0, mode: 'run', jump: false }
      const released = runConstant(awayFromBox, RELEASE_TICKS, atBox, TEST_BOXES)

      // 유의미하게 멀어졌다(고착 아님) — 1초 상당(30틱)이면 6m/s×1s=6m
      // 멀어진다(`sim-movement-walls.test.ts`의 동일 케이스와 같은 여유).
      expect(released.x).toBeLessThan(atBox.x - 1)
    })

    it('경계값(팀리드 결정) — 직전 높이가 박스 상단과 정확히 같으면(y===topY) "위"로 취급해 차단하지 않는다', () => {
      // 합성 상태 — 근접면(x=11) 바로 밖(0.1m)에서 높이가 정확히 topY인
      // 접지 상태를 직접 구성한다(REV 2026-07-24 "상태는 값의 완전한
      // 스냅샷" 정신 — 이 정확한 조합에 실제로 도달하는 자연스러운
      // 경로가 있는지와 무관하게, 판정은 상태 값만으로 결정돼야 한다).
      //
      // **REV(독립 평가 F1 대응)** — 원래 0.2m를 썼으나 1틱 변위가
      // 정확히 `MOVEMENT.SPEED × TICK_SECONDS = 6 × (1/30) = 0.2`라
      // `minX-0.2`에서 출발하면 다음 x가 **정확히 minX**가 된다.
      // `clampAgainstWalls`의 절단 조건(`x > wall.minX`, 개방 구간)은
      // "근접면을 넘어섰을 때"만 절단하므로, 정확히 minX에서 멈추는
      // 결과는 차단됐든(clamp) 안 됐든(자연 이동) 동일하다 — 이 테스트가
      // `y < topY`를 `y <= topY`로 뒤집는 변이를 잡지 못하는 공허한
      // 그물이었다(평가자 실측: 30/30 통과, 변이해도 그대로 통과).
      // 0.1m로 시작점을 당기면 다음 x가 minX+0.1(=11.1, 근접면을
      // 넘어선 값)이 되어 차단 여부에 따라 결과가 갈린다 — 아래
      // §8.5(REV) 실증 참고.
      const atTopHeight = createGroundedState({ x: BOX_ALPHA.minX - 0.1, y: BOX_ALPHA.topY, z: 9 })
      const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
      // 25a-5 REV — 호출 구문만 객체 형태로 변경(단언·기대값 무변경).
      const next = stepMovement(atTopHeight, input, { walls: [], boxes: TEST_BOXES, ladders: [] })

      // 차단됐다면 근접면(minX=11)에 멈췄을 것이다(x=11) — 이 결정("이상"은
      // 차단 없음)에서는 자유롭게 한 틱만큼 전진해 근접면을 넘어선다
      // (x=11.1). 기대값은 계산식이라 시작 좌표를 따라간다.
      const tickSeconds = NET.TICK_MS / 1000
      const expectedX = atTopHeight.x + MOVEMENT.SPEED * tickSeconds
      expect(next.x).toBeCloseTo(expectedX, 6)
    })
  })

  describe('기본값 호환 — 지오메트리에서 boxes를 비우면 기존 동작(박스 없음) 그대로다(회귀 가드, ADR-0010 하위 호환)', () => {
    it('GA-55①과 정확히 같은 경로를, 지오메트리에서 boxes를 비운 채(walls만 채운 StaticGeometry) 재생하면 박스를 무시하고 y=0으로 착지한다', () => {
      let state: MoveState = START
      for (let i = 0; i < TOTAL_TICKS; i += 1) {
        // 25a-5 REV — 옛 "3-인자(walls만, boxes 생략)" 형태의 정확한 등가는
        // 이제 walls·boxes·ladders를 전부 빈 값으로 명시한 geometry 객체다
        // (단언·기대값 무변경 — 호출 구문만 바뀐다).
        state = stepMovement(state, inputTowardBox(i), { walls: [], boxes: [], ladders: [] })
      }
      expect(state.grounded).toBe(true)
      expect(state.y).toBeCloseTo(0, 6)
    })

    it('walls·boxes 둘 다 생략한 기존 2-인자 호출도 그대로 동작한다(13개 기존 호출부와 동일 형태)', () => {
      let state: MoveState = START
      for (let i = 0; i < TOTAL_TICKS; i += 1) {
        state = stepMovement(state, inputTowardBox(i)) // 2-인자 — walls·boxes 둘 다 생략
      }
      expect(state.grounded).toBe(true)
      expect(state.y).toBeCloseTo(0, 6)
    })
  })
})

/**
 * 리뷰 blocker 재현 — 박스 위에 선 플레이어는 점프할 수 없다(ADR-0011
 * 결정 1: `src/shared` 결함 재현은 test-writer 전유, `src/`는 건드리지
 * 않는다).
 *
 * **결함(리뷰어 실측)**: `jumpHeightAt(t)`는 **y=0 기준 절대 높이**
 * 곡선인데, `airborneOutcome`이 착지 스냅을 `jumpHeightAt(t) <= standing
 * Height(x,z,boxes)`로 판정한다 — 이함 높이(박스 위 topY)만큼 궤적을
 * 오프셋하지 않는다. 그래서 이함 첫 틱(`jumpHeightAt(TICK_SECONDS)`
 * ≈0.1997m, 아래서 리터럴 없이 유도)이 박스 `topY` 이하면 착지 스냅
 * 조건이 **이함 그 자체에서 이미 참**이 되어 점프가 통째로 삼켜진다.
 * `topY`가 그 임계선 아래여도(스웰로 증상은 없다) 궤적 자체가 여전히
 * **절대** 곡선이라 정점이 발밑 기준(`topY + JUMP_HEIGHT`)에서 어긋난다
 * — 두 증상이 같은 뿌리(절대 vs 발밑 기준)라 이 파일 하나가 함께 덮는다.
 *
 * **회귀 대상**: RQ-20("점프를 지원해야 한다", 무조건절)·RQ-92(점프 높이
 * 1.0m) — 이 라운드(RQ-22)가 만들기 전까지는 두 RQ 모두 ✅였다.
 *
 * **레벨**: 순수 로직(`airborneOutcome`/`standingHeight`의 산술 그
 * 자체가 결함이다)이라 단위 레벨에서 재현한다. 실서버 도달 경로는
 * 가설이 아니다 — 통합 테스트 GA-55①(`rq-22-box-jump.test.ts`)이 이미
 * 매 실행마다 플레이어를 정확히 `player.y=BOX_ALPHA.topY, grounded=true`
 * 상태로 데려다 놓는다. 그 상태에서 스페이스를 누르는 것이 아래
 * `standingOnBoxTop`이 합성하는 상태와 정확히 같다.
 *
 * **여러 박스 높이로 시험하는 이유**: 임계선(`ONE_TICK_AIRBORNE_HEIGHT_M`
 * ≈0.1997) **아래**(삼켜짐 증상 없음, 정점 어긋남만 발생)와 **위**
 * (`BOX_ALPHA.topY`=0.4, 그리고 RQ-32 상한 근접 `JUMP_HEIGHT-0.1`=0.9,
 * 삼켜짐 발생)를 각각 시험해야 "임계값이 코드에 우연히 남는" 수정(예:
 * `BOX_ALPHA.topY`에만 특화된 하드코딩)을 잡는다. 좌표·높이는 전부
 * `BOX_ALPHA`·`MOVEMENT.JUMP_HEIGHT`에서 유도한다(ADR-0010 — 리터럴 금지).
 * 임계값(0.1997)도 `jumpHeightAt`을 직접 import하는 대신(비공개 함수,
 * export 요구는 `src/` 수정이라 금지) **공개 API(`stepMovement`)로 평지
 * 이함 1틱을 실제로 실행해 유도**한다.
 *
 * **수정 방향은 강제하지 않는다** — 관측 가능한 행동(이함 여부·정점
 * 높이·착지 위치)만 단언한다. `airborneOutcome`이 궤적을 발밑 기준으로
 * 오프셋하든, `standingHeight`를 궤적 계산 이전에 빼서 상대 좌표로
 * 바꾸든, 그 구현 선택은 coder 몫이다.
 *
 * **결정론(ADR-0008)**: 순수 산술, `Math.random()`·`Date.now()`·실
 * 타이머 없음 — 이 describe의 모든 테스트가 완전히 재현 가능한 정수 틱
 * 반복이라는 사실 자체로 증명된다.
 */
describe('리뷰 blocker 재현 — 박스 위에서 점프하면 (박스 높이에 따라) 이함이 삼켜지거나 정점이 발밑 기준을 벗어난다', () => {
  /** 이함 1틱 후 절대 높이 — `jumpHeightAt(TICK_SECONDS)`를 리터럴로
   * 박지 않고 공개 API(박스 없는 평지 이함)로 유도한다. 현재 구현
   * (g=20, `JUMP_HEIGHT`=1.0)에서는 약 0.1997m다 — 결함의 정확한
   * 임계선이며, 매 실행마다 이 함수 자체에서 재도출되므로 물리 상수가
   * 바뀌어도 따라간다. */
  // 25a-5 REV — 옛 4-인자(walls=[], boxes=[]) 호출의 정확한 등가는
  // geometry 객체 하나로 감싸는 것이다(단언·기대값 무변경).
  const ONE_TICK_AIRBORNE_HEIGHT_M = stepMovement(
    createGroundedState(),
    { dirX: 0, dirZ: 0, mode: 'run', jump: true },
    { walls: [], boxes: [], ladders: [] },
  ).y

  const BOX_CENTER_X = (BOX_ALPHA.minX + BOX_ALPHA.maxX) / 2
  const BOX_CENTER_Z = (BOX_ALPHA.minZ + BOX_ALPHA.maxZ) / 2

  /** `BOX_ALPHA`와 같은 발자국(footprint), 높이만 다른 박스 — 임계선
   * 위·아래를 갈아 끼우기 위한 헬퍼. */
  function boxWithTopY(topY: number): BoxAABB {
    return { minX: BOX_ALPHA.minX, maxX: BOX_ALPHA.maxX, minZ: BOX_ALPHA.minZ, maxZ: BOX_ALPHA.maxZ, topY }
  }

  /** "박스 위에 이미 서 있다" 합성 상태 — GA-55① 통합 테스트가 실서버에서
   * 실제로 도달시키는 상태와 동형(위 docblock 참고). */
  function standingOnBoxTop(topY: number): MoveState {
    return createGroundedState({ x: BOX_CENTER_X, y: topY, z: BOX_CENTER_Z })
  }

  /** 제자리 수직 점프 — 첫 틱만 이함(엣지 트리거), 이후 유지 입력. 수평
   * 이동이 전혀 없으니 박스 옆면 차단(질문1)과는 무관하다. */
  function verticalJumpInput(tickIndex: number): MoveInput {
    return { dirX: 0, dirZ: 0, mode: 'run', jump: tickIndex === 0 }
  }

  /** 착지까지 관측하기 충분한 틱 수 — 발밑 기준으로 올바르게 고쳐지면
   * 비행 시간은 박스 높이와 무관하다(같은 상대 포물선을 topY만큼
   * 평행이동한 것뿐이므로 중력·초기속도가 그대로인 한 소요 시간도
   * 그대로다) — 기존 관측값(~19틱, `sim-movement-walls.test.ts` "점프
   * 궤적" 절)과 같은 규모, 30틱이면 착지 후 여유까지 넉넉하다. */
  const TICKS = 30

  const CASES = [
    {
      label: '임계선 아래(0.1997m의 절반) — 삼켜짐은 없어야 하지만 정점은 여전히 발밑 기준을 벗어난다',
      topY: ONE_TICK_AIRBORNE_HEIGHT_M / 2,
    },
    { label: 'BOX_ALPHA 실제 배치(0.4m, 임계선 위) — 리뷰가 지목한 즉시 삼켜짐 그 자체', topY: BOX_ALPHA.topY },
    {
      label: 'RQ-32 상한 근접(JUMP_HEIGHT-0.1m) — 삼켜짐이 가장 심한 경우',
      topY: MOVEMENT.JUMP_HEIGHT - 0.1,
    },
  ]

  it.each(CASES)('박스 상단($label)에서 점프 — ①이함 ②정점(발밑+JUMP_HEIGHT) ③박스 위 재착지', ({ topY }) => {
    const trajectory = runSequence(standingOnBoxTop(topY), TICKS, verticalJumpInput, [boxWithTopY(topY)])

    // ① 박스 위에서 점프하면 이함한다 — 첫 틱부터 공중이어야 한다(평지
    // 이함과 동일한 즉시성). 삼켜지면 이 틱조차 grounded=true로 남는다
    // (리뷰 blocker의 핵심 증상).
    expect(trajectory[0]!.grounded).toBe(false)

    // ② 정점이 발밑 기준(topY + JUMP_HEIGHT)이다 — 절대 기준(그냥
    // JUMP_HEIGHT)이면 이 단언이 topY만큼 어긋난다. 평지 대조군과 동일한
    // 허용오차(소수 1자리, 이산 틱 샘플링 오차 흡수)를 쓴다.
    const apex = Math.max(...trajectory.map((s) => s.y))
    expect(apex).toBeCloseTo(topY + MOVEMENT.JUMP_HEIGHT, 1)

    // ③ 박스 위로 되돌아 착지한다 — 맨 지면(0)이 아니라 박스 높이다.
    const settled = trajectory[trajectory.length - 1]!
    expect(settled.grounded).toBe(true)
    expect(settled.y).toBeCloseTo(topY, 6)
  })

  it('평지 양성 대조군 — 박스가 전혀 없으면 기존 동작이 변하지 않는다(정점≈JUMP_HEIGHT, 착지 y=0)', () => {
    const trajectory = runSequence(createGroundedState(), TICKS, verticalJumpInput, [])

    expect(trajectory[0]!.grounded).toBe(false)
    const apex = Math.max(...trajectory.map((s) => s.y))
    expect(apex).toBeCloseTo(MOVEMENT.JUMP_HEIGHT, 1)

    const settled = trajectory[trajectory.length - 1]!
    expect(settled.grounded).toBe(true)
    expect(settled.y).toBeCloseTo(0, 6)
  })
})
