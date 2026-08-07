import { describe, expect, it } from 'vitest'
import { stepMovement, type BoxAABB, type MoveInput, type MoveState } from '@shared/sim/movement'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'
import { PRODUCTION_BOXES, BOX_ALPHA, BOX_ALPHA_2 } from '@shared/sim/boxes'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'

/**
 * 원장 24af — 박스 클러스터 **이음새** 회귀(PR #67 1차 리뷰 blocker,
 * `_workspace/review/feat-24af-body-radius.md` "박스 클러스터 이음새에서
 * 몸이 박스 안에 박히고, 걸어서 박스 위로 올라선다").
 *
 * **결함(리뷰어 실측)**: 인접 박스 쌍의 자유 간격이 `2 × bodyRadiusM`
 * (0.6m)보다 좁으면(프로덕션에 24쌍 — 전부 박스-박스, 직선 0.3m 12쌍·대각
 * 0.4243m 12쌍, 클러스터 3곳 전부) 두 박스의 팽창(반경 확장) AABB가
 * **겹친다.** `clampAgainstWalls`의 절단이 "교차"에서만 발동하는 구조라
 * (`prevX <= nearMinX && x > nearMinX`), 팽창 띠 **안쪽** 위치는 어느
 * 분기도 만족하지 않아 그 박스가 **차단을 완전히 멈춘다.** 진입 경로:
 *
 * 1. 박스 A 윗면(`y === A.topY`)에 서 있으면 A는 `boxesBlockingAt`에서
 *    빠진다(`y < box.topY`가 거짓) — 자유롭게 걸어 다닐 수 있다.
 * 2. 인접 박스 B 쪽으로 걸으면 `B.minZ − R`에서 절단된다. 간격이 정확히
 *    `R`이면 그 좌표는 **`A.maxZ`와 같다.**
 * 3. `standingHeight`는 A의 **팽창하지 않은** 개방 구간(`z < A.maxZ`)을
 *    쓰므로 그 자리에서 지지 높이가 0으로 떨어져 공중 전이 → 이음새
 *    바닥으로 낙하한다.
 * 4. 착지 위치(`z = A.maxZ`)는 A의 팽창 띠 `(A.minZ−R, A.maxZ+R)`
 *    **내부**다 — 이제 A가 플레이어를 전혀 막지 않는다. 걸어 들어가면
 *    `standingHeight`가 `A.topY`를 보고 **그 자리에서(점프 없이) 윗면으로
 *    솟아오른다.**
 *
 * **왜 기존 테스트가 전부 통과했는가**: `24af-body-radius-*.test.ts`·
 * `24ao-corner-body-radius-*.test.ts`·`sim-movement-boxes.test.ts`가
 * **전부 AABB를 1개만 격리 주입**한다(`boxes: [BOX_ALPHA]` 등) — 인접
 * 박스 쌍의 상호작용을 한 번도 시험하지 않았다. 이 파일은 그 공백을
 * 메운다 — **`PRODUCTION_GEOMETRY` 전체를 그대로 주입**한다(격리 금지).
 *
 * **세울 명제**:
 * 1. 박스 윗면에서 이음새를 가로질러 걸어도(어느 인접 박스로도) 몸이
 *    **어떤 박스의 실제 내부에도 침투하지 않는다** — 접지·맨 지면
 *    (y≈0)에서, 중심의 (x,z)가 어떤 박스의 **실제(반경 미적용) 열린
 *    구간 안**에도 있으면 안 된다.
 *
 *    ⚠️ **"반경만큼 떨어져 있다"(거리 ≥ R)가 아니라 "실제 경계 안에
 *    들어가지 않는다"(침투 금지)로 잡은 이유(초안의 결함, 검출력 실험
 *    중 발견 — 아래 보고서 "초안의 결함" 절)**: 박스 가장자리를 걸어서
 *    벗어나 맨 지면에 착지한 직후 중심이 그 박스의 실제 면에 **정확히
 *    닿는(거리 0, 경계 자체)** 것은 24af **이전부터**(`main`에도) 있던
 *    정상 정지 지점이다 — `main`은 이동 판정에 반경 개념이 아예 없어서,
 *    점 클램프의 목표점 자체가 박스의 실제 경계이기 때문이다. "거리 ≥
 *    R"을 절대 기준으로 잡으면 이 정상 정지까지 잡아 **`base(main)`에서도
 *    실패한다**(초안 실측 — 명제 3 자체가 성립하지 않게 된다). 리뷰어의
 *    실측도 침투량으로 판정한다("BOX_ALPHA 내부로 최대 2.0m 진입" vs
 *    `base`의 "침투 0") — 이 파일은 그 기준을 그대로 따른다.
 * 2. **점프 없이 박스 윗면 높이에 도달하지 않는다**(ADR-0013 결과 절
 *    "박스 등반은 명시적 점프" · RQ-22 · `standingHeight` docblock
 *    "질문1 회신" 대안 (b) 명시적 배제). `jump: false`만 보내는 궤적에서
 *    접지 상태의 `y`는 항상 0이거나 **출발한 그 박스**의 `topY`여야
 *    한다 — 다른 박스의 `topY`에 도달하면(=걸어서 올라섰다는 뜻) 위반.
 * 3. **base(main, `origin/main`)에서는 이 명제가 성립하고 HEAD(이 PR)
 *    에서는 깨진다** — §산출 보고서(`_workspace/24af/09_test-writer
 *    _seam.md`)가 두 버전 실행 출력을 나란히 싣는다(이 파일 자체는
 *    HEAD에서만 실행되므로, 이 파일의 실행 결과만으로는 명제 3을
 *    증명하지 못한다 — base 비교는 별도 워크트리 실행으로 보강한다).
 *
 * **가설 검증(내가 아니라 코디네이터의 가설 — 검증 결과는 보고서에
 * 있다)**: `standingHeight`가 점 판정으로 남아 있어서 이 진입 경로가
 * 열렸는가? 코드 실측(`movement.ts:427-435`)은 그 가설과 일치한다 —
 * `standingHeight`의 판정식은 `x > box.minX && x < box.maxX` **그대로**
 * (반경 미반영, docblock이 "이 함수 자신은 반경을 반영하지 않는다"고
 * 명시적으로 적어 뒀다). 이 파일은 그 판정식의 **행동**만 관측하고 구현
 * 방식을 규정하지 않는다 — 어떤 수정이든(A: 절단을 침투 해소로 바꾸기,
 * B: 클러스터 간격을 넓히기, 또는 다른 접근) 아래 명제만 지키면 통과한다.
 *
 * **스코프(리뷰어 A7 재확인 인용)** — 2R 미만 24쌍은 **전부 박스-박스**다
 * (벽-벽·벽-박스·벽-플랫폼·플랫폼-박스·사다리 조합 중 2R 미만 0건). 이
 * 파일은 그래서 **박스만** 다룬다 — 플랫폼·벽 조합은 이 결함의 공격
 * 표면이 아니다(전수 조사는 리뷰 보고서 §6-1 A7이 이미 했다, 이 파일이
 * 반복하지 않는다).
 *
 * **좌표(ADR-0010)**: `PRODUCTION_GEOMETRY`(`@shared/sim/geometry`)·
 * `PRODUCTION_BOXES`(`@shared/sim/boxes`) 정본을 그대로 읽는다 —
 * 리터럴 좌표를 새로 만들지 않는다.
 *
 * **레벨(ADR-0008)**: 순수 산술 — 단위. **결정론**: 정수 틱 반복만 사용,
 * `Math.random()`·`Date.now()` 없음.
 */

