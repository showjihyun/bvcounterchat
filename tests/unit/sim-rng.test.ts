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
