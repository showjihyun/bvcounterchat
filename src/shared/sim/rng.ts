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
    return createRng(mixSeed(state, salt))
  }

  return { nextU32, nextFloat, nextRange, fork }
}
