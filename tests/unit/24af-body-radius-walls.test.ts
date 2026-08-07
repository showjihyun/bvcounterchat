import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveInput, type MoveState, type StaticGeometry } from '@shared/sim/movement'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PRODUCTION_WALLS, WALL_EAST, WALL_WEST, WALL_NORTH, WALL_SOUTH } from '@shared/sim/walls'

/**
 * 원장 24af 명제 1 — 몸 반경 이동 판정: 벽(RQ-30/RQ-20, 골든 GA-50/GA-57
 * 인접 영역, **전용 GA 없음** — 아래 "골든 부재" 절 참고).
 *
 * **결함(사용자 플레이테스트 보고 + 독립 리뷰 확인, 2026-08-06)**: "벽에
 * 막힐 때 벽을 통과하는 듯한 느낌이 든다." 실측 원인 —
 * `clampAgainstWalls`(`src/shared/sim/movement.ts:316-346`)가 플레이어
 * **중심**을 벽면에 **정확히**(간극 0) 붙인다. 서버 hitscan(`@shared/sim
 * /combat`)은 `DEFAULT_HITBOX.bodyRadiusM`(0.3m) 원통으로 맞히는데, 이동
 * 절단은 점 취급이라 몸통 0.3m가 벽 안에 박힌 채로 설 수 있다 — 판정
 * 불일치(카메라 근평면 결과는 증상일 뿐, 근본은 이동 판정).
 *
 * **사용자 결정(2026-08-06)**: 반경을 벽·박스·플랫폼 전부의 수평 차단
 * 판정에 도입한다. 플레이 면적이 각 벽에서 0.3m 줄어드는 것은 RQ-30
 * "약 60×60m"와 양립하는 것으로 수용됐다.
 *
 * **세울 명제(Red)**: 벽에 밀착해도 플레이어 중심이 근접면에서
 * `DEFAULT_HITBOX.bodyRadiusM`만큼 떨어져 있다 — ±X·±Z 네 방향 전부
 * (`clampAgainstWalls`의 현재 커버리지, `sim-movement-walls.test.ts`
 * docblock "2D(XZ) 전용" 절과 동일 스코프 — 대각선·모서리는 이 라운드가
 * 다루지 않는다).
 *
 * **골든 부재**: 이 결함(몸 반경 미적용)을 직접 겨냥한 GA-* 골든 케이스는
 * `harness/evals/golden/track-a-product.jsonl`에 없다(전수 확인 —
 * GA-50은 세계 경계, GA-57은 "벽을 통과하지 않는다"는 부등식만 요구하고
 * 반경을 요구하지 않는다). 정답은 사람이 쓴다(`harness/evals/README.md`)
 * — 이 라운드는 사용자 결정(위)을 유일한 근거로 삼는다. 임의로 새 GA를
 * 발명하지 않는다.
 *
 * **좌표(ADR-0010 — 리터럴 금지)**: 정본 `PRODUCTION_WALLS`
 * (`@shared/sim/walls`)를 그대로 주입하고, 근접면 좌표도 `WALL_EAST`
 * 등에서 직접 읽는다 — 새 좌표를 발명하지 않는다.
 *
 * **레벨(ADR-0008)**: 순수 산술(`clampAgainstWalls`) — 단위.
 * **결정론**: `Math.random()`·`Date.now()`·실 타이머 없음, 정수 틱 반복만
 * 사용한다(`sim-movement-walls.test.ts`와 동일 근거, 중복 결정론 테스트
 * 추가 없음).
 *
 * **경계 마진 설계(기존 `sim-movement-walls.test.ts` 선례 계승)**: 하한
 * 검사는 `APPROACH_MARGIN_M`(2m, ≫ bodyRadiusM)로 넉넉히 잡아 "어떻게
 * 멈추는가"(하드 클램프·슬라이드 등 구현 방식)를 규정하지 않는다 — 오직
 * "간극이 반경 미만으로 좁혀지지 않는다"(상한, Red의 핵심)와 "실제로
 * 근접면 부근까지 밀렸다"(하한, 고착 아님)만 부등식으로 확인한다.
 */

const BODY_RADIUS_M = DEFAULT_HITBOX.bodyRadiusM
/** 부동소수점 누적 오차 허용치 — `sim-movement-walls.test.ts`의
 * `WALL_TOLERANCE_M`과 동일 값·동일 근거. */
