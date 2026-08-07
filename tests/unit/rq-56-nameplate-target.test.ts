import { describe, expect, it } from 'vitest'
import {
  nameplateAnchorHeightM,
  resolveNameplateTarget,
  type NameplateCandidate,
} from '@client/hud/nameplateTarget'
import { eyeOrigin, findClosestHit, type Vec3 } from '@shared/sim/combat'
import { CROUCH_HITBOX, DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PRODUCTION_WALLS, WALL_EAST } from '@shared/sim/walls'
import { PLAYER } from '@shared/constants'
import { canAct } from '@shared/sim/lifecycle'

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

/** `serverHitId`의 일반화 — 사수 자신의 눈높이·조준 방향을 인자로 받는다
 * (PR #68 blocker, 사수 자세 축). 기존 `serverHitId`는 건드리지 않는다 —
 * 그 헬퍼를 쓰는 기존 테스트가 전부 선 자세·`AIM_EAST`를 전제한다. 이
 * 헬퍼는 아래 "사수 자신의 눈높이" describe만 쓴다. */
function serverHitIdWithEyeHeight(
  candidates: Map<string, NameplateCandidate>,
  walls: readonly (typeof PRODUCTION_WALLS)[number][],
  eyeHeightM: number,
  direction: Vec3 = AIM_EAST,
): string | undefined {
  const hit = findClosestHit(
    { origin: eyeOrigin(SELF_FOOT, eyeHeightM), direction },
    [...candidates].filter(([, p]) => canAct(p.hp)).map(([id, p]) => ({ id, pose: { position: { x: p.x, y: p.y, z: p.z } } })),
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

/**
 * PR #68 리뷰 blocker(team-lead 실측, 원장 24ax 후속) — **사수 자신의**
 * 눈높이도 자세(mode)를 따라야 한다. 카메라(`PlayerControls.tsx:288`)와
 * 서버 레이(`GameRoom.ts:769~771`)는 사수 자신의 `mode`로
 * `hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, mode).eyeHeightM`을 쓰는데,
 * 이름표 레이(`nameplateTarget.ts:139`)는 언제나 `DEFAULT_HITBOX.eyeHeightM`
 * (선 자세, 1.700)이었다 — 앉아도 이름표 판정만 선 자세 눈높이를 쓴다.
 * 세 레이 모두 방향 벡터는 `yawPitchToDirection`이 만드는 같은 벡터이므로,
 * 이름표 레이와 카메라·서버 레이는 원점만 y로 어긋난 **평행선**이고 그
 * 차이는 거리와 무관하게 항상 `DEFAULT_HITBOX.eyeHeightM -
 * CROUCH_HITBOX.eyeHeightM`이다 — 앉아서 선 대상의 머리를 정조준하면
 * 서버는 헤드샷인데 이름표 레이는 대상 위를 지나 이름이 사라지고(쏠 수
 * 있는데 안 보인다), 대상 상단 바깥을 겨누면 반대로 이름만 뜬다. RQ-56
 * 동치("쏠 수 있으면 보이고, 보이면 쏠 수 있다")의 정면 위반이다.
 *
 * **원장 24ba가 이 축을 덮지 않는 이유**: 24ba는 *대상*의 히트박스
 * 축이고, 이월 사유는 "클라가 원격 플레이어의 자세를 모른다(서버
 * `Player` 스키마에 `mode` 필드 0건, 원장 24az)"다. 그 사유는 **사수
 * 자신**에는 성립하지 않는다 — `modeRef.current`(사수 자신의 최근 자세)가
 * 이름표 판정과 **같은 30Hz 루프**(`PlayerControls.tsx`, 이름표 호출부
 * 바로 38줄 위에서 그 값을 갱신한다) 안에 이미 있다. 와이어 프로토콜
 * 확장 없이 닫을 수 있는 축이다.
 *
 * **API 계약(test-writer 결정) — `resolveNameplateTarget`에 6번째 파라미터로
 * `selfEyeHeightM?: number`를 추가한다**(생략하면 `DEFAULT_HITBOX.eyeHeightM`,
 * 즉 선 자세 — 기존 호출부 전부가 그대로 유효한 안전한 기본값).
 *
 * - **위치를 `anchorPosition` 뒤(6번째)에 두는 이유**: `anchorPosition`은
 *   이미 5번째 자리에서 실 콜백으로 쓰이는 기존 테스트가 이 파일에
 *   10건 넘게 있다(보간 describe 3건 포함). 그 앞에 끼워 넣으면 그
 *   호출들의 5번째 위치 인자가 숫자로 오인돼 **기존 테스트를 고쳐야
 *   한다**(이 라운드의 "순증만" 규칙 위반). 뒤에 두면 기존 호출 전부가
 *   손대지 않아도 그대로 유효하다 — 이 describe만 6번째 인자를 명시한다.
 * - **`mode`가 아니라 `eyeHeightM`(숫자)을 받는 이유**: `eyeOrigin`·
 *   `effectiveSpreadConeRadius`가 이미 확립한 "값을 함수 내부에서 직접
 *   import하지 않고 호출자가 넘긴다"(config→sim 의존 방향, `combat
 *   -tuning.ts` 모듈 코멘트) 관례와 동일하게 맞춘다 — 호출자
 *   (`PlayerControls.tsx`)는 이미 `hitboxForMode(DEFAULT_HITBOX,
 *   CROUCH_HITBOX, modeRef.current).eyeHeightM`을 계산해 카메라·서버
 *   양쪽에 쓰고 있으므로 그 값을 그대로 넘기면 된다 — `nameplateTarget
 *   .ts`가 `hitboxForMode`/`CROUCH_HITBOX`를 새로 import할 필요가 없고,
 *   "차폐·조준선" 축만 다룬다는 이 모듈의 기존 경계도 그대로 지켜진다.
 * - **닫는 범위**: 이 describe는 **사수 자신**의 눈 원점 축만 닫는다.
 *   대상 후보의 히트박스(`bodyRadiusM` 등)가 자세에 따라 달라지는 축은
 *   여전히 원장 24ba·24ae의 영역이다(위 모듈 상단 REV 주석 그대로 유효).
 */
describe('RQ-56 blocker(PR #68) — 사수 자신의 눈높이도 자세(mode)를 따라야 한다', () => {
  it('앉은 사수의 이름표 레이 원점은 발+CROUCH_HITBOX.eyeHeightM이다(선 자세 발+DEFAULT_HITBOX.eyeHeightM과 다르다) — 두 눈높이 사이에 걸친 대상으로 직접 관측', () => {
    // 대상의 발 높이를 두 눈높이의 정중앙에 둔다(ADR-0010 — 리터럴 금지,
    // 두 eyeHeightM 상수에서 유도) — 선 자세 레이(더 높음)는 대상의 바디
    // 범위 안(대상 발보다 위)이라 명중하고, 앉은 자세 레이(더 낮음)는
    // 대상 발 아래라 명중하지 않는다.
    const midEyeHeightM = (DEFAULT_HITBOX.eyeHeightM + CROUCH_HITBOX.eyeHeightM) / 2
    const map = others({ target: { nickname: '대상', x: 10, y: midEyeHeightM, z: 0, hp: PLAYER.MAX_HP } })

    const standing = resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [], undefined, DEFAULT_HITBOX.eyeHeightM)
    expect(standing?.sessionId).toBe('target')

    const crouched = resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [], undefined, CROUCH_HITBOX.eyeHeightM)
    expect(crouched).toBeUndefined()
  })

  it('동치 — 앉은 사수가 선 대상의 머리를 정조준하면 이름표 판정이 서버 hitscan 판정(findClosestHit)과 같은 대상을 고른다', () => {
    // team-lead가 실측한 바로 그 배치(원장 24ax 후속 메시지) — 앉은 사수가
    // (눈높이 CROUCH_HITBOX.eyeHeightM) 대상(선 자세)의 머리 중심을 향해
    // 위쪽으로 살짝 올려 겨눈다(실제 조준처럼 낮은 눈높이에서 위를 본다).
    // AIM_EAST(수평)로는 두 눈높이가 같은 단독 대상에 둘 다 명중해(부위만
    // 다르고 sessionId는 같아) 이 축의 버그를 드러내지 못한다 — 그래서
    // 위로 각도를 준다. 리터럴 금지(ADR-0010) — 높이차는 두 상수에서 유도.
    //
    // 서버가 앉은 사수에 대해 실제로 쓰는 것과 정확히 같은 조합
    // (GameRoom.ts:769~771: hitboxForMode(...).eyeHeightM → eyeOrigin)의
    // 오프라인 오라클. 대상은 선 자세이므로 서버 쪽 히트박스도
    // DEFAULT_HITBOX다(대상 자세 축은 원장 24ba 이월 — 이 테스트는 사수
    // 자세 축만 다룬다).
    const distance = 10
    const map = others({ target: targetFootAt(distance) })
    const dy = DEFAULT_HITBOX.headCenterM - CROUCH_HITBOX.eyeHeightM
    const aimAtHead: Vec3 = { x: distance, y: dy, z: 0 }

    const serverHit = serverHitIdWithEyeHeight(map, [], CROUCH_HITBOX.eyeHeightM, aimAtHead)
    const nameplate = resolveNameplateTarget(SELF_FOOT, aimAtHead, map, [], undefined, CROUCH_HITBOX.eyeHeightM)

    expect(nameplate?.sessionId).toBe(serverHit)
    // 공허 방지 — 이 조준은 실제로 명중해야 한다(오프라인 오라클로 확인 —
    // 정확히 머리 중심을 겨눴으므로 region은 항상 head다).
    expect(serverHit).toBe('target')
  })

  it('양성 대조군 — 선 자세(DEFAULT_HITBOX.eyeHeightM을 명시)에서는 결과가 파라미터를 생략했을 때(기존 동작, 기본값)와 완전히 같다', () => {
    const map = others({ enemy: targetFootAt(10) })
    const withoutParam = resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [])
    const withStandingExplicit = resolveNameplateTarget(SELF_FOOT, AIM_EAST, map, [], undefined, DEFAULT_HITBOX.eyeHeightM)
    expect(withStandingExplicit).toEqual(withoutParam)
  })
})
