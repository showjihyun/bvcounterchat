import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { EFFECTS } from '@shared/constants'
import type { Vec3 } from '@shared/sim/combat'
import type { BulletHole, HitEffect, HitFeedbackState } from '@client/effects/hitFeedback'
import {
  createDecalScratch,
  decalOrientation,
  decalPosition,
  syncDecalInstances,
  type DecalInstanceSink,
  type Quat,
} from '@client/scene/decalLayout'

/**
 * RQ-70(탄흔)·RQ-71(피격 효과) 2/2 — **렌더 배선** 중 순수 수학·값 단언으로
 * 판정 가능한 부분만 검증한다(ADR-0016 결정 4 "렌더 배선"의 단위 테스트
 * 면제 자체는 그대로다). **법선 정렬 산술**(`decalOrientation`/
 * `decalPosition`)과 **컬렉션→인스턴스 카운트 환산**(`syncDecalInstances`)이
 * 그 대상이다 — `24f-map-render-geometry.test.ts`가 "판정 AABB → 렌더 박스
 * 환산 산술"만 떼어 검증하는 것과 같은 분리.
 *
 * ⚠️ **이 파일이 보는 것은 딱 이 세 함수 자신의 계약까지다.** F1 재리뷰
 * (`_workspace/RQ-70-71-render/03_evaluator_report.md`) 실측 정정 — 초판
 * docblock은 "남은 것은 `useFrame`이 이 함수를 실제로 부르는가 한 홉뿐"
 * 이라고 적었으나 **거짓이었다**: `syncDecalInstances`를 실제로 부르는
 * 컴포넌트(`HitDecals.tsx`/`GameScene.tsx` — 어느 sink에 어느 컬렉션을
 * 연결하는지, `offsetM` 값, 마운트 여부)를 import하는 테스트가 **0건**이라
 * 그 전체가 무방비다. 평가자가 두 sink를 뒤바꿔도·`offsetM` 부호를
 * 뒤집어도·`<HitDecals>` 마운트를 통째로 지워도 전체 스위트가 그대로
 * 통과함을 실증했다. 그 축은 "한 홉"이 아니라 **배선 전체**이고, 이
 * 저장소의 판정 대상 밖이다(ADR-0016 결정 4 "렌더 배선" 면제) — 대가는
 * 스크린샷(`harness/workflow/fe.md`)이다.
 *
 * **왜 1/2(`rq-70-71-hit-feedback.test.ts`)로는 부족한가**: 그 파일은
 * "수집"까지만 본다(GA-98 docblock이 스스로 "표시가 아니라 수집이다"라고
 * 정정했다). 실측상 `bulletHoles`·`hitEffects`를 읽는 렌더 코드가 0건이라
 * "쌓이지만 아무도 안 그린다"가 전부 초록으로 통과한다 — RQ-73 라운드가
 * 정확히 그 형태로 변이 4건을 1039/1039 통과시킨 전례(PR #79 독립 평가
 * FAIL, ADR-0016 결정 4 각주)가 이 파일의 존재 이유다.
 *
 * 매핑된 골든: **GA-112**(법선 정렬 데칼 배치) · **GA-113**(인스턴스
 * 동기화 — 개수·상한). 둘 다 `harness/evals/golden/track-a-product.jsonl`
 * (현재 `status: todo`) — 이 파일이 그 `verify` 값이다.
 *
 * **그린필드 계약(test-writer 지정 — `rq-70-71-hit-feedback.test.ts`/
 * `rq-73-player-model.test.ts` 선례와 동일한 권한: 신규 모듈의 API를
 * test-writer가 설계하고 coder가 그대로 구현하면 이 파일이 Green이 된다):**
 *
 * ```ts
 * // src/client/scene/decalLayout.ts (신규 모듈) — 순수 함수 + 최소
 * // 인터페이스만 참조한다. THREE.InstancedMesh 타입을 직접 요구하지
 * // 않는다(렌더러 없이 이 축을 볼 수 있어야 한다는 것이 이 설계의 요점).
 *
 * import * as THREE from 'three'
 * import type { Vec3 } from '@shared/sim/combat'
 * import type { HitFeedbackState } from '@client/effects/hitFeedback'
 * import { EFFECTS } from '@shared/constants'
 *
 * export interface Quat { x: number; y: number; z: number; w: number }
 *
 * // 평면의 기본 법선 +Z(0,0,1)를 normal 방향(정규화 후)으로 보내는 최단
 * // 회전. normal은 단위벡터가 아닐 수 있으므로 내부에서 정규화한다.
 * // normal이 정확히 -Z인 특이점(최단 회전이 유일하지 않다)에서도 유한한
 * // 값을 낸다 — 그 경우 축은 아무 수직축이나 좋고 180도 회전이면 된다.
 * export function decalOrientation(normal: Vec3): Quat
 *
 * // point에서 정규화된 normal 방향으로만 offsetM만큼 이동한 위치.
 * // 접선(법선에 수직인) 방향 성분은 0이다.
 * export function decalPosition(point: Vec3, normal: Vec3, offsetM: number): Vec3
 *
 * // 실 THREE.InstancedMesh가 구조적으로 만족하는 최소 인터페이스.
 * export interface DecalInstanceSink {
 *   setMatrixAt(index: number, matrix: THREE.Matrix4): void
 *   count: number
 *   instanceMatrix: { needsUpdate: boolean }
 * }
 *
 * // 프레임 예산(ADR-0001) — syncDecalInstances는 매 프레임(useFrame) 호출
 * // 되므로, 호출마다 new THREE.Matrix4()/new THREE.Quaternion() 등을
 * // 할당하지 않는다. 호출자가 createDecalScratch()로 한 번 만들어 매
 * // 프레임 재사용하는 스크래치 버퍼를 옵션으로 받는다.
 * export interface DecalSyncScratch {} // 내부 형태는 비공개 — coder 재량
 * export function createDecalScratch(): DecalSyncScratch
 *
 * export interface SyncDecalInstancesOptions {
 *   offsetM: number
 *   scratch: DecalSyncScratch
 * }
 *
 * // state.bulletHoles/hitEffects 각각을 sinks.bulletHoles/hitEffects로
 * // 옮긴다. 인스턴스 i의 위치는 decalPosition(item.point, item.normal,
 * // options.offsetM), 회전은 decalOrientation(item.normal)로 유도한다.
 * // 호출이 끝나면 sinks.*.count가 실제로 쓰인 개수로 갱신되고
 * // instanceMatrix.needsUpdate가 true로 설정된다(둘 다 빠지면 이전
 * // 프레임의 유령 인스턴스가 남거나 GPU에 새 값이 안 올라간다).
 * // bulletHoles는 EFFECTS.BULLET_HOLE_CAP(64)을 방어적으로 넘지 않는다
 * // (state.bulletHoles.length가 이미 그 이하이더라도, 그리고 설사
 * // 넘더라도) — hitEffects에는 그런 상한을 두지 않는다(RQ-71 원문에
 * // 개수 상한이 없다, ADR-0016 결정 2).
 * export function syncDecalInstances(
 *   state: Pick<HitFeedbackState, 'bulletHoles' | 'hitEffects'>,
 *   sinks: { bulletHoles: DecalInstanceSink; hitEffects: DecalInstanceSink },
 *   options: SyncDecalInstancesOptions,
 * ): void
 * ```
 *
 * | 골든 | describe/it | 검증 |
 * |---|---|---|
 * | GA-112 | "decalOrientation" | +Z에 반환된 회전을 적용하면 정규화된 normal과 같은 방향이 나온다(축 정렬·오블리크·비단위벡터·-Z 특이점) |
 * | GA-112 | "decalPosition" | 변위(result-point)가 정규화된 normal과 평행하고 크기가 정확히 offsetM(접선 이동 0) |
 * | GA-113 | "syncDecalInstances" | 인스턴스 개수가 컬렉션 크기와 정확히 같다(2/1/0), 위치·회전이 decalPosition/decalOrientation과 일치, count 갱신·needsUpdate, 탄흔 방어적 상한, **피격은 상한 없이 CAP+6개도 전부 인스턴스화**(F1 재리뷰 순증), 스크래치 재사용 |
 *
 * ⚠️ **단언은 쿼터니언 성분이 아니다** — "그 회전을 +Z에 적용하면
 * 정규화된 normal이 나온다"로 검증한다. 성분 직접 비교는 동치인 다른
 * 표현(부호가 반대인 q/-q 등)을 거짓 실패시킨다(아래 첫 describe 마지막
 * 케이스가 그 원칙 자체를 문서화한다).
 *
 * **결정론**: 이 파일은 난수·실시간 타이머·RAF·실 네트워크를 쓰지 않는다
 * (ADR-0008). `three`의 벡터·쿼터니언·행렬 계산은 WebGL 컨텍스트 없이
 * 헤드리스로 돈다 — `22b-aim-camera-binding.test.ts` 선례와 동일(픽셀이
 * 아니라 순수 수학만 본다).
 *
 * **스펙 질문 — 없음.** GA-112·GA-113 문면이 배치·인스턴싱 규칙을 이미
 * 확정했다.
 */

