import { describe, expect, it } from 'vitest'
import { classifyHitRelation, type HitRelation } from '@client/effects/hitFeedback'

/**
 * RQ-57·58·59 공통 — 명중 이벤트의 식별자, 클라이언트 판정 층(ADR-0016
 * 결정 4 "판정·수집" — 면제 없음. "클라이언트는 그 값으로 「나와의
 * 관계」만 판정한다"는 이 결정 자체가 판정 층으로 분류한 문장이다).
 *
 * EARS 문면(`harness/specs/requirements.md`, RQ-57·58·59 공통 절): "…
 * 클라이언트는 그 값으로 **자신과의 관계만** 가르고 **데미지·HP·킬을
 * 계산하지 않는다**(RQ-61 — 그 값은 서버 스냅샷에서만 온다)."
 *
 * 매핑된 골든 케이스: **GA-119·GA-120**
 * (`_workspace/RQ-57-59-identity/golden.json`).
 * - GA-119 then: "세 클라이언트가 같은 이벤트를 받고 각자 자기와의 관계를
 *   가른다 — 사수는 「내가 맞혔다」, 피격자는 「내가 맞았다」, 제3자는
 *   둘 다 아니다." → 이 파일의 "관계 판정" describe.
 * - GA-120 then: "클라이언트는 식별자로 **자기와의 관계만** 가르고
 *   **HP·킬·데미지를 계산하지 않는다** — 그 값은 서버 스냅샷에서만
 *   온다(RQ-61)." → 이 파일의 "식별자로만 판정 — 재구성 금지" describe.
 *
 * **레벨 분리(ADR-0008)**: 서버 payload 내용(식별자가 실제로 담기는가)은
 * `tests/integration/rq-57-59-hit-event-identity.test.ts`(GA-119, 실
 * Colyseus 룸 경계)가 담당한다. 이 파일은 **클라이언트가 그 식별자를 받은
 * 뒤 순수하게 판정하는 로직만** 검증한다 — 네트워크·zustand·렌더
 * 어디에도 의존하지 않는다(`hitFeedback.ts`의 기존 docblock "DOM·
 * Three.js·zustand 어디에도 의존하지 않는다"와 동일한 규율).
 *
 * **그린필드 계약(test-writer 지정 — `rq-70-71-hit-feedback.test.ts`
 * 선례와 동일한 권한: 신규 export의 API를 test-writer가 설계하고 coder가
 * 그대로 구현하면 이 파일이 Green이 된다)**:
 *
 * ```ts
 * // src/client/effects/hitFeedback.ts (기존 모듈 확장 — 신규 모듈 아님)
 *
 * // 기존 HitEvent에 식별자 두 필드를 추가한다. TS 레벨에서는 **선택
 * // 필드**로 둔다(런타임 보장은 다르다 — 서버는 항상 shooterId를 채우고,
 * // 대상이 플레이어일 때만 victimId를 채운다. 그 보장은 이 파일의
 * // 런타임 값 단언이 검증하고, TS 옵셔널은 오직 `rq-70-71
 * // -hit-feedback.test.ts`의 기존 리터럴(`{ point, normal, target }`만
 * // 있고 식별자가 없는 `wallEvent`류)이 그대로 컴파일되게 하려는
 * // 하위호환 조치다 — 그 파일은 test-writer가 손대지 않는다).
 * export interface HitEvent {
 *   point: Vec3
 *   normal: Vec3
 *   target: HitTargetKind
 *   shooterId?: string
 *   victimId?: string
 * }
 *
 * // 관계 3종 — GA-119 then의 "사수/피격자/제3자" 3분기를 그대로 옮긴 타입.
 * export type HitRelation = 'shooter' | 'victim' | 'bystander'
 *
 * // event.shooterId·event.victimId를 selfSessionId와 **문자열 그대로**
 * // 비교한다(재계산·재구성 금지 — GA-98이 좌표에 대해 세운 원칙과 같다,
 * // 이 파일이 좌표·법선을 이 함수에 관여시키지 않는 것으로 확인한다).
 * // point·normal·HP·킬·데미지 등 다른 어떤 상태도 매개변수로 받지
 * // 않는다 — 그 자체가 "가르기만 하고 계산하지 않는다"(GA-120)의 시그니처
 * // 수준 보장이다.
 * export function classifyHitRelation(event: HitEvent, selfSessionId: string): HitRelation
 * ```
 *
 * **BulletHole·HitEffect·applyHitEvent·advanceHitFeedback는 이 라운드가
 * 건드리지 않는다** — 탄흔·피격 효과 컬렉션(RQ-70·71)은 식별자와 무관한
 * 별개 관심사다(그 렌더는 누가 쐈는지 몰라도 성립한다). 식별자는 오직 이
 * 파일이 요구하는 `classifyHitRelation`(RQ-57 히트마커·RQ-58 피격
 * 방향·RQ-59 카메라 반응이 다음 라운드에 소비할 값)로만 흐른다.
 *
 * **결정론**: 이 파일의 모든 값은 테스트가 직접 넘기는 리터럴이다 —
 * `Date.now()`·`performance.now()`·`Math.random()`을 어디서도 호출하지
 * 않는다(ADR-0008).
 *
 * **스펙 질문 — 없음.** ADR-0016 결정 1 개정이 식별자 필드·판정 범위("나와의
 * 관계만")를 이미 확정했다.
 */

