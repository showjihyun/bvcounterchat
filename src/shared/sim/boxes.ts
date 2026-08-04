/**
 * RQ-32 클러스터 배치 — **프로덕션 박스 배열**(원장 25a-9, `tests/unit/map
 * -box-dimensions.test.ts` docblock "제안 좌표" 절 그대로). `@shared/sim
 * /walls`와 동일한 성격의 스캐폴드다 — 확정 맵 레이아웃(`.glb` 저작)이
 * 아니라 `stepMovement`의 지오메트리 인자(`StaticGeometry.boxes`) 주입
 * 계약을 실사용으로 배선하기 위한 데이터다. `.glb`가 도입되면 이 파일이
 * 내보내는 `PRODUCTION_BOXES`의 **출처만** 교체된다(`GameRoom.ts`가
 * 참조하는 이름은 그대로 유지될 수 있다).
 *
 * **RQ-32 전문**(`harness/specs/requirements.md:148-150`): "맵에는 사다리
 * 2개와 박스 클러스터 3곳(클러스터당 4~6개 박스)이 배치되어야 한다.
 * 박스 높이는 점프 높이 1.0m(RQ-92)로 등반 가능한 치수여야 한다." 아래
 * 15개(클러스터 3곳 × 5개, 하한 12·상한 18 사이)가 이 요구를 만족한다 —
 * 카운트·간격 기반 클러스터링 자체의 검증은
 * `tests/unit/map-box-dimensions.test.ts`(GA-53 포함)가 순수 데이터로
 * 확인한다(이 파일은 좌표 정본만 담고 재검증하지 않는다).
 *
 * **클러스터 3곳 구성**(좌표 근거는 위 테스트 파일 docblock의 "회귀 안전
 * 대역" 절이 벽·스폰·탈출 지점 전수 겹침을 런타임 값으로 이미 확인했다 —
 * 여기서 반복하지 않는다):
 * - **ALPHA**(x:[11,17.3], z:[8,17.6]) — 기존 `BOX_ALPHA` 포함, +4개.
 * - **BRAVO**(x:[11,17.3], z:[-17.6,-8]) — ALPHA를 z=0 기준으로 반사.
 * - **CHARLIE**(x:[-3,6.6], z:[8,14.3]) — 원점 근처 북쪽.
 * 클러스터 내부 **인접** 박스 간 간격은 0.3m(**비인접 쌍은 최대 3.6125m** —
 * “내부 간격은 항상 0.3m”이라 적으면 거짓이다), 클러스터 사이 최소 간격은 4.4m
 * (ALPHA↔CHARLIE)로 2m 문턱의 union-find 클러스터링이 정확히 3그룹으로
 * 가른다.
 *
 * **GA-53(상단 높이 ≤ `MOVEMENT.JUMP_HEIGHT`=1.0m)과 실효 상한(이산 30Hz
 * 틱 샘플링의 실제 등반 가능 상한 **0.99736660m**(참값 `0.9973665961010276` — 초안의 `0.997368`은 `V0`를 6.32456으로 반올림한 값이었다, PR #54 독립 평가 ②), 문면 결함이나 이 라운드가
 * 고치지 않는다) — 의도적으로 닿지 않는다**: 전부 0.35~0.70m 높이대이고
 * 가장 높은 값(0.7m)도 실효 상한에서 0.297m 여유가 있다(`map-box
 * -dimensions.test.ts`의 "GA-53" describe가 이 여유를 직접 확인).
 *
 * **2D(XZ) + 상단 높이 — 벽(`WallAABB`)과 구분되는 어휘**: "벽"(무한 높이
 * 기둥, RQ-30)과 등반 가능한 "박스"(유한 높이, RQ-22/RQ-32)를 구분하는
 * 기존 어휘를 따른다(ADR-0013 결과 절).
 */

import type { BoxAABB } from '@shared/sim/movement'

