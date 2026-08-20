import { describe, expect, it } from 'vitest'
import { targetPlacement } from '@client/scene/targetLayout'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'

/**
 * RQ-34 사격 연습용 과녁 배치(원장 24cw) — **골든 GA-127**이 이 파일을 `verify`로
 * 가리킨다. `targetPlacement`의 순수 산술만
 * 값으로 단언한다(렌더 계층 자체는 ADR-0008 §6 면제, `MapMeshes.tsx`가
 * `useFrame` 없이 이 함수를 정적으로 부른다).
 *
 * **기대값을 벽 좌표 리터럴로 적지 않는다**(ADR-0010, `24f-map-render-geometry
 * .test.ts`와 같은 관례) — `PRODUCTION_GEOMETRY.walls`에서 유도되는 관계만
 * 고정한다. 맵이 바뀌어도 이 파일은 "옛 맵을 지키는" 방향으로 거짓 실패하지
 * 않는다.
 */
describe('RQ-34: 과녁 배치 — 안쪽면 판정', () => {
  it('벽마다 과녁이 원점에 더 가까운 경계(안쪽면)에 놓인다 — 바깥면이 아니다', () => {
    for (const wall of PRODUCTION_GEOMETRY.walls) {
      const { center } = targetPlacement(wall, DEFAULT_HITBOX.eyeHeightM, 0)
      const thicknessOnX = wall.maxX - wall.minX < wall.maxZ - wall.minZ
      if (thicknessOnX) {
        const innerX = Math.abs(wall.minX) < Math.abs(wall.maxX) ? wall.minX : wall.maxX
        const outerX = innerX === wall.minX ? wall.maxX : wall.minX
        expect(center[0]).toBeCloseTo(innerX, 12)
        expect(Math.abs(center[0] - outerX)).toBeGreaterThan(0.5)
      } else {
        const innerZ = Math.abs(wall.minZ) < Math.abs(wall.maxZ) ? wall.minZ : wall.maxZ
        const outerZ = innerZ === wall.minZ ? wall.maxZ : wall.minZ
        expect(center[2]).toBeCloseTo(innerZ, 12)
        expect(Math.abs(center[2] - outerZ)).toBeGreaterThan(0.5)
      }
    }
  })

  it('과녁의 폭 축 좌표는 벽 폭의 중점이다 — 벽 끝으로 쏠리지 않는다', () => {
    for (const wall of PRODUCTION_GEOMETRY.walls) {
      const { center } = targetPlacement(wall, DEFAULT_HITBOX.eyeHeightM, 0)
      const thicknessOnX = wall.maxX - wall.minX < wall.maxZ - wall.minZ
      if (thicknessOnX) {
        expect(center[2]).toBeCloseTo((wall.minZ + wall.maxZ) / 2, 12)
      } else {
        expect(center[0]).toBeCloseTo((wall.minX + wall.maxX) / 2, 12)
      }
    }
  })

  it('중심 높이는 호출부가 넘긴 값 그대로다 — 눈높이 상수를 내부에 복제하지 않는다', () => {
    // ADR-0010: 리터럴 1.7을 내부에서 쓰면 이 값을 바꿔도 결과가 그대로일
    // 것이다. 임의의(정본과 다른) 값을 넘겨 함수가 실제로 인자를 반영하는지
    // 확인한다.
    const wall = PRODUCTION_GEOMETRY.walls[0]!
    expect(targetPlacement(wall, DEFAULT_HITBOX.eyeHeightM, 0).center[1]).toBeCloseTo(DEFAULT_HITBOX.eyeHeightM, 12)
    const arbitraryHeight = 3.3
    expect(targetPlacement(wall, arbitraryHeight, 0).center[1]).toBeCloseTo(arbitraryHeight, 12)
  })

  it('네 벽 전부 눈높이가 실제 스펙 상수(DEFAULT_HITBOX.eyeHeightM)에서 온다(RQ-34)', () => {
    for (const wall of PRODUCTION_GEOMETRY.walls) {
      const { center } = targetPlacement(wall, DEFAULT_HITBOX.eyeHeightM, 0)
      expect(center[1]).toBeCloseTo(DEFAULT_HITBOX.eyeHeightM, 12)
    }
  })

  it('표면 오프셋은 벽 안쪽면에서 방 안쪽으로만 아주 얇게 움직인다 — z-fighting 회피', () => {
    const offsetM = 0.01
    for (const wall of PRODUCTION_GEOMETRY.walls) {
      const zero = targetPlacement(wall, DEFAULT_HITBOX.eyeHeightM, 0)
      const offset = targetPlacement(wall, DEFAULT_HITBOX.eyeHeightM, offsetM)
      const thicknessOnX = wall.maxX - wall.minX < wall.maxZ - wall.minZ
      const axis = thicknessOnX ? 0 : 2
      const delta = offset.center[axis] - zero.center[axis]
      // 벽 두께(1m)보다 훨씬 얇다 — "표면과 같은 평면이거나 아주 얇은
      // 오프셋만 갖는다"는 요구를 값으로 고정한다.
      expect(Math.abs(delta)).toBeCloseTo(offsetM, 12)
      expect(Math.abs(delta)).toBeLessThan(0.1)
      // 원점에서 더 멀어지는 방향(벽 바깥쪽)이 아니라 더 가까워지는
      // 방향(방 안쪽)으로 움직인다.
      expect(Math.abs(offset.center[axis])).toBeLessThan(Math.abs(zero.center[axis]))
    }
  })
})

describe('RQ-34: 과녁 배치 — 회전(안쪽 법선 정렬)', () => {
  it('회전 후 기본 법선(+Z)이 실제로 원점을 향한다 — 화면에 표식이 뒤집혀 그려지지 않는다', () => {
    for (const wall of PRODUCTION_GEOMETRY.walls) {
      const { center, rotationY } = targetPlacement(wall, DEFAULT_HITBOX.eyeHeightM, 0)
      // three.js Y축 회전과 동일한 산술(라이브러리 의존 없이 직접 검증) —
      // 기본 법선 (0,0,1)을 Y축으로 rotationY만큼 돌린 결과.
      const normal = { x: Math.sin(rotationY), z: Math.cos(rotationY) }
      // 법선을 따라 살짝 나아간 점이 원점에 더 가까워야 "안쪽을 향한다".
      const thicknessOnX = wall.maxX - wall.minX < wall.maxZ - wall.minZ
      const axis = thicknessOnX ? 'x' : 'z'
      const before = axis === 'x' ? Math.abs(center[0]) : Math.abs(center[2])
      const after =
        axis === 'x' ? Math.abs(center[0] + normal.x * 0.01) : Math.abs(center[2] + normal.z * 0.01)
      expect(after).toBeLessThan(before)
    }
  })
})
