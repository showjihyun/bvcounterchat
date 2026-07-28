import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '@server/index'
import { getStats, openStatsDb, type StatsDb } from '@server/persistence/statsDb'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'
import { getSafeZoneSeam, releaseSpawnProtectionAndEscape, type SafeZoneEscapeSeam } from '../support/safe-zone'

/**
 * RQ-81 통계 절반(B계층 — SQLite 영속 + 익명 UUID 키) — 서버 권위(RQ-61)
 * 통합 테스트(ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직·SQLite
 * 영속 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-22** (`harness/evals/golden/track-a-product.jsonl`,
 * `verify` 필드가 이 파일 경로를 정확히 지정한다).
 * GA-22: "given: 브라우저 로컬스토리지에 UUID-A를 가진 사용자가 닉네임
 * 'alice'로 접속해 여러 판을 플레이하며 킬·데스 통계가 쌓임 / when: 동일
 * UUID-A를 유지한 채 닉네임을 'alice2'로 바꿔 재접속 / then: 이전에 쌓인
 * 킬·데스 통계가 그대로 유지된다 — 통계는 닉네임이 아니라 UUID로
 * 키잉된다."
 *
 * **레벨 분리(ADR-0008)**: 통계 증분 산술 자체(`applyKill`/`applyDeath`가
 * 누적하는 방식)는 `tests/unit/rq-81-stats-math.test.ts`가 이미 고정했다.
 * 이 파일은 그 산술이 실제 Colyseus 룸 안에서 UUID로 정확히 키잉되어
 * SQLite 파일에 기록되고, **재접속으로도 리셋되지 않는가**를 블랙박스로
 * 확인한다.
 *
 * **관측 지점(팀리드 지시 — RQ-18/43/64 교훈 반영)**: 통계 단언은 어느
 * 클라이언트의 Colyseus 상태(`room.state`)도 읽지 않는다 — RQ-81의 진짜
 * 진실 공급원은 SQLite 파일 자체이고(ADR-0006), Colyseus `Player` 스키마의
 * `kills` 필드는 세션 단위 인메모리 값(RQ-14 스코프)이라 재접속하면 새
 * 세션·새 스키마 인스턴스로 리셋된다 — 그 필드로는 이 RQ의 "재접속해도
 * 이어진다"를 애초에 관측할 수 없다(관측 지점이 잘못되면 통과 이유가
 * 뒤바뀐다, 22e 교훈과 동일 정신). 그래서 이 파일은
 * `openStatsDb`/`getStats`로 **서버가 실제로 쓴 SQLite 파일을 테스트가
 * 직접 읽는다** — 클라이언트 시야를 전혀 경유하지 않으므로 "자기 시야로
 * 자기 소속을 읽지 마라"(RQ-43 F2 교훈)의 위험 자체가 구조적으로 없다.
 *
 * **가정(coder에게) — 신규 계약(그린필드, test-writer 지정)**:
 *
 * 1. `src/server/persistence/statsDb.ts`(신규):
 *    ```ts
 *    export interface StatsRow { uuid: string; kills: number; deaths: number; headshots: number; playtimeMs: number }
 *    export interface StatsDb { close(): void }
 *    export function openStatsDb(path: string): StatsDb
 *    export function getStats(db: StatsDb, uuid: string): StatsRow | undefined
 *    export function recordKill(db: StatsDb, uuid: string, isHeadshot: boolean): void
 *    export function recordDeath(db: StatsDb, uuid: string): void
 *    export function addPlaytimeMs(db: StatsDb, uuid: string, deltaMs: number): void
 *    ```
 *    구현 드라이버는 `node:sqlite`(Node 22.5+ 내장, 별도 의존성 불요 —
 *    `_workspace/RQ-81/01_test-writer_red.md` §2 근거)를 권고하되, 이
 *    파일은 `openStatsDb`/`getStats` 두 함수만 직접 호출하므로 드라이버
 *    선택 자체에 결합하지 않는다.
 * 2. `src/server/index.ts`의 `BuildOptions`에 `statsDbPath?: string` 추가
 *    — 미지정 시 기본 경로(운영 배포 시 ADR-0009 named volume 경로)를
 *    쓰되, 테스트는 항상 명시적으로 격리된 임시 파일 경로를 넘긴다.
 *    `gameServer.define('game', GameRoom, { statsDbPath })`로 룸 생성
 *    옵션(서버 설정값 — 클라이언트별 값 아님)에 실어 `GameRoom.onCreate
 *    (options)`가 읽게 한다(Colyseus 0.16.5 실측: `Server.define`의 3번째
 *    인자가 `matchMaker.defineRoomType`의 `defaultOptions`가 되어
 *    `onCreate`에 전달되는 옵션에 병합된다 — `node_modules/@colyseus/core/
 *    build/MatchMaker.js` `onCreate` 호출부).
 * 3. `GameRoom.onJoin`의 옵션 타입을 `{ nickname?: unknown; uuid?: unknown }`
 *    로 확장한다. `options.uuid`가 `@shared/stats/uuid`의
 *    `isValidStatsUuid`를 통과하면 세션별 신규 private map(예:
 *    `playerUuids: Map<string, string>`)에 저장한다 — 통과하지 못하면
 *    (미제공·형식 오류) 그 세션은 이번 판 동안 통계 추적 대상이 아니다
 *    (`rq-81-uuid-tamper-defense.test.ts`가 이 무해성을 별도로 고정한다,
 *    이 파일은 항상 유효한 UUID만 쓴다).
 * 4. 킬·데스 기록 시점: `registerDeath(victimId, currentTick, killerId?,
 *    isHeadshot?)` — 이 함수 안에서 `victimId`의 uuid가 있으면
 *    `recordDeath`, `killerId`의 uuid가 있으면 `recordKill(..., isHeadshot
 *    ?? false)`를 호출한다(현재 시그니처에 `isHeadshot` 인자 추가가
 *    필요하다 — ADR-0011이 허용하는 "계약 추가"). `handleFire`가
 *    `closest.result.region === 'head'`를 그 인자로 넘긴다.
 * 5. 재접속 시나리오는 **새 세션**(새 `client.sessionId`)이다(ADR-0006
 *    "재시작=새 신원" 원칙과 별개로, 같은 프로세스 안에서도 매 `joinOrCreate`
 *    는 새 세션이다) — `playerUuids` 맵은 세션별이라 재사용되지 않지만,
 *    SQLite 쪽 행은 uuid로 키잉되므로 세션이 바뀌어도 같은 행을 찾는다.
 *    이게 이 RQ의 핵심 계약이다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한. 킬 시퀀스는
 * `rq-14-death-kill-credit.test.ts`의 검증된 바디샷 4연타 패턴을 그대로
 * 재사용한다(전투 산술 자체는 이미 그 파일이 고정했다 — 이 파일은 그
 * 산술의 재현이 아니라 통계 영속만 신경 쓴다).
 *
 * **REV(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19·GA-11, `86fddf1`) 이후 사수·피격자
 * 둘 다 각자의 스폰 지점(Safe Zone 내부, 거리 0)에 그대로 있으면 킬
 * 시퀀스 자체가 성립하지 않는다. 기존 `unlockProtectionAndSettle`(자기
 * 사격 + 고정 +X 실이동)을 화이트박스 Safe Zone 탈출(`firedSinceSpawn`
 * 직접 기입 + 반경-방사 텔레포트, `rq-31-safe-zone.test.ts` §반경-방사
 * 기하)로 대체했다 — 고정 +X 실이동은 15개 스폰 지점 중 4개에서 다른
 * 스폰 지점의 Safe Zone에 새로 들어가는 것이 실측됐다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const STATE_TIMEOUT_MS = 5_000
/** RQ-31 회귀 대응 — 화이트박스 Safe Zone 탈출 텔레포트가 스키마
 * (`player.x/y/z`)에 정착할 시간(서버 틱 ≈33ms의 몇 배 여유). */
