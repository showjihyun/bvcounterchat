/**
 * RQ-20 이동 — 평지 순수 산술 시뮬레이션 (ADR-0008: 순수 함수, 결정론,
 * `src/shared` 환경 중립).
 *
 * `stepMovement`는 정확히 1틱(`NET.TICK_MS`) 전진하는 순수 함수다 —
 * `clock`·`scheduler`(원장 17e 계약, `./clock`·`./scheduler`)와 동일하게
 * 여러 틱 분량을 벌크로 건너뛰지 않는다. 호출자(서버 30Hz 틱 루프 ·
 * 테스트)가 틱 수만큼 반복 호출할 책임을 진다.
 *
 * 이동 파라미터(RQ-92): 기본 6m/s(`mode: 'run'`) · 앉기 50%(`'crouch'`) ·
 * 천천히 걷기 70%(`'walk'`). RQ-92는 "기본 이동 속도" 하나만 정하고
 * 걷기·달리기를 구분하지 않으므로(interview 질문 5) `'run'`이 걷기·달리기
 * 공통값을 담당한다. `'walk'`는 RQ-20 원문의 "천천히 걷기(조용한 이동)"이며
 * 흔히 연상되는 "보통 걷기"가 아니다.
 *
 * 점프 궤적은 해석적(analytical)이다 — `vy -= g·dt; y += vy·dt`처럼 매 틱
 * 속도를 적분하는 순진한 오일러 방식은 30Hz에서 최고점이 5~20% 미달로
 * 실측됐다(`_workspace/RQ-20/01_test-writer_red.md` "점프 궤적 유도" 절).
 * 대신 `y(t) = v0·t - ½g·t²`를 매 틱 경과 시각에 직접 대입(샘플링)한다 —
 * 오차 1% 미만. 중력(`JUMP_GRAVITY_MPS2`)은 스펙이 정하지 않은 구현
 * 선택값이라 `@shared/constants`가 아니라 이 파일에 둔다 — 도달
 * 높이(`MOVEMENT.JUMP_HEIGHT`)만 스펙이 정하고, 여기서 초기 수직
 * 속도(v0)를 역산한다.
 *
 * 공중 가속 미허용(RQ-92, `MOVEMENT.AIR_CONTROL === false`): 이륙 순간의
 * 수평 속도(vx, vz)를 그대로 착지까지 유지하고, 공중 틱의 방향 입력은
 * 무시한다. `MoveState`는 팀리드·test-writer가 지정한 계약대로
 * `x·y·z·vy·grounded`만 노출한다(수평 속도 필드가 없다) — 그래서 이 속도는
 * `stepMovement`가 반환한 특정 객체 참조에 결속한 부가 정보로 별도
 * 보관한다(`airborneVelocity` WeakMap). 반환 객체 자체는 항상 계약대로
 * 평평한 5개 필드뿐이다 — 그래야 무입력 테스트의
 * `toEqual(createGroundedState())` 같은 전체 구조 비교가 정확히 맞는다.
 * 호출자가 매 틱 이 함수의 반환값을 다음 호출의 `state`로 그대로
 * 넘기는 한(테스트·GameRoom 모두 그렇다) 참조가 유지돼 착지까지 값을
 * 안전하게 추적한다.
 */

import { MOVEMENT, NET } from '@shared/constants'

export interface MoveState {
  x: number
  y: number
  z: number
  /** 수직 속도(m/s, 상승 +) — 중력 적용 대상. */
  vy: number
  grounded: boolean
}

export interface MoveInput {
  /** 정규화된 수평 방향(단위 벡터). 무입력은 0. 서버가 신뢰하지 않는
   * 클라이언트 입력이므로 이 모듈이 내부에서 크기 1로 클램프한다(RQ-61). */
  dirX: number
  dirZ: number
  mode: 'run' | 'walk' | 'crouch'
  /** 이번 틱의 점프 시도(엣지 트리거) — 접지 상태에서만 유효하다. */
  jump: boolean
}

/** 접지에서 이륙한 뒤 착지까지 수평 속도를 이어 붙이기 위한 부가
 * 저장소 — 위 파일 코멘트 "공중 가속 미허용" 참고. 참조가 끊기면(그
 * 객체를 아무도 더 들고 있지 않으면) 자동 회수된다. */
const airborneVelocity = new WeakMap<MoveState, { vx: number; vz: number }>()

/** 1틱의 경과 시간(초). `NET.TICK_MS`(1000/30, 부동소수점)를 매번 나누지
 * 않도록 모듈 로드 시 한 번만 계산한다. */
const TICK_SECONDS = NET.TICK_MS / 1000

/** 점프 궤적에 쓰는 중력(m/s²) — 스펙 미확정 구현 선택값(위 파일 코멘트
 * 참고). 어떤 값을 골라도 해석적 궤적 샘플링은 오차 1% 미만이므로(실측,
 * red 보고서) 값 자체는 임의다. */
const JUMP_GRAVITY_MPS2 = 20
/** 위 중력으로 `MOVEMENT.JUMP_HEIGHT`에 도달하는 데 필요한 초기 수직
 * 속도(m/s) — h = v0²/2g의 역산. */
const JUMP_V0_MPS = Math.sqrt(2 * JUMP_GRAVITY_MPS2 * MOVEMENT.JUMP_HEIGHT)

/** `mode`별 이동 속도(m/s). 타입은 리터럴 3종이지만, 서버 경계에서 온
 * 값의 런타임 값까지는 이 함수가 보장할 수 없다 — 알 수 없는 값은 기본
 * 이동 속도로 조용히 대체한다(크래시·무반응보다 안전, RQ-61). */
