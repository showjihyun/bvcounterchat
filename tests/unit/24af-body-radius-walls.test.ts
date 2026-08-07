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
 *
 * **REV(독립 평가 O1 대응, `_workspace/24af/03_evaluator_report.md` §8
 * O1) — 최종 틱 1점이 아니라 매 틱 최솟값을 단언한다.** 최초본은 100틱
 * 반복 후 **최종 상태 한 점**만 표본했다 — 평가자가 격리 워크트리에서
 * 심은 변이 M4(절단 **목표점**은 반경 적용 좌표로 두면서 **비교 조건**만
 * 원래 벽면으로 되돌리는 변형)가 이 표본 방식을 통과했다: M4의 실제
 * 동작은 틱 75에서 간극이 **0**(이 라운드가 고치려던 상태)을 찍은 뒤
 * `14.7 ↔ 14.9`로 2틱 주기 진동하는데, `TICKS=100`이 우연히 짝수 위상
 * (간극 0.3 쪽)에서 끝나 최종값만 보면 문제가 전혀 드러나지 않았다(홀수
 * 틱에서 끝났다면 간극 0.1로 실패했을 것 — 평가자 실측). 이제
 * `runTicksTrackingMinClearance`가 매 틱 간극을 계산해 **누적 최솟값**을
 * 반환하고, 그 최솟값에 하한(`>= bodyRadiusM`)을 건다 — 최종 틱의 간극은
 * 이 최솟값 집합의 원소 중 하나이므로 이 단언은 기존 단언보다 항상
 * **강하다**(약화 아님, CLAUDE.md 규칙). 진동이 있으면 어느 틱에서든
 * 최솟값이 그 저점을 잡아낸다 — 표본 위상에 더 이상 의존하지 않는다.
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

/** 매 틱 간극(`signedNearFace - sign*axisCoord(state)`)을 계산해 **누적
 * 최솟값**과 최종 상태를 함께 반환한다(O1 대응 — 위 파일 docblock REV
 * 절 참고). 최종 상태만 보는 것보다 항상 더 엄격하다: 진동·일시적 침범이
 * 있으면 그 저점이 `minClearance`에 반영된다. */
function runTicksTrackingMinClearance(
  input: MoveInput,
  ticks: number,
  initial: MoveState,
  axisCoord: (s: MoveState) => number,
  signedNearFace: number,
  sign: 1 | -1,
): { finalState: MoveState; minClearance: number } {
  let state = initial
  const geometry: StaticGeometry = { walls: PRODUCTION_WALLS, boxes: [], ladders: [] }
  let minClearance = Number.POSITIVE_INFINITY
  for (let i = 0; i < ticks; i += 1) {
    state = stepMovement(state, input, geometry)
    const clearance = signedNearFace - sign * axisCoord(state)
    if (clearance < minClearance) minClearance = clearance
  }
  return { finalState: state, minClearance }
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
    '24af/RQ-30/RQ-20: 벽($label) 방향으로 지속 이동하는 동안(100틱, 매 틱 관측) 중심-근접면 간극이 한 순간도 bodyRadiusM(0.3m) 미만으로 좁혀지지 않는다',
    ({ input, axisCoord, nearFace, sign }) => {
      const signedNearFace = sign * nearFace
      const { finalState, minClearance } = runTicksTrackingMinClearance(
        input,
        TICKS,
        createGroundedState(),
        axisCoord,
        signedNearFace,
        sign,
      )

      // 핵심 단언(O1 대응) — 100틱 **전체**에서 관측된 간극의 최솟값이
      // 반경 미만으로 내려간 적이 없다. 오늘(반경 미적용) 구현은 물론,
      // "목표점은 반경 적용, 비교 조건은 원래 벽면"처럼 진동을 유발하는
      // 부분 수정도 이 최솟값 단언이 저점을 그대로 잡는다(최종 틱 1점
      // 표본으로는 우연한 위상에서 진동을 놓칠 수 있었다 — 위 파일
      // docblock REV 절 참고).
      expect(minClearance).toBeGreaterThanOrEqual(BODY_RADIUS_M - TOLERANCE_M)
      // 고착 아님 — 반경만큼 떨어지되, 근접면에서 훨씬 먼 곳에 멈춰서는 안
      // 된다(정지 전략은 규정하지 않지만 "밀착"이라는 명제 자체는 지켜야
      // 한다).
      expect(minClearance).toBeLessThan(BODY_RADIUS_M + APPROACH_MARGIN_M)
      // 실제로 진행 방향으로 전진했다(0에서 못박힌 것이 아니다).
      expect(sign * axisCoord(finalState)).toBeGreaterThan(0)
    },
  )
})
