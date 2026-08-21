import { describe, expect, it } from 'vitest'
import { gunshotVolume, type GunshotVolumeTuning } from '@shared/sim/gunshotAudio'

/**
 * RQ-78 발사음 — GA-117: 거리에 따른 발사음 볼륨 판정(순수 함수,
 * ADR-0014 결정 5의 "판정" 층 — 면제 없음). `src/shared/sim/gunshotAudio.ts`는
 * 아직 저장소에 0줄이다 — 이 파일이 정의하는 계약대로 coder가 구현하면
 * Green이 된다.
 *
 * EARS(RQ-78): "다른 플레이어의 발사음은 **거리 상한 없이** 들려야 하고
 * **거리에 따라 볼륨이 감쇠**해야 한다. **자기 발사음은 거리와 무관하게
 * 항상 기준 볼륨**으로 들려야 한다."
 *
 * 매핑된 골든 **GA-117**: given: 사수와 관측자가 서로 다른 거리에 있다
 * (근거리/원거리) / when: 사수가 사격한다 / then: 자기 발사음은 거리와
 * 무관하게 항상 기준 볼륨. 다른 플레이어의 발사음은 거리 상한 없이 들리되
 * 볼륨이 단조 감소. ⚠️ 컷오프가 없다는 것이 **RQ-72(발소리 15m)와 갈라지는
 * 지점**이다 — 15m 컷오프를 그대로 쓰면 쏘는 소리를 못 들어 교전 인지가
 * 성립하지 않는다. 감쇠 곡선의 계수는 이 케이스가 정하지 않는다(튜닝).
 *
 * ## 왜 서버가 아니라 클라 순수 함수인가(ADR-0014 결정 6 "결정 5와의 관계" 절)
 *
 * 「언제 소리가 나는가」(여섯 게이트)만 서버로 옮겨갔다 —
 * `tests/integration/rq-78-gunshot-fire-gates.test.ts`가 그 층을 진다.
 * 「얼마나 크게 들리는가」(거리 감쇠)는 RQ-72의 `isFootstepAudible`과 같은
 * 층이다 — 클라이언트는 이미 발사 이벤트로 사수의 위치를 받고(`GunshotEvent
 * .position`, `rq-78-gunshot-fire-event.test.ts` 와이어 계약) 자신의 위치도
 * 알고 있으므로, 거리 자체는 클라가 계산할 수 있다(ADR-0014 결정 1이 발소리에
 * 세운 "클라가 이미 아는 정보로 직접 계산" 원칙과 같은 성격 — 다만 **판정
 * 시점**(언제 이벤트가 발생하는가)은 결정 6이 서버로 옮겼다는 점만 다르다).
 *
 * ## 그린필드 계약(test-writer 지정 — coder가 아래대로 구현하면 Green이 된다)
 *
 * ```ts
 * // src/shared/sim/gunshotAudio.ts
 * export interface GunshotVolumeTuning {
 *   /** 감쇠 곡선의 기준 거리(m). `AUDIO.AUDIBLE_RANGE_M`(발소리 15m)에서
 *    * 유도하지 않는 **독립 상수**다(RQ-78 원문 "볼륨 감쇠의 기준 거리는
 *    * AUDIO.AUDIBLE_RANGE_M에서 유도하지 않는 독립 상수" — ADR-0014
 *    * 결정 4가 가청 거리를 WORLD.SIZE_M에서 유도하지 않은 것과 같은 이유,
 *    * 다른 상수가 바뀌어도 조용히 따라 움직이면 안 된다). * /
 *   referenceDistanceM: number
 * }
 *
 * export function gunshotVolume(
 *   distanceM: number,
 *   isSelf: boolean,
 *   tuning: GunshotVolumeTuning,
 * ): number
 * ```
 *
 * - **반환값은 선형 게인 `[0, 1]`**(Web Audio `GainNode.gain` 관례 — 이
 *   범위는 test-writer가 API 계약으로 고정한다, `HitEvent`의 필드 형태를
 *   test-writer가 고정한 선례와 동일한 권한. 정확한 감쇠 **곡선 모양**은
 *   coder 재량이지만 **끝점·단조성·컷오프 없음**은 이 파일이 값으로 고정한다).
 * - `isSelf === true`이면 `distanceM` 값과 **완전히 무관하게** 항상
 *   정확히 `1`을 반환한다(RQ-78 "거리와 무관하게 항상 기준 볼륨" — 0·먼
 *   거리·비정상 값 어느 것을 넣어도 같다).
 * - `isSelf === false`이면 `distanceM`이 커질수록 반환값이 **단조
 *   비증가**한다(`d1 < d2 ⇒ volume(d1) >= volume(d2)`).
 * - `isSelf === false`이면 반환값이 **어떤 유한 거리에서도 정확히 0이
 *   되지 않는다**(`> 0`) — RQ-72의 `isWithinAudibleRange`가 15m 경계에서
 *   정확히 0(비가청)이 되는 것과 **정반대**(이 대비가 이 파일의 핵심 단언).
 * - `isSelf === false`이고 `distanceM`이 유한하지 않으면(NaN·Infinity·음수)
 *   방어적으로 유한한 `[0, 1]` 값을 반환한다(크래시하지 않는다 — RQ-61
 *   방어적 파싱 원칙, `isWithinAudibleRange`의 `!Number.isFinite` 방어와
 *   동일한 정신).
 * - `referenceDistanceM`의 정확한 값과 감쇠 곡선의 수학적 형태(역거리·
 *   지수·로그 등)는 coder 재량 — 이 파일은 그 값을 몰라도 성립하는 성질만
 *   단언한다(길이가 sampleRateHz에 "비례"만 확인하는 `footstepSynth` 테스트와
 *   동일한 설계 원칙).
 *
 * ## 스펙 질문 — 없음
 *
 * ADR-0014 결정 6이 "컷오프 없음·거리 단조 감소·자기 소리 항상 기준
 * 볼륨"을 이미 못박았다. 정확한 감쇠 계수·곡선 형태는 RQ-78 원문이 명시적으로
 * "이 문면이 정하지 않는다(튜닝)"고 위임한 영역이라 test-writer가 임의로
 * 만들지 않는다.
 */