const SETTLE_MS = 200
const BETWEEN_SHOTS_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[timeout ${ms}ms] ${label}`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

interface RunningServer {
  app: FastifyInstance
  endpoint: string
  statsDbPath: string
}

/** 임시 디렉터리에 격리된 SQLite 파일 경로를 만든다 — 테스트 간 통계가
 * 섞이지 않게 매 describe 블록마다 새로 만든다. */
function createTempStatsDbPath(prefix: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { path: join(dir, 'stats.db'), dir }
}

async function startServer(statsDbPath: string): Promise<RunningServer> {
  const app = buildServer({ logger: false, statsDbPath })
  const address = await withTimeout(app.listen({ port: 0, host: '127.0.0.1' }), LISTEN_TIMEOUT_MS, 'app.listen({ port: 0 })')
  const { port } = new URL(address)
  return { app, endpoint: `ws://127.0.0.1:${port}`, statsDbPath }
}

async function stopServer(server: RunningServer): Promise<void> {
  await withTimeout(server.app.close(), CLOSE_TIMEOUT_MS, 'app.close()')
}

function newClient(server: RunningServer): Client {
  return new Client(server.endpoint)
}

async function joinGame(client: Client, options: { nickname: string; uuid: string }): Promise<Room> {
  return withTimeout(client.joinOrCreate(ROOM_NAME, options), JOIN_TIMEOUT_MS, `joinOrCreate('${ROOM_NAME}', ${JSON.stringify(options)})`)
}

