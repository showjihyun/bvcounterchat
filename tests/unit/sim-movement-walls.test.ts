import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveInput, type MoveState, type WallAABB } from '@shared/sim/movement'
import { MOVEMENT, NET } from '@shared/constants'
import { PRODUCTION_WALLS, WALL_EAST as PRODUCTION_WALL_EAST } from '@shared/sim/walls'

/**
 * RQ-30 벽 충돌 — 정적 지오메트리를 데이터로, 순수 함수가 주입받아 판정
 * (원장 25a-2, ADR-0013 결정 1~3, 원장 26o 인터페이스 미결 해소).
 *
 * ⚠️ **잠정 스캐폴드다 — 확정 맵 레이아웃이 아니다.** RQ-30(`harness/specs
 * /requirements.md:107-110`)의 "레이아웃은 독자 설계"는 `.glb` 저작(사람·
 * 아티스트)에서 정해진다. 이 파일이 정의하는 벽 4개(`WALL_EAST/WEST/NORTH
 * /SOUTH`)는 **주입 계약(injection contract) 자체를 검증하기 위한 것**이지
 * 실제 게임 맵의 벽 배치가 아니다 — 다음 사람이 이 좌표를 "확정 배치"로
 * 읽으면 안 된다. `.glb`가 도입되면 벽 데이터의 **출처만** 교체된다(이
 * 파일이 고정하는 것은 "순수 함수가 축 정렬 상자 목록을 주입받아 이동을
 * 판정한다"는 계약 형태이지 좌표 자체가 아니다).
 *
 * **레벨 선택(ADR-0008)**: 벽 충돌 산술은 이동 계산과 동일하게 순수
 * 로직이다("탄도·데미지·이동·낙하 계산 등 순수 로직 → 단위 →
 * `tests/unit/`", `harness/workflow/tdd.md` 참고 표). GA-50(RQ-30 월드
 * 경계)이 통합 레벨이었던 것은 그 골든의 `verify` 필드가 통합 경로를
 * 명시적으로 지정했기 때문이다(`rq-30-play-area-bounds.test.ts` 상단
 * 참고) — 이 파일이 작성될 당시에는 벽 충돌을 덮는 골든이 없어 기본
 * 규칙(순수 로직 → 단위)으로 되돌아갔다. 이후 독립 평가의 권고로
 * **GA-57**(접지·공중 모두 벽 통과 금지)이 신설됐고 그 `verify`가 이
 * 파일과 `rq-30-wall-collision-wiring.test.ts`를 함께 지정한다. `stepMovement`를
 * 직접 호출해 벽 주입 계약을 검증하는 것이 "서버가 확정하는 위치"라는
 * 관측 대상과도 어긋나지 않는다 — `GameRoom.stepPlayerMovement`가 이
 * 함수를 그대로 호출해 그 반환값을 공개 스키마(`player.x/y/z`)에 쓰기
 * 때문에(`src/server/rooms/GameRoom.ts:1068-1072` 실측), 이 함수의 계약을
 * 지키는 것이 곧 서버 확정 위치의 계약을 지키는 것이다.
 *
 * **주입 형태 결정(원장 26o 미결 해소 — ADR-0013 결정 2 "질의는 주입된
 * 함수로 받는다(시드·틱을 주입하는 것과 같은 형태)")**: 팀리드 지시 원문
 * ("벽을 **데이터**(축 정렬 상자 목록)로 정의하고 **순수 함수가 그것을
 * 주입받아** 이동을 판정한다")은 "질의 함수" 형태와 "벽 목록 데이터" 형태
 * 둘 다 열어 뒀다. 이 라운드는 **벽 목록 데이터**를 택한다 — 이유:
 * ① 이번 스캐폴드에는 Rapier가 전혀 필요 없다(축 정렬 상자 vs 점 판정은
 *   순수 산술로 충분하다) — 아직 쓰이지 않는 질의 함수 추상화를 미리
 *   만드는 것은 YAGNI 위반이다(CLAUDE.md 스코프 규율).
 * ② "주입 형태"라는 핵심 요구(`src/shared`가 파일·전역·환경에서 벽을 읽지
 *   않는다, ADR-0010 환경 중립)는 데이터 배열을 인자로 받는 것만으로도
 *   완전히 충족된다 — 함수로 감싸야만 성립하는 요구가 아니다.
 * ③ Rapier를 실제로 붙이는 결정(26o의 "KCC를 질의 제공자로 쓸 것인가")은
 *   **여전히 미결**로 남겨 둔다 — 그때 Rapier 어댑터가 이 벽 목록과 같은
 *   모양의 데이터를 만들어 넘기거나, `stepMovement`에 새 오버로드/질의
 *   콜백을 추가하는 선택지가 둘 다 열려 있다(이 계약이 그 선택을 막지
 *   않는다 — 기본값 호환이 그대로 유지되는 한 시그니처에 인자를 더 얹는
 *   것은 항상 가능하다).
 *
 * **가정(coder에게 — 이 shape으로 구현할 것. `movement.ts`의 기존
 * `stepMovement(state, input)` 2-인자 계약을 확장한다)**:
 *
 * ```ts
 * export interface WallAABB {
 *   minX: number; maxX: number
 *   minZ: number; maxZ: number
 * }
 * export function stepMovement(
 *   state: MoveState,
 *   input: MoveInput,
 *   walls?: readonly WallAABB[],  // 기본값 [] — 생략 시 벽 없음(기존 동작)
 * ): MoveState
 * ```
 *
 * **2D(XZ) 전용 — 높이(Y) 필드 없음, 의도적 스코프 제한**: `WallAABB`는
 * 상하 경계(`minY`/`maxY`)를 갖지 않는다 — 개념상 "벽"(무한 높이 기둥)과
 * 등반 가능한 "박스"(RQ-32, 유한 높이)를 구분하는 이 프로젝트의 기존
 * 어휘(ADR-0013 결과 절 "RQ-22 완화는 박스에만 적용되고 RQ-30(지형)에는
 * 적용되지 않는다")를 따른 것이다. **공중(점프) 상태에서 벽과의 상호작용은
 * 이 라운드가 다루지 않는다** — 팀리드가 지시한 커버리지 목록(정면 차단·
 * 고착 금지·양성 대조·20k·기본값 회귀) 어디에도 y·점프가 없고, RQ-30/32
 * 어디에도 벽 높이나 "뛰어넘기 가부"를 규정하는 문장이 없다(추측 금지
 * 원칙 — 있지도 않은 요구를 시험하면 스코프 크리프다, `requirements.md`
 * §11). **이것은 원장 25a-1의 "공중 경로 그물" 사례와 다르다** — 그
 * 사례는 세계 경계(모든 상태에서 항상 성립해야 하는 기존 불변식)의
 * 커버리지 공백이었지만, 벽-점프 상호작용은 애초에 이 라운드가 확정하는
 * 요구사항 자체에 없다. 벽을 뛰어넘을 수 있는가는 `.glb` 확정 높이가
 * 정해지는 다음 라운드의 결정 사항으로 남긴다(신규 이월 항목 후보 —
 * 보고서 참고).
 *
 * **"미끄러지는가 멈추는가"는 못박지 않는다(팀리드 지시 — 원장 25a-1
 * 경계 클램프의 선례를 따른다)**: 아래 단언은 전부 부등식이다 —
 * "근접면을 넘지 않는다"(통과 금지)와 "출발점에 얼어붙지 않고 실제로
 * 벽까지 밀렸다"(고착 아님)만 확인하고, 정확한 정지 좌표는 요구하지
 * 않는다. `movement.ts`의 기존 `clampToWorldBounds`(하드 클램프, 상태
 * 비보유)와 같은 전략이어도, 슬라이드·반발이어도 이 테스트는 통과해야
 * 한다 — 구현 방식을 규정하지 않는다.
 *
 * **플레이어 반지름(히트박스) 처리 여부도 못박지 않는다**: `DEFAULT_HITBOX
 * .bodyRadiusM`(0.3m, `@shared/config/combat-tuning`)만큼 벽을 부풀려
 * 정지시키는 구현과, 플레이어를 점으로 취급해 벽의 근접면 정확히 그
 * 지점에서 정지시키는 구현 둘 다 통과하도록 근접 여유(`WALL_APPROACH
 * _MARGIN_M`=2m ≫ 0.3m)를 넉넉히 잡았다 — 어느 쪽을 고르든 아래 단언
 * (근접면을 넘지 않음 + 근접면 2m 이내까지 접근)이 성립한다.
 *
 * **결정론(ADR-0008)**: 순수 산술이라 `Math.random()`·`Date.now()`·실
 * 타이머가 전혀 필요 없다 — 이 성질은 `sim-movement.test.ts`의 "RQ-20:
 * 순수 함수는 결정론적이다" 테스트가 이미 확인했고, 벽 주입이 새 난수·
 * 시간 의존을 들여오지 않는다는 것은 이 파일의 모든 테스트가 완전히
 * 재현 가능한 정수 틱 반복이라는 사실 자체로 증명된다(추가 결정론
 * 테스트를 중복으로 넣지 않는다).
 *
 * **20k(GA-15 "벽 반대편" 문자 그대로 재현) — 중복 확인 결과: 새 테스트를
 * 쓰지 않는다.** `src/server/rooms/GameRoom.ts:66-74`의 `sanitizeMoveInput`
 * 은 `'move'` payload에서 `dirX`·`dirZ`·`mode`·`jump`만 뽑고, 같은 payload에
 * `x`·`y`·`z`가 실려 있어도 그 필드를 읽는 코드 경로가 아예 없다(같은 파일
 * 1068행 `stepMovement(previous, input)`의 `input`이 바로 이 4필드 객체다).
 * 이 라운드는 `stepMovement`에 **세 번째 인자(walls)만** 추가할 뿐,
 * `sanitizeMoveInput`이나 `'move'` 핸들러의 필드 화이트리스트는 전혀
 * 건드리지 않는다 — 즉 클라이언트가 절대 좌표를 참칭하는 경로 자체가
 * 벽의 존재 여부와 **완전히 무관**하다(참칭 좌표가 "벽 반대편"이든 임의의
 * 맵 안 좌표든 서버는 애초에 그 필드를 읽지 않으므로 결과가 같다).
 * `tests/integration/rq-61-server-authoritative-position.test.ts`의
 * `IN_MAP_SPOOF`({x:12.5, y:1.5, z:-12.5}) 케이스가 이미 "정지 입력 +
 * 맵 안 참칭 좌표 → 서버 시뮬레이션 결과(정지 상태)만 유지"를 두
 * 관측 지점((a) 서버 자체 상태 (b) 다른 플레이어 시야) 모두에서 정확히
 * 단언한다 — 벽이 생겨도 이 메커니즘이 관측하는 코드 경로는 한 글자도
 * 바뀌지 않으므로 새 좌표를 "벽 반대편"으로 고른 케이스를 추가해도 이미
 * 검증된 것 이상을 검증하지 못한다(순수한 중복). 상세 근거는
 * `_workspace/RQ-30-walls/01_test-writer_red.md` §20k를 참고.
 *
 * **회귀 안전 좌표(팀리드 지시 — 기존 테스트 42종 좌표와 겹치지 않는
 * 대역에 벽을 둔다)**: 이 파일은 `stepMovement`를 직접 호출하는 **단위
 * 테스트**라 다른 파일과 상태를 공유하지 않으므로 엄밀히는 좌표 충돌
 * 위험이 없다(각 `it()`이 자기 완결적 로컬 상태만 다룬다). 그럼에도
 * 팀리드가 요청한 계산을 이 파일의 좌표에 **그대로 반영**한다 — 이유는
 * coder가 서버 기본 배선(`GameRoom.stepPlayerMovement`)에 실제 프로덕션
 * 벽을 상시 주입하게 될 것이므로(그래야 벽이 실제로 서버에서 관측된다),
 * 그 순간 기존 통합 테스트 45개 파일이 같은 좌표 대역의 영향을 받는다 —
 * 이 파일의 벽 좌표를 그 프로덕션 배치의 **후보**로 그대로 제안한다(계산
 * 근거는 보고서 §회귀 안전 좌표). 원점 부근 대역(|x|,|z|≤12, 기존 테스트
 * 다수 사용)·스폰 링(r≈22)·탈출 지점(r≈28) 어디와도 겹치지 않는 반경
 * 15.8~16.76m 대역에 4개 벽을 뒀다.
 */

