import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveInput, type MoveState } from '@shared/sim/movement'
import type { HitboxConfig } from '@shared/sim/combat'
import { AUDIO } from '@shared/constants'
import { CROUCH_HITBOX, DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { stepFootstepAccumulator } from '@shared/sim/footsteps'
import {
  computePlayerModelLayout,
  isRemoteMeshVisible,
  type PartBox,
  type PartSphere,
  type PlayerModelLayout,
  type Vec3Like,
} from '@client/scene/playerModelLayout'
import { gaitPhase01, stepGaitDistance } from '@client/scene/gaitPhase'
import { GAIT_TUNING } from '@client/config/player-model-tuning'

/**
 * RQ-73/ADR-0015(캐릭터 모델) — "배치·위상 계산" 층 단위 테스트(ADR-0015
 * 결정 5: 면제 없음, 순수 함수 + 값 단언). ADR-0011 결정 2 — 이 라운드는
 * test-after 영역(coder가 구현과 테스트를 함께 쓴다, test-writer 세션 없음,
 * 원장 24bz 착수 커밋). `tests/`에 대한 coder 변경은 순증(신규 파일·신규
 * `it`)만이고, 이 파일은 그린필드 신규 파일이라 그 규칙을 위반하지 않는다.
 *
 * **매핑된 골든**: GA-90~95(`harness/evals/golden/track-a-product.jsonl`).
 * GA-90~94는 원장 24bz 스펙 신설 라운드가 이미 적어 두었고(이 라운드가
 * `status: todo → done`으로 승격), GA-95는 이 라운드가 신설한다(이월 m5 —
 * "4파츠 모델도 GA-90~94를 전부 통과한다"는 구멍을 막는다). GA-90은 이
 * 라운드가 두 번째 반례를 추가한다(이월 D4).
 *
 * **이 파일이 다루지 않는 것(렌더 배선, ADR-0015 결정 5 면제)**:
 * `PlayerMeshes.tsx`의 `THREE.Mesh` 생성·`useFrame` 갱신·지오메트리
 * 공유·스윙 오프셋을 실제 mesh에 적용하는 코드. 이 파일이 고정하는 것은
 * 배치·위상 **값**뿐이다 — 값이 맞으면 배선은 코드 정독·스크린샷이 대신
 * 확인한다(`harness/workflow/fe.md`).
 */

// ---------------------------------------------------------------------------
// GA-90/91/92 헬퍼 — 히트 볼륨 내포·대칭 판정
// ---------------------------------------------------------------------------

/** `y > bodyTopM`이면 헤드 구체, 아니면(그리고 `y >= bodyBottomM`이면) 바디
 * 원통 — RQ-73 "히트박스 내포" 조항을 그대로 옮긴 판정(외접 원통이
 * **아니다**, ADR-0015 결정 2). 부동소수점 경계 비교에 작은 여유(`EPS`)를
 * 둔다 — 이 라운드가 만든 좌표는 경계에서 충분히 떨어져 있으므로(여유
 * 검산은 `player-model-tuning.ts`) `EPS`가 결과를 뒤집는 일은 없다. */
const EPS = 1e-9

function isPointWithinHitVolume(point: Vec3Like, hitbox: HitboxConfig): boolean {
  if (point.y > hitbox.bodyTopM) {
    const dx = point.x
    const dy = point.y - hitbox.headCenterM
    const dz = point.z
    return dx * dx + dy * dy + dz * dz <= hitbox.headRadiusM * hitbox.headRadiusM + EPS
  }
  if (point.y < hitbox.bodyBottomM - EPS) return false
  const horizontal = Math.hypot(point.x, point.z)
  return horizontal <= hitbox.bodyRadiusM + EPS
}

/** 축 정렬 상자의 8개 코너 — 컨테인먼트는 코너에서 가장 먼저 깨지므로
 * 코너만 확인하면 충분하다(볼록 도형인 히트 볼륨 각 구간(원통·구체) 안에
 * 상자가 있으려면 코너가 전부 안에 있으면 된다 — 상자의 다른 모든 점은
 * 코너들의 볼록결합이고, 원통·구체 둘 다 볼록 집합이다). */
function boxCorners(box: PartBox): Vec3Like[] {
  const corners: Vec3Like[] = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push({
          x: box.center.x + sx * box.halfExtents.x,
          y: box.center.y + sy * box.halfExtents.y,
          z: box.center.z + sz * box.halfExtents.z,
        })
      }
    }
  }
  return corners
}