async function leaveRoom(room: Room): Promise<void> {
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface PlayerFields {
  x: number
  z: number
  hp: number
}

function readPlayer(room: Room, sessionId: string): PlayerFields | undefined {
  const state = room.state as { players?: { get?: (key: string) => { x?: unknown; z?: unknown; hp?: unknown } | undefined } } | null
  const player = state?.players?.get?.(sessionId)
  if (typeof player?.x === 'number' && typeof player?.z === 'number' && typeof player?.hp === 'number') {
    return { x: player.x, z: player.z, hp: player.hp }
  }
  return undefined
}

function waitForDefinedPlayer(room: Room, sessionId: string): Promise<PlayerFields> {
  return withTimeout(
    new Promise<PlayerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    STATE_TIMEOUT_MS,
    `초기 스냅샷(x·hp 포함, sessionId=${sessionId}) 관측`,
  )
}

function waitForHpCondition(room: Room, sessionId: string, predicate: (hp: number) => boolean, label: string): Promise<PlayerFields> {
  return withTimeout(
    new Promise<PlayerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current && predicate(current.hp)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    STATE_TIMEOUT_MS,
    label,
  )
}

/**
 * fix(평가 major 6, `_workspace/RQ-81/04_evaluator_report.md` §5.6) — 세션의
 * 닉네임이 room.state에 반영될 때까지 기다린다. `joinGame()`(내부적으로
 * `client.joinOrCreate(...)`)이 resolve됐다고 해서 그 시점에 `room.state
 * .players`가 이미 채워져 있다는 보장은 없다 — colyseus.js SDK 실측
 * (`node_modules/colyseus.js/build/cjs/Client.js:150`)으로 확인한 바,
 * `joinOrCreate`는 JOIN_ROOM 핸드셰이크(직렬화기 handshake) 완료 시점에
 * resolve하고, 최초 상태 패치는 **그 뒤 별도 메시지**로 도착한다. 이전
 * 버전은 `joinGame()` 직후 `room.state`를 동기로 읽었는데, 그 시점에
 * `players` 맵에 해당 세션이 아직 없을 수 있어(패치 미도착) 잠복 레이스였다
 * (RQ-62 잠복 레이스와 같은 계열 — 원장 22e 대기 컨벤션 ② "구독 시점 거짓이
 * 시간 하한으로 보장돼야 한다"의 반대 방향 위반). 닉네임은 서버가 onJoin에서
 * 한 번 확정하면 그 세션이 살아있는 동안 바뀌지 않는 단조·안정 신호라
 * (컨벤션 ①), `waitForDefinedPlayer`와 동일한 폴링 방식으로 안전하게 기다릴
 * 수 있다.
 */
function waitForNickname(room: Room, sessionId: string): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve) => {
      const tryResolve = (): void => {
        const state = room.state as { players?: { get?: (key: string) => { nickname?: unknown } | undefined } } | null
        const nickname = state?.players?.get?.(sessionId)?.nickname
        if (typeof nickname === 'string') resolve(nickname)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    STATE_TIMEOUT_MS,
    `sessionId=${sessionId}의 닉네임이 room.state에 반영되길 대기`,
  )
}

/** RQ-31 회귀 대응 — `room`의 RQ-16 최초 입장 보호를 화이트박스로 즉시
 * 해제하고(자기 사격은 자신의 Safe Zone에 막힐 수 있다), Safe Zone 밖으로
 * 텔레포트한다(`unlockProtectionAndSettle`의 대체 — 공용 헬퍼
 * `tests/support/safe-zone.ts`에 위임하고, 이 파일의 `PlayerFields`(hp
 * 포함) 반환 형태에 맞춰 hp를 채워 넣는다). */
async function unlockProtectionAndSettle(seam: SafeZoneEscapeSeam, room: Room): Promise<PlayerFields> {
  const baseline = await waitForDefinedPlayer(room, room.sessionId)
  const escaped = { ...releaseSpawnProtectionAndEscape(seam, room.sessionId, baseline), hp: PLAYER.MAX_HP }
  await sleep(SETTLE_MS)
  return escaped
}