/** 이번 라운드의 잠정 벽 4개 — 각각 한 방향(±X/±Z)의 정면 차단을 검증하는
 * 스캐폴드다(위 docblock "회귀 안전 좌표" 참고). 두께 1m, 폭 10m(±5m). */
const WALL_EAST: WallAABB = { minX: 15, maxX: 16, minZ: -5, maxZ: 5 }
const WALL_WEST: WallAABB = { minX: -16, maxX: -15, minZ: -5, maxZ: 5 }
const WALL_NORTH: WallAABB = { minX: -5, maxX: 5, minZ: 15, maxZ: 16 }
const WALL_SOUTH: WallAABB = { minX: -5, maxX: 5, minZ: -16, maxZ: -15 }
const TEST_WALLS: readonly WallAABB[] = [WALL_EAST, WALL_WEST, WALL_NORTH, WALL_SOUTH]

/** 부동소수점 누적 오차 허용치 — 100틱 가산 후에도 1e-6 안이면 충분히
 * 엄격하다(`rq-30-play-area-bounds.test.ts`의 `BOUNDARY_TOLERANCE_M`과
 * 동일 값·동일 근거). */
const WALL_TOLERANCE_M = 1e-6
/** "출발점에 얼어붙지 않고 실제로 벽까지 밀렸다"는 것을 확인하는 여유
 * (근접면에서 이 거리 이내까지는 접근해야 한다) — 히트박스 반지름
 * (0.3m)보다 훨씬 넉넉해 반지름 처리 여부와 무관하게 통과한다(위 docblock
 * "플레이어 반지름" 절 참고). `rq-30-play-area-bounds.test.ts`가 세계
 * 경계에 같은 목적으로 쓴 여유(2m)와 동일 값. */
