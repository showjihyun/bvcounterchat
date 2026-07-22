# 결정론 시뮬레이션 하네스 — API 계약

> `src/shared/sim/{clock,rng,scheduler}.ts`와 `tests/support/harness.ts`의
> **동작 계약**이다. 구현이 이 문서와 어긋나면 둘 중 하나가 버그다 —
> 코드를 고치거나(구현 실수) 이 문서를 개정한다(계약 변경, 같은 PR에서).
> 구현 상단 주석이 이 계약을 요약하지만, 근거·트레이드오프는 여기가 정본이다.
>
> 원 구축: 원장 17e (2026-07-21). 파이프라인 핸드오프본은 gitignore된
> `_workspace/harness-17e/contract.md`에 있었고, 이 파일이 그 영구 승격본이다.

## 왜 필요한가

`harness/workflow/tdd.md` Phase 0이 "결정론적 시뮬레이션 하네스(고정 틱 +
fake timer)가 존재한다"를 전제조건으로 요구한다. 없으면 시간 기반 RQ(재장전
2초 RQ-11, 리스폰 3초 RQ-15, 스폰 보호 3초 RQ-16, AFK 5분 RQ-43, 30Hz 틱
RQ-60)에서 "틱을 수동 전진"시킬 대상이 없어 실타이머 의존 테스트가 나온다.
그런 테스트는 flaky하고, flaky한 게이트는
곧 무시된다.

## 핵심 설계 판단

**시간의 정본 단위는 틱(정수)이다. ms가 아니다.**

`NET.TICK_MS`는 `1000/30 = 33.333…`이라 ms로 누적하면 부동소수점 오차가
쌓인다. 90틱 후의 시각을 `tick * TICK_MS`로 계산하는 것과 `TICK_MS`를 90번
더하는 것이 다른 값을 낸다. 그러면 "같은 입력 → 같은 출력"이 깨지고 결정론이라는
목적 자체가 무너진다.

따라서: **모든 내부 상태와 마감시한은 틱 정수로 보관**하고, ms는 경계
(API 인자·표시)에서만 쓴다.

**런타임 코드다.** `src/shared/sim/`에 둔다 — 테스트 전용이 아니다.
서버는 실제 30Hz 루프로 이 시계를 전진시키고, 테스트는 같은 인터페이스를
수동으로 전진시킨다. **인터페이스가 같고 구동자만 다른 것**이 이 설계의 요점이다.
클라이언트 예측(RQ-62)도 같은 코드를 쓴다(ADR-0010 값 복제 금지).

## 제약

- `src/shared`는 환경 중립이어야 한다 — `window`·`document`·`process`·`fs`
  참조·임포트 금지 (ADR-0010, lint가 강제)
- `Math.random()`·`Date.now()`·`performance.now()` 직접 호출 금지
  (ADR-0008, lint가 강제)
- `setTimeout`·`setInterval` 사용 금지 — 틱 기반 스케줄러가 대체한다
- 스펙 상수는 `@shared/constants`에서 임포트한다. 리터럴 복제 금지

---

## 1. `src/shared/sim/clock.ts`

```ts
export interface TickClock {
  /** 현재 틱 (정수, 0부터). 시간의 정본. */
  readonly tick: number
  /** 현재 시각(ms). tick에서 유도된 값 — 저장하지 않고 계산한다. */
  readonly timeMs: number
}

export interface MutableTickClock extends TickClock {
  /** n틱 전진 (기본 1). n은 0 이상의 정수. */
  advance(n?: number): void
}

export function createClock(startTick?: number): MutableTickClock

/** ms를 틱으로 환산. 올림(ceil) — 마감시한은 "그 시각 이후"에 만료돼야 한다. */
export function msToTicks(ms: number): number

/** 틱을 ms로 환산. */
export function ticksToMs(ticks: number): number
```

**요구 동작**
- `createClock()`의 초기 `tick`은 0, `timeMs`는 0
- `advance(n)`은 `tick`을 정확히 n 증가시킨다
- `advance()`는 `advance(1)`과 같다
- `advance(0)`은 아무 변화 없음
- 음수·비정수 인자는 던진다(`RangeError` 또는 `TypeError`) — 조용히 반올림하면
  결정론이 깨진 것을 아무도 모른다
- `timeMs`는 `ticksToMs(tick)`과 항상 같다
- `msToTicks`는 **올림**이다: `msToTicks(0) === 0`,
  `msToTicks(1) === 1`(33.33ms 미만이어도 1틱), `msToTicks(2000) === 60`,
  `msToTicks(3000) === 90`
- 스펙 상수 환산이 정확해야 한다:
  재장전 2000ms → 60틱 · 리스폰 3000ms → 90틱 · 스폰 보호 3000ms → 90틱 ·
  AFK 300000ms → 9000틱 (RQ-11/15/16/43)

