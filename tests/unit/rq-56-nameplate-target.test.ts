import { describe, expect, it } from 'vitest'
import {
  nameplateAnchorHeightM,
  resolveNameplateTarget,
  type NameplateCandidate,
} from '@client/hud/nameplateTarget'
import { eyeOrigin, findClosestHit, type Vec3 } from '@shared/sim/combat'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PRODUCTION_WALLS, WALL_EAST } from '@shared/sim/walls'

/**
 * RQ-56 이름표 대상 판정(원장 24ab).
 *
 * **이 파일이 지키는 명제 하나**: RQ-56이 요구하는 동치 —
 * **"쏠 수 있으면 이름이 보이고, 이름이 보이면 쏠 수 있다"**. 그것이 깨지면
 * 이름이 뜨는데 안 맞거나 그 반대가 되어 플레이어가 화면을 신뢰할 수 없다.
 *
 * 동치를 "비슷한 결과"로 시험하지 않는다 — **서버가 부르는 그 함수**
 * (`findClosestHit`)를 테스트도 직접 불러 **두 결과가 같은 대상**인지 본다.
 * 구현이 로직을 복제하는 쪽으로 되돌아가면 여기서 갈라진다.
 *
 * ⚠️ 좌표를 리터럴로 박지 않는다(ADR-0010) — 히트박스·벽은 정본에서 읽고,
 * 대상 위치는 조준 방향에서 유도한다.
 */

/** 원점에 선 사수가 +X를 정조준한다. 벽·플레이어 좌표를 이 축 위에 놓으면
 * 기하가 단순해져 테스트가 무엇을 시험하는지 읽힌다. */
const SELF_FOOT: Vec3 = { x: 0, y: 0, z: 0 }
const AIM_EAST: Vec3 = { x: 1, y: 0, z: 0 }

/** 사수 눈높이에 바디 중심이 오도록 놓은 대상의 **발** 위치. */
function targetFootAt(distance: number): NameplateCandidate {
  return { nickname: '대상', x: distance, y: 0, z: 0 }
}

function others(entries: Record<string, NameplateCandidate>): Map<string, NameplateCandidate> {
  return new Map(Object.entries(entries))
}

/** 같은 입력으로 서버 경로(`findClosestHit`)를 직접 부른다 — 동치 대조용. */
function serverHitId(
  candidates: Map<string, NameplateCandidate>,
  walls: readonly (typeof PRODUCTION_WALLS)[number][],
): string | undefined {
  const hit = findClosestHit(
    { origin: eyeOrigin(SELF_FOOT, DEFAULT_HITBOX.eyeHeightM), direction: AIM_EAST },
    [...candidates].map(([id, p]) => ({ id, pose: { position: { x: p.x, y: p.y, z: p.z } } })),
    DEFAULT_HITBOX,
    walls,
  )
  return hit?.id
}

describe('RQ-56: 이름표는 조준선이 향한 플레이어를 고른다', () => {
  it('조준선 위의 플레이어를 고르고 그 닉네임을 돌려준다', () => {
    const map = others({ enemy: targetFootAt(10) })
    const target = resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [])
    expect(target?.sessionId).toBe('enemy')
    expect(target?.nickname).toBe('대상')
  })

  it('조준선을 벗어나면 표시하지 않는다 — 반대 방향', () => {
    const map = others({ enemy: targetFootAt(10) })
    expect(resolveNameplateTarget(SELF_FOOT, { x: -1, y: 0, z: 0 }, map, [])).toBeUndefined()
  })

  it('아무도 없으면 표시하지 않는다', () => {
    expect(resolveNameplateTarget(SELF_FOOT, AIM_EAST, others({}), [])).toBeUndefined()
  })

  it('둘이 겹쳐 있으면 **가까운 쪽**을 고른다 — 뒷사람 이름이 뜨면 안 된다', () => {
    const map = others({ near: targetFootAt(8), far: targetFootAt(16) })
    expect(resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [])?.sessionId).toBe('near')
  })
})