function modeSpeed(mode: MoveInput['mode']): number {
  switch (mode) {
    case 'crouch':
      return MOVEMENT.SPEED * MOVEMENT.CROUCH_MULTIPLIER
    case 'walk':
      return MOVEMENT.SPEED * MOVEMENT.WALK_MULTIPLIER
    case 'run':
      return MOVEMENT.SPEED
    default:
      return MOVEMENT.SPEED
  }
}

/** 크기가 1을 넘는 방향 입력을 단위원으로 클램프하고, 유한하지 않은
 * 값(NaN·Infinity — 조작되거나 손상된 클라이언트 입력)은 0으로 취급한다
 * (RQ-61: 서버는 클라이언트 입력을 그대로 신뢰하지 않는다). 이미
 * 정규화된 입력(크기 ≤ 1)은 그대로 통과한다. */
function clampDirection(dirX: number, dirZ: number): { dirX: number; dirZ: number } {
  const x = Number.isFinite(dirX) ? dirX : 0
  const z = Number.isFinite(dirZ) ? dirZ : 0
  const magnitude = Math.sqrt(x * x + z * z)
  if (magnitude > 1) {
    return { dirX: x / magnitude, dirZ: z / magnitude }
  }
  return { dirX: x, dirZ: z }
}

/** 현재 입력으로부터 이번 틱의 수평 속도(m/s)를 계산한다. */
function groundVelocity(input: MoveInput): { vx: number; vz: number } {
  const { dirX, dirZ } = clampDirection(input.dirX, input.dirZ)
  const speed = modeSpeed(input.mode)
  return { vx: dirX * speed, vz: dirZ * speed }
}

/** 이륙 후 경과 시각(t, 초)에서의 높이 — y(t) = v0·t - ½g·t². */
function jumpHeightAt(t: number): number {
  return JUMP_V0_MPS * t - 0.5 * JUMP_GRAVITY_MPS2 * t * t
}

/** 이륙 후 경과 시각(t, 초)에서의 수직 속도 — vy(t) = v0 - g·t. */
function jumpVyAt(t: number): number {
  return JUMP_V0_MPS - JUMP_GRAVITY_MPS2 * t
}

/** 공개 필드 `vy`(이전 틱에서 `jumpVyAt`으로 계산된 값)로부터 이륙 후
 * 경과 시각을 역산한다 — 별도의 "경과 틱 수" 은닉 상태 없이 `vy(t)`의
 * 역함수로 시간을 복원한다. 접지 상태의 `vy`는 항상 정확히 0이므로(이륙
 * 이전) 이 함수는 공중 상태(`grounded === false`)에서만 쓴다. */
function jumpElapsedSeconds(previousVy: number): number {
  return (JUMP_V0_MPS - previousVy) / JUMP_GRAVITY_MPS2
}

/** 접지 상태 결과 — 수평 이동만 적용하고 수직은 0으로 유지한다. 그대로
 * 서 있는 경우와 공중에서 착지하는 경우 모두 같은 모양이라 공유한다. */
function groundedOutcome(state: MoveState, vx: number, vz: number): MoveState {
  return { x: state.x + vx * TICK_SECONDS, y: 0, z: state.z + vz * TICK_SECONDS, vy: 0, grounded: true }
}

/** 이륙 후 경과 시각 `t`(초)에서의 공중 결과. 높이가 0 이하로 내려간
 * 시점(해석적 궤적이 지면을 지나친 시점)이면 착지로 스냅한다. */
function airborneOutcome(state: MoveState, vx: number, vz: number, t: number): MoveState {
  const height = jumpHeightAt(t)
  if (height <= 0) {
    return groundedOutcome(state, vx, vz)
  }

  const newState: MoveState = {
    x: state.x + vx * TICK_SECONDS,
    y: height,
    z: state.z + vz * TICK_SECONDS,
    vy: jumpVyAt(t),
    grounded: false,
  }
  airborneVelocity.set(newState, { vx, vz })
  return newState
}

function stepGrounded(state: MoveState, input: MoveInput): MoveState {
  const { vx, vz } = groundVelocity(input)
  if (!input.jump) {
    return groundedOutcome(state, vx, vz)
  }
  // 이륙 — 이번 틱의 수평 속도를 그대로 착지까지의 공중 관성으로
  // 고정한다(RQ-92 공중 가속 미허용). 수직은 해석적 궤적의
  // t = TICK_SECONDS 지점(이륙 후 정확히 한 틱 경과).
  return airborneOutcome(state, vx, vz, TICK_SECONDS)
}

/** 공중 물리는 이번 틱 입력을 참조하지 않는다 — `MOVEMENT.AIR_CONTROL
 * === false`(RQ-92)라 방향 입력이 무엇이든 이륙 순간에 고정된 수평
 * 속도만 그대로 적용한다(에어 스트레이프·버니합 없음). */
function stepAirborne(state: MoveState): MoveState {
  const { vx, vz } = airborneVelocity.get(state) ?? { vx: 0, vz: 0 }
  const t = jumpElapsedSeconds(state.vy) + TICK_SECONDS
  return airborneOutcome(state, vx, vz, t)
}

/** 1틱(`NET.TICK_MS`) 전진 — 평지(y=0) 순수 산술(RQ-20, RQ-92). Rapier
 * 없음, 사다리(RQ-21)·박스(RQ-22)·낙하 데미지(RQ-18)는 스코프 밖이다. */
export function stepMovement(state: MoveState, input: MoveInput): MoveState {
  return state.grounded ? stepGrounded(state, input) : stepAirborne(state)
}
