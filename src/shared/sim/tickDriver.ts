/**
 * RQ-60(30Hz 고정 틱) — 실 경과 시간(ms)을 정수 틱으로 환산해
 * `MutableTickClock`·`TickScheduler`(원장 17e 계약, `./clock`·`./scheduler`)
 * 를 전진시키는 얇은 어댑터. 원장 17e 계약에는 없는 신규 모듈이라
 * test-writer가 이 shape(`createTickDriver(clock, scheduler)` →
 * `{ advanceByElapsed(elapsedMs): number }`)을 지정했다
 * (`tests/unit/sim-tick-driver.test.ts` 상단 코멘트·
 * `_workspace/RQ-60/01_test-writer_red.md` 참고).
 *
 * **드리프트 방지가 이 모듈의 핵심이다.** "틱마다 누적기에서 `NET.TICK_MS`를
 * 반복해서 빼는" 순진한 뺄셈 누적은 `NET.TICK_MS`(=1000/30, 부동소수점)의
 * 오차가 반복될수록 쌓여 100ms 입력에 2틱, 1000ms 입력에 29틱을 내고,
 * 1000ms를 여러 조각으로 쪼개 넣으면 결과가 달라진다(결정론 붕괴, 실측
 * 확인은 위 Red 보고서 참고). 그래서 이 모듈은 매 호출마다 "총 경과 ms 대비
 * 있어야 할 총 틱 수"를 처음부터 다시 계산한다 — 누적 뺄셈이 아니라 누적
 * 나눗셈이다. `DRIFT_EPSILON_MS`는 그 나눗셈 자체가 부동소수점이라 정확히
 * 정수 배수인 입력(예: `NET.TICK_MS`를 그대로 다시 넣는 경우)에서 결과가
 * 한 틱 모자라게 내림되는 것을 막는 안전 여유다.
 *
 * **전진 단위 불변식 (`harness/sim/README.md` §4와 동일 정신)**: 여러 틱
 * 분량이 한 번에 경과해도 절대 벌크로 건너뛰지 않는다 — 틱마다
 * `clock.advance(1)` 후 `scheduler.advanceTo(clock.tick)`을 개별 호출해야
 * 콜백이 관측하는 `clock.tick`이 자신의 마감 틱과 같다(벌크 전진 후의 최종
 * 틱이 아니라).
 *
 * `src/shared` 환경 중립·결정론 제약(ADR-0008/0010): 이 모듈은 "경과
 * 시간"을 인자로 받을 뿐 시간을 직접 재지 않는다 — 실 시간 측정(`Date.now`
 * 등)은 `src/server`의 구동 루프 책임이다.
 *
 * **catch-up clamp (하이브리드, RQ-60 v1.1 — `harness/sim/README.md` §5)**:
 * 한 호출은 최대 `maxTicksPerAdvance`틱만 전진하고, 남은 밀림은 누적기에
 * 그대로 남아 다음 호출들에서 이어서 소화된다(짧은 스파이크는 유실 없음).
 * 다만 그 시점에 계산된 밀림(`targetTick - clock.tick`)이 `maxBacklogTicks`를
 * **넘으면**(`==`는 정상 캐치업 대상) 그 호출은 전량을 버린다 — 0틱 전진,
 * `onOverflow(버린 전체 틱 수)` 호출, 그리고 누적기를 `clock.tick` 기준으로
 * 재정렬해 백로그 0에서 재출발한다(다음 33.33ms 경과가 정확히 1틱이 되도록).
 * 이 재정렬도 "총 경과에서 매번 재계산"이라는 드리프트 방지 원칙을 그대로
 * 따른다 — 재정렬 시점의 `accumulatedMs`를 `clock.tick * NET.TICK_MS`로
 * 다시 정의할 뿐, 그 이후의 산술(예: 100ms→3틱)은 오염되지 않는다.
 */

import type { MutableTickClock } from './clock'
import type { TickScheduler } from './scheduler'
import { NET } from '@shared/constants'

export interface TickDriver {
  /**
   * `elapsedMs`만큼 경과했다고 알린다. 있어야 할 틱까지 하나씩 개별
   * 전진시키고, 이번 호출로 전진한 틱 수를 반환한다. 나머지(다음 틱까지
   * 못 미친 잔여 ms)는 내부 누적치에 남아 다음 호출로 이월된다.
   */
  advanceByElapsed(elapsedMs: number): number
}

