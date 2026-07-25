import { describe, expect, it } from 'vitest'
import {
  PITCH_LIMIT_RAD,
  accumulateLook,
  clampPitch,
  normalizeYaw,
  rotateLocalMoveDirection,
  yawPitchToDirection,
} from '@client/input/aimMath'

/**
 * 22b — 마우스 룩 순수 산술 (RQ-12 클라 측 조준, RQ-20 이동 방향 회전).
 *
 * ADR-0011 선별 Red의 **test-after 라운드**다 — 클라이언트 모듈이라
 * 구현과 테스트를 같은 PR에서 함께 작성했다(Red-first 아님). 그 대신
 * 검증은 격리 세션의 평가·리뷰가 맡는다.
 *
 * 렌더·DOM 배선(`mouseLook.ts`·`PlayerControls.tsx`)은 `harness/workflow
 * /fe.md`의 면제 대상이라 여기서 다루지 않는다 — 이 파일은 그 배선이
 * 호출하는 **순수 함수**만 검증한다.
 *
 * 좌표계 전제(`aimMath.ts` 상단 코멘트와 동일): yaw=pitch=0일 때 정면은
 * -Z, yaw는 +Y축 기준(왼쪽으로 도는 방향이 +), pitch는 위가 +.
 */

/** 부동소수점 삼각함수 비교 허용 오차 — 배정밀도 sin/cos 오차보다 훨씬 크다. */
const EPS = 1e-12

function length3(v: { dirX: number; dirY: number; dirZ: number }): number {
  return Math.hypot(v.dirX, v.dirY, v.dirZ)
}

