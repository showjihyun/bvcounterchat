import { describe, expect, it } from 'vitest'
import { createLocalFireCooldown } from '@client/input/fireControl'
import { WEAPON } from '@shared/constants'

/**
 * 22b — 로컬 발사 쿨다운(UX용, ADR-0011 test-after 라운드).
 *
 * `canFire` 자체의 경계 판정은 `tests/unit/sim-combat.test.ts`(RQ-90
 * rate-limit)가 이미 검증한다 — 여기서는 그 함수를 감싸는 **상태 전이**만
 * 본다: 발사가 허용된 경우에만 내부 시각을 갱신하는가.
 *
 * 이 쿨다운은 서버 판정을 대체하지 않는다(RQ-61) — 서버
 * `GameRoom.handleFire`가 자신의 `lastFireAtMs`로 독립 재검증한다. 여기
 * 통과가 곧 발사 성공이 아니다.
 */

const INTERVAL = WEAPON.FIRE_INTERVAL_MS

describe('22b 로컬 발사 쿨다운 — 상태 전이', () => {
  it('첫 발사는 언제든 허용된다', () => {
    const cooldown = createLocalFireCooldown()
    expect(cooldown.tryFire(0)).toBe(true)
    expect(createLocalFireCooldown().tryFire(123456)).toBe(true)
  })

  it('간격 미만의 연사는 거부된다', () => {
    const cooldown = createLocalFireCooldown()
    expect(cooldown.tryFire(1000)).toBe(true)
    expect(cooldown.tryFire(1000 + INTERVAL - 1)).toBe(false)
  })

  it('간격이 지나면 다시 허용된다 (경계 포함 — canFire 계약)', () => {
    const cooldown = createLocalFireCooldown()
    expect(cooldown.tryFire(1000)).toBe(true)
    expect(cooldown.tryFire(1000 + INTERVAL)).toBe(true)
  })

  it('거부된 시도는 내부 시각을 갱신하지 않는다 — 연타로 쿨다운이 늘어나지 않는다', () => {
    const cooldown = createLocalFireCooldown()
    expect(cooldown.tryFire(1000)).toBe(true)
    // 거부되는 연타를 마지막 순간까지 반복
    for (let t = 1010; t < 1000 + INTERVAL; t += 10) {
      expect(cooldown.tryFire(t)).toBe(false)
    }
    // 거부가 시각을 갱신했다면 이 시점은 아직 간격 미만이라 거부됐을 것이다
    expect(cooldown.tryFire(1000 + INTERVAL)).toBe(true)
  })

  it('허용된 발사만 다음 쿨다운의 기준이 된다 (연속 발사 시퀀스)', () => {
    const cooldown = createLocalFireCooldown()
    const fireTimes = [0, INTERVAL, INTERVAL * 2, INTERVAL * 3]
    for (const t of fireTimes) {
      expect(cooldown.tryFire(t)).toBe(true)
      expect(cooldown.tryFire(t + 1)).toBe(false)
    }
  })

  it('인스턴스마다 독립적인 상태를 가진다', () => {
    const first = createLocalFireCooldown()
    const second = createLocalFireCooldown()
    expect(first.tryFire(0)).toBe(true)
    expect(first.tryFire(1)).toBe(false)
    // 다른 인스턴스는 first의 발사에 영향받지 않는다
    expect(second.tryFire(1)).toBe(true)
  })
})
