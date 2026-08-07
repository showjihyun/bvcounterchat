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
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'

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
  /** RQ-33 — 등반 전용 고지대 플랫폼(`@shared/sim/platforms`). **네 번째
   * 필드를 `boxes` 필수 3종과 달리 옵셔널로 둔 이유**: `boxes` 필수 규칙의
   * 목적(위 문단 "누락이 타입 에러가 되게")은 지키되, `PRODUCTION_GEOMETRY
   * .boxes`가 `PRODUCTION_BOXES`와 **참조 동일성**을 유지해야 한다
   * (`tests/unit/sim-movement-ladders.test.ts` "25a-5 계약" 테스트,
   * `expect(PRODUCTION_GEOMETRY.boxes).toBe(PRODUCTION_BOXES)` — `tests/`
   * 수정 금지, ADR-0011 Red-first) — 즉 플랫폼을 `boxes` 배열 자체에
   * 스프레드해 합칠 수 없다. 또한 기존 `StaticGeometry` 리터럴(예:
   * `tests/unit/sim-movement-boxes.test.ts:664`, `sim-movement-ladders
   * .test.ts`의 `geometryWithLadders`)이 `platforms`를 전혀 모른 채 세
   * 필드만 채우므로, 이 필드가 필수였다면 그 리터럴들이 컴파일 에러가
   * 난다(기존 테스트 파괴 금지). 생략 시 빈 배열로 취급한다(아래
   * `stepMovement`, 하위 호환 ADR-0010). `standingHeight`/`boxesBlockingAt`
   * 자체는 여전히 임의의 `BoxAABB[]`를 받는 기존 함수 그대로다 — `boxes`와
   * `platforms`를 합친 배열을 `stepMovement`가 호출 시점에 넘길 뿐, 새
   * 판정 로직은 없다. */
  platforms?: readonly BoxAABB[]
}

/** 지오메트리가 전혀 없는 기본값 — `stepMovement`의 세 번째 인자를
 * 생략하거나 이 값을 그대로 넘기면 벽·박스·사다리가 전혀 없던 기존 동작
 * 그대로다(하위 호환, ADR-0010). `platforms`는 옵셔널이라 생략 — 위
 * `StaticGeometry.platforms` 코멘트 참고. */
export const EMPTY_GEOMETRY: StaticGeometry = { walls: [], boxes: [], ladders: [] }

/** 1틱의 경과 시간(초). `NET.TICK_MS`(1000/30, 부동소수점)를 매번 나누지
 * 않도록 모듈 로드 시 한 번만 계산한다. */
const TICK_SECONDS = NET.TICK_MS / 1000

/** 월드 경계(RQ-30, GA-50) — `WORLD.SIZE_M`(60)에서 유도, ±30 하드코딩
 * 금지(ADR-0010). */
const HALF_WORLD_M = WORLD.SIZE_M / 2

/** 몸 반경 이동 판정(원장 24af, 사용자 결정 2026-08-06) — 벽·박스·플랫폼
 * 옆면 차단 시 플레이어 **중심**을 근접면에서 이 값만큼 떨어뜨린다.
 * `DEFAULT_HITBOX.bodyRadiusM`(`@shared/config/combat-tuning`)에서
 * 유도한다(ADR-0010, 값 복제 금지) — 서버 hitscan(`@shared/sim/combat`)이
 * 쓰는 몸통 원통 반지름과 같은 값이어야 "이동은 통과시키고 hitscan만
 * 막는" 판정 불일치(사용자 플레이테스트 보고, 24af Red 보고서 §도입부)가
 * 재발하지 않는다. `clampAgainstWalls`에만 적용한다 —
 * `standingHeight`/`boxesBlockingAt`(수직 지지·차단 목록 판정)은 이
 * 라운드의 스코프 밖(사용자 결정은 "수평 차단 판정"만 지정한다). */
const BODY_RADIUS_M = DEFAULT_HITBOX.bodyRadiusM

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

