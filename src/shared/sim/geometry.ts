/**
 * 원장 25a-5 — 정적 지오메트리 단일 값 조립. `stepMovement`(`@shared/sim
 * /movement`)의 세 번째 인자(`StaticGeometry`)로 상시 주입되는 정본을
 * 여기 한 곳에서만 조립한다 — 벽·박스·사다리 세 정본(`@shared/sim/walls`·
 * `@shared/sim/boxes`·`@shared/sim/ladders`)을 그대로 참조할 뿐 좌표를
 * 복제하지 않는다(ADR-0010).
 *
 * `GameRoom.ts`(서버 권위, RQ-61)와 `prediction.ts`(클라 예측, RQ-62)가
 * 이 값 하나를 공유 주입해야 두 시뮬레이션이 같은 지오메트리를 본다 —
 * 어느 한쪽이 이 임포트를 빠뜨리면(과거 25a-2 F3 벽 · 25a-4 박스처럼)
 * 서버·클라 발산이 재발한다. `StaticGeometry`가 세 필드를 전부 요구하는
 * 단일 객체이므로, 이 값을 통째로 주입하지 않으면(옛 방식처럼 위치
 * 인자를 하나씩 나열하면) 타입 검사 단계에서 드러난다.
 */

import type { StaticGeometry } from '@shared/sim/movement'
import { PRODUCTION_WALLS } from '@shared/sim/walls'
import { PRODUCTION_BOXES } from '@shared/sim/boxes'
import { PRODUCTION_LADDERS } from '@shared/sim/ladders'

/** `stepMovement`에 상시 주입되는 정적 지오메트리 정본 — `GameRoom
 * .stepPlayerMovement`·`prediction.ts`(`applyInput`/`reconcile`) 모두
 * 이 하나의 값을 공유 참조한다. */
export const PRODUCTION_GEOMETRY: StaticGeometry = {
  walls: PRODUCTION_WALLS,
  boxes: PRODUCTION_BOXES,
  ladders: PRODUCTION_LADDERS,
}
