import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '@server/index'
import { getStats, openStatsDb } from '@server/persistence/statsDb'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'

/**
 * RQ-81 통계 절반(B계층 — 서버 재시작 후에도 통계가 보존된다) — 서버
 * 권위(RQ-61) 통합 테스트(ADR-0008: Colyseus 룸 경계, ADR-0011: SQLite
 * 영속 Red-first 영역).
 *
 * RQ-81 전문: "서버 재시작 시 세션은 소실을 허용하고, 통계는 보존해야
 * 한다." 전용 골든 케이스는 없다(GA-22/23은 재접속을, 이 파일은 **서버
 * 프로세스 재시작**을 다룬다 — 다른 축). 팀리드 지시(원장 위임)로 커버.
 *
 * **팀리드 지시 — `:memory:`로는 검증 불가**: ADR-0008 §5는 통합 테스트가
 * SQLite를 `:memory:`로 대체하는 것을 "최소 요구"로 허용하지만, 그건 이
 * RQ의 핵심 계약(재시작 생존)을 검증할 수 없다 — `:memory:`는 프로세스
 * 종료와 함께 사라진다. 그래서 이 파일은 **실제 파일 모드**(임시 디렉터리)
 * 를 쓴다 — `rq-81-uuid-stat-persistence.test.ts`/`-isolation.test.ts`와
 * 동일하게 이미 파일 경로를 쓰고 있으므로 이 파일만의 예외가 아니다.
 *
 * **재시작 시뮬레이션 기법**: `tests/integration/rq-04-persistent-session
 * .test.ts`의 GA-28("서버 재시작 시 진행 중 세션 상태가 소실된다")과 동일한
 * 방식 — 실제 프로세스 kill이 아니라 **같은 테스트 프로세스 안에서
 * `buildServer()`를 다시 호출**한다(team-lead 선례 지시). 두 호출에 **같은
 * `statsDbPath`**를 넘기는 것이 이 파일의 핵심 — RQ-04(세션)는 매번 새
 * 인메모리 상태로 시작하지만(포트도 새로 열림, roomId도 새로 발급), SQLite
 * 파일 경로는 재사용해 "디스크 위 파일은 프로세스 재시작과 무관하게 남는다"
 * 는 조건을 재현한다.
 *
 * **관측 지점**: `openStatsDb`/`getStats`로 SQLite 파일을 직접 읽는다
 * (근거는 `rq-81-uuid-stat-persistence.test.ts` 상단 "관측 지점" 절과
 * 동일 — 재시작 이후에는 애초에 이전 서버 인스턴스에 연결됐던 클라이언트
 * 룸도 없으므로 클라이언트 시야 관측은 선택지 자체가 없다).
 *
 * **양성 대조군**: "재시작 후에도 값이 있다"만으로는 새 서버가 통계
 * 기능을 아예 갖고 있지 않아 매번 새 빈 파일을 만드는 결함과 구분되지
 * 않는다 — 그래서 재시작 후 **새 킬을 하나 더 쌓아 2가 되는 것**까지
 * 확인한다(1로 멈춰 있다면 새 서버가 기존 값을 무시하고 자기 세션 안에서만
 * 세고 있다는 뜻이다).
 *
 * **가정(coder에게)**: `rq-81-uuid-stat-persistence.test.ts`(GA-22)의
 * "가정" 절과 완전히 동일. 추가로 이 파일 전용 가정 — `GameRoom`이 연 SQLite
 * 파일 핸들은 룸이 폐기(`gracefullyShutdown`/dispose 경로)될 때 닫혀야
 * 한다. 닫지 않으면 두 번째 `buildServer()` 인스턴스가 같은 파일을 열 때
 * (Windows 파일 잠금 관례상) 충돌할 수 있다 — 이 파일이 실제 실패로 그
 * 구멍을 드러낸다(닫지 않는 구현이면 두 번째 `startServer()` 또는 그
 * 안의 킬 시퀀스가 타임아웃/에러로 Red가 난다).
 *
 * **결정론 메모**: 실 WebSocket 의존(ADR-0008 허용 예외). 모든 대기에
 * `withTimeout()` 상한.
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
}

function createTempStatsDbPath(prefix: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { path: join(dir, 'stats.db'), dir }
}

async function startServer(statsDbPath: string): Promise<RunningServer> {
  const app = buildServer({ logger: false, statsDbPath })
  const address = await withTimeout(app.listen({ port: 0, host: '127.0.0.1' }), LISTEN_TIMEOUT_MS, 'app.listen({ port: 0 })')
  const { port } = new URL(address)
  return { app, endpoint: `ws://127.0.0.1:${port}` }
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

describe('RQ-81: 서버 프로세스 재시작 후에도 SQLite 통계는 보존된다', () => {
  let tempDir: string

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it(
    'RQ-81: 재시작 전 킬 1을 쌓고, 같은 statsDbPath로 서버를 다시 띄우면 그 값이 그대로 있고, 새 서버에서 킬을 하나 더 쌓으면 2가 된다',
    async () => {
      const temp = createTempStatsDbPath('rq-81-restart-')
      tempDir = temp.dir
      const uuidA = randomUUID()

      // === 재시작 전 인스턴스 ===
      const before = await startServer(temp.path)
      const a1 = await joinGame(newClient(before), { nickname: 'alice', uuid: uuidA })
      const x1 = await joinGame(newClient(before), { nickname: 'victim1', uuid: randomUUID() })

      const a1Pos = await unlockProtectionAndSettle(a1)
      const x1Pos = await unlockProtectionAndSettle(x1)
      await waitForDefinedPlayer(x1, x1.sessionId)

      await killWithBodyshots(a1, x1, a1Pos, x1Pos)

      await Promise.all([leaveRoom(a1), leaveRoom(x1)])
      await stopServer(before) // "재시작" — 프로세스 안에서 buildServer()를 다시 부른다(GA-28 선례)

      // 재시작 전 인스턴스가 닫힌 뒤, 파일에 직접 접근해 값이 실제로 디스크에
      // 있는지 먼저 확인한다(양성 대조군의 첫 단계 — 아래 재시작 후 확인과
      // 분리해, "재시작 자체가 문제"인지 "애초에 기록이 안 됐는지" 구분한다).
      const dbAfterFirstInstance = openStatsDb(temp.path)
      const statsBeforeRestart = getStats(dbAfterFirstInstance, uuidA)
      expect(statsBeforeRestart?.kills).toBe(1)
      dbAfterFirstInstance.close()

      // === 재시작 후 인스턴스(같은 statsDbPath) ===
      const after = await startServer(temp.path)
      const a2 = await joinGame(newClient(after), { nickname: 'alice', uuid: uuidA })
      const x2 = await joinGame(newClient(after), { nickname: 'victim2', uuid: randomUUID() })

      const a2Pos = await unlockProtectionAndSettle(a2)
      const x2Pos = await unlockProtectionAndSettle(x2)
      await waitForDefinedPlayer(x2, x2.sessionId)

      await killWithBodyshots(a2, x2, a2Pos, x2Pos)

      const dbAfterRestart = openStatsDb(temp.path)
      const statsAfterRestart = getStats(dbAfterRestart, uuidA)
      // 핵심 단언 — 재시작 전 값(1)이 살아남아 있었기 때문에 새 킬 1개를
      // 더한 결과가 2다. 재시작이 통계를 지웠다면(버그) 이 값은 1일 것이다.
      expect(statsAfterRestart?.kills).toBe(2)
      dbAfterRestart.close()

      await Promise.all([leaveRoom(a2), leaveRoom(x2)])
      await stopServer(after)
    },
    90_000,
  )
})
