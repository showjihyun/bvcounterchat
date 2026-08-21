import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { synthesizeGunshotBurst } from '@client/audio/gunshotSynth'

/**
 * RQ-78 발사음 — GA-118: 절차적 합성 순수 함수(ADR-0014 결정 2·5의 "합성" 층
 * — 면제 없음). `src/client/audio/gunshotSynth.ts`는 아직 저장소에 0줄이다
 * — 이 파일이 정의하는 계약대로 coder가 구현하면 Green이 된다.
 *
 * EARS(RQ-78): "발사음은 녹음 샘플이 아니라 **절차적으로 합성**해야 하며,
 * 오디오 파일을 저장소에 두지 않는다." (ADR-0014 결정 2와 동일 요구)
 *
 * 매핑된 골든 **GA-118**: given: 발사음이 구현된 저장소 / when: 합성 함수를
 * 같은 파라미터로 두 번 부르고, 발사음 경로의 오디오 로딩을 전수 조사한다 /
 * then: 합성 함수가 **주어진 파라미터에 대해 결정적인 파형 값**을 낸다
 * (길이·엔벨로프·클리핑). 오디오 로딩 경로가 발사음 경로에 0건.
 *
 * ⚠️ **이 파일이 밟지 않는 함정(팀리드 지시, GA-111·이전 GA-118 두 차례
 * 재발)**: **주 단언을 「오디오 파일 0건」에 두지 않는다** — 그러면
 * 구현이 0줄이어도(합성 함수 자체가 없어도) "파일이 없다"는 참이 되어
 * 우연히 초록이 된다. 이 파일의 **주 단언은 아래 "결정론"·"길이 공식"·
 * "클리핑·유한성"·"엔벨로프" 네 그룹**(퇴화 구현·상시-무음 구현·비결정적
 * 구현을 실제로 잡는 값 기반 단언)이고, "로딩 경로 부재" 절은 **보조**다
 * (아래 마지막 그룹 — 구현이 존재해야 이 절의 대상 파일도 존재하므로,
 * 파일이 아예 없는 지금 이 절도 함께 실패한다).
 *
 * ## 그린필드 계약(test-writer 지정 — `rq-72-footstep-synth.test.ts`
 * `synthesizeFootstepBurst` 선례와 **동일한 API 형태**, 선례를 그대로
 * 재사용해 새 합성 관례를 발명하지 않는다)
 *
 * ```ts
 * // src/client/audio/gunshotSynth.ts
 * export function synthesizeGunshotBurst(sampleRateHz: number, seed: number): Float32Array
 * ```
 *
 * - **결정론(ADR-0008)**: `Math.random()`을 직접 호출하지 않는다.
 *   `@shared/sim/rng`의 `createRng(seed)`를 재사용한다(ADR-0010 — 이미
 *   결정론이 검증된 시드 PRNG가 있는데 새 PRNG를 발명하면 로직 복제다.
 *   `footstepSynth.ts`가 이미 세운 선례).
 * - **길이**: `sampleRateHz`에 비례하는 고정 지속시간(정확한 ms·상수 이름은
 *   coder 재량 — `AUDIO_TUNING`에 새 필드를 추가하든 별도 상수를 두든
 *   무관하다). 이 파일은 그 상수의 실제 값을 몰라도 **비율**로만 검증한다.
 * - **엔벨로프**: 앞부분(전체의 앞 10%)에서 큰 진폭에 도달하고, 끝부분
 *   (전체의 뒤 1%)에서 0에 가깝게 수렴한다. 정확한 감쇠 곡선 모양은 coder
 *   재량.
 * - **클리핑 없음**: 모든 샘플이 `|x| <= 1`.
 * - **유한성**: 모든 샘플이 `Number.isFinite`.
 * - **오디오 로딩 경로 0건**: 이 파일이 소스 텍스트를 직접 읽어(아래
 *   "로딩 경로 부재" 절) `fetch`·`decodeAudioData`·`XMLHttpRequest`·
 *   `.wav`/`.mp3`/`.ogg` 문자열 리터럴이 이 모듈에 없음을 확인한다 —
 *   절차적 합성이므로 애초에 필요 없는 API들이다.
 *
 * ## 스코프 밖
 *
 * `AudioContext` 개방·`BufferSource` 연결·실제 재생 — ADR-0014 결정 5
 * 면제, 재생 배선 층의 몫(사람이 듣고 확인한다). 거리·자기 여부에 따른
 * 볼륨 판정은 `tests/unit/sim-gunshot-audio.test.ts`(GA-117, 별도 파일 —
 * 파형 그 자체와 볼륨 판정은 다른 계약이다)의 몫이다.
 *
 * ## 스펙 질문 — 없음
 *
 * ADR-0014 결정 2가 "노이즈+엔벨로프, 절차적, 결정론적"을 이미 못박았고,
 * 정확한 지속시간·감쇠 곡선 모양·음색은 RQ-78 원문이 "이 문면이 정하지
 * 않는다"고 명시적으로 위임한 구현 세부라 test-writer 재량으로 남긴다
 * (`footstepSynth.ts` 선례와 동일한 판단).
 */

const SAMPLE_RATE_HZ = 48_000

/** 큰 배열에 `Math.max(...arr)`를 쓰면 스택 인자 상한에 걸릴 수 있어
 * reduce 기반으로 최대 절대값을 구한다(`rq-72-footstep-synth.test.ts`의
 * `maxAbs`와 동일). */
