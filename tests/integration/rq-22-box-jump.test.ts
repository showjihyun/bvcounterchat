import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { BOX_ALPHA } from '@shared/sim/boxes'

/**
 * RQ-22 박스 점프 — **프로덕션 배선** 통합 테스트(원장 25a-4, team-lead
 * 지시). 골든 **GA-55**(`harness/evals/golden/track-a-product.jsonl:55`,
 * `verify` 필드가 이 파일 경로를 정확히 지정 — 이 파일이 GA-55 자체의
 * 행동 검증을 수행한다):
 * - given: 플레이어가 박스 옆 지면에 서 있고 점프 높이가 1.0m(RQ-92), 박스
 *   상단 높이는 1.0m보다 낮으며, 공중 가속은 허용되지 않음.
 * - when: ① 박스 방향으로 이동하며 점프 ② 정지 상태에서 제자리 점프.
 * - then: ①에서는 박스 상단에 착지해 접지 상태가 되고 y가 박스 높이와
 *   같다. ②에서는 박스에 올라서지 못하고 원래 지면으로 돌아온다.
 *
 * **이 파일이 존재하는 이유(RQ-30/F1 선례, 원장 25a-2)**: 순수 함수
 * 계약(`tests/unit/sim-movement-boxes.test.ts`)만으로는 `GameRoom`이
 * 실제로 `PRODUCTION_BOXES`를 `stepMovement`에 상시 주입하는지 어떤
 * 테스트도 관측하지 않는다 — 벽(RQ-30) 때는 그 배선 자체가 고아 상태로
 * 남았던 전례가 있다(평가 FAIL F1, 3rd 인자를 통째로 빼도 518건이 무성으로
 * 통과). 이 파일은 **서버가 확정하는 위치**(공개 스키마 `player.y`)가 실제
 * Colyseus 룸에서 박스를 존중하는지를 관측한다.
 *
 * **가정(coder에게)**: `src/shared/sim/boxes.ts`(그린필드, `sim-movement
 * -boxes.test.ts` docblock이 제안한 것과 동일한 모양)가 `BOX_ALPHA`·
 * `PRODUCTION_BOXES`를 export하고, `GameRoom.stepPlayerMovement`의
 * `stepMovement(previous, input, PRODUCTION_WALLS)` 호출이 4번째 인자로
 * `PRODUCTION_BOXES`를 추가로 받는다(`stepMovement(previous, input,
 * PRODUCTION_WALLS, PRODUCTION_BOXES)`) — 벽이 이미 그렇게 배선된 자리(
 * `GameRoom.ts` 1091행 부근) 바로 옆이다.
 *
 * **좌표(`BOX_ALPHA`를 그대로 임포트 — ADR-0010 값 복제 금지)**:
 * `sim-movement-boxes.test.ts`가 회귀 안전 대역으로 계산한 값을 그대로
 * 프로덕션 후보로 제안하며, 이 파일은 리터럴을 복제하지 않고 그 정본을
 * 가져와 쓴다. 근접면(x=11) 3m 앞(x=8), 박스 z 범위([8,11]) 한가운데
 * (z=9)에서 시작한다 — 전수 조사(정적 배치 리터럴·동적 드리프트·비점프
 * 스윕 전부 재확인)는 `sim-movement-boxes.test.ts` docblock "좌표 선택"
 * 절 참고, 이 파일이 반복하지 않는다.
 *
 * **화이트박스 기법(신규 계약 아님)**: `matchMaker.getLocalRoomById`
 * (`rq-30-wall-collision-wiring.test.ts`·`rq-92-no-air-acceleration
 * .test.ts`가 이미 확립)로 `moveStates`(x·y·z·vx·vy·vz·grounded 7필드,
 * RQ-20 때부터 있던 기존 private map)를 직접 읽는다 — 클라 패치 배치
 * (기본 20Hz)를 거치지 않는 정본이라 배치 지연이 관측 타이밍을 좌우하지
 * 않는다. **`grounded`는 `Player` 공개 스키마에 없다**(21a-2 확정,
 * `GameState.ts` 필드 코멘트 — `grounded===(y===0)` 파생이 안전하다는
 * 전제로 뺐다). 이 라운드는 그 전제를 깨는 라운드이므로(박스 위 착지는
 * y≠0인데 grounded=true) `moveStates.grounded`를 직접 읽는다 — 이미
 * 확립된 화이트박스 기법이지 신규 계약이 아니다(위 두 선례 파일이 이미
 * 이 정확한 방식으로 `grounded`를 관측한다). **이 발견 자체가 보고서
 * §질문 2의 근거다** — `src/client/net/connection.ts:119`의
 * `grounded: player.y === 0` 파생이 이 라운드로 깨진다(별도 절 참고).
 *
 * **이함~착지 경합(원장 22f 선례)**: `jump:true`를 보낸 뒤 서버가 실제로
 * 이를 반영(이륙)했음을 화이트박스로 확인한 **뒤에만** `jump:false`를
 * 보낸다 — 그러지 않으면 `pendingInputs`의 "최근값 유지" 모델에서 두
 * 메시지가 겹쳐 이륙 자체가 사라지는 경합이 있다(`22f-jump-input-loss
 * .test.ts`가 고정한 계약, `rq-18-fall-damage.test.ts`의
 * `waitForServerTakeoff`와 동일 패턴 — 헬퍼를 공유하지 않고 파일별
 * 자기 완결로 재구현한다, 기존 통합 테스트 관례).
 *
 * **①에서 착지 확인 즉시 정지 입력으로 전환한다**: hold(dirX=1)를 착지
 * 이후에도 무한정 유지하면 결국 박스 원면을 넘어 걸어 나가는데, 그건
 * "박스 가장자리에서 내려오기"라는 별도 스코프다(`sim-movement-boxes
 * .test.ts` docblock 참고, team-lead 지시로 이 라운드가 다루지 않는다).
 * 착지가 확인되는 즉시 `dirX:0`으로 전환해 그 자리에 머물게 한 뒤, 그
 * 상태로 y가 유지되는지(1틱 반짝임이 아닌지)만 짧은 창으로 관찰한다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다
 * (ADR-0008 허용 예외, 기존 RQ-18/30/92 통합 테스트와 동일). 모든 대기에
 * `timeoutMs` 상한을 강제한다.
 *
 * **스코프 밖**: 박스 옆면 수평 차단 여부(걸어서 접근할 때 멈추는가)는
 * 이 파일이 시험하지 않는다 — GA-55는 두 경우 다 점프를 전제한다(보고서
 * §질문 1). 가장자리 낙하·낙하 데미지 상호작용·사격 차폐·다중 박스는
 * team-lead가 명시적으로 비스코프 처리했다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
/** 서버 화이트박스 상태 폴링 간격 — 기존 통합 테스트 관례와 동일 값. */
const SERVER_POLL_INTERVAL_MS = 15
/** 화이트박스 텔레포트 후 반영 대기(`rq-30-wall-collision-wiring.test.ts`
 * `BASELINE_TIMEOUT_MS`와 동일 근거). */
