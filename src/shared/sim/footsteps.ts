/**
 * RQ-72(발소리·착지음) — 순수 로직 (ADR-0008: 순수 함수, 결정론, `src/shared`
 * 환경 중립). 수치·규칙 정본은 ADR-0014("오디오 스택과 발소리의 권위") 결정 4.
 *
 * 그린필드 계약은 `tests/unit/sim-footsteps.test.ts` 상단 docblock
 * (test-writer 지정, `fallDamage.ts`/`ammo.ts` 선례와 동일한 권한)이 정본이다
 * — 이 파일은 그 계약을 그대로 구현한다.
 *
 * 착지음 임계는 새 상수를 두지 않고 `FALL_DAMAGE.SAFE_HEIGHT_M`을 그대로
 * 재사용한다(ADR-0014 결정 4 "남은 자유도: 없음") — "아픈 착지는 시끄럽다"는
 * 하나의 규칙으로 RQ-18과 RQ-72가 같은 경계를 공유한다.
 */

import { FALL_DAMAGE } from '@shared/constants'

/**
 * 이번 틱의 상태 — 호출자가 매 틱 채워 넘긴다. ⚠️ **호출자는 클라이언트다**
 * (자기: `prediction.ts` / 원격: `interpolation.ts`) — ADR-0014 결정 1이
 * 「서버는 발소리 이벤트를 보내지 않는다. 클라이언트가 발소리 발생과 가청
 * 여부를 직접 계산한다」로 못박았다. 초안이 `GameRoom`을 호출자로 적었으나
 * 서버가 누적 상태를 전유하면 그 값은 **아무도 안 쓰는 죽은 계산**이거나
 * **브로드캐스트해야 하는데 그것이 결정 1을 깬다**(PR #74 리뷰 blocker).
 */
export interface FootstepTickInput {
  /** 이번 틱이 **시작된** 시점(직전 틱이 끝난 시점)의 `MoveState.grounded`. */
  wasGrounded: boolean
  /** 이번 틱이 **끝난** 시점(이번 `stepMovement` 호출 결과)의 `MoveState.grounded`. */
  isGrounded: boolean
  mode: 'run' | 'walk' | 'crouch'
  /** 이번 틱의 수평 이동 거리(m). 유한하지 않거나(NaN·Infinity) 음수면
   * 0으로 취급한다(방어적, RQ-61 원칙).
   *
   * ⚠️ **산출 방식이 골든 결과를 가른다**(실측): 직전 틱 끝 위치와 이번 틱 끝
   * 위치의 차 — `Math.hypot(Δx, Δz)` — 로 매 틱 산출한다. 속도×틱을 상수로
   * 미리 계산해 반복 가산하면 FP 누적 양상이 달라져 **GA-77이 2회가 아니라
   * 1회**가 된다(10틱째 1.9999999999999998로 미발화). 자기·원격의 **위치 소스**
   * 선택 자체는 원장 **24bl**이 소유한다 — 여기서 결론내지 않는다. */
  horizontalDeltaM: number
  /** 이번 틱이 위치를 불연속으로 재설정한 사건(리스폰·최초 스폰·재접속)의
   * 결과 틱이면 true. true면 다른 필드는 전부 무시되고 누적이 0으로
   * 초기화된다. */
  discontinuous: boolean
}

export interface FootstepAccumulatorResult {
  /** 다음 틱에 이어서 쓸 누적값. */
  accumM: number
  /** 이번 틱에 발생한 발소리 횟수(보통 0 또는 1). */
  footstepCount: number
}

