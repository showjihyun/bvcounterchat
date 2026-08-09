import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveState, type MoveInput, type LadderVolume, type StaticGeometry } from '@shared/sim/movement'
import { AUDIO, FALL_DAMAGE } from '@shared/constants'
import {
  stepFootstepAccumulator,
  shouldPlayLandingSound,
  isWithinAudibleRange,
  isFootstepAudible,
  type FootstepTickInput,
} from '@shared/sim/footsteps'

/**
 * RQ-72(발소리·착지음, 신설 v2.5 2026-08-09) — 순수 로직 단위 테스트
 * (ADR-0008: 순수 함수·결정론·`src/shared` 환경 중립, ADR-0011: `src/shared`
 * 전체는 Red-first 영역). 수치 정본은 ADR-0014("오디오 스택과 발소리의
 * 권위") 결정 4다.
 *
 * **매핑된 골든 케이스**: GA-77·78·79·80·81·82·84·85·86·87·88·89
 * (`harness/evals/golden/track-a-product.jsonl`, 전부 `verify: ""` — 이
 * 파일이 그 첫 커버리지다). **GA-83은 이 라운드 대상이 아니다** —
 * 원격 플레이어의 클라이언트 렌더 프레임률(60fps vs 20fps)이 발소리
 * 횟수·발생 지점에 영향을 주지 않아야 한다는 골든인데, 이는 "서버 30Hz
 * 스냅샷을 클라가 어떻게 표본화하는가"(RQ-63 보간 배선)의 문제이지 이
 * 파일이 다루는 순수 누적 함수 자체의 문제가 아니다 — 이 함수는 이미 정해진
 * 수평 변위 시퀀스를 받아 발소리를 세는 것이 전부이고, "성긴 표본이 굽은
 * 경로에서 거리를 짧게 만든다"는 함정은 **그 변위 시퀀스를 클라가 어떻게
 * 만들어내는가**(30Hz 스냅샷 보간 vs 렌더 프레임 표본)에 있다. 원격
 * 배선(2/2)이 담당한다 — 산출 지시 원문 그대로.
 *
 * **이 라운드의 범위**: `src/shared`의 순수 층만 — 세 가지 판정만 검증한다.
 * 1. 발소리 누적·발생(`stepFootstepAccumulator`)
 * 2. 착지음 발생(`shouldPlayLandingSound`)
 * 3. 가청 판정(`isWithinAudibleRange`/`isFootstepAudible`)
 * 오디오 합성(Web Audio 노이즈+엔벨로프, ADR-0014 결정 2)과 클라이언트
 * 배선은 스코프 밖이다.
 *
 * ---
 *
 * ## 왜 실제 `stepMovement`로 수평 변위를 유도하는가(하드코딩된 상수 반복이
 * 아니라) — floating-point 실측 함정
 *
 * `MOVEMENT.SPEED × TICK_SECONDS`(=0.2, run의 틱당 변위)를 **한 번 계산해
 * 20회 반복 가산**하는 방식으로 GA-77(4.0m→2회)을 구성하면 **실패한다** —
 * 실측(node 프로브, 이 리포트 하단 "Red 실행 출력" 이전 단계에서 확인):
 *
 * ```
 * 0.2를 20회 누적 가산 → 10번째 누적 1.9999999999999998(<2.0, 미발화),
 * 11번째 2.1999999999999997(발화) → 이후 9회 더해도(9×0.2)
 * 1.9999999999999998까지만 도달, 20번째까지 2회째가 발화하지 않는다
 * (총 1회만 발화).
 * ```
 *
 * 반면 **실제** `stepMovement`가 매 틱 `state.x + vx×TICK_SECONDS`로
 * **직전 위치에서** 다시 계산하는 진짜 경로를 20틱 재생하면(같은 물리,
 * 같은 상수) 반올림 오차의 누적 양상이 달라져 **10번째가 아니라 11번째에
 * 첫 발화, 20번째에 두 번째 발화**가 정확히 일어난다(실측 확인,
 * `Math.hypot(next.x - state.x, next.z - state.z)`로 매 틱 변위를 유도).
 * 이것은 구현 버그가 아니라 **IEEE 754 부동소수점 산술의 결정론적 성질**이다
 * — 같은 연산 순서를 밟으면 항상 같은 결과가 나오지만, "상수를 미리 계산해
 * 반복 가산"과 "매 틱 직전 값에 다시 가산"은 **다른 연산 순서**라 반올림
 * 오차가 다르게 쌓인다. `GameRoom`/`prediction.ts`가 실제로 만드는 변위는
 * 후자(매 틱 `MoveState.x`의 차분)이므로, 이 테스트도 그 경로를 그대로
 * 재생해야 골든의 "정확히 2회"가 재현 가능한 주장이 된다(팀리드 지시
 * "골든의 거리는 전부 이 격자에 맞춰 놨으니 틱 수로 환산해 검증하라"의
 * 실행). 아래 `driveReal` 헬퍼가 이 재생을 전담한다 — GA-77·78·79·84·85
 * (착지 후 구간)·88·89(리스폰 후 구간)가 전부 이 헬퍼로 변위를 유도한다.
 * 거리 자체가 무관한 검증(GA-77 "시간이 아니라 거리로 센다" 보강, GA-89의
 * discontinuous 리셋값 20m 등)에서만 정확한 리터럴(1.0, 20 등 — 이진
 * 부동소수점으로 정확히 표현되는 값)을 직접 주입한다.
 *
 * ---
 *
 * ## 그린필드 계약(test-writer 지정, `sim-fall-damage.test.ts`/`sim-ammo.test.ts`
 * 선례와 동일한 권한). `coder`가 아래대로 구현하면 이 파일이 Green이 된다.
 *
 * ### `src/shared/constants.ts`에 추가 — 신규 `AUDIO` 블록
 *
 * ```ts
 * /** 오디오 (RQ-72, ADR-0014 결정 4) * /
 * export const AUDIO = {
 *   /** 가청 거리(m) — 발소리·착지음 공통. `WORLD.SIZE_M`에서 유도하지
 *    * 않는 **독립 상수**다(ADR-0014 결정 4, 사용자 결정 — 맵 크기가
 *    * 바뀌어도 가청 거리는 따라 움직이지 않는다). * /
 *   AUDIBLE_RANGE_M: 15,
 *   /** 발소리 1회당 누적 수평 이동 거리(m, 보폭). 달리기 6m/s ÷ 2.0m =
 *    * 초당 3보(ADR-0014 결정 4). * /
 *   FOOTSTEP_STRIDE_M: 2.0,
 * } as const
 * ```
 *
 * 착지음 임계는 새 상수를 만들지 않는다 — `FALL_DAMAGE.SAFE_HEIGHT_M`을
 * **그대로** 재사용한다(ADR-0014 결정 4 "착지음 임계 | FALL_DAMAGE
 * .SAFE_HEIGHT_M 그대로 | 남은 자유도: 없음").
 *
 * ### `src/shared/sim/footsteps.ts`(신설) — `fallDamage.ts`/`ammo.ts` 옆
 *
 * ```ts
 * import { AUDIO, FALL_DAMAGE } from '@shared/constants'
 *
 * // 이번 틱의 상태 — 호출자(GameRoom·prediction.ts)가 매 틱 채워 넘긴다.
 * export interface FootstepTickInput {
 *   // 이번 틱이 **시작된** 시점(직전 틱이 끝난 시점)의 MoveState.grounded.
 *   wasGrounded: boolean
 *   // 이번 틱이 **끝난** 시점(이번 stepMovement 호출 결과)의 MoveState.grounded.
 *   isGrounded: boolean
 *   mode: 'run' | 'walk' | 'crouch'
 *   // 이번 틱의 수평 이동 거리(m) — Math.hypot(다음.x-이전.x, 다음.z-이전.z).
 *   // 유한하지 않거나(NaN·Infinity) 음수면 0으로 취급(방어적, RQ-61 원칙).
 *   horizontalDeltaM: number
 *   // 이번 틱이 위치를 불연속으로 재설정한 사건(리스폰·최초 스폰·재접속)의
 *   // 결과 틱이면 true. true면 horizontalDeltaM은 완전히 무시되고 누적이
 *   // 0으로 초기화된다 — wasGrounded/isGrounded/mode도 함께 무시된다.
 *   discontinuous: boolean
 * }
 *
 * export interface FootstepAccumulatorResult {
 *   accumM: number       // 다음 틱에 이어서 쓸 누적값
 *   footstepCount: number // 이번 틱에 발생한 발소리 횟수(보통 0 또는 1)
 * }
 *
 * // RQ-72/ADR-0014 결정 4 — 발소리 누적기. stepMovement와 동일하게
 * // 정확히 1틱을 전진하는 순수 함수다(호출자가 틱마다 반복 호출).
 * //
 * // 누적 대상(eligible) = wasGrounded && isGrounded && mode === 'run'.
 * // **양쪽 끝 모두 grounded여야 하는 이유(GA-85)**: 이함(도약) 틱은
 * // wasGrounded=true·isGrounded=false, 착지 틱은 wasGrounded=false·
 * // isGrounded=true다 — 어느 한쪽만 확인하면 이함 틱 또는 착지 틱의
 * // 0.2m가 누적으로 새어 들어간다(실측: "post landing" 누적이 1.4가
 * // 아니라 1.6이 된다). 양쪽 다 true일 때만 "이번 틱 전체가 순수하게
 * // 접지 물리로 결정됐다"는 것이 보장된다. 사다리(GA-84)는 이 조건에
 * // 아무 영향이 없다 — ladderOutcome은 시작·끝 모두 grounded:true를
 * // 돌려준다(별도 설계 결정, movement.ts:812).
 * //
 * // eligible이면 accumM += horizontalDeltaM, 아니면 accumM은 그대로.
 * // 그 다음 floor(accumM / strideM)회의 발소리가 발생하고, 매회 accumM에서
 * // strideM을 차감한다(0으로 리셋하지 않는다 — RQ-72 원문).
 * // discontinuous면 위 계산을 전부 건너뛰고 { accumM: 0, footstepCount: 0 }.
 * export function stepFootstepAccumulator(
 *   accumM: number,
 *   input: FootstepTickInput,
 *   strideM: number,
 * ): FootstepAccumulatorResult
 *
 * // RQ-72/ADR-0014 결정 4 — 착지음 발생 판정. fallDamageForHeight와
 * // 동일한 경계(FALL_DAMAGE.SAFE_HEIGHT_M **초과**만 true, 경계 포함은
 * // false) — 파일 배치 이웃 `fallDamage.ts`와 같은 상수를 그대로 재사용한다.
 * // 방어적으로 유한하지 않거나 음수인 높이는 false(낙하하지 않은 것과 동일).
 * // mode(자세)를 인자로 받지 않는다 — 착지음은 자세와 무관하다(GA-86).
 * export function shouldPlayLandingSound(fallHeightM: number): boolean
 *
 * // RQ-72/ADR-0014 결정 4 — 가청 판정 공통 규칙(발소리·착지음 동일하게
 * // 적용, GA-87). 경계 포함(<=). 방어적으로 유한하지 않은 거리는 false.
 * export function isWithinAudibleRange(horizontalDistanceM: number, audibleRangeM: number): boolean
 *
 * // RQ-72 — 발소리 전용 가청 판정: 자기 발소리는 거리 판정 없이 항상
 * // 들린다(GA-81). isSelf가 아니면 isWithinAudibleRange 그대로.
 * export function isFootstepAudible(horizontalDistanceM: number, isSelf: boolean, audibleRangeM: number): boolean
 * ```
 *
 * **호출자(GameRoom·prediction.ts) 배선 가정(이 파일의 범위 밖, 2/2 라운드
 * 참고용)**: 세션별 `footstepAccumM`(초기 0)을 서버가 전유 상태로 관리한다.
 * 매 틱 `stepMovement` 호출 전후로 `wasGrounded = previous.grounded`,
 * `isGrounded = next.grounded`를 뽑고, `discontinuous`는 `respawnPlayer`가
 * 실행된 바로 그 틱(`positionHistory.delete`와 같은 지점, GameRoom.ts:1409
 * 인근)에서만 true로 세팅한다 — 최초 스폰(`onJoin`)·재접속도 같은 신호를
 * 세운다. 착지음은 기존 `fallPeakY`(RQ-18 트래킹, `trackFallDamage`)가
 * 공중→접지 전이 시점에 이미 낙하 높이를 들고 있으므로 그 값을
 * `shouldPlayLandingSound`에 그대로 넘기면 된다(새 트래킹 불필요).
 */

