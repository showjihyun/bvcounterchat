import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Vec3 } from '@shared/sim/combat'
import { decalOrientation, decalOrientationInto, decalPosition, decalPositionInto } from '@client/scene/decalLayout'

/**
 * RQ-70(탄흔)·RQ-71(피격 효과) — **결함 재현 라운드(B1)**(ADR-0011 결정 1
 * 「결함 수정 라운드의 재현 테스트」— Red-first 요구 영역. 고치기 전에 그
 * 결함을 재현하는 실패 테스트를 먼저 만든다). 독립 리뷰가 blocker로 판정한
 * 결함을 잠근다.
 *
 * **재현할 결함**: `src/client/scene/decalLayout.ts:138-159`의
 * `writeInstances` 루프가 인스턴스마다 `decalPosition()`·`decalOrientation()`
 * 을 부른다. 둘 다 **값을 반환하는 순수 함수**라 호출마다 객체 리터럴을
 * 새로 만든다 — 각 함수 자신의 반환 객체 1개 + 내부에서 부르는
 * `normalizeVec3`의 반환 객체 1개 = **함수당 2개, 인스턴스당 4개**. 상한은
 * 탄흔 64 + 피격 `HIT_EFFECT_INSTANCE_CAP`(120) = 184 인스턴스이므로
 * **최대 736개 객체/프레임**을 할당한다.
 *
 * 위반하는 규칙:
 * - `CLAUDE.md` 게임 특화 불변식(위반은 리뷰 blocker) — 「렌더 루프
 *   (`useFrame`) 안에서 객체를 할당하지 않는다. 벡터·행렬은 재사용한다」.
 * - `harness/workflow/fe.md` 프레임 예산 절 — 「배열·객체 리터럴도 동일 —
 *   `useFrame` 안에서 `{}`, `[]`를 새로 만들면 GC 압박이 걸려 프레임 드랍
 *   (스터터)으로 이어진다」.
 * - `harness/adr/0001-client-rendering-stack.md` 결과 절 — 「iGPU 30fps
 *   하한이 렌더링 예산의 실질 기준선이다 — 인스턴싱 상한(RQ-70/71 탄흔·
 *   혈흔) … 을 이 하한을 기준으로 튜닝해야 한다」.
 *
 * ⚠️ **`tests/unit/rq-70-71-decal-layout.test.ts`가 이 축을 못 잡는다.**
 * 그 파일의 GA-113 스크래치 재사용 단언("같은 호출 안에서 여러 인스턴스에
 * 넘기는 matrix 인자가 같은 객체(참조)다")은 `scratch.matrix`
 * (`THREE.Matrix4`) 참조 **하나만** 확인한다. `decalPosition`/
 * `decalOrientation`이 매 호출마다 만드는 중간 객체 4개는 그 매트릭스에
 * `.compose()`된 뒤 곧바로 버려지므로, "matrix 참조가 같다"는 단언은 이
 * 네 축을 전혀 건드리지 않는다 — 그래서 전체 스위트가 지금 Green이면서도
 * 결함이 살아있다.
 *
 * **이 파일이 잠그는 계약**(리뷰가 지정한 수정 방향, `decalLayout.ts` 신규
 * export):
 *
 * ```ts
 * // out 파라미터에 직접 써넣는다 — 반환값 없음(void). writeInstances가
 * // 매 인스턴스 새 객체를 만들지 않고 scratch.position/scratch.quaternion
 * // 을 재사용해 넘길 수 있게 하는 것이 존재 이유다(`applyGaitSwingInto`,
 * // `playerModelLayout.ts` 선례와 동일한 정신 — out 인자, 할당 없음).
 * export function decalPositionInto(point: Vec3, normal: Vec3, offsetM: number, out: THREE.Vector3): void
 * export function decalOrientationInto(normal: Vec3, out: THREE.Quaternion): void
 * ```
 *
 * 기존 값 반환 함수 `decalPosition`·`decalOrientation`은 **지우지 않는다**
 * — `rq-70-71-decal-layout.test.ts`의 GA-112 단언(축 정렬·오블리크·비단위·
 * -Z 특이점)이 그 함수들을 대상으로 그대로 남아 있고, 이 파일은 그
 * 커버리지를 반복하지 않는다. 대신 `decalPositionInto`/`decalOrientationInto`
 * 가 (a) 그 값 반환 함수와 **수치가 정확히 같고**(단일 산술 원천 유지 —
 * 골든 GA-112가 단언하는 산술이 렌더 경로가 실제로 도는 코드와 같은
 * 구현이어야 한다는 팀 리드 지시), (b) **새 객체를 반환하지 않으며**
 * (void, `out`에 직접 씀 — 할당 축 A/C), (c) 스크래치 재사용(같은 `out`
 * 으로 서로 다른 입력을 연속 호출)에서 이전 호출 값이 새지 않는지를
 * 잠근다. (a)+(b)+(c)가 함께 있어야 "인스턴스마다 4개"의 근본 원인(값
 * 반환 → 매번 새 객체)이 실제로 제거됐다고 볼 수 있다. 내부 `normalizeVec3`
 * 가 스칼라(`1 / Math.hypot(...)`)로 바뀌어 중간 객체(할당 축 B/D)까지
 * 없어지는지는 private 구현이라 직접 관측할 수 없다 — (a)의 수치 동치가
 * 성립하려면 정규화 자체는 올바라야 하므로, 이 계약 수준 검증이 네 축
 * 전부의 대리 지표다(JS에서 할당을 직접 세기 어렵다는 점을 감안한 선택).
 *
 * **그린필드 계약(TS2305 정당한 Red, ADR-0008 §4)**: `decalPositionInto`·
 * `decalOrientationInto`는 아직 `decalLayout.ts`에 없다 — 이 파일 전체가
 * import 단계에서 "has no exported member" 오류로 실패한다. 아직 만들지
 * 않은 export에 대한 미해결 임포트이므로 정당한 Red다(이미 있는 모듈에
 * 새 export를 추가하는 그린필드 — `rq-70-71-decal-layout.test.ts` 최초
 * 버전이 `decalLayout.ts` 자체에 대해 쓴 것과 같은 성격).
 *
 * **매핑된 골든**: GA-112(법선 정렬 데칼 배치)의 산술을 새 API로 확장한다.
 * "새 객체를 반환하지 않는다"·"재사용 안전" 자체는 GA 번호가 없는 아키텍처
 * 불변식(ADR-0001·CLAUDE.md)이라 `GA-112/ADR-0001 프레임 예산` 태그를
 * 붙인다(원 파일의 `GA-113/ADR-0001 프레임 예산` 태그 선례와 동일한 관행).
 *
 * **테스트 레벨**(ADR-0008): 단위 — 순수 함수 산술. `writeInstances`가
 * 실제로 `*Into`를 부르는지(렌더 배선의 배선 자체)는 이 파일의 대상이
 * 아니다 — 그 축은 이 모듈 안에 있어 ADR-0008 면제 대상은 아니지만,
 * `syncDecalInstances`의 기존 GA-113 단언(위치·회전이 `decalPosition`/
 * `decalOrientation`과 일치)이 리팩터 후에도 수치로 계속 검증하므로,
 * 배선이 깨지면(값 반환 함수와 다른 산술을 실수로 쓰면) 그쪽에서 죽는다.
 * 이 파일이 규정하지 않는 것: 어느 내부 함수가 어느 함수를 부르는가 —
 * 그건 구현 방식이다(private 상태·내부 호출 그래프 검사는 test-writer
 * 권한 밖).
 *
 * **결정론**(ADR-0008): 난수·실시간 타이머·RAF·실 네트워크 없음. `three`의
 * 벡터·쿼터니언 계산은 WebGL 컨텍스트 없이 헤드리스로 돈다(`22b-aim-
 * camera-binding.test.ts`·원 파일과 동일한 정신).
 *
 * **스펙 질문 — 없음.** 계약은 독립 리뷰가 이미 확정했다(위 API 시그니처,
 * 이 라운드 지시문 원문).
 */

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

