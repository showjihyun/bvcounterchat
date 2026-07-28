import { describe, expect, it } from 'vitest'
import { applyDeath, applyKill, applyPlaytime, emptyStatsRow, type StatsRow } from '@shared/stats/statsMath'

/**
 * RQ-81 통계 절반(A계층 — 순수 산술) — ADR-0011 §1 Red-first 영역
 * (`src/shared/` 전체는 결정론 계약의 심장, 서버 판정 로직과 동일 취급).
 *
 * 전담 범위: SQLite 통계 행(킬·데스·헤드샷·플레이타임)의 **증분 산술만**을
 * 순수 함수로 고정한다 — 실제 SQLite I/O·Colyseus 룸 경계·UUID 전달 경로는
 * `tests/integration/rq-81-*.test.ts`(B계층)가 담당한다(ADR-0008 레벨 분리,
 * `sim-fall-damage.test.ts`/`sim-afk.test.ts`/`sim-rewind.test.ts` 선례와
 * 동일한 정신 — "이 산술이 실제 룸에서 재현되는가"는 B계층의 몫).
 *
 * **가정(coder에게) — 신규 모듈 계약(그린필드, test-writer 지정)**:
 *
 * ```ts
 * // src/shared/stats/statsMath.ts
 * export interface StatsRow {
 *   uuid: string
 *   kills: number
 *   deaths: number
 *   headshots: number
 *   playtimeMs: number
 * }
 * export function emptyStatsRow(uuid: string): StatsRow
 * export function applyKill(row: StatsRow, isHeadshot: boolean): StatsRow
 * export function applyDeath(row: StatsRow): StatsRow
 * export function applyPlaytime(row: StatsRow, deltaMs: number): StatsRow
 * ```
 *
 * **설계 결정 1 — "헤드샷" 통계의 정의(팀리드 위임, `_workspace/RQ-81/
 * 01_test-writer_red.md` §2.1에 근거 상술)**: RQ-81 원문은 "킬·데스·헤드샷·
 * 플레이타임"만 나열하고 "헤드샷"이 헤드샷 **킬** 수인지 헤드샷 **명중**
 * 횟수(킬 여부 무관)인지 명시하지 않는다. `requirements.md`에서 "헤드샷"이
 * 정의된 유일한 다른 자리는 RQ-55(킬피드) "헤드샷 킬은 구분 가능하게
 * 표시해야 한다"뿐이라, 이 스펙 어휘 안에서 "헤드샷"은 항상 **킬의 부분
 * 집합**으로 쓰인다(장르 관행과도 일치 — CS류 게임의 HS% 통계는 헤드샷
 * 킬/전체 킬이지 헤드샷 명중 자체를 별도로 세지 않는다). **결정**:
 * `applyKill(row, isHeadshot)`은 `isHeadshot`이 true일 때만 `headshots`도
 * 함께 올린다 — 즉 `headshots <= kills`가 항상 성립하는 부분집합 모델.
 * 아래 "GA 대응 불가" 절 참고 — 이 결정은 골든 케이스가 없어 test-writer
 * 재량으로 고정했고, 틀렸다면 이 함수의 시그니처만 바뀌면 된다.
 *
 * **설계 결정 2 — `applyPlaytime`의 방어적 산술**: `deltaMs`가 음수이거나
 * 유한하지 않으면(시계 역행·NaN — 서버 쪽 `Date.now()` 차분에서 이론상
 * 발생 가능) 0을 더한 것과 동일하게 처리한다(`sanitizeMoveInput` 등과
 * 동일한 RQ-61 방어적 파싱 정신 — 크래시·음수 누적보다 안전한 기본값).
 *
 * **순수성 계약**: 네 함수 모두 인자로 받은 `row`를 변형하지 않고 새
 * 객체를 반환한다(`appendPositionSnapshot`/`fallDamageForHeight` 등
 * 기존 `@shared/sim/*` 순수 함수 계약과 동일 — 매 호출이 새 배열/객체를
 * 반환해야 호출자가 참조 동일성에 기대지 않는다).
 */

const UUID_A = 'aaaaaaaa-1111-4111-8111-111111111111'

describe('RQ-81 통계 산술 — emptyStatsRow', () => {
  it('RQ-81: 빈 통계 행은 모든 카운터가 0이고 uuid만 채워진다', () => {
    const row = emptyStatsRow(UUID_A)
    expect(row).toEqual<StatsRow>({ uuid: UUID_A, kills: 0, deaths: 0, headshots: 0, playtimeMs: 0 })
  })
})