// ---------------------------------------------------------------------------
// 테스트 헬퍼
// ---------------------------------------------------------------------------

const GROUNDED_RUN_INPUT: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
const GROUNDED_WALK_INPUT: MoveInput = { dirX: 1, dirZ: 0, mode: 'walk', jump: false }
const GROUNDED_CROUCH_INPUT: MoveInput = { dirX: 1, dirZ: 0, mode: 'crouch', jump: false }

function originState(): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true }
}

/** 실제 `stepMovement`를 `ticks`회 재생해 매 틱의 실측 수평 변위를 뽑는다
 * (위 docblock "왜 실제 stepMovement로 유도하는가" 참고 — 하드코딩 상수
 * 반복 가산과 반올림 오차 양상이 다르다). `geometry`가 있으면 사다리 등
 * 정적 지오메트리를 함께 재생한다. */
function driveReal(
  state: MoveState,
  input: MoveInput,
  ticks: number,
  geometry?: StaticGeometry,
): { deltas: number[]; grounded: boolean[]; finalState: MoveState } {
  const deltas: number[] = []
  const grounded: boolean[] = []
  let s = state
  for (let i = 0; i < ticks; i++) {
    const next = geometry ? stepMovement(s, input, geometry) : stepMovement(s, input)
    deltas.push(Math.hypot(next.x - s.x, next.z - s.z))
    grounded.push(next.grounded)
    s = next
  }
  return { deltas, grounded, finalState: s }
}

