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

/**
 * RQ-21 사다리(원장 25a-7, ADR-0013 결정 2 "센서 질의는 주입된 함수/데이터로
 * 받는다") — 등반 가능한 수직 볼륨을 축 정렬 상자 + 면 법선으로 표현한다.
 * `WallAABB`·`BoxAABB`와 달리 수직 범위(`minY`/`maxY`)와 법선이 함께
 * 있다 — "어느 방향이 상승인가"는 벽·박스처럼 기하만으로 정해지지 않고
 * 사다리가 향한 면이 정한다(`tests/unit/sim-movement-ladders.test.ts`
 * docblock "법선 일반성" 절).
 */
export interface LadderVolume {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  /** 사다리가 유효한 수직 범위(m) — 이 구간 밖은 사다리가 아니다. */
  minY: number
  maxY: number
  /** 사다리 면을 향하는 단위 법선(XZ 평면, 정규화 전제) — 이동 입력의
   * (dirX,dirZ)를 이 벡터에 내적한 값이 양수면 상승, 음수면 하강, 0이면
   * 정지(RQ-21 v1.4 "서버가 관측 가능한 양으로 방향을 정의"). */
  normalX: number
  normalZ: number
}

/**
 * 원장 25a-5 — 정적 지오메트리 단일 값 주입 계약. `stepMovement(state,
 * input, walls = [], boxes = [])`처럼 지오메트리 종류마다 기본값 있는
 * 위치 인자를 추가하면, 호출부가 하나만 빠뜨려도 타입 검사를 통과해
 * 서버·클라 발산이 재발한다(25a-2 F3 벽 · 25a-4 박스, 원장 25a-5). 사다리를
 * 세 번째 정적 지오메트리 종류로 얹으면서, 위치 인자를 늘리는 대신 세
 * 필드를 전부 요구하는 단일 객체로 묶어 **누락이 타입 에러가 되게** 한다
 * — 필드 하나라도 빠진 리터럴은 이 인터페이스에 대입할 수 없다(옵셔널·
 * 인덱스 시그니처 금지, `tests/unit/sim-movement-ladders.test.ts` "25a-5
 * 계약" 절이 `@ts-expect-error`로 이를 직접 고정한다). */
export interface StaticGeometry {
  walls: readonly WallAABB[]
  boxes: readonly BoxAABB[]
  ladders: readonly LadderVolume[]
}

/** 지오메트리가 전혀 없는 기본값 — `stepMovement`의 세 번째 인자를
 * 생략하거나 이 값을 그대로 넘기면 벽·박스·사다리가 전혀 없던 기존 동작
 * 그대로다(하위 호환, ADR-0010). */
export const EMPTY_GEOMETRY: StaticGeometry = { walls: [], boxes: [], ladders: [] }

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

/** 사다리 상승/하강 속도(m/s, RQ-21 v1.4) — 앉기 속도(RQ-92)와 같다.
 * 리터럴 3을 쓰지 않고 상수에서 유도한다(ADR-0010 값 복제 금지). */
const LADDER_CLIMB_MPS = MOVEMENT.SPEED * MOVEMENT.CROUCH_MULTIPLIER

/** 사다리 Y 경계 판정의 부동소수점 허용 오차(m). 여러 틱에 걸쳐 `y += vy ×
 * TICK_SECONDS`를 반복 가산하면 정확히 `minY`/`maxY`에 도달해야 하는
 * 지점에서 최종 비트 단위 오차가 생긴다(실측: 0에서 0.1m씩 40회 가산한
 * 결과가 정확히 4가 아니라 `4.000000000000002`). 이 오차가 "볼륨을 실제로
 * 벗어났다"는 판정을 오염시키지 않도록, 이 파일을 검증하는 테스트가 쓰는
 * 허용치(`TOLERANCE_M = 1e-9`)와 같은 크기의 여유를 둔다. */