const WALL_APPROACH_MARGIN_M = 2

function createGroundedState(overrides: Partial<MoveState> = {}): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, ...overrides }
}

/** input을 유지한 채 n틱 전진 — 매 틱 `walls`를 그대로 주입한다(신규
 * 3-인자 계약). `sim-movement.test.ts`의 동명 헬퍼와 달리 `walls`를 받는
 * 별도 함수다(파일마다 자기 완결 복제, 저장소 관례 — RQ-61 통합 테스트의
 * `aimAtBody` 선례와 동일). */
function runTicks(input: MoveInput, ticks: number, initial: MoveState, walls: readonly WallAABB[]): MoveState {
  let state = initial
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(state, input, walls)
  }
  return state
}

/** 기존 45개 호출부(`GameRoom.ts:1068`, `sim-movement.test.ts` 등)와
 * 정확히 동일한 **2-인자 형태** — `walls` 인자 자체를 넘기지 않는다.
 * "기본값 호환" 회귀 가드가 이 함수를 통해 신규 계약이 옛 호출 형태를
 * 깨지 않는지 직접 확인한다. */
function runTicksLegacyTwoArgs(input: MoveInput, ticks: number, initial: MoveState): MoveState {
  let state = initial
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(state, input) // 3번째 인자 없음 — 기존 시그니처 그대로
  }
  return state
}