/** RQ-33(GA-59) — 사다리 근접면에서 인접 플랫폼 안쪽으로 **결정론적으로**
 * 밀어 넣는 진입 여유(m). `MOVEMENT.SPEED × TICK_SECONDS`(표준 이동
 * 속도로 1틱 이동하는 거리, 리터럴 아님 — ADR-0010)에서 유도한다 —
 * "옆걸음 한 걸음"이라는 의미와도 맞는다. **독립 평가 FAIL F1
 * 수정(`_workspace/RQ-33/05_evaluator_report.md` §6 F1)**: `stepOntoPlatform`
 * 최초 구현은 사다리 근접면(`ladder.maxX`, 플랫폼의 **열린 구간 밖**
 * 경계) 그 자체에 플레이어를 놓고, **이번 틱 입력에서 유도한 `vx`**로
 * 플랫폼 안쪽까지 걸어 들어가길 기대했다 — `vy`(등반 속도)는 입력
 * 방향의 부호만 보는데 `vx`(옆걸음 속도)는 입력 **크기**에 비례하므로,
 * `dirX`가 극도로 작으면(`vx × TICK_SECONDS`가 좌표 `-13` 근방의
 * 부동소수점 최소 증분(ulp)보다 작아지면) `x`가 경계에 그대로 머물러
 * `standingHeight`가 0을 반환하고 `y`가 4→0으로 스냅됐다(`grounded`는
 * 계속 `true`라 착지 전이가 없어 RQ-18 데미지도 우회됨 — RQ-61 위반,
 * `tests/unit/sim-movement-ladders.test.ts`의 "F1(blocker)" `it.each`가
 * 크기 11종으로 고정). **고정값(리터럴)이 아니라 상수에서 유도한 이
 * 여유를 진입 위치 자체에 미리 더해 두면**, 그 뒤 `groundedOutcome`이
 * 이번 틱 입력으로 계산하는 추가 이동량이 얼마나 작든(심지어 0에
 * 수렴해도) 이미 플랫폼의 열린 구간 안쪽이므로 `standingHeight`가
 * 항상 `platform.topY`를 본다 — **전이의 성패가 더 이상 입력 크기의
 * 함수가 아니다**(부동소수 경계에 기대지 않는다, 조정자 지시). 입력의
 * **방향**은 여전히 의미가 있다 — 이 여유를 적용할지 자체는
 * `stepMovement`의 `outcome.vy > 0` 게이트(무입력·하강이면 애초에
 * `stepOntoPlatform`을 호출하지 않는다, F3 가드)가 여전히 결정한다. */