describe('RQ-81 통계 산술 — applyKill', () => {
  it('RQ-81: 바디킬(isHeadshot=false)은 kills만 1 오르고 headshots는 불변이다', () => {
    const before = emptyStatsRow(UUID_A)
    const after = applyKill(before, false)
    expect(after.kills).toBe(1)
    expect(after.headshots).toBe(0)
  })

  it('RQ-81 설계 결정 1: 헤드샷 킬(isHeadshot=true)은 kills·headshots가 함께 1씩 오른다(헤드샷은 킬의 부분집합)', () => {
    const before = emptyStatsRow(UUID_A)
    const after = applyKill(before, true)
    expect(after.kills).toBe(1)
    expect(after.headshots).toBe(1)
  })

  it('RQ-81: 헤드샷 킬 2회 + 바디킬 1회 후 kills=3, headshots=2 — headshots는 항상 kills 이하로 누적된다', () => {
    let row = emptyStatsRow(UUID_A)
    row = applyKill(row, true)
    row = applyKill(row, true)
    row = applyKill(row, false)
    expect(row.kills).toBe(3)
    expect(row.headshots).toBe(2)
    expect(row.headshots).toBeLessThanOrEqual(row.kills)
  })

  it('RQ-81: applyKill은 인자로 받은 row를 변형하지 않는다(순수 함수 계약)', () => {
    const before = emptyStatsRow(UUID_A)
    const snapshot = { ...before }
    applyKill(before, true)
    expect(before).toEqual(snapshot)
  })

  it('RQ-81: applyKill은 deaths·playtimeMs·uuid를 건드리지 않는다', () => {
    const before: StatsRow = { uuid: UUID_A, kills: 5, deaths: 7, headshots: 2, playtimeMs: 12_345 }
    const after = applyKill(before, false)
    expect(after.deaths).toBe(7)
    expect(after.playtimeMs).toBe(12_345)
    expect(after.uuid).toBe(UUID_A)
  })
})

describe('RQ-81 통계 산술 — applyDeath', () => {
  it('RQ-81: applyDeath는 deaths만 1 올리고 kills·headshots·playtimeMs는 불변이다', () => {
    const before: StatsRow = { uuid: UUID_A, kills: 3, deaths: 1, headshots: 1, playtimeMs: 999 }
    const after = applyDeath(before)
    expect(after.deaths).toBe(2)
    expect(after.kills).toBe(3)
    expect(after.headshots).toBe(1)
    expect(after.playtimeMs).toBe(999)
  })

  it('RQ-81: applyDeath는 인자로 받은 row를 변형하지 않는다(순수 함수 계약)', () => {
    const before = emptyStatsRow(UUID_A)
    const snapshot = { ...before }
    applyDeath(before)
    expect(before).toEqual(snapshot)
  })
})

describe('RQ-81 통계 산술 — applyPlaytime', () => {
  it('RQ-81: 양수 deltaMs는 playtimeMs에 그대로 누적된다', () => {
    const before = emptyStatsRow(UUID_A)
    const after = applyPlaytime(before, 1500)
    expect(after.playtimeMs).toBe(1500)
    const twice = applyPlaytime(after, 2500)
    expect(twice.playtimeMs).toBe(4000)
  })

  it('RQ-81 설계 결정 2: 음수 deltaMs는 무시된다(0을 더한 것과 동일 — 시계 역행 방어)', () => {
    const before: StatsRow = { uuid: UUID_A, kills: 0, deaths: 0, headshots: 0, playtimeMs: 5000 }
    const after = applyPlaytime(before, -100)
    expect(after.playtimeMs).toBe(5000)
  })

  it('RQ-81 설계 결정 2: 유한하지 않은 deltaMs(NaN·Infinity)도 무시된다', () => {
    const before: StatsRow = { uuid: UUID_A, kills: 0, deaths: 0, headshots: 0, playtimeMs: 5000 }
    expect(applyPlaytime(before, NaN).playtimeMs).toBe(5000)
    expect(applyPlaytime(before, Infinity).playtimeMs).toBe(5000)
    expect(applyPlaytime(before, -Infinity).playtimeMs).toBe(5000)
  })

  it('RQ-81: applyPlaytime은 인자로 받은 row를 변형하지 않는다(순수 함수 계약)', () => {
    const before = emptyStatsRow(UUID_A)
    const snapshot = { ...before }
    applyPlaytime(before, 1000)
    expect(before).toEqual(snapshot)
  })
})
