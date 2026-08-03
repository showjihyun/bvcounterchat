import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { WALL_EAST } from '@shared/sim/walls'

/**
 * RQ-30 벽 충돌 — **프로덕션 배선** 통합 테스트(원장 25a-2, 독립 평가 FAIL
 * F1 대응).
 *
 * **이 파일이 존재하는 이유(평가자 실측)**: `tests/unit/sim-movement-walls
 * .test.ts`는 `stepMovement`(순수 함수)를 직접 호출해 벽 주입 **계약**을
 * 고정하지만, `GameRoom`이 실제로 그 계약에 `PRODUCTION_WALLS`를 주입하는
 * **배선**은 어떤 테스트도 관측하지 않았다 — `GameRoom.ts`의
 * `stepMovement(previous, input, PRODUCTION_WALLS)` 호출에서 세 번째
 * 인자를 통째로 제거해도(격리 워크트리 실측, 원장 25a-2 04) 전체
 * 스위트(518건)가 무성으로 통과했다. 벽을 "기존 테스트가 안 닿는 빈
 * 대역"(반경 15.8~16.8m)에 둔 것이 회귀 안전성은 보장했지만, 바로 그
 * 이유로 아무 테스트도 그 벽을 실제로 지나가지 않아 배선 자체가 고아
 * 상태였다. 이 파일은 그 공백을 메운다 — **서버가 확정하는 공개
 * 스키마(`player.x`)**가 실제 Colyseus 룸에서 벽을 존중하는지를 관측한다.
 *
 * **범위 — 순증만.** 기존 `rq-30-play-area-bounds.test.ts`(세계 경계
 * 클램프)는 전혀 건드리지 않는다 — 별개 파일, 별개 관측 대상(경계 vs
 * 벽)이다. `sim-movement-walls.test.ts`(test-writer 전유)도 건드리지
 * 않는다.
 *
 * **좌표 선정**: `WALL_EAST`(`@shared/sim/walls`, x:15~16, z:-5~5)의 근접면
 * (`minX`=15)에서 2m 앞(x=13, z=0)에 배치한다 — z=0은 WALL_EAST의 z범위
 * 안이라 정면으로 충돌한다. 리터럴로 좌표를 복제하지 않고 `WALL_EAST`를
 * 그대로 임포트해 벽 좌표가 바뀌어도 이 테스트가 따라간다.
 *
 * **화이트박스 기법**: `matchMaker.getLocalRoomById`(`rq-30-play-area
 * -bounds.test.ts`·`rq-61-server-authoritative-position.test.ts`가 이미
 * 확립한 기법) — 위치는 `moveStates`(정본)로 순간이동시키고, 관측은
 * `state.players`(공개 스키마, 다른 플레이어에게도 브로드캐스트되는 "서버가
 * 확정하는 위치")로 한다.
 *
 * **정지 방식은 못박지 않는다**(팀리드 지시 — 원장 25a-1/25a-2 선례) —
 * "근접면을 넘지 않는다"(통과 금지)와 "출발점에 얼어붙지 않고 실제로
 * 벽까지 밀렸다"(고착 아님)만 단언한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const BASELINE_TIMEOUT_MS = 3_000
/** 서버 화이트박스 상태 폴링 간격 — 기존 통합 테스트(`rq-61-server
 * -authoritative-position.test.ts` `SERVER_POLL_INTERVAL_MS`)와 동일 값. */
const SERVER_POLL_INTERVAL_MS = 15

/** 벽 근접면(`WALL_EAST.minX`=15)에서 2m 앞 — 근접 여유(`WALL_APPROACH
 * _MARGIN_M`, `sim-movement-walls.test.ts`와 동일 근거)보다 커서 히트박스
 * 반지름(0.3m) 처리 여부와 무관하게 통과한다. */
const START_X_M = WALL_EAST.minX - 2
/** 부동소수점 누적 오차 허용치 — `sim-movement-walls.test.ts`의
 * `WALL_TOLERANCE_M`과 동일 값·동일 근거. */
const WALL_TOLERANCE_M = 1e-6
/** 지속 이동 관측 창 — 2m를 건너기에 필요한 시간(6m/s ≈ 0.33초)보다 넉넉한
 * 여유(≈27틱). */
const SUSTAINED_PUSH_WINDOW_MS = 900

/** 모든 대기에 상한을 강제하는 래퍼 — 상한 초과는 hang이 아니라 즉시 실패다. */
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

