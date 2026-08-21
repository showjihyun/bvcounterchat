/**
 * RQ-78 발사음 — 거리·자기 여부에 따른 볼륨 판정(ADR-0014 결정 5의 "판정"
 * 층 — 면제 없음). **순수 함수** — `src/shared` 환경 중립(`window`·
 * `document`·`process`·`fs` 참조 없음), `Math.random()`·`Date.now()` 직접
 * 호출 없음(ADR-0008).
 *
 * 「언제 소리가 나는가」(여섯 게이트)는 서버로 옮겨갔다(ADR-0014 결정 6,
 * `GameRoom.handleFire`가 그 층을 진다). 이 함수가 판정하는 것은 「이미
 * 발생한 발사음이 얼마나 크게 들리는가」뿐이다 — 클라이언트는 이미 발사
 * 이벤트로 사수의 위치(`GunshotEvent.position`)를 받고 자신의 위치도
 * 알고 있으므로, 거리 자체는 클라가 계산한다(ADR-0014 결정 6 "결정 5와의
 * 관계" 절).
 *
 * 계약 전문은 `tests/unit/sim-gunshot-audio.test.ts` 상단 docblock
 * (test-writer 지정, `@shared/sim/footsteps`의 `isFootstepAudible` 선례와
 * 동일한 권한)이 정본이다 — 이 파일은 그 계약을 그대로 구현한다.
 *
 * ⚠️ **RQ-72(발소리 15m 이진 컷오프)와 정반대다** — 발사음은 거리 상한이
 * 없고 볼륨이 단조 감소한다(GA-117). 발소리 코드(`isFootstepAudible`)를
 * 복사해 오지 않는다 — 그쪽은 "들리는가/아닌가"(boolean)를 판정하고, 이
 * 함수는 "얼마나 크게"(연속값)를 판정한다.
 */

/** 감쇠 곡선의 기준 거리(m) — `tuning.referenceDistanceM`에서 볼륨이 정확히
 * 절반(0.5)이 된다(역거리 감쇠, 아래 `gunshotVolume` 참고). 실제 프로덕션
 * 값은 `@shared/config/audio-tuning`의 `AUDIO_TUNING.GUNSHOT_VOLUME_
 * REFERENCE_DISTANCE_M`이 정한다(위임된 튜닝 슬롯, ADR-0010 — 이 순수
 * 함수 자신은 그 상수를 모른다, 호출자가 주입한다). */
export interface GunshotVolumeTuning {
  referenceDistanceM: number
}

/** `[0, 1]` 밖으로 새거나 비유한 값이 나오지 않도록 방어적으로 자른다
 * (RQ-61 원칙, `isWithinAudibleRange`의 `!Number.isFinite` 방어와 동일한
 * 정신). 정상 입력에서는 아래 감쇠식 자체가 이미 이 범위 안에 있지만,
 * `tuning.referenceDistanceM`이 비정상(0·음수)이어도 크래시하지 않게 한다. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * RQ-78/ADR-0014 결정 6 — 발사음 볼륨 판정(GA-117). 반환값은 선형 게인
 * `[0, 1]`(Web Audio `GainNode.gain` 관례, test-writer가 API 계약으로
 * 고정).
 *
 * - `isSelf === true`이면 `distanceM` 값과 완전히 무관하게 항상 정확히
 *   `1`을 반환한다("거리와 무관하게 항상 기준 볼륨").
 * - `isSelf === false`이면 역거리 감쇠(`referenceDistanceM / (referenceDistanceM
 *   + distanceM)`) — `distanceM`이 커질수록 단조 비증가하고, 어떤 유한
 *   거리에서도 정확히 0이 되지 않는다(분모가 항상 유한한 양수이므로 분수
 *   자체가 항상 `> 0`). 감쇠 곡선의 정확한 수학적 형태는 이 계약이
 *   규정하지 않는 구현 세부다(coder 재량) — 역거리 감쇠는 거리 0에서
 *   정확히 1(자기 발사음의 기준 볼륨을 넘지 않음), 거리 →∞에서 0에
 *   점근하는 가장 단순한 형태를 택했다.
 * - 비정상 거리(NaN·Infinity·음수)는 0으로 정제해 넘긴다(방어적 파싱,
 *   `isWithinAudibleRange`와 동일한 정신) — 정제 후에도 위 감쇠식을 그대로
 *   통과하므로 항상 유한한 `[0, 1]` 값이 나온다.
 */
export function gunshotVolume(distanceM: number, isSelf: boolean, tuning: GunshotVolumeTuning): number {
  if (isSelf) return 1

  const safeDistanceM = Number.isFinite(distanceM) && distanceM > 0 ? distanceM : 0
  const safeReferenceDistanceM = Number.isFinite(tuning.referenceDistanceM) && tuning.referenceDistanceM > 0 ? tuning.referenceDistanceM : 1

  return clamp01(safeReferenceDistanceM / (safeReferenceDistanceM + safeDistanceM))
}
