import { matchMaker } from 'colyseus'
import type { Room } from 'colyseus.js'
import { WORLD } from '@shared/constants'

/**
 * RQ-31 Safe Zone 회귀 대응 공용 헬퍼 (`_workspace/RQ-31/03_test-writer
 * _regression.md` §방침 수정 — 팀리드 지시).
 *
 * **경위**: RQ-31 Safe Zone 배선(GA-19·GA-11, `86fddf1`) 이후 기존 20개
 * 통합 테스트 파일이 쓰던 `UP_MISS_AIM` 자기 사격 관례가 깨졌다(사수가
 * 자신의 스폰 지점=Safe Zone에 그대로 있어 GA-19가 사격 자체를 막는다).
 * 처음에는 파일마다 이 좌표 수학을 각자 복제했는데(원장 20i의 대기 헬퍼
 * 통합 논의와는 별개로, 이때는 `firedSinceSpawn` 한 줄 교체 수준이라
 * 판단했다), 실측 검증 과정에서 그 판단이 틀렸음이 드러났다 — 기존
 * 관례였던 고정 방향(+X) 실이동은 15개 스폰 지점 중 4곳에서 다른 스폰
 * 지점의 Safe Zone에 새로 들어가는 것이 스크립트로 확인됐다(간헐적
 * flaky의 소지). **검증된 수학을 20번 복제하면 20개의 틀릴 자리가
 * 생긴다** — 그래서 이 좌표 수학을 여기 한 곳에 모은다.
 *
 * **반경-방사(radial-outward) 기하 증명**(`rq-31-safe-zone.test.ts` §반경
 * -방사 기하와 동일): 원점에서 스폰 지점을 지나는 방향으로 오프셋만큼
 * 더 밀면, 자기 자신과의 거리는 정확히 늘고 다른 모든 스폰 지점과의
 * 거리는 결코 줄지 않는다(15개 스폰 지점 × 오프셋 0~20m 구간 전수
 * 확인됨). 고정 방향(+X) 실이동에는 이 성질이 없다.
 *
 * **제품 관찰(팀리드가 원장에 이월 등재, 여기서 고치지 않는다) — 서로 다른
 * 두 실측을 혼동하지 않도록 구분한다**:
 * (a) **자연 겹침**(정지 상태, 이동 전혀 없음): 반지름 22m 원 위 15개
 * 스폰 지점의 이론상 인접 간격은 `2×22×sin(π/15)`=9.15m인데 Safe Zone
 * 지름이 10m(반경 5m×2)라 9.15m<10m — 인접 스폰끼리 Safe Zone이 이미
 * 겹친다. 정수 반올림된 실제 좌표로 재확인: **인접 15쌍 중 14쌍이
 * 겹침**(거리 8.60~9.49m, 전부 <10m) — 유일한 예외는 지점 7·8(각각
 * `{x:-22,z:5}`·`{x:-22,z:-5}`)로 정확히 10.00m(접함, 겹침 아님). 즉
 * **15개 스폰 지점 전부가 적어도 한 인접 지점과 Safe Zone이 겹친다**
 * (7·8도 각자의 다른 이웃과는 겹친다) — 맵 가장자리를 따라 사실상 전
 * 구간이 연결된 고리를 이룬다.
 * (b) **탈출 안전성**(위 "경위" 절): 기존 고정 +X 실이동(오프셋
 * 5.4~6.6m)으로 자기 스폰 지점에서 밀려났을 때 **다른** 스폰 지점의
 * Safe Zone에 새로 들어가는 사례 — 15개 중 4곳에서 위반, 그 다른 지점과의
 * 최소 거리 2.60~4.69m. (a)와는 별개 실측이다 — 이동 방향의 안전성
 * 문제이지 스폰 지점끼리의 자연 겹침이 아니다.
 * 어느 쪽도 RQ-31 스펙 위반은 아니다(스펙은 겹침을 금지하지 않는다) —
 * `spawn.ts`의 좌표는 잠정값(맵 단계 RQ-30이 실제 지오메트리로 교체
 * 예정)이다.
 *
 * **`moveStates.set` + `positionHistory.delete`를 한 함수로 묶는 이유**:
 * 되감기(RQ-64)가 `positionHistory` 링버퍼에서 대상 위치를 조회하므로,
 * `positionHistory`를 비우지 않고 `moveStates`만 옮기면 되감기가 옮기기
 * **전** 낡은 위치를 계속 반환해 escape가 조용히 무의미해진다(같은
 * 결함 계열이 `rq-90-spread-seed-determinism.test.ts`의 `teleportPlayer`
 * 리뷰 blocker로 이미 한 번 나왔다 — 그 파일의 §"REV(텔레포트-되감기
 * 버퍼 충돌 수정)" 참고). 둘을 따로 호출하게 두면 반드시 누가 잊는다
 * (`tests/support/harness.ts`의 `advanceTicks`가 시계 전진과 스케줄러
 * 만료를 한 호출로 묶은 것과 같은 이유).
 *
 * **주의**: 이 모듈의 존재가 원장 20i(대기 헬퍼(`waitForCrossViewCondition`
 * 류) 44곳 생명주기 통합 여부) 결정을 예단하지 않는다 — 20i는 리스너
 * 생명주기라는 별개 관심사를 다룬다. 이 모듈은 Safe Zone 탈출 좌표 수학과
 * 그 화이트박스 적용이라는 다른 관심사를 다룬다.
 */