const BASELINE_TIMEOUT_MS = 3_000
/** `jump:true` 전송 뒤 서버가 실제로 이를 반영(이륙)했는지 확인하는 상한
 * — `rq-18-fall-damage.test.ts` `TAKEOFF_CONFIRM_TIMEOUT_MS`와 동일 근거. */
const TAKEOFF_CONFIRM_TIMEOUT_MS = 5_000
/** 착지 관측 상한 — 현재 구현(g=20)에서 자연 비행은 ≈632ms, hold 구간을
 * 그보다 넉넉히 잡은 이 라운드에서도 넉넉한 여유(`rq-18-fall-damage
 * .test.ts`의 `LANDING_OBSERVE_TIMEOUT_MS`와 동일 수준). */
const LANDING_OBSERVE_TIMEOUT_MS = 10_000
/** 착지 후 "정지 상태에서도 y가 유지되는가"(1틱 반짝임 아님) 관찰 창. */
const SETTLE_OBSERVE_MS = 400

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

/** 화이트박스 접근 대상 계약 — `moveStates`는 RQ-20 때부터 있던 기존
 * private map(신규 아님, 위 docblock 참고). `state.players`(공개 스키마)는
 * `y` 필드가 이미 존재한다(`grounded`는 없다 — 위 docblock 참고). */
