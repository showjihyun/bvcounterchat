import type { Vec3 } from '@shared/sim/combat'
import { EFFECTS } from '@shared/constants'

/**
 * RQ-70(탄흔)·RQ-71(피격 효과) — 판정·수집 층(ADR-0016 결정 4, 면제
 * 없음). 서버가 보낸 명중 이벤트를 그대로 옮겨 담는 순수 컬렉터다 —
 * DOM·Three.js·zustand 어디에도 의존하지 않는다. 렌더 배선(`InstancedMesh`
 * 링버퍼 등)은 이 모듈의 책임이 아니다(`harness/workflow/fe.md` "효과
 * 처리" — 그건 스크린샷 확인이 대신한다).
 *
 * RQ-61 서버 권위: `point`·`normal`은 이벤트가 준 값을 그대로 쓴다 —
 * 클라이언트가 재계산하지 않는다(GA-98).
 */

export type HitTargetKind = 'wall' | 'player'

/** 서버 'hit' 브로드캐스트 payload와 동일 shape(ADR-0016 결정 1 개정,
 * 2026-08-15, 원장 24ct — "명중 좌표·표면 법선·명중 대상의 종류"에 사수·
 * 피격자 식별자를 더한다).
 *
 * `shooterId`·`victimId`는 TS 레벨에서 **선택 필드**다 — 런타임 보장은
 * 다르다: 서버는 항상 `shooterId`를 채우고, 대상이 플레이어일 때만
 * `victimId`를 채운다(RQ-57·58·59 공통 절 요구 1·2). TS 옵셔널로 둔 것은
 * 오직 `rq-70-71-hit-feedback.test.ts`의 기존 리터럴(식별자 없이
 * `{ point, normal, target }`만 있는 `wallEvent`류)이 그대로 컴파일되게
 * 하려는 하위호환 조치다 — 런타임 값 자체는
 * `tests/integration/rq-57-59-hit-event-identity.test.ts`가 검증한다. */
export interface HitEvent {
  point: Vec3
  normal: Vec3
  target: HitTargetKind
  shooterId?: string
  victimId?: string
}

/** GA-119 then의 3분기 — "나와의 관계"만 표현하는 값이다. HP·킬·데미지
 * 필드를 가질 수 있는 객체가 아니라 원시 문자열 리터럴 유니온이다(RQ-61 —
 * 그런 값은 서버 스냅샷에서만 온다). */
export type HitRelation = 'shooter' | 'victim' | 'bystander'

/**
 * 명중 이벤트의 식별자로 "나와의 관계"만 가른다(ADR-0016 결정 4 "판정" 층,
 * 면제 없음). `event.shooterId`/`event.victimId`를 `selfSessionId`와
 * **문자열 그대로** 비교할 뿐, 좌표(`point`/`normal`)를 읽지도 재구성하지도
 * 않는다(GA-98이 좌표에 대해 세운 "재계산 금지" 원칙을 관계 판정에 그대로
 * 적용 — GA-120). HP·킬·데미지 등 다른 어떤 상태도 이 함수의 입력에도
 * 출력에도 없다 — 시그니처 자체가 "가르기만 하고 계산하지 않는다"의 구조적
 * 보장이다. 순수 함수(외부 상태 참조 없음, RQ-61: 확정값은 서버 스냅샷에서만
 * 온다).
 */
export function classifyHitRelation(event: HitEvent, selfSessionId: string): HitRelation {
  if (event.shooterId === selfSessionId) return 'shooter'
  if (event.victimId === selfSessionId) return 'victim'
  return 'bystander'
}

export interface BulletHole {
  point: Vec3
  normal: Vec3
}

export interface HitEffect {
  point: Vec3
  normal: Vec3
  /** `applyHitEvent` 호출 시 `nowMs + hitEffectDurationMs`로 확정된다(TTL, GA-99). */
  expiresAtMs: number
}