/** `stepFootstepAccumulator`를 순서대로 여러 틱 적용해 누적 발소리 수를 센다. */
function driveAccumulator(
  accumM: number,
  ticks: readonly FootstepTickInput[],
  strideM: number = AUDIO.FOOTSTEP_STRIDE_M,
): { accumM: number; totalFootsteps: number } {
  let acc = accumM
  let total = 0
  for (const t of ticks) {
    const result = stepFootstepAccumulator(acc, t, strideM)
    acc = result.accumM
    total += result.footstepCount
  }
  return { accumM: acc, totalFootsteps: total }
}

/** 실측 변위 배열을 접지·run 틱 입력 목록으로 변환하는 편의 함수(가장 흔한
 * 경우 — 시작부터 끝까지 계속 접지 상태인 단일 자세 구간). */
function groundedTicks(
  deltas: readonly number[],
  mode: FootstepTickInput['mode'],
): FootstepTickInput[] {
  return deltas.map((horizontalDeltaM) => ({
    wasGrounded: true,
    isGrounded: true,
    mode,
    horizontalDeltaM,
    discontinuous: false,
  }))
}

// ---------------------------------------------------------------------------
// GA-77: run — 거리 기준 발소리(2.0m 보폭)
// ---------------------------------------------------------------------------

describe('RQ-72/GA-77: stepFootstepAccumulator — run 발소리, 보폭 2.0m마다 1회', () => {
  it('접지 상태로 run 20틱(실측 총 4.0m 직선 이동)이면 발소리가 정확히 2회 발생한다', () => {
    const { deltas } = driveReal(originState(), GROUNDED_RUN_INPUT, 20)
    const totalDistance = deltas.reduce((a, b) => a + b, 0)
    expect(totalDistance).toBeCloseTo(4.0, 6) // 전제 확인 — 실제로 4.0m를 이동했다

    const { totalFootsteps, accumM } = driveAccumulator(0, groundedTicks(deltas, 'run'))
    expect(totalFootsteps).toBe(2)
    expect(accumM).toBeGreaterThanOrEqual(0)
    expect(accumM).toBeLessThan(AUDIO.FOOTSTEP_STRIDE_M) // 다음 발소리까지 남은 거리 — 스트라이드 미만
  })

  it('경과 시간이 아니라 이동 거리로 센다 — 더 큰 스텝(1.0m×4회)으로 같은 총 4.0m를 이동해도 2회다', () => {
    // 정확히 이진 부동소수점으로 표현되는 리터럴(1.0, 2.0)만 써서 반올림
    // 오차 없이 "몇 스텝으로 나누든 총 거리가 같으면 결과가 같다"를 검증한다.
    const ticks: FootstepTickInput[] = [1.0, 1.0, 1.0, 1.0].map((horizontalDeltaM) => ({
      wasGrounded: true,
      isGrounded: true,
      mode: 'run',
      horizontalDeltaM,
      discontinuous: false,
    }))
    const { totalFootsteps, accumM } = driveAccumulator(0, ticks)
    expect(totalFootsteps).toBe(2)
    expect(accumM).toBe(0)
  })

  it('RQ-72 실측값(AUDIO.FOOTSTEP_STRIDE_M=2.0)으로도 동일하게 성립한다', () => {
    expect(AUDIO.FOOTSTEP_STRIDE_M).toBe(2.0)
  })
})

