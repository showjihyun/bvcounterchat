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
 * 서버·클라 발산이 재발한다.
 *
 * ⚠️ **타입이 막는 범위를 정확히 적는다**(PR #52 리뷰 major 1, 격리
 * tsconfig 실측 — 초안은 이보다 넓게 주장했다):
 *
 * | 누락 형태 | 타입 | 잡는 것 |
 * |---|---|---|
 * | 필드 부분 누락 `{walls, boxes}` | **TS2345** | 컴파일 |
 * | 옛 위치 인자 나열 | **TS2554** | 컴파일 |
 * | 세 번째 인자 **통째 생략** | 통과 | 통합 3건 |
 * | 잘못된 조립 `{...GEOMETRY, ladders: []}` | 통과 | 통합 1건 |
 *
 * 통째 생략이 통과하는 것은 `stepMovement`가 `EMPTY_GEOMETRY` 기본값을
 * 갖기 때문이고, 그 기본값은 기존 호출부 하위호환에 필요하다. 즉 **원장
 * 25a-5가 타입으로 닫은 것은 "재발 2회차(박스)의 부분 누락 형태"이고,
 * "1회차(벽 F3)의 통째 생략 형태"는 여전히 테스트가 닫는다** — 두 회차의
 * 결함 형태가 서로 달랐다(`50449cc^`·`1170aab^` 실측).
 */

import type { StaticGeometry } from '@shared/sim/movement'
import { PRODUCTION_WALLS } from '@shared/sim/walls'
import { PRODUCTION_BOXES } from '@shared/sim/boxes'
import { PRODUCTION_LADDERS } from '@shared/sim/ladders'
import { PRODUCTION_PLATFORMS } from '@shared/sim/platforms'

/** `stepMovement`에 상시 주입되는 정적 지오메트리 정본 — `GameRoom
 * .stepPlayerMovement`·`prediction.ts`(`applyInput`/`reconcile`) 모두
 * 이 하나의 값을 공유 참조한다.
 *
 * **REV(RQ-33) — `platforms` 필드 추가, `boxes`는 그대로 `PRODUCTION_BOXES`
 * 참조.** `PRODUCTION_PLATFORMS`(topY=4m)를 `boxes` 배열 자체에 스프레드해
 * 합치지 않는 이유 둘: ① `@shared/sim/boxes`의 `PRODUCTION_BOXES`에
 * 넣으면 `tests/unit/map-box-dimensions.test.ts`의 GA-53("모든 박스
 * topY ≤ 1.0m")이 깨진다(`@shared/sim/platforms` docblock 참고). ②
 * 여기서 `boxes: [...PRODUCTION_BOXES, ...PRODUCTION_PLATFORMS]`처럼
 * 새 배열로 합쳐도 `tests/unit/sim-movement-ladders.test.ts`의 "25a-5
 * 계약" 테스트(`expect(PRODUCTION_GEOMETRY.boxes).toBe(PRODUCTION_BOXES)`
 * — 참조 동일성)가 깨진다(`tests/` 수정 금지, ADR-0011 Red-first — 실제로
 * 시도했다가 이 회귀를 발견해 되돌렸다). 대신 `platforms`를 별도 필드로
 * 얹고, `stepMovement`(`@shared/sim/movement`)가 호출 시점에 `boxes`와
 * `platforms`를 합쳐 `standingHeight`/`boxesBlockingAt`(둘 다 임의의
 * `BoxAABB[]`를 받는 기존 함수)에 넘긴다 — "점프로는 못 오르고(옆면
 * 차단) 서면 지지된다"는 성질을 새 판정 로직 없이 얻는다(GA-60). */
export const PRODUCTION_GEOMETRY: StaticGeometry = {
  walls: PRODUCTION_WALLS,
  boxes: PRODUCTION_BOXES,
  ladders: PRODUCTION_LADDERS,
  platforms: PRODUCTION_PLATFORMS,
}
