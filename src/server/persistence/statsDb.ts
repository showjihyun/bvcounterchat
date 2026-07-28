import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyDeath, applyKill, applyPlaytime, emptyStatsRow, type StatsRow } from '@shared/stats/statsMath'

export type { StatsRow }

/**
 * RQ-81 — SQLite 통계 영속(ADR-0006 결정 3). 드라이버로 `node:sqlite`
 * (Node 22.5+ 내장 `DatabaseSync`)를 쓴다 — 신규 npm 의존성 0건
 * (`_workspace/RQ-81/01_test-writer_red.md` §2 근거: `better-sqlite3` 같은
 * 네이티브 애드온은 이 저장소가 최근(원장 17k) 네이티브/런타임 계층 문제로
 * 비용을 치른 직후라 회피 가능한 리스크를 새로 들이지 않는다).
 *
 * 드라이버 호출은 이 파일 하나에 캡슐화한다(`openStatsDb`/`getStats`/
 * `recordKill`/`recordDeath`/`addPlaytimeMs` 다섯 함수만 노출) — `node:sqlite`가
 * 아직 Node "Experimental" 등급이라 향후 시그니처가 바뀌어도 이 파일
 * 안에서만 흡수된다.
 *
 * 증분 산술 자체(헤드샷은 킬의 부분집합·플레이타임 방어적 클램프 등)는
 * `@shared/stats/statsMath`의 순수 함수를 그대로 재사용한다(ADR-0010 값·
 * 로직 복제 금지) — 이 파일은 그 산술 결과를 읽고 쓰는 I/O만 담당한다.
 *
 * `src/server/`(Node 전용)에 두는 이유: `src/shared`는 ADR-0010이 `node:*`
 * 임포트를 lint로 금지한다 — `node:sqlite`도 그 패턴에 걸린다.
 */

export interface StatsDb {
  close(): void
}

/** `StatsDb`가 공개하는 건 `close()`뿐이지만, 이 파일 내부 함수들은 실제
 * 드라이버 핸들에 접근해야 한다 — 반환 객체에 비공개 필드로 실어두고
 * `asHandle`로만 꺼낸다(호출자는 `StatsDb`의 좁은 계약만 본다). */
interface StatsDbInternal extends StatsDb {
  readonly handle: DatabaseSync
}

function asHandle(db: StatsDb): DatabaseSync {
  return (db as StatsDbInternal).handle
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS stats (
    uuid TEXT PRIMARY KEY,
    kills INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,
    headshots INTEGER NOT NULL DEFAULT 0,
    playtimeMs INTEGER NOT NULL DEFAULT 0
  )
`

const SELECT_SQL = 'SELECT uuid, kills, deaths, headshots, playtimeMs FROM stats WHERE uuid = ?'

const UPSERT_SQL = `
  INSERT INTO stats (uuid, kills, deaths, headshots, playtimeMs)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(uuid) DO UPDATE SET
    kills = excluded.kills,
    deaths = excluded.deaths,
    headshots = excluded.headshots,
    playtimeMs = excluded.playtimeMs
`

/** RQ-93: 리셋 로직을 두지 않는다 — 테이블은 서버 가동 이후 누적만 한다.
 *
 * `path`가 `:memory:`가 아니면(ADR-0008 §5가 허용하는 통합 테스트 대체값)
 * 부모 디렉터리를 먼저 만든다 — 운영 기본 경로(`data/stats.db`,
 * `src/server/index.ts`)는 최초 배포 시 그 디렉터리가 없을 수 있고,
 * `node:sqlite`는 존재하지 않는 디렉터리 안에 파일을 만들지 못한다.
 * `mkdirSync(..., { recursive: true })`는 이미 존재하는 디렉터리에도
 * 안전한 no-op이라(표준 동작) 테스트가 쓰는 `mkdtempSync` 결과 경로에도
 * 부작용이 없다. */
export function openStatsDb(path: string): StatsDb {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const handle = new DatabaseSync(path)
  handle.exec(CREATE_TABLE_SQL)
  const db: StatsDbInternal = {
    handle,
    close(): void {
      handle.close()
    },
  }
  return db
}

function selectRaw(handle: DatabaseSync, uuid: string): Record<string, unknown> | undefined {
  return handle.prepare(SELECT_SQL).get(uuid) as Record<string, unknown> | undefined
}

function rowFromRaw(raw: Record<string, unknown>): StatsRow {
  return {
    uuid: String(raw['uuid']),
    kills: Number(raw['kills']),
    deaths: Number(raw['deaths']),
    headshots: Number(raw['headshots']),
    playtimeMs: Number(raw['playtimeMs']),
  }
}

/** 킬·데스·플레이타임 기록 3함수의 공통 읽기 단계 — 행이 없으면(첫 이벤트)
 * `emptyStatsRow`로 시작해 `@shared/stats/statsMath` 함수에 그대로 넘긴다.
 * `getStats`(공개 조회 API)와는 반환 계약이 다르다 — 저기는 "행 없음"을
 * `undefined`로 구분해야 하므로 이 함수를 쓰지 않는다. */
function readRowOrEmpty(handle: DatabaseSync, uuid: string): StatsRow {
  const raw = selectRaw(handle, uuid)
  return raw ? rowFromRaw(raw) : emptyStatsRow(uuid)
}

function writeRow(handle: DatabaseSync, row: StatsRow): void {
  handle.prepare(UPSERT_SQL).run(row.uuid, row.kills, row.deaths, row.headshots, row.playtimeMs)
}

/** 행이 아직 없으면(그 UUID로 한 번도 이벤트가 적재되지 않음) `undefined` —
 * 통계 기능이 없어 항상 0을 반환하는 결함과 "정말 아직 안 쌓였다"를
 * 호출자가 구분할 수 있게 한다(`rq-81-uuid-stat-isolation.test.ts` 계약). */
export function getStats(db: StatsDb, uuid: string): StatsRow | undefined {
  const raw = selectRaw(asHandle(db), uuid)
  return raw ? rowFromRaw(raw) : undefined
}

export function recordKill(db: StatsDb, uuid: string, isHeadshot: boolean): void {
  const handle = asHandle(db)
  writeRow(handle, applyKill(readRowOrEmpty(handle, uuid), isHeadshot))
}

export function recordDeath(db: StatsDb, uuid: string): void {
  const handle = asHandle(db)
  writeRow(handle, applyDeath(readRowOrEmpty(handle, uuid)))
}

export function addPlaytimeMs(db: StatsDb, uuid: string, deltaMs: number): void {
  const handle = asHandle(db)
  writeRow(handle, applyPlaytime(readRowOrEmpty(handle, uuid), deltaMs))
}