/** 구체가 헤드 히트 구체 안에 완전히 들어있는지 — 두 구체의 중심 거리 +
 * 파츠 반지름이 헤드 반지름을 넘지 않으면 충분(구체-안-구체 표준 조건). */
function isSphereWithinHeadVolume(sphere: PartSphere, hitbox: HitboxConfig): boolean {
  const centerDist = Math.hypot(
    sphere.center.x,
    sphere.center.y - hitbox.headCenterM,
    sphere.center.z,
  )
  return centerDist + sphere.radius <= hitbox.headRadiusM + EPS
}

const BOX_PARTS: readonly (keyof PlayerModelLayout)[] = ['torso', 'armLeft', 'armRight', 'legLeft', 'legRight']

describe('RQ-73/GA-90: computePlayerModelLayout — 모든 파츠가 서버 히트 볼륨(바디 원통 ∪ 헤드 구체) 안이다', () => {
  it.each([
    ['run(선 자세)', DEFAULT_HITBOX],
    ['crouch(앉은 자세)', CROUCH_HITBOX],
  ])('GA-90: %s — 6파츠의 모든 경계점(코너)이 히트 볼륨 안이다', (_label, hitbox) => {
    const layout = computePlayerModelLayout(hitbox)

    expect(isSphereWithinHeadVolume(layout.head, hitbox)).toBe(true)

    for (const partName of BOX_PARTS) {
      const box = layout[partName] as PartBox
      for (const corner of boxCorners(box)) {
        expect(isPointWithinHitVolume(corner, hitbox)).toBe(true)
      }
    }
  })

  it('GA-90 반례 1 — 선 자세에서 높이 1.60m·중심에서 수평 0.25m인 점은 히트 볼륨 밖이다(외접 원통 오독을 걸러낸다)', () => {
    // 그 높이(1.60)는 bodyTopM(1.5)을 넘어 머리 구간이고, 실제 히트 반경은
    // headRadiusM(0.15)다 — 외접 원통(bodyRadiusM=0.3) 기준으로 읽으면 이
    // 점을 (잘못) 통과시킨다.
    const point: Vec3Like = { x: 0.25, y: 1.6, z: 0 }
    const naiveOuterCylinderAccepts = Math.hypot(point.x, point.z) <= DEFAULT_HITBOX.bodyRadiusM
    expect(naiveOuterCylinderAccepts).toBe(true) // 외접 원통 오독은 통과시킨다 — 그래서 이 반례가 필요했다

    expect(isPointWithinHitVolume(point, DEFAULT_HITBOX)).toBe(false) // 올바른(구체) 판정은 거부한다
  })

  it('GA-90 반례 2(원장 24bz 이월 D4) — 선 자세에서 높이 1.79m·중심에서 수평 0.14m인 점도 히트 볼륨 밖이다(「머리 구간 = headRadiusM 원통」 오독을 걸러낸다)', () => {
    // 반례 1은 외접 원통(반경 0.3) 오독과 구체(반경 0.15) 판정을 구별하지
    // 못한다 — 두 판정 모두 0.25 > 0.15라 거부한다. 이 반례는 「머리
    // 구간을 반경 headRadiusM(0.15)의 좁은 원통으로 읽는」 또 다른 오독과
    // 구별한다: 그 오독은 수평거리(0.14)만 보고 0.14<=0.15라 통과시키지만,
    // 실제 구체 판정은 높이 오프셋(1.79-1.65=0.14)까지 함께 고려해
    // 0.14²+0.14²=0.0392 > 0.15²=0.0225로 거부한다.
    const point: Vec3Like = { x: 0.14, y: 1.79, z: 0 }
    const naiveHeadCylinderAccepts = Math.hypot(point.x, point.z) <= DEFAULT_HITBOX.headRadiusM
    expect(naiveHeadCylinderAccepts).toBe(true) // 「머리=원통」 오독은 통과시킨다 — 그래서 D4가 필요했다

    expect(isPointWithinHitVolume(point, DEFAULT_HITBOX)).toBe(false) // 올바른(구체) 판정은 거부한다
  })
})