const BODY_RADIUS_M = DEFAULT_HITBOX.bodyRadiusM
const TOLERANCE_M = 1e-6

function createGroundedState(overrides: Partial<MoveState> = {}): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, ...overrides }
}

/** 이 틱의 상태가 명제 1(박힘 금지)·명제 2(무점프 등반 금지)를 지키는지
 * 확인한다. `startingBox`는 이 궤적이 애초에 서 있던 박스 — 아직 **한
 * 번도 맨 지면에 닿지 않았다면**(`ctx.hasTouchedGround === false`) 계속
 * 그 박스 위에 있는 것은 허용한다(원래 서 있던 자리를 벗어나지 않은
 * 것뿐이므로 "등반"이 아니다). `ctx`는 궤적 하나(호출자의 `for` 루프)
 * 전체에 걸쳐 공유하는 가변 상태다. */
interface SeamCheckContext {
  /** 이 궤적이 한 번이라도 맨 지면(접지, y≈0)에 닿은 적이 있는가. 한
   * 번이라도 닿았다면 그 뒤로는 **출발 박스를 포함해 어떤 박스 윗면에
   * 다시 올라서는 것도** 무점프 등반이다(리뷰어 재현의 2단계 — "이음새로
   * 낙하한 뒤 되돌아 걸으면 원래 그 박스로 다시 올라선다"가 정확히 이
   * 경우다 — 원래 박스라고 봐줄 이유가 없다, 이미 한 번 완전히 내려왔기
   * 때문이다). */
  hasTouchedGround: boolean
}

