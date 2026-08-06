import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { LADDER_ALPHA } from '@shared/sim/ladders'
import { PLATFORM_ALPHA } from '@shared/sim/platforms'

/**
 * RQ-33 고지대 플랫폼 — **프로덕션 배선** 통합 테스트. 골든 **GA-59·
 * GA-60**(`harness/evals/golden/track-a-product.jsonl`, `verify` 필드가
 * 이 파일 경로를 정확히 지정 — 이 파일이 두 골든 자체의 행동 검증을
 * 수행한다):
 *
 * - **GA-59**: given 플레이어가 사다리 하단 볼륨 안에 서 있는 상태 / when
 *   등반 법선 방향으로 이동 입력을 유지 / then 플랫폼 윗면 높이(4m)에
 *   도달해 서 있고, 사다리를 벗어나도 낙하하지 않는다.
 * - **GA-60**: given 플레이어가 플랫폼 측면에 인접해 지면에 서 있는 상태 /
 *   when 점프를 반복 / then 플랫폼 윗면에 오르지 못하고 지면 높이로
 *   되돌아온다.
 *
 * **이 파일이 존재하는 이유(RQ-21/RQ-22 선례)**: 순수 함수 계약
 * (`tests/unit/rq-33-platform-geometry.test.ts`)만으로는 `GameRoom`이
 * 실제로 플랫폼을 `stepMovement`의 지오메트리 인자에 상시 주입하는지
 * 어떤 테스트도 관측하지 않는다 — 벽·박스·사다리 때 그 배선 자체가 고아
 * 상태로 남았던 전례가 각각 있다(평가 FAIL, `1170aab` 등). 이 파일은
 * **서버가 확정하는 위치**(공개 스키마 `player.y`·`player.grounded`)가
 * 실제 Colyseus 룸에서 플랫폼을 존중하는지를 관측한다.
 *
 * **가정(coder에게)**: `src/shared/sim/platforms.ts`(그린필드)가
 * `PLATFORM_ALPHA`·`PLATFORM_BRAVO`·`PRODUCTION_PLATFORMS`를 export하고
 * (정확한 shape은 `tests/unit/rq-33-platform-geometry.test.ts` 상단
 * docblock 참고, 이 파일이 반복하지 않는다), `@shared/sim/ladders`의
 * `LADDER_ALPHA`/`LADDER_BRAVO`가 z 폭 3m→1.5m로 좁아지며(같은 문서
 * 참고), `GameRoom.stepPlayerMovement`(및 `prediction.ts`)에 상시
 * 주입되는 지오메트리가 플랫폼을 `boxesBlockingAt`/`standingHeight`가
 * 보는 박스 목록에 포함한다(`PRODUCTION_BOXES` 자체에 합치지는 않는다 —
 * GA-53 위반, 같은 문서 "회귀 안전 대역" 참고).
 *
 * **화이트박스 기법(`moveStates`, 신규 계약 아님)**: `matchMaker
 * .getLocalRoomById`(`rq-21-ladder-vertical-movement.test.ts`·`rq-22-box
 * -jump.test.ts`가 이미 확립)로 `moveStates`(x·y·z·vx·vy·vz·grounded
 * 7필드, RQ-20 때부터 있던 기존 private map)를 직접 읽는다 — 클라 패치
 * 배치(기본 20Hz)를 거치지 않는 정본이라 배치 지연이 관측 타이밍을
 * 좌우하지 않는다. `grounded`는 RQ-22 라운드부터 공개 스키마(`state
 * .players`)에도 있으므로 정본과 공개 스키마 둘 다 확인한다.
 *
 * **GA-59 given을 문자 그대로 재현한다**: "사다리 하단 볼륨 안에 서 있는
 * 상태" — 사다리의 최하단(`LADDER_ALPHA.minY`, 지면과 같은 높이)에
 * 화이트박스로 배치한다(`rq-21-ladder-vertical-movement.test.ts`의
 * "걸어서 진입" 재현과 달리, GA-59의 given 자체가 "이미 볼륨 안"이므로
 * 걸어서 접근하는 단계는 필요 없다 — `sim-movement-ladders.test.ts`의
 * `createLadderState` 관례와 동일하게 이미 볼륨 안인 상태에서 시작한다).
 * "등반 법선 방향으로 이동 입력을 유지"는 `LADDER_ALPHA.normalX/normalZ`를
 * 그대로 방향 입력으로 써서(리터럴 하드코딩 금지, ADR-0010) 표현한다 —
 * 사다리를 다 오른 뒤에도 **같은 입력을 계속 유지**하는 것이 골든 문면
 * 그대로다(중간에 입력을 바꾸지 않는다).
 *
 * **GA-60 given을 문자 그대로 재현한다**: "플랫폼 측면에 인접해 지면에
 * 서 있는 상태" — 사다리가 붙어 있지 않은 면(동쪽, `PLATFORM_ALPHA
 * .maxX`)에 인접 배치한다(사다리가 있는 서쪽 면을 쓰면 GA-59와
 * 관심사가 겹친다 — "점프로 도달할 수 없다"는 사다리 유무와 무관하게
 * 모든 면에서 성립해야 하므로, 사다리 없는 면에서 검증하는 편이 이
 * 골든의 의도(점프·박스 등반으로는 어느 쪽에서도 못 오른다)에 더
 * 가깝다). 근접면 3m 앞(`sim-movement-boxes.test.ts`/`rq-22-box-jump
 * .test.ts`의 "근접면 3m 앞" 관례)에서 이동+점프를 반복한다 — 정지
 * 상태 제자리 점프보다 강한 시도(이동하며 점프하면 수평 관성으로 더 멀리
 * 도달할 수 있으므로, 이 강한 시도조차 실패해야 "점프로는 도달할 수
 * 없다"는 것이 확실히 증명된다).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * §5 허용 예외, 기존 RQ-18/21/22/30/92 통합 테스트와 동일). 모든 대기에
 * `timeoutMs` 상한을 강제한다.
 *
 * **스코프 밖**: 플랫폼의 시각 표현, 플랫폼 위 사격/차폐 상호작용,
 * BRAVO 플랫폼의 개별 재현(구조적 대칭성은
 * `rq-33-platform-geometry.test.ts`가 두 사다리 전부에 대해 이미
 * 전수 확인한다) — 이 파일이 시험하지 않는다.
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
/** 등반 시작 확인 + 플랫폼 도달까지 관측 상한 — 사다리 40틱(≈1.33s) 등반
 * + 이탈·전이에 필요한 여유를 넉넉히 얹었다(구현이 정확히 몇 틱을 쓰는지
 * 이 라운드가 강제하지 않는다, ADR-0010 "구현 방식을 규정하지 않는다" 정신). */
