import { describe, expect, it } from 'vitest'
import { ladderRailBoxes, ladderRungBoxes, ladderRungCount } from '@client/scene/ladderGeometry'
import type { LadderRenderConfig } from '@client/scene/ladderGeometry'
import { ladderRenderBox } from '@client/scene/mapGeometry'
import type { RenderBox } from '@client/scene/mapGeometry'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'
import { SCENE } from '@client/config/design-tokens'
import type { LadderVolume } from '@shared/sim/movement'

/**
 * 원장 24t — 사다리 뼈대(등반면 레일 + 가로대) 치수.
 *
 * **무엇을 시험하고 무엇을 안 하는가**: 화면에 실제로 사다리처럼 보이는지는
 * 사람이 볼 일이다(ADR-0008 §6 렌더 면제, `fe.md` 수동 확인). 여기서 고정하는
 * 것은 **뼈대가 등반 볼륨과 정합하는가**라는 산술뿐이다 — 그것이 어긋나면
 * "보이는 사다리와 오를 수 있는 사다리가 다른" 결함이 되고, 자동 게이트는
 * 전부 초록인 채 통과한다(원장 24f·24a가 이미 겪은 형태).
 *
 * ⚠️ **기대값을 좌표·치수 리터럴로 적지 않는다**(ADR-0010) — 정본
 * `PRODUCTION_GEOMETRY`와 토큰 `SCENE`에서 읽는다.
 */

const CONFIG: LadderRenderConfig = {
  railThicknessM: SCENE.ladderRailThicknessM,
  rungThicknessM: SCENE.ladderRungThicknessM,
  rungSpacingM: SCENE.ladderRungSpacingM,
}

/** 상자가 볼륨 안에 완전히 들어가는지 — 축별 [min, max] 포함 관계. */
function assertInsideVolume(part: RenderBox, ladder: LadderVolume, label: string): void {
  const volume = ladderRenderBox(ladder)
  const axes = [0, 1, 2] as const
  const volumeMin = axes.map((a) => volume.center[a] - volume.size[a] / 2)
  const volumeMax = axes.map((a) => volume.center[a] + volume.size[a] / 2)
  for (const a of axes) {
    const partMin = part.center[a] - part.size[a] / 2
    const partMax = part.center[a] + part.size[a] / 2
    // 부동소수 여유 — 반 두께를 더하고 빼는 산술이라 마지막 자리가 흔들린다.
    expect(partMin, `${label} axis${a} min`).toBeGreaterThanOrEqual(volumeMin[a]! - 1e-9)
    expect(partMax, `${label} axis${a} max`).toBeLessThanOrEqual(volumeMax[a]! + 1e-9)
  }
}