describe('RQ-73/GA-91: 자세 전환은 같은 틱 즉시다 — 보간(중간 배치) 없음', () => {
  it('GA-91: 순수 함수라 이전 호출을 기억하지 않는다 — run 다음에 crouch를 부른 결과와 crouch만 독립적으로 부른 결과가 정확히 같다', () => {
    computePlayerModelLayout(DEFAULT_HITBOX) // "직전 틱은 선 자세였다"를 흉내
    const crouchAfterRun = computePlayerModelLayout(CROUCH_HITBOX) // "이번 틱, 즉시 앉았다"
    const crouchDirect = computePlayerModelLayout(CROUCH_HITBOX) // 호출 이력 없이 독립 호출

    expect(crouchAfterRun).toEqual(crouchDirect)
  })

  it('GA-91: crouch 결과는 run과 crouch "사이"의 중간값이 아니라 crouch 그 자체다', () => {
    const runLayout = computePlayerModelLayout(DEFAULT_HITBOX)
    const crouchLayout = computePlayerModelLayout(CROUCH_HITBOX)

    expect(crouchLayout.legLeft.center.y).toBeLessThan(runLayout.legLeft.center.y)
    expect(crouchLayout.head.center.y).toBeCloseTo(CROUCH_HITBOX.headCenterM, 12)
    expect(crouchLayout.head.center.y).not.toBeCloseTo(runLayout.head.center.y, 3)
  })
})

// ---------------------------------------------------------------------------
// GA-92 헬퍼 — 전후(Z) 반전
// ---------------------------------------------------------------------------

function reflectZ(v: Vec3Like): Vec3Like {
  // `-0`을 피한다(`0`을 반전하면 `-0`이 나오고, 일부 매처가 `Object.is`
  // 기준으로 `0`과 `-0`을 다르게 볼 수 있다 — 방어적 정규화).
  return { x: v.x, y: v.y, z: v.z === 0 ? 0 : -v.z }
}

function reflectLayoutFrontBack(layout: PlayerModelLayout): PlayerModelLayout {
  return {
    head: { kind: 'sphere', center: reflectZ(layout.head.center), radius: layout.head.radius },
    torso: { kind: 'box', center: reflectZ(layout.torso.center), halfExtents: layout.torso.halfExtents },
    armLeft: { kind: 'box', center: reflectZ(layout.armLeft.center), halfExtents: layout.armLeft.halfExtents },
    armRight: { kind: 'box', center: reflectZ(layout.armRight.center), halfExtents: layout.armRight.halfExtents },
    legLeft: { kind: 'box', center: reflectZ(layout.legLeft.center), halfExtents: layout.legLeft.halfExtents },
    legRight: { kind: 'box', center: reflectZ(layout.legRight.center), halfExtents: layout.legRight.halfExtents },
  }
}

describe('RQ-73/GA-92: 배치는 앞뒤(Z) 대칭이다 — 방향을 시사하는 비대칭이 0건', () => {
  it.each([
    ['run', DEFAULT_HITBOX],
    ['crouch', CROUCH_HITBOX],
  ])('GA-92: %s 자세 — 배치를 전후 축으로 반전시키면 원본과 정확히 일치한다', (_label, hitbox) => {
    const layout = computePlayerModelLayout(hitbox)
    expect(reflectLayoutFrontBack(layout)).toEqual(layout)
  })
})

