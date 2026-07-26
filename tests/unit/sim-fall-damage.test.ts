import { describe, expect, it } from 'vitest'
import { fallDamageForHeight } from '@shared/sim/fallDamage'
import { FALL_DAMAGE } from '@shared/constants'

/**
 * RQ-18(낙하 데미지) · RQ-92(3m 초과분 1m당 10, 즉사 임계 없음) — 순수 로직
 * 단위 테스트 (ADR-0008: 순수 함수·결정론·`src/shared` 환경 중립, ADR-0011:
 * `src/shared` 전체는 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-44·GA-45** (`harness/evals/golden/track-a-product.jsonl`,
 * `verify: tests/integration/rq-18-fall-damage.test.ts`). 골든의 `verify`가
 * 가리키는 파일은 통합 테스트지만, "낙하 높이 → 데미지" 산술 자체는 순수
 * 함수라 여기(A계층)가 정밀 산술을 먼저 고정한다 — `rq-60-fixed-tickrate
 * .test.ts`/`sim-lifecycle.test.ts`가 이미 채택한 "정밀 경계는 단위, 실
 * 서버 결합은 통합" A/B 레벨 분리와 동일한 정신이다. 통합 테스트는 이
 * 산술이 실제 `GameRoom` 틱 루프의 착지 판정에 배선돼 있는지만 블랙박스로
 * 확인한다.
 *
 * **기존 커버리지와의 관계**: `tests/unit/shared-constants.test.ts`("RQ-18/92:
 * 3m 이하 무피해, 5m 낙하는 20 데미지, 즉사 없음")가 이미 `FALL_DAMAGE` 상수
 * **값 자체**가 스펙과 일치하는지(드리프트 검출)를 그 테스트 파일 안의
 * 로컬 재구현(`damageAt` 인라인 함수)으로 확인해 두었다 — 상수는 옳다.
 * 이 파일이 새로 확인하는 것은 그 상수를 실제로 소비하는 **공유 함수
 * 자체**(`fallDamageForHeight`, 아래 계약)가 옳게 구현됐는가이다 — `GameRoom`이
 * 실제로 호출하는 것은 이 함수이지 상수 재구현이 아니므로, 상수 값 검증과
 * 함수 동작 검증은 서로 대체하지 못한다(공유 함수가 상수를 잘못 조합해도
 * `shared-constants.test.ts`는 여전히 green이다 — 그 파일은 함수를 임포트하지
 * 않는다).
 *
 * **설계 근거 — 왜 "낙하 높이(m)"를 직접 인자로 받는가(점프 물리를 거쳐
 * 시뮬레이션하지 않는가)**: `MOVEMENT.JUMP_HEIGHT`(1.0m, RQ-92)가
 * `FALL_DAMAGE.SAFE_HEIGHT_M`(3m)보다 작다 — 즉 **이번 라운드(평지 y=0,
 * 지형·박스·사다리 스코프 밖)의 실제 게임플레이에서는 어떤 점프도 낙하
 * 데미지를 유발할 수 없다**(`@shared/sim/movement`의 해석적 점프 궤적은
 * 항상 착지 높이 y=0으로 돌아오고, 최고점은 1.0m를 넘지 않는다 — 공중
 * 가속·이중 점프도 없다, RQ-92). 낙하 데미지가 실제로 유발되려면(GA-45의
 * "8m 낙하") RQ-21(사다리)·RQ-22(박스)·맵 단계의 실제 지형 고저차가
 * 필요하며, 이는 이번 RQ-18의 명시적 스코프 밖이다(원장 22e "제외" 항).
 * 따라서 "낙하 높이 → 데미지"라는 **산술 자체**는 그 높이가 어떻게
 * 결정됐는지(점프 물리·미래의 지형 낙차)와 완전히 무관한 순수 함수로
 * 분리해야 한다 — 그래야 지형이 없는 지금도 이 산술 하나만은 온전히
 * 검증할 수 있고, 맵 단계에서 실제 낙차가 생겨도 이 함수는 재작업이
 * 필요 없다(호출자만 늘어난다). `tests/integration/rq-18-fall-damage
 * .test.ts`가 "착지 시 이 함수가 실제로 호출·적용되는가"를 검증하는
 * 화이트박스 기법(설계 근거는 그 파일 상단 참고)도 이 분리 위에서만
 * 가능하다.
 *
 * **그린필드 계약(test-writer 지정, `sim-combat.test.ts`/`sim-lifecycle.test.ts`
 * 선례와 동일한 권한)**: `src/shared/sim/fallDamage.ts`는 원장에 없는 신규
 * 모듈이다. 아래 계약대로 `coder`가 구현하면 이 파일이 Green이 된다.
 *
 * ```ts
 * // src/shared/sim/fallDamage.ts (신규)
 * import { FALL_DAMAGE } from '@shared/constants'
 *
 * // RQ-18/RQ-92: 낙하 높이(m)로부터 데미지를 계산한다.
 * // - SAFE_HEIGHT_M(3m) 이하(경계 포함)는 0.
 * // - 초과분(fallHeightM - SAFE_HEIGHT_M)에 DAMAGE_PER_METER(10)를 곱한다.
 * // - 즉사 임계 없음(INSTANT_DEATH_HEIGHT_M === null, RQ-92) — 결과에 상한을
 * //   두지 않는다. HP를 0 이상으로 클램프하는 것은 호출자(`applyDamage`/
 * //   `applyDamageWithProtection`, `@shared/sim/{combat,lifecycle}`)의 책임이지
 * //   이 함수의 책임이 아니다(관심사 분리 — canFire가 "허용 여부"만 판정하고
 * //   실제 발사는 호출자가 하는 것과 동일한 패턴).
 * // - 방어적으로 유한하지 않거나(NaN·Infinity) 음수인 높이는 0으로 취급한다
 * //   (`canAct`의 "hp가 음수여도 방어적으로 false" 원칙과 동일 — 악의적이거나
 * //   손상된 값이 서버 판정에 닿아도 크래시·오버플로 대신 안전한 기본값).
 * export function fallDamageForHeight(fallHeightM: number): number
 * ```
 *
 * **GameRoom 배선 가정(coder에게, 이 파일의 범위 밖이나 통합 테스트가
 * 요구하는 계약 — 상세 근거는 `tests/integration/rq-18-fall-damage.test.ts`
 * 상단 및 `_workspace/RQ-18/01_test-writer_red.md` 참고)**: `GameRoom`은
 * 세션별 "현재 연속 공중 구간의 최고 y"를 신규 private map
 * `fallPeakY: Map<string, number>`로 추적하고, 공중→접지 전이 시점에
 * `fallDamageForHeight(peak)`을 호출해 그 결과를 `applyDamageWithProtection`
 * (스폰 보호 게이트 재사용)으로 적용한다. 사망 시 가해자가 없으므로 킬
 * 카운트는 증가시키지 않되, `diedAtTick`은 반드시 갱신해야 한다(원장
 * 22e "사망 처리 중앙화" — 현재 `handleFire` 한 곳뿐이라 낙하로 죽으면
 * 영구 시신이 되는 결함, GA-46이 이 회귀를 고정한다).
 */

