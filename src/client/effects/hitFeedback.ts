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

export interface HitFeedbackState {
  bulletHoles: readonly BulletHole[]
  hitEffects: readonly HitEffect[]
}

export function createHitFeedbackState(): HitFeedbackState {
  return { bulletHoles: [], hitEffects: [] }
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
 */
export function advanceHitFeedback(state: HitFeedbackState, nowMs: number): HitFeedbackState {
  const hasExpired = state.hitEffects.some((effect) => effect.expiresAtMs <= nowMs)
  if (!hasExpired) return state
  return { ...state, hitEffects: state.hitEffects.filter((effect) => effect.expiresAtMs > nowMs) }
}