const PLATFORM_ENTRY_MARGIN_M = MOVEMENT.SPEED * TICK_SECONDS

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
 * 설계하지 마라 — 부등식만 단언한다"). x축·z축을 순서대로 독립 적용한다.
 *
 * 각 벽에 대해, 이동 축과 **수직**인 축의 좌표가 벽의 범위 안에 있을 때만
 * 절단한다 — 그렇지 않으면 벽 옆을 스쳐 지나가는 경로까지 막아버린다(위
 * "양성 대조군" 요구). 근접면은 **직전 위치(prevX/prevZ)가 벽의 어느 쪽에
 * 있었는가**로 정한다 — 반대쪽에서 접근하면 반대쪽 면에서 멈춘다.
 *
 * **몸 반경(원장 24af, 사용자 결정 2026-08-06) — 절단 목표점은 벽면
 * 자체가 아니라 `BODY_RADIUS_M`만큼 바깥으로 민 지점이다.** 이 함수는
 * 벽·박스·플랫폼을 구분하지 않는다(호출자 `groundedOutcome`/
 * `airborneOutcome`이 벽과 "이번 틱 차단 대상 박스"를 합쳐서 넘긴다) —
 * 같은 절단 목표점 계산이 세 지오메트리 종류 모두에 자동으로 적용된다.
 * **비교 조건(`prevX <= ...`/`x > ...`)도 반경이 반영된 같은 목표점을
 * 써야 한다** — 그렇지 않으면(원래 벽면 좌표로 조건을 남겨두면) 후보
 * 위치가 목표점을 넘어도 조건이 걸리지 않아 매 틱 목표점을 살짝씩 지나
 * 계속 전진하다가, 원래 벽면 좌표를 넘는 틱에야 뒤늦게 목표점으로
 * 되튕기는 진동이 될 것이다(설계 단계 분석 — 조건-목표점을 처음부터
 * 일치시켰으므로 이 저장소 코드에서 실제로 관측된 적은 없다) — 아래
 * "고착 방지" 분석도 이 조건-목표점 일치를 전제한다.
 *
 * **고착 방지가 이 판정 순서에서 자연히 나온다**: 벽에서 반경만큼 떨어져
 * 멈춘 뒤(`prevX`가 절단 목표점과 같아짐) 반대 방향으로 밀면, 후보 위치가
 * 그 목표점을 다시 넘지 않으므로(반대 방향으로 움직였으니까) 두 조건
 * (`prev` 비교, `next` 비교) 중 하나가 깨져 절단이 걸리지 않는다 —
 * 세계 경계의 `clampToWorldBounds`(상태 비보유 절단)와 달리 이 함수는
 * "다가오는 방향"까지 함께 봐야 하므로 직전 위치가 필요하다.
 *
 * **REV(원장 24ao, 사용자 결정 2026-08-06 연장) — 수직축(스침 여부) 게이트도
 * 같은 반경 목표점을 쓴다.** 24af 최초 구현은 이 게이트(`z > wall.minZ &&
 * z < wall.maxZ` 등)를 원래 벽 경계 그대로 뒀다 — 그 결과 벽 모서리를
 * 반경보다 가깝게 스치면(두 축이 동시에, 또는 게이트가 보는 축 하나가
 * 원래 범위 밖) 게이트가 "이 벽은 관여하지 않는다"고 판정해 절단 자체가
 * 발동하지 않고 몸이 벽 내부로 그대로 지나갔다(독립 평가 O4 실측,
 * `24ao-corner-body-radius-*.test.ts` Red). 게이트를 `near*`(반경만큼
 * 팽창된 AABB, 축별 독립 Minkowski 근사)로 바꾸면 이 스침도 걸린다.
 *
 * **AABB를 사각으로(원이 아니라) 팽창시키는 것은 의도적으로 보수적인
 * 근사다(사용자 승인, 원장 24ao)** — 모서리가 둥글지 않고 각지므로, 정확히
 * 대각으로 접근하면 이론상 `R√2`까지 일찍 막힐 **수 있다.** ⚠️ **실측상 그
 * 초과분은 발생하지 않는다**(원장 24ao 재평가 — 대각 최소거리가 정확히
 * `R`=0.300000이다). 몸이 팽창 모서리에서 멈추지 않고 **팽창 면을 따라
 * 미끄러지기** 때문이다. 아래는 그럼에도 성립하는 **상한**이지 관측값이
 * 아니다 — 최대 `R(√2−1)≈0.1243m` 더 일찍 막힐 수 있고(`24ao-corner-body
 * -radius-walls.test.ts` 명제 3, 상한 `R√2`), "더 통과시키는" 방향이 아니라
 * "더 막는" 방향의 근사 오차라 RQ-61(서버가 더 보수적으로 판정해 몸이 절대
 * 지오메트리에 박히지 않는 쪽)과 양립한다.
 *
 * **한쪽 게이트만 고치면 안 된다(검출력 함정, 원장 24ao Red 보고서 §4-2)**
 * — 이 함수는 x축 절단을 먼저 계산하고 z축 절단이 그 결과를 이어받으므로,
 * 정확히 45° 대각 접근에서는 먼저 평가되는 축의 게이트 하나만 고쳐도
 * 그 축의 절단이 사실상 반대 축까지 막아버려 "대각 케이스만" 보면 완전
 * 수정과 절반 수정이 구분되지 않는다. 두 게이트 모두 `near*`로 바꿔야
 * 한다(아래 구현, 축별 직선 스침 테스트가 게이트별로 개별 검증한다).
 *
 * **REV(원장 24af 이음새 회귀, PR #67 1차 리뷰 blocker) — 실경계(real)
 * 절단을 최후 방어선으로 추가한다.** `near*` 팽창은 **AABB마다 독립**이다
 * — 인접한 두 AABB의 자유 간격이 `2R` 미만이면 팽창 영역이 **겹친다**
 * (프로덕션에는 박스-박스 쌍 24건이 그렇다, `@shared/sim/boxes` 클러스터
 * 내부 간격 0.3m/0.4243m 둘 다 `2R`=0.6m 미만). 절단이 "교차"에서만
 * 발동하는 구조(`prevX <= nearMinX && x > nearMinX` 등)라, **팽창 띠
 * 안쪽에 이미 있는 위치**(예: 인접 박스 쪽으로 걸어 나가 낙하한 뒤 그
 * 자리에 착지한 경우 — 수평 이동이 아니라 수직 낙하로 띠 안에 "도착"하면
 * `prev`가 처음부터 그 띠 안이라 교차 자체가 성립하지 않는다)에서는 그
 * AABB가 차단을 완전히 멈춘다 — 리뷰가 실측한 회귀(박스 안에 박히고,
 * 점프 없이 인접 박스 윗면으로 올라섬)가 정확히 이 경로다.
 *
 * 대응: `near*`(팽창) 절단과 **별개로**, 같은 루프 안에서 **실경계**
 * (`wall.minX`/`wall.maxX`/`wall.minZ`/`wall.maxZ`, 반경 미적용)에 대해
 * **같은 교차 판정을 한 번 더** 적용한다 — 24af 이전(`main`)의 점
 * 클램프와 정확히 같은 식이다. **`near*` 절단이 발동한 틱에 한해, 이
 * 실경계 절단은 무력하다**(`항상`이 아니다 — 전건이 깨지는 경우는 아래
 * §조건 절과 §점프 경로에 있다) — `near*` 절단이
 * 이미 실경계에서 `R`만큼 떨어진 지점(`nearMinX` 등)에서 후보 위치를
 * 멈춰 세우므로, `x`가 결코 실경계(`wall.minX` 등)에 도달하지 못해
 * 실경계 교차 조건(`prevX <= wall.minX && x > wall.minX`)의 `x > wall.minX`
 * 가 성립할 수 없다(아래 §"정상 경로 간극 보존 조건" 참고). ⚠️ 이 무력함은
 * **`near*` 절단이 그 틱에 실제로 발동했을 때만** 성립한다 — 아래 조건 절을
 * 반드시 함께 읽어라. 팽창이 겹쳐 무력해진 이음새에서, 실경계 절단이 몸이 그 AABB의 실제 내부로
 * 넘어가는 것을 막는 마지막 방어선으로 발화한다 — 이때는 `R` 간극을
 * 되살리지 못한다(구조적으로 두 AABB 모두에서 `R` 이상 떨어진 위치가
 * 존재하지 않으므로 애초에 불가능하다, 리뷰 보고서 "수정 (B)" 참고).
 * 실경계 절단이 보장하는 것은 오직 **침투 금지**(거리 0에서 멈춤, `main`과
 * 동일)뿐이다 — "박스 등반은 명시적 점프"(ADR-0013 결과 절)를 지키려면
 * 이 정도로 충분하다: `standingHeight`가 참조하는 실경계를 몸이 넘지
 * 못하면, 그 자리에서 무점프로 다른 박스 윗면에 솟아오르는 경로 자체가
 * 사라진다.
 *
 * **정상 경로 간극 보존 조건**: 고립된 AABB(또는 2R 이상 떨어진 쌍)에서
 * `near*` 절단이 `x`를 `nearMinX`(= `wall.minX − R`)에 붙들어 두는 한,
 * `x ≤ nearMinX < wall.minX`이므로 실경계 절단의 발동 조건
 * `x > wall.minX`가 거짓이다 — 실경계 절단은 아예 평가되지 않는다(같은
 * 루프 반복 안에서 `near*` 절단이 먼저 실행되고 그 결과 `x`를 실경계
 * 절단이 이어받는다).
 *
 * ⚠️ **그 전건이 언제 깨지는지 정확히 적는다**(원장 24at — 초안은 이 절을
 * "증명"이라 불렀고 "이음새에서만 관측 가능"이라 단정했다. **둘 다 거짓이다**).
 * `near*` 절단은 **`prev`가 팽창 띠 밖에 있다가 안으로 넘어올 때만** 발동한다.
 * `prev`가 **이미 띠 안**(`nearMinX < prevX < wall.minX`)이면 발동하지 않고,
 * 그러면 실경계 절단이 이어받아 몸을 **간극 0**(실경계 위)에 세운다 —
 * **고립된 벽·박스에서도** 그렇다. 실측 반례: 고립 벽 `x=14.9`에서 +X로
 * 밀면 최종 `15.000000`, 간극 `0.000000`. 고립 박스도 띠 안 오프셋
 * 0.05~0.29에서 간극 0, 0.31 이상에서 0.300000.
 *
 * **그래서 `R` 간극이 어디까지 보존되는가**(원장 24at — ⚠️ 이 문단의 앞선
 * 두 판본이 모두 실측에 반박됐다. 아래는 전수 스캔 출력이지 추론이 아니다.
 * 8방향 × 3속도 × 50틱, `PRODUCTION_GEOMETRY`. ⚠️ **절대 개수는 적지 않는다**
 * — 표본 정의(출발 격자 간격, "합법 출발점"에 팽창 띠를 포함하는지)에 따라
 * 자릿수가 달라져 재현이 안 된다. 실제로 같은 코드에서 정의만 바꿔 4,124 ·
 * 4,121 · 53,254가 나왔다. 아래는 **정의에 무관한 불변식과 재현 가능한
 * 최소 반례**만 싣는다):
 *
 * - **무점프 경로에서는 완전히 보존된다** — 박스 위반 **0건**, 최소거리
 *   정확히 **0.300000**. 벽도 0건.
 * - **점프 경로에서는 보존되지 않는다** — 대상은 프로덕션 박스 **15개
 *   전부**, 최소거리 **0.000000**. 기전은 이음새가
 *   아니라 **점프 궤적 자체**다: 띠 폭이 `R`=0.3m인데 `run` 한 틱이 0.2m라,
 *   하강 궤적이 `topY`를 지나는 순간 `prev`가 이미 띠 안이어서 `near*`의
 *   교차 전건이 깨진다. 결정론적 최소 반례 —
 *   `(x,z)=(−10, 11.5)`, `y=0`, grounded에서 `{dirX:+1, mode:'run', jump:true}`
 *   유지 → **틱 38**에 `x=−3.000000` 접지, box#13(`x[−3,0] z[11.3,14.3]`,
 *   `topY=0.7`)까지 거리 **0.000000**. 그 `−X`면은 이음새가 아니다.
 * - **벽·플랫폼에서는 점프에서도 0건**이다(최소 `0.300000`, **접지 상태
 *   기준** — 공중 프레임은 `near*`가 아직 관여하지 않으므로 세지 않는다).
 *   일반 규칙은 **점프로 `topY`를 넘을 수 있는 지오메트리만 취약**하다는
 *   것이다 — 넘지 못하면 상승 중에도 차단 목록에 남아 `near*`가 계속
 *   발동하기 때문이다. ⚠️ **기준을 `JUMP_HEIGHT` 단독과 비교하면 안 된다**
 *   (원장 24at, PR #67 7차 리뷰 major — 초안이 그렇게 적어 틀렸다):
 *   `JUMP_HEIGHT`는 **지면 기준 상승분**이지 도달 고도가 아니라서 발판이
 *   있으면 그만큼 더 올라간다. 실측 — box#13(`topY`=0.7) 윗면 제자리 점프의
 *   최고 고도는 **1.697367**이다. 올바른 기준은
 *   `topY > (**그 지오메트리 밖에서** 도달 가능한 최고 지지면) + JUMP_HEIGHT`
 *   이고 이 맵에서는 **1.7**이다. ⚠️ **범위 한정을 빼면 안 된다**(8차 리뷰
 *   minor): 이 맵에서 도달 가능한 최고 지지면은 **플랫폼 윗면 4**이고
 *   (사다리 `maxY`와 같다, GA-62) 그대로 넣으면 임계가 5.0이 되어
 *   **플랫폼 자신이 "취약"으로 분류된다** — 세 줄 뒤 결론과 어긋난다.
 *   합성 반례(`boxA x[0,3] z[0,3] topY 0.7` · `boxB x[5,8] z[0,3] topY 1.2` ·
 *   출발 `(1.3, 0.7, 1.0)`에서 `run`+`jump` 유지): `boxB`가 `JUMP_HEIGHT`를
 *   넘는데도 22스텝에 `x=5.000000`, 간극 **0.000000** — 1.0~1.7 구간을
 *   "면제"로 분류하면 그런 배치를 놓친다. 이 맵의 결론 자체는 그대로다:
 *   플랫폼 `topY`=4 > 1.7, 벽은 무한 높이라 **구조적 면제**이고, 박스는
 *   최대 `topY`=0.7이라 전부 취약하다. `eyeHeightM`=1.7 > 박스 최대 `topY`=0.7이므로
 *   24af 원 증상(카메라가 면에 놓여 내부가 보인다)은 박스에서 재발하지 않는다.
 *
 * ⚠️ 즉 **점프 경로의 간극 0은 미래 위험이 아니라 현재 상태다.** 이 델타가
 * 만든 회귀는 아니지만(`ae609d6`에도 있었다) 계약이 정해지지 않았다 —
 * 간극 0을 수용할지, `near*`를 침투 해소로 바꿀지가 먼저다(원장 24at). */
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
    // 반경만큼 바깥으로 민 절단 목표점 — 이 벽(또는 벽으로 합류한
    // 박스·플랫폼)에 대해서만 유효하므로 루프 안에서 매번 계산한다.
    // 절단 목표점(위)과 아래 두 게이트(모서리 스침 판정, 원장 24ao)가
    // 같은 네 값을 공유한다 — 사각 Minkowski 팽창 하나로 목표점 계산과
    // "이 벽이 관여하는가" 판정을 동시에 반영한다.
    const nearMinX = wall.minX - BODY_RADIUS_M
    const nearMaxX = wall.maxX + BODY_RADIUS_M
    const nearMinZ = wall.minZ - BODY_RADIUS_M
    const nearMaxZ = wall.maxZ + BODY_RADIUS_M

    // x축 이동 절단(near) — z(수직축)가 팽창된 벽의 z범위 안에 있어야
    // ("스쳐 지나감"이 아니라 실제로 벽면(반경 포함)과 마주친다) 충돌로
    // 본다(원장 24ao REV — 원래는 팽창 전 `wall.minZ`/`wall.maxZ`를 썼다).
    if (z > nearMinZ && z < nearMaxZ) {
      if (prevX <= nearMinX && x > nearMinX) {
        x = nearMinX
      } else if (prevX >= nearMaxX && x < nearMaxX) {
        x = nearMaxX
      }
    }

    // z축 이동 절단(near) — x(수직축)가 팽창된 벽의 x범위 안에 있어야
    // 충돌. 위에서 x가 이미 절단됐을 수 있으므로 절단된 x로 재평가한다
    // (원장 24ao REV — 게이트도 팽창된 범위를 쓴다).
    if (x > nearMinX && x < nearMaxX) {
      if (prevZ <= nearMinZ && z > nearMinZ) {
        z = nearMinZ
      } else if (prevZ >= nearMaxZ && z < nearMaxZ) {
        z = nearMaxZ
      }
    }

    // x축 이동 절단(실경계, 원장 24af 이음새 회귀 수정 — 위 docblock REV
    // 절 참고) — near가 발동하지 못한 틱에 발화하는 최후 방어선
    // (팽창 띠 안에서 출발했거나 팽창이 겹친 이음새 — 점프 하강 궤적이
    // 대표적이다). 이때 보장하는 것은 침투 금지뿐이고 R 간극은 되살아나지
    // 않는다. near가 발동한 틱에는 교차 조건이 성립하지 않아 무력하다.
    if (z > wall.minZ && z < wall.maxZ) {
      if (prevX <= wall.minX && x > wall.minX) {
        x = wall.minX
      } else if (prevX >= wall.maxX && x < wall.maxX) {
        x = wall.maxX
      }
    }

    // z축 이동 절단(실경계) — 위와 동일한 최후 방어선.
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
 * 구간, 예: `x > box.minX && x < box.maxX`, 원장 24af/24ao 이후에는
 * 반경만큼 팽창된 `nearMinX`/`nearMaxX`)과 동일하게 **개방 구간**을 쓴다
 * — 근접면(반경 적용 전이든 후든)에 막혀 정확히 그 경계에 멈춘 플레이어는
 * 아직 "박스 안"이 아니므로 지지 높이가 오르지 않는다(질문1 회신에서
 * 명시적으로 배제한 대안 (b) "차단 없이 걸어 들어가 y가 솟아오른다"와
 * 결과가 갈리는 지점 — "걸어서 접근" 테스트가 이 경계를 고정한다).
 * **이 함수 자신(`standingHeight`)은 반경을 반영하지 않는다** — 위
 * `x > box.minX && x < box.maxX`는 이 함수의 실제 판정식(변경 없음)이고,
 * `clampAgainstWalls`의 개방 구간 관례를 비유로 든 것뿐이다. */
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

