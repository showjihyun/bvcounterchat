import { describe, expect, it } from 'vitest'
import { raycastHitbox, type HitboxConfig, type Ray, type TargetPose } from '@shared/sim/combat'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'

/**
 * RQ-70·71 — **F1 재리뷰 대응**(`_workspace/RQ-70-71/03_evaluator_report.md`
 * blocker F1) — `raycastHitbox().normal`(플레이어 명중 표면 법선) 검출력 0건
 * 보강. 순수 산술 단위 테스트(ADR-0008: 순수 함수·결정론·`src/shared` 환경
 * 중립. ADR-0011: `src/shared` 전체가 Red-first 영역).
 *
 * **골든 매핑 없음 — 의도적이다.** GA-96~100 어느 것도 플레이어 명중의
 * `normal` **값**을 단언하지 않는다(GA-98은 이벤트를 **소비하는 쪽**만
 * 보고, 이벤트 자체가 올바른 법선을 담았는지는 다루지 않는다). 그런데
 * `requirements.md` §8 "RQ-70·71 공통"은 "서버는 hitscan 판정 시 **명중
 * 좌표·표면 법선·명중 대상의 종류**를 전원에게 전달해야 한다"고
 * **벽·플레이어를 구분하지 않고** 요구한다 — 즉 플레이어 법선도 스펙
 * 값이지 coder의 선택 사항이 아니다. 평가자가 격리 워크트리에서 실증한
 * 변이 M1(`raycastHitbox`의 법선 산출부를 통째로 영벡터로 치환)이
 * **1075/1075를 통과**했다는 것은 이 계약이 어떤 테스트로도 관측되지
 * 않는다는 뜻이다(ADR-0011 위치 판정 기준 — `sim-combat-wall-hit.test.ts`가
 * 같은 이유로 골든 미매핑인 것과 동일한 근거).
 *
 * **손으로 검산 가능한 배치 4건**(evaluator 처방 그대로):
 *
 * 1. **+x 쪽에서 원통 측면 명중** — 사수를 표적의 +x 쪽(`x=10`)에 두고
 *    -x 방향으로 쏘면, 명중면은 원통의 +x 쪽 표면(사수 쪽)이라
 *    `normal ≈ (1,0,0)`.
 * 2. **-z 쪽에서 원통 측면 명중** — 대칭 검증(같은 공식이 축만 바꿔도
 *    성립하는지 — 하드코딩된 `(1,0,0)` 반환 변이를 잡는다).
 *    `normal ≈ (0,0,-1)`.
 * 3. **바디 법선의 y 성분은 `dir.y ≠ 0`이어도 항상 0이다** — 위 1·2는
 *    레이의 `dir.y=0`이라 "우연히" y=0일 수 있다는 반박을 막기 위해,
 *    레이가 아래로 기운(`dir.y<0`) 상태로 **같은 원통 측면**(로컬
 *    (x,z)=(bodyRadiusM,0))을 맞히는 배치를 추가한다 — 원통은 y축에
 *    대해 무한하므로 XZ 평면상의 진입 위치는 `dir.y`와 무관하고(원통
 *    반지름-레이 교차의 판별식·근이 `dir.x`·`dir.z`에만 의존한다), 법선
 *    자체는 항상 y를 버린 방사 방향이라는 계약(원통 측면 정의)을 직접
 *    검증한다. 기대값은 케이스 1과 **동일**(`(1,0,0)`) — "다른 각도에서도
 *    같다"가 이 케이스의 요점이다.
 * 4. **헤드 구체를 위에서 비스듬히 맞히면 `normal.y > 0`** — 바디(y=0
 *    고정)와 헤드(구체 방사 법선)가 **다른 공식**을 쓴다는 것을
 *    확인한다. 사수를 헤드 중심에서 정확히 대각선(`(1,-1,0)`)
 *    방향으로 `headRadiusM`을 넘는 거리만큼 뗀 지점에 두면(레이가
 *    헤드 중심을 정확히 관통하는 경로), 구체 표면 진입점의 법선은
 *    항상 **레이 방향의 반대**(`-direction`)다 — 구의 법선은 항상
 *    중심에서 표면으로의 방사 방향이고, 중심을 향해 쏜 레이는 그
 *    방사선을 따라 들어가기 때문이다. 이 배치가 바디 원통과 겹치지
 *    않는지(= 헤드가 실제로 더 가까운 표면인지)는 아래에서 손으로
 *    재확인한다(있다면 케이스 자체가 무의미해진다).
 *
 * **헤드 케이스(④)의 몸통 비간섭 확인(직접 계산, 산출물 아님)**:
 * `DEFAULT_HITBOX`(bodyRadiusM=0.3, bodyBottomM=0, bodyTopM=1.5,
 * headRadiusM=0.15, headCenterM=1.65)와 `D=10`(사수-헤드중심 거리)에서
 * 바디 원통과의 교차 거리는 t≈10.4243(높이 1.3499, 유효 범위 안이지만
 * 헤드 명중 거리 t=9.85보다 **뒤**), 헤드 명중 거리 t=9.85가 더 가깝다
 * — `raycastHitbox`의 "더 가까운(작은 t) 표면 채택" 규칙(가정 A 코멘트)에
 * 따라 헤드가 승자다. 이 계산은 `Math.SQRT1_2`(=1/√2)만으로 정확히
 * 재현되므로(원점·중심·반지름이 모두 유리수/√2 배수) `toBeCloseTo`로
 * 손 계산값과 대조 가능하다.
 */