## 2. `src/shared/sim/rng.ts`

```ts
export interface SeededRng {
  /** 다음 32비트 부호 없는 정수 */
  nextU32(): number
  /** [0, 1) 범위 실수 */
  nextFloat(): number
  /** [min, max) 범위 실수 */
  nextRange(min: number, max: number): number
  /** 독립된 하위 스트림. 같은 salt는 같은 스트림을 준다. */
  fork(salt: number): SeededRng
}

export function createRng(seed: number): SeededRng
```

**요구 동작**
- 같은 시드 → 완전히 같은 수열 (재현성). 이것이 RQ-90 탄퍼짐 랜덤 콘이
  결정론적으로 테스트 가능한 근거다
- 다른 시드 → 다른 수열
- `nextFloat()`는 항상 `0 <= x < 1`
- `nextRange(a, b)`는 항상 `a <= x < b`
- `fork(salt)`가 준 스트림은 부모의 이후 수열에 영향을 주지 않는다
  (사수별·발사별로 독립 스트림을 뽑기 위함)
- 같은 시드·같은 salt의 `fork`는 같은 수열
- `Math.random()`을 쓰지 않는다
- 32비트 정수 연산으로 구현해 플랫폼 간 동일 결과를 보장한다
  (`Math.imul`, `>>> 0` 사용)

## 3. `src/shared/sim/scheduler.ts`

```ts
export type TimerHandle = number

export interface TickScheduler {
  /** delayMs 후 실행 예약. 내부적으로 틱 마감시한으로 환산(올림). */
  scheduleIn(delayMs: number, callback: () => void): TimerHandle
  /** 특정 틱에 실행 예약. */
  scheduleAt(tick: number, callback: () => void): TimerHandle
  /** 예약 취소. 이미 실행됐거나 없는 handle이면 false. */
  cancel(handle: TimerHandle): boolean
  /** targetTick까지(포함) 만료된 콜백을 전부 실행. */
  advanceTo(targetTick: number): void
  /** 대기 중인 예약 수. */
  readonly pending: number
}

export interface SchedulerOptions {
  /** 한 advanceTo 안의 콜백 실행 상한 (연쇄 폭주 안전망). 기본 100,000. */
  maxCallbacksPerAdvance?: number
}

export function createScheduler(clock: TickClock, options?: SchedulerOptions): TickScheduler
```

**요구 동작**
- 콜백은 **마감 틱 순서대로** 실행된다. 같은 틱에 여러 개면 예약 순서대로
- 마감 틱 **이전**에는 절대 실행되지 않는다 (조기 실행 금지)
- `advanceTo`가 여러 틱을 한 번에 건너뛰어도 그 사이 만료된 것을 **전부**,
  순서대로 실행한다 (건너뛴 만료 유실 금지)
- `cancel`된 예약은 실행되지 않는다
- 콜백 안에서 새로 `scheduleIn`한 것이 같은 `advanceTo` 안에서 만료 시각에
  도달하면 그것도 실행된다 (연쇄 예약)
- **연쇄 폭주 상한**: 한 번의 `advanceTo` 호출 안에서 실행되는 콜백 수에
  상한을 둔다. 상한을 넘으면 던진다 — 조용히 무한 루프에 빠지지 않는다.
  - **왜**: `advanceTo`는 서버 틱 경로(RQ-60)에서 매 틱 호출된다. 콜백이
    `scheduleIn(0)`으로 자기를 재예약하면 마감이 현재 틱이라 같은 `advanceTo`
    안에서 끝없이 pop된다. 상한이 없으면 30Hz 서버가 그 틱에서 영원히 멈춘다.
    상한을 두면 **조용한 정지(hang)가 원인이 특정되는 에러**로 바뀐다.
  - **정상 코드는 이 상한에 닿지 않는다** — 이건 호출자 버그(무한 재예약)를
    잡는 안전망이다. 따라서 상한은 실제 게임이 한 틱에 낼 수 있는 콜백 수보다
    충분히 커야 한다. **기본값 100,000** (10인 규모에서 한 틱의 정상 콜백은
    많아야 수십 개다 — 3자리 이상의 여유).
  - 던지는 에러는 **원인을 특정할 수 있어야** 한다: 메시지에 "연쇄 폭주"와
    상한값, "콜백이 자신을 현재 틱 이하로 재예약하고 있는지 확인하라"는
    진단을 담는다. `RangeError`를 쓴다.
  - 이미 실행된 콜백의 부수효과는 되돌리지 않는다(롤백 없음). 던지는 시점까지
    실행된 것은 실행된 것이다 — `advanceTo`는 트랜잭션이 아니다.
  - 상한은 `createScheduler(clock, options?)`의 `options.maxCallbacksPerAdvance`로
    조정 가능하되, 미지정 시 기본값을 쓴다. **스펙 상수가 아니라 안전망
    파라미터**이므로 `@shared/constants`가 아니라 여기(스케줄러 옵션)에 둔다.
