/**
 * RQ-31(스폰 지점 **선택 규칙**만 이번 라운드 범위) — 순수 로직 (ADR-0008:
 * 순수 함수, 결정론, `src/shared` 환경 중립).
 *
 * 그린필드 계약은 `tests/unit/sim-spawn.test.ts` 상단 docblock(test-writer
 * 지정)이 정본이다 — 이 파일은 그 계약을 그대로 구현한다.
 *
 * **좌표는 잠정값이다**: Safe Zone(RQ-31, 반경 5m)·실제 맵 좌표는 이번
 * 라운드 범위 밖이다. 60×60m `WORLD` 위에 절차적으로(원형 등간격) 배치한
 * 값일 뿐 — 맵 단계(8)가 실제 지오메트리 기반 좌표로 교체한다. 이 모듈이
 * 보장하는 것은 개수(14~16)·평지(y=0)·월드 경계 안·서로 다른 좌표라는
 * 구조적 불변식뿐이다.
 */

import { WORLD } from '@shared/constants'

export interface SpawnPoint {
  x: number
  y: number
  z: number
}

/** RQ-31 "14~16개"의 중간값. */
const SPAWN_COUNT = 15
/** 월드 경계(±30m)에서 8m 여유를 둔 원형 배치 반지름 — 벽 근접 스폰을
 * 피하는 잠정값(정확한 근거는 맵 단계가 실제 지오메트리로 대체한다). */
const SPAWN_RADIUS_M = WORLD.SIZE_M / 2 - 8

/**
 * `count`개를 반지름 `radiusM`의 원 위에 등간격으로 배치한다 — 서로 다른
 * 각도는 서로 다른 좌표를 보장하고(정수 반올림 후에도 15개 전부 서로 다름,
 * 실측 확인), 전부 평지(y=0)다.
 *
 * **정수로 반올림하는 이유(중요)**: `Player` 스키마의 `@type('number')`
 * 필드는 `@colyseus/schema`에서 float32로 인코딩된다(실측:
 * `node -e`로 8.95를 인코딩→디코딩하면 8.949999809265137로 손실된다) —
 * 임의 소수(예: 소수점 2자리)는 와이어를 왕복하며 원래 `SPAWN_POINTS`
 * 배열(클라·테스트가 직접 임포트하는 float64 값)과 더 이상 정확히
 * 일치하지 않는다. 정수는 float32로 정확히 표현되는 범위(2^24 이내) 안이라
 * 왕복 손실이 없다 — `SPAWN_POINTS.some(p => p.x === received.x && ...)`
 * 같은 멤버십 비교(RQ-15 GA-09, 사전조건 테스트)가 정확히 성립하려면
 * 이 정밀도가 필요하다.
 */
function buildSpawnPoints(count: number, radiusM: number): SpawnPoint[] {
  const points: SpawnPoint[] = []
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / count
    points.push({
      x: Math.round(radiusM * Math.cos(angle)),
      y: 0,
      z: Math.round(radiusM * Math.sin(angle)),
    })
  }
  return points
}

export const SPAWN_POINTS: readonly SpawnPoint[] = buildSpawnPoints(SPAWN_COUNT, SPAWN_RADIUS_M)

/**
 * 직전에 사용된 인덱스를 회피하는 순환 로테이션(RQ-31 "순환 로테이션",
 * ADR-0008 결정론 — `Math.random()` 금지). `previousIndex`가 없으면(로테이션
 * 이력 없음 — 서버 기동 직후) 0을 반환한다. 그 외에는 `(previousIndex + 1)
 * % total` — 단순 라운드로빈. 호출자는 항상 `SPAWN_POINTS.length`를
 * `total`로 넘긴다는 전제라 `total`의 유효성은 검사하지 않는다.
 */
export function nextSpawnIndex(previousIndex: number | undefined, total: number): number {
  if (previousIndex === undefined) return 0
  return (previousIndex + 1) % total
}

/**
 * RQ-31 Safe Zone — 좌표가 스폰 지점 중 **하나라도**의 반경 안에 있는지
 * 판정하는 순수 함수(ADR-0008: 환경 중립, 결정론 — `Math.random()`·
 * `Date.now()` 없음).
 *
 * **"스폰 지점" 해석(팀리드 지시, `_workspace/RQ-31/01_test-writer_red.md`
 * §3.5)**: RQ-31 원문은 "자신의 마지막 스폰 지점"인지 "맵의 모든 스폰 지점
 * 각각"인지 명시하지 않는다. 이 구현은 후자(맵 전체 `SPAWN_POINTS` 각각을
 * 독립된 Safe Zone으로 본다)를 택했다 — 전자를 택하면 세션별로 "마지막
 * 배정 스폰 지점"을 별도 상태로 추적해야 하는데(현재 그런 상태가 없다),
 * 후자는 이 순수 함수 하나로 충분하다. Red 보고서 §3.3(반경-방사 기하
 * 증명)이 두 해석 모두에서 테스트가 성립함을 이미 증명했으므로 이 선택이
 * 테스트를 좌우하지 않는다.
 *
 * **수평(XZ) 거리만 본다**: `SPAWN_POINTS`는 전부 평지(y=0)이고, Safe
 * Zone은 스폰 지점을 축으로 한 원통형 구역이라는 통상적 FPS 관례를
 * 따른다 — 점프로 y가 살짝 뜬 것만으로 보호가 깜빡여서는 안 된다.
 *
 * **경계값**: "반경 안"은 `<=`(경계 포함)로 판정한다 — RQ-31 원문
 * "반경을 벗어나면 즉시 해제"는 반경보다 **커진** 순간의 해제를 규정할 뿐,
 * 반경과 정확히 같은 지점의 소속을 규정하지 않는다. 경계 자체(정확히
 * 5.000...m)는 골든 케이스가 시험하지 않는 지점이라(GA-11/GA-19 둘 다
 * ±0.5m 오프셋만 관측) 이 선택이 결과를 좌우하지 않는다.
 */
export function isWithinSafeZone(
  position: { x: number; z: number },
  spawnPoints: readonly SpawnPoint[] = SPAWN_POINTS,
  radiusM: number = WORLD.SAFE_ZONE_RADIUS_M,
): boolean {
  for (const point of spawnPoints) {
    const dx = position.x - point.x
    const dz = position.z - point.z
    if (Math.hypot(dx, dz) <= radiusM) return true
  }
  return false
}