function assertNoEmbedAndNoUnauthorizedClimb(
  state: MoveState,
  tickIndex: number,
  startingBox: BoxAABB | undefined,
  ctx: SeamCheckContext,
): void {
  // ⚠️ **공중(자유낙하, `grounded === false`) 상태는 이 명제의 대상이
  // 아니다 — 검사는 접지(착지) 상태에서만 한다.** 박스 가장자리를 걸어서
  // 벗어나면(원장 25a-6, 24af/24ao와 무관한 기존 낙하 물리) 이함 직후
  // 몇 틱은 "방금 떠난 그 박스"에 근접한 채(수평 속도가 그대로 이어지므로
  // 아직 멀어지지 못한 상태) 낙하 중이다 — 이건 **어느 단일 박스에서도
  // 항상 있는 정상적인 전이**이지 이음새 결함이 아니다. 이 파일이
  // 겨냥하는 결함은 **착지(재접지) 이후**의 상태다: (a) 맨 지면에
  // 내려섰는데 어떤 박스의 실제 내부에 **침투**해 있거나, (b) 점프 없이
  // 다른 박스 윗면으로 솟아오른 것.
  if (!state.grounded) return

  if (state.y <= TOLERANCE_M) {
    // 명제 1 — 박힘(침투) 금지: 맨 지면(접지, y≈0)에서는 중심이 **어떤
    // 박스의 실제(반경 미적용) 열린 구간 안에도 있으면 안 된다.**
    //
    // ⚠️ **경계 접촉(거리=0, "닿음")과 내부 침투("박힘")를 구분한다 —
    // 초안은 이를 혼동했다(아래 보고서 "초안의 결함" 절).** `distance
    // >= bodyRadiusM`(중심이 항상 반경만큼 떨어져야 한다)를 절대 기준으로
    // 삼으면 **`base(main)`에서도 실패한다** — `main`은애초에 이동 판정에
    // 반경 개념이 전혀 없어서, 박스 가장자리를 걸어 나가 맨 지면에 착지한
    // 직후 그 박스의 실제 면에 정확히 닿는(거리 0, 열린 구간 밖) 것이
    // **정상 정지 지점**이다(24af 이전부터 항상 그래 왔다 — 점 판정
    // 클램프의 목표점 자체가 박스의 실제 경계다). 리뷰어의 실측도 같은
    // 결론이다 — "박힘"의 증거로 든 것은 거리가 아니라 **침투량**
    // ("BOX_ALPHA 내부로 최대 2.0m 진입")이고, `base`의 대조값은
    // "침투 0"이다. 그래서 이 파일은 **열린 구간 안(strict containment)**
    // 인지만 본다 — 경계에 닿는 것(main·HEAD 둘 다에서 일어나는 정상
    // 정지)은 위반이 아니고, 실제 내부로 들어가는 것(HEAD에서만 발생하는
    // 결함)만 위반이다.
    for (const box of PRODUCTION_BOXES) {
      const insideRealFootprint = state.x > box.minX && state.x < box.maxX && state.z > box.minZ && state.z < box.maxZ
      expect(
        insideRealFootprint,
        `tick ${tickIndex}: 맨 지면(y=${state.y})인데 (x,z)=(${state.x},${state.z})가 박스(topY=${box.topY}, x:[${box.minX},${box.maxX}], z:[${box.minZ},${box.maxZ}])의 실제 내부다 — 박스 안에 박혔다`,
      ).toBe(false)
    }
    ctx.hasTouchedGround = true
    return
  }

  // 명제 2 — 무점프 등반 금지: 접지 상태에서 y가 0이 아니면 **실제로
  // 그 XZ 위치가 열린 구간 안에 있는(=`standingHeight`가 참조하는 것과
  // 동일한 포함 판정)** 박스라야 한다. jump는 이 파일 전체에서 한 번도
  // true로 보내지 않는다.
  //
  // ⚠️ **`topY` 값만으로 매칭하지 않는다** — 서로 다른 클러스터의
  // 무관한 박스가 우연히 같은 `topY`를 공유한다(예: `BOX_ALPHA_4`와
  // `BOX_CHARLIE_4` 둘 다 0.7m, 클러스터 배치가 ALPHA/BRAVO/CHARLIE
  // 전부 같은 topY 집합 {0.35,0.4,0.5,0.6,0.7}을 쓰기 때문 —
  // `@shared/sim/boxes` 좌표 실측). `topY`만 보고 매칭하면 실제로는 계속
  // 출발 박스 위에 서 있는데도(정상 상태) `.find()`가 배열 순서상 먼저
  // 나오는 **다른 클러스터의 동일 높이 박스**를 골라 오탐한다(이 파일
  // 초안에서 실제로 겪은 버그 — 아래 보고서 "초안의 결함" 절에 기록).
  // XZ 열린 구간 포함까지 함께 확인해 "실제로 이 박스 위에 서 있는가"를
  // 모호함 없이 판정한다.
  const supportingBox = PRODUCTION_BOXES.find(
    (box) =>
      Math.abs(box.topY - state.y) < TOLERANCE_M &&
      state.x > box.minX &&
      state.x < box.maxX &&
      state.z > box.minZ &&
      state.z < box.maxZ,
  )
  expect(
    supportingBox,
    `tick ${tickIndex}: 접지 y=${state.y}, (x,z)=(${state.x},${state.z})인데 이 위치·높이를 지지하는 박스가 없다(standingHeight가 낼 수 없는 값)`,
  ).toBeDefined()

  if (!ctx.hasTouchedGround) {
    // 아직 맨 지면에 닿은 적이 없다 — 출발 박스에서 한 번도 안 벗어난
    // 것뿐이면(정상) 그 박스라야 한다.
    expect(
      supportingBox,
      `tick ${tickIndex}: 맨 지면에 닿기도 전에 점프 없이 다른 박스(topY=${supportingBox?.topY})의 윗면에 도달했다 — 출발 박스(topY=${startingBox?.topY})가 아니다`,
    ).toBe(startingBox)
    return
  }

  // ⚠️ **한 번이라도 맨 지면에 닿았다면, 그 뒤로는 출발 박스를 포함해
  // 어떤 박스 윗면에 다시 올라서는 것도 무점프 등반이다.** 리뷰어 재현의
  // 2단계(이음새로 낙하 → 되돌아 걸으면 원래 박스로 다시 올라섬)가
  // 정확히 이 경우다 — "원래 서 있던 박스니까 괜찮다"는 예외를 두면 그
  // 재현을 놓친다(이 파일 초안의 결함, 아래 보고서 참고).
  expect(
    false,
    `tick ${tickIndex}: 맨 지면에 닿은 뒤(재접지 이후) 점프 없이 박스(topY=${supportingBox?.topY}, 출발 박스와 같은가=${supportingBox === startingBox})의 윗면에 다시 올라섰다`,
  ).toBe(true)
}

