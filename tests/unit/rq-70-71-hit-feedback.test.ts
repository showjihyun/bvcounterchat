import { describe, expect, it } from 'vitest'
import { EFFECTS } from '@shared/constants'
import {
  advanceHitFeedback,
  applyHitEvent,
  createHitFeedbackState,
  type BulletHole,
  type HitEffect,
  type HitEvent,
} from '@client/effects/hitFeedback'

/**
 * RQ-70(탄흔)·RQ-71(피격 효과) — 클라이언트 판정·수집 순수 로직 단위 테스트
 * (ADR-0016 결정 4 "판정·수집" 층 — 면제 없음. 렌더 배선(`InstancedMesh`
 * 링버퍼 등, `harness/workflow/fe.md` "효과 처리")은 이 파일의 대상이
 * **아니다** — 그건 스크린샷 확인이 대신한다).
 *
 * ⚠️ **이 라운드는 `src/client/`만 다루지만 test-writer가 먼저 쓴다.**
 * team-lead 지시(원장 24ca): 클라 모듈 자체는 ADR-0011상 test-after가
 * 허용되는 영역이지만, 이 라운드는 벽 명중 지점 산출(`src/shared`)·명중
 * 이벤트 배선(서버 판정)이 함께 있어 test-writer 세션이 이미 떠 있다 —
 * 그 김에 GA-96~99(전부 이 파일이 `verify`로 지정된 골든)도 Red로 먼저
 * 고정한다.
 *
 * 매핑된 골든 케이스: **GA-96·GA-97·GA-98·GA-99**
 * (`harness/evals/golden/track-a-product.jsonl`, 전부 `status: todo`).
 * GA-100(배선)은 이 파일이 아니라 `tests/integration/20b-client-connect
 * .test.ts`(golden의 `verify` 필드가 그 경로를 직접 지정)에 있다 — 그
 * 파일에서 이 파일이 고정하는 계약과 동일한 모듈을 실 Colyseus 룸 경계
 * 너머로 검증한다(레벨 분리, `sim-combat-occlusion.test.ts`/
 * `rq-12-wall-occlusion.test.ts` 관계와 동일한 정신).
 *
 * | 골든 | describe/it | 검증 |
 * |---|---|---|
 * | GA-96 | "FIFO 상한" | 65번째 삽입까지 진행하면 정확히 64개, 가장 오래된 1개(0번째)가 빠지고 65번째(64번 인덱스)는 남는다 |
 * | GA-97 | "같은 갱신 함수" | 탄흔 3개 + 피격 1개가 있는 상태에서 `advanceHitFeedback` **한 번**으로 피격만 사라지고 탄흔은 하나도 안 사라진다 |
 * | GA-98 | "이벤트 좌표 그대로·대상 종류로 갈린다" | 표시 위치가 이벤트 좌표 그대로(재계산 아님), target이 'wall'이면 탄흔 컬렉션에, 'player'면 피격 컬렉션에만 들어간다 |
 * | GA-99 | "지속 시간 전·후" | 지속 시간 이전에는 남아 있고, 지속 시간을 넘겨 진행시키면 사라진다 |
 *
 * **그린필드 계약(test-writer 지정 — RQ-72 `rq-72-remote-footsteps.test.ts`
 * 선례와 동일한 권한: 신규 모듈의 API를 test-writer가 설계하고 coder가
 * 그대로 구현하면 이 파일이 Green이 된다):**
 *
 * ```ts
 * // src/client/effects/hitFeedback.ts (신규 모듈) — 순수 함수, DOM·Three.js·
 * // zustand 어디에도 의존하지 않는다(ADR-0016 결정 4 "판정·수집"과 "렌더
 * // 배선"을 파일 경계로도 분리 — coder가 실수로 섞기 어렵게 한다).
 *
 * import type { Vec3 } from '@shared/sim/combat'
 *
 * export type HitTargetKind = 'wall' | 'player'
 *
 * // 서버 'hit' 브로드캐스트 페이로드와 동일 shape(ADR-0016 결정 1 —
 * // "명중 좌표·표면 법선·명중 대상의 종류"). 클라이언트는 이 값을
 * // **그리기만** 한다 — 재계산하지 않는다(GA-98).
 * export interface HitEvent {
 *   point: Vec3
 *   normal: Vec3
 *   target: HitTargetKind
 * }
 *
 * export interface BulletHole {
 *   point: Vec3
 *   normal: Vec3
 * }
 *
 * export interface HitEffect {
 *   point: Vec3
 *   normal: Vec3
 *   expiresAtMs: number // applyHitEvent 호출 시 nowMs + hitEffectDurationMs로 확정
 * }
 *
 * export interface HitFeedbackState {
 *   bulletHoles: readonly BulletHole[]
 *   hitEffects: readonly HitEffect[]
 * }
 *
 * export function createHitFeedbackState(): HitFeedbackState // { bulletHoles: [], hitEffects: [] }
 *
 * // event.target==='wall'이면 bulletHoles 끝에 추가하고 EFFECTS.BULLET_HOLE_CAP
 * // (64, RQ-70 확정값 — 아래 "constants.ts 추가" 참고)을 넘으면 **가장
 * // 오래된 것부터**(배열 앞) 제거한다(FIFO, GA-96). event.target==='player'면
 * // hitEffects 끝에 { point, normal, expiresAtMs: nowMs + hitEffectDurationMs }를
 * // 추가한다(개수 상한 없음 — RQ-71 원문에 상한이 없다). `point`·`normal`은
 * // event에서 읽은 값을 **그대로** 옮긴다(GA-98 — 재계산 금지).
 * //
 * // `hitEffectDurationMs`를 함수 인자로 받는 이유(숨긴 튜닝 상수 금지 —
 * // `combat.ts`의 `eyeOrigin(footPosition, eyeHeightM)`·`interpolation.ts`의
 * // `delayMs` 생성자 인자와 동일한 규율): 이 값은 ADR-0016 결정 3이
 * // "확정하지 않은 튜닝값"으로 남긴 값이라 어디선가는 주입돼야 하고,
 * // 이 순수 함수가 그 출처(설정 모듈)를 스스로 import하면 "sim이 config를
 * // 아는" 방향이 뒤집힌다(`combat-tuning.ts` "의존 방향은 config→sim").
 * export function applyHitEvent(
 *   state: HitFeedbackState,
 *   event: HitEvent,
 *   nowMs: number,
 *   hitEffectDurationMs: number,
 * ): HitFeedbackState
 *
 * // GA-97/GA-99 — 같은 갱신 함수가 두 컬렉션을 함께 다룬다. hitEffects 중
 * // expiresAtMs <= nowMs인 것을 제거한다(RQ-71 "일시적", 피는 순간의
 * // 신호 — ADR-0016 결정 2). bulletHoles는 **시간으로는 절대 사라지지
 * // 않는다**(RQ-70 "상한이 유일한 제거 규칙") — 이 함수는 bulletHoles를
 * // 건드리지 않는다(내용·순서 불변).
 * //
 * // ⚠️ **이 함수 자신은 `Date.now()`를 호출하지 않는다**(ADR-0008 정신 —
 * // 순수 함수는 시각을 인자로만 받는다). `nowMs`는 호출자(배선 계층,
 * // 이 라운드 면제 대상)가 **서버 틱에서 유도한 값**(예: `room.state.tick`
 * // 기반)으로 조달해야 한다는 것이 GA-99의 요구이지만, 그 조달 지점
 * // 자체는 배선이라 이 파일이 직접 검증하지 않는다 — 대신 이 파일의
 * // 모든 테스트가 실제 시각이 아닌 임의의(작은) 숫자를 nowMs로 써서,
 * // 이 함수가 실제 시각과 무관하게 순수하게 동작함을 간접적으로 보인다.
 * export function advanceHitFeedback(state: HitFeedbackState, nowMs: number): HitFeedbackState
 * ```
 *
 * **constants.ts 추가(ADR-0016 결정 3 — "64는 RQ-70 문면에 박는다... 구현은
 * 그 확정값을 constants.ts에 둔다", `audio-tuning.ts`가 세운 규칙과 동일:
 * 확정한 값은 `constants.ts`, 미확정 튜닝값(피격 지속 시간)만 별도 모듈)**:
 *
 * ```ts
 * // src/shared/constants.ts에 추가할 블록
 * /** 효과 (RQ-70) *\/
 * export const EFFECTS = {
 *   /** 탄흔 최대 개수 — 초과 시 가장 오래된 것부터 제거 (RQ-70) *\/
 *   BULLET_HOLE_CAP: 64,
 * } as const
 * ```
 *
 * **피격 지속 시간 튜닝 모듈(ADR-0016 결정 3 후반 — 미확정 값)**: 이 파일은
 * `hitEffectDurationMs`를 매번 호출자가 넘기는 리터럴로 쓰므로 이 모듈을
 * 직접 참조하지 않는다 — 실제 값의 출처는 coder가 `audio-tuning.ts` 선례를
 * 따라 별도 모듈(예: `src/shared/config/effects-tuning.ts`)에 두고
 * `gameStore.ts`/`connection.ts` 배선이 그 값을 `applyHitEvent`에 주입한다.
 * 정확한 파일명·값은 이 계약이 규정하지 않는다(coder 재량 — 스펙이
 * "튜닝 설정값"이라고만 위임했다).
 *
 * **gameStore.ts/connection.ts 배선(요약 — 이 파일의 검증 대상 아님, GA-100이
 * 실 배선을 검증한다)**: `GameStoreState`에 `bulletHoles`·`hitEffects`
 * 필드와 `addHitEvent(event, nowMs)`·`advanceHitFeedback(nowMs)` 액션을
 * 추가해 위 순수 함수를 감싼다. `connection.ts`는 `room.onMessage<HitEvent>
 * ('hit', ...)`로 서버 브로드캐스트를 구독해 `addHitEvent`를 호출하고,
 * 기존 `handleStateChange`(매 패치, 이미 `room.state.tick`을 읽는다)가
 * 그 tick 기반 시각으로 `advanceHitFeedback`도 함께 호출한다.
 *
 * **결정론**: 이 파일의 모든 시각 값은 테스트가 직접 넘기는 리터럴이다 —
 * `Date.now()`·`performance.now()`를 어디서도 호출하지 않는다(ADR-0008).
 *
 * **스펙 질문 — 없음.** ADR-0016 결정 2·3·4가 상한(64)·제거 규칙(상한만 vs
 * TTL만)·검증 층 분리를 이미 확정했다.
 */

