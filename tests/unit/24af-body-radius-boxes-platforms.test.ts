import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveInput, type MoveState, type StaticGeometry } from '@shared/sim/movement'
import { MOVEMENT, NET } from '@shared/constants'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { BOX_ALPHA } from '@shared/sim/boxes'
import { PLATFORM_ALPHA } from '@shared/sim/platforms'

/**
 * 원장 24af 명제 2 — 몸 반경 이동 판정: 박스·플랫폼(RQ-22/RQ-32/RQ-33,
 * 골든 GA-53/GA-55/GA-59/GA-60 인접 영역 — **이 결함을 직접 겨냥한 전용
 * GA는 없다**, 근거는 `24af-body-radius-walls.test.ts` 상단 "골든 부재"
 * 절과 동일).
 *
 * **결함 근거**: `24af-body-radius-walls.test.ts` 상단 docblock 전문 참고
 * — `boxesBlockingAt`이 옆면 차단 대상 박스를 `clampAgainstWalls`에 벽과
 * 같은 목록으로 합류시키므로(`movement.ts` `groundedOutcome`/
 * `airborneOutcome`), 벽의 결함(반경 미적용)이 박스·플랫폼에도 그대로
 * 상속된다 — 박스도 몸통 0.3m가 옆면 안에 박힐 수 있다.
 *
 * **사용자 결정(2026-08-06)**: 반경을 박스·플랫폼에도 도입한다. **단,
 * 상단(topY)보다 높거나 같은 높이(y >= topY, "서 있는" 상태)에서는 그
 * 박스가 애초에 차단 목록(`boxesBlockingAt`)에서 빠지므로 이 반경 적용과
 * 무관하게 계속 막히지 않아야 한다** — 이 계약을 이 라운드가 깨서는 안
 * 된다(RQ-22 "박스 위에 설 수 있어야 한다"는 무조건절, `sim-movement
 * -boxes.test.ts` "접지 지속"/"질문1 경계" 테스트가 이미 고정한 계약).
 *
 * **좌표(ADR-0010 — 리터럴 금지)**: `BOX_ALPHA`(`@shared/sim/boxes`)·
 * `PLATFORM_ALPHA`(`@shared/sim/platforms`) 정본을 그대로 읽는다. "윗면에
 * 서 있을 때 막히지 않는다" 회귀 가드는 클러스터 내 인접 박스
 * (`BOX_ALPHA_3`, 근접 간격 0.3m)와의 간섭을 피하기 위해 `boxes: [BOX_ALPHA]`
 * 하나만 주입한다(`PRODUCTION_BOXES` 전체가 아니다) — 이 라운드가 시험하는
 * 것은 "이 박스 자신의 상단 위는 막히지 않는다"이지 클러스터 간 상호작용이
 * 아니다(스코프 밖, 원장 25a-4 "명시적으로 정하지 않는 것" 절과 동일 정신).
 *
 * **레벨(ADR-0008)**: 순수 산술 — 단위. **결정론**: 정수 틱 반복만 사용,
 * `Math.random()`·`Date.now()` 없음.
 *
 * **REV(독립 평가 O2 대응, `_workspace/24af/03_evaluator_report.md` §8
 * O2) — 윗면 회귀 가드를 "박스 밖에서 근접면을 넘어 들어오는" 궤적으로
 * 다시 짰다.** 최초본은 **박스 중심에서 출발**해 원면(먼 쪽 면) 밖으로
 * 걸어 나가는 궤적을 시험했다 — `clampAgainstWalls`의 절단 조건
 * (`prevX <= near && x > near`, 즉 "근접면을 **넘어서는** 순간에만
 * 발동")은 중심에서 출발하면 애초에 만족되지 않는다(출발 자체가 이미
 * "면 안쪽"이라 "밖에서 안으로 넘어옴"이 없다). 그 결과 M2(`y < topY ||
 * true`, 상단 계약을 통째로 깨 항상 차단)·M3(`y <= topY`, 경계 부등호
 * 반전)를 심어도 두 가드 모두 실패하지 않았다 — "계약을 지킨다"고
 * 선언했지만 실제로는 절단 조건 자체를 시험하지 않는 공허한 가드였다.
 * 지금은 `sim-movement-boxes.test.ts`의 "경계값(팀리드 결정)" 테스트와
 * 동일한 패턴 — **단 1틱**만 전진시켜, 그 1틱이 절단 조건을 실제로
 * 만족시키는데도(근접면을 넘어선다) 차단되지 않고 **정확한 미차단
 * 기대값**(`start.x ± SPEED*TICK_SECONDS`)에 도달하는지 `toBeCloseTo`로
 * 단언한다 — "차단되지 않았다"를 방향 부등식이 아니라 **정확한 값**으로
 * 확인해 부분 차단(느슨해진 반경)도 잡는다.
 *
 * ⚠️ **시작 위치는 `wall.minX`가 아니라 반경 도입 후 실제 절단 목표점
 * (`nearMinX = box.minX − bodyRadiusM`) 기준으로 잡아야 한다(격리
 * 워크트리 1차 실험에서 직접 확인 — `box.minX − 0.1`로 잡았더니 그 값이
 * 이미 `nearMinX`(`box.minX − 0.3`)보다 안쪽이라 절단 조건(`prevX <=
 * nearMinX`)이 애초에 성립하지 않아 M2·M3 둘 다 잡지 못했다).** 이제
 * `BOX_ALPHA.minX − BODY_RADIUS_M − JUST_OUTSIDE_NEAR_TARGET_M`에서
 * 출발해 1틱(0.2m)이 정확히 `nearMinX`를 넘어서게 한다 — 이래야 "박스가
 * 실제로 차단 목록에서 빠졌다"는 것이 이 1틱의 결과로 관측 가능해진다.
 */