describe('24af 명제 seam-1 — 리뷰어의 정확한 재현: BOX_ALPHA 윗면에서 이음새를 걸어서 넘어도(전진→후진) 박히거나 무점프 등반하지 않는다', () => {
  it('전제 확인 — BOX_ALPHA와 BOX_ALPHA_2의 자유 간격이 정확히 bodyRadiusM(0.3m)이다(이 결함이 발화하는 정확한 조건)', () => {
    // 정본(@shared/sim/boxes)에서 직접 읽는다 — 리터럴 좌표를 새로 쓰지
    // 않는다(ADR-0010). 둘 다 PRODUCTION_BOXES의 원소임도 함께 확인해
    // "정본과 무관한 로컬 값"이 아님을 보증한다.
    expect(PRODUCTION_BOXES).toContain(BOX_ALPHA)
    expect(PRODUCTION_BOXES).toContain(BOX_ALPHA_2)
    const gap = BOX_ALPHA_2.minZ - BOX_ALPHA.maxZ
    expect(gap).toBeCloseTo(BODY_RADIUS_M, 6)
  })

  it(
    '24af/블로커 재현: 리뷰어와 동일한 좌표(12.5, 0.4, 10.5)에서 +z 14틱(이음새 낙하) → -z 10틱(되돌아 걷기)해도 박히지 않고 무점프로 윗면에 오르지 않는다',
    () => {
      let state = createGroundedState({ x: 12.5, y: BOX_ALPHA.topY, z: 10.5 })
      const forward: MoveInput = { dirX: 0, dirZ: 1, mode: 'run', jump: false }
      const backward: MoveInput = { dirX: 0, dirZ: -1, mode: 'run', jump: false }

      // 전제 확인 — 출발점이 실제로 BOX_ALPHA 윗면이다.
      expect(state.x).toBeGreaterThan(BOX_ALPHA.minX)
      expect(state.x).toBeLessThan(BOX_ALPHA.maxX)
      expect(state.z).toBeGreaterThan(BOX_ALPHA.minZ)
      expect(state.z).toBeLessThan(BOX_ALPHA.maxZ)

      const ctx: SeamCheckContext = { hasTouchedGround: false }
      let tick = 0
      for (let i = 0; i < 14; i += 1, tick += 1) {
        state = stepMovement(state, forward, PRODUCTION_GEOMETRY)
        assertNoEmbedAndNoUnauthorizedClimb(state, tick, BOX_ALPHA, ctx)
      }
      for (let i = 0; i < 10; i += 1, tick += 1) {
        state = stepMovement(state, backward, PRODUCTION_GEOMETRY)
        assertNoEmbedAndNoUnauthorizedClimb(state, tick, BOX_ALPHA, ctx)
      }
    },
  )
})

