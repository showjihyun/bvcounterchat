import { describe, expect, it } from 'vitest'
import { synthesizeFootstepBurst } from '@client/audio/footstepSynth'

/**
 * RQ-72 발소리 구현 2/2-b(오디오 합성) — 절차적 파형 합성기 순수 함수 계약
 * (ADR-0014 결정 2: 노이즈 소스 + 엔벨로프, 오디오 파일을 저장소에 두지
 * 않는다. ADR-0008 결정론). `src/client/audio/footstepSynth.ts`는 아직
 * 저장소에 0줄이다(원장 24bv) — 이 파일이 정의하는 계약대로 coder가
 * 구현하면 Green이 된다.
 *
 * **사용자 결정(원장 24bv, 착수 커밋)**: 검증 수단으로 합성기를
 * `AudioContext`와 분리된 순수 함수로 둔다 — 파형을 **샘플 배열
 * (`Float32Array`)을 리턴하는 순수 함수**로 만들면 길이·진폭 포락선
 * (엔벨로프)·클리핑 여부를 값으로 단언할 수 있다(⚠️ ADR-0008 §6은 **렌더링(R3F)만** 면제하고 오디오를 면제한 적이 없다 —
 * 초안이 그렇게 인용했으나 틀렸다. 검증 방식의 정본은 **ADR-0014 결정 5**다). 면제 대상은 **재생 배선**(`AudioContext` 생성·
 * `BufferSource` 연결·포인터 락 개방 시점)뿐이다 — 그 배선은 이 파일이
 * 다루지 않는다(아래 "스코프 밖" 절).
 *
 * ⚠️ **이 파일이 검증하지 않는 것**: 「실제로 들리는가」·「사람 귀에 발소리
 * 같은가」는 어느 단언도 확인하지 않는다(**ADR-0014 결정 5** — **재생 배선 층만** 단위 테스트 면제이고, 그 대가로
 * 사람의 청취 증거를 요구한다). 이 파일이 고정하는 것은 **파형 배열의 구조적 성질**뿐
 * (길이 공식·결정론·진폭 상·하한·엔벨로프 추세)이다. 사람이 듣고 확인하는
 * 절차는 이 라운드가 별도로 기록한다(`harness/workflow/fe.md` 수동 확인
 * 절차 — 스크린샷 기반이라 오디오에 그대로 맞지 않는다는 점은 원장 24bv가
 * 이미 지적했고, 그 절차 자체를 고치는 것은 이 test-writer 라운드의
 * 스코프가 아니다).
 *
 * ## API 계약(test-writer 지정 — coder가 아래대로 구현하면 이 파일이
 * Green이 된다)
 *
 * ```ts
 * // src/client/audio/footstepSynth.ts
 * export function synthesizeFootstepBurst(sampleRateHz: number, seed: number): Float32Array
 * ```
 *
 * - **결정론(ADR-0008)**: 노이즈 소스는 `Math.random()`을 직접 호출하지
 *   않는다. **`@shared/sim/rng`의 `createRng(seed)`를 재사용한다**(ADR-0010
 *   — 이미 결정론이 검증된 시드 PRNG가 저장소에 있는데 오디오 모듈이 새
 *   PRNG를 발명하면 로직 복제다. `createRng`는 `seed`가 음이 아닌 정수·
 *   2^32 미만이 아니면 던진다 — 이 계약을 그대로 물려받는다). 노이즈 샘플은
 *   `rng.nextRange(-1, 1)` 등으로 [-1, 1) 범위에서 뽑는다.
 * - **길이**: `sampleRateHz`와 새 상수 `AUDIO_TUNING.FOOTSTEP_DURATION_MS`
 *   (`@shared/config/audio-tuning`, 이 라운드가 새로 추가 — ADR-0010 "매직 넘버를
 *   함수 안에 감추지 않는다")로부터 `Math.round(sampleRateHz *
 *   AUDIO_TUNING.FOOTSTEP_DURATION_MS / 1000)`개의 샘플을 반환한다. **이 파일은
 *   그 상수의 정확한 값을 알 필요가 없다** — 아래 "길이는 sampleRateHz에
 *   비례한다" 테스트가 두 sampleRateHz의 **비율**만으로 검증한다(값을
 *   하드코딩하면 ADR-0010 복제가 되므로 피한다).
 * - **엔벨로프(진폭 포락선)**: 앞부분(전체의 앞 10%)에서 큰 진폭에 도달하고,
 *   끝부분(전체의 뒤 1%)에서 0에 가깝게 수렴한다. 정확한 감쇠 곡선(선형·
 *   지수·코사인 창 등)은 coder 재량 — 이 파일은 "크게 시작해서 0으로
 *   수렴한다"는 성질만 값으로 단언한다.
 * - **클리핑 없음**: 모든 샘플이 `|x| <= 1`.
 * - **유한성**: 모든 샘플이 `Number.isFinite`(NaN·Infinity 없음).
 *
 * ## 스코프 밖(다음 라운드 또는 다른 계층의 몫)
 *
 * - `AudioContext` 개방·포인터 락 시점 배선·`BufferSource` 연결·실제 재생
 *   — ADR-0014 결정 5 면제, 재생 배선 층(`src/client/audio/` 또는
 *   `src/client/scene/`)의 몫이며 이 파일이 테스트하지 않는다.
 * - 착지음 합성 — 원장 24bn, 다음 PR(클라 측 낙하 높이 추적이 먼저
 *   필요하다).
 * - 원격·자기 발소리를 **언제** 재생할지(가청 판정·델타 계산)는
 *   `tests/unit/rq-72-footstep-playback.test.ts`(별도 파일, 소비 경로)의
 *   몫이다 — 이 파일은 파형 그 자체만 다룬다.
 *
 * ## 스펙 질문 — 없음
 *
 * ADR-0014 결정 2가 "노이즈 + 엔벨로프"라는 합성 방식과 "결정론적" 요구를
 * 이미 못박았고, 정확한 길이(ms)·감쇠 곡선 모양은 스펙이 규정하지 않는
 * 구현 세부(RQ-72 EARS 문면에 수치가 없다)라 test-writer 재량으로 남긴다.
 */