const BODY_RADIUS_M = DEFAULT_HITBOX.bodyRadiusM
const TOLERANCE_M = 1e-6
/** `24af-body-radius-walls.test.ts`의 `APPROACH_MARGIN_M`과 동일 값·동일
 * 근거(정지 전략을 규정하지 않는 넉넉한 여유). */
const APPROACH_MARGIN_M = 2
/** 이 파일이 쓰는 시작점~근접면 거리(5m 이상)를 6m/s로 걷기 충분한 여유. */
const TICKS = 60
/** 1틱의 경과 시간(초) — `sim-movement-boxes.test.ts`의 "경계값" 테스트와
 * 동일 산식(ADR-0010, 리터럴 금지). */
const TICK_SECONDS = NET.TICK_MS / 1000
/** 절단 목표점(`nearMinX`/`nearMaxX` = 근접면 ∓ `BODY_RADIUS_M`) 바깥
 * 0.1m — 1틱 변위(0.2m, `MOVEMENT.SPEED`×`TICK_SECONDS`)보다 작아 정확히
 * 그 목표점을 넘어서는 시작 여유(`sim-movement-boxes.test.ts` "경계값"
 * 테스트와 동일 근거: 1틱 변위와 정확히 같은 여유를 쓰면 다음 위치가
 * 목표점과 완전히 같아져 차단 여부와 무관하게 결과가 같아지는 공허한
 * 그물이 된다). 근접면(`wall.minX`/`wall.maxX`) 자체가 아니라 **반경
 * 적용 후 목표점**을 기준으로 잡는다 — 위 파일 docblock REV 절 "시작
 * 위치" 경고 참고. */
const JUST_OUTSIDE_NEAR_TARGET_M = 0.1

function createGroundedState(overrides: Partial<MoveState> = {}): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, ...overrides }
}

function runTicks(input: MoveInput, ticks: number, initial: MoveState, geometry: StaticGeometry): MoveState {
  let state = initial
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(state, input, geometry)
  }
  return state
}

describe('24af 명제 2 — 박스: 상단보다 낮은 높이에서 밀착해도 중심이 옆면에서 bodyRadiusM만큼 떨어진다', () => {
  it('24af/RQ-22: BOX_ALPHA 방향으로 걸어서(비점프) 접근해도(60틱) 중심-근접면(minX) 간극이 bodyRadiusM(0.3m) 이상이다', () => {
    const centerZ = (BOX_ALPHA.minZ + BOX_ALPHA.maxZ) / 2
    const start = createGroundedState({ x: BOX_ALPHA.minX - 5, z: centerZ })
    const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
    const geometry: StaticGeometry = { walls: [], boxes: [BOX_ALPHA], ladders: [] }

    const state = runTicks(input, TICKS, start, geometry)
    const clearance = BOX_ALPHA.minX - state.x

    // 핵심 Red 단언 — 오늘 구현은 clearance≈0.
    expect(clearance).toBeGreaterThanOrEqual(BODY_RADIUS_M - TOLERANCE_M)
    expect(clearance).toBeLessThan(BODY_RADIUS_M + APPROACH_MARGIN_M)
    expect(state.x).toBeGreaterThan(start.x) // 고착 아님 — 실제로 전진했다
    // 차단됐으니(근접면을 넘지 못했으니) 지지 높이도 여전히 맨 지면이다.
    expect(state.grounded).toBe(true)
    expect(state.y).toBeCloseTo(0, 6)
  })

  it('24af/RQ-22 회귀 가드(과잉수정 방지) — 박스 밖(근접면 0.1m 바깥, y=topY)에서 면을 넘어 들어와도 반경과 무관하게 막히지 않는다(원장 25a-4 계약 유지)', () => {
    // 절단 목표점(nearMinX = minX − bodyRadiusM) **바깥**에서 출발한다 —
    // clampAgainstWalls의 절단 조건(prevX <= nearMinX && x > nearMinX)이
    // 이번 틱에 실제로 성립해야 "차단되지 않았다"는 단언이 그 조건을
    // 진짜로 시험한 것이 된다(O2 대응, 위 파일 docblock REV 절 — 근접면
    // 자체가 아니라 목표점 기준으로 여유를 잡는 이유도 그 절 참고).
    const centerZ = (BOX_ALPHA.minZ + BOX_ALPHA.maxZ) / 2
    const start = createGroundedState({
      x: BOX_ALPHA.minX - BODY_RADIUS_M - JUST_OUTSIDE_NEAR_TARGET_M,
      y: BOX_ALPHA.topY,
      z: centerZ,
    })
    const input: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }
    const geometry: StaticGeometry = { walls: [], boxes: [BOX_ALPHA], ladders: [] }

    const next = stepMovement(start, input, geometry)

    // 전제 확인 — 이 1틱이 실제로 절단 목표점을 넘어선다(절단 조건을
    // 실제로 만족시킨다는 증거, 공허한 그물 방지).
    expect(next.x).toBeGreaterThan(BOX_ALPHA.minX - BODY_RADIUS_M)
    // 본 단언(O2 핵심) — 방향 부등식이 아니라 **정확한 미차단 기대값**으로
    // 확인한다. 차단됐다면 근접면(또는 근접면-반경)에 멈췄을 것이다 —
    // y>=topY라 이 박스가 boxesBlockingAt에서 빠지므로, 기대값은 순수하게
    // 입력 속도만으로 계산한 값과 같아야 한다.
    const expectedX = start.x + MOVEMENT.SPEED * TICK_SECONDS
    expect(next.x).toBeCloseTo(expectedX, 6)
    expect(next.grounded).toBe(true)
  })
})

