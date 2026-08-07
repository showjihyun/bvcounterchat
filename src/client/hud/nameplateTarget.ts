/**
 * RQ-56 이름표 대상 판정(원장 24ab) — **조준선이 향한 플레이어**를 고른다.
 *
 * ## 왜 별도 모듈인가
 *
 * RQ-56이 요구하는 동치 — **"쏠 수 있으면 이름이 보이고, 이름이 보이면 쏠 수
 * 있다"** — 는 두 판정이 **같아야** 성립한다. 비슷한 로직을 여기 다시 쓰면 그
 * 순간부터 갈라질 수 있으므로, 서버 hitscan이 쓰는 `findClosestHit`을 **그대로
 * 호출한다**(ADR-0010 값 복제 금지의 논리 버전). 이 파일이 하는 일은 클라이언트
 * 스토어의 모양을 그 함수의 입력 모양으로 옮기는 것뿐이다.
 *
 * ⚠️ **REV(RQ-92 v2.2, 2026-08-07, 원장 24ba) — 아래 서술이 거짓이 됐다.**
 * 이 자리는 원래 "`GameRoom.handleFire`가 `findClosestHit(ray, candidates,
 * DEFAULT_HITBOX, PRODUCTION_WALLS)`를 부르고, 여기서도 같은 히트박스·같은
 * 차폐 목록을 넘긴다"였다. **더 이상 사실이 아니다** — `handleFire`는 이제
 * 각 피격 후보 **자신의** `mode`로 `hitboxForMode(DEFAULT_HITBOX,
 * CROUCH_HITBOX, mode)`를 호출해 후보별로 다른 히트박스를 쓴다(선 자세
 * `DEFAULT_HITBOX` vs 앉은 자세 `CROUCH_HITBOX`). 이 파일은 여전히
 * `DEFAULT_HITBOX` 하나만 균일하게 쓴다 — **차폐 목록(`walls`)은 여전히
 * 같지만, 대상 히트박스는 더 이상 같지 않다.**
 *
 * ✅ **REV2(PR #68 리뷰 blocker, 2026-08-07) — 눈 원점(사수 자신의 레이
 * 시작점)은 이 PR에서 복구했다.** `resolveNameplateTarget`이 항상
 * `DEFAULT_HITBOX.eyeHeightM`으로 레이 원점을 잡아, 사수 자신이 앉아 있을
 * 때도 이름표 레이만 선 자세 눈높이(1.7)에서 출발하고 카메라·서버 레이는
 * 앉은 눈높이(1.221875)에서 출발하는 **평행선 어긋남**(원점만 y로
 * 0.478125m 차이, 거리 무관하게 일정)이 있었다 — 앉아서 대상 머리를
 * 정조준해도 이름표 레이는 그 옆을 지나 이름이 사라지고, 대상 위쪽을
 * 겨누면 반대로 이름만 떴다. 6번째 파라미터 `selfEyeHeightM`(호출자가
 * `hitboxForMode(...).eyeHeightM`을 계산해 넘긴다, §아래 함수 docblock)으로
 * 닫았다 — **사수 자신의 눈 원점 축은 이제 서버·카메라와 일치한다.**
 *
 * **동치가 앉은 대상에서는 아직 깨져 있다 — 남은 갈라짐은 대상 히트박스
 * 축뿐이다(원장 24ba).** 이 파일이 판정하는 대상 볼륨은 클라
 * `[0,1.5]`(바디)+`[1.5,1.8]`(머리)로 여전히 고정인데, 서버가 실제로
 * 판정하는 볼륨은 앉은 대상의 경우 `[0,1.05]`+`[1.05,1.35]`다 — **이름표는
 * 뜨는데 그 높이를 쏘면 맞지 않는** 구간이 남는다(RQ-56의 "쏠 수 있으면
 * 보인다" 위반, 24ab 리뷰 blocker 1과 같은 계열의 재발 — 그때는 시신,
 * 이번엔 자세).
 *
 * **대상 히트박스 축의 동치 복구는 이번 PR 범위가 아니다 — 원장 24ba로
 * 이월한다.** 복구하려면 이 파일이 각 후보의 `mode`를 알아야 하는데, 서버
 * `Player` 스키마는 자세를 다른 클라이언트에 동기화하지 않는다(원장
 * **24az** — 스키마 필드 0건). 즉 와이어 프로토콜 확장(스키마에 `mode`
 * 필드 추가)이 선행이고, 이 파일의 대상 히트박스 선택 로직 변경은 그
 * 뒤에 온다.
 *
 * ⚠️ **테스트가 그 동치를 고정하는 범위는 차폐 목록·조준 벡터 두 축까지다** —
 * 히트박스·눈 원점 축은 아직 변이가 살아남는다(원장 24ae). 즉 이 주석의
 * "같은 차폐 목록"은 **코드가 그렇게 되어 있다**는 서술이지 테스트가 지킨다는
 * 뜻이 아니다.
 *
 * ## 서버와 **일부러** 다른 두 가지
 *
 * 1. **탄퍼짐을 적용하지 않는다.** 서버는 발사 시 시드로 콘 안에서 방향을
 *    흔든다(RQ-90). 이름표는 **지금 조준한 곳**을 알려 주는 표시이고 탄착점
 *    예언이 아니다 — 크로스헤어가 확산을 "이만큼 퍼질 수 있다"로만 보여 주는
 *    것과 같은 성격이다(원장 24e). CS도 조준하면 이름이 뜨지만 총알은 빗나갈
 *    수 있다.
 * 2. **랙 보상 되감기를 하지 않는다.** RQ-64의 되감기는 서버가 사수의 RTT만큼
 *    과거로 돌리는 판정이다. 저RTT에서는 스냅샷 쪽이 서버가 보는 것에 더 가까워
 *    선택 축에서는 이 차이가 작다.
 *
 * ⚠️ **앵커는 다르다 — 반드시 보간 위치를 써야 한다.** 몸은 `PlayerMeshes`가
 * `renderTime − 보간 지연`에 그린다. 앵커에 최신 스냅샷을 쓰면 그 지연만큼
 * (`MOVEMENT.SPEED` 6m/s × 66.67ms = **0.40m**, 바디 반경 0.3m보다 크다)
 * 이름이 몸 옆 허공에 뜬다 — RQ-56의 "머리 위" 문면 위반이다. 초안이 주석에는
 * "보간 위치를 쓴다"고 적고 코드는 스냅샷을 썼다(PR #66 리뷰 blocker 2).
 * 그래서 앵커 좌표는 **호출자가 보간기에서 얻어 넘긴다**(`anchorPosition`).
 *
 * 즉 동치는 **"차폐와 조준선"** 축에서 성립하고, 확산·되감기라는 **확률·시간**
 * 축은 애초에 이름표의 관심사가 아니다.
 *
 * ## 표현 계층이다 (RQ-61 대상 아님)
 *
 * 이 판정은 HP·킬·명중처럼 서버가 확정할 값이 아니다. 클라가 정해도 정보
 * 누출이 늘지 않는다 — 타인 좌표는 **렌더하려면 어차피** 클라에 있어야 한다.
 *
 * 렌더 계층 면제 대상이 아니다(ADR-0008 §6은 WebGL·씬 그래프를 면제한다) —
 * 이 파일은 순수 함수이고 `tests/unit/rq-56-nameplate-target.test.ts`가 시험한다.
 */