/** 쿼터니언(플레인 `Quat` 또는 `THREE.Quaternion`, 둘 다 x/y/z/w 구조가
 * 같다)을 평면 기본 법선 +Z(0,0,1)에 적용한 결과 — 단언은 항상 이 벡터를
 * 대상으로 한다(성분 직접 비교 금지, 원 파일과 동일한 원칙 — 쿼터니언의
 * 이중 커버 q/-q가 거짓 실패하지 않도록). */
function applyQuatToPlusZ(q: { x: number; y: number; z: number; w: number }): THREE.Vector3 {
  return new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))
}

function expectVec3CloseTo(actual: { x: number; y: number; z: number }, expected: Vec3, precision = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, precision)
  expect(actual.y).toBeCloseTo(expected.y, precision)
  expect(actual.z).toBeCloseTo(expected.z, precision)
}

const OFFSET_M = 0.01

const POSITION_SAMPLES: { label: string; point: Vec3; normal: Vec3; offsetM: number }[] = [
  { label: '+x 벽면(축 정렬)', point: { x: 1, y: 2, z: 3 }, normal: { x: 1, y: 0, z: 0 }, offsetM: 0.01 },
  { label: '오블리크 법선(비단위, magnitude 5)', point: { x: 5, y: -2, z: 0 }, normal: { x: 3, y: 4, z: 0 }, offsetM: 0.02 },
  { label: '비단위 법선(magnitude 2, z축)', point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 2 }, offsetM: 0.05 },
]

