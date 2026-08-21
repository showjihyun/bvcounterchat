import { synthesizeGunshotBurst } from '@client/audio/gunshotSynth'

/**
 * RQ-78 발사음 재생 배선(ADR-0014 결정 5 — 재생 배선 층 — 이 파일 자체는
 * 자동 테스트 대상이 아니다. 값 검증은 이미 순수 함수
 * (`gunshotSynth.ts`의 파형·`@shared/sim/gunshotAudio`의 볼륨 판정)가
 * 했다. 이 파일이 하는 일은 그 둘을 실제 `AudioContext`로 소리 낼 뿐, 새
 * 판정 로직을 추가하지 않는다). `footstepAudioEngine.ts`가 세운 선례와
 * 동일한 형태 — 유일한 차이는 발사음이 거리에 따라 **볼륨이 연속적으로
 * 감쇠**해야 하므로(GA-117 — 발소리는 이진 가청/비가청뿐이다)
 * `playBurst`가 게인(`GainNode`)을 인자로 받는다는 점이다.
 *
 * 브라우저 자동재생 정책상 `AudioContext`는 **사용자 제스처 이후에만**
 * 시작할 수 있다(ADR-0014 「결과」). 이 게임은 포인터 락 진입(캔버스
 * 클릭)이 그 제스처이므로, 호출자(`PlayerControls.tsx`)가 같은 클릭
 * 핸들러 안에서 `open()`을 부른다(발소리와 같은 제스처를 공유한다 —
 * 브라우저는 페이지당 `AudioContext` 생성 제스처 자체를 딱히 여러 번
 * 요구하지 않는다, `resume()`은 아래처럼 매 제스처 반복한다).
 *
 * 파형은 `open()` 시점에 **한 번만** 합성해 `AudioBuffer`로 캐시한다 —
 * 재생마다 새로 합성하면 순수 계산이 발사마다 반복된다(`footstepAudioEngine
 * .ts`와 동일한 근거). `AudioBufferSourceNode`는 1회용이라 재생마다 새로
 * 만드는 것은 불가피하다 — 이 루프의 소비자(`PlayerControls.tsx`)는
 * `useFrame`이 아니라 서버 'gunshot' 이벤트 수신 시점에만 `playBurst()`를
 * 부른다(매 프레임 호출이 아니다, `harness/workflow/fe.md` 프레임 예산과
 * 무관).
 */
export interface GunshotAudioEngine {
  /** 사용자 제스처(포인터 락 클릭) 핸들러 안에서 호출한다.
   *
   * `footstepAudioEngine.ts`의 `open()`과 동일한 계약 — 완전 멱등이
   * 아니다: 컨텍스트 생성과 파형 합성은 **1회뿐**이지만,
   * `context.state === 'suspended'` 검사와 `resume()`은 **매 제스처마다**
   * 돈다(그러지 않으면 브라우저가 컨텍스트를 정지시킨 뒤 어떤 클릭으로도
   * 복구되지 않아 영구 무음이 된다 — `footstepAudioEngine.ts` 원장 참고).
   * `resume()` 실패는 조용히 넘기지 않고 `console.warn`한다. */
  open(): void
  /** 캐시된 버퍼를 새 `AudioBufferSourceNode`로, `volume`(선형 게인
   * `[0, 1]`, `gunshotVolume`의 반환값 그대로)을 적용해 재생한다. `open()`이
   * 아직 호출되지 않았으면(배선 순서 오류 방어) 조용한 no-op. */
  playBurst(volume: number): void
}

/** @param seed 합성 결정론 시드(`synthesizeGunshotBurst`) — 기본값 1,
 * `footstepAudioEngine.ts`의 기본 시드와 동일한 근거(세션 내내 같은
 * 파형을 재생한다 — 매 재생마다 새 시드를 뽑을 이유가 없다). */
export function createGunshotAudioEngine(seed = 1): GunshotAudioEngine {
  let context: AudioContext | undefined
  let buffer: AudioBuffer | undefined

  return {
    open(): void {
      if (!context) {
        context = new AudioContext()
        const samples = synthesizeGunshotBurst(context.sampleRate, seed)
        const newBuffer = context.createBuffer(1, samples.length, context.sampleRate)
        // `footstepAudioEngine.ts`와 동일한 이유로 새 배열에 감싸 구체
        // `ArrayBuffer` 백업을 보장한다.
        newBuffer.copyToChannel(new Float32Array(samples), 0)
        buffer = newBuffer
      }
      if (context.state === 'suspended') {
        context.resume().catch((err: unknown) => {
          console.warn(
            `[gunshotAudioEngine] AudioContext 재개 실패: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      }
    },
    playBurst(volume: number): void {
      if (!context || !buffer) return
      const source = context.createBufferSource()
      source.buffer = buffer
      // GA-117 — 발사음은 거리에 따라 볼륨이 연속적으로 감쇠한다(발소리의
      // 이진 가청/비가청과 다른 지점). `GainNode`로 판정 층(`gunshotVolume`)의
      // 반환값을 그대로 적용한다 — 여기서 새 판정을 하지 않는다.
      const gain = context.createGain()
      gain.gain.value = volume
      source.connect(gain)
      gain.connect(context.destination)
      source.start()
    },
  }
}
