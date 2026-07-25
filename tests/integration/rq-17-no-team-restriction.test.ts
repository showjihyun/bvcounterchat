import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'

/**
 * RQ-17 개인전(Free-For-All) — 팀 판정 없이 모든 플레이어 간 피해를
 * 허용한다 (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직
 * Red-first 영역).
 *
 * RQ-17 전문: "개인전이므로 시스템은 팀 판정 없이 모든 플레이어 간 피해를
 * 허용해야 한다(Friendly Fire = 아군 판정 없음)." 이 요구사항에 매핑된
 * 전용 GA는 없다 — team-lead 지시대로 **얇게**(thin) 확인한다: 현재
 * 스키마(`@shared/schema/GameState`)에 팀 필드가 아예 없으므로, "팀 개념
 * 부재"를 직접 증명하는 가장 확실한 방법은 **같은 두 플레이어 사이에서
 * 피해가 양방향으로 모두 성립한다**는 것을 보이는 것이다 — 만약 구현이
 * (스펙에 없는) 접속 순서·세션ID 기반의 암묵적 "편"을 가르는 버그가 있다면
 * 한쪽 방향의 피해만 성립하고 반대 방향은 막힐 것이다.
 *
 * **레벨 분리(ADR-0008)**: 명중·데미지 산술 자체는
 * `tests/unit/sim-combat.test.ts`·`rq-12-server-hitscan.test.ts`가 이미
 * 검증했다. 이 파일은 그 산술을 반복 검증하지 않고 "제3의 방향 제약(팀)이
 * 존재하지 않는가"만 thin하게 확인한다 — 그래서 데미지 값 자체는 A→B,
 * B→A 각각 1회씩만 쏘아 HP가 바디 데미지만큼 감소하는지만 본다(4연타
 * 사망까지는 가지 않는다 — 그건 GA-08/`rq-14`의 책임).
 *
 * **가정(coder에게)**: `rq-12-server-hitscan.test.ts`의 가정 1~4와 동일.
 * rate-limit(ADR-0005)은 **사수별 독립 추적**이라고 가정했으므로(그 파일
 * 가정 4), A→B 사격 직후 B→A 사격을 보내도 서로 다른 세션이라 rate-limit
 * 충돌이 없다 — 그래도 이 테스트는 A의 사격 처리가 HP 변화로 확인된 뒤에만
 * B의 반격을 보내 순서를 명확히 한다(레이스 방지).
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

interface PlayerFields {
  x: number
  hp: number
}

function readPlayer(room: Room, sessionId: string): PlayerFields | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; hp?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (typeof player?.x === 'number' && typeof player?.hp === 'number') {
    return { x: player.x, hp: player.hp }
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
    HP_TIMEOUT_MS,
    `초기 스냅샷(x·hp 포함, sessionId=${sessionId}) 관측`,
  )
}

function waitForHpCondition(
  room: Room,
  sessionId: string,
  predicate: (hp: number) => boolean,
  label: string,
): Promise<PlayerFields> {
  return withTimeout(
    new Promise<PlayerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current && predicate(current.hp)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
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

/** shooterX(고정, 0으로 가정)에서 targetX(발 위치)의 바디 중심을 조준하는
 * 방향 벡터(정규화) — 부호 있는 수평 오프셋(targetX - shooterX)을 받는다. */
function aimAtBody(horizontalOffset: number): { dirX: number; dirY: number; dirZ: number } {
  const bodyCenterM = (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
  const dy = bodyCenterM - DEFAULT_HITBOX.eyeHeightM
  const dx = horizontalOffset
  const magnitude = Math.sqrt(dx * dx + dy * dy)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: 0 }
}

describe('RQ-17: 팀 판정 없이 모든 플레이어 간 피해가 양방향으로 허용된다(Friendly Fire = 아군 판정 없음)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-17: A가 B를 쏘면 B의 HP가 줄고, 곧이어 B가 A를 쏘면 A의 HP도 똑같이 준다 — 어느 쪽도 상대의 사격을 "아군"으로 취급해 막지 않는다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 원점(x=0) 고정
      const roomB = await joinGame(newClient(server)) // +X로 이동

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineA.hp).toBe(PLAYER.MAX_HP)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      const settledB = await travelAndSettle(roomB)
      const distance = settledB.x // A(x=0) 기준 B까지의 수평 거리

      // A → B: 명중해야 한다(팀 제약이 있다면 여기서부터 막힐 것이다).
      roomA.send('fire', aimAtBody(distance))
      const bAfterHit = await waitForHpCondition(
        roomB,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'A → B 사격 후 B의 HP 감소 대기',
      )
      expect(bAfterHit.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      // B → A: 반대 방향(음의 오프셋)으로 A를 조준 — 이 사격도 동일하게
      // 명중해야 한다. "먼저 쏜 쪽만 유효하다" 같은 숨은 우선순위가 있다면
      // 여기서 실패한다.
      roomB.send('fire', aimAtBody(-distance))
      const aAfterHit = await waitForHpCondition(
        roomA,
        roomA.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'B → A 반격 후 A의 HP 감소 대기',
      )
      expect(aAfterHit.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )
})