const DURATION_MS = 1500

function wallEvent(x: number): HitEvent {
  return { point: { x, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 0 }, target: 'wall' }
}

describe('RQ-70/GA-96: 탄흔 FIFO 상한(64) — constants.ts의 EFFECTS.BULLET_HOLE_CAP', () => {
  it('GA-96: 서로 다른 명중 지점으로 65번 넣으면 보관된 탄흔이 정확히 64개이고, 가장 먼저 넣은 1개가 빠지며 65번째는 남아 있다', () => {
    let state = createHitFeedbackState()
    for (let i = 0; i < 65; i += 1) {
      state = applyHitEvent(state, wallEvent(i), 0, DURATION_MS)
    }

    expect(state.bulletHoles).toHaveLength(EFFECTS.BULLET_HOLE_CAP)
    expect(state.bulletHoles.some((hole: BulletHole) => hole.point.x === 0)).toBe(false) // 가장 먼저 넣은 것(0번째)이 빠졌다
    expect(state.bulletHoles.some((hole: BulletHole) => hole.point.x === 64)).toBe(true) // 65번째(인덱스 64)는 남아 있다
    // LIFO가 아니라 FIFO라는 것도 함께 고정한다 — 방금 넣은 자리가 사라지면
    // "명중 지점을 기록한다"는 기능 자체가 배반된다(골든 근거 문단).
    expect(state.bulletHoles.some((hole: BulletHole) => hole.point.x === 63)).toBe(true)
  })

  it('상한 미만(64개 이하)은 하나도 제거되지 않는다(양성 대조군 — 상한 로직이 미만에서 오작동하지 않는다는 확인)', () => {
    let state = createHitFeedbackState()
    for (let i = 0; i < EFFECTS.BULLET_HOLE_CAP; i += 1) {
      state = applyHitEvent(state, wallEvent(i), 0, DURATION_MS)
    }
    expect(state.bulletHoles).toHaveLength(EFFECTS.BULLET_HOLE_CAP)
    expect(state.bulletHoles.some((hole: BulletHole) => hole.point.x === 0)).toBe(true) // 상한에 정확히 도달했을 뿐 아직 초과가 아니다
  })
})