/** RQ-57 히트마커 신호(원장 24cv) — "내 총알이 플레이어에 명중했다"는 사실
 * 하나만 담는다. 그릴 위치가 필요 없다(크로스헤어 위에 겹치는 고정 위치라
 * `point`·`normal`을 옮기지 않는다) — TTL만 있으면 충분하다. */
export interface HitMarkerSignal {
  expiresAtMs: number
}

/** RQ-58 피격 방향 원시 신호(원장 24cv) — "내가 맞았다"는 사실과 이벤트의
 * `normal`을 **그대로** 옮긴다(재계산 금지, GA-98과 같은 원칙). 화면
 * 가장자리로의 변환(카메라 yaw가 필요하다)은 이 층의 책임이 아니다 — 이
 * 파일은 카메라를 모른다. 변환은 `@client/hud/hitDirectionEdge`가 scene
 * 레이어(카메라 접근 가능)를 통해 담당한다. */
export interface HitDirectionSignal {
  normal: Vec3
  expiresAtMs: number
}

export interface HitFeedbackState {
  bulletHoles: readonly BulletHole[]
  hitEffects: readonly HitEffect[]
  /** RQ-57 — 사수 자신에게만 채워진다(`applyHitReaction`). */
  hitMarker: HitMarkerSignal | null
  /** RQ-58 — 피격자 자신에게만 채워진다(`applyHitReaction`). */
  hitDirection: HitDirectionSignal | null
}

export function createHitFeedbackState(): HitFeedbackState {
  return { bulletHoles: [], hitEffects: [], hitMarker: null, hitDirection: null }
}

/**
 * `event.target`으로 컬렉션을 가른다(GA-98) — `'wall'`이면 탄흔 컬렉션
 * 끝에 추가하고 `EFFECTS.BULLET_HOLE_CAP`(64, RQ-70 확정값)을 넘으면
 * **가장 오래된 것부터**(배열 앞) 제거한다(FIFO, GA-96). `'player'`면
 * 피격 컬렉션 끝에 추가한다(개수 상한 없음 — RQ-71 원문에 없다, TTL만
 * `advanceHitFeedback`이 담당). 어느 쪽이든 `point`·`normal`은 이벤트에서
 * 읽은 값을 **그대로** 옮긴다(재계산 금지).
 *
 * `hitEffectDurationMs`를 함수 인자로 받는 이유(숨긴 튜닝 상수 금지 —
 * `combat.ts`의 `eyeOrigin(footPosition, eyeHeightM)`·`interpolation.ts`의
 * `delayMs` 생성자 인자와 동일한 규율): 이 값은 ADR-0016 결정 3이
 * "확정하지 않은 튜닝값"으로 남긴 값이라 어디선가는 주입돼야 하고, 이
 * 순수 함수가 그 출처(설정 모듈)를 스스로 import하면 "sim이 config를
 * 아는" 방향이 뒤집힌다(`combat-tuning.ts` "의존 방향은 config→sim").
 */
export function applyHitEvent(
  state: HitFeedbackState,
  event: HitEvent,
  nowMs: number,
  hitEffectDurationMs: number,
): HitFeedbackState {
  if (event.target === 'wall') {
    const bulletHoles = [...state.bulletHoles, { point: event.point, normal: event.normal }]
    const overflow = bulletHoles.length - EFFECTS.BULLET_HOLE_CAP
    return { ...state, bulletHoles: overflow > 0 ? bulletHoles.slice(overflow) : bulletHoles }
  }

  return {
    ...state,
    hitEffects: [
      ...state.hitEffects,
      { point: event.point, normal: event.normal, expiresAtMs: nowMs + hitEffectDurationMs },
    ],
  }
}