// ---------------------------------------------------------------------------
// GA-93/94 — 걸음 위상: 접지 수평 이동 거리 누적, 자세 무관, 프레임률 무관
// ---------------------------------------------------------------------------

const GROUNDED_RUN_INPUT: MoveInput = { dirX: 1, dirZ: 0, mode: 'run', jump: false }

function originState(): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true }
}

/** 실제 `stepMovement`를 `ticks`회 재생해 매 틱의 위치를 전부 뽑는다
 * (`sim-footsteps.test.ts`의 `driveReal` 선례와 동일한 이유 — 하드코딩된
 * 상수를 반복 가산하면 실제 이동 경로의 부동소수점 반올림 양상과 달라진다.
 * 이 파일은 위치 자체(중간 인덱스에서 구간을 잘라 다시 묶어야 하므로)가
 * 필요해 `deltas`가 아니라 전체 위치 배열을 반환한다). */
function driveRealPositions(state: MoveState, input: MoveInput, ticks: number): MoveState[] {
  const positions: MoveState[] = [state]
  let s = state
  for (let i = 0; i < ticks; i++) {
    s = stepMovement(s, input)
    positions.push(s)
  }
  return positions
}

function horizontalDelta(from: MoveState, to: MoveState): number {
  return Math.hypot(to.x - from.x, to.z - from.z)
}

describe('RQ-73/GA-93: gaitPhase01 — 걸음 위상은 누적 거리의 함수이지 갱신 횟수·프레임률의 함수가 아니다', () => {
  it('GA-93: 같은 경로(실측 6.0m)를 30회(30Hz) 갱신으로 진행한 결과와 20회(20Hz) 갱신으로 진행한 결과의 최종 위상이 같다', () => {
    // MOVEMENT.SPEED(6m/s) × 1초(30틱 × TICK_MS) ≈ 6.0m — 실측(전제 확인,
    // 아래)으로 고정한다.
    const positions = driveRealPositions(originState(), GROUNDED_RUN_INPUT, 30)
    const totalDistance = horizontalDelta(positions[0]!, positions[positions.length - 1]!)
    expect(totalDistance).toBeCloseTo(6.0, 6) // 전제 확인 — 30틱이 실제로 6.0m다

    // "30Hz" — 매 틱(30회) 하나씩 먹인다.
    let distance30 = 0
    for (let i = 1; i < positions.length; i++) {
      distance30 = stepGaitDistance(distance30, {
        wasGrounded: true,
        isGrounded: true,
        horizontalDeltaM: horizontalDelta(positions[i - 1]!, positions[i]!),
        discontinuous: false,
      })
    }

    // "20Hz" — 같은 30틱 경로를 20번의 갱신으로 묶어 먹인다(패턴 [2,1] ×
    // 10회 = 20묶음, 틱 합계 30). 직선 경로라 묶음 내 개별 델타의 합과
    // 묶음 양끝의 직접 거리 차가 (부동소수점 오차 이내로) 같다.
    const groupSizes = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 2 : 1))
    expect(groupSizes.reduce((a, b) => a + b, 0)).toBe(30) // 전제 확인 — 묶음 합이 원래 틱 수와 같다

    let distance20 = 0
    let index = 0
    for (const size of groupSizes) {
      distance20 = stepGaitDistance(distance20, {
        wasGrounded: true,
        isGrounded: true,
        horizontalDeltaM: horizontalDelta(positions[index]!, positions[index + size]!),
        discontinuous: false,
      })
      index += size
    }

    expect(distance20).toBeCloseTo(distance30, 6)
    expect(gaitPhase01(distance30, GAIT_TUNING.CYCLE_DISTANCE_M)).toBeCloseTo(
      gaitPhase01(distance20, GAIT_TUNING.CYCLE_DISTANCE_M),
      9,
    )
  })

  it('GA-93 경계 — 공중 구간(wasGrounded/isGrounded 어느 한쪽이라도 false)의 수평 변위는 누적되지 않는다', () => {
    const afterGround = stepGaitDistance(0, {
      wasGrounded: true,
      isGrounded: true,
      horizontalDeltaM: 1.0,
      discontinuous: false,
    })
    const afterJump = stepGaitDistance(afterGround, {
      wasGrounded: true,
      isGrounded: false, // 이함(도약) 틱
      horizontalDeltaM: 5.0,
      discontinuous: false,
    })
    expect(afterJump).toBe(afterGround) // 공중 변위는 새지 않는다
  })

  it('GA-93 리스폰 — discontinuous 틱은 누적을 0으로 되돌린다', () => {
    const before = stepGaitDistance(10, {
      wasGrounded: true,
      isGrounded: true,
      horizontalDeltaM: 999,
      discontinuous: true,
    })
    expect(before).toBe(0)
  })
})