describe('RQ-18/GA-44/GA-45: fallDamageForHeight(fallHeightM) — 낙하 데미지 산술', () => {
  describe('GA-44: 안전 높이(SAFE_HEIGHT_M=3m) 이하는 무피해', () => {
    it('정확히 3m(경계)이면 데미지가 0이다', () => {
      expect(fallDamageForHeight(3)).toBe(0)
    })

    it('3m 미만이면 데미지가 0이다', () => {
      expect(fallDamageForHeight(2)).toBe(0)
      expect(fallDamageForHeight(0.5)).toBe(0)
    })

    it('낙하하지 않았으면(0m) 데미지가 0이다', () => {
      expect(fallDamageForHeight(0)).toBe(0)
    })

    it('RQ-92 실측값(FALL_DAMAGE.SAFE_HEIGHT_M=3)으로도 동일하게 성립한다', () => {
      expect(FALL_DAMAGE.SAFE_HEIGHT_M).toBe(3)
      expect(fallDamageForHeight(FALL_DAMAGE.SAFE_HEIGHT_M)).toBe(0)
    })
  })

  describe('GA-45: 초과분 1m당 10 — 정확한 비례 산술', () => {
    it('8m 낙하는 정확히 50 데미지다((8-3)×10=50, GA-45 given 그대로)', () => {
      expect(fallDamageForHeight(8)).toBe(50)
    })

    it('5m 낙하는 정확히 20 데미지다(shared-constants.test.ts의 기존 확인과 동일 수치)', () => {
      expect(fallDamageForHeight(5)).toBe(20)
    })

    it('경계 바로 위(3.1m)는 정확히 1 데미지다 — 안전 높이 경계가 날카롭다', () => {
      expect(fallDamageForHeight(3.1)).toBeCloseTo(1, 10)
    })

    it('경계 바로 아래(2.9999m)는 여전히 0이다 — 경계가 반대 방향으로 새지 않는다', () => {
      expect(fallDamageForHeight(2.9999)).toBe(0)
    })

    it('RQ-92 실측 배율(DAMAGE_PER_METER=10)로도 동일하게 성립한다', () => {
      expect(FALL_DAMAGE.DAMAGE_PER_METER).toBe(10)
      expect(fallDamageForHeight(FALL_DAMAGE.SAFE_HEIGHT_M + 1)).toBe(FALL_DAMAGE.DAMAGE_PER_METER)
    })
  })

  describe('RQ-92: 즉사 임계 없음 — 아무리 높아도 상한 없이 비례한다', () => {
    it('매우 큰 높이(1000m)도 클램프·상한 없이 정확한 비례값을 반환한다((1000-3)×10=9970)', () => {
      // FALL_DAMAGE.INSTANT_DEATH_HEIGHT_M이 null이라는 것(상수 자체)은
      // shared-constants.test.ts가 이미 확인했다 — 여기서는 그 null이
      // "이 함수가 실제로 상한을 두지 않는다"는 동작으로 이어지는지를
      // 직접 확인한다(상수가 null이어도 함수 내부에서 별도 캡을 걸면
      // 이 단언만 잡아낸다).
      expect(fallDamageForHeight(1000)).toBe(9970)
    })

    it('사망에 필요한 것보다 훨씬 큰 데미지(HP 100 초과)도 그대로 반환한다 — 클램프는 호출자(applyDamage) 몫이다', () => {
      const damage = fallDamageForHeight(20) // (20-3)×10=170 > PLAYER.MAX_HP(100)
      expect(damage).toBe(170)
      expect(damage).toBeGreaterThan(100)
    })
  })

  describe('방어적 입력 처리 — 악의적이거나 손상된 높이값(RQ-61과 동일한 방어 원칙)', () => {
    it('음수 높이는 0을 반환한다(낙하하지 않은 것과 동일 취급)', () => {
      expect(fallDamageForHeight(-5)).toBe(0)
    })

    it('NaN 높이는 0을 반환한다(크래시 대신 안전한 기본값)', () => {
      expect(fallDamageForHeight(NaN)).toBe(0)
    })

    it('Infinity 높이는 0을 반환한다(비정상 값 방어 — Infinity 데미지가 새어나가지 않는다)', () => {
      expect(fallDamageForHeight(Infinity)).toBe(0)
    })
  })

  describe('결정론 — 같은 입력은 항상 같은 결과를 낸다(ADR-0008)', () => {
    it('순수 함수이므로 반복 호출해도 결과가 바뀌지 않는다', () => {
      expect(fallDamageForHeight(8)).toBe(fallDamageForHeight(8))
      expect(fallDamageForHeight(3)).toBe(fallDamageForHeight(3))
    })
  })
})
