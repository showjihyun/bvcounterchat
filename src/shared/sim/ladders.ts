/**
 * RQ-21/RQ-32 사다리 — **프로덕션 배치**(원장 25a-7·25a-9, `tests/unit/map
 * -box-dimensions.test.ts` docblock "제안 좌표" 절 그대로). `@shared/sim
 * /walls`·`@shared/sim/boxes`와 동일한 성격의 스캐폴드다 — 확정 맵
 * 레이아웃(`.glb` 저작)이 아니라 `stepMovement`의 `StaticGeometry.ladders`
 * (원장 25a-5) 주입 계약을 실사용으로 배선하기 위한 데이터다. `.glb`가
 * 도입되면 이 파일이 내보내는 `PRODUCTION_LADDERS`의 **출처만** 교체된다
 * (`GameRoom.ts`·`prediction.ts`가 참조하는 이름은 그대로 유지될 수 있다).
 *
 * **RQ-32 전문**(`harness/specs/requirements.md:148-150`): "맵에는 사다리
 * **2개**와 박스 클러스터 3곳..." — `LADDER_BRAVO`가 두 번째 사다리다.
 * 카운트 검증은 `tests/unit/map-box-dimensions.test.ts`가 순수 데이터로
 * 확인한다.
 *
 * **좌표 선정 근거 — 회귀 안전 대역**: `LADDER_ALPHA`는 기존 근거(원장
 * 25a-7)를 그대로 유지한다. `LADDER_BRAVO`는 `LADDER_ALPHA`를 z=0
 * 기준으로 반사한 좌표(`@shared/sim/boxes`의 클러스터 BRAVO와 동일 관례)
 * — 벽·박스·스폰 링·탈출 지점과 겹치지 않음을 `map-box-dimensions
 * .test.ts`가 런타임 값 전수 확인으로 이미 검증했다(이 파일은 반복하지
 * 않는다).
 *
 * **2D(XZ) + 수직 범위 + 법선 — 벽·박스와 구분되는 어휘**: "벽"(무한 높이
 * 기둥, RQ-30)·"박스"(유한 높이, RQ-22)와 달리 "사다리"는 수직 범위
 * (`minY`/`maxY`)와 등반 방향을 정하는 면 법선(`normalX`/`normalZ`)을
 * 함께 갖는다(ADR-0013 결과 절, `@shared/sim/movement`의 `LadderVolume`
 * docblock 참고).
 */

import type { LadderVolume } from '@shared/sim/movement'

/** 폭 1m×깊이 3m, 수직 범위 0~4m. 면의 법선은 +X(`dirX=1` 입력이 상승).
 * 개별로 export하는 이유: 통합 테스트(`rq-21-ladder-vertical-movement
 * .test.ts`)가 좌표를 리터럴로 복제하지 않고 이 정본을 그대로 참조하게
 * 하기 위해서다(ADR-0010 값 복제 금지 정신 — `@shared/sim/walls`의
 * `WALL_EAST` 등과 동일한 선례). */
export const LADDER_ALPHA: LadderVolume = { minX: -14, maxX: -13, minZ: 8, maxZ: 11, minY: 0, maxY: 4, normalX: 1, normalZ: 0 }

/** RQ-32 — 두 번째 사다리. `LADDER_ALPHA`를 z=0 기준으로 반사(같은 x
 * 대역·같은 법선, z 부호만 반전). */
export const LADDER_BRAVO: LadderVolume = { minX: -14, maxX: -13, minZ: -11, maxZ: -8, minY: 0, maxY: 4, normalX: 1, normalZ: 0 }

/** `GameRoom.stepPlayerMovement`·`prediction.ts`가 `StaticGeometry.ladders`
 * (원장 25a-5)로 상시 주입하는 프로덕션 사다리 목록(RQ-32 — 2개) — 위
 * docblock 참고. */
export const PRODUCTION_LADDERS: readonly LadderVolume[] = [LADDER_ALPHA, LADDER_BRAVO]