/**
 * RQ-72/ADR-0014 결정 4 — 발소리 누적기. `stepMovement`와 동일하게 정확히
 * 1틱을 전진하는 순수 함수다(호출자가 틱마다 반복 호출).
 *
 * `discontinuous`가 최우선이다 — true면 나머지 필드를 전부 무시하고 누적을
 * 0으로 리셋한다(GA-89, 리스폰은 이동이 아니라 위치의 불연속 재설정).
 *
 * 그 외에는 누적 대상(eligible) = `wasGrounded && isGrounded && mode === 'run'`.
 * **양쪽 끝 모두 grounded여야 하는 이유(GA-85)**: 이함(도약) 틱은
 * `wasGrounded=true·isGrounded=false`, 착지 틱은 `wasGrounded=false·
 * isGrounded=true`다 — 어느 한쪽만 보면 이함 틱 또는 착지 틱의 수평 변위가
 * 공중 구간인데도 누적으로 새어 들어간다. 사다리(GA-84)는 이 조건에 아무
 * 영향이 없다 — `ladderOutcome`은 시작·끝 모두 `grounded:true`를 돌려주므로
 * (movement.ts:812) 조건은 항상 만족하고, 대신 수평 변위 자체가 0이라
 * 무음이 된다.
 *
 * eligible이면 `accumM += horizontalDeltaM`(방어적으로 정제한 값), 아니면
 * `accumM`은 그대로 — walk·crouch 구간은 누적 자체에서 완전히 배제된다
 * (GA-78/79/88, Shift·Ctrl이 "거리를 저축하는 키"가 되지 않도록).
 *
 * 그 다음 `floor(accumM / strideM)`회의 발소리가 발생하고, 매회 `accumM`에서
 * `strideM`을 차감한다(0으로 리셋하지 않는다 — RQ-72 원문).
 */
export function stepFootstepAccumulator(
  accumM: number,
  input: FootstepTickInput,
  strideM: number,
): FootstepAccumulatorResult {
  if (input.discontinuous) {
    return { accumM: 0, footstepCount: 0 }
  }

  const eligible = input.wasGrounded && input.isGrounded && input.mode === 'run'
  const safeDeltaM =
    Number.isFinite(input.horizontalDeltaM) && input.horizontalDeltaM > 0 ? input.horizontalDeltaM : 0
  let nextAccumM = eligible ? accumM + safeDeltaM : accumM

  let footstepCount = 0
  while (nextAccumM >= strideM) {
    nextAccumM -= strideM
    footstepCount++
  }

  return { accumM: nextAccumM, footstepCount }
}

/**
 * RQ-72/ADR-0014 결정 4 — 착지음 발생 판정. `fallDamageForHeight`와 동일한
 * 경계(`FALL_DAMAGE.SAFE_HEIGHT_M` **초과**만 true, 경계 포함은 false) —
 * 파일 배치 이웃 `fallDamage.ts`와 같은 상수를 그대로 재사용한다.
 *
 * `mode`(자세)를 인자로 받지 않는다 — 착지음은 자세와 무관하다(GA-86,
 * 앉아서 착지해도 소리는 난다).
 *
 * 방어적으로 유한하지 않은 높이는 false(낙하하지 않은 것과 동일 취급) —
 * 음수 높이도 `SAFE_HEIGHT_M`(양수) 이하이므로 별도 분기 없이 이미 false다.
 */
export function shouldPlayLandingSound(fallHeightM: number): boolean {
  if (!Number.isFinite(fallHeightM)) return false
  return fallHeightM > FALL_DAMAGE.SAFE_HEIGHT_M
}

/**
 * RQ-72/ADR-0014 결정 4 — 가청 판정 공통 규칙(발소리·착지음 동일하게 적용,
 * GA-87). 경계 포함(`<=`) — 정확히 `AUDIO.AUDIBLE_RANGE_M`이면 들린다.
 * 방어적으로 유한하지 않은 거리는 false.
 */
export function isWithinAudibleRange(horizontalDistanceM: number, audibleRangeM: number): boolean {
  if (!Number.isFinite(horizontalDistanceM)) return false
  return horizontalDistanceM <= audibleRangeM
}

/**
 * RQ-72 — 발소리 전용 가청 판정: 자기 발소리는 거리 판정 없이 항상 들린다
 * (GA-81). `isSelf`가 아니면 `isWithinAudibleRange` 그대로.
 */
export function isFootstepAudible(horizontalDistanceM: number, isSelf: boolean, audibleRangeM: number): boolean {
  if (isSelf) return true
  return isWithinAudibleRange(horizontalDistanceM, audibleRangeM)
}
