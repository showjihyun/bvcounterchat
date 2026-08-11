import { describe, expect, it } from 'vitest'
import { stepMovement, type MoveInput, type MoveState } from '@shared/sim/movement'
import type { HitboxConfig } from '@shared/sim/combat'
import { AUDIO, NET } from '@shared/constants'
import { CROUCH_HITBOX, DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { stepFootstepAccumulator } from '@shared/sim/footsteps'
import {
  applyGaitSwingInto,
  computePlayerModelLayout,
  isRemoteMeshVisible,
  type PartBox,
  type PartSphere,
  type PlayerModelLayout,
  type Vec3Like,
} from '@client/scene/playerModelLayout'
import { gaitPhase01, resolveRemoteGaitPhase01, stepGaitDistance } from '@client/scene/gaitPhase'
import { GAIT_TUNING } from '@client/config/player-model-tuning'
import { createRemoteEntityInterpolator, type RemoteSnapshot } from '@client/net/interpolation'
import { remoteMeshHeightM } from '@client/scene/remoteMeshHeight'

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
 * `PlayerMeshes.tsx`의 `THREE.Mesh` 생성·`useFrame` 갱신. 이 파일이
 * 고정하는 것은 배치·위상 **값**뿐이다 — 값이 맞으면 배선은 코드 정독·
 * 스크린샷이 대신 확인한다(`harness/workflow/fe.md`).
 *
 * ⚠️ **REV(독립 평가 FAIL, `_workspace/RQ-73/03_evaluator_report.md`) —
 * 아래 세 절을 추가했다(전부 순증, 기존 단언 무변경).** 평가가 격리
 * 워크트리에서 검출력 변이를 심어 확인한 공백:
 * - **F1**: `getGaitDistance`(`@client/net/interpolation`)를 부르는 테스트가
 *   0건이었다 — `stepGaitDistance`에 `mode` 인자가 없어 "자세 무관 누적"을
 *   실제로 판별할 지점이 그 호출부뿐인데 비어 있었다(변이 M3 무검출:
 *   `advanceGaitAccumulator`에 `mode!=='run'` 필터를 넣어도 통과). 같은
 *   층위 결정("어느 접근자를 쓰는가")이 `PlayerMeshes.tsx`(렌더 배선, 면제)
 *   안에만 있어 `getFootstepCount`로 바꿔치기해도 통과했다(변이 M8). 이
 *   결정을 `resolveRemoteGaitPhase01`(`@client/scene/gaitPhase`, 순수
 *   함수)로 뽑아 값으로 단언한다.
 * - **F2**: RQ-73 "히트박스 내포"는 자세·애니메이션 예외가 없는데 스윙을
 *   포함한 좌표는 값으로 단언되지 않았다(변이 M4 무검출: 다리 스윙 진폭을
 *   0.1→5.0m로 바꿔도 통과). 스윙 산술을 `applyGaitSwingInto`(순수 함수,
 *   `@client/scene/playerModelLayout`)로 뽑아 여러 위상 표본에서 코너
 *   내포를 단언한다.
 * - **F3**: `remoteMeshHeightM`(RQ-92, `@client/scene/remoteMeshHeight`)이
 *   더 이상 프로덕션에서 호출되지 않아 그 값을 검증하는 GA-72·GA-75가
 *   실물에서 분리됐다 — 모델 머리 상단과의 동치를 값으로 다시 연결한다.
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

// ---------------------------------------------------------------------------
// 평가 F1(원장 24bz 재호출) — getGaitDistance: 원격 배선(interpolation.ts)
// 계약. `stepGaitDistance`(순수 함수)는 이미 GA-93/94 위에서 직접
// 시험했지만, "자세 무관 누적"이 실제 배선(`advanceGaitAccumulator`)에서도
// 성립하는지, 그리고 "어느 접근자를 쓰는가"(`resolveRemoteGaitPhase01`)가
// `getFootstepCount`로 새지 않는지는 아무도 판별하지 않았다(평가 F1,
// 변이 M3·M8).
// ---------------------------------------------------------------------------

const SELF = 'self-session'
const REMOTE = 'remote-1'
const GAIT_INTERPOLATOR_DELAY_MS = 50

const GROUNDED_WALK_INPUT: MoveInput = { dirX: 1, dirZ: 0, mode: 'walk', jump: false }
const GROUNDED_CROUCH_INPUT: MoveInput = { dirX: 1, dirZ: 0, mode: 'crouch', jump: false }

/** 실제 `stepMovement`를 재생해 `RemoteSnapshot` 열을 만든다(원본:
 * `rq-72-remote-footsteps.test.ts`의 `buildCornerPathSnapshots`와 동일한
 * 이유 — 실제 위치 델타의 부동소수점 양상을 그대로 쓴다). 항상 접지·같은
 * `mode`로만 이동하는 단순 경로(직선)라 GA-93처럼 코너를 낼 필요가 없다. */
function buildGaitSnapshots(input: MoveInput, ticks: number): RemoteSnapshot[] {
  const snapshots: RemoteSnapshot[] = []
  let s: MoveState = originState()
  snapshots.push({ x: s.x, y: s.y, z: s.z, receivedAt: 0, mode: input.mode, grounded: true })
  for (let i = 1; i <= ticks; i++) {
    s = stepMovement(s, input)
    snapshots.push({ x: s.x, y: s.y, z: s.z, receivedAt: i * NET.TICK_MS, mode: input.mode, grounded: true })
  }
  return snapshots
}

describe('RQ-73(평가 F1): getGaitDistance/resolveRemoteGaitPhase01 — 원격 배선의 자세 무관 누적', () => {
  it.each([
    ['walk', GROUNDED_WALK_INPUT],
    ['crouch', GROUNDED_CROUCH_INPUT],
  ])(
    '평가 F1: mode=%s로 접지 이동해도 getGaitDistance가 0보다 커진다(자세 필터가 있으면 이 값이 0에 머문다 — 변이 M3)',
    (_label, input) => {
      const snapshots = buildGaitSnapshots(input, 10)
      const interpolator = createRemoteEntityInterpolator(SELF, GAIT_INTERPOLATOR_DELAY_MS)
      for (const snapshot of snapshots) interpolator.addSnapshot(REMOTE, snapshot)

      expect(interpolator.getGaitDistance(REMOTE)).toBeGreaterThan(0)
    },
  )

  it('평가 F1: 같은 이동 경로에 mode 라벨만 다르게 붙이면 getGaitDistance는 같지만(자세 무관) getFootstepCount는 다르다(RQ-72는 run만) — ADR-0015 결정 4 "갈리는 것이 의도다"', () => {
    // 20틱 — `sim-footsteps.test.ts`가 실측한 것과 같은 이유(실제
    // stepMovement 델타의 부동소수점 누적 양상): 10틱(≈2.0m)만으로는
    // 누적이 2.0m 문턱에 아직 못 미친다(11번째 틱에서야 첫 발화). 발소리
    // 1회 이상을 확실히 관측하려면 20틱이 필요하다.
    const runSnapshots = buildGaitSnapshots(GROUNDED_RUN_INPUT, 20)
    // 같은 좌표 열에 mode만 'walk'로 다시 라벨링한다 — 실제 walk 속도로
    // 재시뮬레이션하면 이동 거리 자체가 달라 "자세만 갈랐을 때" 대조가
    // 흐려진다.
    const walkSnapshots: RemoteSnapshot[] = runSnapshots.map((snapshot) => ({ ...snapshot, mode: 'walk' }))

    const runInterpolator = createRemoteEntityInterpolator(SELF, GAIT_INTERPOLATOR_DELAY_MS)
    for (const snapshot of runSnapshots) runInterpolator.addSnapshot(REMOTE, snapshot)

    const walkInterpolator = createRemoteEntityInterpolator(SELF, GAIT_INTERPOLATOR_DELAY_MS)
    for (const snapshot of walkSnapshots) walkInterpolator.addSnapshot(REMOTE, snapshot)

    const runGaitDistance = runInterpolator.getGaitDistance(REMOTE)
    const walkGaitDistance = walkInterpolator.getGaitDistance(REMOTE)
    expect(runGaitDistance).toBeDefined()
    expect(walkGaitDistance).toBeCloseTo(runGaitDistance!, 9) // 걸음 위상 소스는 같다

    expect(runInterpolator.getFootstepCount(REMOTE)).toBeGreaterThan(0) // run은 발소리가 난다
    expect(walkInterpolator.getFootstepCount(REMOTE)).toBe(0) // walk는 발소리가 0회다 — 여기서 갈린다
  })

  it('평가 F1(GA-83 대응): getGaitDistance는 폴링 빈도·조회 시 renderTime과 무관하다 — addSnapshot 횟수에만 반응한다', () => {
    const snapshots = buildGaitSnapshots(GROUNDED_WALK_INPUT, 12)
    const interpolatorA = createRemoteEntityInterpolator(SELF, GAIT_INTERPOLATOR_DELAY_MS)
    const interpolatorB = createRemoteEntityInterpolator(SELF, GAIT_INTERPOLATOR_DELAY_MS)

    for (let i = 0; i < snapshots.length; i++) {
      interpolatorA.addSnapshot(REMOTE, snapshots[i]!)
      interpolatorB.addSnapshot(REMOTE, snapshots[i]!)

      // A는 매 스냅샷마다 폴링하고, 그때마다 무관한 renderTime으로
      // getMode도 함께 조회한다(위치·자세 조회가 걸음 누적에 새어들지
      // 않는지 함께 본다). B는 3개마다 1번만 폴링한다.
      interpolatorA.getGaitDistance(REMOTE)
      interpolatorA.getMode(REMOTE, snapshots[i]!.receivedAt + 10_000)
      if (i % 3 === 2) {
        interpolatorB.getGaitDistance(REMOTE)
      }
    }

    expect(interpolatorA.getGaitDistance(REMOTE)).toBeCloseTo(interpolatorB.getGaitDistance(REMOTE)!, 9)
  })

  it('평가 F1: 리스폰(hp 0→MAX) 스냅샷에서 getGaitDistance가 0으로 리셋되고, 자기 세션 조회는 undefined다(GA-39와 동일 계약)', () => {
    const interpolator = createRemoteEntityInterpolator(SELF, GAIT_INTERPOLATOR_DELAY_MS)
    interpolator.addSnapshot(REMOTE, { x: 0, y: 0, z: 0, receivedAt: 0, mode: 'run', grounded: true, hp: 100 })
    interpolator.addSnapshot(REMOTE, { x: 5, y: 0, z: 0, receivedAt: 100, mode: 'run', grounded: true, hp: 0 }) // 사망
    expect(interpolator.getGaitDistance(REMOTE)).toBeGreaterThan(0)

    // 리스폰 — 좌표가 순간이동하고 hp가 0 → MAX_HP로 바뀐다.
    interpolator.addSnapshot(REMOTE, { x: -20, y: 0, z: 30, receivedAt: 200, mode: 'run', grounded: true, hp: 100 })
    expect(interpolator.getGaitDistance(REMOTE)).toBe(0)

    expect(interpolator.getGaitDistance(SELF)).toBeUndefined()
  })

  it('평가 F1(변이 M8 방어) — resolveRemoteGaitPhase01은 getGaitDistance에서 위상을 유도한다: walk 이동에서 위상이 0보다 크다(발소리 전용 접근자를 썼다면 0에 머문다)', () => {
    const snapshots = buildGaitSnapshots(GROUNDED_WALK_INPUT, 10)
    const interpolator = createRemoteEntityInterpolator(SELF, GAIT_INTERPOLATOR_DELAY_MS)
    for (const snapshot of snapshots) interpolator.addSnapshot(REMOTE, snapshot)

    const phase = resolveRemoteGaitPhase01(interpolator, REMOTE, GAIT_TUNING.CYCLE_DISTANCE_M)
    expect(phase).toBeGreaterThan(0)
    // 대조 — 발소리 전용 접근자(getFootstepCount)를 썼다면 walk에서 이
    // 값이 0이라 위상도 0에 머물렀을 것이다.
    expect(interpolator.getFootstepCount(REMOTE)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 평가 F2(원장 24bz 재호출) — applyGaitSwingInto: 스윙을 포함해도 히트
// 볼륨 내포가 유지된다. RQ-73 "히트박스 내포"는 자세·애니메이션 예외를
// 두지 않는다(변이 M4: 다리 스윙 진폭 0.1→5.0m가 무검출이었다).
// ---------------------------------------------------------------------------

describe('RQ-73(평가 F2): applyGaitSwingInto — 스윙(걷기 애니메이션)을 포함해도 모든 파츠가 히트 볼륨 안이다', () => {
  it.each([
    ['run(선 자세)', DEFAULT_HITBOX],
    ['crouch(앉은 자세)', CROUCH_HITBOX],
  ])('평가 F2: %s — 위상 0·0.25·0.5·0.75(스윙 진폭이 0·+최대·0·-최대가 되는 지점)에서도 6파츠 전부 내포된다', (_label, hitbox) => {
    const layout = computePlayerModelLayout(hitbox)
    const swayed = computePlayerModelLayout(hitbox) // 임의 초기값 — applyGaitSwingInto가 매번 전부 덮어쓴다(useFrame 스크래치 버퍼와 동일한 사용법)

    for (const phase of [0, 0.25, 0.5, 0.75]) {
      applyGaitSwingInto(layout, phase, swayed)

      expect(isSphereWithinHeadVolume(swayed.head, hitbox)).toBe(true)
      for (const partName of BOX_PARTS) {
        const box = swayed[partName] as PartBox
        for (const corner of boxCorners(box)) {
          expect(isPointWithinHitVolume(corner, hitbox)).toBe(true)
        }
      }
    }
  })

  it('평가 F2 반례 — 다리 코너에 비정상적으로 큰 스윙 오프셋(5.0m 상당)이 있으면 컨테인먼트 판정이 실제로 거부한다(가드가 공허하지 않다는 자기 검증)', () => {
    const layout = computePlayerModelLayout(DEFAULT_HITBOX)
    const swayed = computePlayerModelLayout(DEFAULT_HITBOX)
    applyGaitSwingInto(layout, 0.25, swayed) // 정상 진폭(sin=1) — 위 테스트가 이미 내포를 확인했다

    // "진폭이 5.0m였다면"을 흉내낸다(변이 M4와 동일한 크기) — 정상 결과
    // 코너에 큰 오프셋을 더해 판정기가 실제로 무언가를 거르는지 본다.
    const inflatedCorner: Vec3Like = {
      x: swayed.legLeft.center.x,
      y: swayed.legLeft.center.y,
      z: swayed.legLeft.center.z + 5.0,
    }
    expect(isPointWithinHitVolume(inflatedCorner, DEFAULT_HITBOX)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 평가 F3(원장 24bz 재호출) — GA-72/75의 verify(`remoteMeshHeightM`)를
// 실물(computePlayerModelLayout)에 다시 연결한다. `remoteMeshHeightM`은
// 더 이상 프로덕션 소비처가 없다(RQ-73 6파츠 재작성 이후) — 두 골든이
// 지키려던 "메시 높이 = 히트박스 head top" 성질은 이제 이 동치로만
// 지켜진다.
// ---------------------------------------------------------------------------

describe('RQ-73(평가 F3): 모델 머리 상단은 remoteMeshHeightM과 같다', () => {
  it.each([
    ['run', DEFAULT_HITBOX, 'run' as const],
    ['crouch', CROUCH_HITBOX, 'crouch' as const],
  ])('평가 F3: %s — layout.head.center.y + layout.head.radius === remoteMeshHeightM(mode)', (_label, hitbox, mode) => {
    const layout = computePlayerModelLayout(hitbox)
    const modelHeadTopM = layout.head.center.y + layout.head.radius
    expect(modelHeadTopM).toBeCloseTo(remoteMeshHeightM(mode), 12)
  })
})
