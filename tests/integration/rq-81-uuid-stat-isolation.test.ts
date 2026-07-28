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

/**
 * RQ-81 통계 절반(B계층 — SQLite 영속 + 익명 UUID 키) — 서버 권위(RQ-61)
 * 통합 테스트(ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직·SQLite
 * 영속 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-23** (`harness/evals/golden/track-a-product.jsonl`,
 * `verify` 필드가 이 파일 경로를 정확히 지정한다).
 * GA-23: "given: UUID-A를 가진 사용자가 닉네임 'bob'으로 통계를 쌓은 뒤
 * 접속을 종료 / when: UUID-B를 가진 다른 사용자가 동일한 닉네임 'bob'으로
 * 접속 / then: UUID-B는 UUID-A의 통계를 물려받지 않고 0에서 시작하는
 * 별개의 통계 행으로 취급된다 — 동일 닉네임이라도 UUID가 다르면 별개
 * 인격이다."
 *
 * **GA-22와의 관계**: GA-22가 "UUID 고정·닉네임 변경 → 이어짐"을 고정한다면,
 * 이 파일은 그 반대 방향("닉네임 고정·UUID 변경 → 별개")을 고정한다 —
 * 두 방향이 함께 있어야 "통계 키는 닉네임이 아니라 UUID"라는 명제가
 * 완전히 증명된다(한쪽만으로는 "닉네임도 같이 쓰일 수 있다"는 가능성을
 * 배제하지 못한다).
 *
 * **관측 지점**: GA-22 파일과 동일 — 어느 클라이언트의 `room.state`도
 * 읽지 않고 `openStatsDb`/`getStats`로 서버가 실제로 쓴 SQLite 파일을
 * 직접 읽는다(근거 전문은 `rq-81-uuid-stat-persistence.test.ts` 상단
 * docblock "관측 지점" 절 참고).
 *
 * **가정(coder에게)**: `rq-81-uuid-stat-persistence.test.ts`(GA-22)의
 * "가정" 절 1~5와 완전히 동일 — `statsDb.ts`·`BuildOptions.statsDbPath`·
 * `onJoin` uuid 옵션·`registerDeath` 확장 계약을 그대로 재사용한다.
 *
 * **양성 대조군(공허화 방지, `rq-18-fall-damage.test.ts`/`rq-43-afk-kick
 * .test.ts` "양성 대조군" 절과 동일 정신)**: "UUID-B의 행이 0에서
 * 시작한다"는 단언만으로는 통계 기능이 통째로 없어도(모든 조회가 항상
 * `undefined`/0을 반환) 우연히 통과한다 — 그래서 이 파일은 UUID-A의 행이
 * **실제로 0이 아닌 값**을 갖는 것부터 먼저 확인한 뒤에만 UUID-B의 격리를
 * 단언한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const STATE_TIMEOUT_MS = 5_000
const TRAVEL_MS = 900
const SETTLE_MS = 200
const BETWEEN_SHOTS_MS = 300

const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

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

async function travelAndSettle(mover: Room): Promise<PlayerFields> {
  mover.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
  await sleep(TRAVEL_MS)
  mover.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
  await sleep(SETTLE_MS)
  const settled = readPlayer(mover, mover.sessionId)
  if (!settled) throw new Error('travelAndSettle: 이동 후 위치 관측 실패')
  return settled
}

async function unlockProtectionAndSettle(room: Room): Promise<PlayerFields> {
  room.send('fire', UP_MISS_AIM)
  return travelAndSettle(room)
}

function aimAtBody(shooter: { x: number; z: number }, target: { x: number; z: number }): { dirX: number; dirY: number; dirZ: number } {
  const bodyCenterM = (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = bodyCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

async function killWithBodyshots(shooterRoom: Room, victimRoom: Room, shooterPos: PlayerFields, victimPos: PlayerFields): Promise<void> {
  const aim = aimAtBody(shooterPos, victimPos)
  for (let shot = 1; shot <= 4; shot += 1) {
    shooterRoom.send('fire', aim)
    const expectedHp = Math.max(0, PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * shot)
    await waitForHpCondition(victimRoom, victimRoom.sessionId, (hp) => hp === expectedHp, `${shot}번째 바디샷 후 HP=${expectedHp} 대기`)
    await sleep(BETWEEN_SHOTS_MS)
  }
}

describe('RQ-81/GA-23: 다른 UUID가 같은 닉네임을 써도 통계 행은 별개다(0에서 시작)', () => {
  let server: RunningServer
  let statsDb: StatsDb
  let tempDir: string

  beforeAll(async () => {
    const temp = createTempStatsDbPath('rq-81-ga23-')
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
    "RQ-81/GA-23: UUID-A·닉네임 'bob'이 킬 1을 쌓고 종료한 뒤, UUID-B·동일 닉네임 'bob'으로 접속하면 UUID-B의 행은 kills=0에서 시작하고 UUID-A의 행은 그대로다",
    async () => {
      const uuidA = randomUUID()
      const uuidB = randomUUID()

      // === UUID-A, 닉네임 'bob' — 통계를 쌓고 종료 ===
      const bobA = await joinGame(newClient(server), { nickname: 'bob', uuid: uuidA })
      const victim1 = await joinGame(newClient(server), { nickname: 'victim1', uuid: randomUUID() })

      const bobAPos = await unlockProtectionAndSettle(bobA)
      const victim1Pos = await unlockProtectionAndSettle(victim1)
      await waitForDefinedPlayer(victim1, victim1.sessionId)

      await killWithBodyshots(bobA, victim1, bobAPos, victim1Pos)

      // 양성 대조군 — UUID-A의 행이 실제로 0이 아니어야 아래 UUID-B=0 단언이
      // "기능이 통째로 없어서 항상 0"과 구분된다.
      const uuidAStats = getStats(statsDb, uuidA)
      expect(uuidAStats?.kills).toBe(1)

      await Promise.all([leaveRoom(bobA), leaveRoom(victim1)])

      // === UUID-B, 동일 닉네임 'bob'으로 접속 ===
      const bobB = await joinGame(newClient(server), { nickname: 'bob', uuid: uuidB })
      const victim2 = await joinGame(newClient(server), { nickname: 'victim2', uuid: randomUUID() })

      // 서버가 실제로 같은 표시 닉네임(자동 접미사 없이, 이전 'bob'은 이미
      // 나갔으므로 충돌이 없다)을 재사용했는지 확인 — GA-23 given/when 전제.
      // fix(평가 major 6): join 직후 동기 읽기 대신 조건 대기 — 근거는
      // 위 waitForNickname docblock 참고.
      const bobBNickname = await waitForNickname(bobB, bobB.sessionId)
      expect(bobBNickname).toBe('bob')

      // 핵심 단언(GA-23 then) — UUID-B는 UUID-A의 통계를 물려받지 않는다.
      // 아직 아무 판도 치르지 않았으므로 행 자체가 없거나(신규 UUID는 최초
      // 조회 시 행이 없을 수 있다) 있어도 전부 0이어야 한다 — 두 경우
      // 모두 "UUID-A의 kills=1을 물려받지 않았다"는 계약을 만족한다.
      const uuidBStatsBeforePlay = getStats(statsDb, uuidB)
      if (uuidBStatsBeforePlay !== undefined) {
        expect(uuidBStatsBeforePlay.kills).toBe(0)
        expect(uuidBStatsBeforePlay.deaths).toBe(0)
      }

      const bobBPos = await unlockProtectionAndSettle(bobB)
      const victim2Pos = await unlockProtectionAndSettle(victim2)
      await waitForDefinedPlayer(victim2, victim2.sessionId)

      await killWithBodyshots(bobB, victim2, bobBPos, victim2Pos)

      // UUID-B가 자신의 첫 킬을 올리면 정확히 1이어야 한다(0+1, 1(UUID-A의
      // 값)+1=2가 아니다) — 별개 행이라는 것의 결정적 증거.
      const uuidBStatsAfterPlay = getStats(statsDb, uuidB)
      expect(uuidBStatsAfterPlay?.kills).toBe(1)

      // UUID-A의 행은 UUID-B의 접속·플레이와 무관하게 그대로다(교차 오염
      // 없음 — 닉네임이 같다는 이유로 두 UUID가 한 행을 공유하지 않는다).
      const uuidAStatsAfterB = getStats(statsDb, uuidA)
      expect(uuidAStatsAfterB?.kills).toBe(1)

      await Promise.all([leaveRoom(bobB), leaveRoom(victim2)])
    },
    90_000,
  )
})
