import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { PLAYER } from '@shared/constants'

/**
 * RQ-12 악의적 클라이언트의 명중 주장 거부 — 서버 권위(RQ-61) 통합 테스트
 * (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-06** (v1.1, `harness/evals/golden/track-a-product.jsonl`).
 * GA-06: "given: 서버 판정 기준으로 A의 사격이 B에게 명중 불가능한 상태
 * (조준 이탈, 또는 맵 단계 이후에는 벽 차폐 — v1.1: 맵 부재로 given
 * 일반화, 사용자 승인) / when: 악의적 클라이언트 A가 자신이 B에게
 * 명중시켰다는 명중 결과를 직접 서버에 보고 / then: 서버는 클라이언트가
 * 보고한 명중 결과를 그대로 반영하지 않고 자체 hitscan을 재계산하며, 그
 * 결과(명중 없음)만 적용되어 B의 HP는 변하지 않는다(RQ-61)." `verify`
 * 필드가 이 파일 경로를 정확히 지정한다.
 *
 * 맵(RQ-30)이 아직 없어 "벽 차폐"는 이 v1.1 given에서 제외됐다(사용자
 * 승인, `harness/progress.md` 22a 행) — "조준 이탈"만으로 given을
 * 충족한다: A가 B와 기하학적으로 전혀 무관한 방향(정반대·수직 등)을
 * 조준한 상태.
 *
 * **레이-히트박스 판정 자체(있음/없음)의 정밀도**는 `tests/unit/sim-combat.test.ts`가
 * 담당한다. 이 파일은 "클라이언트가 보낸 조준과 무관하게 명중을 **주장하는
 * 필드**를 함께 실어 보내도, 서버가 그 주장을 참조하지 않고 자체 판정
 * (명중 없음)만 적용하는가"를 블랙박스로 확인한다 — `rq-12-server-hitscan.test.ts`의
 * "무관한 방향 사격 시 HP 불변" 테스트가 이미 "진짜 미스는 HP를 바꾸지
 * 않는다"를 확인했으므로, 이 파일은 그 미스에 **악의적 주장 필드**를
 * 덧붙였을 때도 여전히 무시되는지에 집중한다(더 강한 공격 시나리오).
 *
 * **가정(coder에게)**: `rq-12-server-hitscan.test.ts`의 가정 1~4와 동일
 * (`Player.hp`·`Player.kills` 필드, `'fire'` 메시지가 `dirX`·`dirY`·`dirZ`
 * 외의 필드를 읽지 않음, 즉시 판정, DEFAULT_HITBOX). 이 파일이 추가로
 * 요구하는 것은 오직 하나 — **`'fire'` payload에 임의의 여분 필드(명중
 * 주장·데미지 주장·헤드샷 주장·대상 지정)를 실어 보내도 서버가 그 필드들을
 * 전혀 참조하지 않는다**는 것. `sanitizeMoveInput`이 `move` payload에서
 * 방향·상태 필드만 뽑고 좌표(x·y·z)를 무시하던 것(`GameRoom.ts`)과 동일한
 * 패턴이 `'fire'` 핸들러에도 적용된다고 가정한다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존(ADR-0008 허용
 * 예외). 모든 대기에 `withTimeout()` 상한. "변화 없음"은 `onStateChange`를
 * 여러 차례 통과시키는 고정 대기로 확인한다(변화가 없다는 것 자체가
 * 확인 대상이라 이벤트 기반 대기가 부적합 — `rq-20`의 "무입력 표류 없음"
 * 테스트와 동일한 필요성).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** "변화 없음"을 확인하기 위한 관찰 구간(여러 틱을 거치기 충분한 여유). */
const NO_CHANGE_OBSERVATION_MS = 500

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
  hp: number
  kills: number
}

function readPlayer(room: Room, sessionId: string): PlayerFields | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { hp?: unknown; kills?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (typeof player?.hp === 'number' && typeof player?.kills === 'number') {
    return { hp: player.hp, kills: player.kills }
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
    `초기 스냅샷(hp·kills 포함, sessionId=${sessionId}) 관측`,
  )
}

describe('RQ-12/GA-06(v1.1): 조준 이탈 상태에서 클라이언트의 명중 주장을 서버가 거부한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-12/GA-06: A가 B와 기하학적으로 무관한 방향(수직 위)을 조준한 채, 명중·데미지·헤드샷을 직접 주장하는 필드를 실어 사격해도 서버는 자체 hitscan(명중 없음)만 적용하며 B의 HP·A의 킬 수는 변하지 않는다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      // A는 이동하지 않아 B와 같은 평면(y=0)에 있다 — 수직 위(dirY=1)를
      // 조준하면 지면 위의 B와는 기하학적으로 전혀 만날 수 없는 "조준
      // 이탈" 상태다(GA-06 given). 여기에 명중·데미지·헤드샷·대상 지정을
      // 직접 주장하는 여분 필드를 덧붙인다 — 서버가 이 필드들을 읽는다면
      // B의 HP가 감소하거나 A의 킬이 오르는 것으로 드러난다.
      roomA.send('fire', {
        dirX: 0,
        dirY: 1,
        dirZ: 0,
        hit: true,
        headshot: true,
        targetId: roomB.sessionId,
        damage: 999,
        killed: true,
      })

      await sleep(NO_CHANGE_OBSERVATION_MS)

      const afterB = readPlayer(roomB, roomB.sessionId)
      const afterA = readPlayer(roomA, roomA.sessionId)
      expect(afterB?.hp).toBe(baselineB.hp) // 서버 자체 판정(명중 없음)만 적용됨 — 주장은 무시됨
      expect(afterA?.kills).toBe(baselineA.kills) // 주장된 킬도 반영되지 않음

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    20_000,
  )
})