describe('RQ-70·71/GA-97: 같은 갱신 함수(advanceHitFeedback)가 탄흔·피격 효과를 한 번에 다룬다', () => {
  it('GA-97: 탄흔 3개(상한 미만) + 피격 효과 1개가 있는 상태에서 지속 시간을 넘기는 시간으로 advanceHitFeedback을 한 번 호출하면, 같은 호출에서 피격 효과는 사라지고 탄흔은 하나도 사라지지 않는다', () => {
    let state = createHitFeedbackState()
    for (let i = 0; i < 3; i += 1) {
      state = applyHitEvent(state, wallEvent(i), 0, DURATION_MS)
    }
    state = applyHitEvent(state, { point: { x: 9, y: 1, z: 9 }, normal: { x: 0, y: 1, z: 0 }, target: 'player' }, 0, DURATION_MS)

    expect(state.bulletHoles).toHaveLength(3)
    expect(state.hitEffects).toHaveLength(1)

    // ⚠️ 핵심 — 단 한 번의 갱신 호출로 지속 시간을 넘긴다(따로 두 함수를
    // 부르지 않는다). 이 한 호출의 결과에서 두 단언을 함께 확인하는 것이
    // 이 골든의 요점이다(파일 상단 골든 매핑 참고 — GA-94 공허화 재발 방지).
    state = advanceHitFeedback(state, DURATION_MS + 1)

    expect(state.hitEffects).toHaveLength(0) // 피격 효과는 사라졌다
    expect(state.bulletHoles).toHaveLength(3) // 탄흔은 하나도 사라지지 않았다
    expect(
      state.bulletHoles.map((hole: BulletHole) => hole.point.x).sort((a: number, b: number) => a - b),
    ).toEqual([0, 1, 2]) // 내용도 그대로다(순서 포함, FIFO 순서 유지)
  })

  it('탄흔만 있고 피격 효과가 없는 상태에서 시간을 아무리 진행시켜도 탄흔은 그대로다(RQ-70 "시간으로는 사라지지 않는다"의 직접 확인)', () => {
    let state = createHitFeedbackState()
    for (let i = 0; i < 5; i += 1) {
      state = applyHitEvent(state, wallEvent(i), 0, DURATION_MS)
    }
    state = advanceHitFeedback(state, DURATION_MS * 1000) // 지속 시간의 1000배 — 극단적으로 먼 미래
    expect(state.bulletHoles).toHaveLength(5)
  })
})

