/**
 * RQ-33 고지대 플랫폼 — **프로덕션 배치**(원장 24y, 사용자 결정 + 실측
 * 검산 완료). `@shared/sim/walls`·`@shared/sim/boxes`·`@shared/sim/ladders`와
 * 동일한 성격의 스캐폴드다 — 확정 맵 레이아웃(`.glb` 저작)이 아니라
 * `stepMovement`의 지지 높이 판정(`standingHeight`/`boxesBlockingAt`,
 * `@shared/sim/movement`)이 이미 다루는 "유한 높이 지오메트리"에 태울
 * 데이터다. `BoxAABB`(minX/maxX/minZ/maxZ/topY)를 그대로 재사용한다 —
 * 플랫폼을 표현하는 데 새 타입이 필요 없다(`tests/unit/rq-33-platform
 * -geometry.test.ts` 상단 docblock "가정" 절, test-writer 제안 그대로).
 *
 * **RQ-33 전문**(`harness/specs/requirements.md`): "맵에는 사다리로만
 * 도달 가능한 고지대 플랫폼이 사다리 개수만큼 배치되어야 한다. 플랫폼
 * 윗면은 서 있을 수 있어야 하며, 그 높이는 접한 사다리의 상단과 같아야
 * 한다. 플랫폼은 점프(RQ-92 1.0m)나 박스 등반(RQ-22)으로는 도달할 수
 * 없어야 한다. 각 사다리는 플랫폼 측면에 접해야 하고, 등반이 끝나는
 * 지점에서 플랫폼 윗면으로 이동할 수 있어야 한다."
 *
 * **좌표 근거**: `@shared/sim/ladders`의 `LADDER_ALPHA`/`LADDER_BRAVO`
 * (이 라운드에서 z 폭 3m→1.5m로 좁아짐, 같은 파일 참고)의 근접면(x=−13,
 * `maxX`)에 간격 0으로 접한다(GA-61). 각 플랫폼의 z 범위(4m 폭)는 접한
 * 사다리의 z 범위(1.5m 폭)를 좌우 여백 1.25m씩 남기고 완전히 포함한다
 * (GA-63 "치우침 없음"). `topY`는 사다리 `maxY`(4m)와 정확히 같다(GA-62).
 * `PLATFORM_BRAVO`는 `PLATFORM_ALPHA`를 z=0 기준으로 반사(같은 x 대역,
 * z 부호만 반전 — `@shared/sim/boxes`·`@shared/sim/ladders`의 BRAVO
 * 클러스터/사다리와 동일 관례).
 *
 * ⚠️ **`PRODUCTION_PLATFORMS`를 `PRODUCTION_BOXES`(`@shared/sim/boxes`)에
 * 합치지 않는다** — 합치면 `tests/unit/map-box-dimensions.test.ts`의
 * GA-53("모든 박스 topY ≤ 1.0m")이 깨진다(플랫폼 topY=4m, RQ-32 점프
 * 등반 상한을 한참 넘는다 — RQ-33이 명시적으로 "점프·박스 등반으로는
 * 도달할 수 없어야 한다"고 요구하는 이유이기도 하다). 대신 `@shared/sim
 * /geometry`의 `PRODUCTION_GEOMETRY.boxes` 조립 시점에서만 `[...PRODUCTION_
 * BOXES, ...PRODUCTION_PLATFORMS]`로 합친다 — `standingHeight`/
 * `boxesBlockingAt`은 이미 임의의 `BoxAABB[]`를 받으므로 새 판정 로직
 * 없이 "점프로는 못 오르고(옆면이 벽처럼 막는다), 서면 지지된다"는 성질을
 * 그대로 얻는다(GA-60).
 */

import type { BoxAABB } from '@shared/sim/movement'

/** 서쪽 사다리(`LADDER_ALPHA`)가 접한 플랫폼. */
export const PLATFORM_ALPHA: BoxAABB = { minX: -13, maxX: -9, minZ: 7.5, maxZ: 11.5, topY: 4 }

/** 서쪽 사다리(`LADDER_BRAVO`)가 접한 플랫폼 — `PLATFORM_ALPHA`를 z=0
 * 기준으로 반사. */
export const PLATFORM_BRAVO: BoxAABB = { minX: -13, maxX: -9, minZ: -11.5, maxZ: -7.5, topY: 4 }

/** `@shared/sim/geometry`의 `PRODUCTION_GEOMETRY.boxes` 조립 시 `PRODUCTION_
 * BOXES`와 합쳐지는 프로덕션 플랫폼 목록(RQ-33 — 사다리 2개 = 플랫폼
 * 2개, GA-62) — 위 docblock 참고. */
export const PRODUCTION_PLATFORMS: readonly BoxAABB[] = [PLATFORM_ALPHA, PLATFORM_BRAVO]
