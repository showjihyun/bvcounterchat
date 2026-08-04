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

/**
 * RQ-22 박스 등반(원장 25a-4, ADR-0013 결과 절 "박스 등반은 명시적
 * 점프") — 유한 높이 지오메트리를 축 정렬 상자로 표현한다. `WallAABB`와
 * 달리 `topY`가 있다: 상단이 점프 높이(`MOVEMENT.JUMP_HEIGHT`)보다 낮으면
 * 점프로 밟고 올라설 수 있고(등반, 아래 `standingHeight`), 그 상단보다
 * 낮은 높이에서 옆면에 부딪히면 벽과 같은 성질로 수평 이동을 막는다(REV,
 * `tests/unit/sim-movement-boxes.test.ts` docblock "질문1 회신" — 팀리드
 * 결정: "충돌 형상을 구성해야 한다"가 근거, 아래 `boxesBlockingAt`).
 */
export interface BoxAABB {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  /** 상단 높이(m) — RQ-32: 점프 높이(1.0m)보다 낮아야 등반 가능. */
  topY: number
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

/** 지점 `(x,z)`의 **지지 높이**(standing height) — 그 지점을 포함하는
 * 모든 박스의 `topY` 중 최댓값, 어떤 박스에도 포함되지 않으면 맨 지면
 * (0)이다(`tests/unit/sim-movement-boxes.test.ts` docblock "행동 계약"
 * 절). "포함"의 경계 규칙은 `clampAgainstWalls`의 "안에 있는가" 판정(개방
 * 구간, 예: `x > wall.minX && x < wall.maxX`)과 동일하게 **개방 구간**을
 * 쓴다 — 근접면에 막혀 정확히 `minX`에 멈춘 플레이어는 아직 "박스 안"이
 * 아니므로 지지 높이가 오르지 않는다(질문1 회신에서 명시적으로 배제한
 * 대안 (b) "차단 없이 걸어 들어가 y가 솟아오른다"와 결과가 갈리는 지점 —
 * "걸어서 접근" 테스트가 이 경계를 고정한다). */
function standingHeight(x: number, z: number, boxes: readonly BoxAABB[]): number {
  let height = 0
  for (const box of boxes) {
    if (x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ && box.topY > height) {
      height = box.topY
    }
  }
  return height
}

/** 직전 높이(`y`, 위치가 아니라 상태 값 자체 — REV 2026-07-24 정신)가
 * 자신의 상단보다 **낮은** 박스만 고른다 — 그런 박스만 이번 틱에
 * `clampAgainstWalls`가 벽과 같은 성질(근접면 통과 금지 + 고착 금지)로
 * 수평 이동을 막는다. `y`가 상단과 같거나 높으면("이상") 그 박스는
 * 차단하지 않는다 — "정확히 `topY`"는 이 "이상"에 포함된다(REV 질문1
 * 회신, 팀리드 결정). 반환 타입을 `WallAABB[]`로 좁히는 것은 `BoxAABB`가
 * `WallAABB`의 네 필드를 전부 가진 상위집합이라 구조적으로 안전하다(엄격한
 * 초과 프로퍼티 검사는 객체 리터럴에만 적용되고, 변수에는 적용되지 않는다). */
function boxesBlockingAt(y: number, boxes: readonly BoxAABB[]): readonly WallAABB[] {
  return boxes.filter((box) => y < box.topY)
}

/** 접지 결과 — 수평은 `vx`·`vz`를 그대로(값으로) 적용·보고하고 수직은
 * `standingHeight`가 계산한 지지 높이로 재계산한다(박스 없으면 항상 0 —
 * 기존 동작과 바이트 동일). 그대로 서 있는 경우와 공중에서 착지하는
 * 경우가 같은 모양이라 공유한다. **`groundedOutcome`이 매 틱 y를
 * 재계산해야 하는 이유(원장 `_workspace/RQ-22-box-jump/01_test-writer
 * _red.md` "접지 지속" 절)**: 하드코딩된 0을 쓰면 박스 위에 착지한 다음
 * 틱에 y가 도로 0으로 꺼지는 "1틱 반짝임" 결함이 생긴다 — 착지 이후
 * 매 틱은 이 함수(`stepGrounded`→`groundedOutcome`)를 타므로, 여기가
 * 박스를 모르면 즉시 바닥으로 떨어진다.
 *
 * 세계 경계(`clampToWorldBounds`) 절단 이후 벽 절단(`clampAgainstWalls`,
 * 벽 + 이번 틱 차단 대상 박스를 합쳐서)을 적용한다 — 둘 다 위치만 절단하고
 * 속도(`vx`/`vz`)는 그대로 보고한다(위 `clampToWorldBounds` 코멘트의
 * "절단 대상은 위치뿐"과 동일한 선택 — 속도 처리는 이 라운드의 스코프가
 * 아니다). */
function groundedOutcome(
  state: MoveState,
  vx: number,
  vz: number,
  walls: readonly WallAABB[],
  boxes: readonly BoxAABB[],
): MoveState {
  const boundedX = clampToWorldBounds(state.x + vx * TICK_SECONDS)
  const boundedZ = clampToWorldBounds(state.z + vz * TICK_SECONDS)
  const blockingBoxes = boxesBlockingAt(state.y, boxes)
  const { x, z } = clampAgainstWalls(state.x, state.z, boundedX, boundedZ, [...walls, ...blockingBoxes])
  return {
    x,
    y: standingHeight(x, z, boxes),
    z,
    vx,
    vy: 0,
    vz,
    grounded: true,
  }
}

/** 이륙 후 경과 시각 `tPrev`(초, **이번 틱 시작 시점 기준** — 아직 이번
 * 틱의 `TICK_SECONDS`를 더하지 않은 값)에서의 공중 결과.
 *
 * **REV(리뷰 blocker 수정 — 원장 25a-4/평가) — 궤적을 발밑(launch-relative)
 * 기준으로 오프셋한다.** `jumpHeightAt(t)`는 `y=0` 기준 절대 높이 곡선이다
 * — 박스 위(발밑 높이 `h0 = standingHeight(...) > 0`)에서 이함하면, 옛
 * 구현은 이 절대 곡선을 그대로 썼다. 그 결과 이함 첫 틱의 절대 높이
 * (`jumpHeightAt(TICK_SECONDS)` ≈ 0.1997m, 현재 물리 상수 기준)가 `h0`
 * 이하면 착지 스냅 조건(`height <= support`)이 **이함 그 자체에서 이미
 * 참**이 되어 점프가 통째로 삼켜졌다(`h0` > 0.1997m인 모든 박스, RQ-32
 * 허용 구간 0.2~1.0m 전부 해당). 삼켜지지 않는 낮은 `h0`에서도 정점이
 * 절대 `MOVEMENT.JUMP_HEIGHT`에 고정돼 발밑 기준(`h0 + JUMP_HEIGHT`)에서
 * 어긋났다 — "높은 지대일수록 실효 점프가 낮아진다"는 비대칭인데, 어떤
 * 스펙 문장도 이를 규정하지 않는다(리뷰어 지적).
 *
 * **오프셋 값(`h0`)을 별도 필드로 저장하지 않는다** — `MoveState`
 * 7필드 계약(REV 2026-07-24)을 깨지 않기 위해서다. 대신 매 틱
 * `state.y - jumpHeightAt(tPrev)`로 다시 구한다 — `state.y`가 이미
 * `h0 + jumpHeightAt(tPrev)`이므로 대수적으로 `h0`과 같다. **평지(맨
 * 지면, `h0=0`)에서는 이 값이 IEEE754상 항상 정확히 0으로 떨어진다**
 * (`X - X = 0`은 부동소수점에서 반올림 없이 항상 정확하다 — `state.y`가
 * 귀납적으로 `jumpHeightAt(tPrev)`와 비트 동일하기 때문, 아래 §회귀
 * 참고) — 그래서 이 변경은 기존 절대 곡선 동작과 **바이트 동일**하다
 * (박스가 없거나 발밑이 맨 지면일 때).
 *
 * 해석적 궤적 높이(`h0 + jumpHeightAt(tNext)`)가 지지 높이
 * (`standingHeight`, 박스 없으면 항상 0) 이하로 내려간 시점이면 착지로
 * 스냅한다 — 그 시점까지 유지해 온 수평 속도(vx·vz)로 착지 틱의 이동까지
 * 마저 적용한다.
 *
 * **REV(독립 평가 FAIL F2 대응) — 공중 상태도 벽을 본다**: `WallAABB`
 * docblock이 "무한 높이 기둥"이라고 선언한 이상 공중(점프 중)에도 그
 * 기둥을 통과할 수 없어야 문서와 코드가 일치한다 — 최초 구현은 공중
 * 궤적에 `walls`를 전혀 스레딩하지 않아 몸통 높이로 벽을 관통했다(평가자
 * 실측: x=15에서 점프 → 1틱 만에 x=15.4로 벽 안쪽 진입). 이제 착지
 * 스냅(`groundedOutcome` 호출)뿐 아니라 **체공 중 매 틱의 수평 위치도**
 * `clampAgainstWalls`(벽 + 이번 틱 차단 대상 박스)로 절단한다 — 세계
 * 경계(`clampToWorldBounds`)를 먼저 적용한 뒤 벽을 적용하는 순서는 접지
 * 경로(`groundedOutcome`)와 동일하다.
 *
 * **RQ-22 박스 등반과의 관계**: 박스(유한 높이)는 `WallAABB`와 다른
 * 범주라 `walls` 목록에 포함되지 않는다 — 대신 `boxesBlockingAt`이 매 틱
 * `state.y`(직전 높이)를 기준으로 "지금 옆면 취급해야 하는 박스"만 골라
 * 벽 목록에 합류시킨다. 상단(`topY`)보다 높은 고도에서 접근하면 그 틱은
 * 차단 목록에서 빠지므로 박스 위를 자유롭게 지나간다 — 벽이 무한 높이인
 * 것과 박스가 낮아 뛰어넘을 수 있는 것은 양립한다. */
function airborneOutcome(
  state: MoveState,
  vx: number,
  vz: number,
  tPrev: number,
  walls: readonly WallAABB[],
  boxes: readonly BoxAABB[],
): MoveState {
  const tNext = tPrev + TICK_SECONDS
  const boundedX = clampToWorldBounds(state.x + vx * TICK_SECONDS)
  const boundedZ = clampToWorldBounds(state.z + vz * TICK_SECONDS)
  const blockingBoxes = boxesBlockingAt(state.y, boxes)
  const { x, z } = clampAgainstWalls(state.x, state.z, boundedX, boundedZ, [...walls, ...blockingBoxes])

  const tookOffFrom = state.y - jumpHeightAt(tPrev)
  const height = tookOffFrom + jumpHeightAt(tNext)
  const support = standingHeight(x, z, boxes)
  if (height <= support) {
    return groundedOutcome(state, vx, vz, walls, boxes)
  }
  return {
    x,
    y: height,
    z,
    vx,
    vy: jumpVyAt(tNext),
    vz,
    grounded: false,
  }
}

function stepGrounded(state: MoveState, input: MoveInput, walls: readonly WallAABB[], boxes: readonly BoxAABB[]): MoveState {
  const { vx, vz } = groundVelocity(input)
  if (!input.jump) {
    return groundedOutcome(state, vx, vz, walls, boxes)
  }
  // 이륙 — 이번 틱의 수평 속도를 그대로 착지까지의 공중 관성으로
  // 고정한다(RQ-92 공중 가속 미허용). `tPrev=0` — 이함 시점(아직 이번
  // 틱이 경과하지 않은 시각)이라 발밑 오프셋(`tookOffFrom`, 위
  // `airborneOutcome` 코멘트)이 정확히 `state.y`(이함 직전 접지 높이)가
  // 된다. 이함 틱도 접지·공중 나머지 구간과 동일하게 벽·박스를 본다.
  return airborneOutcome(state, vx, vz, 0, walls, boxes)
}

/** 공중 물리는 이번 틱 입력을 참조하지 않는다 — `MOVEMENT.AIR_CONTROL
 * === false`(RQ-92)라 방향 입력이 무엇이든 상태에 담긴 `vx`·`vz`(이륙
 * 순간 고정된 값)만 그대로 적용한다(에어 스트레이프·버니합 없음). 상태
 * **값**만 읽으므로 직렬화 왕복·얕은 복사를 거친 `state`를 넘겨도 결과가
 * 같다(REV 2026-07-24). */
function stepAirborne(state: MoveState, walls: readonly WallAABB[], boxes: readonly BoxAABB[]): MoveState {
  const tPrev = jumpElapsedSeconds(state.vy)
  return airborneOutcome(state, state.vx, state.vz, tPrev, walls, boxes)
}

/** 1틱(`NET.TICK_MS`) 전진 — 순수 산술(RQ-20, RQ-92). Rapier 없음,
 * 사다리(RQ-21)·낙하 데미지(RQ-18)는 여전히 스코프 밖이다 — 박스 등반
 * (RQ-22)은 이 함수가 직접 다룬다(아래 `boxes` 인자, 원장 25a-4).
 *
 * **`walls`(RQ-30, 원장 25a-2/26o) — 세 번째 인자, 기본값 `[]`**: 정적
 * 지오메트리를 축 정렬 상자 목록으로 **주입**받는다(`src/shared`는 파일·
 * 전역·환경에서 벽을 읽지 않는다 — ADR-0010 환경 중립). 생략하거나 빈
 * 배열을 넘기면 벽이 전혀 없던 기존 동작 그대로다(하위 호환 — 기존 13개
 * 호출부가 전부 이 계약을 만족한다). **접지·공중 모두 적용한다**(평가
 * FAIL F2 대응 REV, 위 `airborneOutcome` 코멘트 참고 — 최초 구현은 접지
 * 상태에만 적용해 공중에서 벽을 관통했다).
 *
 * **`boxes`(RQ-22, 원장 25a-4) — 네 번째 인자, 기본값 `[]`**: 유한 높이
 * 지오메트리를 `walls`와 동일하게 환경 중립으로 주입받는다. 생략하거나
 * 빈 배열을 넘기면 지지 높이(`standingHeight`)가 항상 0이라 박스가 전혀
 * 없던 기존 동작과 바이트 동일하다(하위 호환 — 기존 15개 `stepMovement`
 * 호출 테스트 파일 전부 이 계약을 만족, `tests/unit/sim-movement-boxes
 * .test.ts` "기본값 호환" 절). */
export function stepMovement(
  state: MoveState,
  input: MoveInput,
  walls: readonly WallAABB[] = [],
  boxes: readonly BoxAABB[] = [],
): MoveState {
  return state.grounded ? stepGrounded(state, input, walls, boxes) : stepAirborne(state, walls, boxes)
}