function aimAtBody(shooter: { x: number; z: number }, target: { x: number; z: number }): { dirX: number; dirY: number; dirZ: number } {
  const bodyCenterM = (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = bodyCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

/** 바디샷 4연타로 victim을 사망(HP<=0)시킨다 — `rq-14-death-kill-credit
 * .test.ts`의 검증된 패턴 재사용(전투 산술 자체는 그 파일이 이미 고정). */
async function killWithBodyshots(shooterRoom: Room, victimRoom: Room, shooterPos: PlayerFields, victimPos: PlayerFields): Promise<void> {
  const aim = aimAtBody(shooterPos, victimPos)
  for (let shot = 1; shot <= 4; shot += 1) {
    shooterRoom.send('fire', aim)
    const expectedHp = Math.max(0, PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * shot)
    await waitForHpCondition(victimRoom, victimRoom.sessionId, (hp) => hp === expectedHp, `${shot}번째 바디샷 후 HP=${expectedHp} 대기`)
    await sleep(BETWEEN_SHOTS_MS)
  }
}

describe('RQ-81/GA-22: 재접속(UUID 동일·닉네임 변경)에도 킬·데스 통계가 이어진다', () => {
  let server: RunningServer
  let statsDb: StatsDb
  let tempDir: string

  beforeAll(async () => {
    const temp = createTempStatsDbPath('rq-81-ga22-')
    tempDir = temp.dir
    server = await startServer(temp.path)
    statsDb = openStatsDb(temp.path)
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    statsDb.close()
    await stopServer(server)
    rmSync(tempDir, { recursive: true, force: true })
  })

  it(
    'RQ-81/GA-22: UUID-A로 킬 1·데스 1을 쌓은 뒤, 같은 UUID-A·다른 닉네임으로 재접속해 킬·데스를 각 1씩 더 쌓으면 누적 kills=2·deaths=2다',
    async () => {
      const uuidA = randomUUID()

      // === 라운드 1: 닉네임 'alice' ===
      const a1 = await joinGame(newClient(server), { nickname: 'alice', uuid: uuidA })
      const x1 = await joinGame(newClient(server), { nickname: 'victim1', uuid: randomUUID() })
      const y1 = await joinGame(newClient(server), { nickname: 'killer1', uuid: randomUUID() })

      const seam1 = getSafeZoneSeam(a1)
      const a1Pos = await unlockProtectionAndSettle(seam1, a1)
      const x1Pos = await unlockProtectionAndSettle(seam1, x1)
      const y1Pos = await unlockProtectionAndSettle(seam1, y1)
      await waitForDefinedPlayer(x1, x1.sessionId)
      await waitForDefinedPlayer(y1, y1.sessionId)

      // A가 X를 죽인다 — A의 킬 카운트가 오른다.
      await killWithBodyshots(a1, x1, a1Pos, x1Pos)
      // Y가 A를 죽인다 — A의 데스 카운트가 오른다.
      await killWithBodyshots(y1, a1, y1Pos, a1Pos)

      const afterRound1 = getStats(statsDb, uuidA)
      expect(afterRound1?.kills).toBe(1)
      expect(afterRound1?.deaths).toBe(1)

      await Promise.all([leaveRoom(a1), leaveRoom(x1), leaveRoom(y1)])

      // === 라운드 2: 같은 UUID-A, 닉네임 'alice2'로 재접속 ===
      const a2 = await joinGame(newClient(server), { nickname: 'alice2', uuid: uuidA })
      const x2 = await joinGame(newClient(server), { nickname: 'victim2', uuid: randomUUID() })
      const y2 = await joinGame(newClient(server), { nickname: 'killer2', uuid: randomUUID() })

      // 재접속이 실제로 다른 닉네임으로 확정됐는지 확인(전제 조건 — GA-22 when 절).
      // fix(평가 major 6): join 직후 동기 읽기 대신 조건 대기 — 근거는
      // 위 waitForNickname docblock 참고.
      const a2Nickname = await waitForNickname(a2, a2.sessionId)
      expect(a2Nickname).toBe('alice2')

      const seam2 = getSafeZoneSeam(a2)
      const a2Pos = await unlockProtectionAndSettle(seam2, a2)
      const x2Pos = await unlockProtectionAndSettle(seam2, x2)
      const y2Pos = await unlockProtectionAndSettle(seam2, y2)
      await waitForDefinedPlayer(x2, x2.sessionId)
      await waitForDefinedPlayer(y2, y2.sessionId)

      await killWithBodyshots(a2, x2, a2Pos, x2Pos)
      await killWithBodyshots(y2, a2, y2Pos, a2Pos)

      // 핵심 단언(GA-22 then) — 리셋됐다면 이 값은 1·1일 것이다(라운드 1과
      // 우연히 같은 수라 구분이 안 되므로, 위 afterRound1 단언이 그 구분의
      // 전제가 된다: 1·1 → 2·2는 "이어짐"만이 낼 수 있는 값이다).
      const afterRound2 = getStats(statsDb, uuidA)
      expect(afterRound2?.kills).toBe(2)
      expect(afterRound2?.deaths).toBe(2)

      await Promise.all([leaveRoom(a2), leaveRoom(x2), leaveRoom(y2)])
    },
    90_000,
  )
})