const REACH_OBSERVE_TIMEOUT_MS = 15_000
/** `jump:true` 전송 뒤 서버가 실제로 이를 반영(이륙)했는지 확인하는 상한
 * — `rq-22-box-jump.test.ts` `TAKEOFF_CONFIRM_TIMEOUT_MS`와 동일 근거. */
const TAKEOFF_CONFIRM_TIMEOUT_MS = 5_000
/** 착지(재접지) 관측 상한 — `rq-22-box-jump.test.ts`
 * `LANDING_OBSERVE_TIMEOUT_MS`와 동일 근거. */
const LANDING_OBSERVE_TIMEOUT_MS = 10_000
/** 정지 상태에서 y가 유지되는지(1틱 반짝임·재낙하 아님) 관찰하는 창. */
const SETTLE_OBSERVE_MS = 500

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
 * private map(신규 아님). `state.players`(공개 스키마)의 `grounded`는
 * RQ-22 라운드부터 있다(둘 다 기존 통합 테스트와 동일 계약, 새로
 * 발명하지 않는다). */
interface PlatformReachSeam {
  moveStates: Map<string, MoveState>
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number; grounded?: boolean } | undefined
    }
  }
}

function getServerRoom(room: Room): PlatformReachSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as PlatformReachSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-33 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function placePlayer(seam: PlatformReachSeam, sessionId: string, position: { x: number; y: number; z: number }): void {
  seam.moveStates.set(sessionId, { x: position.x, y: position.y, z: position.z, vx: 0, vy: 0, vz: 0, grounded: true })
}

function readMoveState(seam: PlatformReachSeam, sessionId: string): MoveState | undefined {
  return seam.moveStates.get(sessionId)
}