/** N틱 유지 이동 시 이론적 총 변위(m) — `sim-movement.test.ts`의 동명
 * 헬퍼와 동일 산식·동일 근거(오차 무시 가능 수준, 그 파일 코멘트 참고). */
function expectedDistance(speed: number, ticks: number): number {
  return speed * ((ticks * NET.TICK_MS) / 1000)
}

/** GA-30(`sim-movement.test.ts`)과 동일 스케일 — 100틱 동안 유지 이동하면
 * 이론상 20m(SPEED 6m/s × ≈3.33s) 전진해, 15~16m 대역의 벽을 막지 않으면
 * 훌쩍 넘어선다(Red 신호가 여유 없이 묻히지 않는다). */
const TICKS = 100

describe('RQ-30 벽 충돌 — 정적 지오메트리 주입 계약 (ADR-0013, 원장 25a-2/26o, 골든 신설 없음)', () => {
  describe('정면 차단 — 벽을 향해 지속 이동해도 서버 확정 위치가 벽을 통과하지 않는다(4방향)', () => {
    interface FrontBlockCase {
      label: string
      input: MoveInput
      /** 이동 축의 좌표를 상태에서 뽑는다(x 또는 z). */
      axisCoord: (s: MoveState) => number
      /** 벽의 근접면(진행 방향 기준 플레이어와 마주하는 면) 좌표. */
      nearFace: number
      /** 진행 방향 부호 — 양수/음수 두 방향을 같은 부등식으로 다루기 위한
       * 정규화 계수(부호를 곱하면 "근접면을 넘지 않았다"가 항상 `<=`
       * 형태의 단일 부등식이 된다). */
      sign: 1 | -1
    }

    const CASES: FrontBlockCase[] = [
      { label: '+X(동)', input: { dirX: 1, dirZ: 0, mode: 'run', jump: false }, axisCoord: (s) => s.x, nearFace: WALL_EAST.minX, sign: 1 },
      { label: '-X(서)', input: { dirX: -1, dirZ: 0, mode: 'run', jump: false }, axisCoord: (s) => s.x, nearFace: WALL_WEST.maxX, sign: -1 },
      { label: '+Z(북)', input: { dirX: 0, dirZ: 1, mode: 'run', jump: false }, axisCoord: (s) => s.z, nearFace: WALL_NORTH.minZ, sign: 1 },
      { label: '-Z(남)', input: { dirX: 0, dirZ: -1, mode: 'run', jump: false }, axisCoord: (s) => s.z, nearFace: WALL_SOUTH.maxZ, sign: -1 },
    ]

    it.each(CASES)(
      'RQ-30: 벽($label) 방향으로 지속 이동 입력을 줘도(100틱) 서버 확정 위치가 벽을 통과하지 않는다',
      ({ input, axisCoord, nearFace, sign }) => {
        const state = runTicks(input, TICKS, createGroundedState(), TEST_WALLS)
        const signedCoord = sign * axisCoord(state)
        const signedNearFace = sign * nearFace

        // 통과 금지 — 근접면을 넘지 않았다(부동소수 오차만 허용).
        expect(signedCoord).toBeLessThanOrEqual(signedNearFace + WALL_TOLERANCE_M)
        // 고착이 아니라 실제로 벽까지 밀렸다 — 출발점(0)에 얼어붙은 구현이면
        // 이 하한을 만족하지 못한다(근접면 2m 이내까지는 접근해야 한다).
        expect(signedCoord).toBeGreaterThan(signedNearFace - WALL_APPROACH_MARGIN_M)
        // 실제로 진행 방향으로 전진했다(0에서 못박힌 것이 아니다).
        expect(signedCoord).toBeGreaterThan(0)
      },
    )
  })

  it(
    'RQ-30 고착 금지: 벽(+X)에 닿아 멈춘 뒤 반대 방향(-X) 입력은 정상 반영되어 위치가 벽에서 멀어진다',
    () => {
      const towardWall: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
      const atWall = runTicks(towardWall, TICKS, createGroundedState(), TEST_WALLS)
      // 전제 확인 — 실제로 벽 근접면 근처까지 밀렸어야 다음 단계("멈춘
      // 뒤")가 의미를 갖는다.
      expect(atWall.x).toBeLessThanOrEqual(WALL_EAST.minX + WALL_TOLERANCE_M)
      expect(atWall.x).toBeGreaterThan(WALL_EAST.minX - WALL_APPROACH_MARGIN_M)

      // 방향을 바꾼다 — 고착(그 좌표에 못박힘)이면 아래 이동이 무시되고
      // 위치가 거의 변하지 않을 것이다. 1초 상당(30틱)이면 고착이 아닌 한
      // 6m/s × 1s = 6m 멀어진다.
      const RELEASE_TICKS = 30
      const awayFromWall: MoveInput = { dirX: -1, dirZ: 0, mode: 'run', jump: false }
      const released = runTicks(awayFromWall, RELEASE_TICKS, atWall, TEST_WALLS)

      expect(released.x).toBeLessThan(atWall.x - 1) // 유의미하게 멀어졌다(고착 아님)
    },
  )

  it(
    'RQ-30 양성 대조군: 벽의 XZ 범위 밖 경로는 벽 주입과 무관하게 RQ-92 기본 속도 그대로 이동한다',
    () => {
      // z=20 — TEST_WALLS 4개 중 어느 것의 (minX~maxX, minZ~maxZ) 범위에도
      // 걸리지 않는 시작점(위 docblock/보고서의 좌표 계산 참고). 이것이
      // 없으면 "벽을 주입하면 전역적으로 이동이 느려진다"(또는 전면
      // 정지한다) 같은 오구현도 위 정면 차단 테스트들을 통과할 수 있다.
      const farFromAnyWall = createGroundedState({ z: 20 })
      const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
      const state = runTicks(input, TICKS, farFromAnyWall, TEST_WALLS)

      // 정확히 예상 변위 — 벽이 4개나 주입돼 있어도 이 경로는 전혀
      // 영향받지 않는다(느려지지도, 막히지도 않는다).
      expect(state.x).toBeCloseTo(expectedDistance(MOVEMENT.SPEED, TICKS), 3)
      expect(state.z).toBeCloseTo(20, 6) // dirZ=0이라 표류하지 않음(전제 확인)
    },
  )

  describe('기본값 호환 — 벽을 주지 않으면 기존 동작 그대로다(회귀 가드, ADR-0010 하위 호환)', () => {
    it(
      'RQ-30: 세 번째 인자(walls)를 아예 생략한 기존 2-인자 호출은 벽이 전혀 없는 것처럼 동작한다 — ' +
        'WALL_EAST(x:15~16)의 경로 위를 그대로 통과한다',
      () => {
        const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
        const state = runTicksLegacyTwoArgs(input, TICKS, createGroundedState())

        // WALL_EAST가 이 경로(z=0, x 0→20)의 정확히 그 자리(x:15~16)에
        // 있음에도, 주입하지 않았으므로 완전히 무관하게 예상 변위 그대로다.
        expect(state.x).toBeCloseTo(expectedDistance(MOVEMENT.SPEED, TICKS), 3)
      },
    )

    it(
      'RQ-30: 빈 배열을 명시적으로 넘겨도(walls=[]) 벽이 없는 것과 완전히 동일하다',
      () => {
        const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
        const state = runTicks(input, TICKS, createGroundedState(), [])

        expect(state.x).toBeCloseTo(expectedDistance(MOVEMENT.SPEED, TICKS), 3)
      },
    )
  })
})

