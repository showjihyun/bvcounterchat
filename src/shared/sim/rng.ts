/**
 * 결정론 시뮬레이션 하네스 — 시드 난수 (원장 17e 계약 §2).
 *
 * 같은 시드가 항상 같은 수열을 내야 RQ-90(탄퍼짐 랜덤 콘)이 결정론적으로
 * 테스트 가능해진다. `Math.random()`은 시드를 주입할 수 없어 쓰지 않는다
 * (ADR-0008) — 대신 32비트 정수 연산만으로 구현해 플랫폼 간 동일 결과를
 * 보장한다(`Math.imul`, `>>> 0`). 부동소수점 누적 기반 PRNG는 반올림
 * 방식이 엔진마다 미세하게 갈릴 여지가 있어 피한다.
 *
 * `fork(salt)`는 사수별·발사별 독립 스트림을 뽑기 위한 것이다 — 부모
 * 스트림의 현재 상태와 salt를 해시로 섞어 자식 시드를 만들 뿐, 부모의
 * 다음 값을 소비하지 않는다.
 */

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

/** 2^32 — nextU32()를 [0, 1)로 정규화하는 분모. */
const U32_RANGE = 0x100000000

/**
 * 원장 17e-1① — `seed`/`salt`가 `>>> 0`(ToUint32)로 조용히 32비트에 랩어라운드
 * 되기 전에 **거부**한다. `>>> 0`은 비정수를 절삭하고(`1.5 → 1`), 음수를
 * 모듈러 랩어라운드하며(`-1 → 2^32-1`), 범위 밖 값을 모듈러로 접고
 * (`2**32 → 0`), `NaN`/`Infinity`/`-Infinity`까지 전부 유효한 정수(대부분
 * `0`)로 둔갑시킨다 — 시드를 계산식으로 만드는 호출자(예: `tick`·카운터를
 * 섞는 `fork` 실호출자)에서 무증상 충돌·상류 계산 버그 은폐로 이어진다
 * (원장 17e-1①, `_workspace/RQ-90-spread/01_test-writer_red.md` §21).
 * team-lead 결정: **전부 거부(throw)로 통일**한다 — 형제 API(`clock.ts`
 * `advance`·`scheduler.ts` `scheduleAt`)가 이미 "조용한 반올림 금지"를
 * 적용하고 있어 생성자만 비대칭이었다(17e-1① 원문). `assertNonNegativeInteger`
 * (`clock.ts`·`scheduler.ts`)와 같은 정신이지만, 여기는 상한(2^32 미만)도
 * 검사한다는 점이 다르다 — 그 둘을 억지로 재사용하면 상한 검사를 잃거나
 * 무관한 계약을 얹게 돼 별도로 둔다(중복 정리는 17e-1②③과 함께 볼 문제,
 * 이 라운드 범위 밖 — team-lead 지시). */
function assertValidSeed(n: number, label: string): void {
  if (!Number.isInteger(n)) {
    // `Number.isInteger`는 `NaN`·`Infinity`·`-Infinity`·비정수 전부에 false를
    // 반환한다 — 이 한 분기가 그 넷을 모두 잡는다.
    throw new TypeError(`${label}은 정수만 받는다(NaN·Infinity 불가) — 받은 값: ${n}`)
  }
  if (n < 0) {
    throw new RangeError(`${label}은 음수를 받을 수 없다 — 받은 값: ${n}`)
  }
  if (n >= U32_RANGE) {
    throw new RangeError(`${label}은 32비트 범위(0 이상 2^32 미만)를 넘을 수 없다 — 받은 값: ${n}`)
  }
}

/**
 * state와 salt를 32비트 해시로 섞어 독립적인 자식 시드를 만든다.
 * (triple32류 정수 아발란치 해시 — 부동소수점을 쓰지 않는다.)
 */
function mixSeed(state: number, salt: number): number {
  let h = (state ^ Math.imul((salt ^ 0x9e3779b9) >>> 0, 0x85ebca6b)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h
}

export function createRng(seed: number): SeededRng {
  assertValidSeed(seed, 'createRng(seed)의 seed')
  // 카운터 기반 상태(mulberry32류) — 매 호출마다 고정 증분만큼 전진하고,
  // 출력은 그 카운터를 다시 섞어 만든다. 순수 정수 연산이라 플랫폼 간
  // 동일 결과가 보장된다.
  let state = seed >>> 0

  function nextU32(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }

  function nextFloat(): number {
    return nextU32() / U32_RANGE
  }

  function nextRange(min: number, max: number): number {
    return min + nextFloat() * (max - min)
  }

  function fork(salt: number): SeededRng {
    assertValidSeed(salt, 'fork(salt)의 salt')
    return createRng(mixSeed(state, salt))
  }

  return { nextU32, nextFloat, nextRange, fork }
}
