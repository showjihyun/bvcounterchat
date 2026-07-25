import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'

/**
 * RQ-13 헤드샷 배율 — 서버 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus
 * 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-07** (`harness/evals/golden/track-a-product.jsonl`).
 * GA-07: "given: 플레이어 A가 Pistol(바디 데미지 25, RQ-90)로 플레이어 B를
 * 조준 / when: 동일 조건에서 머리에 명중 / then: 적용된 데미지는 50이다 —
 * 바디 데미지 25의 정확히 2배(RQ-13이 정한 배율, RQ-90이 실수치를 확정)."
 * `verify` 필드가 이 파일 경로를 정확히 지정한다.
 *
 * **레벨 분리(ADR-0008)**: 헤드 데미지가 "바디의 정확히 2배"라는 산술
 * 자체(`damageForRegion('head') === damageForRegion('body') *
 * WEAPON.HEADSHOT_MULTIPLIER`)는 `tests/unit/sim-combat.test.ts`가 이미
 * 고정했다. 이 파일은 "서버가 실제로 머리 높이 조준을 '헤드'로 판정해
 * 그 배율을 적용하는가"를 실 Colyseus 룸 경계에서 블랙박스로 확인한다.
 *
 * **가정(coder에게)**: `rq-12-server-hitscan.test.ts`의 가정 1~4와 동일
 * (`Player.hp` 필드, `'fire'` 메시지 `{dirX,dirY,dirZ}`, 즉시 판정,
 * `DEFAULT_HITBOX` 전원 동일 적용). 조준 방향 계산은 그 파일과 동일한
 * 방식(`aimAt` 헬퍼)이되, 수직 목표를 바디 중심이 아니라
 * `DEFAULT_HITBOX.headCenterM`(헤드 구체 중심 높이)으로 바꾼다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한. 위치는 `rq-20` 패턴대로
 * 실제 이동 입력으로 구동하고, 도달한 최종 위치를 읽어 조준 각도를
 * 계산한다(가정한 거리에 결합하지 않는다).
 *
 * **REV(구현 후 셋업 적응, RQ-15~16 라운드, team-lead 지시)**: RQ-16
 * item C(최초 입장도 스폰 보호)와 RQ-31(onJoin도 스폰 로테이션) 구현으로
 * 이 파일의 두 전제가 깨졌다 — B가 접속 직후 3초간 보호돼 사격이
 * 무효화됐고, A가 더 이상 원점에 고정되지 않는다
 * (`_workspace/RQ-15-16/02_coder_green.md` §3.3). 대응은
 * `rq-12-server-hitscan.test.ts`의 REV와 동일: B가 킬 시퀀스 전에
 * 스스로(빗나가는 방향으로) 한 발 쏴 보호를 즉시 해제하고, `aimAt`이
 * A의 실제 위치를 읽어 상대 오프셋을 계산하도록 일반화했다. 단언(HP
 * 감소량 50) 자체는 손대지 않았다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
const TRAVEL_MS = 900
const SETTLE_MS = 200

/** GA-06/GA-08과 동일한 근거로 기하학적으로 항상 빗나가는 방향(수직 위) —
 * 위치와 무관하게 안전하다. REV: B가 이 방향으로 자기 자신을 쏘면 자신의
 * 스폰 보호가 즉시 해제된다(RQ-16). */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

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
  z: number
  hp: number
}

/** REV: `z` 필드를 추가했다 — A가 더 이상 원점에 고정되지 않아(RQ-31
 * onJoin 로테이션) 조준 벡터 계산에 두 플레이어의 z좌표가 모두 필요하다
 * (파일 상단 REV 참고, 원래는 x만으로 충분했다). */
function readPlayer(room: Room, sessionId: string): PlayerFields | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; z?: unknown; hp?: unknown } | undefined }
  } | null
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

/** shooter(발 위치)에서 target(발 위치)의 verticalCenterM 높이를 정확히
 * 조준하는 방향 벡터(정규화)를 계산한다. REV: A가 더 이상 원점에 고정되지
 * 않으므로(RQ-31 onJoin 로테이션) 두 위치 모두를 인자로 받는 일반형이다. */
function aimAt(
  shooter: { x: number; z: number },
  target: { x: number; z: number },
  verticalCenterM: number,
): { dirX: number; dirY: number; dirZ: number } {
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = verticalCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

describe('RQ-13/GA-07: 머리 명중은 바디 데미지의 정확히 2배(50)를 적용한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-13/GA-07: A가 B의 머리 높이를 정확히 조준해 사격하면, B의 HP가 100에서 정확히 50(헤드 데미지 50 = 바디 25×2)만큼만 감소한다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      roomB.send('fire', UP_MISS_AIM) // REV: 자신의 최초 입장 스폰 보호를 즉시 해제(item C)
      const settledB = await travelAndSettle(roomB) // 1100ms 경과 — 위 해제 사격이 반영되기 충분하다
      const aim = aimAt(baselineA, settledB, DEFAULT_HITBOX.headCenterM)
      roomA.send('fire', aim)

      const afterShot = await waitForHpCondition(
        roomB,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        '헤드샷 사격 후 HP 감소 대기',
      )

      const headDamage = WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER
      expect(headDamage).toBe(50) // 전제 확인 — RQ-90 확정값
      expect(afterShot.hp).toBe(PLAYER.MAX_HP - headDamage)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )
})