export interface TickDriverOptions {
  /** 한 호출당 따라잡는 최대 틱 수. 기본 15 (0.5초치). */
  maxTicksPerAdvance?: number
  /** 누적 밀림 상한(틱). 초과분은 버리고 onOverflow를 부른다. 기본 30 (1초치). */
  maxBacklogTicks?: number
  /** 밀림 초과로 시간이 유실될 때 호출 (버린 틱 수 전달). 로깅용. */
  onOverflow?: (droppedTicks: number) => void
}

/**
 * 정수 배수 경과(예: `NET.TICK_MS` 그대로)가 부동소수점 나눗셈 오차로
 * 한 틱 모자라게 내림되는 것을 막는 여유. 스펙 상수가 아니라 부동소수점
 * 안전 여유이므로 `@shared/constants`가 아니라 여기 둔다(스케줄러의
 * `DEFAULT_MAX_CALLBACKS_PER_ADVANCE`와 같은 성격).
 */
const DRIFT_EPSILON_MS = 1e-9

/**
 * clamp 안전망 파라미터의 기본값(`harness/sim/README.md` §5). 스펙 상수가
 * 아니므로 `@shared/constants`가 아니라 여기 둔다.
 */
const DEFAULT_MAX_TICKS_PER_ADVANCE = 15
const DEFAULT_MAX_BACKLOG_TICKS = 30

function assertValidElapsed(elapsedMs: number): void {
  if (Number.isNaN(elapsedMs)) {
    throw new TypeError(`advanceByElapsed(elapsedMs)의 elapsedMs는 NaN을 받을 수 없다 (받은 값: ${elapsedMs})`)
  }
  if (elapsedMs < 0) {
    throw new RangeError(`advanceByElapsed(elapsedMs)의 elapsedMs는 음수를 받을 수 없다 (받은 값: ${elapsedMs})`)
  }
}

/**
 * clamp 옵션(`maxTicksPerAdvance`·`maxBacklogTicks`) 값을 검증한다. 둘 다
 * "1 이상의 정수"여야 한다 — 0·음수·비정수·NaN은 조용히 보정하지 않고
 * 던진다(하네스 §1 원칙, `clock.advance`·`scheduler`의 검증과 같은 정신).
 */
function resolvePositiveIntOption(value: number | undefined, defaultValue: number, optionName: string): number {
  if (value === undefined) {
    return defaultValue
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `createTickDriver의 options.${optionName}은(는) 1 이상의 정수여야 한다 (받은 값: ${value}) — ` +
        '조용한 보정 금지(하네스 §1)',
    )
  }
  return value
}

export function createTickDriver(
  clock: MutableTickClock,
  scheduler: TickScheduler,
  options: TickDriverOptions = {},
): TickDriver {
  const maxTicksPerAdvance = resolvePositiveIntOption(
    options.maxTicksPerAdvance,
    DEFAULT_MAX_TICKS_PER_ADVANCE,
    'maxTicksPerAdvance',
  )
  const maxBacklogTicks = resolvePositiveIntOption(options.maxBacklogTicks, DEFAULT_MAX_BACKLOG_TICKS, 'maxBacklogTicks')
  const onOverflow = options.onOverflow

  // 총 경과 ms 누적치 — 여기서 뺄셈으로 소모하지 않는다(그게 드리프트의
  // 원인이다). targetTick은 매번 이 누적치 전체에서 새로 계산한다. 밀림
  // 초과로 버릴 때만 이 누적치를 `clock.tick` 기준으로 재정렬한다(아래).
  let accumulatedMs = 0

  function advanceByElapsed(elapsedMs: number): number {
    assertValidElapsed(elapsedMs)
    accumulatedMs += elapsedMs
    const targetTick = Math.floor(accumulatedMs / NET.TICK_MS + DRIFT_EPSILON_MS)
    const backlog = targetTick - clock.tick

    if (backlog > maxBacklogTicks) {
      onOverflow?.(backlog)
      // 빨리감기 없이 이 호출의 밀림 전량을 버린다 — 0틱 전진, clock은
      // 그대로. 다음 호출부터 백로그 0에서 재출발하도록 누적치를 현재
      // `clock.tick` 기준으로 재정렬한다(드리프트 없는 총 경과 재계산 방식
      // 유지 — 이후 산술이 이 재정렬로 오염되지 않는다).
      accumulatedMs = clock.tick * NET.TICK_MS
      return 0
    }

    const ticksToAdvance = Math.min(backlog, maxTicksPerAdvance)
    for (let i = 0; i < ticksToAdvance; i += 1) {
      clock.advance(1)
      scheduler.advanceTo(clock.tick)
    }
    return ticksToAdvance
  }

  return { advanceByElapsed }
}
