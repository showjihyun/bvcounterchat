import { createRng } from '@shared/sim/rng'
import { AUDIO_TUNING } from '@shared/config/audio-tuning'

/**
 * RQ-72 2/2-b — 발소리 파형 절차적 합성(ADR-0014 결정 2: 노이즈 소스 +
 * 엔벨로프, 오디오 파일을 저장소에 두지 않는다). **순수 함수** —
 * `AudioContext`를 참조하지 않는다(원장 24bv 사용자 결정 1: 검증 수단으로
 * 합성기를 재생 배선과 분리했다 — 샘플 배열을 리턴하면 길이·엔벨로프·
 * 클리핑을 값으로 단언할 수 있다). 배선 계층(`footstepAudioEngine.ts`)이
 * 이 함수의 결과를 `AudioBuffer`로 감싸 재생한다 — 그 배선은 ADR-0008 §6
 * 면제 대상이라 이 파일과 별도로 취급한다.
 *
 * 계약 전문은 `tests/unit/rq-72-footstep-synth.test.ts` 상단 docblock
 * (test-writer 지정)이 정본이다 — 이 함수는 그 계약을 그대로 구현한다.
 *
 * 결정론(ADR-0008): 노이즈 소스는 `Math.random()`을 쓰지 않고
 * `@shared/sim/rng`의 `createRng(seed)`를 재사용한다(ADR-0010 — 이미
 * 결정론이 검증된 시드 PRNG가 있는데 새 PRNG를 발명하면 로직 복제다).
 */
export function synthesizeFootstepBurst(sampleRateHz: number, seed: number): Float32Array {
  const sampleCount = Math.round((sampleRateHz * AUDIO_TUNING.FOOTSTEP_DURATION_MS) / 1000)
  const samples = new Float32Array(sampleCount)
  const rng = createRng(seed)

  // 지수 감쇠 엔벨로프 — 정확한 감쇠 곡선 모양은 스펙이 규정하지 않는
  // 구현 세부다(test-writer 재량, 계약 docblock "엔벨로프" 절 — "선형·
  // 지수·코사인 창 등 coder 재량"). DECAY_RATE=8은 t=i/(n-1) 구간에서
  // 앞 10%(t≈0.1)가 여전히 큰 진폭(엔벨로프 ≈ exp(-0.8) ≈ 0.45)을 유지해
  // "충분히 큰 진폭" 단언을 넉넉히 만족하면서, 뒤 1%(t≈0.99)는 노이즈
  // 최댓값(<1)을 곱해도 exp(-0.99×8) ≈ 0.00036으로 "0에 가깝게 수렴"
  // 단언을 여유 있게 만족하도록 고른 값이다.
  const DECAY_RATE = 8

  for (let i = 0; i < sampleCount; i += 1) {
    const t = sampleCount > 1 ? i / (sampleCount - 1) : 0
    const envelope = Math.exp(-DECAY_RATE * t)
    // rng.nextRange(-1, 1)은 [-1, 1) 범위다 — envelope(0,1]와 곱해도
    // 절댓값이 항상 1 미만이라 클리핑이 구조적으로 발생하지 않는다.
    samples[i] = rng.nextRange(-1, 1) * envelope
  }

  return samples
}