describe('RQ-70·71/GA-112(ADR-0001 프레임 예산, 결함 재현 B1): decalPositionInto — out에 직접 써넣고 decalPosition과 수치가 같다(할당 축 A)', () => {
  it('축 정렬(+x, offset 0.01) — out.x가 point.x+offset, y·z는 그대로다(decalPosition과의 동치 확인과 별개로 절대값도 확인 — 위임만으로는 decalPosition 자체의 잠재 결함까지 같이 통과시킬 수 있다)', () => {
    const out = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN)
    const returned = decalPositionInto({ x: 1, y: 2, z: 3 }, { x: 1, y: 0, z: 0 }, OFFSET_M, out)

    expect(returned).toBeUndefined()
    expect(out.x).toBeCloseTo(1.01, 9)
    expect(out.y).toBeCloseTo(2, 9)
    expect(out.z).toBeCloseTo(3, 9)
  })

  it.each(POSITION_SAMPLES)(
    '$label — out에 쓰인 값이 decalPosition(...)의 반환값과 정확히 같고, 반환값은 undefined다(새 객체를 만들지 않는다)',
    ({ point, normal, offsetM }) => {
      const expected = decalPosition(point, normal, offsetM)
      const out = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN)

      const returned = decalPositionInto(point, normal, offsetM, out)

      expect(returned).toBeUndefined()
      expectVec3CloseTo(out, expected, 9)
    },
  )

  it('재사용 버퍼 안전성(`writeInstances` 루프와 동일한 사용 패턴) — 같은 out으로 서로 다른 입력을 연속 호출해도 매번 정확한 값이고, 이전 호출 값이 새지 않는다(부분 대입 결함 — 예: z만 갱신하고 x·y는 이전 값에 머무는 버그 — 을 잡는다)', () => {
    const out = new THREE.Vector3()

    decalPositionInto({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.01, out)
    const afterFirst = out.clone()
    expectVec3CloseTo(afterFirst, decalPosition({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.01), 9)

    decalPositionInto({ x: 9, y: -4, z: 7 }, { x: 0, y: 1, z: 0 }, 0.03, out)
    expectVec3CloseTo(out, decalPosition({ x: 9, y: -4, z: 7 }, { x: 0, y: 1, z: 0 }, 0.03), 9)
    // 이전 호출 값이 하나라도 남아 있으면(부분 대입 결함) out과 afterFirst가
    // 우연히 같아질 수 있다 — 이번 두 입력은 세 축 모두 값이 달라 그 경우
    // 반드시 서로 달라야 한다.
    expect(out.equals(afterFirst)).toBe(false)
  })
})

