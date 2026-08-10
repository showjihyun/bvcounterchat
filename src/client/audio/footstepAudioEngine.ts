import { synthesizeFootstepBurst } from '@client/audio/footstepSynth'

/**
 * RQ-72 2/2-b — 발소리 재생 배선(ADR-0008 §6 렌더·오디오 계층 면제 — 이
 * 파일 자체는 자동 테스트 대상이 아니다. 값 검증은 이미 순수 함수
 * (`footstepSynth.ts`의 파형·`footstepPlayback.ts`의 재생 횟수 판정)가
 * 했다. 이 파일이 하는 일은 그 둘을 실제 `AudioContext`로 소리 낼 뿐,
 * 새 판정 로직을 추가하지 않는다).
 *
 * 브라우저 자동재생 정책상 `AudioContext`는 **사용자 제스처 이후에만**
 * 시작할 수 있다(ADR-0014 「결과」). 이 게임은 포인터 락 진입(캔버스
 * 클릭)이 그 제스처이므로, 호출자(`PlayerControls.tsx`)가 같은 클릭
 * 핸들러 안에서 `open()`을 부른다.
 *
 * 파형은 `open()` 시점에 **한 번만** 합성해 `AudioBuffer`로 캐시한다 —
 * 재생마다 새로 합성하면 순수 계산(수천 샘플 루프)이 발소리마다 반복된다.
 * `AudioBufferSourceNode`는 Web Audio API 자체가 1회용으로 설계한
 * 객체라(재생이 끝나면 버려진다) 재생마다 새로 만드는 것은 불가피하다 —
 * 재사용 가능한 자원은 그 아래의 `AudioBuffer`뿐이다. `harness/workflow/
 * fe.md`의 "렌더 루프(`useFrame`) 안에서 객체를 할당하지 않는다"는
 * 규칙은 60fps 렌더 루프를 겨냥한 것이고, 이 엔진의 소비자
 * (`PlayerControls.tsx`)는 `useFrame`이 아니라 30Hz 이동 루프에서 실제로
 * 발소리가 발생한 순간에만 `playBurst()`를 부른다 — 매 프레임 호출이
 * 아니다.
 */
export interface FootstepAudioEngine {
  /** 사용자 제스처(포인터 락 클릭) 핸들러 안에서 호출한다. 멱등 — 이미
   * 열려 있으면 아무 일도 하지 않는다. */
  open(): void
  /** 캐시된 버퍼를 새 `AudioBufferSourceNode`로 재생한다. `open()`이 아직
   * 호출되지 않았으면(배선 순서 오류 방어) 조용한 no-op — 자동재생
   * 정책을 우회하려 시도하지 않는다. */
  playBurst(): void
}

/** @param seed 합성 결정론 시드(`synthesizeFootstepBurst`) — 기본값 1,
 * 발소리는 세션 내내 같은 파형을 재생한다(매 재생마다 새 시드를 뽑을
 * 이유가 없다 — 스펙이 요구하지 않는 다양화다). */
export function createFootstepAudioEngine(seed = 1): FootstepAudioEngine {
  let context: AudioContext | undefined
  let buffer: AudioBuffer | undefined

  return {
    open(): void {
      if (!context) {
        context = new AudioContext()
        const samples = synthesizeFootstepBurst(context.sampleRate, seed)
        const newBuffer = context.createBuffer(1, samples.length, context.sampleRate)
        // `copyToChannel`은 `Float32Array<ArrayBuffer>`를 요구하는데
        // `synthesizeFootstepBurst`의 반환 타입은 (제네릭을 명시하지 않아)
        // `Float32Array<ArrayBufferLike>`로 넓혀진다 — 새 배열로 감싸
        // 구체 `ArrayBuffer` 백업을 보장한다(값 복사는 어차피 1회, 초기화
        // 시점에만 일어난다).
        newBuffer.copyToChannel(new Float32Array(samples), 0)
        buffer = newBuffer
      }
      // 원장 28ab 평가 F2 — `AudioContext`가 `suspended` 상태로 열릴 수
      // 있다(브라우저 자동재생 정책이 첫 제스처에서 즉시 `running`을
      // 보장하지 않는 경우가 있다). 위 `if (!context)` 가드 때문에 재개
      // 시도를 여기서 하지 않으면 이후 어떤 클릭도 복구할 방법이 없어
      // 영구 무음이 된다 — 그래서 이 검사는 `open()`이 불릴 때마다(매
      // 제스처) 반복한다. `pointerLock.ts`가 락 거절을 `console.warn`하는
      // 것과 같은 대우(원장 24e-2 "실패가 조용하면 안 된다") — 실패해도
      // 예외를 던지지 않고 다음 제스처에서 다시 시도할 수 있게 둔다.
      if (context.state === 'suspended') {
        context.resume().catch((err: unknown) => {
          console.warn(
            `[footstepAudioEngine] AudioContext 재개 실패: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      }
    },
    playBurst(): void {
      if (!context || !buffer) return
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.start()
    },
  }
}
