import { PLAYER } from '@shared/constants'
import { canAct } from '@shared/sim/lifecycle'
import { stepFootstepAccumulator, type FootstepTickInput } from '@shared/sim/footsteps'
import type { MoveInput } from '@shared/sim/movement'

/**
 * RQ-72 2/2-b — 자기 발소리 누적(원격 경로는 `interpolation.ts`의
 * `advanceFootstepAccumulator`). 이전 라운드에는 이 판정이
 * `PlayerControls.tsx`(ADR-0008 §6 렌더 계층 면제 대상) 안에 인라인으로
 * 있어 자동 커버리지가 0이었다 — 이 모듈은 그 판정만 순수 함수로 뽑아
 * `tsc`·`vitest` 양쪽의 대상이 되게 한다(`footstepPlayback.ts`가 합성기를
 * 뽑은 것과 같은 이유).
 *
 * **원장 28ab 평가 FAIL F1 대응** — 사망 중 게이팅. 서버는 사망 중 입력을
 * ack하지 않는다(`GameRoom.ts:1186`의 `if (!canAct(player.hp)) { … return }`
 * 이 `lastProcessedInputSeq` 기록보다 앞에 있다). `ClientPredictor.reconcile`은
 * 미확인 입력을 전부 재생하므로, 게이팅 없이는 고정된 시신 위치 위에
 * 예측이 계속 전진해 사망 중에도 자기 발소리가 난다(실측: 사망 90틱 동안
 * 7회). 원격 경로는 서버가 시신 위치를 고정하므로 이 문제가 구조적으로
 * 없다 — 자기 경로만 명시적 게이팅이 필요하다.
 *
 * ⚠️ **누적만 건너뛰고 `previous`(위치·hp)는 매 틱 갱신한다** — 갱신을
 * 멈추면 부활 시점에 사망 지점부터의 변위가 한꺼번에 새어 큰 누적이
 * 발생한다. `discontinuous`(리스폰) 리셋은 `stepFootstepAccumulator`가
 * 그대로 처리하므로 이 모듈은 게이팅 한 겹만 얹는다.
 *
 * ⚠️ **F1 잠금 테스트는 이 라운드에 없다** — ADR-0011 결정 1 "결함 수정
 * 라운드의 재현 테스트"는 Red-first 영역이라 `tests/`는 test-writer
 * 전유물이다(coder 역할 규약). 이 파일을 순수 함수로 분리해 둔 것은 그
 * 테스트를 다음에 쓰기 쉽게 하기 위함이지, 이 라운드에서 coder가 직접
 * 쓴 것이 아니다 — `_workspace/RQ-72c/04_coder_fix.md` 참고.
 *
 * 재사용 버퍼(F3, 원장 28ab 평가 관찰) — 이 트래커의 소비자
 * (`PlayerControls.tsx`)는 `useFrame`이 아니라 30Hz 이동 루프이므로
 * `harness/workflow/fe.md`의 프레임 예산 규칙(`useFrame` 한정) 위반은
 * 아니지만, 같은 파일의 `anchorScratch`·`footstepPositionScratch`가 이미
 * "30Hz라도 같은 규율을 쓴다"는 관례를 세워 두었다 — 내부 상태(`previous`·
 * `tickInput`)를 틱마다 새 객체로 만들지 않고 제자리에서 갱신해 그 관례를
 * 따른다.
 */

export interface SelfFootstepTrackerTickInput {
  x: number
  z: number
  grounded: boolean
  mode: MoveInput['mode']
  /** 서버 확정 HP(RQ-61) — 사망 게이팅과 리스폰 판정 둘 다 이 값을 쓴다. */
  hp: number
}

export interface SelfFootstepTracker {
  /** 정확히 1틱 전진하고, 갱신된 누적 발소리 총합을 반환한다. */
  step(input: SelfFootstepTrackerTickInput): number
}

export function createSelfFootstepTracker(strideM: number): SelfFootstepTracker {
  let hasPrevious = false
  // F3 — 매 틱 새 객체를 만들지 않고 제자리 갱신한다.
  const previous = { x: 0, z: 0, grounded: false, hp: 0 }
  const tickInput: FootstepTickInput = {
    wasGrounded: false,
    isGrounded: false,
    mode: 'run',
    horizontalDeltaM: 0,
    discontinuous: false,
  }
  let accumM = 0
  let totalCount = 0

  return {
    step(input: SelfFootstepTrackerTickInput): number {
      // F1 — 사망 중(`!canAct(input.hp)`)에는 누적을 건너뛴다. 리스폰 틱은
      // `input.hp === PLAYER.MAX_HP`(canAct true)이므로 게이트를 통과해
      // 아래 discontinuous 리셋이 그대로 발동한다.
      if (hasPrevious && canAct(input.hp)) {
        tickInput.wasGrounded = previous.grounded
        tickInput.isGrounded = input.grounded
        tickInput.mode = input.mode
        tickInput.horizontalDeltaM = Math.hypot(input.x - previous.x, input.z - previous.z)
        tickInput.discontinuous = previous.hp === 0 && input.hp === PLAYER.MAX_HP
        const result = stepFootstepAccumulator(accumM, tickInput, strideM)
        accumM = result.accumM
        totalCount += result.footstepCount
      }
      previous.x = input.x
      previous.z = input.z
      previous.grounded = input.grounded
      previous.hp = input.hp
      hasPrevious = true
      return totalCount
    },
  }
}