function waitForMoveStateCondition(
  seam: PlatformReachSeam,
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

function sampleMoveStateOverWindow(seam: PlatformReachSeam, sessionId: string, windowMs: number): Promise<MoveState[]> {
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
 * 확인한다 — `rq-22-box-jump.test.ts`의 `waitForServerTakeoff`와 동일
 * 이유·동일 패턴(원장 22f 경합 회피, jump:false를 너무 일찍 보내면
 * 이함 자체가 사라진다). */
async function waitForServerTakeoff(seam: PlatformReachSeam, sessionId: string, label: string): Promise<void> {
  await waitForMoveStateCondition(seam, sessionId, (s) => s.grounded === false, label, TAKEOFF_CONFIRM_TIMEOUT_MS)
}

describe('RQ-33 플랫폼 도달(GA-59): 사다리 하단 볼륨 안에서 등반 법선 방향 입력을 유지하면 플랫폼 윗면에 도달해 서고, 낙하하지 않는다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  const LADDER_CENTER_X = (LADDER_ALPHA.minX + LADDER_ALPHA.maxX) / 2
  const LADDER_CENTER_Z = (LADDER_ALPHA.minZ + LADDER_ALPHA.maxZ) / 2
  /** 등반 법선 방향 입력 — `LADDER_ALPHA.normalX/normalZ`에서 유도한다
   * (리터럴 하드코딩 금지, ADR-0010). */
  const CLIMB_TOWARD_FACE = { dirX: LADDER_ALPHA.normalX, dirZ: LADDER_ALPHA.normalZ, mode: 'run' as const, jump: false }
  /** 실제로 상승이 시작됐다고 볼 수 있는 임계고도 — 걸어 들어오는 단계가
   * 없는 이 시나리오에서도(GA-59 given이 이미 "볼륨 안") `sim-movement
   * -ladders.test.ts`/`rq-21-ladder-vertical-movement.test.ts`와 동일한
   * 여유(0.3m ≈ 3틱)를 둔다. */
  const ASCEND_CONFIRM_Y_M = 0.3

  it(
    'GA-59: 사다리 최하단에서 등반 입력을 유지하면 y가 플랫폼 윗면(topY)에 도달해 접지 상태로 안정되고, 그 뒤로도 낙하하지 않는다',
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)
      const sessionId = room.sessionId

      try {
        // given — 사다리 하단 볼륨 안에 서 있음.
        placePlayer(seam, sessionId, { x: LADDER_CENTER_X, y: LADDER_ALPHA.minY, z: LADDER_CENTER_Z })
        await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => Math.abs(s.y - LADDER_ALPHA.minY) < 1e-6 && s.grounded,
          'RQ-33: 화이트박스 순간이동(사다리 하단) 반영 대기',
          BASELINE_TIMEOUT_MS,
        )

        // when — 등반 법선 방향 입력을 유지(이후 계속 같은 입력).
        room.send('move', CLIMB_TOWARD_FACE)

        // 중간 체크포인트 — 실제로 사다리를 오르기 시작했다(전제 확인,
        // 아래 "플랫폼 도달" 단언이 우연히 통과하는 경로를 배제).
        const climbing = await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => s.y >= ASCEND_CONFIRM_Y_M,
          'RQ-33: 등반 시작 대기',
          REACH_OBSERVE_TIMEOUT_MS,
        )
        expect(climbing.grounded).toBe(true)

        // then — 플랫폼 윗면 높이에 도달해 접지 상태로 선다.
        const onPlatform = await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => s.grounded === true && s.y >= PLATFORM_ALPHA.topY - 1e-6,
          'RQ-33: 플랫폼 윗면 도달 대기',
          REACH_OBSERVE_TIMEOUT_MS,
        )
        expect(onPlatform.y).toBeCloseTo(PLATFORM_ALPHA.topY, 6)
        // 실제로 플랫폼의 XZ 범위 위에서 서 있다(사다리 자신의 좌표에
        // 멈춰 있는 것이 아니다 — 사다리는 플랫폼 footprint 밖이다).
        expect(onPlatform.x).toBeGreaterThanOrEqual(PLATFORM_ALPHA.minX - 1e-6)
        expect(onPlatform.x).toBeLessThanOrEqual(PLATFORM_ALPHA.maxX + 1e-6)
        expect(onPlatform.z).toBeGreaterThanOrEqual(PLATFORM_ALPHA.minZ - 1e-6)
        expect(onPlatform.z).toBeLessThanOrEqual(PLATFORM_ALPHA.maxZ + 1e-6)

        // then(마지막 문장) — 사다리를 벗어나도 낙하하지 않는다: 정지
        // 상태에서도 y가 플랫폼 높이에 그대로 유지된다(1틱 반짝임도,
        // 뒤늦은 재낙하도 아니다).
        const settled = await sampleMoveStateOverWindow(seam, sessionId, SETTLE_OBSERVE_MS)
        expect(settled.length).toBeGreaterThan(0)
        for (const s of settled) {
          expect(s.grounded).toBe(true)
          expect(s.y).toBeCloseTo(PLATFORM_ALPHA.topY, 6)
        }

        // 공개 스키마도 같은 값을 확정한다(정본-스키마 배선 확인).
        const finalPublic = seam.state.players.get(sessionId)
        expect(finalPublic?.grounded).toBe(true)
        expect(finalPublic?.y).toBeCloseTo(PLATFORM_ALPHA.topY, 6)

        await leaveRoom(room)
      } catch (err) {
        await leaveRoom(room).catch(() => undefined)
        throw err
      }
    },
    30_000,
  )
})