/** RQ-33 — 사다리의 등반 법선이 가리키는 방향에서, 사다리와 간격 0으로
 * 접하는(근접면 좌표 일치) 플랫폼을 찾는다. GA-61 설계상 사다리와
 * 플랫폼은 **경계만 접하고 겹치지 않는다**(둘 다 개방 구간 관례를
 * 쓰므로, 사다리 안에 고정된 x·z는 결코 플랫폼의 "안"에 들지 않는다 —
 * `stepOntoPlatform`이 경계를 넘겨줘야 하는 이유, 아래). 축 정렬 법선
 * (`normalX`·`normalZ` 중 하나만 ±1)만 지원한다 — 프로덕션 사다리가
 * 전부 이 형태다(`tests/unit/rq-33-platform-geometry.test.ts`의
 * `findAdjacentPlatform` 헬퍼와 동일한 판정, 독립 재구현 — 그 파일은
 * 순수 데이터 검증용이라 이 함수를 참조하지 않는다). */
function findAdjacentPlatform(ladder: LadderVolume, platforms: readonly BoxAABB[]): BoxAABB | undefined {
  return platforms.find((platform) => {
    if (ladder.normalX > 0) {
      return (
        Math.abs(ladder.maxX - platform.minX) < LADDER_Y_EPSILON_M &&
        ladder.minZ >= platform.minZ - LADDER_Y_EPSILON_M &&
        ladder.maxZ <= platform.maxZ + LADDER_Y_EPSILON_M
      )
    }
    if (ladder.normalX < 0) {
      return (
        Math.abs(ladder.minX - platform.maxX) < LADDER_Y_EPSILON_M &&
        ladder.minZ >= platform.minZ - LADDER_Y_EPSILON_M &&
        ladder.maxZ <= platform.maxZ + LADDER_Y_EPSILON_M
      )
    }
    if (ladder.normalZ > 0) {
      return (
        Math.abs(ladder.maxZ - platform.minZ) < LADDER_Y_EPSILON_M &&
        ladder.minX >= platform.minX - LADDER_Y_EPSILON_M &&
        ladder.maxX <= platform.maxX + LADDER_Y_EPSILON_M
      )
    }
    if (ladder.normalZ < 0) {
      return (
        Math.abs(ladder.minZ - platform.maxZ) < LADDER_Y_EPSILON_M &&
        ladder.minX >= platform.minX - LADDER_Y_EPSILON_M &&
        ladder.maxX <= platform.maxX + LADDER_Y_EPSILON_M
      )
    }
    return false
  })
}

