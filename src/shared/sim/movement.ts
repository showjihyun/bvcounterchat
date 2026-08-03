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
 * **REV 2026-07-24 — `MoveState` 7필드 계약(evaluator FAIL #1·#2 대응)**:
 * 최초 구현은 공중 수평 속도(vx·vz)를 `MoveState`가 노출하지 않는다는
 * 이유로 모듈 전역 `WeakMap<MoveState, ...>`(반환 객체 참조 키)에
 * 은닉했다. evaluator가 프로브로 실증한 결함 두 가지 — ①
 * `JSON.stringify`→`parse` 왕복 복제 후 이어 시뮬레이션하면 수평 관성이
 * 소실된다(클라이언트 예측(RQ-62)의 스냅샷·롤백 전제, ADR-0004 위반).
 * ② 값이 완전히 같은 다른 참조(얕은 복사)에 같은 입력을 줘도 출력이
 * 다르다(`stepMovement`가 인자 값이 아니라 참조에 의존 — ADR-0008 §2
 * "값의 함수" 순수 함수 요구 위반). 근본 원인은 5필드 계약이 공중 상태를
 * 완전히 표현하지 못했다는 데 있다 — test-writer가 계약을 `vx`·`vz`
 * 명시 필드로 확장했다(`tests/unit/sim-movement.test.ts` REV 2026-07-24
 * 절). 이 구현은 그 계약을 따라 `WeakMap` 은닉을 걷어내고, 공중 수평
 * 속도를 상태 값 자체에 담는다 — `stepMovement`는 이제 인자 **값**만으로
 * 다음 상태가 결정되는 순수 함수다(직렬화·복제 왕복 후에도 궤적이
 * 일치한다).
 *
 * 공중 가속 미허용(RQ-92, `MOVEMENT.AIR_CONTROL === false`)은 여전히
 * 지킨다 — 공중 물리(`stepAirborne`)는 이번 틱의 방향 입력을 아예
 * 참조하지 않고, 상태에 담긴 `vx`·`vz`(이함 순간 고정된 값)만 그대로
 * 적용한다. 접지 상태의 `vx`·`vz`는 매 틱 현재 입력에서 새로 계산한
 * 실제 이동 속도를 그대로 보고한다(0으로 뭉개지 않는다 — "상태는 값의
 * 완전한 스냅샷"이라는 정신에 더 맞는다. 다음 접지 틱은 어차피 이 값을
 * 참조하지 않고 입력에서 다시 계산하므로 어떤 값을 남기든 이후 궤적에는
 * 영향이 없다).
 */

import { MOVEMENT, NET, WORLD } from '@shared/constants'

export interface MoveState {
  x: number
  y: number
  z: number
  /** 수평 속도(m/s) — 접지·공중 모두 노출(REV 2026-07-24, 위 파일 코멘트). */
  vx: number
  /** 수직 속도(m/s, 상승 +) — 중력 적용 대상. */
  vy: number
  vz: number
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

/**
 * RQ-30 벽 충돌(원장 25a-2, ADR-0013 결정 1~2) — 정적 지오메트리를 축
 * 정렬 상자(무한 높이 기둥)로 표현한다. `minY`/`maxY`가 없는 것은 의도다 —
 * 등반 가능한 유한 높이 "박스"(RQ-32)와 "벽"(지형, RQ-30)을 구분하는
 * 기존 어휘를 따른다(`tests/unit/sim-movement-walls.test.ts` docblock).
 */
export interface WallAABB {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/** 1틱의 경과 시간(초). `NET.TICK_MS`(1000/30, 부동소수점)를 매번 나누지
 * 않도록 모듈 로드 시 한 번만 계산한다. */
const TICK_SECONDS = NET.TICK_MS / 1000

/** 월드 경계(RQ-30, GA-50) — `WORLD.SIZE_M`(60)에서 유도, ±30 하드코딩
 * 금지(ADR-0010). */
const HALF_WORLD_M = WORLD.SIZE_M / 2

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
 * 경과 시각을 역산한다 — 별도의 "경과 틱 수" 필드 없이 `vy(t)`의
 * 역함수로 시간을 복원한다(선형·단조감소라 역산이 항상 유일하다 —
 * evaluator 특별검증 #3 확인). 접지 상태의 `vy`는 항상 정확히 0이므로
 * (이륙 이전) 이 함수는 공중 상태(`grounded === false`)에서만 쓴다. */
function jumpElapsedSeconds(previousVy: number): number {
  return (JUMP_V0_MPS - previousVy) / JUMP_GRAVITY_MPS2
}

/** 좌표를 플레이 면적 경계(±`HALF_WORLD_M`) 안으로 가둔다(RQ-30/GA-50).
 * 하드 클램프 — GA-50 then은 "항상 ±30m 안"만 요구하고 "어떻게 멈추는가"
 * (슬라이드·반발 등)는 규정하지 않는다(`_workspace/RQ-30/01_test-writer
 * _red.md` §4) — 벽 충돌이 들어오는 다음 조각이 게임 감각 결정을 대체할 수
 * 있는 자리다. 상태를 들고 있지 않아 매 틱 결과만 절단하므로, 경계에서
 * 안쪽으로 방향을 바꾸면 다음 틱 값이 경계 미만이라 그대로 반영된다(고착
 * 없음).
 *
 * ⚠️ **절단 대상은 위치뿐이다.** `vx`·`vz`는 입력값 그대로 보고되므로 경계에
 * 붙은 플레이어의 속도는 0이 아니다. 오늘은 무해하다 — 그 값을 표현에 쓰는
 * 소비자가 없고, 클라 예측은 같은 함수를 재생하므로 서버와 정합한다. 다만
 * 속도를 소비하는 첫 코드(달리기 애니메이션·데드레커닝)가 생기면 "벽에 붙어
 * 달리는" 표현이 나온다 — **그때 이것이 결정이었는지 누락이었는지 알 수 있게**
 * 여기 적어 둔다. 속도 처리는 벽 충돌 조각(RQ-32)에서 함께 정한다.
 * (PR #44 리뷰 minor) */
function clampToWorldBounds(value: number): number {
  if (value > HALF_WORLD_M) return HALF_WORLD_M
  if (value < -HALF_WORLD_M) return -HALF_WORLD_M
  return value
}

/**
 * 벽 목록(`WallAABB[]`)에 대해 이번 틱 후보 위치(nextX/nextZ)를 근접면에서
 * 절단한다 — **축별 독립 절단**(RQ-30 팀리드 지시: "정지 방식을 과도하게
 * 설계하지 마라 — 부등식만 단언한다"). 이 라운드의 커버리지(원장 25a-2)가
 * ±X·±Z 단일축 접근만 다루므로, x축·z축을 순서대로 독립 적용해도 충분하다
 * (대각선 이동 중 모서리 스침 같은 케이스는 이 계약이 시험하지 않는다).
 *
 * 각 벽에 대해, 이동 축과 **수직**인 축의 좌표가 벽의 범위 안에 있을 때만
 * 절단한다 — 그렇지 않으면 벽 옆을 스쳐 지나가는 경로까지 막아버린다(위
 * "양성 대조군" 요구). 근접면은 **직전 위치(prevX/prevZ)가 벽의 어느 쪽에
 * 있었는가**로 정한다 — 반대쪽에서 접근하면 반대쪽 면에서 멈춘다.
 *
 * **고착 방지가 이 판정 순서에서 자연히 나온다**: 벽에 붙어 멈춘
 * 뒤(`prevX`가 근접면 값과 같아짐) 반대 방향으로 밀면, 후보 위치가 그
 * 근접면을 다시 넘지 않으므로(반대 방향으로 움직였으니까) 두 조건
 * (`prev` 비교, `next` 비교) 중 하나가 깨져 절단이 걸리지 않는다 —
 * 세계 경계의 `clampToWorldBounds`(상태 비보유 절단)와 달리 이 함수는
 * "다가오는 방향"까지 함께 봐야 하므로 직전 위치가 필요하다. */
function clampAgainstWalls(
  prevX: number,
  prevZ: number,
  nextX: number,
  nextZ: number,
  walls: readonly WallAABB[],
): { x: number; z: number } {
  let x = nextX
  let z = nextZ

  for (const wall of walls) {
    // x축 이동 절단 — z(수직축)가 벽의 z범위 안에 있어야("스쳐 지나감"이
    // 아니라 실제로 벽면과 마주친다) 충돌로 본다.
    if (z > wall.minZ && z < wall.maxZ) {
      if (prevX <= wall.minX && x > wall.minX) {
        x = wall.minX
      } else if (prevX >= wall.maxX && x < wall.maxX) {
        x = wall.maxX
      }
    }

    // z축 이동 절단 — x(수직축)가 벽의 x범위 안에 있어야 충돌. 위에서 x가
    // 이미 절단됐을 수 있으므로 절단된 x로 재평가한다.
    if (x > wall.minX && x < wall.maxX) {
      if (prevZ <= wall.minZ && z > wall.minZ) {
        z = wall.minZ
      } else if (prevZ >= wall.maxZ && z < wall.maxZ) {
        z = wall.maxZ
      }
    }
  }

  return { x, z }
}

/** 접지 결과 — 수평은 `vx`·`vz`를 그대로(값으로) 적용·보고하고 수직은
 * 0으로 유지한다. 그대로 서 있는 경우와 공중에서 착지하는 경우가 같은
 * 모양이라 공유한다. 세계 경계(`clampToWorldBounds`) 절단 이후 벽 절단
 * (`clampAgainstWalls`)을 적용한다 — 둘 다 위치만 절단하고 속도(`vx`/`vz`)는
 * 그대로 보고한다(위 `clampToWorldBounds` 코멘트의 "절단 대상은 위치뿐"과
 * 동일한 선택 — 속도 처리는 이 라운드의 스코프가 아니다). */
function groundedOutcome(state: MoveState, vx: number, vz: number, walls: readonly WallAABB[]): MoveState {
  const boundedX = clampToWorldBounds(state.x + vx * TICK_SECONDS)
  const boundedZ = clampToWorldBounds(state.z + vz * TICK_SECONDS)
  const { x, z } = clampAgainstWalls(state.x, state.z, boundedX, boundedZ, walls)
  return {
    x,
    y: 0,
    z,
    vx,
    vy: 0,
    vz,
    grounded: true,
  }
}

/** 이륙 후 경과 시각 `t`(초)에서의 공중 결과. 높이가 0 이하로 내려간
 * 시점(해석적 궤적이 지면을 지나친 시점)이면 착지로 스냅한다 — 그
 * 시점까지 유지해 온 수평 속도(vx·vz)로 착지 틱의 이동까지 마저 적용한다.
 *
 * **공중 상태는 벽과 상호작용하지 않는다(이 라운드의 명시적 스코프 밖 —
 * `sim-movement-walls.test.ts` docblock "2D(XZ) 전용" 절 참고)**: `WallAABB`가
 * 상하 경계를 갖지 않아(무한 높이 기둥) 점프 중 벽을 넘을 수 있는가는
 * RQ-30/32 어디에도 규정이 없다. 착지 스냅(`groundedOutcome` 호출)에도
 * 벽을 넘기지 않는다 — 공중 궤적 전체(이함~착지)가 벽의 존재를 보지 않는
 * 것으로 일관되게 남긴다. `.glb` 확정 시(벽 높이·뛰어넘기 가부가 정해지는
 * 시점) 결정할 이월 항목이다. */
function airborneOutcome(state: MoveState, vx: number, vz: number, t: number): MoveState {
  const height = jumpHeightAt(t)
  if (height <= 0) {
    return groundedOutcome(state, vx, vz, [])
  }

  return {
    x: clampToWorldBounds(state.x + vx * TICK_SECONDS),
    y: height,
    z: clampToWorldBounds(state.z + vz * TICK_SECONDS),
    vx,
    vy: jumpVyAt(t),
    vz,
    grounded: false,
  }
}

function stepGrounded(state: MoveState, input: MoveInput, walls: readonly WallAABB[]): MoveState {
  const { vx, vz } = groundVelocity(input)
  if (!input.jump) {
    return groundedOutcome(state, vx, vz, walls)
  }
  // 이륙 — 이번 틱의 수평 속도를 그대로 착지까지의 공중 관성으로
  // 고정한다(RQ-92 공중 가속 미허용). 수직은 해석적 궤적의
  // t = TICK_SECONDS 지점(이륙 후 정확히 한 틱 경과). 이함 틱도 공중
  // 상태와 동일하게 벽을 보지 않는다(위 `airborneOutcome` 코멘트 참고).
  return airborneOutcome(state, vx, vz, TICK_SECONDS)
}

/** 공중 물리는 이번 틱 입력을 참조하지 않는다 — `MOVEMENT.AIR_CONTROL
 * === false`(RQ-92)라 방향 입력이 무엇이든 상태에 담긴 `vx`·`vz`(이륙
 * 순간 고정된 값)만 그대로 적용한다(에어 스트레이프·버니합 없음). 상태
 * **값**만 읽으므로 직렬화 왕복·얕은 복사를 거친 `state`를 넘겨도 결과가
 * 같다(REV 2026-07-24). */
function stepAirborne(state: MoveState): MoveState {
  const t = jumpElapsedSeconds(state.vy) + TICK_SECONDS
  return airborneOutcome(state, state.vx, state.vz, t)
}

/** 1틱(`NET.TICK_MS`) 전진 — 평지(y=0) 순수 산술(RQ-20, RQ-92). Rapier
 * 없음, 사다리(RQ-21)·박스(RQ-22)·낙하 데미지(RQ-18)는 스코프 밖이다.
 *
 * **`walls`(RQ-30, 원장 25a-2/26o) — 세 번째 인자, 기본값 `[]`**: 정적
 * 지오메트리를 축 정렬 상자 목록으로 **주입**받는다(`src/shared`는 파일·
 * 전역·환경에서 벽을 읽지 않는다 — ADR-0010 환경 중립). 생략하거나 빈
 * 배열을 넘기면 벽이 전혀 없던 기존 동작 그대로다(하위 호환 — 기존 13개
 * 호출부가 전부 이 계약을 만족한다). 접지 상태에서만 적용하고(위
 * `airborneOutcome`/`stepGrounded` 코멘트 참고) 공중 상태는 이 라운드의
 * 스코프가 아니다. */
export function stepMovement(state: MoveState, input: MoveInput, walls: readonly WallAABB[] = []): MoveState {
  return state.grounded ? stepGrounded(state, input, walls) : stepAirborne(state)
}
