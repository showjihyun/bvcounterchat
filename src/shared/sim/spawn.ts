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