/** 감쇠 곡선의 정확한 수학적 형태와 무관하게 성립해야 하는 기준 거리 —
 * coder가 실제로 쓸 값을 몰라도 되도록 이 파일이 임의의 양수를 하나
 * 고른다(길이 공식 테스트가 `AUDIO_TUNING.FOOTSTEP_DURATION_MS`의 실제
 * 값을 몰라도 비율로 검증하는 것과 동일한 설계). */
const TUNING: GunshotVolumeTuning = { referenceDistanceM: 20 }

describe('RQ-78/GA-117: gunshotVolume — 자기 발사음은 거리와 무관하게 항상 기준 볼륨', () => {
  it('isSelf=true이면 거리 0·근거리·원거리·비정상 값 어느 것을 넣어도 항상 1이다', () => {
    const distances = [0, -5, 1, 15, 50, 1_000, 1_000_000, Number.POSITIVE_INFINITY, Number.NaN]
    for (const distanceM of distances) {
      expect(gunshotVolume(distanceM, true, TUNING)).toBe(1)
    }
  })
})

describe('RQ-78/GA-117: gunshotVolume — 원격 발사음은 거리에 따라 단조 비증가한다', () => {
  it('거리가 멀어질수록 볼륨이 증가하지 않는다(단조 비증가)', () => {
    const distances = [1, 5, 10, 15, 20, 50, 100, 500, 5_000]
    const volumes = distances.map((distanceM) => gunshotVolume(distanceM, false, TUNING))
    for (let i = 1; i < volumes.length; i += 1) {
      expect(volumes[i]!).toBeLessThanOrEqual(volumes[i - 1]!)
    }
    // 상수 함수(퇴화 구현)를 잡는다 — 최소 한 구간은 실제로 줄어야 한다.
    expect(volumes[volumes.length - 1]!).toBeLessThan(volumes[0]!)
  })

  it('가장 가까운 거리(0m)의 볼륨은 자기 발사음의 기준 볼륨(1)을 넘지 않는다', () => {
    const closest = gunshotVolume(0, false, TUNING)
    expect(closest).toBeLessThanOrEqual(1)
    expect(closest).toBeGreaterThan(0)
  })
})

describe('RQ-78/GA-117: gunshotVolume — 컷오프가 없다(RQ-72 발소리 15m과 정반대)', () => {
  it('가청 거리(RQ-72의 15m)를 넘어서도 볼륨이 0이 아니다', () => {
    expect(gunshotVolume(15, false, TUNING)).toBeGreaterThan(0)
    expect(gunshotVolume(16, false, TUNING)).toBeGreaterThan(0)
    expect(gunshotVolume(60, false, TUNING)).toBeGreaterThan(0) // WORLD.SIZE_M(60) — 맵 반대편
  })

  it('맵 크기를 훨씬 넘는 극단적으로 먼 거리에서도 볼륨이 정확히 0이 되지는 않는다(어떤 유한 거리도 컷오프가 아니다)', () => {
    const veryFar = gunshotVolume(1_000_000, false, TUNING)
    expect(veryFar).toBeGreaterThan(0)
    expect(Number.isFinite(veryFar)).toBe(true)
  })
})

describe('RQ-78/GA-117: gunshotVolume — 방어적 처리(비정상 거리값)', () => {
  it('NaN·Infinity·음수 거리를 원격 발사음에 넣어도 크래시하지 않고 유한한 [0,1] 값을 반환한다', () => {
    for (const distanceM of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -10]) {
      const volume = gunshotVolume(distanceM, false, TUNING)
      expect(Number.isFinite(volume)).toBe(true)
      expect(volume).toBeGreaterThanOrEqual(0)
      expect(volume).toBeLessThanOrEqual(1)
    }
  })
})