describe("RQ-70·71/GA-98: 표시 위치는 이벤트 좌표 그대로이고, 대상 종류('wall'/'player')로 컬렉션이 갈린다", () => {
  it('GA-98: target=\'wall\'은 탄흔 컬렉션에만, target=\'player\'는 피격 컬렉션에만 들어가고, 좌표·법선이 이벤트 값 그대로다(재계산 없음)', () => {
    const wallHit: HitEvent = { point: { x: 1, y: 2, z: 3 }, normal: { x: 1, y: 0, z: 0 }, target: 'wall' }
    const playerHit: HitEvent = { point: { x: 4, y: 5, z: 6 }, normal: { x: 0, y: 1, z: 0 }, target: 'player' }

    let state = createHitFeedbackState()
    state = applyHitEvent(state, wallHit, 0, DURATION_MS)
    state = applyHitEvent(state, playerHit, 0, DURATION_MS)

    expect(state.bulletHoles).toHaveLength(1)
    expect(state.bulletHoles[0]).toEqual({ point: wallHit.point, normal: wallHit.normal })

    expect(state.hitEffects).toHaveLength(1)
    expect(state.hitEffects[0]?.point).toEqual(playerHit.point)
    expect(state.hitEffects[0]?.normal).toEqual(playerHit.normal)

    // 컬렉션이 실제로 갈렸다는 것을 교차로도 확인한다 — 벽 이벤트 좌표가
    // 피격 컬렉션에, 플레이어 이벤트 좌표가 탄흔 컬렉션에 섞이지 않는다.
    expect(state.hitEffects.some((effect: HitEffect) => effect.point.x === wallHit.point.x)).toBe(false)
    expect(state.bulletHoles.some((hole: BulletHole) => hole.point.x === playerHit.point.x)).toBe(false)
  })

  it('점·법선은 클라이언트가 임의로 만든 값이 아니라 이벤트가 준 값 그대로다(비대칭 값으로 재계산 여부를 가른다)', () => {
    const oddEvent: HitEvent = { point: { x: -123.456, y: 78.9, z: 0.001 }, normal: { x: 0.6, y: 0, z: -0.8 }, target: 'wall' }
    let state = createHitFeedbackState()
    state = applyHitEvent(state, oddEvent, 0, DURATION_MS)

    expect(state.bulletHoles[0]?.point).toEqual(oddEvent.point)
    expect(state.bulletHoles[0]?.normal).toEqual(oddEvent.normal)
  })
})