/**
 * RQ-57(히트마커)·RQ-58(피격 방향) — ADR-0016 결정 1 개정(원장 24ct)이 실은
 * 식별자로 "나와의 관계"만 가른다. `classifyHitRelation`을 그대로 재사용한다
 * (새 판정을 만들지 않는다 — team-lead 지시, ADR-0010) — HP·킬·데미지는
 * 여전히 계산하지 않는다(RQ-61).
 *
 * `applyHitEvent`(탄흔·피격 효과 수집)와는 **독립적인 신호**다 — 같은 'hit'
 * 이벤트를 두 함수에 각각 통과시켜도 서로 간섭하지 않는다(호출 순서 무관,
 * `gameStore.addHitEvent`가 둘 다 호출한다). 이 함수를 분리한 이유:
 * `applyHitEvent`의 4-인자 시그니처는 기존 테스트(`rq-70-71-hit-feedback
 * .test.ts`)가 다수 호출하므로 시그니처를 바꾸면(예: `selfSessionId` 추가)
 * 그 파일 전체가 깨진다 — test-after 영역이라도 기존 단언은 건드리지 않는다
 * (coder 작업 규약).
 *
 * ⚠️ **자격이 없는 이벤트는 기존 신호를 그대로 둔다** — 예를 들어 남이 남을
 * 맞힌 이벤트(bystander)가 도착해도 내가 방금 맞힌 것에 대한 아직 살아있는
 * `hitMarker`를 지우면 안 된다. TTL 만료는 오직 `advanceHitFeedback`의
 * 책임이다(관심사 분리 — 이 함수는 "새 신호를 켤지"만 판단한다).
 *
 * @param hitMarkerDurationMs RQ-57 히트마커 지속 시간(ms) — 스펙이 "일시적"
 *   만 규정한 튜닝값이라 호출자가 주입한다(`applyHitEvent`의
 *   `hitEffectDurationMs`와 동일한 규율 — sim이 config를 모른다).
 * @param hitDirectionDurationMs RQ-58 피격 방향 지속 시간(ms) — 위와 동일.
 */
export function applyHitReaction(
  state: HitFeedbackState,
  event: HitEvent,
  nowMs: number,
  selfSessionId: string,
  hitMarkerDurationMs: number,
  hitDirectionDurationMs: number,
): HitFeedbackState {
  const relation = classifyHitRelation(event, selfSessionId)

  // RQ-57/GA-122 — 히트마커는 "내 총알이 **플레이어**에 명중"에만 뜬다.
  // shooterId는 벽 명중에도 항상 채워지므로(RQ-57·58·59 공통 요구 1)
  // relation === 'shooter'만으로는 벽 명중을 걸러내지 못한다 —
  // event.target === 'player'를 함께 요구해야 한다.
  const hitMarker: HitMarkerSignal | null =
    relation === 'shooter' && event.target === 'player'
      ? { expiresAtMs: nowMs + hitMarkerDurationMs }
      : state.hitMarker

  // RQ-58 — 피격 방향은 "내가 맞았을 때"(relation === 'victim')만. victimId는
  // 대상이 플레이어일 때만 채워지므로(공통 요구 2) target 재확인이 불필요하다
  // — relation이 'victim'이면 target은 이미 'player'다.
  const hitDirection: HitDirectionSignal | null =
    relation === 'victim' ? { normal: event.normal, expiresAtMs: nowMs + hitDirectionDurationMs } : state.hitDirection

  // 참조 안정성(advanceHitFeedback의 관례와 동일한 정신) — 아무것도 안
  // 바뀌었으면 새 객체를 만들지 않는다(불필요한 zustand 알림 방지).
  if (hitMarker === state.hitMarker && hitDirection === state.hitDirection) return state
  return { ...state, hitMarker, hitDirection }
}

