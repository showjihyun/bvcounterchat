import { describe, expect, it } from 'vitest'
import {
  nameplateAnchorHeightM,
  resolveNameplateTarget,
  type NameplateCandidate,
} from '@client/hud/nameplateTarget'
import { eyeOrigin, findClosestHit, type Vec3 } from '@shared/sim/combat'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PRODUCTION_WALLS, WALL_EAST } from '@shared/sim/walls'
import { PLAYER } from '@shared/constants'

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
 * ⚠️ **이 대조가 고정하는 축은 둘뿐이다 — 차폐 목록과 조준 벡터.**
 * 히트박스(`bodyRadiusM`)와 눈 원점(`eyeHeightM`)은 **고정하지 못한다**:
 * 모든 케이스가 사수 원점·조준 +X·대상 `(d,0,0)`의 한 축 정렬이고 단언이
 * `sessionId`만 보기 때문에, 그 두 값을 바꾸는 변이가 살아남는다(PR #66 리뷰
 * major 1 — 격리 워크트리 실측). 축을 벗어난 경계 케이스 추가는 **원장 24ae**가
 * 갖는다. 여기 "동치를 고정한다"고 적힌 것을 그 두 축까지로 읽으면 안 된다.
 *
 * ⚠️ 좌표를 리터럴로 박지 않는다(ADR-0010) — 히트박스·벽은 정본에서 읽고,
 * 대상 위치는 조준 방향에서 유도한다.
 */

/** 원점에 선 사수가 +X를 정조준한다. 벽·플레이어 좌표를 이 축 위에 놓으면
 * 기하가 단순해져 테스트가 무엇을 시험하는지 읽힌다. */
const SELF_FOOT: Vec3 = { x: 0, y: 0, z: 0 }
const AIM_EAST: Vec3 = { x: 1, y: 0, z: 0 }

/** 사수 눈높이에 바디 중심이 오도록 놓은 대상의 **발** 위치. */
function targetFootAt(distance: number, hp: number = PLAYER.MAX_HP): NameplateCandidate {
  return { nickname: '대상', x: distance, y: 0, z: 0, hp }
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
    [...candidates].filter(([, p]) => p.hp > 0).map(([id, p]) => ({ id, pose: { position: { x: p.x, y: p.y, z: p.z } } })),
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

describe('RQ-56 blocker 회귀 — 시신은 이름표 후보가 아니다', () => {
  // 서버 `handleFire`가 `canAct(player.hp)`로 시신을 사격 후보에서 뺀다.
  // 클라가 그 필터를 안 하면 **이름은 시신을 가리키고 총알은 뒤의 산 사람을
  // 맞히는** 상태가 된다 — 이 라운드가 세운 동치가 그 자리에서 깨진다.
  it('시신만 있으면 표시하지 않는다', () => {
    const map = others({ corpse: targetFootAt(10, 0) })
    expect(resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [])).toBeUndefined()
  })

  it('같은 위치의 산 사람은 표시된다 — hp가 원인임을 확인', () => {
    // 음성 대조군. 없으면 위 단언이 "그냥 조준이 빗나갔다"로도 통과한다.
    const map = others({ alive: targetFootAt(10) })
    expect(resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [])?.sessionId).toBe('alive')
  })

  it('시신이 산 사람 **앞**에 있으면 뒤의 산 사람을 고른다 — 서버가 맞히는 그 대상', () => {
    // 이것이 blocker의 실제 형태다. 시신을 그냥 건너뛰는 것으로는 부족하고,
    // 시신을 **후보 집합에서 빼야** 뒤 사람이 최근접으로 뽑힌다.
    const map = others({ corpse: targetFootAt(8, 0), alive: targetFootAt(16) })
    const target = resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [])
    expect(target?.sessionId).toBe('alive')
    expect(target?.sessionId).toBe(serverHitId(map, []))
  })
})

describe('RQ-56 blocker 회귀 — 앵커는 보간 표시 위치를 따른다', () => {
  // 몸은 `renderTime − 보간 지연`에 그려진다. 앵커에 최신 스냅샷을 쓰면
  // 그 지연만큼(6m/s × 66.67ms = 0.40m, 바디 반경보다 크다) 이름이 몸 옆에 뜬다.
  it('보간 위치가 주어지면 스냅샷이 아니라 그것을 쓴다', () => {
    const map = others({ enemy: targetFootAt(10) })
    const interpolated = { x: 9.6, y: 0, z: 0 }
    const target = resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [], () => interpolated)
    expect(target?.anchor.x).toBe(9.6)
    expect(target?.anchor.z).toBe(0)
    expect(target?.anchor.y).toBeCloseTo(nameplateAnchorHeightM(), 12)
  })

  it('보간 이력이 없으면 스냅샷으로 떨어진다 — 첫 프레임 폴백', () => {
    const map = others({ enemy: targetFootAt(10) })
    const target = resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [], () => undefined)
    expect(target?.anchor.x).toBe(10)
  })

  it('보간 조회는 **선택된 대상**의 id로 이뤄진다 — 엉뚱한 몸에 붙지 않는다', () => {
    const map = others({ near: targetFootAt(8), far: targetFootAt(16) })
    const asked: string[] = []
    resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [], (id) => {
      asked.push(id)
      return undefined
    })
    expect(asked).toEqual(['near'])
  })
})