const TOLERANCE_M = 1e-6
/** "실제로 근접면 부근까지 밀렸다"(고착 아님) 확인용 여유 — 반경(0.3m)보다
 * 훨씬 넉넉해(2m) 정지 전략(하드 클램프·슬라이드)을 규정하지 않는다. */
const APPROACH_MARGIN_M = 2
/** 100틱(≈3.33초) 유지 이동이면 15~16m 대역의 벽까지 충분히 수렴한다
 * (`sim-movement-walls.test.ts` `TICKS`와 동일 근거). */
const TICKS = 100

function createGroundedState(overrides: Partial<MoveState> = {}): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, ...overrides }
}

function runTicks(input: MoveInput, ticks: number, initial: MoveState): MoveState {
  let state = initial
  const geometry: StaticGeometry = { walls: PRODUCTION_WALLS, boxes: [], ladders: [] }
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(state, input, geometry)
  }
  return state
}

describe('24af 명제 1 — 벽에 밀착해도 중심이 근접면에서 bodyRadiusM만큼 떨어진다(±X·±Z)', () => {
  // 공허 통과 방지 — 전제 확인(빈 배열이면 아래 it.each가 조용히 0건 실행된다).
  it('전제 확인 — PRODUCTION_WALLS가 비어있지 않다(아래 it.each가 공허하게 통과하지 않음을 보증)', () => {
    expect(PRODUCTION_WALLS.length).toBeGreaterThan(0)
  })

  interface Case {
    label: string
    input: MoveInput
    axisCoord: (s: MoveState) => number
    /** 근접면 좌표 — 진행 방향이 마주하는 면. */
    nearFace: number
    /** 부호 — 양수/음수 두 방향을 동일한 부등식으로 다루기 위한 정규화 계수. */
    sign: 1 | -1
  }

  const CASES: Case[] = [
    { label: '+X(동, WALL_EAST)', input: { dirX: 1, dirZ: 0, mode: 'run', jump: false }, axisCoord: (s) => s.x, nearFace: WALL_EAST.minX, sign: 1 },
    { label: '-X(서, WALL_WEST)', input: { dirX: -1, dirZ: 0, mode: 'run', jump: false }, axisCoord: (s) => s.x, nearFace: WALL_WEST.maxX, sign: -1 },
    { label: '+Z(북, WALL_NORTH)', input: { dirX: 0, dirZ: 1, mode: 'run', jump: false }, axisCoord: (s) => s.z, nearFace: WALL_NORTH.minZ, sign: 1 },
    { label: '-Z(남, WALL_SOUTH)', input: { dirX: 0, dirZ: -1, mode: 'run', jump: false }, axisCoord: (s) => s.z, nearFace: WALL_SOUTH.maxZ, sign: -1 },
  ]

  it.each(CASES)(
    '24af/RQ-30/RQ-20: 벽($label) 방향으로 지속 이동해도(100틱) 중심-근접면 간극이 bodyRadiusM(0.3m) 이상이다',
    ({ input, axisCoord, nearFace, sign }) => {
      const state = runTicks(input, TICKS, createGroundedState())
      const signedCoord = sign * axisCoord(state)
      const signedNearFace = sign * nearFace
      const clearance = signedNearFace - signedCoord

      // 핵심 Red 단언 — 오늘 구현(반경 미적용)은 clearance≈0이라 이 하한을
      // 만족하지 못한다. 반경이 도입되면 clearance≈bodyRadiusM(0.3m)이 되어
      // 통과한다.
      expect(clearance).toBeGreaterThanOrEqual(BODY_RADIUS_M - TOLERANCE_M)
      // 고착 아님 — 반경만큼 떨어지되, 근접면에서 훨씬 먼 곳에 멈춰서는 안
      // 된다(정지 전략은 규정하지 않지만 "밀착"이라는 명제 자체는 지켜야
      // 한다).
      expect(clearance).toBeLessThan(BODY_RADIUS_M + APPROACH_MARGIN_M)
      // 실제로 진행 방향으로 전진했다(0에서 못박힌 것이 아니다).
      expect(signedCoord).toBeGreaterThan(0)
    },
  )
})