/**
 * 만료된(`expiresAtMs <= nowMs`) 피격 효과를 제거한다(GA-97/GA-99, RQ-71
 * "일시적"). `bulletHoles`는 **시간으로는 절대 사라지지 않는다**(RQ-70
 * "상한이 유일한 제거 규칙") — 이 함수는 `bulletHoles`를 건드리지 않는다
 * (내용·순서·참조 그대로).
 *
 * ⚠️ 이 함수 자신은 `Date.now()`/`performance.now()`를 호출하지 않는다
 * (ADR-0008 정신 — 순수 함수는 시각을 인자로만 받는다). `nowMs`는
 * 호출자(배선 계층)가 서버 틱에서 유도한 값으로 조달해야 한다(GA-99).
 *
 * **참조 안정성(이월 24cg, 결함 수정)**: 만료 대상이 0건이면 `hitEffects`
 * 배열 참조와 `state` 객체 참조를 **그대로**(동일성) 반환한다.
 * `Array.prototype.filter`는 제거 대상이 0건이어도 항상 새 배열을 만드는데,
 * `connection.ts`의 `handleStateChange`가 매 상태 패치(초당 20~30회)마다
 * 이 함수를 부르므로 만료 대상이 없는 대다수 호출에서도 `hitEffects` 참조가
 * 그 빈도로 바뀌었었다.
 *
 * ⚠️ **무엇을 아끼는지 정확히 적는다**(델타 재평가 비블로커, 2026-08-12 —
 * 이 docblock의 초안이 "GPU 업로드·리렌더"라고 적었으나 **둘 다 틀렸다**):
 * 아끼는 것은 **zustand 스토어 알림 1회/패치**다. `gameStore`의
 * `advanceHitFeedback`이 `set((state) => advanceHitFeedbackState(state, …))`
 * 이고, zustand `vanilla.js`의 `setState`는 `Object.is(nextState, state)`가
 * 참이면 **루트 객체 재생성(`Object.assign`)과 리스너 통지를 통째로
 * 건너뛴다** — 즉 만료가 없는 패치에서 `PlayerMeshes`의 `store.subscribe`
 * 같은 **다른 구독자들이 깨어나지 않는다**.
 * **아끼지 않는 것 둘**: ① GPU 업로드 — `decalLayout.ts`의
 * `syncDecalInstances`가 `instanceMatrix.needsUpdate = true`를 **매 프레임
 * 무조건** 설정하므로 참조와 무관하다 ② `HitDecals.tsx`의 React 리렌더 —
 * 그 컴포넌트는 **구독하지 않는다**(`useFrame` + `getState()`,
 * `harness/workflow/fe.md` 레이어 규칙).
 *
 * `bulletHoles`가 이미 "참조 그대로"를 보장하므로(위 docblock), 이 대칭을
 * `hitEffects`에도 맞춘다.
 *
 * ⚠️ **원장 24cv 확장 — `hitMarker`·`hitDirection`(RQ-57·58)도 같은 갱신
 * 함수가 다룬다**(GA-97이 세운 "같은 갱신 함수가 여러 컬렉션을 함께 다룬다"
 * 선례를 그대로 확장). 두 신호는 원소가 아니라 단일 `... | null` 값이라
 * `filter` 대신 만료 시 `null`로 되돌린다. 참조 안정성 규칙은 동일하게
 * 적용된다 — 셋(`hitEffects`·`hitMarker`·`hitDirection`) 중 **무엇도 만료
 * 대상이 없으면** `state`를 그대로 반환한다(`rq-70-71-hit-feedback.test.ts`의
 * 기존 24cg 테스트는 `hitMarker`/`hitDirection`이 항상 `null`인 시나리오만
 * 쓰므로 이 확장으로 깨지지 않는다 — `null`은 만료 대상이 될 수 없다).
 */
export function advanceHitFeedback(state: HitFeedbackState, nowMs: number): HitFeedbackState {
  const hitEffectsExpired = state.hitEffects.some((effect) => effect.expiresAtMs <= nowMs)
  const hitMarkerExpired = state.hitMarker !== null && state.hitMarker.expiresAtMs <= nowMs
  const hitDirectionExpired = state.hitDirection !== null && state.hitDirection.expiresAtMs <= nowMs
  if (!hitEffectsExpired && !hitMarkerExpired && !hitDirectionExpired) return state
  return {
    ...state,
    hitEffects: hitEffectsExpired ? state.hitEffects.filter((effect) => effect.expiresAtMs > nowMs) : state.hitEffects,
    hitMarker: hitMarkerExpired ? null : state.hitMarker,
    hitDirection: hitDirectionExpired ? null : state.hitDirection,
  }
}