// ---------------------------------------------------------------------------
// GA-78/79: walk·crouch — 완전 무음(거리를 저축하는 수단이 아니다)
// ---------------------------------------------------------------------------

describe('RQ-72/GA-78: stepFootstepAccumulator — walk(Shift)는 완전 무음', () => {
  it('접지 상태로 walk 72틱(실측 총 10m 이상 직선 이동)해도 발소리가 0회다', () => {
    const { deltas } = driveReal(originState(), GROUNDED_WALK_INPUT, 72)
    const totalDistance = deltas.reduce((a, b) => a + b, 0)
    expect(totalDistance).toBeGreaterThanOrEqual(10) // 전제 확인 — GA-78 given "10m 이동"

    const { totalFootsteps } = driveAccumulator(0, groundedTicks(deltas, 'walk'))
    expect(totalFootsteps).toBe(0)
  })
})

describe('RQ-72/GA-79: stepFootstepAccumulator — crouch(Ctrl)는 완전 무음', () => {
  it('접지 상태로 crouch 100틱(실측 총 10m 직선 이동)해도 발소리가 0회다', () => {
    const { deltas } = driveReal(originState(), GROUNDED_CROUCH_INPUT, 100)
    const totalDistance = deltas.reduce((a, b) => a + b, 0)
    expect(totalDistance).toBeCloseTo(10, 6) // 전제 확인 — GA-79 given "10m 이동"

    const { totalFootsteps } = driveAccumulator(0, groundedTicks(deltas, 'crouch'))
    expect(totalFootsteps).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// GA-84: 사다리 — grounded는 true지만 x·z가 고정돼 수평 변위가 0
// ---------------------------------------------------------------------------

describe('RQ-72/GA-84: stepFootstepAccumulator — 사다리는 grounded===true이지만 수평 변위가 0이라 무음', () => {
  it('사다리 볼륨 안에서 mode=run으로 수직 10m를 올라도 발소리가 0회다(매 틱 grounded:true, 수평 변위:0)', () => {
    // ladderOutcome은 시작·끝 모두 grounded:true를 돌려준다(movement.ts:812,
    // RQ-18 상호작용을 위한 설계 결정) — "접지가 아니면 무음"으로 짜면 이
    // 골든을 이미 통과한 것처럼 보이지만 실제로는 이 함수가 grounded 자체를
    // 잘못 해석한 것이다. 이 테스트는 실제 grounded:true를 그대로 넘기고,
    // 오직 수평 변위가 0이라는 사실만으로 무음이 되는지를 검증한다.
    const ladder: LadderVolume = { minX: -1, maxX: 1, minZ: -1, maxZ: 1, minY: 0, maxY: 20, normalX: 1, normalZ: 0 }
    const geometry: StaticGeometry = { walls: [], boxes: [], ladders: [ladder] }
    const climbInput: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false } // dirX·normalX 내적>0 → 상승

    const { deltas, grounded, finalState } = driveReal(originState(), climbInput, 100, geometry)
    expect(finalState.y).toBeCloseTo(10, 6) // 전제 확인 — 실제로 수직 10m를 올랐다(3m/s×100틱/30Hz)
    expect(grounded.every((g) => g === true)).toBe(true) // 전제 확인 — 매 틱 grounded:true
    expect(deltas.every((d) => d === 0)).toBe(true) // 전제 확인 — 매 틱 수평 변위가 정확히 0

    const ticks: FootstepTickInput[] = deltas.map((horizontalDeltaM) => ({
      wasGrounded: true,
      isGrounded: true,
      mode: 'run',
      horizontalDeltaM,
      discontinuous: false,
    }))
    const { totalFootsteps, accumM } = driveAccumulator(0, ticks)
    expect(totalFootsteps).toBe(0)
    expect(accumM).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// GA-85: 공중 변위(19틱·3.8m)는 애초에 누적하지 않는다
// ---------------------------------------------------------------------------

describe('RQ-72/GA-85: stepFootstepAccumulator — 공중 구간은 애초에 누적되지 않는다', () => {
  it('이함부터 착지까지 정확히 19틱·수평 3.8m가 발생해도 발소리는 0회이고, 착지 후 1.4m를 더 이동해도 여전히 0회다(누적은 정확히 1.4m)', () => {
    const jumpInput: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: true }
    const holdInput: MoveInput = { dirX: 0, dirZ: 0, mode: 'run', jump: false } // AIR_CONTROL=false — 공중에서는 입력이 무시된다

    let accumM = 0
    let totalFootsteps = 0

    const prev = originState()
    let current = stepMovement(prev, jumpInput) // 이함 틱(1틱째)
    expect(current.grounded).toBe(false) // 전제 확인 — 이함 틱부터 이미 공중이다

    let airborneTicks = 1
    let airborneHorizontalM = Math.hypot(current.x - prev.x, current.z - prev.z)
    {
      const tick: FootstepTickInput = {
        wasGrounded: prev.grounded, // true(이함 직전)
        isGrounded: current.grounded, // false(이함 직후)
        mode: 'run',
        horizontalDeltaM: airborneHorizontalM,
        discontinuous: false,
      }
      const result = stepFootstepAccumulator(accumM, tick, AUDIO.FOOTSTEP_STRIDE_M)
      accumM = result.accumM
      totalFootsteps += result.footstepCount
    }

    // 착지(current.grounded === true로 전환)할 때까지 반복한다. 상한 30틱은
    // 무한루프 방지 안전장치일 뿐이다 — ADR-0014가 명시한 19틱에서 착지하지
    // 못하면 이 루프가 강제 종료되고 아래 "정확히 19틱" 단언이 즉시
    // 실패로 드러난다.
    while (!current.grounded && airborneTicks < 30) {
      const stepPrev = current
      current = stepMovement(stepPrev, holdInput)
      airborneTicks++
      const horizontalDeltaM = Math.hypot(current.x - stepPrev.x, current.z - stepPrev.z)
      airborneHorizontalM += horizontalDeltaM
      const tick: FootstepTickInput = {
        wasGrounded: stepPrev.grounded,
        isGrounded: current.grounded,
        mode: 'run',
        horizontalDeltaM,
        discontinuous: false,
      }
      const result = stepFootstepAccumulator(accumM, tick, AUDIO.FOOTSTEP_STRIDE_M)
      accumM = result.accumM
      totalFootsteps += result.footstepCount
    }

    expect(airborneTicks).toBe(19) // ADR-0014 결정 3 실측값(JUMP_V0=√40, g=20)
    expect(airborneHorizontalM).toBeCloseTo(3.8, 6) // 19×0.2m
    expect(current.grounded).toBe(true) // 착지 완료
    expect(totalFootsteps).toBe(0) // 공중 구간(이함~착지 틱 포함) 전체 0회
    expect(accumM).toBe(0) // 공중 변위는 누적에 전혀 반영되지 않는다 — "따로 추적하다 착지 때 폐기"가 아니다

    // 착지 후 접지로 1.4m(실측, run 7틱) 더 이동해도 여전히 스트라이드
    // 미만이라 무음이고, 누적은 정확히 그 값이어야 한다.
    const { deltas: postLandingDeltas } = driveReal(current, GROUNDED_RUN_INPUT, 7)
    const postLandingDistance = postLandingDeltas.reduce((a, b) => a + b, 0)
    expect(postLandingDistance).toBeCloseTo(1.4, 6) // 전제 확인 — GA-85 "착지 후 1.4m 더 이동"

    const after = driveAccumulator(accumM, groundedTicks(postLandingDeltas, 'run'))
    expect(after.totalFootsteps).toBe(0)
    expect(after.accumM).toBeCloseTo(1.4, 6)
  })
})

// ---------------------------------------------------------------------------
// GA-88: 자세 전환 — 누적은 유지, walk 구간만 재생에서 배제
// ---------------------------------------------------------------------------

describe('RQ-72/GA-88: stepFootstepAccumulator — 자세 전환 시 누적은 유지하되 walk 구간은 누적 자체에서 배제된다', () => {
  it('run 1.8m(실측) → walk 5.0m(실측) → run 0.6m(실측) — walk 구간은 누적에 전혀 더해지지 않아 총 1회만 발생하고 잔여는 0.4m다', () => {
    const phase1 = driveReal(originState(), GROUNDED_RUN_INPUT, 9) // ≈1.8m
    expect(phase1.deltas.reduce((a, b) => a + b, 0)).toBeCloseTo(1.8, 6)

    const phase2 = driveReal(phase1.finalState, GROUNDED_WALK_INPUT, 36) // ≈5.0m 이상
    expect(phase2.deltas.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5.0)

    const phase3 = driveReal(phase2.finalState, GROUNDED_RUN_INPUT, 3) // ≈0.6m
    expect(phase3.deltas.reduce((a, b) => a + b, 0)).toBeCloseTo(0.6, 6)

    const ticks: FootstepTickInput[] = [
      ...groundedTicks(phase1.deltas, 'run'),
      ...groundedTicks(phase2.deltas, 'walk'),
      ...groundedTicks(phase3.deltas, 'run'),
    ]
    const { totalFootsteps, accumM } = driveAccumulator(0, ticks)

    // ⚠️ '접지 변위를 모두 누적하되 walk에서는 재생만 막는' 구현은 walk
    // 도중 누적이 6.8m가 되어 run 재개 즉시 3회가 울린다. 자세 전환이
    // 누적을 초기화하는 구현은 run 0.6m로 2.0m에 못 미쳐 0회가 된다.
    // 올바른 구현만 정확히 1회·잔여 0.4m다.
    expect(totalFootsteps).toBe(1)
    expect(accumM).toBeCloseTo(0.4, 6)
  })
})

// ---------------------------------------------------------------------------
// GA-89: 리스폰(위치 불연속 재설정) — 누적을 0으로 초기화
// ---------------------------------------------------------------------------

describe('RQ-72/GA-89: stepFootstepAccumulator — 리스폰 순간이동은 누적하지 않고 0으로 초기화한다', () => {
  it('mode가 run으로 남아 있고 grounded가 true여도(GameRoom.ts respawnPlayer의 mode 미대입), discontinuous 플래그면 20m 순간이동을 누적하지 않고 0으로 리셋한다', () => {
    const preDeathAccumM = 1.8 // GA-89 given: 사망 직전 누적 1.8m

    // respawnPlayer는 mode를 대입하지 않으므로(GameRoom.ts:1396-1406) 부활
    // 시각에도 mode는 'run'이고 grounded는 명시적으로 true다 — 그런데도
    // discontinuous=true면 wasGrounded/isGrounded/mode/horizontalDeltaM을
    // 전부 무시하고 완전히 리셋해야 한다.
    const respawnTick: FootstepTickInput = {
      wasGrounded: true,
      isGrounded: true,
      mode: 'run',
      horizontalDeltaM: 20, // 스폰 지점 간 순간이동 거리(예시값) — 이동이 아니다
      discontinuous: true,
    }
    const afterRespawn = stepFootstepAccumulator(preDeathAccumM, respawnTick, AUDIO.FOOTSTEP_STRIDE_M)
    expect(afterRespawn.accumM).toBe(0)
    expect(afterRespawn.footstepCount).toBe(0)

    // 부활 후 그 자리에서 run으로 0.4m(실측, 2틱) 이동해도 2.0m 미만이라 무음이다.
    const { deltas } = driveReal(originState(), GROUNDED_RUN_INPUT, 2)
    expect(deltas.reduce((a, b) => a + b, 0)).toBeCloseTo(0.4, 6)

    const after = driveAccumulator(afterRespawn.accumM, groundedTicks(deltas, 'run'))
    expect(after.totalFootsteps).toBe(0)
    expect(after.accumM).toBeCloseTo(0.4, 6)
  })
})

// ---------------------------------------------------------------------------
// GA-80/81: 가청 판정 — 15m 경계(이내 포함), 자기 발소리는 항상
// ---------------------------------------------------------------------------

describe('RQ-72/GA-80: isWithinAudibleRange — 가청 거리 15m, 경계(15.0m) 포함', () => {
  it('발소리가 실제로 발생한 상태에서(run 11틱, 보폭 2.0m 채움), 수평 거리 정확히 15.0m는 들린다', () => {
    const { deltas } = driveReal(originState(), GROUNDED_RUN_INPUT, 11)
    const { totalFootsteps } = driveAccumulator(0, groundedTicks(deltas, 'run'))
    expect(totalFootsteps).toBe(1) // 전제 확인 — 이번 구간에서 발소리 자체는 발생했다

    expect(isWithinAudibleRange(15.0, AUDIO.AUDIBLE_RANGE_M)).toBe(true)
  })

  it('수평 거리가 15.0m를 넘으면 들리지 않는다', () => {
    expect(isWithinAudibleRange(15.0001, AUDIO.AUDIBLE_RANGE_M)).toBe(false)
  })

  it('RQ-72 실측값(AUDIO.AUDIBLE_RANGE_M=15)으로도 동일하게 성립한다', () => {
    expect(AUDIO.AUDIBLE_RANGE_M).toBe(15)
    expect(isWithinAudibleRange(AUDIO.AUDIBLE_RANGE_M, AUDIO.AUDIBLE_RANGE_M)).toBe(true)
  })
})

describe('RQ-72/GA-81: isFootstepAudible — 자기 발소리는 거리 판정 없이 항상 들린다', () => {
  it('본인이 보폭을 채우면(run 11틱) 발소리가 발생하고, 자기 발소리는 거리와 무관하게 항상 들린다', () => {
    const { deltas } = driveReal(originState(), GROUNDED_RUN_INPUT, 11)
    const { totalFootsteps } = driveAccumulator(0, groundedTicks(deltas, 'run'))
    expect(totalFootsteps).toBe(1)

    expect(isFootstepAudible(0, true, AUDIO.AUDIBLE_RANGE_M)).toBe(true)
    expect(isFootstepAudible(9999, true, AUDIO.AUDIBLE_RANGE_M)).toBe(true) // 가청 거리를 한참 넘어도 자기 소리는 들린다
  })

  it('타인의 발소리는 isSelf가 아니면 일반 가청 판정을 그대로 따른다', () => {
    expect(isFootstepAudible(15.0, false, AUDIO.AUDIBLE_RANGE_M)).toBe(true)
    expect(isFootstepAudible(15.0001, false, AUDIO.AUDIBLE_RANGE_M)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GA-82/86: 착지음 발생 — 무피해 임계(3m) 초과 여부, 자세 무관
// ---------------------------------------------------------------------------

describe('RQ-72/GA-82: shouldPlayLandingSound — 낙하 무피해 임계(FALL_DAMAGE.SAFE_HEIGHT_M=3m) 초과 여부', () => {
  it('정확히 3.0m(경계)이면 착지음이 나지 않는다', () => {
    expect(shouldPlayLandingSound(3.0)).toBe(false)
  })

  it('3.0m를 초과하면(3.0001m) 착지음이 난다', () => {
    expect(shouldPlayLandingSound(3.0001)).toBe(true)
  })

  it('3.0m 미만이면 착지음이 나지 않는다', () => {
    expect(shouldPlayLandingSound(1)).toBe(false)
    expect(shouldPlayLandingSound(0)).toBe(false)
  })

  it('FALL_DAMAGE.SAFE_HEIGHT_M(3) 실측값과 동일한 경계다', () => {
    expect(FALL_DAMAGE.SAFE_HEIGHT_M).toBe(3)
    expect(shouldPlayLandingSound(FALL_DAMAGE.SAFE_HEIGHT_M)).toBe(false)
    expect(shouldPlayLandingSound(FALL_DAMAGE.SAFE_HEIGHT_M + 1)).toBe(true)
  })
})

describe('RQ-72/GA-86: shouldPlayLandingSound — 착지음은 자세와 무관하다(발소리와 별개)', () => {
  it('crouch(Ctrl) 자세로 5.0m 낙하해 착지해도 착지음이 난다 — 이 함수는 애초에 자세를 인자로 받지 않는다', () => {
    // GA-79("앉기는 완전 무음")는 발소리 함수(stepFootstepAccumulator)의
    // 성질이지 착지음 함수의 성질이 아니다 — 두 함수가 별개이므로 앉기의
    // "발소리 무음"이 착지음까지 지우지 않는다.
    expect(shouldPlayLandingSound(5.0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// GA-87: 착지음도 발소리와 동일한 가청 거리(15m)를 적용한다
// ---------------------------------------------------------------------------

describe('RQ-72/GA-87: 착지음 발생과 가청은 별개 판정 — 가청 거리 15m은 착지음에도 동일하게 적용된다', () => {
  it('원격 플레이어가 수평 거리 15.0m를 넘는 곳에서 3m를 초과해 낙하해 착지하면, 착지음 자체는 발생하지만 가청 거리 밖이라 들리지 않는다', () => {
    const fallHeightM = 5.0 // 3m 초과 — 무피해 임계를 넘겼다
    const horizontalDistanceM = 15.0001 // 15m 초과 — 가청 거리 밖

    expect(shouldPlayLandingSound(fallHeightM)).toBe(true) // 이벤트 자체는 발생한다
    expect(isWithinAudibleRange(horizontalDistanceM, AUDIO.AUDIBLE_RANGE_M)).toBe(false) // 그러나 들리지 않는다
  })
})

// ---------------------------------------------------------------------------
// 방어적 입력 처리 — RQ-61과 동일한 방어 원칙(fallDamageForHeight 선례)
// ---------------------------------------------------------------------------

describe('방어적 입력 처리 — 악의적이거나 손상된 값(RQ-61과 동일한 방어 원칙)', () => {
  it('stepFootstepAccumulator: horizontalDeltaM이 NaN이면 이동하지 않은 것과 동일하게 취급한다(누적 변화 없음)', () => {
    const tick: FootstepTickInput = { wasGrounded: true, isGrounded: true, mode: 'run', horizontalDeltaM: NaN, discontinuous: false }
    const result = stepFootstepAccumulator(1.0, tick, AUDIO.FOOTSTEP_STRIDE_M)
    expect(result.accumM).toBe(1.0)
    expect(result.footstepCount).toBe(0)
  })

  it('stepFootstepAccumulator: horizontalDeltaM이 음수(손상된 값)면 0으로 취급한다 — 누적이 거꾸로 줄지 않는다', () => {
    const tick: FootstepTickInput = { wasGrounded: true, isGrounded: true, mode: 'run', horizontalDeltaM: -5, discontinuous: false }
    const result = stepFootstepAccumulator(1.0, tick, AUDIO.FOOTSTEP_STRIDE_M)
    expect(result.accumM).toBe(1.0)
    expect(result.footstepCount).toBe(0)
  })

  it('shouldPlayLandingSound: NaN·음수 높이는 착지음이 나지 않는다(낙하하지 않은 것과 동일 취급, fallDamageForHeight와 동일 원칙)', () => {
    expect(shouldPlayLandingSound(NaN)).toBe(false)
    expect(shouldPlayLandingSound(-5)).toBe(false)
    expect(shouldPlayLandingSound(Infinity)).toBe(false)
  })

  it('isWithinAudibleRange: NaN 거리는 들리지 않는 것으로 취급한다(안전한 기본값)', () => {
    expect(isWithinAudibleRange(NaN, AUDIO.AUDIBLE_RANGE_M)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 결정론 — 같은 입력은 항상 같은 결과를 낸다(ADR-0008)
// ---------------------------------------------------------------------------

describe('결정론 — 같은 입력은 항상 같은 결과를 낸다(ADR-0008)', () => {
  it('stepFootstepAccumulator는 순수 함수이므로 반복 호출해도 결과가 바뀌지 않는다', () => {
    const tick: FootstepTickInput = { wasGrounded: true, isGrounded: true, mode: 'run', horizontalDeltaM: 1.2, discontinuous: false }
    expect(stepFootstepAccumulator(0.9, tick, AUDIO.FOOTSTEP_STRIDE_M)).toEqual(
      stepFootstepAccumulator(0.9, tick, AUDIO.FOOTSTEP_STRIDE_M),
    )
  })

  it('shouldPlayLandingSound·isWithinAudibleRange도 반복 호출해도 결과가 바뀌지 않는다', () => {
    expect(shouldPlayLandingSound(8)).toBe(shouldPlayLandingSound(8))
    expect(isWithinAudibleRange(10, AUDIO.AUDIBLE_RANGE_M)).toBe(isWithinAudibleRange(10, AUDIO.AUDIBLE_RANGE_M))
  })
})
