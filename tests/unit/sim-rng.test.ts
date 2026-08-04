import { describe, expect, it, vi } from 'vitest'
import { createRng } from '@shared/sim/rng'

/**
 * 결정론 시뮬레이션 하네스 — 시드 난수 (원장 17e 계약 §2).
 *
 * RQ-90(탄퍼짐 랜덤 콘)을 결정론적으로 테스트하려면 "같은 시드 → 같은 수열"이
 * 반드시 성립해야 한다. 이 파일은 그 재현성과, 사수별·발사별 독립 스트림을
 * 뽑기 위한 `fork`의 격리 보장을 검증한다.
 */
describe('SeededRng (원장 17e §2)', () => {
  it('같은 시드는 완전히 같은 수열을 낸다 (재현성)', () => {
    const a = createRng(1234)
    const b = createRng(1234)
    const seqA = Array.from({ length: 20 }, () => a.nextU32())
    const seqB = Array.from({ length: 20 }, () => b.nextU32())
    expect(seqA).toEqual(seqB)
  })

  it('다른 시드는 다른 수열을 낸다', () => {
    const a = createRng(1)
    const b = createRng(2)
    const seqA = Array.from({ length: 10 }, () => a.nextU32())
    const seqB = Array.from({ length: 10 }, () => b.nextU32())
    expect(seqA).not.toEqual(seqB)
  })

  it('nextU32()는 항상 32비트 부호 없는 정수다', () => {
    const rng = createRng(42)
    for (let i = 0; i < 200; i++) {
      const v = rng.nextU32()
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('nextFloat()는 항상 0 이상 1 미만이다', () => {
    const rng = createRng(7)
    for (let i = 0; i < 500; i++) {
      const v = rng.nextFloat()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('nextRange(min, max)는 항상 [min, max) 범위다', () => {
    const rng = createRng(9)
    for (let i = 0; i < 500; i++) {
      const v = rng.nextRange(-5, 5)
      expect(v).toBeGreaterThanOrEqual(-5)
      expect(v).toBeLessThan(5)
    }
  })

  it('fork(salt)는 부모의 이후 수열에 영향을 주지 않는다', () => {
    const withFork = createRng(100)
    const withoutFork = createRng(100)

    // 두 스트림을 동일하게 한 번 소비한다.
    withFork.nextU32()
    withoutFork.nextU32()

    // fork() 호출 자체가 부모 스트림에서 값을 소비하면 안 된다.
    withFork.fork(1)

    const afterFork = [withFork.nextU32(), withFork.nextU32(), withFork.nextU32()]
    const neverForked = [withoutFork.nextU32(), withoutFork.nextU32(), withoutFork.nextU32()]
    expect(afterFork).toEqual(neverForked)
  })

  it('같은 시드·같은 salt의 fork는 같은 수열을 낸다', () => {
    const parentA = createRng(55)
    const parentB = createRng(55)
    const forkA = parentA.fork(9)
    const forkB = parentB.fork(9)

    const seqA = Array.from({ length: 10 }, () => forkA.nextU32())
    const seqB = Array.from({ length: 10 }, () => forkB.nextU32())
    expect(seqA).toEqual(seqB)
  })

  it('다른 salt의 fork는 서로 다른 수열을 낸다 (독립된 하위 스트림)', () => {
    const parent = createRng(55)
    const forkA = parent.fork(1)
    const forkB = parent.fork(2)

    const seqA = Array.from({ length: 10 }, () => forkA.nextU32())
    const seqB = Array.from({ length: 10 }, () => forkB.nextU32())
    expect(seqA).not.toEqual(seqB)
  })

  it('Math.random()을 호출하지 않는다', () => {
    const spy = vi.spyOn(Math, 'random')
    const rng = createRng(3)
    rng.nextU32()
    rng.nextFloat()
    rng.nextRange(0, 10)
    rng.fork(1)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

/**
 * 원장 17e-1① — `createRng(seed)`·`fork(salt)`의 `seed >>> 0` 조용한 강제
 * (PR #4 리뷰 major, reviewer 재리뷰 APPROVE에서 후속 이월 확정 — "RQ-90
 * 탄퍼짐의 fork 실호출자가 생기기 전 필수 수정"). ADR-0011: `src/shared`는
 * Red-first 영역이다 — coder의 실제 수정(rng.ts) 전에 이 Red를 먼저 심는다.
 *
 * **원 사례**: `createRng(1.5)`와 `createRng(1)`이 **완전히 같은 스트림**이다
 * — `state = seed >>> 0`(ToUint32, 소수점 이하 절삭 후 모듈러 랩어라운드)이
 * 어떤 유효성 검사도 없이 그대로 상태로 쓰인다. "시드를 계산식으로 만들 때
 * 무증상 충돌"(원장 17e-1①)이 실제 발생 형태를 실측으로 넓혀 확인했다
 * (`node -e`로 `>>> 0`을 직접 실행 — `_workspace/RQ-90-spread/
 * 01_test-writer_red.md` §21 참고):
 * ```
 * 1.5 >>> 0 = 1            (비정수 — 정수 이웃과 충돌)
 * -1 >>> 0 = 4294967295    (음수 — 큰 양수와 충돌)
 * -0.5 >>> 0 = 0           (음수+비정수 — 0과 충돌)
 * 2**32 >>> 0 = 0          (범위 밖 — 0과 충돌)
 * NaN/Infinity/-Infinity >>> 0 = 0  (숫자가 아닌 값도 조용히 "유효한 시드
 *   0"으로 둔갑 — 상류의 계산 버그(NaN 전파 등)를 완전히 숨긴다)
 * ```
 *
 * **이 라운드가 규정하지 않는 것**: 정확한 수정 방식(비정수·음수·범위 밖
 * 시드를 거부(예외)할지, 아니면 서로 다른 값으로 구분되게(더 나은 정수화)
 * 고칠지)은 이 계약이 강제하지 않는다(team-lead 지시 — "거부되거나
 * 구분되는지 고정하라"). 아래 테스트는 팀리드가 명시한 구체 사례(비정수
 * 충돌)에 한해 **"구분"** 쪽을 단언하고, 어떤 유효한 대체 해석도 없는
 * NaN·Infinity류에 한해 **"거부"**(예외)를 단언한다 — coder가 "구분" 대신
 * "거부"로 비정수/음수/범위 밖까지 통일해 고친다면 그 두 절은 그때
 * `toThrow()`로 갱신하면 된다(이 파일은 그 개정을 막지 않는다).
 *
 * **범위(①만)**: 같은 행의 ②(`createClock` 인자 무검증)·③(`RangeError`
 * 시 `errors` 유실)은 이 파일의 대상이 아니다(team-lead 명시 — 범위
 * 밖이다).
 */
describe('원장 17e-1① — createRng(seed)·fork(salt)의 seed>>>0 조용한 강제(무증상 충돌) — Red 계약(coder 구현 대상)', () => {
  it('비정수 시드가 정수 시드와 조용히 같은 스트림이 되면 안 된다 — createRng(1.5)와 createRng(1) (원 사례, reviewer 지정)', () => {
    const a = createRng(1.5)
    const b = createRng(1)
    const seqA = Array.from({ length: 5 }, () => a.nextU32())
    const seqB = Array.from({ length: 5 }, () => b.nextU32())
    // 오늘은 `1.5 >>> 0 === 1`(ToUint32 절삭)이라 완전히 같은 스트림이다
    // — 이 단언은 오늘 반드시 실패해야 정상이다(Red).
    expect(seqA).not.toEqual(seqB)
  })

  it('fork(salt)도 같은 함정이 있다 — fork(1.5)와 fork(1)이 조용히 같은 하위 스트림이 되면 안 된다(팀리드 지시)', () => {
    const parentA = createRng(777)
    const parentB = createRng(777)
    const forkA = parentA.fork(1.5)
    const forkB = parentB.fork(1)
    const seqA = Array.from({ length: 5 }, () => forkA.nextU32())
    const seqB = Array.from({ length: 5 }, () => forkB.nextU32())
    // `mixSeed`도 `salt >>> 0`를 그대로 쓰므로(`rng.ts:34`) 같은 절삭
    // 충돌이 salt 축에도 그대로 있다 — 오늘 반드시 실패해야 정상이다(Red).
    expect(seqA).not.toEqual(seqB)
  })

  it('음수 시드가 다른 정수 시드와 조용히 같은 스트림이 되면 안 된다 — createRng(-1)과 createRng(2^32-1)', () => {
    // -1 >>> 0 === 4294967295(2^32-1) — ToUint32의 모듈러 랩어라운드로
    // 부호가 다른 두 "서로 다른 의도"의 시드가 오늘은 완전히 같은 스트림이다.
    const a = createRng(-1)
    const b = createRng(4294967295)
    const seqA = Array.from({ length: 5 }, () => a.nextU32())
    const seqB = Array.from({ length: 5 }, () => b.nextU32())
    expect(seqA).not.toEqual(seqB)
  })

  it('범위를 벗어난(2^32 이상) 시드가 그 범위 안의 다른 시드와 조용히 같은 스트림이 되면 안 된다 — createRng(2^32)와 createRng(0)', () => {
    // 2**32 >>> 0 === 0 — 범위 밖 값이 정상적인 시드 0과 오늘은 완전히
    // 같은 스트림이다(가장 흔히 쓰이는 시드 중 하나와 충돌한다는 점에서
    // 특히 위험하다 — 이 세션의 다른 RQ-90 테스트 다수가 seed=0을 쓴다).
    const a = createRng(2 ** 32)
    const b = createRng(0)
    const seqA = Array.from({ length: 5 }, () => a.nextU32())
    const seqB = Array.from({ length: 5 }, () => b.nextU32())
    expect(seqA).not.toEqual(seqB)
  })

  it('NaN·Infinity·-Infinity 시드는 조용히 유효한 시드(0)로 둔갑하지 않고 거부(예외)돼야 한다', () => {
    // 오늘은 NaN>>>0===0, Infinity>>>0===0, -Infinity>>>0===0이라 셋 다
    // 조용히 "정상적인 시드 0"으로 취급된다 — 상류의 계산 버그(NaN 전파
    // 등)를 완전히 숨긴다. "구분"할 대안이 없는 값들이라 여기서는 "거부"
    // (예외)만 단언한다 — 오늘은 아무것도 던지지 않으므로 반드시
    // 실패해야 정상이다(Red).
    expect(() => createRng(NaN)).toThrow()
    expect(() => createRng(Infinity)).toThrow()
    expect(() => createRng(-Infinity)).toThrow()
  })
})