describe('22b clampPitch — 짐벌 뒤집힘 방지', () => {
  it('한계 안의 pitch는 그대로 통과한다', () => {
    expect(clampPitch(0)).toBe(0)
    expect(clampPitch(0.5)).toBe(0.5)
    expect(clampPitch(-0.5)).toBe(-0.5)
  })

  it('위·아래 한계를 넘는 pitch는 ±PITCH_LIMIT_RAD로 잘린다 (±90°에 닿지 않는다)', () => {
    expect(clampPitch(Math.PI)).toBe(PITCH_LIMIT_RAD)
    expect(clampPitch(-Math.PI)).toBe(-PITCH_LIMIT_RAD)
    // 특이점(정확히 ±90°)에 닿지 않아야 yaw축 정의가 유지된다
    expect(PITCH_LIMIT_RAD).toBeLessThan(Math.PI / 2)
    expect(clampPitch(Math.PI / 2)).toBeLessThan(Math.PI / 2)
  })

  it('유한하지 않은 값은 0(수평)으로 취급한다', () => {
    expect(clampPitch(Number.NaN)).toBe(0)
    expect(clampPitch(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampPitch(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe('22b normalizeYaw — 무한 누적 방지', () => {
  it('(-π, π] 안의 yaw는 그대로 통과한다', () => {
    expect(normalizeYaw(0)).toBe(0)
    expect(normalizeYaw(1)).toBe(1)
    expect(normalizeYaw(-1)).toBe(-1)
    expect(normalizeYaw(Math.PI)).toBeCloseTo(Math.PI, 12)
  })

  it('범위를 벗어난 yaw는 같은 방향을 가리키는 등가 각도로 되접힌다', () => {
    // 2π 회전은 제자리 — 되접은 뒤 방향 벡터가 동일해야 한다
    const wrapped = normalizeYaw(1 + Math.PI * 2 * 3)
    expect(wrapped).toBeCloseTo(1, 12)
    expect(Math.abs(wrapped)).toBeLessThanOrEqual(Math.PI)

    const negative = normalizeYaw(-1 - Math.PI * 2 * 3)
    expect(negative).toBeCloseTo(-1, 12)
    expect(Math.abs(negative)).toBeLessThanOrEqual(Math.PI)
  })

  it('유한하지 않은 값은 0으로 취급한다', () => {
    expect(normalizeYaw(Number.NaN)).toBe(0)
    expect(normalizeYaw(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('22b yawPitchToDirection — 조준 방향 벡터 (fire 페이로드)', () => {
  it('yaw=0·pitch=0이면 정면 -Z를 가리킨다', () => {
    const dir = yawPitchToDirection(0, 0)
    expect(dir.dirX).toBeCloseTo(0, 12)
    expect(dir.dirY).toBeCloseTo(0, 12)
    expect(dir.dirZ).toBeCloseTo(-1, 12)
  })

  it('yaw +90°는 -X, yaw -90°는 +X를 가리킨다 (마우스 오른쪽 이동이 yaw를 줄이므로 오른쪽 = +X)', () => {
    const left = yawPitchToDirection(Math.PI / 2, 0)
    expect(left.dirX).toBeCloseTo(-1, 12)
    expect(left.dirZ).toBeCloseTo(0, 12)

    const right = yawPitchToDirection(-Math.PI / 2, 0)
    expect(right.dirX).toBeCloseTo(1, 12)
    expect(right.dirZ).toBeCloseTo(0, 12)
  })

  it('yaw 180°는 뒤(+Z)를 가리킨다', () => {
    const back = yawPitchToDirection(Math.PI, 0)
    expect(back.dirZ).toBeCloseTo(1, 12)
    expect(back.dirX).toBeCloseTo(0, 12)
  })

  it('pitch가 양수면 위(+Y), 음수면 아래(-Y)를 향한다', () => {
    expect(yawPitchToDirection(0, PITCH_LIMIT_RAD).dirY).toBeGreaterThan(0.99)
    expect(yawPitchToDirection(0, -PITCH_LIMIT_RAD).dirY).toBeLessThan(-0.99)
  })

  it('어떤 yaw·pitch 조합에서도 단위 벡터다 (서버 레이 방향이 정규화를 전제한다)', () => {
    for (let yawStep = -8; yawStep <= 8; yawStep += 1) {
      for (let pitchStep = -4; pitchStep <= 4; pitchStep += 1) {
        const yaw = (yawStep / 8) * Math.PI
        const pitch = (pitchStep / 4) * PITCH_LIMIT_RAD
        expect(length3(yawPitchToDirection(yaw, pitch))).toBeCloseTo(1, 12)
      }
    }
  })
})

describe('22b rotateLocalMoveDirection — WASD를 yaw 기준 월드 방향으로', () => {
  it('yaw=0에서 전진(local dirZ=1)은 월드 -Z다 (정면과 같은 방향)', () => {
    const world = rotateLocalMoveDirection({ dirX: 0, dirZ: 1 }, 0)
    expect(world.dirX).toBeCloseTo(0, 12)
    expect(world.dirZ).toBeCloseTo(-1, 12)
  })

  it('yaw=0에서 우측 이동(local dirX=1)은 월드 +X다', () => {
    const world = rotateLocalMoveDirection({ dirX: 1, dirZ: 0 }, 0)
    expect(world.dirX).toBeCloseTo(1, 12)
    expect(world.dirZ).toBeCloseTo(0, 12)
  })

  it('전진 방향이 항상 조준 방향의 수평 성분과 일치한다 (보는 곳으로 걷는다 — 22b 핵심 계약)', () => {
    for (let step = -8; step <= 8; step += 1) {
      const yaw = (step / 8) * Math.PI
      const moved = rotateLocalMoveDirection({ dirX: 0, dirZ: 1 }, yaw)
      const aimed = yawPitchToDirection(yaw, 0)
      expect(moved.dirX).toBeCloseTo(aimed.dirX, 12)
      expect(moved.dirZ).toBeCloseTo(aimed.dirZ, 12)
    }
  })

  it('회전은 입력 크기를 보존한다 — 대각 입력(√2)도 그대로 (클램프는 stepMovement 책임)', () => {
    const diagonal = { dirX: 1, dirZ: 1 }
    const expected = Math.hypot(diagonal.dirX, diagonal.dirZ)
    for (let step = -8; step <= 8; step += 1) {
      const yaw = (step / 8) * Math.PI
      const world = rotateLocalMoveDirection(diagonal, yaw)
      expect(Math.hypot(world.dirX, world.dirZ)).toBeCloseTo(expected, 12)
    }
  })

  it('정지 입력(0,0)은 어떤 yaw에서도 정지다', () => {
    for (let step = -4; step <= 4; step += 1) {
      const world = rotateLocalMoveDirection({ dirX: 0, dirZ: 0 }, (step / 4) * Math.PI)
      expect(Math.abs(world.dirX)).toBeLessThan(EPS)
      expect(Math.abs(world.dirZ)).toBeLessThan(EPS)
    }
  })
})

describe('22b accumulateLook — 마우스 이동량 누적', () => {
  const SENS = 0.002

  it('마우스를 오른쪽으로 움직이면 yaw가 감소한다 (시야가 오른쪽으로 돈다)', () => {
    const next = accumulateLook({ yaw: 0, pitch: 0 }, 100, 0, SENS)
    expect(next.yaw).toBeCloseTo(-0.2, 12)
    expect(next.pitch).toBe(0)
  })

  it('마우스를 아래로 움직이면 pitch가 감소한다 (아래를 본다 — Y축 반전 없음)', () => {
    const next = accumulateLook({ yaw: 0, pitch: 0 }, 0, 100, SENS)
    expect(next.pitch).toBeCloseTo(-0.2, 12)
    expect(next.yaw).toBe(0)
  })

  it('누적된 pitch는 한계를 넘지 않는다 (계속 위로 밀어도 ±PITCH_LIMIT_RAD)', () => {
    let angles = { yaw: 0, pitch: 0 }
    for (let i = 0; i < 100; i += 1) {
      angles = accumulateLook(angles, 0, -100, SENS)
    }
    expect(angles.pitch).toBe(PITCH_LIMIT_RAD)

    for (let i = 0; i < 200; i += 1) {
      angles = accumulateLook(angles, 0, 100, SENS)
    }
    expect(angles.pitch).toBe(-PITCH_LIMIT_RAD)
  })

  it('yaw는 계속 돌려도 (-π, π] 안에 유지된다 (부동소수점 정밀도 위생)', () => {
    let angles = { yaw: 0, pitch: 0 }
    for (let i = 0; i < 500; i += 1) {
      angles = accumulateLook(angles, 1000, 0, SENS)
      expect(Math.abs(angles.yaw)).toBeLessThanOrEqual(Math.PI)
    }
  })

  it('같은 입력이면 항상 같은 출력이다 — 순수 함수 (입력 객체를 변형하지 않는다)', () => {
    const current = { yaw: 0.3, pitch: 0.1 }
    const first = accumulateLook(current, 10, -5, SENS)
    const second = accumulateLook(current, 10, -5, SENS)
    expect(first).toEqual(second)
    expect(current).toEqual({ yaw: 0.3, pitch: 0.1 })
  })
})