describe('RQ-56: 차폐 — 벽 뒤에 있으면 이름이 뜨지 않는다', () => {
  // 동쪽 벽은 x 15~16에 서 있다(정본). 그 너머의 대상은 가려진다.
  const BEHIND_WALL = WALL_EAST.maxX + 5
  const IN_FRONT_OF_WALL = WALL_EAST.minX - 5

  it('벽 뒤 대상은 표시하지 않는다', () => {
    const map = others({ hidden: targetFootAt(BEHIND_WALL) })
    expect(resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, PRODUCTION_WALLS)).toBeUndefined()
  })

  it('같은 대상이라도 차폐 목록이 비면 표시된다 — 벽이 원인임을 확인', () => {
    // 음성 대조군. 이게 없으면 위 단언이 "그냥 조준이 빗나갔다"로도 통과한다.
    const map = others({ hidden: targetFootAt(BEHIND_WALL) })
    expect(resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [])?.sessionId).toBe('hidden')
  })

  it('벽 앞 대상은 차폐 목록이 있어도 표시된다', () => {
    const map = others({ visible: targetFootAt(IN_FRONT_OF_WALL) })
    expect(resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, PRODUCTION_WALLS)?.sessionId).toBe('visible')
  })
})

describe('RQ-56: 서버 명중 판정과의 동치 — "쏠 수 있으면 보인다"', () => {
  // RQ-56 문면: "차폐 판정은 사격 명중 판정(RQ-12)과 같은 지오메트리를 사용해야
  // 한다." 그 동치를 결과 비교로 고정한다 — 구현이 로직을 복제하면 갈라진다.
  const CASES: { label: string; map: Map<string, NameplateCandidate>; walls: readonly (typeof PRODUCTION_WALLS)[number][] }[] = [
    { label: '단독 대상', map: others({ a: targetFootAt(10) }), walls: [] },
    { label: '겹친 둘', map: others({ near: targetFootAt(8), far: targetFootAt(16) }), walls: [] },
    { label: '벽 뒤', map: others({ a: targetFootAt(WALL_EAST.maxX + 5) }), walls: PRODUCTION_WALLS },
    { label: '벽 앞', map: others({ a: targetFootAt(WALL_EAST.minX - 5) }), walls: PRODUCTION_WALLS },
    { label: '벽 뒤 + 벽 앞 동시', map: others({ front: targetFootAt(WALL_EAST.minX - 5), back: targetFootAt(WALL_EAST.maxX + 5) }), walls: PRODUCTION_WALLS },
  ]

  for (const { label, map, walls } of CASES) {
    it(`이름표 대상과 서버 hitscan 대상이 같다 — ${label}`, () => {
      const nameplate = resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, walls)
      expect(nameplate?.sessionId).toBe(serverHitId(map, walls))
    })
  }

  it('대조군이 실제로 갈릴 수 있는 케이스를 담고 있다 — 전부 미탐이면 공허하다', () => {
    // 위 루프가 전부 `undefined === undefined`면 동치가 시험되지 않는다.
    const resolved = CASES.map(({ map, walls }) => resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, walls)?.sessionId)
    expect(resolved.filter((id) => id !== undefined).length).toBeGreaterThan(0)
    expect(resolved.filter((id) => id === undefined).length).toBeGreaterThan(0)
  })
})

describe('RQ-56: 이름표 앵커', () => {
  it('머리 볼륨 위에 놓인다 — 히트박스에서 유도하고 리터럴을 쓰지 않는다', () => {
    const headTop = DEFAULT_HITBOX.headCenterM + DEFAULT_HITBOX.headRadiusM
    expect(nameplateAnchorHeightM()).toBeGreaterThan(headTop)
  })

  it('앵커가 대상의 XZ를 따르고 발 높이 + 앵커 높이에 놓인다', () => {
    const map = others({ enemy: targetFootAt(10) })
    const target = resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [])
    expect(target?.anchor.x).toBe(10)
    expect(target?.anchor.z).toBe(0)
    expect(target?.anchor.y).toBeCloseTo(nameplateAnchorHeightM(), 12)
  })
})
