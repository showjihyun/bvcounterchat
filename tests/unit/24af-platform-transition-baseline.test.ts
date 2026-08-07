import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveInput, type MoveState } from '@shared/sim/movement'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'
import { LADDER_ALPHA } from '@shared/sim/ladders'
import { PLATFORM_ALPHA } from '@shared/sim/platforms'

/**
 * 원장 24af 명제 4(실측 대상, GA-59) — 몸 반경 도입 후에도 사다리 꼭대기
 * → 인접 플랫폼 옆걸음 전이(RQ-33)가 살아 있는가.
 *
 * **왜 단위 레벨에서 재현하는가**: 기존 GA-59 검증
 * (`tests/integration/rq-33-platform-reach.test.ts`)은 실 서버·실
 * WebSocket을 띄우는 통합 테스트라 무겁고, 이 파일이 묻는 질문("전이가
 * 여전히 성공하는가")은 순수히 `stepMovement`/`PRODUCTION_GEOMETRY`
 * 산술로 답이 결정된다 — `rq-33-platform-reach.test.ts`가 화이트박스로
 * 관측하는 것과 동일한 정본(`moveStates`)이 바로 이 `stepMovement`의
 * 반환값이다(`GameRoom.stepPlayerMovement`가 그대로 그 값을 쓴다,
 * `src/server/rooms/GameRoom.ts` 실측). 이 파일은 그 통합 테스트를
 * **대체하지 않는다** — 더 빠른 회귀 가드를 하나 추가할 뿐이다(통합
 * 테스트는 손대지 않았다).
 *
 * **구조적 분석(실측으로 확인, 추정 아님)** — 이 파일의 실행 결과가
 * 근거다: `stepOntoPlatform`(`movement.ts`)이 계산하는 진입 위치
 * (`boundaryState`)는 `y: platform.topY`로 **이미 플랫폼 높이에 서 있는
 * 상태**로 합성된다. `boxesBlockingAt`은 `y < box.topY`인 박스만
 * 차단 목록에 넣으므로(`movement.ts` 378-380행), `y === platform.topY`인
 * 이 순간 플랫폼 자신은 애초에 차단 목록에 들지 않는다 — 즉 반경이
 * `clampAgainstWalls`(옆면 차단, y<topY 전용)에만 적용되고 원장 24af
 * 명제 2가 요구하는 대로 "윗면 계약"(y>=topY는 차단 없음)이 유지되는 한,
 * **이 전이 경로 자체는 반경 도입의 영향권 밖**이다 — `PLATFORM_ENTRY
 * _MARGIN_M`(0.2m)과 `bodyRadiusM`(0.3m)의 대소 관계는 이 특정 전이의
 * 성패를 좌우하지 않는다(진입 여유는 "플랫폼의 열린 구간 안쪽에 확실히
 * 떨어뜨린다"는 목적이지, 반경 기반 차단을 피하는 목적이 아니다 — 애초에
 * 이 높이에서는 차단이 발동하지 않는다).
 *
 * **이 파일이 지금 Red가 아닌 이유**: 오늘(반경 미도입) 기준 동작을 그대로
 * 검증하므로 현재 Green이다 — 명제 1·2처럼 "아직 없는 동작"을 요구하지
 * 않는다. **기준선(baseline) 확정 + 회귀 가드**가 목적이다: coder가 반경을
 * 구현한 뒤 이 파일이 계속 Green이어야 위 구조적 분석이 실제로도 성립함이
 * 확인된다 — Red로 바뀌면 구현이 위 분석의 전제(윗면 계약 유지)를 깼다는
 * 신호다.
 *
 * **좌표(ADR-0010)**: `PRODUCTION_GEOMETRY`(`@shared/sim/geometry`)·
 * `LADDER_ALPHA`·`PLATFORM_ALPHA` 정본을 그대로 읽는다.
 *
 * **결정론(ADR-0008)**: 순수 산술, 정수 틱 반복만 사용한다.
 */

describe('24af 명제 4(실측, GA-59 기준선) — 사다리 하단에서 등반 입력을 유지하면 플랫폼 윗면에 도달한다(단위 레벨 재현)', () => {
  const LADDER_CENTER_X = (LADDER_ALPHA.minX + LADDER_ALPHA.maxX) / 2
  const LADDER_CENTER_Z = (LADDER_ALPHA.minZ + LADDER_ALPHA.maxZ) / 2
  /** 등반 법선 방향 입력 — 리터럴 하드코딩 대신 `LADDER_ALPHA.normalX/normalZ`에서
   * 유도한다(ADR-0010). */
  const CLIMB_TOWARD_FACE: MoveInput = { dirX: LADDER_ALPHA.normalX, dirZ: LADDER_ALPHA.normalZ, mode: 'run', jump: false }
  /** 사다리 최하단(minY=0)~꼭대기(maxY=4m)를 3m/s(앉기 속도)로 오르는 데
   * 필요한 최소 40틱(`rq-62-prediction.test.ts`의 동일 시나리오 TICKS=40과
   * 같은 근거, 단 그 파일은 y=1에서 시작해 30틱이면 충분했던 것과 달리 이
   * 파일은 GA-59 given 그대로 최하단(y=0)에서 시작하므로 여유를 더 얹는다)
   * + 전이·정착 여유. */
  const TICKS = 50

  it('24af/RQ-33/GA-59: PRODUCTION_GEOMETRY로 사다리 하단→플랫폼 전이가 (반경 도입 전 기준) 성공한다', () => {
    let state: MoveState = { x: LADDER_CENTER_X, y: LADDER_ALPHA.minY, z: LADDER_CENTER_Z, vx: 0, vy: 0, vz: 0, grounded: true }

    let reachedPlatform = false
    for (let i = 0; i < TICKS; i += 1) {
      state = stepMovement(state, CLIMB_TOWARD_FACE, PRODUCTION_GEOMETRY)
      if (state.grounded && state.y >= PLATFORM_ALPHA.topY - 1e-6) {
        reachedPlatform = true
      }
    }

    // 전제 확인 — 실제로 상승이 있었다(즉시 어딘가에 막혀 y=0에 머문 것이
    // 아니다).
    expect(state.y).toBeGreaterThan(LADDER_ALPHA.minY)

    expect(reachedPlatform).toBe(true)
    expect(state.grounded).toBe(true)
    expect(state.y).toBeCloseTo(PLATFORM_ALPHA.topY, 6)
    // 실제로 플랫폼의 XZ 범위 위에서 서 있다(사다리 자신의 좌표가 아니다).
    expect(state.x).toBeGreaterThanOrEqual(PLATFORM_ALPHA.minX - 1e-6)
    expect(state.x).toBeLessThanOrEqual(PLATFORM_ALPHA.maxX + 1e-6)
  })
})