const OFFSET_M = 0.01

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

/** 반환된 쿼터니언을 평면 기본 법선 +Z(0,0,1)에 적용한 결과 — 단언은
 * 항상 이 벡터를 대상으로 한다(성분 직접 비교 금지, 파일 상단 docblock). */
function applyQuatToPlusZ(q: Quat): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))
}

function expectVec3CloseTo(actual: { x: number; y: number; z: number }, expected: Vec3, precision = 6): void {
  expect(actual.x).toBeCloseTo(expected.x, precision)
  expect(actual.y).toBeCloseTo(expected.y, precision)
  expect(actual.z).toBeCloseTo(expected.z, precision)
}

describe('RQ-70·71/GA-112: decalOrientation — 데칼 평면의 법선을 이벤트 법선과 같은 방향으로 정렬한다', () => {
  it.each([
    { label: '+x 면', normal: { x: 1, y: 0, z: 0 } },
    { label: '-x 면', normal: { x: -1, y: 0, z: 0 } },
    { label: '+y 면(천장 방향)', normal: { x: 0, y: 1, z: 0 } },
    { label: '-y 면(바닥 방향)', normal: { x: 0, y: -1, z: 0 } },
    { label: '+z 면(항등에 가까움)', normal: { x: 0, y: 0, z: 1 } },
    { label: '오블리크 법선(정규화 전, magnitude √3)', normal: { x: 1, y: 1, z: 1 } },
  ])('GA-112: $label — 반환된 회전을 +Z에 적용하면 정규화된 normal과 같은 방향이 나온다', ({ normal }) => {
    const q = decalOrientation(normal)
    expectVec3CloseTo(applyQuatToPlusZ(q), normalize(normal), 6)
  })

  it('GA-112: normal이 단위벡터가 아니어도(magnitude=5) 내부에서 정규화해 방향만 반영한다', () => {
    const q = decalOrientation({ x: 0, y: 5, z: 0 })
    expectVec3CloseTo(applyQuatToPlusZ(q), { x: 0, y: 1, z: 0 }, 6)
  })

  it('GA-112: normal이 정확히 -Z인 특이점에서도 유한한 값을 낸다(쿼터니언 성분이 NaN/Infinity가 아니고, +Z에 적용하면 -Z가 나온다 — 축은 임의의 수직축, 180도 회전이면 충분하다)', () => {
    const q = decalOrientation({ x: 0, y: 0, z: -1 })
    expect(Number.isFinite(q.x)).toBe(true)
    expect(Number.isFinite(q.y)).toBe(true)
    expect(Number.isFinite(q.z)).toBe(true)
    expect(Number.isFinite(q.w)).toBe(true)
    expectVec3CloseTo(applyQuatToPlusZ(q), { x: 0, y: 0, z: -1 }, 6)
  })

  it('GA-112: 단언 원칙 확인 — 부호가 반대인 동치 쿼터니언(q, -q)도 "+Z에 적용" 단언을 함께 통과한다(쿼터니언의 이중 커버, 성분 직접 비교였다면 여기서 거짓 실패했을 것)', () => {
    const normal = { x: 0.6, y: 0, z: 0.8 }
    const q = decalOrientation(normal)
    const negated: Quat = { x: -q.x, y: -q.y, z: -q.z, w: -q.w }
    expectVec3CloseTo(applyQuatToPlusZ(q), normalize(normal), 6)
    expectVec3CloseTo(applyQuatToPlusZ(negated), normalize(normal), 6)
  })
})