- 콜백이 던져도 나머지 콜백 실행이 중단되지 않는다 — 던진 것은 모아서
  `advanceTo`가 끝난 뒤 다시 던진다(`AggregateError`). 하나가 죽어서
  나머지 타이머가 조용히 사라지면 디버깅이 불가능하다
- **이미 지난 마감시한**(`scheduleAt`에 현재 틱 이하를 넘기거나
  `scheduleIn(0)`): 던지지 않는다. **다음 `advanceTo` 호출에서 실행**된다.
  이유: `scheduleIn(0)`은 정상적인 사용이고 그것이 곧 "현재 틱 마감"이므로,
  과거/현재 마감을 오류로 취급하면 경계에서 불필요하게 터진다. 다만
  `advanceTo`가 유일한 실행 지점이라는 규칙은 유지한다 — 예약 시점에
  즉시 실행하지 않는다. 그래야 "언제 실행됐는가"가 틱으로 결정된다
- `scheduleAt`의 tick과 `scheduleIn`의 delayMs가 비정수·음수·NaN이면 던진다
  (`advance`와 같은 이유 — 조용한 반올림 금지)
- `setTimeout`을 쓰지 않는다

## 4. `tests/support/harness.ts` (테스트 전용)

```ts
export interface SimHarness {
  clock: MutableTickClock
  rng: SeededRng
  scheduler: TickScheduler
  /** n틱 전진 — 시계를 옮기고 스케줄러를 그 틱까지 몰아준다. */
  advanceTicks(n: number): void
  /** ms만큼 전진 (올림으로 틱 환산). */
  advanceMs(ms: number): void
}

export function createSimHarness(options?: { seed?: number }): SimHarness
```

**요구 동작**
- `seed` 미지정 시 고정 기본값을 쓴다 — 테스트가 실행마다 달라지면 안 된다
- `advanceTicks(n)`은 시계를 n틱 전진시키고 **그 사이 만료된 스케줄러
  콜백을 전부 실행**한다. 둘을 따로 호출하게 두면 반드시 누가 잊는다
- `advanceMs(ms)`는 `advanceTicks(msToTicks(ms))`와 같다
- **전진 단위 불변식 (가장 중요)**: `advanceTicks(n)` 1회와 `advanceTicks(1)`
  n회는 **관측 가능한 모든 면에서 같은 결과**를 내야 한다. 구체적으로:
  1. 콜백이 실행되는 시점의 `clock.tick`이 **그 콜백의 마감 틱과 같아야** 한다
     (벌크 전진 후의 최종 틱이 아니라)
  2. 콜백 안에서 `scheduleIn`으로 건 연쇄 예약의 마감 틱이 두 경로에서 같아야 한다

  **왜 이것이 하네스의 존재 이유인가**: 서버는 시계를 1틱 옮기고 `advanceTo`를
  부른다(틱별 경로). 테스트는 `advanceMs(RELOAD_MS)`처럼 한 번에 건너뛴다
  (벌크 경로). 두 경로가 다른 결과를 내면 **하네스로 통과한 테스트가 서버
  동작을 보장하지 않는다.** "재장전 완료 후 다음 타이머를 건다" 같은 연쇄는
  게임 상태 기계의 기본 형태이고, RQ-11/15/16/43 테스트가 전부 이 위에 쌓인다.

  (2026-07-21 PR #4 리뷰에서 실제로 이 불변식이 깨진 채 evaluator PASS를 통과했다.
  계약이 이 요구를 명시하지 않아 evaluator가 문면 충족으로 판정한 것이다 —
  **계약의 누락이 원인이었다.**)

---

## 테스트 위치

- `tests/unit/sim-clock.test.ts`
- `tests/unit/sim-rng.test.ts`
- `tests/unit/sim-scheduler.test.ts`
- `tests/unit/sim-harness.test.ts` (하네스 자체가 동작하는지)

`tests/support/harness.ts`는 테스트 지원 코드이므로 그 자체를 테스트하는
파일도 위에 포함한다 — **고장 난 하네스는 없는 하네스보다 나쁘다.**
그 위에 쌓은 모든 테스트가 거짓 신호를 내기 때문이다.

## 골든 케이스

이건 RQ 구현이 아니라 테스트 인프라라 매핑된 GA 케이스가 없다.
정상이며, `tdd-workflow` Phase 0의 GA 요구는 RQ 구현에만 적용된다.