const ORIENTATION_SAMPLES: { label: string; normal: Vec3 }[] = [
  { label: '+x 면', normal: { x: 1, y: 0, z: 0 } },
  { label: '-y 면(바닥 방향)', normal: { x: 0, y: -1, z: 0 } },
  { label: '오블리크 법선(비단위, magnitude √3)', normal: { x: 1, y: 1, z: 1 } },
]

describe('RQ-70·71/GA-112(ADR-0001 프레임 예산, 결함 재현 B1): decalOrientationInto — out에 직접 써넣고 decalOrientation과 동치인 회전이다(할당 축 C)', () => {
  it.each(ORIENTATION_SAMPLES)(
    '$label — out을 +Z에 적용한 방향이 decalOrientation(...)을 적용한 방향과 같고(성분 직접 비교 금지 — 이중 커버 q/-q 동치), 반환값은 undefined다',
    ({ normal }) => {
      const expectedDir = applyQuatToPlusZ(decalOrientation(normal))
      const out = new THREE.Quaternion(Number.NaN, Number.NaN, Number.NaN, Number.NaN)

      const returned = decalOrientationInto(normal, out)

      expect(returned).toBeUndefined()
      expectVec3CloseTo(applyQuatToPlusZ(out), expectedDir, 6)
      // 방향뿐 아니라 정규화도 확인 — normal이 단위벡터가 아니어도 out을
      // +Z에 적용한 결과가 정규화된 normal과 일치해야 한다(내부 정규화가
      // 스칼라로 바뀌어도 값은 그대로여야 한다).
      expectVec3CloseTo(applyQuatToPlusZ(out), normalize(normal), 6)
    },
  )

  it('normal이 정확히 -Z인 특이점에서도 out이 유한한 값으로 채워진다(NaN/Infinity 없음) — decalOrientation의 폴백 분기와 동치', () => {
    const out = new THREE.Quaternion(Number.NaN, Number.NaN, Number.NaN, Number.NaN)
    const returned = decalOrientationInto({ x: 0, y: 0, z: -1 }, out)

    expect(returned).toBeUndefined()
    expect(Number.isFinite(out.x)).toBe(true)
    expect(Number.isFinite(out.y)).toBe(true)
    expect(Number.isFinite(out.z)).toBe(true)
    expect(Number.isFinite(out.w)).toBe(true)
    expectVec3CloseTo(applyQuatToPlusZ(out), { x: 0, y: 0, z: -1 }, 6)
  })

  it('재사용 버퍼 안전성(`writeInstances` 루프와 동일한 사용 패턴) — 같은 out으로 서로 다른 법선을 연속 호출해도 매번 정확한 회전이고, 이전 호출 값이 새지 않는다', () => {
    const out = new THREE.Quaternion()

    decalOrientationInto({ x: 1, y: 0, z: 0 }, out)
    const afterFirst = out.clone()
    expectVec3CloseTo(applyQuatToPlusZ(afterFirst), applyQuatToPlusZ(decalOrientation({ x: 1, y: 0, z: 0 })), 6)

    decalOrientationInto({ x: 0, y: 1, z: 0 }, out)
    expectVec3CloseTo(applyQuatToPlusZ(out), applyQuatToPlusZ(decalOrientation({ x: 0, y: 1, z: 0 })), 6)
    // +x → +Z(0,0,1)과 +y → +Z가 서로 다른 방향을 만들어야 하므로(직교
    // 법선 두 개), 재사용 버퍼가 이전 값을 새지 않았다면 반드시 다르다.
    expect(out.equals(afterFirst)).toBe(false)
  })
})