interface MoveState {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  grounded: boolean
}

interface HorizontalPosition {
  x: number
  z: number
}

interface WallWiringSeam {
  moveStates: Map<string, MoveState>
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number } | undefined
    }
  }
}

function getServerRoom(room: Room): WallWiringSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as WallWiringSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-30 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** `moveStates`만 화이트박스로 덮어쓴다(`rq-30-play-area-bounds.test.ts`의
 * `placePlayer`와 동일 관례) — 공개 스키마는 서버의 다음 틱이 자연스럽게
 * 반영하도록 둔다. */
function placePlayer(seam: WallWiringSeam, sessionId: string, position: HorizontalPosition): void {
  seam.moveStates.set(sessionId, { x: position.x, y: 0, z: position.z, vx: 0, vy: 0, vz: 0, grounded: true })
}

function readServerPosition(seam: WallWiringSeam, sessionId: string): HorizontalPosition | undefined {
  const p = seam.state.players.get(sessionId)
  if (typeof p?.x === 'number' && typeof p?.z === 'number') {
    return { x: p.x, z: p.z }
  }
  return undefined
}

function waitForServerCondition(
  seam: WallWiringSeam,
  sessionId: string,
  predicate: (p: HorizontalPosition) => boolean,
  label: string,
  timeoutMs: number,
): Promise<HorizontalPosition> {
  return new Promise<HorizontalPosition>((resolve, reject) => {
    const tryResolve = (): boolean => {
      const current = readServerPosition(seam, sessionId)
      if (current && predicate(current)) {
        resolve(current)
        return true
      }
      return false
    }
    if (tryResolve()) return
    const interval = setInterval(() => {
      if (tryResolve()) {
        clearInterval(interval)
        clearTimeout(timeout)
      }
    }, SERVER_POLL_INTERVAL_MS)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`[timeout ${timeoutMs}ms] ${label}`))
    }, timeoutMs)
  })
}

function sampleServerPositionOverWindow(
  seam: WallWiringSeam,
  sessionId: string,
  windowMs: number,
): Promise<HorizontalPosition[]> {
  return new Promise<HorizontalPosition[]>((resolve) => {
    const samples: HorizontalPosition[] = []
    const interval = setInterval(() => {
      const current = readServerPosition(seam, sessionId)
      if (current) samples.push(current)
    }, SERVER_POLL_INTERVAL_MS)
    setTimeout(() => {
      clearInterval(interval)
      resolve(samples)
    }, windowMs)
  })
}

function lastSample<T>(samples: T[]): T {
  const last = samples[samples.length - 1]
  if (last === undefined) {
    throw new Error('RQ-30: 관측 구간 동안 샘플이 한 건도 수집되지 않았다')
  }
  return last
}

describe('RQ-30 벽 충돌 — 프로덕션 배선(평가 FAIL F1 대응): 서버가 확정하는 공개 스키마가 벽을 존중한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-30/F1: 벽(WALL_EAST) 앞에서 지속 이동해도 서버가 확정하는 player.x(공개 스키마)가 근접면을 넘지 않는다',
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)

      placePlayer(seam, room.sessionId, { x: START_X_M, z: 0 })
      const baseline = await waitForServerCondition(
        seam,
        room.sessionId,
        (p) => Math.abs(p.x - START_X_M) < WALL_TOLERANCE_M,
        'RQ-30: 화이트박스 순간이동 반영 대기',
        BASELINE_TIMEOUT_MS,
      )

      room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
      const samples = await sampleServerPositionOverWindow(seam, room.sessionId, SUSTAINED_PUSH_WINDOW_MS)

      expect(samples.length).toBeGreaterThan(0)
      for (const s of samples) {
        // 통과 금지 — 관측 구간 전체에서 근접면(WALL_EAST.minX)을 넘지 않는다.
        expect(s.x).toBeLessThanOrEqual(WALL_EAST.minX + WALL_TOLERANCE_M)
      }

      const last = lastSample(samples)
      // 고착 금지 — 출발점에 얼어붙지 않고 실제로 전진했다(PRODUCTION_WALLS를
      // 통째로 제거하는 변이뿐 아니라, "모든 이동을 통째로 막는" 오구현도
      // 이 단언으로 잡는다).
      expect(last.x).toBeGreaterThan(baseline.x)

      await leaveRoom(room)
    },
    15_000,
  )
})