/** 서버 `MoveState`의 화이트박스 쓰기에 필요한 최소 형태(`GameRoom`의
 * 기존 private `moveStates` 필드 값 — `rq-90-spread-seed-determinism
 * .test.ts`의 `SpreadTestSeam.moveStates`·`rq-64-lag-compensation-bound
 * .test.ts`의 `RewindTestSeam.moveStates`와 동일 형태, 그린필드가 아니다). */
export interface MoveState {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  grounded: boolean
}

/**
 * Safe Zone 탈출에 필요한 최소 화이트박스 접근 대상 계약. `positionHistory`의
 * 배열 원소 타입은 파일마다 다르다(대부분 `unknown[]`로 읽기 전용 취급하지만
 * `rq-64-lag-compensation-bound.test.ts`처럼 `PositionSnapshot[]`으로 구체화해
 * 쓰는 파일도 있다) — 제네릭 `H`로 열어 둬, 각 파일의 커스텀 Seam 인터페이스가
 * `extends SafeZoneEscapeSeam<자신의 원소 타입>`으로 이 계약을 상속하면서도
 * 자기 필드 타입을 그대로 쓸 수 있게 한다.
 */
export interface SafeZoneEscapeSeam<H = unknown> {
  moveStates: Map<string, MoveState>
  positionHistory: Map<string, H[]>
  firedSinceSpawn: Map<string, boolean>
}

/** `matchMaker.getLocalRoomById`(`rq-18-fall-damage.test.ts`·
 * `rq-43-afk-kick.test.ts`가 이미 확립한 기법)로 테스트 프로세스 안에서
 * 실행 중인 실제 `GameRoom` 인스턴스를 얻는다. 커스텀 Seam 인터페이스가
 * 필요한 파일(예: 자체 필드를 더 갖는 파일)은 이 함수 대신 자신의
 * `getServerRoom`류 함수를 유지해도 된다 — 이 함수는 순수 Safe Zone
 * 탈출만 필요한 파일을 위한 최소 버전이다. */