const LADDER_Y_EPSILON_M = 1e-9

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
 * 여기 적어 둔다.
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
 * 아니다).
 *
 * **원장 25a-6 회수 — 걸어서(비점프) 지지 높이가 낮아지는 가장자리를
 * 벗어나면 공중(자유낙하)으로 전이한다.** 옛 구현은 위 재계산이 낮아진
 * 지지 높이로도 그대로 `grounded: true`를 반환해, 박스 가장자리를
 * 걸어서 넘는 틱에 y가 순간 하강하면서도 접지 상태가 유지되는 결함이
 * 있었다 — `GameRoom.trackFallDamage`(`next.grounded === false`일 때만
 * `fallPeakY` 갱신)가 이 낙하를 전혀 관측하지 못해 낙하 데미지가
 * 우회됐다(`tests/unit/sim-movement-boxes.test.ts` "원장 25a-6 회수"
 * describe가 재현·고정). 새 지지 높이(`support`)가 직전 높이(`state.y`)
 * 보다 **낮아지면**, 그 낮은 높이로 즉시 스냅하지 않고
 * `airborneOutcome`으로 넘겨 중력 낙하 궤적을 계산한다 — 사다리 이탈
 * 폴백(`stepMovement`의 "지지면이 없다" 분기, 원장 25a-7 F1 수정)이 이미
 * 쓰는 것과 같은 기법이다: 현재 수직 속도(`state.vy` — 접지 중에는
 * 보통 0이지만, 사다리에서 막 지지면으로 전환된 직후처럼 잔여 값이
 * 있으면 그대로 인계한다)를 표준 점프 곡선 위의 한 순간으로 재해석해
 * `tPrev`를 구하면, 다음 틱부터 중력 가속으로 매끄럽게 이어지는 낙하
 * 궤적이 나온다(새 궤적 모델을 발명하지 않는다).
 *
 * **"이전 지지 높이"는 `state.y`가 아니라 `standingHeight(state.x,
 * state.z, boxes)`로 재계산한다(합성 상태 오탐 방지)**: 이 파일·
 * `sim-movement-ladders.test.ts`는 관례적으로 `y`가 실제 지오메트리와
 * 무관한 값(예: 사다리 안쪽 합성 상태 `y=1.5`, 박스가 전혀 없는
 * 지오메트리)을 가진 **합성 접지 상태**를 직접 구성해 특정 분기만
 * 떼어 검증한다(REV 2026-07-24 "상태는 값의 완전한 스냅샷" 정신 — 그
 * 상태에 실제로 도달하는 자연스러운 경로가 있는지는 무관하다). `state.y`
 * 자체를 "직전 지지 높이"로 오인하면, 이런 합성 상태(현재 위치의 실제
 * `standingHeight`는 0인데 `state.y`가 그보다 큰 경우)에서 실제로는
 * 아무 것도 벗어난 적이 없는데도 이 분기가 오발화한다(평가 실측:
 * `sim-movement-ladders.test.ts` "사다리를 아예 주입하지 않으면" 테스트
 * — 사다리 중심 합성 상태 `y=1.5`, 박스 없음 — 가 `next.y≈0` 대신
 * 공중 낙하 궤적 값을 반환해 실패했다). 대신 **현재 위치**의 지오메트리
 * 기준 지지 높이(`previousSupport`)를 새로 계산해 새 위치의 지지 높이와
 * 비교한다 — 두 값 모두 지오메트리에서 직접 유도되므로 `state.y`의
 * 신뢰성과 무관하게 "실제로 지지면이 낮아졌는가"만 순수하게 묻는다.
 *
 * **`state.grounded` 게이트가 필요한 이유(착지 실패 방지)**:
 * `airborneOutcome`은 착지 판정 시(`height <= support`) 바로 이
 * `groundedOutcome`을 다시 호출한다(아래) — 그 호출의 `state`는 직전
 * 틱의 **공중** 상태라서, 게이트 없이 지지 높이 하강만 봤다면 정상
 * 착지마다(박스 위든 맨 지면이든, 모든 기존 점프 테스트가 이 경로를
 * 탄다) 다시 공중으로 튕겨 나가 착지 자체가 성립하지 않았을 것이다.
 * `state.grounded`가 참일 때만(즉 `stepGrounded`가 직접 부른 경우에만)
 * 이 분기를 타게 하면, 착지 재호출(`state.grounded === false`)은 이
 * 분기를 건너뛰고 기존 그대로 스냅한다.
 *
 * **`airborneOutcome`에 원래 `state`가 아니라 `{ ...state, grounded:
 * false }`를 넘기는 이유(무한 재귀 차단, 실측)**: 최초 구현은 원래
 * `state`(`grounded: true`)를 그대로 `airborneOutcome`에 넘겼다. 사다리
 * 이탈 폴백(`stepMovement`)이 **원래 `state`**(`grounded: true`)를 이미
 * 이 함수에 물려주는 경로가 있어(지지면 있음 분기 → `stepGrounded` →
 * `groundedOutcome`), 낙차가 얕아 **같은 틱 안에서 즉시 착지**하면
 * `airborneOutcome`이 위 착지 재호출에서 다시 이 `groundedOutcome`을
 * 부르는데 — 이번에도 여전히 `state.grounded === true`(원래 인자를
 * 그대로 물려받았으므로)이고 지지 높이 비교도 그대로 참이라(같은
 * `state`·같은 계산이니 결과가 바뀔 리 없다) **같은 분기를 다시 타
 * `airborneOutcome`을 다시 부르고, 그게 다시 착지를 재판정해 다시 이
 * 함수를 부르는** 무한 상호 재귀가 됐다(`RangeError: Maximum call stack
 * size exceeded`, `sim-movement-ladders.test.ts`의 사다리 이탈 후 접지
 * 유지 테스트에서 실측). `grounded: false`로 표시한 사본을 넘기면, 착지
 * 재호출 시점의 `state.grounded`가 `false`가 되어 이 분기 자체를
 * 건너뛰므로(바로 위 문단) 재귀가 정확히 한 겹에서 끊긴다 — `x`·`y`·
 * `z`·`vx`·`vz`는 원래 `state`와 값이 같으므로 낙차·궤적 계산에는
 * 영향이 없다. */
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
  const support = standingHeight(x, z, boxes)
  const previousSupport = standingHeight(state.x, state.z, boxes)
  if (state.grounded && support < previousSupport) {
    // 공중 전이 — `grounded: false`로 표시한 상태를 `airborneOutcome`에
    // 넘긴다(무한 재귀 차단, 위 문단). `x`·`y`·`z`·`vx`·`vz`는 원래
    // `state`와 동일하게 유지한다 — `tookOffFrom` 계산은 여전히 원래
    // `state.y`를 참조해야 낙차가 정확하다.
    const airborneState: MoveState = { ...state, grounded: false }
    return airborneOutcome(airborneState, vx, vz, jumpElapsedSeconds(state.vy), walls, boxes)
  }
  return {
    x,
    y: support,
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
 * `h0 + jumpHeightAt(tPrev)`이므로 대수적으로 `h0`과 같다.
 *
 * ⚠️ **평지 궤적은 기존과 "바이트 동일"하지 않다 — 초안의 그 주장은
 * 철회됐다**(`_workspace/RQ-22-box-jump/05_coder_blocker.md` §4가 정정,
 * 독립 평가가 재확인). 실측 잔차는 **최대 3.33e-16(3 ULP)**이고, 원인은
 * `stepAirborne`이 `jumpElapsedSeconds(state.vy)`로 `tPrev`를 복원하는
 * **기존** 왕복(최대 1 ULP)이다 — 이 수정이 만든 것이 아니라 그 왕복을
 * 한 번 더 타는 것이다. 구조적 증거: 잔차가 **tick 0에서 정확히 0, tick 1
 * 부터 발생**한다(tick 0은 `tPrev=0`이 리터럴이라 왕복이 없다).
 *
 * **발산하지 않는다**(평가자 실측): 착지마다 `standingHeight`가 정확한
 * 리터럴로 y를 덮어써 리셋되므로, 60틱·점프 4회에서 `grounded`·`x`가
 * 비트 완전 일치하고 접지 y 집합이 정확히 `{0.0}`이며 정점이 소수
 * 12자리까지 동일하다. 테스트 허용오차(`toBeCloseTo(x, 6)`)보다 10자릿수
 * 아래다.
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

/** `y`가 사다리의 수직 범위 안(폐구간, `LADDER_Y_EPSILON_M` 여유 포함)에
 * 있는지. Y가 폐구간인 이유는 지면에서 걸어 들어온 플레이어가 정확히
 * `y = minY`(사다리 밑동 = 지면 높이)에 서 있는 순간부터 "볼륨 안"으로
 * 인정돼야 진입 자체가 성립하기 때문이다(개방 구간이면 진입 지점 자체가
 * 영원히 "볼륨 밖"이 된다). */
function isWithinLadderY(y: number, ladder: LadderVolume): boolean {
  return y >= ladder.minY - LADDER_Y_EPSILON_M && y <= ladder.maxY + LADDER_Y_EPSILON_M
}

/** 위치 `(x,y,z)`를 포함하는 첫 사다리를 찾는다. XZ는 벽·박스와 동일한
 * 개방 구간(`clampAgainstWalls`/`standingHeight`와 동일 관례), Y는 위
 * `isWithinLadderY`(폐구간)를 쓴다. */
function findLadderAt(x: number, y: number, z: number, ladders: readonly LadderVolume[]): LadderVolume | undefined {
  return ladders.find(
    (ladder) => x > ladder.minX && x < ladder.maxX && z > ladder.minZ && z < ladder.maxZ && isWithinLadderY(y, ladder),
  )
}

/** 사다리 결과(RQ-21 v1.4) — 입력의 수평 방향(정규화 후)을 사다리 면의
 * 법선에 내적한 값이 상승/하강/정지를 정한다. `vx`·`vz`는 0이다 — 사다리는
 * 수직 이동만 허용하고(RQ-21 원문), 수평 관성이라는 개념 자체가 없다.
 *
 * **`x`·`z`는 진입 시점 값을 그대로 유지한다(스냅하지 않는다)** — RQ-21
 * v1.4·GA-54는 사다리 볼륨 안의 수평 위치를 전혀 규정하지 않는다(중력
 * 미적용·법선 기준 상승/하강/정지·이탈 시 중력 복귀·속도 3m/s가 전부).
 * 한때 XZ 폭 중심으로 스냅하는 구현이 있었으나, 그 근거는 통합 테스트의
 * `toBeCloseTo(center, 1)` 단언이었고 — 그 단언 자체가 결함이었다(정밀도
 * 0.05m가 걷기 보폭 0.2m/틱보다 좁아 "볼륨 안에 들어와 있다"는 느슨한
 * 위생 점검을 의도치 않게 "정확히 중앙 스냅"이라는 강한 계약으로 만들어
 * 버렸다). 스펙이 요구하지 않는 동작을 테스트에 맞춰 도입한 것이라 걷어냈다
 * — 단언은 `tests/integration/rq-21-ladder-vertical-movement.test.ts`(REV,
 * 볼륨 XZ 범위 안인지만 확인)로 정정됐다. `x`·`z`는 등반 내내(상승·하강·
 * 정지) 그대로 유지되므로("불변") 진입 경로와 무관하게 안정적이다.
 *
 * **`grounded: true`인 이유(RQ-18과의 상호작용, 설계 결정)**: `grounded`를
 * `false`(공중)로 보고하면 `GameRoom.trackFallDamage`의 `fallPeakY`가
 * `next.grounded === false`인 동안 러닝 최댓값을 추적하므로, 사다리를
 * 안전하게 타고 내려오는 것을 낙하로 오귀속해 가짜 낙하 데미지가 붙는다
 * (`tests/unit/sim-movement-ladders.test.ts` "RQ-18 상호작용" 절 참고).
 * `grounded: true`를 쓰면 `trackFallDamage`가 애초에 `fallPeakY`를
 * 갱신하지 않으므로(GameRoom 코드 변경 없이) 이 오귀속이 구조적으로
 * 발생하지 않는다. */
function ladderOutcome(state: MoveState, input: MoveInput, ladder: LadderVolume): MoveState {
  const { dirX, dirZ } = clampDirection(input.dirX, input.dirZ)
  const projection = dirX * ladder.normalX + dirZ * ladder.normalZ
  const vy = projection > 0 ? LADDER_CLIMB_MPS : projection < 0 ? -LADDER_CLIMB_MPS : 0
  return {
    x: state.x,
    y: state.y + vy * TICK_SECONDS,
    z: state.z,
    vx: 0,
    vy,
    vz: 0,
    grounded: true,
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

/** 1틱(`NET.TICK_MS`) 전진 — 순수 산술(RQ-20, RQ-92). Rapier 없음. 박스
 * 등반(RQ-22)·사다리(RQ-21)는 이 함수가 직접 다룬다(아래 `geometry` 인자,
 * 원장 25a-4·25a-7). 낙하 데미지(RQ-18)는 여전히 스코프 밖(`GameRoom`이
 * 이 함수의 출력을 보고 별도로 계산한다).
 *
 * **`geometry`(`StaticGeometry`, 원장 25a-5) — 세 번째 인자, 기본값
 * `EMPTY_GEOMETRY`**: 벽·박스·사다리 세 정적 지오메트리를 단일 값으로
 * **주입**받는다(`src/shared`는 파일·전역·환경에서 지오메트리를 읽지
 * 않는다 — ADR-0010 환경 중립). 생략하거나 `EMPTY_GEOMETRY`를 그대로
 * 넘기면 지오메트리가 전혀 없던 기존 동작 그대로다(하위 호환 — 기존
 * 호출부 전부 이 계약을 만족한다).
 *
 * **`geometry.walls`(RQ-30, 원장 25a-2/26o)**: 축 정렬 상자 목록. **접지·
 * 공중 모두 적용한다**(평가 FAIL F2 대응 REV, 아래 `airborneOutcome`
 * 코멘트 참고 — 최초 구현은 접지 상태에만 적용해 공중에서 벽을
 * 관통했다).
 *
 * **`geometry.boxes`(RQ-22, 원장 25a-4)**: 유한 높이 지오메트리. 비어
 * 있으면 지지 높이(`standingHeight`)가 항상 0이라 박스가 전혀 없던 기존
 * 동작과 바이트 동일하다.
 *
 * **`geometry.ladders`(RQ-21, 원장 25a-7, REV 평가 FAIL F1 대응)**: 등반
 * 가능한 수직 볼륨. 이번 틱 시작 시점의 위치(`state.x/y/z`)가 어떤
 * 사다리의 볼륨 안이고 **`state.grounded`가 참**이면, 접지/공중 분기
 * (`stepGrounded`/`stepAirborne`) **대신** 사다리 결과(`ladderOutcome`)를
 * 반환한다.
 *
 * **`state.grounded`가 참일 때만 재포획하는 이유(F1 수정, 아래)**: 사다리
 * 이탈이 공중 전이를 만드는 이상, 낙하 중인 상태가 여전히 사다리의 XZ×Y
 * 경계 상자 안(사다리 바로 아래로 떨어지는 경로는 필연적으로 그렇다)에
 * 있다는 이유만으로 매 틱 다시 사다리에 붙잡히면 낙하가 완주되지 못하고
 * 사다리 상단 바로 아래 좁은 띠에서 영원히 진동한다(실측 확인, 아래 F1
 * 절). 접지 상태에서 걸어 들어오는 정상 진입은 이 게이트로 막히지
 * 않는다(걷는 동안은 항상 `grounded: true`).
 *
 * 이번 틱의 사다리 결과가 볼륨을 벗어나면(`isWithinLadderY`가 거짓):
 * - **지지면이 있으면**(`standingHeight(state.x, state.z, geometry.boxes)`가
 *   `state.y` 이상 — 예: 사다리 상단과 높이가 맞는 발판) 원래 위치 기준
 *   접지/공중 물리로 넘어가 그 높이에 붙는다(기존 "발판 있음" 동작 유지).
 * - **지지면이 없으면** 접지로 즉시 스냅하지 않고 **공중(자유낙하) 상태로
 *   전이한다**(`grounded: false`) — "볼륨을 벗어나면 즉시 중력이
 *   복귀한다"(RQ-21 v1.4 마지막 문장)가 문면 그대로 성립하고, `GameRoom
 *   .trackFallDamage`가 실제 `grounded` 전이를 관측해 낙차만큼 데미지를
 *   매긴다.
 *
 * **REV(독립 평가 FAIL F1, `_workspace/RQ-21-ladder/03_evaluator_report.md`)**:
 * 최초 구현은 지지면 유무와 무관하게 항상 원래 `state`로 접지 분기를
 * 다시 호출했다 — 발판 없는 프로덕션 사다리(`LADDER_ALPHA`, `maxY=4`,
 * 발판 없음)에서 상단을 넘기면 그 자리에서 즉시 `y=0`(맨 지면)으로
 * 스냅됐다(`grounded` 유지 `true`, 중간 낙하 구간이 아예 없음). 착지
 * 전이 자체가 없으니 `GameRoom.trackFallDamage`(`next.grounded ===
 * false`인 동안만 `fallPeakY` 갱신)가 결코 발화하지 않아 3.85m~4m
 * 낙차에도 데미지가 0이었고, 스냅된 위치가 여전히 사다리 범위 안이라
 * 다음 틱에 다시 붙잡혀 재상승하는 4↔0 무한 순환(요요)이 됐다. */
export function stepMovement(state: MoveState, input: MoveInput, geometry: StaticGeometry = EMPTY_GEOMETRY): MoveState {
  const ladder = state.grounded ? findLadderAt(state.x, state.y, state.z, geometry.ladders) : undefined
  if (ladder) {
    const outcome = ladderOutcome(state, input, ladder)
    if (isWithinLadderY(outcome.y, ladder)) {
      return outcome
    }
    // 이번 틱에 사다리 볼륨을 벗어난다.
    const support = standingHeight(state.x, state.z, geometry.boxes)
    if (support < state.y) {
      // 지지면이 없다 — 이탈 순간의 사다리 수직 속도(outcome.vy)를 낙하
      // 궤적의 초기 속도로 인계한다. jumpElapsedSeconds는 stepAirborne이
      // 이미 쓰는 기존 기법(임의의 vy를 표준 점프 곡선 위의 한 순간으로
      // 재해석)을 그대로 재사용한다 — 새 궤적 모델을 발명하지 않는다.
      // 수평 속도는 0(사다리는 수평 관성을 만들지 않는다, `ladderOutcome`
      // 코멘트 참고).
      const tPrev = jumpElapsedSeconds(outcome.vy)
      return airborneOutcome(state, 0, 0, tPrev, geometry.walls, geometry.boxes)
    }
    // 지지면이 있다(발판 등) — 원래 위치(`state`, 사다리 판정에 쓰인
    // 시작점) 기준으로 접지/공중 물리를 그대로 적용해 그 높이로 전환한다.
    // `outcome`의 초과된 y는 쓰지 않는다.
  }
  return state.grounded
    ? stepGrounded(state, input, geometry.walls, geometry.boxes)
    : stepAirborne(state, geometry.walls, geometry.boxes)
}
