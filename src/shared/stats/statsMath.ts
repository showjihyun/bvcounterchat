/**
 * RQ-81 통계 절반 — SQLite 통계 행(킬·데스·헤드샷·플레이타임)의 증분
 * 산술을 순수 함수로 고정한다(ADR-0011 §1 Red-first 영역). 실제 SQLite
 * I/O·Colyseus 룸 경계·UUID 전달 경로는 `@server/persistence/statsDb`·
 * `GameRoom`(B계층)이 담당한다 — 이 모듈은 산술만 안다.
 *
 * 계약은 `tests/unit/rq-81-stats-math.test.ts` 상단 docblock(test-writer
 * 지정)이 정본이다.
 *
 * **설계 결정 1 — "헤드샷"은 킬의 부분집합이다**(근거는 위 테스트 파일
 * docblock 참고): `applyKill(row, isHeadshot)`은 `isHeadshot`이 true일
 * 때만 `headshots`도 함께 올린다 — `headshots <= kills`가 항상 성립한다.
 *
 * **설계 결정 2 — `applyPlaytime`의 방어적 산술**: `deltaMs`가 음수이거나
 * 유한하지 않으면(시계 역행·NaN·Infinity) 0을 더한 것과 동일하게 처리한다
 * (`sanitizeMoveInput` 등과 동일한 RQ-61 방어적 파싱 정신).
 *
 * **순수성 계약**: 네 함수 모두 인자로 받은 `row`를 변형하지 않고 새
 * 객체를 반환한다(`@shared/sim/*`의 기존 순수 함수 계약과 동일).
 */

export interface StatsRow {
  uuid: string
  kills: number
  deaths: number
  headshots: number
  playtimeMs: number
}

export function emptyStatsRow(uuid: string): StatsRow {
  return { uuid, kills: 0, deaths: 0, headshots: 0, playtimeMs: 0 }
}

export function applyKill(row: StatsRow, isHeadshot: boolean): StatsRow {
  return {
    ...row,
    kills: row.kills + 1,
    headshots: isHeadshot ? row.headshots + 1 : row.headshots,
  }
}

export function applyDeath(row: StatsRow): StatsRow {
  return { ...row, deaths: row.deaths + 1 }
}

export function applyPlaytime(row: StatsRow, deltaMs: number): StatsRow {
  const safeDelta = Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0
  return { ...row, playtimeMs: row.playtimeMs + safeDelta }
}