/** 클러스터 ALPHA(5개) — 근접면(가까운 쪽 x면) x=11. `BOX_ALPHA`를 개별로
 * export하는 이유: `rq-22-box-jump.test.ts`·`rq-62-prediction.test.ts`가
 * 좌표를 리터럴로 복제하지 않고 이 정본을 그대로 참조하기 때문이다
 * (ADR-0010 값 복제 금지 정신 — `@shared/sim/walls`의 `WALL_EAST` 등과
 * 동일한 선례). 나머지 4개는 클러스터 구성용으로만 쓰이므로 `PRODUCTION_
 * BOXES` 배열을 통해서만 참조된다. */
export const BOX_ALPHA: BoxAABB = { minX: 11, maxX: 14, minZ: 8, maxZ: 11, topY: 0.4 }
export const BOX_ALPHA_2: BoxAABB = { minX: 11, maxX: 14, minZ: 11.3, maxZ: 14.3, topY: 0.5 }
export const BOX_ALPHA_3: BoxAABB = { minX: 14.3, maxX: 17.3, minZ: 8, maxZ: 11, topY: 0.6 }
export const BOX_ALPHA_4: BoxAABB = { minX: 14.3, maxX: 17.3, minZ: 11.3, maxZ: 14.3, topY: 0.7 }
export const BOX_ALPHA_5: BoxAABB = { minX: 11, maxX: 14, minZ: 14.6, maxZ: 17.6, topY: 0.35 }

/** 클러스터 BRAVO(5개) — ALPHA를 z=0 기준으로 반사(같은 x 대역, z 부호
 * 반전). */
export const BOX_BRAVO_1: BoxAABB = { minX: 11, maxX: 14, minZ: -11, maxZ: -8, topY: 0.4 }
export const BOX_BRAVO_2: BoxAABB = { minX: 11, maxX: 14, minZ: -14.3, maxZ: -11.3, topY: 0.5 }
export const BOX_BRAVO_3: BoxAABB = { minX: 14.3, maxX: 17.3, minZ: -11, maxZ: -8, topY: 0.6 }
export const BOX_BRAVO_4: BoxAABB = { minX: 14.3, maxX: 17.3, minZ: -14.3, maxZ: -11.3, topY: 0.7 }
export const BOX_BRAVO_5: BoxAABB = { minX: 11, maxX: 14, minZ: -17.6, maxZ: -14.6, topY: 0.35 }

/** 클러스터 CHARLIE(5개) — 원점 근처 북쪽, ALPHA·BRAVO와 다른 x 대역이라
 * 두 클러스터 어느 쪽과도 붙지 않는다(간격 4.4m 이상). */
export const BOX_CHARLIE_1: BoxAABB = { minX: -3, maxX: 0, minZ: 8, maxZ: 11, topY: 0.4 }
export const BOX_CHARLIE_2: BoxAABB = { minX: 0.3, maxX: 3.3, minZ: 8, maxZ: 11, topY: 0.5 }
export const BOX_CHARLIE_3: BoxAABB = { minX: 3.6, maxX: 6.6, minZ: 8, maxZ: 11, topY: 0.6 }
export const BOX_CHARLIE_4: BoxAABB = { minX: -3, maxX: 0, minZ: 11.3, maxZ: 14.3, topY: 0.7 }
export const BOX_CHARLIE_5: BoxAABB = { minX: 0.3, maxX: 3.3, minZ: 11.3, maxZ: 14.3, topY: 0.35 }

/** `GameRoom.stepPlayerMovement`가 `stepMovement`의 지오메트리 인자
 * (`StaticGeometry.boxes`, 원장 25a-5)로 상시 주입하는 프로덕션 박스
 * 목록(RQ-32 — 클러스터 3곳 × 5개 = 15개) — 위 docblock 참고. */
export const PRODUCTION_BOXES: readonly BoxAABB[] = [
  BOX_ALPHA, BOX_ALPHA_2, BOX_ALPHA_3, BOX_ALPHA_4, BOX_ALPHA_5,
  BOX_BRAVO_1, BOX_BRAVO_2, BOX_BRAVO_3, BOX_BRAVO_4, BOX_BRAVO_5,
  BOX_CHARLIE_1, BOX_CHARLIE_2, BOX_CHARLIE_3, BOX_CHARLIE_4, BOX_CHARLIE_5,
]
