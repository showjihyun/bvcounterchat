import { createRng } from '@shared/sim/rng'
import { AUDIO_TUNING } from '@shared/config/audio-tuning'

/**
 * RQ-78 발사음 — 파형 절차적 합성(ADR-0014 결정 2: 노이즈 소스 + 엔벨로프,
 * 오디오 파일을 저장소에 두지 않는다). **순수 함수** — `AudioContext`를
 * 참조하지 않는다(`footstepSynth.ts`가 세운 선례와 동일한 이유 — 검증
 * 수단으로 합성기를 재생 배선과 분리한다, ADR-0014 결정 5 "합성" 층).
 * 배선 계층(`gunshotAudioEngine.ts`)이 이 함수의 결과를 `AudioBuffer`로
 * 감싸 재생한다 — 그 배선은 **ADR-0014 결정 5의 재생 배선 층**이라 이
 * 파일과 별도로 취급한다.
 *
 * 계약 전문은 `tests/unit/rq-78-gunshot-synth.test.ts` 상단 docblock
 * (test-writer 지정)이 정본이다 — 이 함수는 그 계약을 그대로 구현한다.
 * `footstepSynth.ts`의 `synthesizeFootstepBurst`와 **완전히 동일한 API
 * 형태·엔벨로프 방식**을 재사용한다(계약이 "새 합성 관례를 발명하지
 * 않는다"로 명시) — 지속 시간 상수만 발사음 전용값
 * (`AUDIO_TUNING.GUNSHOT_DURATION_MS`)으로 갈린다.
 *
 * 결정론(ADR-0008): 노이즈 소스는 `Math.random()`을 쓰지 않고
 * `@shared/sim/rng`의 `createRng(seed)`를 재사용한다(ADR-0010 — 이미
 * 결정론이 검증된 시드 PRNG가 있는데 새 PRNG를 발명하면 로직 복제다).
 */
export function synthesizeGunshotBurst(sampleRateHz: number, seed: number): Float32Array {
  const sampleCount = Math.round((sampleRateHz * AUDIO_TUNING.GUNSHOT_DURATION_MS) / 1000)
  const samples = new Float32Array(sampleCount)
  const rng = createRng(seed)

  // 지수 감쇠 엔벨로프 — `footstepSynth.ts`와 동일한 DECAY_RATE=8(그
  // 파일의 근거를 그대로 재사용한다: t=i/(n-1) 구간에서 앞 10%(t≈0.1)가
  // 여전히 큰 진폭(엔벨로프 ≈ exp(-0.8) ≈ 0.45)을 유지해 "충분히 큰 진폭"
  // 단언을 넉넉히 만족하면서, 뒤 1%(t≈0.99)는 exp(-0.99×8) ≈ 0.00036으로
  // "0에 가깝게 수렴" 단언을 여유 있게 만족한다 — 지속 시간(상수)만
  // 다르고 t는 항상 [0,1] 비율이므로 발사음(150ms)에도 동일하게 성립한다).
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