const TARGET: TargetPose = { position: { x: 0, y: 0, z: 0 } }
/** 표적 발 위치 기준 원통 중간 높이 — `[bodyBottomM, bodyTopM]`=[0,1.5] 안. */
const BODY_MID_HEIGHT_M = 0.75

describe('RQ-70·71/F1 — raycastHitbox().normal: 부위별 법선 공식이 실제로 관측된다(골든 미매핑 — 파일 상단 근거)', () => {
  it('바디(+x 쪽 측면 명중) — 사수가 표적의 +x 쪽(x=10)에서 -x로 쏘면 법선은 사수 쪽인 (1,0,0)이다', () => {
    const ray: Ray = { origin: { x: 10, y: BODY_MID_HEIGHT_M, z: 0 }, direction: { x: -1, y: 0, z: 0 } }
    const result = raycastHitbox(ray, TARGET, DEFAULT_HITBOX)

    expect(result.hit).toBe(true)
    expect(result.region).toBe('body')
    expect(result.normal?.x).toBeCloseTo(1, 6)
    expect(result.normal?.y).toBeCloseTo(0, 6)
    expect(result.normal?.z).toBeCloseTo(0, 6)
  })

  it('바디(-z 쪽 측면 명중) — 사수가 표적의 -z 쪽(z=-10)에서 +z로 쏘면 법선은 사수 쪽인 (0,0,-1)이다(축 대칭 확인 — 항상 (1,0,0)을 반환하는 변이를 잡는다)', () => {
    const ray: Ray = { origin: { x: 0, y: BODY_MID_HEIGHT_M, z: -10 }, direction: { x: 0, y: 0, z: 1 } }
    const result = raycastHitbox(ray, TARGET, DEFAULT_HITBOX)

    expect(result.hit).toBe(true)
    expect(result.region).toBe('body')
    expect(result.normal?.x).toBeCloseTo(0, 6)
    expect(result.normal?.y).toBeCloseTo(0, 6)
    expect(result.normal?.z).toBeCloseTo(-1, 6)
  })

  it('바디 법선의 y 성분은 dir.y≠0(아래로 기운 사격)이어도 항상 0이다 — 케이스 1과 같은 원통 측면 지점에 다른 각도로 명중한다', () => {
    // 원통 반지름-레이 XZ 교차는 dir.y와 무관하다(파일 상단 근거) — 사수를
    // 케이스 1과 같은 x=10 쪽에 두고, 높이를 원통 상단 가까이서 살짝
    // 아래로 기울여 쏜다. 명중 로컬 (x,z)는 케이스 1과 동일하게 (0.3,0)
    // 이지만 명중 "높이"는 다르다 — 그런데도 normal.y는 여전히 0이어야
    // 한다(원통 측면 법선의 정의 — 높이를 버린다).
    const ray: Ray = { origin: { x: 10, y: 1.4, z: 0 }, direction: { x: -1, y: -0.05, z: 0 } }
    const result = raycastHitbox(ray, TARGET, DEFAULT_HITBOX)

    expect(result.hit).toBe(true)
    expect(result.region).toBe('body') // 헤드(y∈[1.5,1.8] 근방)에 못 미치는 높이대라 바디여야 한다
    expect(result.normal?.x).toBeCloseTo(1, 6) // 케이스 1과 동일한 로컬 (x,z) 진입점
    expect(result.normal?.y).toBeCloseTo(0, 6) // dir.y=-0.05인데도 정확히 0
    expect(result.normal?.z).toBeCloseTo(0, 6)
  })

  it('헤드(위에서 비스듬히 명중) — 레이가 헤드 중심을 정확히 관통하도록 배치하면 법선은 -direction이고 normal.y > 0이다(바디와 다른 공식이 실제로 갈린다)', () => {
    const D = 10 // 사수-헤드중심 거리(> headRadiusM) — 파일 상단 "비간섭 확인" 참고
    const dirX = Math.SQRT1_2
    const dirY = -Math.SQRT1_2 // 아래로 내려찍는 방향 — 진입점은 헤드 중심보다 "위"
    const origin = { x: -dirX * D, y: DEFAULT_HITBOX.headCenterM - dirY * D, z: 0 }
    const ray: Ray = { origin, direction: { x: dirX, y: dirY, z: 0 } }

    const result = raycastHitbox(ray, TARGET, DEFAULT_HITBOX)

    expect(result.hit).toBe(true)
    expect(result.region).toBe('head') // 바디(t≈10.4243)보다 헤드(t≈9.85)가 더 가깝다(파일 상단 계산)
    expect(result.distance).toBeCloseTo(D - DEFAULT_HITBOX.headRadiusM, 6)
    expect(result.normal?.x).toBeCloseTo(-dirX, 6)
    expect(result.normal?.y).toBeCloseTo(-dirY, 6)
    expect(result.normal?.y ?? 0).toBeGreaterThan(0) // 핵심 — 바디(y=0 고정)와 대비되는 부위별 분기
    expect(result.normal?.z).toBeCloseTo(0, 6)
  })

  it('명중하지 않으면(hit:false) normal이 없다(회귀 없음 — 기존 계약)', () => {
    const ray: Ray = { origin: { x: 100, y: BODY_MID_HEIGHT_M, z: 0 }, direction: { x: 1, y: 0, z: 0 } } // 반대쪽으로 쏴서 빗나감
    const result = raycastHitbox(ray, TARGET, DEFAULT_HITBOX)

    expect(result.hit).toBe(false)
    expect(result.normal).toBeUndefined()
  })
})

/** `HitboxConfig`만 별도로 바꿔도(캐릭터 모델 자산 교체 등) 위 계약이
 * 유지되는지 확인하는 회귀 가드 — 반지름이 달라져도 법선은 여전히
 * 단위 벡터이고 방향은 동일한 축을 가리킨다. */
describe('RQ-70·71/F1 — 다른 HitboxConfig로도 법선 공식이 동일하게 성립한다(형상 무관성)', () => {
  const CUSTOM_HITBOX: HitboxConfig = {
    bodyRadiusM: 1,
    bodyBottomM: 0,
    bodyTopM: 2,
    headRadiusM: 0.5,
    headCenterM: 2.5,
  }

  it('바디 반지름이 달라도(1m) +x 쪽 명중 법선은 여전히 (1,0,0)이다', () => {
    const ray: Ray = { origin: { x: 10, y: 1, z: 0 }, direction: { x: -1, y: 0, z: 0 } }
    const result = raycastHitbox(ray, TARGET, CUSTOM_HITBOX)

    expect(result.hit).toBe(true)
    expect(result.region).toBe('body')
    expect(result.normal).toEqual({ x: 1, y: 0, z: 0 })
  })
})
