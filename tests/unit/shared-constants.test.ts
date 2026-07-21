import { describe, expect, it } from 'vitest'
import {
  CAPACITY,
  FALL_DAMAGE,
  MOVEMENT,
  NET,
  PLAYER,
  WEAPON,
  WORLD,
} from '@shared/constants'

/**
 * 스펙 확정값이 코드에 정확히 옮겨졌는지 검증한다 (RQ-90, RQ-92, RQ-03 등).
 *
 * 이 테스트의 목적은 "상수가 상수인지" 확인하는 게 아니라 **드리프트 검출**이다.
 * 누군가 밸런싱한다며 값을 바꾸면 여기서 깨지고, 그때 스펙 개정이 먼저라는
 * 사실을 상기시킨다 (CLAUDE.md: 스펙 변경은 코드와 같은 PR).
 * 값을 바꾸려면 `harness/specs/requirements.md`를 먼저 고쳐야 한다.
 */
describe('공유 상수 — 스펙 확정값 (RQ-03/60/64/90/92)', () => {
  it('RQ-60: 서버 틱은 30Hz 고정이고 틱 예산은 33.3ms다', () => {
    expect(NET.TICK_HZ).toBe(30)
    expect(NET.TICK_MS).toBeCloseTo(33.33, 1)
  })

  it('RQ-64: 되감기 상한 200ms는 RTT 보장치 150ms보다 커야 한다', () => {
    expect(NET.REWIND_CAP_MS).toBe(200)
    expect(NET.RTT_BUDGET_MS).toBe(150)
    // 되감기 상한이 보장 RTT보다 작으면 보장 구간의 사수조차 절단된다.
    expect(NET.REWIND_CAP_MS).toBeGreaterThan(NET.RTT_BUDGET_MS)
  })

  it('RQ-03: 정원은 플레이어 10 + 관전자 10 = 총 20 연결이다', () => {
    expect(CAPACITY.PLAYERS).toBe(10)
    expect(CAPACITY.SPECTATORS).toBe(10)
    expect(CAPACITY.PLAYERS + CAPACITY.SPECTATORS).toBe(20)
  })

  it('RQ-90/13/14: 바디 4타·헤드 2타로 킬이 나야 한다', () => {
    expect(WEAPON.DAMAGE_BODY).toBe(25)
    expect(WEAPON.HEADSHOT_MULTIPLIER).toBe(2)

    const headshot = WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER
    expect(headshot).toBe(50)

    // TTK 관계가 스펙(질문 1 답변)과 일치하는지 — 나눗셈이 아니라
    // 올림으로 확인한다. 4타·2타가 곧 이 게임의 교전 리듬이다.
    expect(Math.ceil(PLAYER.MAX_HP / WEAPON.DAMAGE_BODY)).toBe(4)
    expect(Math.ceil(PLAYER.MAX_HP / headshot)).toBe(2)
  })

  it('RQ-90: 400 RPM은 사격 간격 150ms다', () => {
    expect(WEAPON.RPM).toBe(400)
    expect(WEAPON.FIRE_INTERVAL_MS).toBe(150)
  })

  it('RQ-10/11: 탄창 10발, 재장전 2초', () => {
    expect(WEAPON.MAGAZINE).toBe(10)
    expect(WEAPON.RELOAD_MS).toBe(2000)
  })

  it('RQ-92: 이동 6m/s, 앉기 50%, 천천히 걷기 70%', () => {
    expect(MOVEMENT.SPEED).toBe(6)
    expect(MOVEMENT.SPEED * MOVEMENT.CROUCH_MULTIPLIER).toBe(3)
    expect(MOVEMENT.SPEED * MOVEMENT.WALK_MULTIPLIER).toBeCloseTo(4.2, 5)
    // 앉기가 천천히 걷기보다 느려야 한다 — 뒤집히면 조용히 이상해진다.
    expect(MOVEMENT.CROUCH_MULTIPLIER).toBeLessThan(MOVEMENT.WALK_MULTIPLIER)
  })

  it('RQ-92: 공중 가속은 허용하지 않는다 (에어 스트레이프·버니합 없음)', () => {
    // 이 값이 true가 되면 클라이언트 예측(RQ-62)의 전제가 무너진다.
    // 바꾸려면 ADR-0003/0004 재검토가 먼저다.
    expect(MOVEMENT.AIR_CONTROL).toBe(false)
  })

  it('RQ-18/92: 3m 이하 무피해, 5m 낙하는 20 데미지, 즉사 없음', () => {
    const damageAt = (height: number) =>
      Math.max(0, (height - FALL_DAMAGE.SAFE_HEIGHT_M) * FALL_DAMAGE.DAMAGE_PER_METER)

    expect(damageAt(3)).toBe(0)
    expect(damageAt(2)).toBe(0)
    expect(damageAt(5)).toBe(20)
    expect(FALL_DAMAGE.INSTANT_DEATH_HEIGHT_M).toBeNull()
  })

  it('RQ-30/31: 60×60m 맵, Safe Zone 반경 5m, 내부 사격 불가', () => {
    expect(WORLD.SIZE_M).toBe(60)
    expect(WORLD.SAFE_ZONE_RADIUS_M).toBe(5)
    expect(WORLD.SAFE_ZONE_ALLOWS_FIRING).toBe(false)
  })

  it('RQ-15/16/43: 리스폰 3초, 스폰 보호 3초, AFK 5분', () => {
    expect(PLAYER.RESPAWN_MS).toBe(3000)
    expect(PLAYER.SPAWN_PROTECTION_MS).toBe(3000)
    expect(PLAYER.AFK_TIMEOUT_MS).toBe(300_000)
  })
})