describe('RQ-70·71/GA-112: decalPosition — 명중 지점에서 법선 방향으로만 offsetM만큼 띄운다(접선 이동 0)', () => {
  it('GA-112: 축 정렬 법선(+x) — 결과는 point.x + offsetM이고 y·z는 그대로다', () => {
    const point: Vec3 = { x: 1, y: 2, z: 3 }
    const result = decalPosition(point, { x: 1, y: 0, z: 0 }, OFFSET_M)
    expect(result.x).toBeCloseTo(1.01, 9)
    expect(result.y).toBeCloseTo(2, 9)
    expect(result.z).toBeCloseTo(3, 9)
  })

  it('GA-112: 오블리크 법선 — 변위(result-point)가 정규화된 normal과 평행(외적≈0)하고 크기가 정확히 offsetM이며 법선 쪽으로(부호가 맞게) 이동한다', () => {
    const point: Vec3 = { x: 5, y: -2, z: 0 }
    const normal: Vec3 = { x: 3, y: 4, z: 0 } // magnitude 5, 정규화 전
    const result = decalPosition(point, normal, 0.02)
    const diff: Vec3 = { x: result.x - point.x, y: result.y - point.y, z: result.z - point.z }
    expect(Math.hypot(diff.x, diff.y, diff.z)).toBeCloseTo(0.02, 9)

    const n = normalize(normal)
    // 평행성 — 외적이 0벡터에 가깝다. 접선 방향 성분이 조금이라도 섞이면
    // 외적이 0에서 벗어난다(GA-112 "접선 방향 이동 0"의 직접 확인).
    const cross: Vec3 = {
      x: diff.y * n.z - diff.z * n.y,
      y: diff.z * n.x - diff.x * n.z,
      z: diff.x * n.y - diff.y * n.x,
    }
    expect(Math.hypot(cross.x, cross.y, cross.z)).toBeCloseTo(0, 9)
    // 방향(부호) — 법선 반대쪽으로 이동하면 벽 안에 파묻혀 보이지 않는다.
    const dot = diff.x * n.x + diff.y * n.y + diff.z * n.z
    expect(dot).toBeCloseTo(0.02, 9)
  })

  it('GA-112: normal이 단위벡터가 아니어도(magnitude=2) 입력 크기에 비례하지 않고 정확히 offsetM만큼만 이동한다(내부 정규화 확인)', () => {
    const point: Vec3 = { x: 0, y: 0, z: 0 }
    const result = decalPosition(point, { x: 0, y: 0, z: 2 }, 0.05)
    expect(result.x).toBeCloseTo(0, 9)
    expect(result.y).toBeCloseTo(0, 9)
    expect(result.z).toBeCloseTo(0.05, 9) // 2배(0.1)로 커지면 정규화가 빠진 것이다
  })
})

