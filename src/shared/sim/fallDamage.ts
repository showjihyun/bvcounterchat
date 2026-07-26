/**
 * RQ-18(낙하 데미지) · RQ-92(3m 초과분 1m당 10, 즉사 임계 없음) — 순수 로직
 * (ADR-0008: 순수 함수, 결정론, `src/shared` 환경 중립).
 *
 * 그린필드 계약은 `tests/unit/sim-fall-damage.test.ts` 상단 docblock
 * (test-writer 지정, `combat.ts`/`lifecycle.ts` 선례와 동일한 권한)이
 * 정본이다 — 이 파일은 그 계약을 그대로 구현한다.
 *
 * "낙하 높이(m)"를 직접 인자로 받고 점프 물리를 거쳐 유도하지 않는 이유는
 * `_workspace/RQ-18/01_test-writer_red.md` §1을 참고 — 이 산술은 그 높이가
 * 어떻게 결정됐는지(점프 궤적의 최고점이든, 지형 낙차든)와 완전히 무관하다.
 */

import { FALL_DAMAGE } from '@shared/constants'

/**
 * 낙하 높이(m)로부터 데미지를 계산한다.
 * - `SAFE_HEIGHT_M`(3m) 이하(경계 포함)는 0.
 * - 초과분(`fallHeightM - SAFE_HEIGHT_M`)에 `DAMAGE_PER_METER`(10)를 곱한다.
 * - 즉사 임계 없음(`INSTANT_DEATH_HEIGHT_M === null`, RQ-92) — 결과에 상한을
 *   두지 않는다. ⚠️ 이 함수는 그 상수를 **읽지 않는다** — 밸런싱에서
 *   `INSTANT_DEATH_HEIGHT_M`을 null이 아닌 값으로 바꾸면 **이 함수를 함께
 *   고쳐야 한다**. 상수만 바꾸면 조용히 무시된다(리뷰 minor 7). 지금은
 *   `tests/unit/shared-constants.test.ts`의 `toBeNull()` 단언이 그 변경을
 *   먼저 깨뜨려 사람이 이 지점을 보게 하는 것이 유일한 방어다. HP를 0 이상으로 클램프하는 것은 호출자(`applyDamage`/
 *   `applyDamageWithProtection`, `@shared/sim/{combat,lifecycle}`)의 책임이지
 *   이 함수의 책임이 아니다(관심사 분리 — `canFire`가 "허용 여부"만
 *   판정하고 실제 발사는 호출자가 하는 것과 동일한 패턴).
 * - 방어적으로 유한하지 않거나(NaN·Infinity) 음수인 높이는 0으로 취급한다
 *   (`canAct`의 "hp가 음수여도 방어적으로 false" 원칙과 동일 — 악의적이거나
 *   손상된 값이 서버 판정에 닿아도 크래시·오버플로 대신 안전한 기본값).
 */
export function fallDamageForHeight(fallHeightM: number): number {
  if (!Number.isFinite(fallHeightM) || fallHeightM <= FALL_DAMAGE.SAFE_HEIGHT_M) return 0
  return (fallHeightM - FALL_DAMAGE.SAFE_HEIGHT_M) * FALL_DAMAGE.DAMAGE_PER_METER
}