describe('RQ-71/GA-99: 피격 효과는 지속 시간 이전에는 남아 있고, 지속 시간을 넘기면 사라진다', () => {
  it('GA-99: 지속 시간 이전(경계 미만)에는 남아 있고, 지속 시간을 넘겨(경계 초과) 진행시키면 사라진다', () => {
    const START_MS = 1000
    let state = createHitFeedbackState()
    state = applyHitEvent(
      state,
      { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, target: 'player' },
      START_MS,
      DURATION_MS,
    )

    const beforeExpiry = advanceHitFeedback(state, START_MS + DURATION_MS - 1)
    expect(beforeExpiry.hitEffects).toHaveLength(1)

    const afterExpiry = advanceHitFeedback(state, START_MS + DURATION_MS + 1)
    expect(afterExpiry.hitEffects).toHaveLength(0)
  })

  it('여러 피격 효과가 서로 다른 시각에 생성되면 각자의 지속 시간 기준으로 독립적으로 사라진다(한꺼번에 전멸/한꺼번에 생존이 아니다)', () => {
    let state = createHitFeedbackState()
    // 하나는 이미 오래 전(곧 만료), 하나는 방금(아직 한참 남음).
    state = applyHitEvent(state, { point: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, target: 'player' }, 0, DURATION_MS)
    state = applyHitEvent(state, { point: { x: 2, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, target: 'player' }, DURATION_MS, DURATION_MS)

    // 첫 번째 것만 만료되는 시각(두 번째 것의 만료 시각보다는 이전).
    const midway = advanceHitFeedback(state, DURATION_MS + 1)
    expect(midway.hitEffects).toHaveLength(1)
    expect(midway.hitEffects[0]?.point.x).toBe(2)
  })

  it('advanceHitFeedback은 실제 시각(Date.now()/performance.now())과 무관하게 순수하다 — 작은 임의 숫자(nowMs)만으로도 정확히 동작한다', () => {
    let state = createHitFeedbackState()
    state = applyHitEvent(state, { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, target: 'player' }, 5, 10)
    expect(advanceHitFeedback(state, 14).hitEffects).toHaveLength(1)
    expect(advanceHitFeedback(state, 16).hitEffects).toHaveLength(0)
  })
})

/**
 * 이월 24cg — `advanceHitFeedback` 참조 안정성(결함 재현, ADR-0011 Red-first
 * 대상: 실측 결함).
 *
 * 현재 구현은 `Array.prototype.filter`를 무조건 호출한다. `filter`는
 * 제거 대상이 **0건이어도 항상 새 배열**을 반환한다(원소가 그대로여도
 * 참조는 새것). `connection.ts`의 `handleStateChange`가 매 상태 패치
 * (초당 20~30회)마다 이 함수를 부르므로, 만료 대상이 없는 대다수의
 * 호출에서도 `hitEffects` 배열 참조가 그 빈도로 바뀐다. 2/2 라운드가
 * 이 컬렉션을 구독해 렌더링하는 순간 그 빈도의 불필요한 리렌더·GPU
 * 업로드로 이어진다(ADR-0001 프레임 예산).
 *
 * **요구 계약**: 만료 대상이 0건이면 `hitEffects` 배열 참조와 반환
 * `state` 객체 참조를 **그대로**(동일성, `toBe`) 반환한다. 만료 대상이
 * 있으면(양성 대조군) 새 배열/새 객체를 반환한다. `bulletHoles`는 만료
 * 여부와 무관하게 **항상** 참조 그대로다(파일 상단 `advanceHitFeedback`
 * docblock이 이미 "bulletHoles를 건드리지 않는다(내용·순서·참조 그대로)"를
 * 선언한다 — 이 describe는 그 계약에 "hitEffects도 무변화 시엔 참조가
 * 안정적이어야 한다"는 대칭 축을 더한다).
 */
describe('RQ-70·71/이월 24cg: advanceHitFeedback 참조 안정성 — 만료 대상이 없으면 배열·상태 참조를 그대로 반환한다', () => {
  it('만료할 피격 효과가 없으면(아직 살아있는 효과 1개) hitEffects 배열 참조와 state 객체 참조를 그대로 반환한다', () => {
    let state = createHitFeedbackState()
    state = applyHitEvent(state, { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, target: 'player' }, 0, DURATION_MS)
    const beforeExpiry = advanceHitFeedback(state, DURATION_MS - 1) // 아직 만료 전
    expect(beforeExpiry.hitEffects).toBe(state.hitEffects)
    expect(beforeExpiry).toBe(state)
  })

  it('hitEffects가 애초에 비어 있으면(만료 대상 자체가 없음) advanceHitFeedback을 아무리 진행시켜도 참조가 그대로다', () => {
    const state = createHitFeedbackState()
    const advanced = advanceHitFeedback(state, 999_999)
    expect(advanced).toBe(state)
    expect(advanced.hitEffects).toBe(state.hitEffects)
  })

  it('양성 대조군 — 만료 대상이 실제로 있으면 새 배열·새 state를 반환한다(참조 안정성이 "절대 안 바뀐다"를 뜻하지 않는다는 것을 함께 고정)', () => {
    let state = createHitFeedbackState()
    state = applyHitEvent(state, { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, target: 'player' }, 0, DURATION_MS)
    const afterExpiry = advanceHitFeedback(state, DURATION_MS + 1)
    expect(afterExpiry).not.toBe(state)
    expect(afterExpiry.hitEffects).not.toBe(state.hitEffects)
    expect(afterExpiry.hitEffects).toHaveLength(0)
  })

  it('만료가 실제로 일어나는 호출에서도 bulletHoles 참조는 그대로다(RQ-70 "시간으로는 사라지지 않는다"를 참조 동일성 수준까지 재확인)', () => {
    let state = createHitFeedbackState()
    state = applyHitEvent(state, wallEvent(1), 0, DURATION_MS)
    state = applyHitEvent(state, { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, target: 'player' }, 0, DURATION_MS)
    const afterExpiry = advanceHitFeedback(state, DURATION_MS + 1)
    expect(afterExpiry.bulletHoles).toBe(state.bulletHoles)
  })
})