/** 테스트 전역에서 재사용하는 표본 sampleRateHz — Web Audio의 흔한
 * 기본값(48kHz)을 대표값으로 쓴다. 실제 브라우저 `AudioContext.sampleRate`는
 * 기기마다 다를 수 있으므로(대표적으로 44100·48000) 아래 "비례" 테스트가
 * 별도로 다른 sampleRateHz를 함께 확인한다. */
const SAMPLE_RATE_HZ = 48_000

/** 큰 배열에 `Math.max(...arr)`를 쓰면 스택 인자 상한에 걸릴 수 있어(엔진
 * 마다 다르지만 대체로 수만 개 이상에서 위험) reduce 기반으로 최대 절대값을
 * 구한다 — `AUDIO_TUNING.FOOTSTEP_DURATION_MS`가 커져도 안전하다. */
function maxAbs(samples: Float32Array, fromInclusive: number, toExclusive: number): number {
  let max = 0
  for (let i = fromInclusive; i < toExclusive; i += 1) {
    const abs = Math.abs(samples[i]!)
    if (abs > max) max = abs
  }
  return max
}

describe('RQ-72 2/2-b: synthesizeFootstepBurst — 결정론', () => {
  it('같은 (sampleRateHz, seed)는 완전히 동일한 배열을 낸다(Math.random 미사용의 관측 가능한 증거)', () => {
    const a = synthesizeFootstepBurst(SAMPLE_RATE_HZ, 1)
    const b = synthesizeFootstepBurst(SAMPLE_RATE_HZ, 1)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('다른 seed는 다른 배열을 낸다(시드가 실제로 소비된다는 증거 — 항상 같은 노이즈를 무시하고 반환하는 퇴화 구현을 잡는다)', () => {
    const a = synthesizeFootstepBurst(SAMPLE_RATE_HZ, 1)
    const b = synthesizeFootstepBurst(SAMPLE_RATE_HZ, 2)
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })
})

describe('RQ-72 2/2-b: synthesizeFootstepBurst — 길이 공식', () => {
  it('길이는 0보다 크다(빈 배열이 아니다)', () => {
    const samples = synthesizeFootstepBurst(SAMPLE_RATE_HZ, 1)
    expect(samples.length).toBeGreaterThan(0)
  })

  it('길이는 sampleRateHz에 비례한다(AUDIO_TUNING.FOOTSTEP_DURATION_MS 고정 지속시간 계약 — 이 파일은 그 상수의 실제 값을 몰라도 비율로 검증한다)', () => {
    const half = synthesizeFootstepBurst(SAMPLE_RATE_HZ / 2, 1)
    const full = synthesizeFootstepBurst(SAMPLE_RATE_HZ, 1)
    // 반올림 오차(최대 ±1 샘플)를 감안한 비율 확인 — sampleRateHz를 절반으로
    // 줄이면 길이도 절반이어야 한다(고정 상수를 표본 개수로 오인해 sampleRateHz와
    // 무관하게 항상 같은 길이를 반환하는 결함을 잡는다).
    expect(Math.abs(full.length - half.length * 2)).toBeLessThanOrEqual(1)
  })
})

describe('RQ-72 2/2-b: synthesizeFootstepBurst — 클리핑·유한성', () => {
  it('모든 샘플이 |x| <= 1이다(클리핑 없음)', () => {
    for (const seed of [1, 2, 42]) {
      const samples = synthesizeFootstepBurst(SAMPLE_RATE_HZ, seed)
      for (const sample of samples) {
        expect(Math.abs(sample)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('모든 샘플이 유한하다(NaN·Infinity 없음)', () => {
    const samples = synthesizeFootstepBurst(SAMPLE_RATE_HZ, 7)
    for (const sample of samples) {
      expect(Number.isFinite(sample)).toBe(true)
    }
  })
})

describe('RQ-72 2/2-b: synthesizeFootstepBurst — 엔벨로프(크게 시작해서 0으로 수렴)', () => {
  it('앞 10%의 최대 절대 진폭이 뒤 1%의 최대 절대 진폭보다 뚜렷하게 크다(시작이 끝보다 크다)', () => {
    const samples = synthesizeFootstepBurst(SAMPLE_RATE_HZ, 3)
    const n = samples.length
    const frontEnd = Math.max(1, Math.floor(n * 0.1))
    const tailStart = Math.min(n - 1, Math.ceil(n * 0.99))

    const frontMax = maxAbs(samples, 0, frontEnd)
    const tailMax = maxAbs(samples, tailStart, n)

    expect(frontMax).toBeGreaterThan(tailMax)
  })

  it('앞 10%는 충분히 큰 진폭에 도달한다(퇴화한 상시-무음 구현을 잡는다)', () => {
    const samples = synthesizeFootstepBurst(SAMPLE_RATE_HZ, 3)
    const frontEnd = Math.max(1, Math.floor(samples.length * 0.1))
    expect(maxAbs(samples, 0, frontEnd)).toBeGreaterThan(0.3)
  })

  it('뒤 1%는 0에 가깝게 수렴한다(끝에서 무음에 근접)', () => {
    const samples = synthesizeFootstepBurst(SAMPLE_RATE_HZ, 3)
    const n = samples.length
    const tailStart = Math.min(n - 1, Math.ceil(n * 0.99))
    expect(maxAbs(samples, tailStart, n)).toBeLessThan(0.05)
  })
})