function maxAbs(samples: Float32Array, fromInclusive: number, toExclusive: number): number {
  let max = 0
  for (let i = fromInclusive; i < toExclusive; i += 1) {
    const abs = Math.abs(samples[i]!)
    if (abs > max) max = abs
  }
  return max
}

describe('RQ-78/GA-118: synthesizeGunshotBurst — 결정론(주 단언)', () => {
  it('같은 (sampleRateHz, seed)는 완전히 동일한 배열을 낸다(Math.random 미사용의 관측 가능한 증거)', () => {
    const a = synthesizeGunshotBurst(SAMPLE_RATE_HZ, 1)
    const b = synthesizeGunshotBurst(SAMPLE_RATE_HZ, 1)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('다른 seed는 다른 배열을 낸다(시드가 실제로 소비된다는 증거 — 항상 같은 노이즈를 무시하고 반환하는 퇴화 구현을 잡는다)', () => {
    const a = synthesizeGunshotBurst(SAMPLE_RATE_HZ, 1)
    const b = synthesizeGunshotBurst(SAMPLE_RATE_HZ, 2)
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })
})

describe('RQ-78/GA-118: synthesizeGunshotBurst — 길이 공식(주 단언)', () => {
  it('길이는 0보다 크다(빈 배열이 아니다)', () => {
    const samples = synthesizeGunshotBurst(SAMPLE_RATE_HZ, 1)
    expect(samples.length).toBeGreaterThan(0)
  })

  it('길이는 sampleRateHz에 비례한다(고정 지속시간 계약 — 이 파일은 그 상수의 실제 값을 몰라도 비율로 검증한다)', () => {
    const half = synthesizeGunshotBurst(SAMPLE_RATE_HZ / 2, 1)
    const full = synthesizeGunshotBurst(SAMPLE_RATE_HZ, 1)
    expect(Math.abs(full.length - half.length * 2)).toBeLessThanOrEqual(1)
  })
})

describe('RQ-78/GA-118: synthesizeGunshotBurst — 클리핑·유한성(주 단언)', () => {
  it('모든 샘플이 |x| <= 1이다(클리핑 없음)', () => {
    for (const seed of [1, 2, 42]) {
      const samples = synthesizeGunshotBurst(SAMPLE_RATE_HZ, seed)
      for (const sample of samples) {
        expect(Math.abs(sample)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('모든 샘플이 유한하다(NaN·Infinity 없음)', () => {
    const samples = synthesizeGunshotBurst(SAMPLE_RATE_HZ, 7)
    for (const sample of samples) {
      expect(Number.isFinite(sample)).toBe(true)
    }
  })
})

describe('RQ-78/GA-118: synthesizeGunshotBurst — 엔벨로프(크게 시작해서 0으로 수렴, 주 단언)', () => {
  it('앞 10%의 최대 절대 진폭이 뒤 1%의 최대 절대 진폭보다 뚜렷하게 크다(시작이 끝보다 크다)', () => {
    const samples = synthesizeGunshotBurst(SAMPLE_RATE_HZ, 3)
    const n = samples.length
    const frontEnd = Math.max(1, Math.floor(n * 0.1))
    const tailStart = Math.min(n - 1, Math.ceil(n * 0.99))

    const frontMax = maxAbs(samples, 0, frontEnd)
    const tailMax = maxAbs(samples, tailStart, n)

    expect(frontMax).toBeGreaterThan(tailMax)
  })

  it('앞 10%는 충분히 큰 진폭에 도달한다(퇴화한 상시-무음 구현을 잡는다)', () => {
    const samples = synthesizeGunshotBurst(SAMPLE_RATE_HZ, 3)
    const frontEnd = Math.max(1, Math.floor(samples.length * 0.1))
    expect(maxAbs(samples, 0, frontEnd)).toBeGreaterThan(0.3)
  })

  it('뒤 1%는 0에 가깝게 수렴한다(끝에서 무음에 근접)', () => {
    const samples = synthesizeGunshotBurst(SAMPLE_RATE_HZ, 3)
    const n = samples.length
    const tailStart = Math.min(n - 1, Math.ceil(n * 0.99))
    expect(maxAbs(samples, tailStart, n)).toBeLessThan(0.05)
  })
})

describe('RQ-78/GA-118: 오디오 로딩 경로 부재(보조 — 주 증거 아님, 위 그룹들이 주 증거다)', () => {
  it('gunshotSynth.ts 소스에 fetch·decodeAudioData·XMLHttpRequest·녹음 샘플 확장자 문자열이 없다', () => {
    // `tests/unit/`에서 저장소 루트를 거쳐 계약 경로(`src/client/audio/
    // gunshotSynth.ts`)로 내려간다 — 이 파일이 없으면(지금) ENOENT로
    // 실패한다(파일 부재 자체가 "구현 0줄"의 증거이지, 이 절이 조용히
    // 통과하지 않는다 — 위 "밟지 않는 함정" 절 참고).
    const testDir = dirname(fileURLToPath(import.meta.url))
    const implPath = resolve(testDir, '../../src/client/audio/gunshotSynth.ts')
    const source = readFileSync(implPath, 'utf-8')

    const forbiddenPatterns = [/fetch\s*\(/, /decodeAudioData/, /XMLHttpRequest/, /\.wav['"`]/, /\.mp3['"`]/, /\.ogg['"`]/]
    for (const pattern of forbiddenPatterns) {
      expect(pattern.test(source)).toBe(false)
    }
  })
})
