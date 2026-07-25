import { canFire } from '@shared/sim/combat'
import { WEAPON } from '@shared/constants'

/**
 * 로컬 발사 쿨다운(22b, UX용) — 서버 rate-limit(ADR-0005,
 * `GameRoom.handleFire`)과 **같은 판정 함수**(`@shared/sim/combat`의
 * `canFire`)와 **같은 상수**(`WEAPON.FIRE_INTERVAL_MS`)를 재사용한다
 * (ADR-0010 값·로직 복제 금지). 클릭이 너무 잦아 서버가 어차피 버릴
 * 'fire' 메시지를 클라이언트가 미리 걸러 불필요한 네트워크 전송을 줄인다
 * — **서버 판정을 대체하지 않는다**(RQ-61). 서버는 이 클라이언트 판단을
 * 신뢰하지 않고 자신의 `lastFireAtMs`로 독립적으로 재검증한다
 * (`GameRoom.handleFire`가 이미 그렇게 한다 — 이 모듈이 없어도 서버는
 * 안전하다).
 *
 * `canFire` 자체의 경계 동작(미만/이상 판정)은 이미
 * `tests/unit/sim-combat.test.ts`가 검증한다 — 이 모듈의
 * `tests/unit/22b-fire-cooldown.test.ts`는 그 함수를 감싸는 상태
 * 전이(성공 시에만 내부 시각을 갱신하는지)만 검증해 중복 커버리지를
 * 피한다.
 *
 * DOM·타이머에 의존하지 않는다 — 시각(`nowMs`)은 호출자가 조달한다.
 * `performance.now()` 호출은 배선 계층(`PlayerControls.tsx`) 한 곳에
 * 모은다.
 */
export interface LocalFireCooldown {
  /** `nowMs` 시점에 발사가 허용되면 내부 상태를 갱신하고 true, 아니면
   * 상태를 건드리지 않고 false를 반환한다. */
  tryFire(nowMs: number): boolean
}

export function createLocalFireCooldown(): LocalFireCooldown {
  let lastFireAtMs: number | undefined

  return {
    tryFire(nowMs: number): boolean {
      const allowed = canFire(lastFireAtMs, nowMs, WEAPON.FIRE_INTERVAL_MS)
      if (allowed) {
        lastFireAtMs = nowMs
      }
      return allowed
    },
  }
}
