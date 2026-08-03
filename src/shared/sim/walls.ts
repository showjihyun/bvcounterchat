/**
 * RQ-30 벽 충돌 — **잠정 프로덕션 배치**(원장 25a-2, ADR-0013 결정 1~3).
 *
 * ⚠️ **확정 맵 레이아웃이 아니다.** RQ-30(`harness/specs/requirements.md:107
 * -110`)의 "레이아웃은 독자 설계"는 `.glb` 저작(사람·아티스트)에서 정해진다.
 * 이 파일이 정의하는 벽 4개(`WALL_EAST/WEST/NORTH/SOUTH`)는 `stepMovement`
 * 3번째 인자(`WallAABB[]`) 주입 계약을 **실사용으로 배선**하기 위한
 * 스캐폴드다 — 다음 사람이 이 좌표를 "확정 배치"로 읽으면 안 된다. `.glb`가
 * 도입되면 이 파일이 내보내는 `PRODUCTION_WALLS`의 **출처만** 교체된다
 * (`GameRoom.ts`가 참조하는 이름은 그대로 유지될 수 있다).
 *
 * **좌표 선정 근거 — 회귀 안전 대역(팀리드 지시, 원장 25a-2)**: 기존
 * 통합·단위 테스트가 쓰는 (x,z) 좌표는 원점 부근(|x|,|z| ≤ 12, 다수 테스트
 * 사용)·스폰 링(`SPAWN_POINTS`, `@shared/sim/spawn`, 반지름 22)·탈출
 * 지점(`tests/support/safe-zone.ts` `computeRadialEscape`, 반지름 28) 세
 * 대역에 몰려 있다. 이 파일의 벽 4개는 그 사이 빈 대역 — 원점 기준 반경
 * **15.81~16.76m**(네 모서리 실측)에 둔다. 독립 재계산(coder, 원장 25a-2
 * 02_coder_green.md 첨부):
 *
 * - `SPAWN_POINTS`: `SPAWN_COUNT`=15, `SPAWN_RADIUS_M`=`WORLD.SIZE_M/2-8`=22.
 *   15개 좌표 전수 재계산 결과 반경 21.93~22.56m, 이 파일의 벽 대역(15.8~
 *   16.8) 밖. `x∈[15,16]`을 만족하는 것은 i=2 `(15,16)`·i=13 `(15,-16)`뿐인데
 *   둘 다 `z`가 ±16으로 `WALL_EAST`의 `z∈[-5,5]` 밖 — 대칭으로 나머지 세 벽도
 *   동일하게 겹치지 않는다(전수 확인).
 * - 탈출 지점(스폰 × `(22+6)/22` 배, `DEFAULT_SAFE_ZONE_ESCAPE_OFFSET_M`=
 *   `WORLD.SAFE_ZONE_RADIUS_M`(4)+2=6): 반경 28 부근으로 스케일업되어 벽
 *   대역과 더 멀어진다 — 겹침 없음(전수 확인).
 * - `rq-30-play-area-bounds.test.ts`(`START_COORD_M`=29, 세계 경계 근접
 *   테스트): 시작·이동 방향이 전부 경계 바깥쪽이거나(벽 대역을 지나지 않음)
 *   맵 중앙(0,0)에서 짧은 창(≤600ms, ≤3.9m 변위)만 관측해 벽 대역(15.8m~)에
 *   못 미친다 — "고착 금지" 케이스(29→안쪽 이동)도 정지 판정 조건(`x <
 *   atBoundary.x - 0.5`)이 이동 직후(≈83ms) 충족돼 벽 대역 도달 전에
 *   관측이 끝난다(실측 확인, 아래 §실행 근거).
 * - `rq-61-server-authoritative-position.test.ts`의 `IN_MAP_SPOOF`
 *   `{x:12.5, z:-12.5}`: 정지 입력(`dirX=dirZ=0`)과 함께 오는 참칭 좌표라
 *   실제로 이동하지 않는다(속도 0 → 위치 불변) — 벽 판정 자체가 개입할
 *   여지가 없다.
 * - 전수 grep(`tests/integration/`·`tests/unit/`): `x:`/`z:` 리터럴 15~19
 *   구간에 걸리는 것은 `rq-63-interpolation.test.ts`(x:20)·
 *   `sim-combat.test.ts`(z:20) 뿐이며 둘 다 `stepMovement`를 호출하지 않는
 *   순수 로직 테스트(보간·레이캐스트)라 이 주입과 무관하다.
 *
 * **2D(XZ) 전용 — 높이(Y) 필드 없음**: "벽"(무한 높이 기둥)과 등반 가능한
 * "박스"(RQ-32, 유한 높이)를 구분하는 기존 어휘를 따른다(ADR-0013 결과 절).
 *
 * **20k(GA-15 "벽 반대편" 문자 그대로 재현) 무관**: `sanitizeMoveInput`
 * (`@server/rooms/GameRoom.ts`)이 `'move'` payload에서 `dirX`·`dirZ`·
 * `mode`·`jump`만 뽑으므로, 이 벽이 실제로 배선돼도 클라이언트의 절대 좌표
 * 참칭이 서버에 반영되는 경로는 여전히 없다(코더 재확인, `_workspace/
 * RQ-30-walls/02_coder_green.md` §20k 참고).
 */

import type { WallAABB } from '@shared/sim/movement'

/** 동쪽 벽 — 두께 1m(x:15~16m), 폭 10m(z:-5~5m). 개별로 export하는 이유:
 * 통합 테스트(`rq-30-wall-collision-wiring.test.ts`, 평가 F1 대응)가 벽
 * 좌표를 리터럴로 복제하지 않고 이 정본을 그대로 참조하게 하기 위해서다
 * (ADR-0010 값 복제 금지 정신 — 이 값은 스펙 확정값은 아니지만, 정본이
 * 하나면 좌표를 바꿔도 테스트가 따라간다). */
export const WALL_EAST: WallAABB = { minX: 15, maxX: 16, minZ: -5, maxZ: 5 }
/** 서쪽 벽 — 두께 1m(x:-16~-15m), 폭 10m(z:-5~5m). */
export const WALL_WEST: WallAABB = { minX: -16, maxX: -15, minZ: -5, maxZ: 5 }
/** 북쪽 벽 — 폭 10m(x:-5~5m), 두께 1m(z:15~16m). */
export const WALL_NORTH: WallAABB = { minX: -5, maxX: 5, minZ: 15, maxZ: 16 }
/** 남쪽 벽 — 폭 10m(x:-5~5m), 두께 1m(z:-16~-15m). */
export const WALL_SOUTH: WallAABB = { minX: -5, maxX: 5, minZ: -16, maxZ: -15 }

/** `GameRoom.stepPlayerMovement`가 `stepMovement`의 세 번째 인자로 상시
 * 주입하는 잠정 프로덕션 벽 목록 — 위 docblock 참고. */
export const PRODUCTION_WALLS: readonly WallAABB[] = [WALL_EAST, WALL_WEST, WALL_NORTH, WALL_SOUTH]