/** RQ-33(GA-59) — 사다리 꼭대기를 넘어 인접 플랫폼 위로 "옆걸음"한다.
 * RQ-21 v1.4 "볼륨을 벗어나면 즉시 중력이 복귀한다"를 우회하는 특례가
 * 아니다 — **정확히 그 문장이 요구하는 대로** 사다리 전용 물리(중력
 * 미적용·수직 전용)를 끄고 표준 접지 물리(`groundedOutcome`, 중력이
 * 지배하는 세계에서 발밑에 지지면이 있으면 그 위에 선다)로 넘길 뿐이다.
 *
 * **진입 위치는 `PLATFORM_ENTRY_MARGIN_M`만큼 플랫폼 안쪽으로 미리
 * 밀어 넣는다 — 입력 크기와 무관하게 만들기 위해서다(독립 평가 FAIL
 * F1 수정, 위 `PLATFORM_ENTRY_MARGIN_M` 코멘트가 결함·수정 근거 전문).**
 * 법선 축(예 `normalX>0`이면 `x`)은 사다리 근접면(`ladder.maxX`, GA-61
 * 설계상 `platform.minX`와 같다)에서 그 여유만큼 **더 나아간**
 * 좌표 — `platform.minX + margin`이 아니라 `ladder.maxX + margin`으로
 * 쓰는 것은 둘이 같은 값(GA-61)이라 결과가 같으면서도 "사다리 근접면
 * 기준"이라는 의미를 그대로 유지하기 위해서다. 이 여유는 플랫폼 폭의
 * 절반을 넘지 않도록(`spanAlongNormal / 2`) 한 번 더 죄어 — 어떤 폭의
 * 플랫폼에도 항상 열린 구간 **안쪽**에 떨어짐을 보장한다(플랫폼 폭이
 * 여유보다 좁은 극단적 데이터가 미래에 생겨도 반대쪽 경계를 넘어가지
 * 않는다). 법선과 **수직**인 축(예 `normalX>0`이면 `z`)은 `state.z`
 * (사다리 진입 이후 줄곧 고정돼 온 실제 좌표)를 그대로 쓴다 — GA-63
 * (사다리 폭이 플랫폼 대응 축 범위에 좌우 여백을 남기고 완전히
 * 포함됨)이 보장하는 대로, 사다리 볼륨 안 어떤 z든 플랫폼의 z 개방
 * 구간에 이미 들어 있다.
 *
 * 이렇게 **이미 플랫폼 안쪽에 도달한 위치**에서, 이번 틱의 실제 입력
 * (`groundVelocity(input)`)으로 `groundedOutcome`을 호출한다 — 입력이
 * 아무리 작아도(심지어 부동소수점 상 이동량이 0으로 뭉개져도) 시작
 * 위치 자체가 이미 플랫폼의 열린 구간 안쪽이므로 `standingHeight`가
 * 언제나 `platform.topY`를 본다. 입력의 **방향**은 여전히 의미가
 * 있다 — 얼마나 더 안쪽으로 걸어 들어가는지, 그리고 이 함수를 호출할지
 * 자체(`stepMovement`의 `outcome.vy > 0` 게이트, F3 가드)는 그대로
 * 입력에 좌우된다. 새 위치 계산 로직을 발명하지 않고 `groundedOutcome`을
 * 그대로 재사용한다는 원래 설계는 유지했다. */