describe('24af 명제 seam-2 — 전수 스윕: 박스 15개 × 8방향, 윗면에서 걸어 나가도 박히거나 무점프 등반하지 않는다', () => {
  const TICKS = 40 // 0.2m/틱 × 40 = 8m — 박스 폭(3m)+간격(≤0.4243m)+인접 박스 폭을 넉넉히 지난다
  const SQRT1_2 = Math.SQRT1_2
  const DIRECTIONS: Array<{ label: string; dirX: number; dirZ: number }> = [
    { label: '+X', dirX: 1, dirZ: 0 },
    { label: '-X', dirX: -1, dirZ: 0 },
    { label: '+Z', dirX: 0, dirZ: 1 },
    { label: '-Z', dirX: 0, dirZ: -1 },
    { label: '+X+Z', dirX: SQRT1_2, dirZ: SQRT1_2 },
    { label: '+X-Z', dirX: SQRT1_2, dirZ: -SQRT1_2 },
    { label: '-X+Z', dirX: -SQRT1_2, dirZ: SQRT1_2 },
    { label: '-X-Z', dirX: -SQRT1_2, dirZ: -SQRT1_2 },
  ]

  it('전제 확인 — PRODUCTION_BOXES·방향 목록이 비어있지 않다(공허 통과 방지)', () => {
    expect(PRODUCTION_BOXES.length).toBeGreaterThan(0)
    expect(DIRECTIONS.length).toBeGreaterThan(0)
  })

  const CASES = PRODUCTION_BOXES.flatMap((box, boxIndex) =>
    DIRECTIONS.map((dir) => ({ box, boxIndex, dir })),
  )

  it.each(CASES)(
    '24af/RQ-22: 박스#$boxIndex 윗면에서 $dir.label 방향으로 40틱 걸어도 어떤 박스에도 박히지 않고 무점프로 인접 박스 윗면에 오르지 않는다',
    ({ box, dir }) => {
      const centerX = (box.minX + box.maxX) / 2
      const centerZ = (box.minZ + box.maxZ) / 2
      let state = createGroundedState({ x: centerX, y: box.topY, z: centerZ })
      const input: MoveInput = { dirX: dir.dirX, dirZ: dir.dirZ, mode: 'run', jump: false }
      const ctx: SeamCheckContext = { hasTouchedGround: false }

      for (let i = 0; i < TICKS; i += 1) {
        state = stepMovement(state, input, PRODUCTION_GEOMETRY)
        assertNoEmbedAndNoUnauthorizedClimb(state, i, box, ctx)
      }
    },
  )
})
