/**
 * RQ-22 박스 점프 — **잠정 프로덕션 배치**(원장 25a-4, `tests/unit/sim
 * -movement-boxes.test.ts` docblock 제안 좌표 그대로). `@shared/sim/walls`와
 * 동일한 성격의 스캐폴드다 — 확정 맵 레이아웃(`.glb` 저작)이 아니라
 * `stepMovement`의 지오메트리 인자(`StaticGeometry.boxes`, 원장 25a-5 이전에는 네 번째 위치 인자) 주입 계약을 실사용으로 배선하기
 * 위한 잠정 좌표다. `.glb`가 도입되면 이 파일이 내보내는
 * `PRODUCTION_BOXES`의 **출처만** 교체된다(`GameRoom.ts`가 참조하는 이름은
 * 그대로 유지될 수 있다).
 *
 * **좌표 선정 근거 — 회귀 안전 대역**: `tests/unit/sim-movement-boxes
 * .test.ts` docblock "좌표 선택" 절이 기존 벽(`PRODUCTION_WALLS`, 반경
 * 15.8~16.8m)·스폰 링(`SPAWN_POINTS`, 반경 21.9~22.6m)·탈출 지점(반경
 * ~28m)과 겹치지 않음을 좌표 전수 재계산(정적 배치 리터럴 4곳·동적 점프
 * 드리프트 2파일·비점프 스윕·스폰 15개 전부)으로 확인했다 — 기존 테스트
 * 좌표는 전부 z가 0 또는 음수인데 이 박스는 z∈[8,11](항상 양수, 0에서
 * 8m 이상)이라 무관하다.
 *
 * **2D(XZ) + 상단 높이 — 벽(`WallAABB`)과 구분되는 어휘**: "벽"(무한 높이
 * 기둥, RQ-30)과 등반 가능한 "박스"(유한 높이, RQ-22/RQ-32)를 구분하는
 * 기존 어휘를 따른다(ADR-0013 결과 절).
 */

import type { BoxAABB } from '@shared/sim/movement'

/** 이 라운드의 잠정 박스 1개 — 3m×3m, 상단 0.4m(< `MOVEMENT.JUMP_HEIGHT`=
 * 1.0m, GA-55 given). 근접면(가까운 쪽 x면) x=11. 개별로 export하는
 * 이유: 통합 테스트(`rq-22-box-jump.test.ts`)가 좌표를 리터럴로 복제하지
 * 않고 이 정본을 그대로 참조하게 하기 위해서다(ADR-0010 값 복제 금지
 * 정신 — `@shared/sim/walls`의 `WALL_EAST` 등과 동일한 선례). */
export const BOX_ALPHA: BoxAABB = { minX: 11, maxX: 14, minZ: 8, maxZ: 11, topY: 0.4 }

/** `GameRoom.stepPlayerMovement`가 `stepMovement`의 지오메트리 인자(`StaticGeometry.boxes`, 원장 25a-5 이전에는 네 번째 위치 인자)로 상시
 * 주입하는 잠정 프로덕션 박스 목록 — 위 docblock 참고. */
export const PRODUCTION_BOXES: readonly BoxAABB[] = [BOX_ALPHA]