describe("RQ-73/GA-94: mode='walk' 접지 이동 — 걸음 위상은 전진하지만 발소리(RQ-72)는 나지 않는다", () => {
  it('GA-94: 직전 발소리 누적 0m에서 walk로 수평 2.0m 이동 — 발소리는 0회(RQ-72는 run만 누적), 걸음 위상은 전진한다(ADR-0015 결정 4: 자세 무관 누적)', () => {
    const footstepResult = stepFootstepAccumulator(
      0,
      { wasGrounded: true, isGrounded: true, mode: 'walk', horizontalDeltaM: 2.0, discontinuous: false },
      AUDIO.FOOTSTEP_STRIDE_M,
    )
    expect(footstepResult.footstepCount).toBe(0)

    const gaitDistanceM = stepGaitDistance(0, {
      wasGrounded: true,
      isGrounded: true,
      horizontalDeltaM: 2.0,
      discontinuous: false,
    })
    expect(gaitDistanceM).toBe(2.0)

    const phaseBefore = gaitPhase01(0, GAIT_TUNING.CYCLE_DISTANCE_M)
    const phaseAfter = gaitPhase01(gaitDistanceM, GAIT_TUNING.CYCLE_DISTANCE_M)
    expect(phaseAfter).not.toBe(phaseBefore) // "전진했다"
  })
})

// ---------------------------------------------------------------------------
// GA-95(원장 24bz 이월 m5, 신설) — 파츠 수 6, 자기 자신 미렌더
// ---------------------------------------------------------------------------

describe('RQ-73/GA-95: 원격 1인의 모델은 정확히 6파츠이고, 자기 자신은 렌더 대상이 아니다', () => {
  it.each([
    ['run', DEFAULT_HITBOX],
    ['crouch', CROUCH_HITBOX],
  ])('GA-95: %s — computePlayerModelLayout이 정확히 6개의 이름 붙은 파츠(머리·몸통·팔2·다리2)를 반환한다', (_label, hitbox) => {
    const layout = computePlayerModelLayout(hitbox)
    const partNames = Object.keys(layout).sort()
    expect(partNames).toEqual(['armLeft', 'armRight', 'head', 'legLeft', 'legRight', 'torso'])
    expect(partNames).toHaveLength(6)
  })

  it('GA-95: 자기 자신의 세션은 렌더 대상이 아니고(false), 다른 세션은 렌더 대상이다(true)', () => {
    expect(isRemoteMeshVisible('self-session', 'self-session')).toBe(false)
    expect(isRemoteMeshVisible('other-session', 'self-session')).toBe(true)
    // 접속 초기(아직 selfSessionId가 서버로부터 확정되기 전) — null이면
    // 모두 렌더 대상이다(기존 PlayerMeshes.tsx 인라인 판정과 동일 근거).
    expect(isRemoteMeshVisible('any-session', null)).toBe(true)
  })
})
