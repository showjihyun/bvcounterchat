/**
 * RQ-21 사다리 — **잠정 프로덕션 배치**(원장 25a-7, `tests/unit/sim-movement
 * -ladders.test.ts` docblock 제안 좌표 그대로). `@shared/sim/walls`·
 * `@shared/sim/boxes`와 동일한 성격의 스캐폴드다 — 확정 맵 레이아웃(`.glb`
 * 저작)이 아니라 `stepMovement`의 `StaticGeometry.ladders`(원장 25a-5)
 * 주입 계약을 실사용으로 배선하기 위한 잠정 좌표다. `.glb`가 도입되면 이
 * 파일이 내보내는 `PRODUCTION_LADDERS`의 **출처만** 교체된다(`GameRoom.ts`
 * ·`prediction.ts`가 참조하는 이름은 그대로 유지될 수 있다).
 *
 * **좌표 선정 근거 — 회귀 안전 대역(test-writer 사전 조사, 원장
 * `_workspace/RQ-21-ladder/01_test-writer_red.md` §6 재확인)**: 기존
 * 벽(`PRODUCTION_WALLS`, 반경 15.8~16.8m)·박스(`BOX_ALPHA`, x∈[11,14]·
 * z∈[8,11])·스폰 링(`SPAWN_POINTS`, 반경 21.9~22.6m)·탈출 지점(반경 ~28m)
 * 어느 것과도 겹치지 않는다 — `BOX_ALPHA`와 z 대역은 같지만 x 부호가
 * 반대(음수)다.
 *
 * **2D(XZ) + 수직 범위 + 법선 — 벽·박스와 구분되는 어휘**: "벽"(무한 높이
 * 기둥, RQ-30)·"박스"(유한 높이, RQ-22)와 달리 "사다리"는 수직 범위
 * (`minY`/`maxY`)와 등반 방향을 정하는 면 법선(`normalX`/`normalZ`)을
 * 함께 갖는다(ADR-0013 결과 절, `@shared/sim/movement`의 `LadderVolume`
 * docblock 참고).
 */

import type { LadderVolume } from '@shared/sim/movement'

/** 이 라운드의 잠정 사다리 1개 — 폭 1m×깊이 3m, 수직 범위 0~4m. 면의
 * 법선은 +X(`dirX=1` 입력이 상승). 개별로 export하는 이유: 통합
 * 테스트(`rq-21-ladder-vertical-movement.test.ts`)가 좌표를 리터럴로
 * 복제하지 않고 이 정본을 그대로 참조하게 하기 위해서다(ADR-0010 값
 * 복제 금지 정신 — `@shared/sim/walls`의 `WALL_EAST` 등과 동일한 선례). */
export const LADDER_ALPHA: LadderVolume = { minX: -14, maxX: -13, minZ: 8, maxZ: 11, minY: 0, maxY: 4, normalX: 1, normalZ: 0 }

/** `GameRoom.stepPlayerMovement`·`prediction.ts`가 `StaticGeometry.ladders`
 * (원장 25a-5)로 상시 주입하는 잠정 프로덕션 사다리 목록 — 위 docblock 참고. */
export const PRODUCTION_LADDERS: readonly LadderVolume[] = [LADDER_ALPHA]
