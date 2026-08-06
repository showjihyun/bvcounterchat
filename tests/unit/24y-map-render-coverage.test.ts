import { describe, expect, it } from 'vitest'
import { RENDERED_GEOMETRY_KINDS } from '@client/scene/MapMeshes'
import { boxRenderBox } from '@client/scene/mapGeometry'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'

/**
 * 원장 24y — **판정에 있는 지오메트리 종류가 전부 렌더되는가.**
 *
 * ## 왜 이 테스트가 있는가
 *
 * 렌더 계층은 테스트 면제라(ADR-0008 §6) "새 종류를 판정에 더하고 렌더에 안
 * 더했다"는 결함을 잡을 그물이 원리적으로 없다. 그 결함의 증상은 **지면에
 * 보이지 않는 차단물**이고, 원장 24f가 벽·박스·사다리에서 이미 겪었다 —
 * 사용자가 "보이지 않는 벽에 부딪힌다"로 보고한 그것이다.
 *
 * RQ-33이 `platforms`를 판정에 더하면서 **같은 실수를 반복할 뻔했다**(독립 평가
 * 관찰 O1 — 4m×4m 투명 차단물). 그래서 컴포넌트가 아는 종류를 상수로 내보내고
 * 여기서 정본과 대조한다.
 *
 * ## 이 테스트가 잡는 것과 못 잡는 것
 *
 * **잡는다**: `StaticGeometry`에 종류가 늘었는데 `MapMeshes`가 모르는 경우.
 * 다섯 번째 종류가 생기면 여기서 먼저 실패한다.
 *
 * **못 잡는다**: `RENDERED_GEOMETRY_KINDS`에 이름만 더하고 JSX 루프를 안 더한
 * 경우 — 그것은 렌더 계층 안의 일이라 마운트해야 보인다(ADR-0008 §6). 그 짝은
 * 사람이 지키며, `MapMeshes`의 상수 주석에 그 경고를 박아 두었다. 즉 이 그물은
 * **완전하지 않고 가장 흔한 누락 형태만** 막는다.
 */
describe('24y: 판정 지오메트리와 렌더 목록이 어긋나지 않는다', () => {
  it('렌더 목록이 PRODUCTION_GEOMETRY의 종류를 하나도 빠뜨리지 않는다', () => {
    const judged = Object.keys(PRODUCTION_GEOMETRY).sort()
    const rendered = [...RENDERED_GEOMETRY_KINDS].sort()
    expect(rendered).toEqual(judged)
  })

  it('렌더 목록에 정본이 모르는 이름이 없다 — 오타가 그물을 뚫지 못한다', () => {
    // 위 단언만으로도 잡히지만, 실패했을 때 **어느 쪽이 문제인지**가 보여야 한다.
    for (const kind of RENDERED_GEOMETRY_KINDS) {
      expect(Object.keys(PRODUCTION_GEOMETRY), `렌더 목록의 '${kind}'`).toContain(kind)
    }
  })

  it('전제 확인 — 정본에 종류가 실제로 있다(빈 객체면 위 단언이 공허하다)', () => {
    expect(Object.keys(PRODUCTION_GEOMETRY).length).toBeGreaterThan(0)
  })
})

/**
 * 플랫폼 렌더 치수 — `boxRenderBox`를 그대로 쓴다(플랫폼은 `BoxAABB`이고
 * `topY`가 윗면 높이다). 박스와 같은 계약이라 별도 환산 함수를 만들지 않았고,
 * 그 재사용이 옳은지를 여기서 고정한다.
 */
describe('24y: 플랫폼 렌더 상자가 판정 볼륨과 일치한다', () => {
  it('윗면이 topY와 같고 바닥에서 시작한다 — 서는 높이와 보이는 높이가 같다', () => {
    const platforms = PRODUCTION_GEOMETRY.platforms ?? []
    expect(platforms.length).toBeGreaterThan(0)
    for (const platform of platforms) {
      const { center, size } = boxRenderBox(platform)
      expect(center[1] + size[1] / 2).toBeCloseTo(platform.topY, 12)
      expect(center[1] - size[1] / 2).toBeCloseTo(0, 12)
      expect(center[0] - size[0] / 2).toBeCloseTo(platform.minX, 12)
      expect(center[0] + size[0] / 2).toBeCloseTo(platform.maxX, 12)
      expect(center[2] - size[2] / 2).toBeCloseTo(platform.minZ, 12)
      expect(center[2] + size[2] / 2).toBeCloseTo(platform.maxZ, 12)
    }
  })
})
