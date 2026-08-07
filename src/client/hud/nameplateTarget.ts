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
 * ✅ **REV3(RQ-92 v2.4, 2026-08-08, 원장 24az) — 대상 히트박스 축도 이
 * PR에서 닫았다. 원장 24ba가 완전히 해소됐다.** REV2 이후 남아 있던 문제 —
 * 이 파일이 판정하는 대상 볼륨이 클라 `[0,1.5]`(바디)+`[1.5,1.8]`(머리)로
 * 고정이라 서버가 실제로 판정하는 앉은 대상 볼륨(`[0,1.05]`+`[1.05,1.35]`)과
 * 갈라졌던 것 — 은 `Player` 스키마에 `mode` 필드가 실려(RQ-92 v2.4 와이어
 * 확장, `GameRoom.ts` "grounded"와 동일한 관례) 클라가 각 후보 자신의 자세를
 * 알게 되면서 근거 자체가 사라졌다. `NameplateCandidate.mode`(아래 인터페이스)
 * 를 후보가 지니고, `resolveNameplateTarget`이 `GameRoom.handleFire`와
 * **정확히 같은 알고리즘**(자세별 두 그룹으로 나눠 그룹마다
 * `findClosestHit`을 부른 뒤 거리로 병합, `GameRoom.ts` "RQ-92 v2.2: 후보를
 * ... 자세별 두 그룹으로 나눈다" 절과 동일 — ADR-0010 "논리 복제")을
 * 재사용한다. **이제 이름표는 앉은 대상에서도 서버와 완전히 같은 대상·같은
 * 히트박스로 판정된다.**
 *
 * ⚠️ **테스트가 그 동치를 고정하는 범위는 차폐 목록·조준 벡터 두 축까지다** —
 * 히트박스·눈 원점 축은 아직 변이가 살아남는다(원장 24ae). 즉 이 주석의
 * "같은 차폐 목록"은 **코드가 그렇게 되어 있다**는 서술이지 테스트가 지킨다는
 * 뜻이 아니다.
 *
 * ✅ **REV4(PR #68 리뷰 F1 blocker, 2026-08-08, 원장 24az 후속) — 앵커
 * "높이"에도 같은 시간축 문제가 있었다.** REV3이 대상 히트박스 축을 최신
 * `mode`로 닫았지만, **표시**(앵커 높이) 쪽은 여전히 최신 `mode`를 썼다 —
 * 몸은 `PlayerMeshes.tsx`가 `remoteMeshHeightM(interpolator.getMode(...))`로
 * **보간 지연된** 자세로 그리는데, 앵커 높이는 `nameplateAnchorHeightM
 * (player.mode)`로 **최신** 자세를 썼다. 정지 상태에서는 두 값이 항상
 * 같아 드러나지 않고, 전환 직후 보간 지연 창(66.67ms) 안에서만 어긋난다
 * — 실측: 일어서는 순간 그려진 몸은 아직 1.35m인데 앵커는 2.05m(0.7m
 * 허공, GA-73 `then`이 적은 바로 그 수치이자 PR #66에서 blocker였던
 * 0.40m보다 크다). 7번째 파라미터 `anchorMode`(아래 함수 docblock)로
 * 닫았다 — **앵커 위치(§위 "앵커는 다르다")와 앵커 높이가 이제 같은
 * 시간축(보간 지연)을 본다.** ⚠️ **대상 선택·히트박스 판정(REV3, GA-74)은
 * 건드리지 않았다** — 서버는 항상 최신 입력으로 판정하므로(RQ-61), 그
 * 축까지 지연시키면 "쏠 수 있으면 보인다" 동치가 오히려 깨진다. 시간축을
 * 맞춰야 하는 것은 **표시뿐**이다.
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

import { eyeOrigin, findClosestHit, hitboxForMode, type ClosestHit, type HitCandidate, type Vec3 } from '@shared/sim/combat'
import { CROUCH_HITBOX, DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { canAct } from '@shared/sim/lifecycle'
import type { MoveInput, WallAABB } from '@shared/sim/movement'

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
  /** RQ-92 v2.4(원장 24az, GA-74) — 서버가 확정한 자세(`Player.mode`,
   * `grounded`와 동일한 관례로 서버가 매 틱 권위 값을 싣는다, RQ-61).
   * 옵셔널 — 생략하면 선 자세(`'run'`)로 취급한다(기존 호출부 순증 규칙,
   * `hp`가 PR #66에서 그랬던 것과 동일 근거). `resolveNameplateTarget`이
   * 후보 **자신의** 이 값으로 히트박스(GA-74)·이름표 앵커(GA-73)를 고른다. */
  mode?: MoveInput['mode']
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

/**
 * **REV(RQ-92 v2.4, 2026-08-08, 원장 24az, GA-73)** — `mode` 파라미터
 * 추가(옵셔널, 기본값 `'run'` — 기존 0-인자 호출 전부 그대로 유효). 지금까지
 * 이 값은 선 자세 히트박스(2.05m)로 고정이었다 — 메시 높이(`remoteMeshHeightM`,
 * GA-72)만 앉은 자세로 줄이고 이 값을 그대로 두면 **앉은 대상의 이름표가
 * 줄어든 몸(1.35m) 위 0.7m 허공에 남는다**(PR #66에서 0.40m 오프셋이
 * blocker였던 것과 같은 축, 이번엔 더 크다). `hitboxForMode`(RQ-92 정본
 * 히트박스 선택 로직)를 그대로 재사용해 앉은 자세는 1.6m로 낮아진다.
 */
export function nameplateAnchorHeightM(mode: MoveInput['mode'] = 'run'): number {
  const hitbox = hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, mode)
  return hitbox.headCenterM + hitbox.headRadiusM + NAMEPLATE_HEAD_CLEARANCE_M
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
 *
 * **REV3(RQ-92 v2.4, 2026-08-08, 원장 24az, GA-74)** — 대상 후보도 자세를
 * 가질 수 있다(`NameplateCandidate.mode`). 후보를 **자신의** `mode`로 두
 * 그룹(선 자세·앉은 자세)으로 나눠 그룹마다 `findClosestHit`을 한 번씩
 * 부른 뒤, 두 결과가 모두 있으면 **거리로** 더 가까운 쪽을 취한다 —
 * `GameRoom.handleFire`가 이미 하는 바로 그 알고리즘을 그대로 복제한다
 * (ADR-0010 "논리 복제"). ⚠️ `findClosestHit`의 "가장 가까운 것 하나"
 * 계약은 **그룹 안에서만** 성립한다 — 그룹 간 최단 거리 비교를 빠뜨리면
 * (예: `standingHit ?? crouchHit`처럼 한쪽을 무조건 우선하면) 실제로는 더
 * 먼 그룹이 뽑힌다(RQ-92 F1 라운드에서 `GameRoom.handleFire` 구현 중 실제로
 * 났던 결함과 같은 계열 — `GameRoom.ts`의 같은 절 주석 참고). **이 그룹
 * 판정(대상 선택·히트박스)은 항상 후보의 최신 `mode`를 쓴다 — 아래
 * `anchorMode`(표시 전용)의 영향을 받지 않는다(REV4).**
 *
 * @param anchorMode **REV4(PR #68 F1 blocker, 2026-08-08)** — 선택된
 *   대상의 이름표 **앵커 높이**를 계산할 때 쓸 자세를 돌려준다.
 *   `anchorPosition`(5번째)과 완전히 대칭인 위치·원칙 — "최신 스냅샷
 *   값"(그룹 판정, 위)과 "호출자가 보간기에서 얻어 넘기는 지연 값"(표시)을
 *   분리한다. 프로덕션 호출부는 `interpolator.getMode(id, now())`를
 *   넘긴다 — `PlayerMeshes.tsx`가 몸 높이(`remoteMeshHeightM`)에 쓰는 것과
 *   **같은 호출**이라 몸과 앵커가 항상 같은 시간축을 본다. 생략하거나
 *   `undefined`를 반환하면(첫 프레임 등 보간 이력이 아직 없음)
 *   `player.mode`(후보의 최신 자세)로 떨어진다 — `anchorPosition`을
 *   생략하면 "지연 없는 스냅샷 위치"로 떨어지는 것과 정확히 같은 등급의
 *   폴백이다(원장 24bd가 경고한 "조용히 틀린 값" 위험을 그대로 인지하고
 *   받아들인다 — `anchorPosition`이 이미 같은 위험을 안고 코드 리뷰로
 *   관리돼 왔다). **옵셔널인 것은 선택이 아니라 강제다** — 다만 ⚠️ **근거를
 *   정정한다**(독립 평가 D1, tsc 6.0.3 실측): 원인은 6번째
 *   `selfEyeHeightM`이 아니라 **5번째 `anchorPosition?`** 다.
 *   `selfEyeHeightM`은 `?` 옵셔널이 아니라 **기본값 파라미터**이고,
 *   기본값 뒤에 필수 인자를 두는 것 자체는 **컴파일된다**(실측). TS1016을
 *   내는 것은 `?` 옵셔널 뒤의 필수뿐이다. 결론은 그대로다 —
 *   `anchorPosition?`가 5번째에 있는 한 **그 뒤 어떤 인자도 필수가 될 수
 *   없다**. "순증만" 규칙도 같은 결론을 강제한다.
 *   ⚠️ **함의**: 원장 24bd에 적힌 수정안("`selfEyeHeightM` 기본값을 제거해
 *   필수로 승격")은 **그대로는 구현 불가**다. 실행 가능한 형태는 꼬리 3개를
 *   **하나의 필수 옵션 객체**로 묶는 것이다(원장 24bd 참고).
 */
export function resolveNameplateTarget(
  selfFoot: Vec3,
  aimDirection: Vec3,
  others: ReadonlyMap<string, NameplateCandidate>,
  walls: readonly WallAABB[],
  anchorPosition?: (sessionId: string) => Vec3 | undefined,
  selfEyeHeightM: number = DEFAULT_HITBOX.eyeHeightM,
  anchorMode?: (sessionId: string) => MoveInput['mode'] | undefined,
): NameplateTarget | undefined {
  if (others.size === 0) return undefined

  // RQ-92 v2.4(GA-74) — 후보를 **자신의** mode로 자세별 두 그룹으로 나눈다.
  // findClosestHit의 hitbox 인자가 후보 전체에 균일하게 적용되므로, 서로
  // 다른 자세가 섞인 후보 집합은 한 번의 호출로 정확히 판정할 수 없다
  // (`GameRoom.handleFire`의 같은 절과 동일 근거).
  //
  // ⚠️ **`mode === 'crouch'`를 여기서 직접 재판정하지 않는다** —
  // `hitboxForMode`를 매핑 정본으로 그대로 쓴다(원장 24be: `GameRoom
  // .handleFire`가 이 판정을 `hitboxForMode` 안과 그룹핑 코드 두 곳에
  // 복제해 "자세가 3종 이상이 되면 한쪽만 고쳐 갈라진다"는 결함을 남겼다
  // — 새 코드에서 같은 함정을 반복하지 않는다). `hitboxForMode`가 둘 중
  // 하나를 그대로 반환하는 계약이므로(새 객체 생성 없음) 참조 동일성으로
  // 그룹을 가른다.
  //
  // ⚠️ **평가 F3 — 이 참조 동일성 위임에는 직접 단언이 없다(test-writer
  // 영역, 이 라운드는 코드 주석으로만 계약을 명시한다).** 아래 `===
  // CROUCH_HITBOX` 판정은 **`hitboxForMode`가 인자로 받은 두 객체 중
  // 하나를 새로 만들지 않고 그대로 반환한다**는 계약에 전적으로
  // 의존한다 — 그 함수가 훗날 `{ ...crouch }`처럼 복사본을 반환하도록
  // 바뀌면 이 판정은 (컴파일 에러 없이) 조용히 항상 `standingCandidates`
  // 쪽으로만 떨어진다.
  //
  // ⚠️ **평가 F4 — 서버(`GameRoom.handleFire`)는 아직 `mode === 'crouch'`
  // 직접 비교 스타일이다(원장 24be, 이 PR 스코프 밖 — 24be가 소유한
  // 이월).** 이 파일만 참조 동일성 위임으로 리팩터돼 두 판정 술어의
  // "스타일"이 갈렸다 — 결과(어느 후보가 어느 그룹에 들어가는가)는
  // 오늘 시점 두 스타일이 동일하므로 동작 차이는 없다. 다음 사람이 두
  // 스타일을 보고 헷갈리지 않도록 남긴다.
  const standingCandidates: HitCandidate[] = []
  const crouchCandidates: HitCandidate[] = []
  for (const [sessionId, player] of others) {
    // 시신 제외 — 서버 `handleFire`(`GameRoom.ts`)가 쓰는 것과 **같은 술어**다.
    if (!canAct(player.hp)) continue
    const candidate: HitCandidate = { id: sessionId, pose: { position: { x: player.x, y: player.y, z: player.z } } }
    if (hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, player.mode ?? 'run') === CROUCH_HITBOX) {
      crouchCandidates.push(candidate)
    } else {
      standingCandidates.push(candidate)
    }
  }
  if (standingCandidates.length === 0 && crouchCandidates.length === 0) return undefined

  const ray = { origin: eyeOrigin(selfFoot, selfEyeHeightM), direction: aimDirection }
  const standingHit = findClosestHit(ray, standingCandidates, DEFAULT_HITBOX, walls)
  const crouchHit = findClosestHit(ray, crouchCandidates, CROUCH_HITBOX, walls)

  // RQ-92 v2.4 — "가장 가까운 것 하나" 계약은 그룹 안에서만 성립한다.
  // 두 그룹을 합친 전체에서 가장 가까운 하나를 얻으려면 이 함수가 직접
  // 거리로 비교해야 한다(그룹 간 최단 거리 비교, GA-74).
  let hit: ClosestHit | undefined
  if (standingHit && crouchHit) {
    hit = (standingHit.result.distance as number) <= (crouchHit.result.distance as number) ? standingHit : crouchHit
  } else {
    hit = standingHit ?? crouchHit
  }
  if (!hit) return undefined

  const player = others.get(hit.id)
  // 위 루프가 `others`에서 후보를 만들었으므로 정상 경로에서는 항상 있다.
  // 방어적으로 두는 이유는 `findClosestHit`이 id를 그대로 돌려준다는 계약에
  // 이 파일이 의존하기 때문이다 — 그 계약이 바뀌면 조용히 틀리는 대신 사라진다.
  if (!player) return undefined

  // 몸이 그려지는 자리(보간)에 이름을 붙인다 — 위 ⚠️ 참고.
  const foot = anchorPosition?.(hit.id) ?? { x: player.x, y: player.y, z: player.z }
  // RQ-92 v2.4 REV4(F1 blocker) — 앵커 **높이**도 앵커 **위치**와 같은
  // 시간축(보간 지연)을 봐야 한다. `anchorMode`가 있고 undefined가
  // 아니면 그 값(호출자가 보간기에서 얻은 지연 자세)을, 없으면 후보의
  // 최신 `mode`로 떨어진다 — `anchorPosition`의 스냅샷 폴백과 동일한
  // 원칙(원장 24bd 위험을 인지하고 받아들인다, 위 함수 docblock 참고).
  const heightMode = anchorMode?.(hit.id) ?? player.mode
  return {
    sessionId: hit.id,
    nickname: player.nickname,
    // `nameplateAnchorHeightM`은 `undefined`를 명시적으로 받아도 기본값
    // ('run')으로 대체한다(JS 파라미터 기본값 의미론).
    anchor: { x: foot.x, y: foot.y + nameplateAnchorHeightM(heightMode), z: foot.z },
  }
}