/**
 * RQ-30/F2 회귀(독립 평가 FAIL, `_workspace/RQ-30-walls/03_evaluator_report.md`
 * §10) — **공중(점프) 상태에서도 벽을 통과하지 않는다.**
 *
 * **이것은 미결 설계 결정이었지 문서·스펙 위반이 아니었다.** 수정 전
 * (`640d825`) `movement.ts`는 "공중 상태는 벽과 상호작용하지 않는다 —
 * 이 라운드의 명시적 스코프 밖. 점프 중 벽을 넘을 수 있는가는 RQ-30/32
 * 어디에도 규정이 없다. `.glb` 확정 시(벽 높이·뛰어넘기 가부가 정해지는
 * 시점) 결정할 이월 항목"이라고 **명시적으로** 적어 두고 있었다. 평가자도
 * "고쳐라"가 아니라 "(a) 공중 경로에 벽을 적용한다 / (b) 현재 동작(공중
 * 통과)을 의도로 확정하고 `WallAABB` docblock 문면을 실제와 맞게 고친다 —
 * 어느 쪽이든 **테스트로 못박아라**"라고 두 선택지를 대등하게 제시했다
 * (위 보고서 §10 "수정 방법"). 즉 "무한 높이 기둥이므로 통과가 곧 계약
 * 위반"이라는 서술은 이 라운드 자체가 아직 열어 둔 질문에 답을 미리
 * 정해 놓은 것이었다 — 사실이 아니다.
 *
 * **실제 근거(사용자 결정, (a) 채택)**: 공중 제외의 실제 효과는 "벽을
 * 뛰어넘음"이 아니라 **"벽을 관통함"**이었다. `WallAABB`는 애초에 높이
 * 개념이 없다(`minY`/`maxY` 없음, 2D XZ 판정) — 그래서 "공중이면 판정
 * 제외"는 벽이 몇 미터든 상관없이 **판정 자체가 아예 없었다**는 뜻이지,
 * 플레이어가 벽 위를 실제로 넘어갔다는 뜻이 아니다. 게다가 점프
 * 높이(`MOVEMENT.JUMP_HEIGHT`=1.0m, RQ-92)와 벽 두께(1m)가 비슷한
 * 규모라, 실측 궤적(평가자, 위 보고서 §10)은 플레이어가 벽 **한복판을
 * 몸통 높이(y≈0.38~1.0m)로 그대로 가로지르는** 것이었다(착지 위치
 * x≈18.8, `WALL_EAST.maxX`=16을 2.8m 넘김). 이후 `.glb`가 벽 높이를
 * 무한으로 정하든 낮은 박스형으로 정하든 이 관통 자체는 결함이다 —
 * 그래서 `.glb`를 기다릴 이유 없이 이번 라운드에 닫는다.
 *
 * 이 파일의 다른 테스트(정면 차단·고착 금지·양성 대조군)는 전부 `jump:
 * false` 접지 이동만 다룬다 — 벽 테스트 8건 중 `jump: true`를 쓰는 것이
 * 0건이었다는 것이 평가자가 지목한 정확한 공백이다(위 보고서 §10 "테스트
 * 측면") — 미결이었던 (a)/(b) 중 **어느 쪽으로 결정되든 그 결정이 실행되는
 * 단언으로 남아 있지 않았다는 뜻이다. 아래 두 테스트가 (a) 결정을 처음으로
 * 실행되는 단언에 못박는다.
 *
 * **레벨·결정론**: 위 describe와 동일 — 순수 산술, `Math.random()`·
 * `Date.now()`·실 타이머 없음, 틱은 수동 반복으로만 전진한다.
 *
 * **좌표 재사용(ADR-0010 — 값 복제 금지)**: 이 블록만 `PRODUCTION_WALLS`
 * (와 근접면 참조용 `WALL_EAST`)를 `@shared/sim/walls`에서 직접 임포트해
 * 쓴다 — 이 파일 상단의 로컬 `WALL_EAST`/`TEST_WALLS`는 이 라운드 스캐폴드
 * 검증용 상수이지 프로덕션 정본이 아니다(위 파일 최상단 docblock 참고).
 * F2는 **실제로 서버에 상시 배선된**(`GameRoom.ts`) 그 정본 자체가 관통을
 * 막는지를 확인하는 것이므로 정본을 그대로 참조한다(숫자가 우연히 같아도
 * 복제하지 않는다).
 */
