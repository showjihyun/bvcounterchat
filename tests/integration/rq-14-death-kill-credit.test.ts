import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'

/**
 * RQ-14 HP·사망·킬 기록 — 서버 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus
 * 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-08** (`harness/evals/golden/track-a-product.jsonl`).
 * GA-08: "given: 플레이어 B의 HP가 100(RQ-14 시작값)이며, 플레이어 A로부터
 * 바디샷(각 25데미지, RQ-90) 3회를 맞아 HP 25가 남은 상태 / when: A의
 * 4번째 바디샷이 B에게 명중해 HP가 0 이하가 됨 / then: B는 사망 처리되고,
 * 가해자 A에게 킬이 1 기록된다." `verify` 필드가 이 파일 경로를 정확히
 * 지정한다.
 *
 * **스코프 제외**: 리스폰(RQ-15)·스폰 보호(RQ-16)는 이 RQ의 범위 밖 —
 * "사망 처리" 이후 B에게 일어나는 일(재배치 등)은 이 파일이 검증하지
 * 않는다. GA-08이 관측 가능하다고 규정하는 것은 딱 둘 — B의 HP가 0(이하)
 * 이 되는 것과 A의 킬 수가 1 오르는 것뿐이다.
 *
 * **레벨 분리(ADR-0008)**: "바디샷 4회 = 정확히 사망"이라는 산술 자체는
 * `tests/unit/sim-combat.test.ts`의 "GA-08: 바디샷 3회는 생존..." 테스트가
 * 이미 고정했다. 이 파일은 그 산술이 실제 Colyseus 룸에서 4회의 실제
 * `'fire'` 메시지로 재현되고, 사망 시 가해자의 `kills` 필드가 실제로
 * 갱신되는가를 블랙박스로 확인한다.
 *
 * **가정(coder에게)**: `rq-12-server-hitscan.test.ts`의 가정 1~4와 동일
 * (`Player.hp`·`Player.kills` 필드, `'fire'` 메시지, 즉시 판정,
 * `DEFAULT_HITBOX`). **킬 크레딧 갱신 시점**: 피해자의 `hp`가 0(이하)이
 * 되는 그 사격의 처리 안에서, 가해자(사수)의 `kills`를 정확히 1 증가시킨다
 * — 이미 사망한(hp<=0) 대상에 대한 추가 사격이 있다면 몇 번을 더 맞아도
 * `kills`가 중복 증가하지 않는다는 것까지는 이 RQ가 규정하지 않는다(리스폰
 * 부재 상태에서 "이미 죽은 대상"의 취급은 스코프 밖 — 이 테스트는 정확히
 * 4번째 사격에서 처음 사망이 발생하는 시나리오만 다룬다).
 *
 * **rate-limit과의 상호작용**: 4회 연속 사격은 매 사격 사이에 rate-limit
 * (ADR-0005, 150ms)이 확실히 풀릴 만큼 기다린 뒤 보낸다(각 사격이 실제로
 * 명중 처리됐는지를 HP 변화로 직접 확인하므로, 만약 rate-limit에 걸려
 * 무시된 사격이 있다면 뒤이은 `waitForHpCondition`이 타임아웃으로 실패해
 * 즉시 드러난다).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
const TRAVEL_MS = 900
const SETTLE_MS = 200
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[timeout ${ms}ms] ${label}`))
    }, ms)
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

async function startServer(): Promise<RunningServer> {
  const app = buildServer({ logger: false })
  const address = await withTimeout(
    app.listen({ port: 0, host: '127.0.0.1' }),
    LISTEN_TIMEOUT_MS,
    'app.listen({ port: 0 })',
  )
  const { port } = new URL(address)
  return { app, endpoint: `ws://127.0.0.1:${port}` }
}

async function stopServer(server: RunningServer): Promise<void> {
  await withTimeout(server.app.close(), CLOSE_TIMEOUT_MS, 'app.close()')
}

function newClient(server: RunningServer): Client {
  return new Client(server.endpoint)
}

async function joinGame(client: Client): Promise<Room> {
  return withTimeout(client.joinOrCreate(ROOM_NAME), JOIN_TIMEOUT_MS, `joinOrCreate('${ROOM_NAME}')`)
}

async function leaveRoom(room: Room): Promise<void> {
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface VictimFields {
  x: number
  hp: number
}

interface KillerFields {
  kills: number
}

function readVictim(room: Room, sessionId: string): VictimFields | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; hp?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (typeof player?.x === 'number' && typeof player?.hp === 'number') {
    return { x: player.x, hp: player.hp }
  }
  return undefined
}

function readKiller(room: Room, sessionId: string): KillerFields | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { kills?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (typeof player?.kills === 'number') {
    return { kills: player.kills }
  }
  return undefined
}

function waitForDefinedVictim(room: Room, sessionId: string): Promise<VictimFields> {
  return withTimeout(
    new Promise<VictimFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readVictim(room, sessionId)
        if (current) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    `초기 스냅샷(x·hp 포함, sessionId=${sessionId}) 관측`,
  )
}

function waitForDefinedKiller(room: Room, sessionId: string): Promise<KillerFields> {
  return withTimeout(
    new Promise<KillerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readKiller(room, sessionId)
        if (current) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    `초기 스냅샷(kills 포함, sessionId=${sessionId}) 관측`,
  )
}

function waitForHpCondition(
  room: Room,
  sessionId: string,
  predicate: (hp: number) => boolean,
  label: string,
): Promise<VictimFields> {
  return withTimeout(
    new Promise<VictimFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readVictim(room, sessionId)
        if (current && predicate(current.hp)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    label,
  )
}

function waitForKillsCondition(
  room: Room,
  sessionId: string,
  predicate: (kills: number) => boolean,
  label: string,
): Promise<KillerFields> {
  return withTimeout(
    new Promise<KillerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readKiller(room, sessionId)
        if (current && predicate(current.kills)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    label,
  )
}

async function travelAndSettle(mover: Room): Promise<VictimFields> {
  mover.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
  await sleep(TRAVEL_MS)
  mover.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
  await sleep(SETTLE_MS)
  const settled = readVictim(mover, mover.sessionId)
  if (!settled) throw new Error('travelAndSettle: 이동 후 위치 관측 실패')
  return settled
}

function aimAtBody(targetXOffset: number): { dirX: number; dirY: number; dirZ: number } {
  const bodyCenterM = (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
  const dy = bodyCenterM - DEFAULT_HITBOX.eyeHeightM
  const dx = targetXOffset
  const magnitude = Math.sqrt(dx * dx + dy * dy)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: 0 }
}

describe('RQ-14/GA-08: 바디샷 4회 누적으로 사망 처리되고 가해자에게 킬이 1 기록된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-14/GA-08: A의 바디샷 3회 후 B의 HP는 25(생존, 킬 미기록), 4번째 바디샷에서 B의 HP는 0이 되고 A의 킬 수는 1이 된다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      const baselineB = await waitForDefinedVictim(roomB, roomB.sessionId)
      const baselineA = await waitForDefinedKiller(roomA, roomA.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)
      expect(baselineA.kills).toBe(0)

      const settledB = await travelAndSettle(roomB)
      const aim = aimAtBody(settledB.x)

      let lastHp = baselineB.hp
      for (let shot = 1; shot <= 3; shot += 1) {
        roomA.send('fire', aim)
        const expectedHp = PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * shot
        const afterShot = await waitForHpCondition(
          roomB,
          roomB.sessionId,
          (hp) => hp === expectedHp,
          `${shot}번째 바디샷 후 HP=${expectedHp} 대기`,
        )
        lastHp = afterShot.hp
        await sleep(BETWEEN_SHOTS_MS)
      }

      // GA-08 given 상태 — 3회 피격 후 HP 25, 아직 생존, 킬 미기록.
      expect(lastHp).toBe(25)
      const killsBeforeFourth = readKiller(roomA, roomA.sessionId)
      expect(killsBeforeFourth?.kills).toBe(0)

      // 4번째 바디샷 — 사망 처리 + 킬 크레딧.
      roomA.send('fire', aim)
      const afterFourth = await waitForHpCondition(
        roomB,
        roomB.sessionId,
        (hp) => hp <= 0,
        '4번째 바디샷 후 사망(HP<=0) 대기',
      )
      expect(afterFourth.hp).toBe(0)

      const afterKillCredit = await waitForKillsCondition(
        roomA,
        roomA.sessionId,
        (kills) => kills > 0,
        '사망 처리 후 가해자 킬 수 증가 대기',
      )
      expect(afterKillCredit.kills).toBe(1)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    40_000,
  )
})