export function getSafeZoneSeam<H = unknown>(room: Room): SafeZoneEscapeSeam<H> {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as SafeZoneEscapeSeam<H> | undefined
  if (!serverRoom) {
    throw new Error(`RQ-31 회귀 대응 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** 기본 탈출 오프셋 — Safe Zone 반경 + 15m 여유(0~20m 증명 구간 안).
 *
 * **결합 주의(원장 22y, 리뷰 major 5)**: 이 값은 `rq-90-spread-seed
 * -determinism.test.ts`의 `F1_SEED_SEQUENCE`(시드 12개 하드코딩 오라클
 * 열)가 성립하는 전제 중 하나다 — 그 파일이 A·B를 이 오프셋만큼 각자의
 * 스폰 지점에서 밀어낸 뒤 둘 사이 실제 거리로 `coneRadiusRad`를 계산하기
 * 때문에, 이 값을 바꾸면 그 거리가 바뀌고 시드 열의 분류 결과("정확히
 * 1개 body·나머지 miss")가 깨질 수 있다. 이 값(또는 `SPAWN_POINTS`)을
 * 바꾸는 PR은 `rq-90-spread-seed-determinism.test.ts`를 반드시 재실행해야
 * 한다. **그 파일의 전제 가드에 기대지 마라** — 가드는 body 개수만 보고,
 * **이 오프셋 축에서는** 0~200m 스윕에서 분류가 완전히 불변이라 발화 자체가
 * 0건이었다 — 콘 반경과 표적의 각 크기가 같은 `atan(bodyRadiusM / distance)`
 * 에서 나와 **비율이 항상 3으로 고정**되기 때문이다(각 크기 자체는 거리에
 * 반비례한다). **그러나 `SPAWN_POINTS` 축은 다르다** — 스폰 조합 210쌍 중
 * **68쌍(32%)에서 가드가 발화**한다(원장 22y·25f 재리뷰 실측).
 * 어느 축이든 시드 열의 검출력을 직접 재확인해야 한다
 * (`F1_SEED_SEQUENCE` 선언부 코멘트도 참고). */
export const DEFAULT_SAFE_ZONE_ESCAPE_OFFSET_M = WORLD.SAFE_ZONE_RADIUS_M + 15

/** `base`(자신의 스폰 지점 또는 현재 위치) 기준 방사 방향 단위 벡터. 이
 * 파일 안의 모든 방사 방향 계산(텔레포트든 실이동이든)이 이 함수 하나를
 * 거치게 해, "고정 +X는 15개 중 4개에서 깨진다"는 종류의 좌표 공식
 * 실수가 한 곳에서만 발생할 수 있게 한다. */
export function radialUnitVector(base: { x: number; z: number }): { ux: number; uz: number } {
  const magnitude = Math.hypot(base.x, base.z)
  if (magnitude < 1e-6) {
    throw new Error(`RQ-31 회귀 대응 전제 위반 — base(${base.x},${base.z})가 원점에 있어 방사 방향을 정의할 수 없다`)
  }
  return { ux: base.x / magnitude, uz: base.z / magnitude }
}

/** `base` 기준 방사 방향으로 `offsetM`만큼 밀어낸 좌표를 계산한다(순수
 * 함수 — 화이트박스 쓰기는 하지 않는다). 스폰 지점은 전부 평지이므로
 * y는 0으로 고정한다. */
export function computeRadialEscape(
  base: { x: number; z: number },
  offsetM: number = DEFAULT_SAFE_ZONE_ESCAPE_OFFSET_M,
): { x: number; y: number; z: number } {
  const { ux, uz } = radialUnitVector(base)
  return { x: base.x + ux * offsetM, y: 0, z: base.z + uz * offsetM }
}

/** 세션을 `base` 기준 방사 방향으로 밀어내 Safe Zone 밖으로 화이트박스
 * 텔레포트한다. `moveStates.set`과 `positionHistory.delete`를 한 호출로
 * 묶는다(모듈 docblock의 "묶는 이유" 참고). */
export function escapeSafeZone<H = unknown>(
  seam: SafeZoneEscapeSeam<H>,
  sessionId: string,
  base: { x: number; z: number },
  offsetM?: number,
): { x: number; y: number; z: number } {
  const escaped = computeRadialEscape(base, offsetM)
  seam.moveStates.set(sessionId, { x: escaped.x, y: escaped.y, z: escaped.z, vx: 0, vy: 0, vz: 0, grounded: true })
  seam.positionHistory.delete(sessionId)
  return escaped
}

/** 가장 흔한 조합 — RQ-16 스폰 보호 해제(`firedSinceSpawn`)와 Safe Zone
 * 탈출을 한 호출로 묶는다. 보통 피격자 쪽에 쓴다(사수는 자신이 맞는
 * 쪽이 아니므로 보통 `escapeSafeZone`만 필요하다). RQ-16 자체를 검증하는
 * `rq-16-spawn-protection.test.ts`는 이 함수를 쓰지 않는다 — 시간 기반
 * 보호 로직을 건드리지 않고 위치만 옮겨야 하므로 `escapeSafeZone`만
 * 쓴다(파일 상단 REV 참고). */
export function releaseSpawnProtectionAndEscape<H = unknown>(
  seam: SafeZoneEscapeSeam<H>,
  sessionId: string,
  base: { x: number; z: number },
  offsetM?: number,
): { x: number; y: number; z: number } {
  seam.firedSinceSpawn.set(sessionId, true)
  return escapeSafeZone(seam, sessionId, base, offsetM)
}