describe('RQ-30/F2 회귀 — 공중(점프) 상태에서도 벽을 통과하지 않는다 (독립 평가 FAIL 대응, 골든 GA-57)', () => {
  /** 벽 앞 2m 지점(x:13, `WALL_EAST.minX`=15)에서 이함하는 **첫 틱만**
   * `jump:true`를 준다 — `MoveInput.jump`는 "접지 상태에서만 유효한
   * 엣지 트리거"다(movement.ts `MoveInput` docblock). 이후 틱까지 계속
   * `jump:true`를 주면 착지 순간(다시 접지) 매번 새 도약이 트리거되는
   * 연속 폴짝임(bunny hop) 아티팩트가 생겨 "착지 후 정지" 전제가 깨진다
   * (프로브로 직접 확인 — 착지 틱 바로 다음 틱에 `grounded`가 다시
   * `false`로 튐). 실제 호출부(`GameRoom.stepPlayerMovement`)도 점프
   * 키를 누른 그 틱에만 `jump:true`를 실어 보낸다. z:0은 `WALL_EAST`의
   * z범위(-5~5) 안이라 정면으로 충돌한다. */
  const JUMP_LAUNCH: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: true }
  /** 이함 이후(2번째 틱부터) — `stepAirborne`은 이번 틱 입력을 아예
   * 참조하지 않으므로(REV 2026-07-24 코멘트) 공중 중에는 `dirX`/`jump`
   * 값 자체가 결과에 영향을 주지 않지만, 착지 이후에도 "벽 방향 입력을
   * 유지한다"는 시나리오를 그대로 반영하도록 `dirX:1`은 유지하고
   * `jump:false`만 확정한다. */
  const HOLD_TOWARD_WALL: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }

  /** 이함~착지 전체 비행(점프 높이 1m·중력 20m/s² 궤적 — movement.ts의
   * `JUMP_V0_MPS`/`JUMP_GRAVITY_MPS2` 유도와 동일 물리)은 이함 후 약
   * 0.63초(≈19틱)에 끝난다(프로브로 확인 — 아래 보고서 §Red/Green 실행
   * 출력 참고). 25틱이면 착지 이후 6틱까지 여유 있게 관측해 "착지가
   * 실제로 일어났고 그 상태를 유지한다"는 것까지 확인할 수 있다. */
  const TICKS_COVERING_FLIGHT = 25

  /** `walls`를 매 틱 동일하게 주입하며 `TICKS_COVERING_FLIGHT`회 전진하고,
   * 매 틱 결과 상태를 전부 기록한다(마지막 값만이 아니라 **비행 전체**
   * 위를 검사하기 위해 — F2는 "착지 순간"이 아니라 "체공 중" 관통이었다).
   * 첫 틱만 `JUMP_LAUNCH`(엣지 트리거), 이후는 `HOLD_TOWARD_WALL`. */
  function runJumpSequence(start: MoveState, walls: readonly WallAABB[]): MoveState[] {
    const trajectory: MoveState[] = []
    let state = start
    for (let i = 0; i < TICKS_COVERING_FLIGHT; i += 1) {
      const input = i === 0 ? JUMP_LAUNCH : HOLD_TOWARD_WALL
      state = stepMovement(state, input, walls)
      trajectory.push(state)
    }
    return trajectory
  }

  it(
    'RQ-30/F2: 벽 앞에서 점프해 벽 방향 입력을 유지해도 체공 내내(착지 전까지 매 틱) 위치가 근접면을 넘지 않는다',
    () => {
      const trajectory = runJumpSequence(createGroundedState({ x: 13, z: 0 }), PRODUCTION_WALLS)

      // 전제 확인 — 실제로 공중에 뜬 틱이 존재해야 "공중 경로"를 검증한
      // 것이다(전부 접지 상태라면 이 테스트가 F2와 무관해진다).
      expect(trajectory.some((s) => !s.grounded)).toBe(true)

      // 통과 금지 — 접지·공중 어느 상태에서든, 비행 전체 어느 틱에서도
      // 근접면(PRODUCTION_WALL_EAST.minX)을 넘지 않는다(부동소수 오차만
      // 허용). F2 결함 재현: 이 단언이 없던 시절에는 몸통 높이(y≈0.38~
      // 1.0m)에서 x가 16.8까지 벽을 관통했다(평가자 실측, 위 docblock 참고).
      for (const s of trajectory) {
        expect(s.x).toBeLessThanOrEqual(PRODUCTION_WALL_EAST.minX + WALL_TOLERANCE_M)
      }

      // 고착 아님 — 출발점(13)에 못박히지 않고 실제로 근접면 부근까지
      // 밀렸다.
      const closestApproach = Math.max(...trajectory.map((s) => s.x))
      expect(closestApproach).toBeGreaterThan(PRODUCTION_WALL_EAST.minX - WALL_APPROACH_MARGIN_M)
    },
  )

  it(
    'RQ-30/F2 양성 대조: 벽 절단이 공중 경로에 걸려도 점프 궤적(y 상승·하강·착지) 자체는 벽이 없는 경로와 동일하다',
    () => {
      // z:0(벽과 정면 충돌) vs z:20(이 파일의 기존 "양성 대조군"과 동일
      // 대역 — 어느 벽의 XZ 범위에도 걸리지 않는다)에서 동일한 점프 입력을
      // 재생한다. 수평 위치만 벽에 막힐 뿐, 매 틱의 수직 물리(y·vy)와
      // 착지 시점(grounded 전이)은 경과 시각(t)만의 함수라 수평 위치와
      // 무관해야 한다 — 다르면 벽 절단이 수직 물리까지 오염시킨 과잉수정
      // (F2를 "점프 자체를 죽여서" 고친 경우)을 잡는다. 벽이 공중에서
      // 완전히 무력화된 회귀(F2 재발)는 이 비교와 무관하게 위 테스트가
      // 이미 잡는다 — 이 테스트는 그 반대쪽(과잉수정) 극단을 잡는 양성
      // 대조군이다.
      const blocked = runJumpSequence(createGroundedState({ x: 13, z: 0 }), PRODUCTION_WALLS)
      const clear = runJumpSequence(createGroundedState({ x: 13, z: 20 }), PRODUCTION_WALLS)

      expect(blocked.map((s) => s.y)).toEqual(clear.map((s) => s.y))
      expect(blocked.map((s) => s.vy)).toEqual(clear.map((s) => s.vy))
      expect(blocked.map((s) => s.grounded)).toEqual(clear.map((s) => s.grounded))

      // 점프가 무력화되지 않았다는 전제 확인 — 상승해 JUMP_HEIGHT 근방에
      // 도달했다가 결국 착지(y=0, grounded=true)로 돌아온다.
      expect(Math.max(...clear.map((s) => s.y))).toBeCloseTo(MOVEMENT.JUMP_HEIGHT, 2)
      expect(clear[clear.length - 1]?.grounded).toBe(true)
      expect(clear[clear.length - 1]?.y).toBe(0)
    },
  )
})