describe('24af 명제 2 — 플랫폼: 상단보다 낮은 높이에서 밀착해도 중심이 옆면에서 bodyRadiusM만큼 떨어진다(GA-60 인접면)', () => {
  it('24af/RQ-33/GA-60 인접: PLATFORM_ALPHA의 사다리 없는 면(동쪽, maxX)으로 접근해도(60틱) 중심-근접면 간극이 bodyRadiusM(0.3m) 이상이다', () => {
    const centerZ = (PLATFORM_ALPHA.minZ + PLATFORM_ALPHA.maxZ) / 2
    const start = createGroundedState({ x: PLATFORM_ALPHA.maxX + 5, z: centerZ })
    const input: MoveInput = { dirX: -1, dirZ: 0, mode: 'run', jump: false }
    // stepMovement가 호출 시점에 platforms를 boxes에 합쳐 boxesBlockingAt/
    // standingHeight에 넘긴다(`@shared/sim/movement` docblock "원장 25a-5"
    // 절) — boxes는 비워 platforms 경로 자체를 시험한다.
    const geometry: StaticGeometry = { walls: [], boxes: [], ladders: [], platforms: [PLATFORM_ALPHA] }

    const state = runTicks(input, TICKS, start, geometry)
    const clearance = state.x - PLATFORM_ALPHA.maxX

    expect(clearance).toBeGreaterThanOrEqual(BODY_RADIUS_M - TOLERANCE_M)
    expect(clearance).toBeLessThan(BODY_RADIUS_M + APPROACH_MARGIN_M)
    expect(state.x).toBeLessThan(start.x) // 고착 아님 — 실제로 전진했다
    expect(state.grounded).toBe(true)
    expect(state.y).toBeCloseTo(0, 6) // 오르지 못했다(GA-60과 동일 귀결)
  })

  it('24af/RQ-33 회귀 가드(과잉수정 방지) — 플랫폼 밖(근접면 0.1m 바깥, y=topY)에서 면을 넘어 들어와도 반경과 무관하게 막히지 않는다(GA-59 전이 이후 이동 자유)', () => {
    // GA-60 절에서 접근에 쓴 면(동쪽, maxX)의 절단 목표점(nearMaxX = maxX
    // + bodyRadiusM) **바깥**에서 안쪽(-X)으로 넘어 들어오는 1틱을
    // 시험한다(O2 대응, 위 파일 docblock REV 절과 동일 패턴).
    const centerZ = (PLATFORM_ALPHA.minZ + PLATFORM_ALPHA.maxZ) / 2
    const start = createGroundedState({
      x: PLATFORM_ALPHA.maxX + BODY_RADIUS_M + JUST_OUTSIDE_NEAR_TARGET_M,
      y: PLATFORM_ALPHA.topY,
      z: centerZ,
    })
    const input: MoveInput = { dirX: -1, dirZ: 0, mode: 'run', jump: false }
    const geometry: StaticGeometry = { walls: [], boxes: [], ladders: [], platforms: [PLATFORM_ALPHA] }

    const next = stepMovement(start, input, geometry)

    // 전제 확인 — 이 1틱이 실제로 절단 목표점(maxX + bodyRadiusM)을
    // 넘어선다.
    expect(next.x).toBeLessThan(PLATFORM_ALPHA.maxX + BODY_RADIUS_M)
    // 본 단언(O2 핵심) — 정확한 미차단 기대값과 비교한다.
    const expectedX = start.x - MOVEMENT.SPEED * TICK_SECONDS
    expect(next.x).toBeCloseTo(expectedX, 6)
    expect(next.grounded).toBe(true)
  })
})