interface BoxJumpSeam {
  moveStates: Map<string, MoveState>
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number } | undefined
    }
  }
}

function getServerRoom(room: Room): BoxJumpSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as BoxJumpSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-22 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** GA-55 given의 공유 시작점 — `sim-movement-boxes.test.ts`와 동일 좌표
 * (박스 근접면 3m 앞, 박스 z범위 한가운데). */
const START_X_M = BOX_ALPHA.minX - 3
const START_Z_M = (BOX_ALPHA.minZ + BOX_ALPHA.maxZ) / 2

function placePlayer(seam: BoxJumpSeam, sessionId: string, position: { x: number; z: number }): void {
  seam.moveStates.set(sessionId, { x: position.x, y: 0, z: position.z, vx: 0, vy: 0, vz: 0, grounded: true })
}

function readMoveState(seam: BoxJumpSeam, sessionId: string): MoveState | undefined {
  return seam.moveStates.get(sessionId)
}

function waitForMoveStateCondition(
  seam: BoxJumpSeam,
  sessionId: string,
  predicate: (s: MoveState) => boolean,
  label: string,
  timeoutMs: number,
): Promise<MoveState> {
  return new Promise<MoveState>((resolve, reject) => {
    const tryResolve = (): boolean => {
      const current = readMoveState(seam, sessionId)
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

function sampleMoveStateOverWindow(seam: BoxJumpSeam, sessionId: string, windowMs: number): Promise<MoveState[]> {
  return new Promise<MoveState[]>((resolve) => {
    const samples: MoveState[] = []
    const interval = setInterval(() => {
      const current = readMoveState(seam, sessionId)
      if (current) samples.push(current)
    }, SERVER_POLL_INTERVAL_MS)
    setTimeout(() => {
      clearInterval(interval)
      resolve(samples)
    }, windowMs)
  })
}

/** `jump:true` 전송 뒤 서버가 실제로 이를 반영(이륙)했음을 화이트박스로
 * 확인한다 — `rq-18-fall-damage.test.ts`/`rq-92-fall-damage-curve.test.ts`
 * 의 `waitForServerTakeoff`와 동일 이유·동일 패턴(원장 22f 경합 회피). */
async function waitForServerTakeoff(seam: BoxJumpSeam, sessionId: string, label: string): Promise<void> {
  await waitForMoveStateCondition(seam, sessionId, (s) => s.grounded === false, label, TAKEOFF_CONFIRM_TIMEOUT_MS)
}

describe('RQ-22 박스 점프 — 프로덕션 배선(GA-55): 서버가 확정하는 위치가 박스 등반을 반영한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'GA-55①: 박스 방향으로 이동하며 점프하면 박스 상단에 착지해 접지 상태가 되고, y가 박스 높이(topY)와 같다 — 착지 후에도 유지된다',
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)
      const sessionId = room.sessionId

      try {
        placePlayer(seam, sessionId, { x: START_X_M, z: START_Z_M })
        await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => Math.abs(s.x - START_X_M) < 1e-6 && s.grounded,
          'RQ-22: 화이트박스 순간이동 반영 대기',
          BASELINE_TIMEOUT_MS,
        )

        // 이함 — 박스 방향(dirX=1) + 점프.
        room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: true })
        await waitForServerTakeoff(seam, sessionId, 'RQ-22①: 이함 반영 대기')

        // 확인 후에만 jump:false(유지 입력)로 전환 — 착지 후 재이륙(버니합) 방지.
        room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })

        const landed = await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => s.grounded === true,
          'RQ-22①: 박스 상단 착지(재접지) 대기',
          LANDING_OBSERVE_TIMEOUT_MS,
        )

        // then — 접지 상태가 되고 y가 박스 높이와 같다(맨 지면 0이 아니다).
        expect(landed.y).toBeCloseTo(BOX_ALPHA.topY, 6)
        expect(landed.y).not.toBeCloseTo(0, 6)
        // 실제로 박스 XZ 범위 위에서 착지했다.
        expect(landed.x).toBeGreaterThanOrEqual(BOX_ALPHA.minX - 1e-6)
        expect(landed.x).toBeLessThanOrEqual(BOX_ALPHA.maxX + 1e-6)

        // 착지 확인 즉시 정지 — 가장자리까지 걸어 나가지 않는다(별도 스코프, 위 docblock 참고).
        room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })

        // 접지 지속 — 정지 상태에서도 y가 계속 박스 높이다(1틱 반짝임이 아니다).
        const settled = await sampleMoveStateOverWindow(seam, sessionId, SETTLE_OBSERVE_MS)
        expect(settled.length).toBeGreaterThan(0)
        for (const s of settled) {
          expect(s.grounded).toBe(true)
          expect(s.y).toBeCloseTo(BOX_ALPHA.topY, 6)
        }

        // 공개 스키마(player.y)도 같은 값을 확정한다 — moveStates(정본)와
        // Player 스키마(브로드캐스트 대상) 사이의 배선(`stepPlayerMovement`의
        // `player.y = next.y`)까지 관측한다.
        const publicPlayer = seam.state.players.get(sessionId)
        expect(publicPlayer?.y).toBeCloseTo(BOX_ALPHA.topY, 6)

        await leaveRoom(room)
      } catch (err) {
        await leaveRoom(room).catch(() => undefined)
        throw err
      }
    },
    30_000,
  )

  it(
    'GA-55②: 정지 상태에서 제자리 점프하면 박스에 올라서지 못하고 원래 지면(y=0)으로 돌아온다',
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)
      const sessionId = room.sessionId

      try {
        placePlayer(seam, sessionId, { x: START_X_M, z: START_Z_M })
        await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => Math.abs(s.x - START_X_M) < 1e-6 && s.grounded,
          'RQ-22: 화이트박스 순간이동 반영 대기',
          BASELINE_TIMEOUT_MS,
        )

        // 이함 — 수평 입력 없이(dirX=dirZ=0) 점프만.
        room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: true })
        await waitForServerTakeoff(seam, sessionId, 'RQ-22②: 이함 반영 대기')

        room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })

        const landed = await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => s.grounded === true,
          'RQ-22②: 원래 지면 재접지 대기',
          LANDING_OBSERVE_TIMEOUT_MS,
        )

        // then — 박스에 올라서지 못하고 원래 지면으로 돌아온다.
        expect(landed.y).toBeCloseTo(0, 6)
        expect(landed.y).not.toBeCloseTo(BOX_ALPHA.topY, 6)
        // 수평 관성이 없어 애초에 박스 XZ 범위 안으로 들어가지도 않았다.
        expect(landed.x).toBeCloseTo(START_X_M, 6)
        expect(landed.z).toBeCloseTo(START_Z_M, 6)
        expect(landed.x).toBeLessThan(BOX_ALPHA.minX) // 박스 근접면에 못 미친다(전제 확인)

        await leaveRoom(room)
      } catch (err) {
        await leaveRoom(room).catch(() => undefined)
        throw err
      }
    },
    20_000,
  )
})