const SHOOTER_ID = 'session-shooter-7f3'
const VICTIM_ID = 'session-victim-2c9'
const BYSTANDER_ID = 'session-bystander-e1a'

/** 반환 타입을 `HitEvent`로 명시하지 않는다 — 오늘 시점의 `HitEvent`에는
 * `shooterId`/`victimId` 필드가 아직 없으므로, 명시하면 "미해결 필드"가
 * 아니라 "초과 프로퍼티"로 엉뚱한 자리에서 타입 오류가 난다. 리터럴
 * 추론에 맡기고 `classifyHitRelation` 호출부(그 함수 자체가 아직
 * 없으므로 이 라운드의 진짜 Red)에서만 구조적으로 검사되게 한다. */
function playerHitEvent(overrides: { shooterId: string; victimId: string }) {
  return {
    point: { x: 4, y: 1.2, z: -3 },
    normal: { x: 0, y: 1, z: 0 },
    target: 'player' as const,
    shooterId: overrides.shooterId,
    victimId: overrides.victimId,
  }
}

function wallHitEvent(overrides: { shooterId: string }) {
  return {
    point: { x: 15.4, y: 0.9, z: 2 },
    normal: { x: -1, y: 0, z: 0 },
    target: 'wall' as const,
    shooterId: overrides.shooterId,
  }
}