function stepOntoPlatform(
  state: MoveState,
  input: MoveInput,
  ladder: LadderVolume,
  platform: BoxAABB,
  walls: readonly WallAABB[],
  boxes: readonly BoxAABB[],
): MoveState {
  const spanAlongNormal = ladder.normalX !== 0 ? platform.maxX - platform.minX : platform.maxZ - platform.minZ
  const entryMargin = Math.min(PLATFORM_ENTRY_MARGIN_M, spanAlongNormal / 2)
  const boundaryX = ladder.normalX > 0 ? ladder.maxX + entryMargin : ladder.normalX < 0 ? ladder.minX - entryMargin : state.x
  const boundaryZ = ladder.normalZ > 0 ? ladder.maxZ + entryMargin : ladder.normalZ < 0 ? ladder.minZ - entryMargin : state.z
  const boundaryState: MoveState = { x: boundaryX, y: platform.topY, z: boundaryZ, vx: 0, vy: 0, vz: 0, grounded: true }
  const { vx, vz } = groundVelocity(input)
  return groundedOutcome(boundaryState, vx, vz, walls, boxes)
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
 * 다음 틱에 다시 붙잡혀 재상승하는 4↔0 무한 순환(요요)이 됐다.
 *
 * **RQ-33(GA-59) — 사다리 꼭대기 → 인접 플랫폼 옆걸음 전이.** 이번 틱
 * 사다리 결과가 **상승 방향으로**(`outcome.vy > 0`) 꼭대기에 닿거나
 * 넘어서면(`outcome.y >= ladder.maxY - LADDER_Y_EPSILON_M`), 등반 법선이
 * 가리키는 방향에 간격 0으로 접한 플랫폼이 있는지 먼저 찾는다
 * (`findAdjacentPlatform`, `geometry.platforms`). 있으면 `stepOntoPlatform`
 * 으로 그 위에 옆걸음해 올라선다. **없으면**(예: `geometry.platforms`가
 * 비었거나 그 방향에 접한 플랫폼이 없는 합성 사다리) 아래로 흘러 기존
 * F1 수정 그대로 자유낙하로 전이한다 — `tests/unit/sim-movement-ladders
 * .test.ts`의 "F1(합성, RQ-33 이후)" describe(`SYNTHETIC_LADDER_NO_PLATFORM`
 * + `EMPTY_GEOMETRY`, `geometry.platforms`가 `undefined`)가 이 폴백을
 * 직접 고정한다 — **전이는 인접 플랫폼이 실제로 있을 때만 발화**하고,
 * 없는 사다리에서는 요요 없는 낙하가 그대로 유지된다.
 *
 * **이 검사를 `isWithinLadderY`(폐구간 — "정확히 maxY에서도 여전히
 * 사다리 물리가 적용된다") 판정보다 먼저 두는 이유(실측 회귀 — coder,
 * `_workspace/RQ-33/04_coder_green-ga59.md` §3 참고)**: 처음에는
 * `isWithinLadderY`가 참이면 그대로 반환하고, "볼륨을 완전히 벗어난"
 * 경우에만(즉 `LADDER_Y_EPSILON_M`을 넘어선 진짜 초과) 플랫폼을 찾도록
 * 짰다 — 그러자 부동소수점 누적으로 `outcome.y`가 `maxY`를
 * `LADDER_Y_EPSILON_M` 이내로 살짝 넘긴 바로 그 1틱(~33ms)에서는
 * "아직 폐구간 안"으로 판정돼 `x`가 사다리 자신의 좌표(플랫폼 밖)에
 * 머문 사다리 결과를 그대로 반환했다 — 시뮬레이션 자체는 결정론적이지만,
 * `rq-33-platform-reach.test.ts`(실 서버, 실시간 폴링)의 "플랫폼 도달"
 * 대기 조건(`grounded && y ≥ topY-ε`)이 이 찰나의 틱을 실제로 관측할
 * 수 있어(`npm run check`처럼 시스템 부하가 커 폴링 타이밍이 벌어지면
 * 더 잘 걸린다 — 격리 실행에서는 우연히 피해가 재현 확률이 낮았다)
 * `onPlatform.x`가 플랫폼 범위 밖으로 관측되는 산발적 실패가 재현됐다.
 * 상승 중 `maxY`(오차 이내 포함)에 닿는 순간 곧바로 플랫폼 여부부터
 * 확인하면 이 중간 관측 가능 상태 자체가 없어진다 — `outcome.vy > 0`
 * 게이트 덕분에 무입력·하강 중 정확히 `maxY`에서는(플랫폼 유무와
 * 무관) 기존 "여전히 사다리 물리" 동작이 그대로 유지된다(아래
 * `isWithinLadderY`가 여전히 그 경로를 담당). */
export function stepMovement(state: MoveState, input: MoveInput, geometry: StaticGeometry = EMPTY_GEOMETRY): MoveState {
  // RQ-33 — 플랫폼(있으면)을 이번 틱 지지/차단 판정에 합류시킨다.
  // `geometry.boxes` 자체(참조)는 건드리지 않는다 — `PRODUCTION_GEOMETRY
  // .boxes`가 `PRODUCTION_BOXES`와 참조 동일해야 하는 계약(위
  // `StaticGeometry.platforms` 코멘트) 때문에 합치는 지점을 호출 시점
  // (여기)으로 미룬다. `standingHeight`/`boxesBlockingAt` 자체는 변경
  // 없음 — 여전히 임의의 `BoxAABB[]`를 받는다.
  const platforms = geometry.platforms ?? []
  const boxes = platforms.length > 0 ? [...geometry.boxes, ...platforms] : geometry.boxes
  const ladder = state.grounded ? findLadderAt(state.x, state.y, state.z, geometry.ladders) : undefined
  if (ladder) {
    const outcome = ladderOutcome(state, input, ladder)
    // RQ-33(GA-59) — 상승 중 꼭대기(오차 이내 포함)에 닿으면, "폐구간이라
    // 아직 사다리 안"이라는 아래 `isWithinLadderY` 허용보다 먼저 플랫폼
    // 전이를 시도한다 — 위 docblock "이 검사를 먼저 두는 이유" 참고
    // (관측 가능한 중간 상태 제거가 목적).
    if (outcome.vy > 0 && outcome.y >= ladder.maxY - LADDER_Y_EPSILON_M) {
      const platform = findAdjacentPlatform(ladder, platforms)
      if (platform) {
        return stepOntoPlatform(state, input, ladder, platform, geometry.walls, boxes)
      }
    }
    if (isWithinLadderY(outcome.y, ladder)) {
      return outcome
    }
    // 이번 틱에 사다리 볼륨을 벗어난다. 상승 방향이었다면 위에서 이미
    // 플랫폼 전이를 시도했고 실패했다는 뜻이다(인접 플랫폼 없음) — 이
    // 지점은 하강 방향 이탈(바닥 아래) 또는 플랫폼 없는 상승 이탈만
    // 도달한다.
    const support = standingHeight(state.x, state.z, boxes)
    if (support < state.y) {
      // 지지면이 없다 — 이탈 순간의 사다리 수직 속도(outcome.vy)를 낙하
      // 궤적의 초기 속도로 인계한다. jumpElapsedSeconds는 stepAirborne이
      // 이미 쓰는 기존 기법(임의의 vy를 표준 점프 곡선 위의 한 순간으로
      // 재해석)을 그대로 재사용한다 — 새 궤적 모델을 발명하지 않는다.
      // 수평 속도는 0(사다리는 수평 관성을 만들지 않는다, `ladderOutcome`
      // 코멘트 참고).
      const tPrev = jumpElapsedSeconds(outcome.vy)
      return airborneOutcome(state, 0, 0, tPrev, geometry.walls, boxes)
    }
    // 지지면이 있다(발판 등) — 원래 위치(`state`, 사다리 판정에 쓰인
    // 시작점) 기준으로 접지/공중 물리를 그대로 적용해 그 높이로 전환한다.
    // `outcome`의 초과된 y는 쓰지 않는다.
  }
  return state.grounded
    ? stepGrounded(state, input, geometry.walls, boxes)
    : stepAirborne(state, geometry.walls, boxes)
}