/** GA-113 — sink 호출을 기록하는 최소 페이크. `matrixRef`는 setMatrixAt에
 * 넘어온 객체를 **그대로**(clone 없이) 보관해 참조 재사용(스크래치)
 * 여부를 나중에 비교할 수 있게 하고, `snapshot`은 그 시점의 값을
 * clone해 보관해 이후 호출이 같은 객체를 다시 mutate해도 값 단언이
 * 안전하도록 한다. */
interface RecordedSetMatrixCall {
  index: number
  matrixRef: THREE.Matrix4
  snapshot: THREE.Matrix4
}

function createRecordingSink(): { sink: DecalInstanceSink; calls: RecordedSetMatrixCall[] } {
  const calls: RecordedSetMatrixCall[] = []
  const sink: DecalInstanceSink = {
    count: 0,
    instanceMatrix: { needsUpdate: false },
    setMatrixAt(index: number, matrix: THREE.Matrix4) {
      calls.push({ index, matrixRef: matrix, snapshot: matrix.clone() })
    },
  }
  return { sink, calls }
}

function decompose(m: THREE.Matrix4): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  m.decompose(position, quaternion, scale)
  return { position, quaternion }
}

function wallHole(x: number): BulletHole {
  return { point: { x, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
}

function bloodEffect(x: number): HitEffect {
  return { point: { x, y: 1, z: 0 }, normal: { x: 0, y: 1, z: 0 }, expiresAtMs: 999_999 }
}

describe('RQ-70·71/GA-113: syncDecalInstances — 수집된 상태를 인스턴스 버퍼로 옮긴다', () => {
  it('GA-113: 탄흔 2개 + 피격 1개 → 탄흔 인스턴스 정확히 2개, 피격 정확히 1개이고 각 인스턴스의 위치·회전이 decalPosition/decalOrientation과 일치한다', () => {
    const state: Pick<HitFeedbackState, 'bulletHoles' | 'hitEffects'> = {
      bulletHoles: [wallHole(10), wallHole(20)],
      hitEffects: [bloodEffect(5)],
    }
    const bulletHoles = createRecordingSink()
    const hitEffects = createRecordingSink()
    const scratch = createDecalScratch()

    syncDecalInstances(
      state,
      { bulletHoles: bulletHoles.sink, hitEffects: hitEffects.sink },
      { offsetM: OFFSET_M, scratch },
    )

    expect(bulletHoles.sink.count).toBe(2)
    expect(hitEffects.sink.count).toBe(1)
    // ⚠️ 안 하면 GPU에 안 올라가 화면이 안 바뀐다(팀 리드 지시 원문).
    expect(bulletHoles.sink.instanceMatrix.needsUpdate).toBe(true)
    expect(hitEffects.sink.instanceMatrix.needsUpdate).toBe(true)
    expect(bulletHoles.calls.map((c) => c.index).sort()).toEqual([0, 1])
    expect(hitEffects.calls.map((c) => c.index)).toEqual([0])

    for (const [i, hole] of state.bulletHoles.entries()) {
      const call = bulletHoles.calls.find((c) => c.index === i)!
      const { position, quaternion } = decompose(call.snapshot)
      expectVec3CloseTo(position, decalPosition(hole.point, hole.normal, OFFSET_M), 5)
      const quat: Quat = { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }
      expectVec3CloseTo(applyQuatToPlusZ(quat), normalize(hole.normal), 5)
    }

    const effect = state.hitEffects[0]!
    const effectCall = hitEffects.calls[0]!
    const { position: effectPos, quaternion: effectQuat } = decompose(effectCall.snapshot)
    expectVec3CloseTo(effectPos, decalPosition(effect.point, effect.normal, OFFSET_M), 5)
    const effectQ: Quat = { x: effectQuat.x, y: effectQuat.y, z: effectQuat.z, w: effectQuat.w }
    expectVec3CloseTo(applyQuatToPlusZ(effectQ), normalize(effect.normal), 5)
  })

  it('GA-113: 컬렉션이 비면 인스턴스가 0개다(탄흔·피격 둘 다) — 이전 프레임의 잔재 count가 남지 않는다', () => {
    const state: Pick<HitFeedbackState, 'bulletHoles' | 'hitEffects'> = { bulletHoles: [], hitEffects: [] }
    const bulletHoles = createRecordingSink()
    const hitEffects = createRecordingSink()
    bulletHoles.sink.count = 5 // 이전 프레임의 잔재 — 갱신 안 되면 유령 인스턴스가 남는다
    hitEffects.sink.count = 3
    const scratch = createDecalScratch()

    syncDecalInstances(
      state,
      { bulletHoles: bulletHoles.sink, hitEffects: hitEffects.sink },
      { offsetM: OFFSET_M, scratch },
    )

    expect(bulletHoles.sink.count).toBe(0)
    expect(hitEffects.sink.count).toBe(0)
  })

  it('GA-113: state.bulletHoles가 상한 64를 넘도록(방어적으로) 조작돼도 인스턴스 수는 64를 넘지 않는다(탄흔 쪽 방어적 상한 — 피격 쪽 "상한이 없다"는 아래 별도 케이스가 잠근다)', () => {
    const forgedBulletHoles: BulletHole[] = Array.from({ length: EFFECTS.BULLET_HOLE_CAP + 6 }, (_, i) => wallHole(i))
    const state: Pick<HitFeedbackState, 'bulletHoles' | 'hitEffects'> = {
      bulletHoles: forgedBulletHoles,
      hitEffects: [],
    }
    const bulletHoles = createRecordingSink()
    const hitEffects = createRecordingSink()
    const scratch = createDecalScratch()

    syncDecalInstances(
      state,
      { bulletHoles: bulletHoles.sink, hitEffects: hitEffects.sink },
      { offsetM: OFFSET_M, scratch },
    )

    expect(bulletHoles.sink.count).toBeLessThanOrEqual(EFFECTS.BULLET_HOLE_CAP)
    expect(bulletHoles.calls.every((c) => c.index < EFFECTS.BULLET_HOLE_CAP)).toBe(true)
  })

  it('GA-113/ADR-0016 결정 2(F1 재리뷰 순증 — 평가 실측 blocker): 피격에는 개수 상한이 없다 — EFFECTS.BULLET_HOLE_CAP보다 많은 피격 효과를 넣어도 전부(잘림 없이) 인스턴스가 된다', () => {
    // ⚠️ 리터럴 금지(ADR-0010) — 탄흔 상한 상수에서 "+6만큼 넘는다"만
    // 유도한다. 정확히 64/64보다 큰 임의의 값이면 되고, 상수 자체를
    // 그대로 베끼지 않는다는 것이 핵심이다.
    const forgedCount = EFFECTS.BULLET_HOLE_CAP + 6
    const forgedHitEffects: HitEffect[] = Array.from({ length: forgedCount }, (_, i) => bloodEffect(i))
    const state: Pick<HitFeedbackState, 'bulletHoles' | 'hitEffects'> = {
      bulletHoles: [],
      hitEffects: forgedHitEffects,
    }
    const bulletHoles = createRecordingSink()
    const hitEffects = createRecordingSink()
    const scratch = createDecalScratch()

    syncDecalInstances(
      state,
      { bulletHoles: bulletHoles.sink, hitEffects: hitEffects.sink },
      { offsetM: OFFSET_M, scratch },
    )

    // ⚠️ 탄흔과 달리 **잘리지 않고 입력 길이와 정확히 같아야 한다** — 이
    // 자리에 64/2/1 같은 상한을 몰래 심는 변이(F1 재리뷰 실측, `Infinity`
    // → `EFFECTS.BULLET_HOLE_CAP`/2/1 셋 다 기존 케이스들을 전부 생존시켰다)
    // 는 아래 세 단언에서 죽는다.
    expect(hitEffects.sink.count).toBe(forgedCount)
    expect(hitEffects.calls).toHaveLength(forgedCount)
    expect(hitEffects.calls.map((c) => c.index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: forgedCount }, (_, i) => i),
    )
  })

  it('GA-113/ADR-0001 프레임 예산: 같은 호출 안에서 여러 인스턴스에 넘기는 matrix 인자가 같은 객체(참조)다 — 인스턴스마다 new THREE.Matrix4()를 새로 할당하지 않는다(InstancedMesh 표준 관용구)', () => {
    const state: Pick<HitFeedbackState, 'bulletHoles' | 'hitEffects'> = {
      bulletHoles: [wallHole(1), wallHole(2), wallHole(3)],
      hitEffects: [],
    }
    const bulletHoles = createRecordingSink()
    const hitEffects = createRecordingSink()
    const scratch = createDecalScratch()

    syncDecalInstances(
      state,
      { bulletHoles: bulletHoles.sink, hitEffects: hitEffects.sink },
      { offsetM: OFFSET_M, scratch },
    )

    expect(bulletHoles.calls).toHaveLength(3)
    const [c0, c1, c2] = bulletHoles.calls
    expect(c0!.matrixRef).toBe(c1!.matrixRef)
    expect(c1!.matrixRef).toBe(c2!.matrixRef)
  })

  it('GA-113/ADR-0001 프레임 예산: 같은 scratch로 연속 호출해도(3개 → 1개로 줄어도) 매번 정확한 결과를 낸다 — 재사용 버퍼에 이전 호출의 값이 새어 나오지 않는다', () => {
    const scratch = createDecalScratch()

    const firstState: Pick<HitFeedbackState, 'bulletHoles' | 'hitEffects'> = {
      bulletHoles: [wallHole(1), wallHole(2), wallHole(3)],
      hitEffects: [],
    }
    const firstBulletHoles = createRecordingSink()
    const firstHitEffects = createRecordingSink()
    syncDecalInstances(
      firstState,
      { bulletHoles: firstBulletHoles.sink, hitEffects: firstHitEffects.sink },
      { offsetM: OFFSET_M, scratch },
    )
    expect(firstBulletHoles.sink.count).toBe(3)

    const secondHole = wallHole(99)
    const secondState: Pick<HitFeedbackState, 'bulletHoles' | 'hitEffects'> = {
      bulletHoles: [secondHole],
      hitEffects: [],
    }
    const secondBulletHoles = createRecordingSink()
    const secondHitEffects = createRecordingSink()
    syncDecalInstances(
      secondState,
      { bulletHoles: secondBulletHoles.sink, hitEffects: secondHitEffects.sink },
      { offsetM: OFFSET_M, scratch },
    )

    expect(secondBulletHoles.sink.count).toBe(1)
    const call = secondBulletHoles.calls[0]!
    const { position } = decompose(call.snapshot)
    expectVec3CloseTo(position, decalPosition(secondHole.point, secondHole.normal, OFFSET_M), 5)
  })
})
