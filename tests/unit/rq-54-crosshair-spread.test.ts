import { describe, expect, it } from 'vitest'
import { crosshairGapPx, crosshairSpreadMultiplier } from '@client/hud/crosshairSpread'
import { CROSSHAIR } from '@client/config/design-tokens'
import { DEFAULT_SPREAD } from '@shared/config/combat-tuning'

/**
 * RQ-54 크로스헤어 확산(원장 24e) — `DESIGN.md` §3.1 "간격 = 기본 간격 × 콘 배율".
 *
 * **무엇을 시험하고 무엇을 안 하는가**: 렌더 결과(픽셀·DOM)는 ADR-0008 §6으로
 * 면제이고 `fe.md`의 스모크·스크린샷 수동 확인이 그 몫이다. 여기서 고정하는 것은
 * **간격을 얼마로 정하는가**라는 산술뿐이다.
 *
 * ⚠️ **기대값을 리터럴로 적지 않는다** — `DESIGN.md` §3.1 표의 4/8/16px은
 * `CROSSHAIR.gapPx`와 `DEFAULT_SPREAD` 배수에서 **유도된 결과**다. 리터럴로 적으면
 * 튜닝값이 바뀔 때 이 테스트가 "옛 값을 지키는" 방향으로 거짓 실패한다(ADR-0010).
 * 대신 **관계**를 고정한다 — 그래야 배율이 바뀌어도 명제가 살아 있다.
 */
describe('RQ-54: 크로스헤어 간격은 RQ-90 콘 배율을 따른다', () => {
  const STILL = { dirX: 0, dirZ: 0, mode: 'run' } as const
  const MOVING = { dirX: 1, dirZ: 0, mode: 'run' } as const
  const CROUCH_MOVING = { dirX: 1, dirZ: 0, mode: 'crouch' } as const

  it('정지(접지·수평 입력 없음)는 배율 1 — 기본 간격 그대로다', () => {
    expect(crosshairSpreadMultiplier(STILL, true)).toBe(1)
    expect(crosshairGapPx(STILL, true)).toBe(CROSSHAIR.gapPx)
  })

  it('이동(접지·수평 입력 있음)은 DEFAULT_SPREAD.movingMultiplier를 그대로 쓴다', () => {
    expect(crosshairSpreadMultiplier(MOVING, true)).toBeCloseTo(DEFAULT_SPREAD.movingMultiplier, 12)
    expect(crosshairGapPx(MOVING, true)).toBeCloseTo(CROSSHAIR.gapPx * DEFAULT_SPREAD.movingMultiplier, 12)
  })

  it('공중은 접지 여부만으로 airborneMultiplier가 되고 이동 입력·mode와 무관하다', () => {
    const airborneStill = crosshairSpreadMultiplier(STILL, false)
    const airborneMoving = crosshairSpreadMultiplier(MOVING, false)
    const airborneCrouch = crosshairSpreadMultiplier(CROUCH_MOVING, false)
    expect(airborneStill).toBeCloseTo(DEFAULT_SPREAD.airborneMultiplier, 12)
    expect(airborneMoving).toBe(airborneStill)
    expect(airborneCrouch).toBe(airborneStill)
  })

  it('앉은 채 이동해도 정지 tier(×1)다 — RQ-90 v1.9의 OR 조건을 그대로 물려받는다', () => {
    expect(crosshairSpreadMultiplier(CROUCH_MOVING, true)).toBe(1)
  })

  it('단조 증가 — 정지 ≤ 이동 ≤ 공중', () => {
    const still = crosshairGapPx(STILL, true)
    const moving = crosshairGapPx(MOVING, true)
    const airborne = crosshairGapPx(MOVING, false)
    expect(moving).toBeGreaterThanOrEqual(still)
    expect(airborne).toBeGreaterThanOrEqual(moving)
  })

  it('배율은 서버 판정 함수에서 유도된다 — 이 모듈이 값을 복제하지 않는다(ADR-0010)', () => {
    // 튜닝값이 바뀌어도 이 관계가 유지돼야 한다. 배수를 리터럴로 옮겨 적으면
    // 여기서만 옛 값이 살아남아 서버와 갈라진다.
    const ratio = crosshairGapPx(MOVING, true) / crosshairGapPx(STILL, true)
    expect(ratio).toBeCloseTo(DEFAULT_SPREAD.movingMultiplier, 12)
  })
})