import { eyeOrigin, findClosestHit, type HitCandidate, type Vec3 } from '@shared/sim/combat'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { canAct } from '@shared/sim/lifecycle'
import type { WallAABB } from '@shared/sim/movement'

/** 이름표가 필요한 최소 플레이어 정보 — 클라 스토어(`PlayerView`)의 부분집합.
 * 스토어 타입을 그대로 요구하지 않는 이유는 이 함수를 스토어 없이 시험하기
 * 위해서다(`chatInputGate`의 `ChatGatedConnection`과 같은 좁힘). */
export interface NameplateCandidate {
  nickname: string
  x: number
  y: number
  z: number
  /** 서버 확정 HP. **시신을 거르는 데만** 쓴다 — 서버 `handleFire`가
   * `canAct(player.hp)`로 시신을 사격 후보에서 빼기 때문이다. 이 필터가 없으면
   * 시신이 3초(`RESPAWN_MS`)간 후보로 남아, **시신이 산 사람 앞에 있을 때**
   * 이름표는 시신을 가리키고 총알은 뒤의 산 사람을 맞힌다(PR #66 리뷰
   * blocker 1) — 이 라운드가 세운 동치가 그 자리에서 깨진다. */
  hp: number
}

/** 조준선이 향한 대상. 없으면 `undefined`. */
export interface NameplateTarget {
  sessionId: string
  nickname: string
  /** 이름표를 띄울 월드 좌표(대상 머리 **위**). 화면 투영은 호출자가 한다. */
  anchor: Vec3
}

