import { describe, expect, it } from 'vitest'
import { boxRenderBox, ladderRenderBox, wallRenderBox } from '@client/scene/mapGeometry'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'
import { SCENE } from '@client/config/design-tokens'

/**
 * 원장 24f — 맵 정적 지오메트리 렌더 치수 환산.
 *
 * **무엇을 시험하고 무엇을 안 하는가**: 렌더 결과(픽셀·씬 그래프)는 ADR-0008 §6
 * 면제이고 `fe.md`의 스모크·스크린샷 수동 확인이 그 몫이다. 여기서 고정하는 것은
 * **판정 AABB → 렌더 박스 환산 산술**뿐이다. 이 환산이 틀리면 "보이는 벽과 막는
 * 벽이 다른" 결함이 되는데, 그것은 화면을 봐야만 드러나고 자동 게이트가 전부
 * 초록인 채로 통과한다(원장 24a major 3의 재판이다).
 *
 * ⚠️ **기대값을 좌표 리터럴로 적지 않는다**(ADR-0010) — 맵 좌표를 여기 옮겨
 * 적으면 맵이 바뀔 때 이 테스트가 "옛 맵을 지키는" 방향으로 거짓 실패한다.
 * 대신 정본 AABB에서 **유도되는 관계**를 고정한다.
 */
describe('24f: 맵 지오메트리 렌더 치수 환산', () => {
  it('환산된 박스의 6면이 원래 AABB와 정확히 일치한다 — 벽 전부', () => {
    for (const wall of PRODUCTION_GEOMETRY.walls) {
      const { center, size } = wallRenderBox(wall, SCENE.wallRenderHeightM)
      expect(center[0] - size[0] / 2).toBeCloseTo(wall.minX, 12)
      expect(center[0] + size[0] / 2).toBeCloseTo(wall.maxX, 12)
      expect(center[2] - size[2] / 2).toBeCloseTo(wall.minZ, 12)
      expect(center[2] + size[2] / 2).toBeCloseTo(wall.maxZ, 12)
    }
  })

  it('벽은 바닥(y=0)에서 시작해 주어진 높이까지 선다 — 바닥에 파묻히거나 뜨지 않는다', () => {
    for (const wall of PRODUCTION_GEOMETRY.walls) {
      const { center, size } = wallRenderBox(wall, SCENE.wallRenderHeightM)
      expect(center[1] - size[1] / 2).toBeCloseTo(0, 12)
      expect(center[1] + size[1] / 2).toBeCloseTo(SCENE.wallRenderHeightM, 12)
    }
  })

  it('박스 윗면은 topY와 같다 — 착지면과 보이는 면이 어긋나지 않는다(RQ-32)', () => {
    // topY는 **윗면 높이**이지 두께가 아니다. 그대로 size로 쓰면 윗면이 2×topY에
    // 서고 플레이어가 허공에 착지한 것처럼 보인다.
    for (const box of PRODUCTION_GEOMETRY.boxes) {
      const { center, size } = boxRenderBox(box)
      expect(center[1] + size[1] / 2).toBeCloseTo(box.topY, 12)
      expect(center[1] - size[1] / 2).toBeCloseTo(0, 12)
      expect(center[0] - size[0] / 2).toBeCloseTo(box.minX, 12)
      expect(center[2] + size[2] / 2).toBeCloseTo(box.maxZ, 12)
    }
  })

  it('사다리는 볼륨의 minY~maxY를 그대로 차지한다 — 등반 판정 범위와 같다(RQ-21)', () => {
    for (const ladder of PRODUCTION_GEOMETRY.ladders) {
      const { center, size } = ladderRenderBox(ladder)
      expect(center[1] - size[1] / 2).toBeCloseTo(ladder.minY, 12)
      expect(center[1] + size[1] / 2).toBeCloseTo(ladder.maxY, 12)
      expect(center[0] - size[0] / 2).toBeCloseTo(ladder.minX, 12)
      expect(center[2] - size[2] / 2).toBeCloseTo(ladder.minZ, 12)
    }
  })

  it('모든 변의 길이가 양수다 — 뒤집힌 AABB는 보이지 않는 메시가 된다', () => {
    const all = [
      ...PRODUCTION_GEOMETRY.walls.map((w) => wallRenderBox(w, SCENE.wallRenderHeightM)),
      ...PRODUCTION_GEOMETRY.boxes.map(boxRenderBox),
      ...PRODUCTION_GEOMETRY.ladders.map(ladderRenderBox),
    ]
    expect(all).toHaveLength(
      PRODUCTION_GEOMETRY.walls.length + PRODUCTION_GEOMETRY.boxes.length + PRODUCTION_GEOMETRY.ladders.length,
    )
    for (const { size } of all) {
      expect(size[0]).toBeGreaterThan(0)
      expect(size[1]).toBeGreaterThan(0)
      expect(size[2]).toBeGreaterThan(0)
    }
  })

  it('벽 렌더 높이가 도달 가능한 최고 지점 이상이다 — 벽 위가 뚫려 보이지 않는다', () => {
    // 사다리 꼭대기가 현재 맵의 최고 도달점이다. 벽이 그보다 낮으면 사다리를
    // 다 오른 플레이어가 벽 윗면 위에 서서 맵 밖이 보인다. 사다리가 높아지면
    // 이 단언이 실패해 `SCENE.wallRenderHeightM`을 함께 올리라고 알린다.
    const highestReachable = Math.max(...PRODUCTION_GEOMETRY.ladders.map((l) => l.maxY))
    expect(SCENE.wallRenderHeightM).toBeGreaterThanOrEqual(highestReachable)
  })

  it('그릴 지오메트리가 실제로 존재한다 — 빈 배열이면 화면은 여전히 비어 있다', () => {
    // 이 결함의 증상이 정확히 "장애물이 하나도 안 보인다"였다. 정본이 비면
    // 위 단언들은 전부 공허하게 통과한다(vacuous truth) — 그 구멍을 막는다.
    expect(PRODUCTION_GEOMETRY.walls.length).toBeGreaterThan(0)
    expect(PRODUCTION_GEOMETRY.boxes.length).toBeGreaterThan(0)
    expect(PRODUCTION_GEOMETRY.ladders.length).toBeGreaterThan(0)
  })
})