describe('RQ-57·58·59 공통/GA-119: classifyHitRelation — 같은 이벤트에서 사수·피격자·제3자가 각자 다른 관계를 가른다', () => {
  it('GA-119: 사수 자신이 이벤트를 받으면 관계가 "shooter"다', () => {
    const event = playerHitEvent({ shooterId: SHOOTER_ID, victimId: VICTIM_ID })
    const relation: HitRelation = classifyHitRelation(event, SHOOTER_ID)
    expect(relation).toBe('shooter')
  })

  it('GA-119: 피격자 자신이 이벤트를 받으면 관계가 "victim"이다', () => {
    const event = playerHitEvent({ shooterId: SHOOTER_ID, victimId: VICTIM_ID })
    const relation: HitRelation = classifyHitRelation(event, VICTIM_ID)
    expect(relation).toBe('victim')
  })

  it('GA-119: 사수도 피격자도 아닌 제3자가 같은 이벤트를 받으면 관계가 "bystander"다', () => {
    const event = playerHitEvent({ shooterId: SHOOTER_ID, victimId: VICTIM_ID })
    const relation: HitRelation = classifyHitRelation(event, BYSTANDER_ID)
    expect(relation).toBe('bystander')
  })

  it('GA-119: 같은 이벤트 객체 하나를 세 세션ID로 각각 판정하면 세 관계가 서로 다르다(하나의 브로드캐스트 — 세 관찰자, then 문면의 핵심)', () => {
    const event = playerHitEvent({ shooterId: SHOOTER_ID, victimId: VICTIM_ID })
    const relations = new Set<HitRelation>([
      classifyHitRelation(event, SHOOTER_ID),
      classifyHitRelation(event, VICTIM_ID),
      classifyHitRelation(event, BYSTANDER_ID),
    ])
    expect(relations).toEqual(new Set(['shooter', 'victim', 'bystander']))
  })

  it('벽 명중(victimId 없음)에서는 사수만 "shooter"이고 그 외 누구나 "bystander"다(피격자 자체가 존재하지 않는다)', () => {
    const event = wallHitEvent({ shooterId: SHOOTER_ID })
    expect(classifyHitRelation(event, SHOOTER_ID)).toBe('shooter')
    expect(classifyHitRelation(event, VICTIM_ID)).toBe('bystander')
    expect(classifyHitRelation(event, BYSTANDER_ID)).toBe('bystander')
  })
})

describe('RQ-57·58·59 공통/GA-120: classifyHitRelation은 식별자로만 판정한다 — 좌표로 재구성하지 않고 HP·킬·데미지를 계산하지 않는다', () => {
  it('점·법선이 완전히 달라도(비대칭 값) 식별자가 같으면 같은 관계가 나온다 — 좌표 기반 추정이 아니다(GA-98이 좌표에 대해 세운 "재계산 금지" 원칙을 관계 판정에 적용)', () => {
    const oddEventA = {
      point: { x: -999.5, y: 0.001, z: 42 },
      normal: { x: 0.6, y: 0, z: -0.8 },
      target: 'player' as const,
      shooterId: SHOOTER_ID,
      victimId: VICTIM_ID,
    }
    const oddEventB = {
      point: { x: 1, y: 1, z: 1 },
      normal: { x: 0, y: 1, z: 0 },
      target: 'player' as const,
      shooterId: SHOOTER_ID,
      victimId: VICTIM_ID,
    }
    expect(classifyHitRelation(oddEventA, SHOOTER_ID)).toBe(classifyHitRelation(oddEventB, SHOOTER_ID))
    expect(classifyHitRelation(oddEventA, VICTIM_ID)).toBe(classifyHitRelation(oddEventB, VICTIM_ID))
    expect(classifyHitRelation(oddEventA, BYSTANDER_ID)).toBe(classifyHitRelation(oddEventB, BYSTANDER_ID))
  })

  it('반환값은 관계 3종("shooter"|"victim"|"bystander") 중 하나뿐이다 — HP·킬·데미지 필드를 가질 수 있는 객체가 아니라 원시 문자열이다(RQ-61: 그런 값은 서버 스냅샷에서만 온다)', () => {
    const event = playerHitEvent({ shooterId: SHOOTER_ID, victimId: VICTIM_ID })
    const relation = classifyHitRelation(event, SHOOTER_ID)
    expect(['shooter', 'victim', 'bystander']).toContain(relation)
    expect(typeof relation).toBe('string')
  })

  it('같은 이벤트·같은 셀프 ID로 반복 호출해도 항상 같은 결과다(순수 함수 — HP·킬 등 외부 상태를 참조하지 않는다)', () => {
    const event = playerHitEvent({ shooterId: SHOOTER_ID, victimId: VICTIM_ID })
    const results = [
      classifyHitRelation(event, VICTIM_ID),
      classifyHitRelation(event, VICTIM_ID),
      classifyHitRelation(event, VICTIM_ID),
    ]
    expect(results).toEqual(['victim', 'victim', 'victim'])
  })
})