/**
 * 이름표를 띄울 머리 위 높이 — 머리 볼륨 상단(`headCenterM + headRadiusM`)에서
 * 유도한다. 리터럴을 쓰면 히트박스가 바뀔 때 이름표만 몸에 겹치거나 뜬다.
 *
 * 여유분 `0.25`는 글자가 정수리에 붙지 않을 만큼만 띄우는 렌더 선택값이다
 * (스펙에 없다 — RQ-56은 "머리 위"까지만 규정한다).
 */
const NAMEPLATE_HEAD_CLEARANCE_M = 0.25

export function nameplateAnchorHeightM(): number {
  return DEFAULT_HITBOX.headCenterM + DEFAULT_HITBOX.headRadiusM + NAMEPLATE_HEAD_CLEARANCE_M
}

/**
 * 조준선이 향한 플레이어를 고른다.
 *
 * @param selfFoot 자신의 **발** 위치(예측 위치). 눈 높이는 여기서 유도한다.
 * @param aimDirection 조준 방향 단위 벡터(`@client/input/aimMath`의 `yawPitchToDirection` 결과).
 * @param others 자신을 **제외한** 플레이어들. 자기 자신이 섞이면 자기 이름이 뜬다.
 * @param walls 차폐 목록 — 서버가 `findClosestHit`에 넘기는 것과 **같은 값**이어야 한다.
 * @param anchorPosition 대상의 **보간 표시 위치**(발)를 돌려준다. `undefined`를
 *   돌려주면 스냅샷 위치로 떨어진다 — 보간 이력이 아직 없는 첫 프레임의 폴백이다.
 * @param selfEyeHeightM **REV2(PR #68 blocker, 2026-08-07)** — 사수 자신의 레이
 *   원점 눈높이. 생략하면 `DEFAULT_HITBOX.eyeHeightM`(선 자세) — 기존 호출부
 *   전부가 그대로 유효한 안전한 기본값이다. `mode`가 아니라 계산된 숫자를 받는
 *   이유: `eyeOrigin`·`effectiveSpreadConeRadius`가 이미 확립한 "값을 함수
 *   내부에서 직접 import하지 않고 호출자가 넘긴다"(config→sim 의존 방향) 관례를
 *   그대로 따른다 — 호출자(`PlayerControls.tsx`)는 이미
 *   `hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, mode).eyeHeightM`을 계산해
 *   카메라·서버 레이 양쪽에 쓰고 있으므로 그 값을 그대로 넘기면 된다 — 이
 *   파일이 `hitboxForMode`/`CROUCH_HITBOX`를 새로 import할 필요가 없다.
 *   ⚠️ **닫는 범위는 사수 자신의 눈 원점 축뿐**이다 — 대상 후보의 히트박스
 *   (`bodyRadiusM` 등)가 자세에 따라 달라지는 축은 여전히 원장 24ba의
 *   영역이다(위 모듈 상단 REV2 절 참고).
 */
export function resolveNameplateTarget(
  selfFoot: Vec3,
  aimDirection: Vec3,
  others: ReadonlyMap<string, NameplateCandidate>,
  walls: readonly WallAABB[],
  anchorPosition?: (sessionId: string) => Vec3 | undefined,
  selfEyeHeightM: number = DEFAULT_HITBOX.eyeHeightM,
): NameplateTarget | undefined {
  if (others.size === 0) return undefined

  const candidates: HitCandidate[] = []
  for (const [sessionId, player] of others) {
    // 시신 제외 — 서버 `handleFire`(`GameRoom.ts`)가 쓰는 것과 **같은 술어**다.
    if (!canAct(player.hp)) continue
    candidates.push({ id: sessionId, pose: { position: { x: player.x, y: player.y, z: player.z } } })
  }
  if (candidates.length === 0) return undefined

  const hit = findClosestHit(
    { origin: eyeOrigin(selfFoot, selfEyeHeightM), direction: aimDirection },
    candidates,
    DEFAULT_HITBOX,
    walls,
  )
  if (!hit) return undefined

  const player = others.get(hit.id)
  // 위 루프가 `others`에서 후보를 만들었으므로 정상 경로에서는 항상 있다.
  // 방어적으로 두는 이유는 `findClosestHit`이 id를 그대로 돌려준다는 계약에
  // 이 파일이 의존하기 때문이다 — 그 계약이 바뀌면 조용히 틀리는 대신 사라진다.
  if (!player) return undefined

  // 몸이 그려지는 자리(보간)에 이름을 붙인다 — 위 ⚠️ 참고.
  const foot = anchorPosition?.(hit.id) ?? { x: player.x, y: player.y, z: player.z }
  return {
    sessionId: hit.id,
    nickname: player.nickname,
    anchor: { x: foot.x, y: foot.y + nameplateAnchorHeightM(), z: foot.z },
  }
}