describe('RQ-33 플랫폼 도달 불가(GA-60): 플랫폼 측면(사다리 없는 면)에 인접해 이동+점프를 반복해도 오르지 못하고 지면 높이로 되돌아온다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  /** 사다리가 붙어 있지 않은 동쪽 면(`PLATFORM_ALPHA.maxX`) 근접면 3m
   * 앞에서 접근한다 — `sim-movement-boxes.test.ts`/`rq-22-box-jump
   * .test.ts`의 "근접면 3m 앞" 관례. */
  const START_X_M = PLATFORM_ALPHA.maxX + 3
  const START_Z_M = (PLATFORM_ALPHA.minZ + PLATFORM_ALPHA.maxZ) / 2
  /** 플랫폼을 향해(서쪽) 이동하며 점프 — 정지 상태 제자리 점프보다 강한
   * 시도(수평 관성으로 더 멀리 도달할 수 있다). */
  const APPROACH_AND_JUMP = { dirX: -1, dirZ: 0, mode: 'run' as const, jump: true }
  const HOLD_APPROACH = { dirX: -1, dirZ: 0, mode: 'run' as const, jump: false }
  /** 반복 횟수 — GA-60의 "점프를 반복"을 문자 그대로 재현하면서, 시도가
   * 누적돼도 결과가 달라지지 않는지(매번 동일하게 실패하는지) 확인한다. */
  const REPEAT_ATTEMPTS = 3

  it(
    'GA-60: 이동+점프를 여러 번 반복해도 매번 플랫폼 윗면에 오르지 못하고 지면 높이로 되돌아온다',
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)
      const sessionId = room.sessionId

      try {
        for (let attempt = 0; attempt < REPEAT_ATTEMPTS; attempt += 1) {
          // given(매 시도마다 재확인) — 플랫폼 측면에 인접해 지면에 서 있음.
          placePlayer(seam, sessionId, { x: START_X_M, y: 0, z: START_Z_M })
          await waitForMoveStateCondition(
            seam,
            sessionId,
            (s) => Math.abs(s.x - START_X_M) < 1e-6 && s.grounded,
            `RQ-33/GA-60 시도${attempt}: 화이트박스 순간이동 반영 대기`,
            BASELINE_TIMEOUT_MS,
          )

          // when — 플랫폼 방향 이동 + 점프.
          room.send('move', APPROACH_AND_JUMP)
          await waitForServerTakeoff(seam, sessionId, `RQ-33/GA-60 시도${attempt}: 이함 반영 대기`)

          // 이함 즉시 확인 — 이 순간에도 아직 플랫폼 높이 근처에도 못 미친다.
          const airborne = readMoveState(seam, sessionId)!
          expect(airborne.y).toBeLessThan(PLATFORM_ALPHA.topY)

          // 이함 확인 후에만 jump:false로 전환(원장 22f 경합 회피).
          room.send('move', HOLD_APPROACH)

          const landed = await waitForMoveStateCondition(
            seam,
            sessionId,
            (s) => s.grounded === true,
            `RQ-33/GA-60 시도${attempt}: 재접지 대기`,
            LANDING_OBSERVE_TIMEOUT_MS,
          )

          // then — 플랫폼 윗면에 오르지 못하고 지면 높이로 되돌아온다.
          expect(landed.y).toBeCloseTo(0, 6)
          expect(landed.y).not.toBeCloseTo(PLATFORM_ALPHA.topY, 1)
          // 플랫폼의 XZ 범위 안으로 들어가지 못했다(옆면에 막혔다 —
          // RQ-22 박스 옆면 차단과 동일 성질, `boxesBlockingAt`).
          expect(landed.x).toBeGreaterThanOrEqual(PLATFORM_ALPHA.maxX - 1e-6)

          // 공개 스키마도 같은 결론을 확정한다.
          const landedPublic = seam.state.players.get(sessionId)
          expect(landedPublic?.grounded).toBe(true)
          expect(landedPublic?.y).toBeCloseTo(0, 6)
        }

        await leaveRoom(room)
      } catch (err) {
        await leaveRoom(room).catch(() => undefined)
        throw err
      }
    },
    60_000,
  )
})