describe('24t: 사다리 뼈대는 등반 볼륨과 정합한다', () => {
  it('레일·가로대가 **전부** 등반 볼륨 안에 들어간다 — 보이는 곳과 오르는 곳이 같다', () => {
    // 이것이 이 라운드의 핵심 불변식이다. 원장 24f의 통짜 상자는 볼륨과
    // 정확히 일치했으므로 자동으로 성립했지만, 뼈대는 면 위에 얹히므로
    // 부호를 한 번만 틀려도 볼륨 밖으로 튀어나간다.
    for (const [index, ladder] of PRODUCTION_GEOMETRY.ladders.entries()) {
      for (const [i, rail] of ladderRailBoxes(ladder, CONFIG).entries()) {
        assertInsideVolume(rail, ladder, `ladder${index} rail${i}`)
      }
      for (const [i, rung] of ladderRungBoxes(ladder, CONFIG).entries()) {
        assertInsideVolume(rung, ladder, `ladder${index} rung${i}`)
      }
    }
  })

  it('레일은 정확히 2개이고 등반면 쪽에 붙는다 — 반대 면에 그리면 조작과 어긋난다', () => {
    for (const ladder of PRODUCTION_GEOMETRY.ladders) {
      const rails = ladderRailBoxes(ladder, CONFIG)
      expect(rails).toHaveLength(2)
      // RQ-21: 법선은 "밀어붙이면 오르는" 면을 가리킨다. 법선이 양수면 max 쪽이다.
      const alongX = Math.abs(ladder.normalX) >= Math.abs(ladder.normalZ)
      const axis = alongX ? 0 : 2
      const normal = alongX ? ladder.normalX : ladder.normalZ
      const face = normal >= 0 ? (alongX ? ladder.maxX : ladder.maxZ) : alongX ? ladder.minX : ladder.minZ
      for (const rail of rails) {
        const near = normal >= 0 ? rail.center[axis] + rail.size[axis] / 2 : rail.center[axis] - rail.size[axis] / 2
        expect(near).toBeCloseTo(face, 9)
      }
    }
  })

  it('가로대는 바닥에 얹히고 윗면을 넘지 않는다 — 볼륨 밖에 뜬 가로대가 없다', () => {
    for (const ladder of PRODUCTION_GEOMETRY.ladders) {
      const rungs = ladderRungBoxes(ladder, CONFIG)
      expect(rungs.length).toBeGreaterThan(1)
      const first = rungs[0]!
      const last = rungs[rungs.length - 1]!
      expect(first.center[1] - first.size[1] / 2).toBeCloseTo(ladder.minY, 9)
      expect(last.center[1] + last.size[1] / 2).toBeLessThanOrEqual(ladder.maxY + 1e-9)
    }
  })

  it('가로대 간격이 토큰값과 같다 — 위로 갈수록 성기거나 촘촘해지지 않는다', () => {
    for (const ladder of PRODUCTION_GEOMETRY.ladders) {
      const ys = ladderRungBoxes(ladder, CONFIG).map((r) => r.center[1])
      for (let i = 1; i < ys.length; i += 1) {
        expect(ys[i]! - ys[i - 1]!).toBeCloseTo(CONFIG.rungSpacingM, 9)
      }
    }
  })

  it('가로대는 등반면의 폭을 가득 잇는다 — 레일 사이가 비지 않는다', () => {
    for (const ladder of PRODUCTION_GEOMETRY.ladders) {
      const alongX = Math.abs(ladder.normalX) >= Math.abs(ladder.normalZ)
      const widthAxis = alongX ? 2 : 0
      const expected = alongX ? ladder.maxZ - ladder.minZ : ladder.maxX - ladder.minX
      for (const rung of ladderRungBoxes(ladder, CONFIG)) {
        expect(rung.size[widthAxis]).toBeCloseTo(expected, 9)
      }
    }
  })

  it('개수는 높이에서 유도된다 — 사다리가 높아지면 가로대도 늘어난다', () => {
    const base = PRODUCTION_GEOMETRY.ladders[0]!
    const taller: LadderVolume = { ...base, maxY: base.maxY * 2 }
    expect(ladderRungCount(taller, CONFIG)).toBeGreaterThan(ladderRungCount(base, CONFIG))
  })

  it('퇴화 입력에 방어한다 — 간격 0이나 두께보다 낮은 볼륨은 가로대 0개다', () => {
    const ladder = PRODUCTION_GEOMETRY.ladders[0]!
    expect(ladderRungCount(ladder, { ...CONFIG, rungSpacingM: 0 })).toBe(0)
    // 두께조차 못 담는 볼륨 — 무한 루프나 음수 개수가 되면 안 된다.
    const flat: LadderVolume = { ...ladder, maxY: ladder.minY + CONFIG.rungThicknessM / 2 }
    expect(ladderRungCount(flat, CONFIG)).toBe(0)
    expect(ladderRungBoxes(flat, CONFIG)).toHaveLength(0)
  })

  it('법선이 음수 방향이어도 반대 면에 붙는다 — 부호 처리가 대칭이다', () => {
    // 정본에는 아직 음수 법선 사다리가 없다. 그 경우가 들어와도 산술이
    // 성립하는지를 여기서 고정한다 — 안 하면 맵이 늘 때 조용히 어긋난다.
    const base = PRODUCTION_GEOMETRY.ladders[0]!
    const flipped: LadderVolume = { ...base, normalX: -base.normalX, normalZ: -base.normalZ }
    for (const rail of ladderRailBoxes(flipped, CONFIG)) {
      assertInsideVolume(rail, flipped, 'flipped rail')
      expect(rail.center[0] - rail.size[0] / 2).toBeCloseTo(flipped.minX, 9)
    }
  })

  it('그릴 사다리가 실제로 있다 — 정본이 비면 위 단언이 전부 공허하다', () => {
    expect(PRODUCTION_GEOMETRY.ladders.length).toBeGreaterThan(0)
  })
})
