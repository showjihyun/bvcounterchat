/**
 * RQ-73/ADR-0015 결정 4 — 걸음(팔·다리 스윙) 위상을 **접지 수평 이동 거리의
 * 누적**에서 유도한다. "배치·위상 계산" 층(ADR-0015 결정 5, 면제 없음) —
 * 순수 함수 + 값 단언, `tests/unit/rq-73-player-model.test.ts`(GA-93/94)가
 * 검증한다.
 *
 * ⚠️ **RQ-72(`@shared/sim/footsteps`)의 발소리 누적과 별개의 값이다** —
 * 그 누적기는 `mode==='run'`만 더한다("조용한 이동"의 기전 그 자체). 이
 * 모듈은 **자세와 무관하게**(걷기·앉기 이동에서도) 누적한다. 같은 눈사람
 * 함정(값 복제)을 피하려고 `stepFootstepAccumulator`를 감싸거나 재사용하지
 * 않는다 — 두 계약(자세 필터 유무)이 근본적으로 달라 감싸면 오히려 분기
 * 조건이 두 곳에 흩어진다.
 *
 * **소비처**: 원격 플레이어만(자기 자신은 1인칭이라 몸을 렌더하지 않으므로
 * 스윙도 없다). `@client/net/interpolation`의 `RemoteEntityInterpolator`가
 * 서버 스냅샷 수신(`addSnapshot`) 시점마다 `stepGaitDistance`를 호출해
 * 누적하고(`getFootstepCount`와 동일한 "렌더 시각과 무관한 유상태 누적"
 * 원칙, GA-83 선례), `PlayerMeshes.tsx`(렌더 배선, 면제)가 매 프레임
 * `gaitPhase01`(무상태 순수 변환)만 호출해 스윙 오프셋을 계산한다.
 */

export interface GaitTickInput {
  /** 이번 틱이 **시작된** 시점의 접지 여부. */
  wasGrounded: boolean
  /** 이번 틱이 **끝난** 시점의 접지 여부. */
  isGrounded: boolean
  /** 이번 틱의 수평 이동 거리(m). 유한하지 않거나(NaN·Infinity) 음수면
   * 0으로 취급한다(방어적, RQ-61 원칙 — `stepFootstepAccumulator`와 동일한
   * 방어). */
  horizontalDeltaM: number
  /** 위치를 불연속으로 재설정한 사건(리스폰 등)의 결과 틱이면 true. true면
   * 다른 필드는 무시되고 누적이 0으로 초기화된다(`stepFootstepAccumulator`와
   * 동일한 정신 — 리스폰 이동이 스윙으로 새어 들어가면 안 된다). */
  discontinuous: boolean
}

/**
 * 정확히 1스텝(서버 스냅샷 1개) 전진한다. 누적 대상(eligible) =
 * `wasGrounded && isGrounded` — 양쪽 끝 모두 접지여야 하는 이유는
 * `stepFootstepAccumulator`의 GA-85 근거와 같다: 이함·착지 틱의 수평
 * 변위가 공중 구간인데도 새어 들어가는 것을 막는다. **`mode` 필터가
 * 없다** — 이 함수가 `stepFootstepAccumulator`와 갈리는 지점 그 자체다
 * (ADR-0015 결정 4, GA-94).
 */
export function stepGaitDistance(distanceM: number, input: GaitTickInput): number {
  if (input.discontinuous) return 0

  const eligible = input.wasGrounded && input.isGrounded
  const safeDeltaM =
    Number.isFinite(input.horizontalDeltaM) && input.horizontalDeltaM > 0 ? input.horizontalDeltaM : 0
  return eligible ? distanceM + safeDeltaM : distanceM
}

/**
 * 누적 거리를 [0, 1) 위상으로 접는다(무상태, 순수) — GA-93 "같은 누적
 * 거리면 같은 위상"이 이 함수의 계약 그 자체다. `cycleDistanceM`이 0
 * 이하이거나 `distanceM`이 유한하지 않으면 0(스윙 없음)으로 방어한다.
 */
export function gaitPhase01(distanceM: number, cycleDistanceM: number): number {
  if (!(cycleDistanceM > 0) || !Number.isFinite(distanceM)) return 0
  const wrapped = distanceM % cycleDistanceM
  const positive = wrapped < 0 ? wrapped + cycleDistanceM : wrapped
  return positive / cycleDistanceM
}
