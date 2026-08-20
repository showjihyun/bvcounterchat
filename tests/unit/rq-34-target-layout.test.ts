import { describe, expect, it } from 'vitest'
import { targetPlacement } from '@client/scene/targetLayout'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { DECAL, TARGET } from '@client/config/design-tokens'

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
    // 리터럴이 아니라 정본 토큰을 그대로 쓴다(ADR-0010, PR #90 리뷰 blocker
    // B1 처방 ③) — 이전에는 로컬 리터럴 0.01을 넘겨 TARGET.offsetM을 어떤
    // 값으로 바꿔도 이 단언이 초록이었다.
    const offsetM = TARGET.offsetM
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

/**
 * PR #90 리뷰 blocker B1 — 과녁 평면과 탄흔 평면이 **정확히 같은 좌표**에
 * 놓였던 결함의 회귀 그물. `TARGET.offsetM`과 `DECAL.offsetM`이 우연히 같은
 * 값(0.01)이라 두 평면이 부동소수 오차 안에서 겹쳤고, 어느 쪽이 위에
 * 그려지는지는 `GameScene.tsx`의 컴포넌트 마운트 순서(three
 * `painterSortStable`의 동률 처리)라는 문서화되지 않은 우연에 맡겨져 있었다.
 *
 * ⚠️ **값만 고치는 것으로는 아무도 안 죽는다** — 위 5번째 케이스가 로컬
 * 리터럴을 토큰으로 바꿔 값 자체는 이제 반영되지만, "과녁이 탄흔보다 벽에
 * 더 가까워야 한다"는 **관계**(층 규칙)를 재는 단언은 없었다. 여기서 그
 * 관계를 직접 토큰끼리 비교해 고정한다 — `TARGET.offsetM`을 `DECAL.offsetM`
 * 이상으로 올리는 회귀가 생기면 이 스위트가 먼저 죽는다.
 */
describe('RQ-34: 과녁 오프셋 — 탄흔과의 층 규칙(PR #90 리뷰 blocker B1)', () => {
  it('과녁 오프셋은 0보다 크다 — 벽 표면과 완전히 겹치지 않는다', () => {
    expect(TARGET.offsetM).toBeGreaterThan(0)
  })

  it('과녁 오프셋은 탄흔·피격 효과 오프셋(DECAL.offsetM)보다 작다 — 탄흔이 과녁 위에 그려진다', () => {
    expect(TARGET.offsetM).toBeLessThan(DECAL.offsetM)
  })
})

/**
 * PR #90 리뷰 major M1 — RQ-34 문면의 "동심원" 절과 `TARGET.ringRadiiM`/
 * `ringColors`의 길이 결합이 값으로 잠기지 않았던 공백의 회귀 그물.
 * `MapMeshes.tsx`의 `TARGET.ringColors[ringIndex]!`가 길이 불일치를 타입
 * 검사에서 지운다(런타임에 `undefined` → three가 조용히 흰색으로 대체) —
 * 여기서 그 불변식을 값으로 고정한다.
 */
describe('RQ-34: 과녁 토큰 불변식 — "동심원" 절(PR #90 리뷰 major M1)', () => {
  it('링 반지름과 링 색의 길이가 같다 — 인덱스 밖 접근이 조용히 흰색으로 새지 않는다', () => {
    expect(TARGET.ringColors).toHaveLength(TARGET.ringRadiiM.length)
  })

  it('링이 최소 2개다 — 동심원이려면 밴드가 최소 하나는 있어야 한다', () => {
    expect(TARGET.ringRadiiM.length).toBeGreaterThanOrEqual(2)
  })

  it('링 반지름이 바깥→안쪽으로 강한 단조 감소다 — inner > outer로 뒤집히지 않는다', () => {
    for (let i = 0; i < TARGET.ringRadiiM.length - 1; i += 1) {
      expect(TARGET.ringRadiiM[i]!).toBeGreaterThan(TARGET.ringRadiiM[i + 1]!)
    }
  })

  it('가장 안쪽 반지름(불스아이)이 0보다 크다 — 보이지 않는 링이 없다', () => {
    expect(Math.min(...TARGET.ringRadiiM)).toBeGreaterThan(0)
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
      // 나아가는 거리 자체(TARGET.offsetM)는 결과 부호와 무관하지만, 리터럴
      // 대신 정본 토큰을 쓴다(ADR-0010, PR #90 리뷰 blocker B1 처방 ③).
      const thicknessOnX = wall.maxX - wall.minX < wall.maxZ - wall.minZ
      const axis = thicknessOnX ? 'x' : 'z'
      const before = axis === 'x' ? Math.abs(center[0]) : Math.abs(center[2])
      const after =
        axis === 'x'
          ? Math.abs(center[0] + normal.x * TARGET.offsetM)
          : Math.abs(center[2] + normal.z * TARGET.offsetM)
      expect(after).toBeLessThan(before)
    }
  })
})
