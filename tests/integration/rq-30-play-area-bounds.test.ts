import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { MOVEMENT, WORLD } from '@shared/constants'

/**
 * RQ-30 월드 경계 클램프 — 통합 테스트 (ADR-0008: `src/shared` 판정 로직
 * Red-first 영역 — 클램프는 `stepMovement`(`@shared/sim/movement`) 안에
 * 들어가야 매 틱 `player.x/y/z`(공개 스키마)에 반영된다, `GameRoom.ts`
 * `stepPlayerMovement` 968~1072행 실측 확인).
 *
 * RQ-30 전문(`harness/specs/requirements.md:107-110`): "시스템은 오리지널
 * 맵 1종을 제공해야 한다. 플레이 면적은 약 60×60m(소형)이다. ..."
 *
 * 매핑된 골든 케이스 **GA-50**(`verify` 필드가 이 파일 경로를 정확히 지정,
 * `harness/evals/golden/track-a-product.jsonl`):
 * - given: 플레이어가 플레이 면적(60×60m) 경계 근처 지면에 서 있음
 * - when: 경계 바깥 방향으로 이동 입력을 지속해서 보냄
 * - then: 서버가 확정하는 위치의 x·z가 항상 ±30m 안에 머문다 — 경계를 넘어
 *   월드 밖으로 나갈 수 없다.
 *
 * **현재 상태(팀리드 확인, grep 실측)**: `src/shared/sim/movement.ts`에
 * 좌표 클램프가 없다(`clampDirection`은 입력 방향 정규화이지 위치 클램프가
 * 아니다). 경계 밖으로 계속 이동하면 위치가 무한히 커진다 — 이 파일의
 * 핵심 단언(항상 ±30m 안)은 오늘 코드베이스에서 **실패한다**(Red).
 *
 * **값의 정본(ADR-0010 값 복제 금지)**: 월드 경계는 `WORLD.SIZE_M`(=60)에서
 * `HALF_WORLD_M = WORLD.SIZE_M / 2`로 유도한다 — ±30을 하드코딩하지 않는다.
 *
 * **레벨 선택(ADR-0008)**: 클램프 산술 자체는 순수 로직이지만, GA-50의
 * `verify` 필드가 이 통합 경로를 명시하고 팀리드도 이 경로를 지정했다 —
 * "서버가 확정하는 위치"(공개 스키마, 다른 플레이어에게도 브로드캐스트되는
 * 값)가 실제 Colyseus 룸 경계에서 항상 유지되는지가 골든의 관찰 대상이기
 * 때문이다(`rq-61-server-authoritative-position.test.ts`와 같은 이유로
 * 서버 권위 계열은 통합 레벨에서도 확인한다). 클램프 산술의 미시적 정밀도를
 * 순수 함수로 별도 검증하는 단위 테스트는 이 파일의 책임이 아니다(그런
 * 테스트가 필요하면 `tests/unit/sim-movement.test.ts`가 별도로 다룬다).
 *
 * **설계 의도적 결정 — "어떻게 멈추는가"를 못박지 않는다**: RQ-30/GA-50은
 * "±30m 안에 머문다"만 요구하고 정지 방식(하드 클램프·슬라이드·반발)은
 * 규정하지 않는다. 이 파일은 그래서 경계에서 좌표가 **정확히** ±30.000...에
 * 닿는다고 단언하지 않는다 — "항상 그 범위 **안**"(`<=`/`>=` 부등식)과
 * "붙어서 못 움직이는 것은 아니다"(안쪽 이동이 실제로 반영된다)만 단언한다.
 * 스펙이 답하지 않는 "정확한 정지 지점"까지 못박으면 구현 방식을 과도하게
 * 규정하게 된다.
 *
 * **RQ-31 Safe Zone과 무관**: 이 파일은 이동(위치)만 다루고 사격을 전혀
 * 쓰지 않는다 — Safe Zone은 피해 무효화·사격 불가만 규정하므로(RQ-31)
 * 이동 클램프와 직교한다. `tests/support/safe-zone.ts`의 헬퍼를 쓰지
 * 않는다(테스트 시작 좌표는 화이트박스로 직접 지정하며 스폰 지점의 Safe
 * Zone 반경과 무관한 좌표를 쓴다).
 *
 * **⚠️ 회귀 주의(원장 25r, 팀리드 지시로 조사·보고만 함 — 이 파일이 고치지
 * 않는다)**: `tests/support/safe-zone.ts`의
 * `DEFAULT_SAFE_ZONE_ESCAPE_OFFSET_M`(현재 19, Safe Zone 반경 4 + 15)은
 * 스폰 지점(반지름 22 원 위)을 반지름 41까지 방사 이동시킨다 — 이 클램프가
 * 들어오면 41 > 30(`HALF_WORLD_M`)이라 **다음 서버 틱에 즉시 30으로
 * 되접힌다**. `tests/`에서 `safe-zone` 참조 24파일, `escapeSafeZone`/
 * `ESCAPE_OFFSET` 참조 17파일이 이 헬퍼에 의존한다(grep 실측, 이 커밋
 * 시점 기준). 조사 결과와 대안 오프셋 후보는
 * `_workspace/RQ-30/01_test-writer_red.md`에 근거와 함께 남긴다 — 실제
 * 수정은 Green 단계(coder)의 몫이다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트) + 서버의 실제 30Hz
 * `setSimulationInterval` 틱 루프에 의존한다(ADR-0008 허용 예외 — 기존
 * RQ-20/61/64 등 통합 테스트와 동일). 모든 대기에 상한을 강제한다. 위치는
 * 화이트박스(`matchMaker.getLocalRoomById`, `rq-18-fall-damage.test.ts`·
 * `rq-61-server-authoritative-position.test.ts`가 이미 확립한 기법)로
 * 서버 자신의 `moveStates`·`state.players`를 직접 읽고 쓴다 — 클라이언트
 * 패치 배치 지연과 무관한 정본 관측이다(`escapeSafeZone`과 동일하게
 * `moveStates`만 화이트박스로 쓰고, 공개 스키마는 서버의 다음 틱
 * (`stepPlayerMovement`)이 자연스럽게 반영하도록 둔다).
 *
 * **경계·속도 근거(실측)**: `MOVEMENT.SPEED`(6m/s, RQ-92 `'run'`) ×
 * `NET.TICK_MS`(≈33.33ms) ≈ 틱당 0.2m. 경계에서 1m 안쪽(`NEAR_BOUNDARY_
 * START_MARGIN_M`)에서 출발해 600ms(≈18틱, `SUSTAINED_PUSH_WINDOW_MS`)
 * 지속 입력을 주면 클램프가 없는 오늘 코드베이스는 좌표가 30을 훌쩍
 * 넘긴다(실측 여유 — 첫 메시지 왕복 지연을 감안해도 남은 시간만으로 1m를
 * 넘어서기에 충분하다) — Red 신호가 타이밍 지터에 묻히지 않는다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const BASELINE_TIMEOUT_MS = 3_000
/** 서버 화이트박스 상태 폴링 간격 — 기존 통합 테스트(`rq-61-server
 * -authoritative-position.test.ts` `SERVER_POLL_INTERVAL_MS`)와 동일 값·
 * 동일 근거. */
const SERVER_POLL_INTERVAL_MS = 15

/** 월드 경계(RQ-30) — `WORLD.SIZE_M`(60)에서 유도, 하드코딩 금지(ADR-0010). */
const HALF_WORLD_M = WORLD.SIZE_M / 2
/** 부동소수점 누적 오차 허용치 — 18틱 가산 후에도 1e-6 안이면 충분히 엄격하다. */
const BOUNDARY_TOLERANCE_M = 1e-6
/** "경계 근처"(GA-50 given) 출발 지점 — 경계에서 1m 안쪽. */
const NEAR_BOUNDARY_START_MARGIN_M = 1
const START_COORD_M = HALF_WORLD_M - NEAR_BOUNDARY_START_MARGIN_M // 29

/** 지속 바깥쪽 입력 관측 창 — ≈18틱(파일 상단 "경계·속도 근거" 참고). */
const SUSTAINED_PUSH_WINDOW_MS = 600
/** 안쪽 이동 관측 창(경계에서 멈춘 뒤 자유 이동 확인). */
const INWARD_RETURN_WINDOW_MS = 500
/** 경계에서 먼 곳 양성 대조군 관측 창. */
const FAR_FROM_BOUNDARY_WINDOW_MS = 500

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

/** 테스트 프로세스 안에서 실 포트(임의 바인딩)로 서버를 기동한다. */
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
  // consented=true — 정상적인 접속 종료(비정상 단절이 아니다).
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

/** 서버 `MoveState`의 화이트박스 쓰기에 필요한 최소 형태 — `tests/support
 * /safe-zone.ts`의 동명 인터페이스와 동일 형태(그린필드가 아니다, 기존
 * private `moveStates` 필드 값). */
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

/** 화이트박스 접근 대상 계약 — `moveStates`(위치 시뮬레이션 정본, 다음
 * 틱의 `previous`)와 `state.players`(공개 스키마, 다른 플레이어에게도
 * 브로드캐스트되는 "서버가 확정하는 위치") 양쪽. */
interface BoundsTestSeam {
  moveStates: Map<string, MoveState>
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number } | undefined
    }
  }
}

/** `matchMaker.getLocalRoomById`(`rq-18-fall-damage.test.ts`·`rq-61
 * -server-authoritative-position.test.ts`가 이미 확립한 기법)로 테스트
 * 프로세스 안에서 실행 중인 실제 `GameRoom` 인스턴스를 얻는다. */
function getServerRoom(room: Room): BoundsTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as BoundsTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-30 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function readServerPosition(seam: BoundsTestSeam, sessionId: string): HorizontalPosition | undefined {
  const p = seam.state.players.get(sessionId)
  if (typeof p?.x === 'number' && typeof p?.z === 'number') {
    return { x: p.x, z: p.z }
  }
  return undefined
}

/** `moveStates`만 화이트박스로 덮어쓴다(`escapeSafeZone`과 동일한 관례 —
 * 공개 스키마는 건드리지 않고, 서버의 다음 틱이 자연스럽게 반영하도록
 * 둔다). 접지(y=0)·정지(vx=vy=vz=0) 상태로 순간이동시킨다. */
function placePlayer(seam: BoundsTestSeam, sessionId: string, position: HorizontalPosition): void {
  seam.moveStates.set(sessionId, { x: position.x, y: 0, z: position.z, vx: 0, vy: 0, vz: 0, grounded: true })
}

/** 서버 자체 상태(화이트박스)를 폴링해 조건을 기다린다. */
function waitForServerCondition(
  seam: BoundsTestSeam,
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

/** `windowMs` 동안 서버 자체 상태를 `SERVER_POLL_INTERVAL_MS` 간격으로
 * 반복 샘플링한다 — "항상 ±30m 안"(GA-50 then)을 마지막 값 하나가 아니라
 * 관측 구간 전체에서 확인하기 위해서다. */
function sampleServerPositionOverWindow(
  seam: BoundsTestSeam,
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

/** 배열의 마지막 원소 — `noUncheckedIndexedAccess`(tsconfig strict) 때문에
 * `arr[arr.length - 1]`는 `T | undefined`로 좁혀지지 않는다. 빈 배열이면
 * (관측 구간 안에 폴링이 한 번도 못 돈 비정상 상황) 조용히 `undefined`를
 * 넘기는 대신 즉시 명확한 에러로 실패시킨다. */
function lastSample<T>(samples: T[]): T {
  const last = samples[samples.length - 1]
  if (last === undefined) {
    throw new Error('RQ-30: 관측 구간 동안 샘플이 한 건도 수집되지 않았다')
  }
  return last
}

/** 관측 구간 전체에서 x·z가 항상 [-HALF_WORLD_M, HALF_WORLD_M] 안인지
 * 단언한다(GA-50 then 핵심 문구). */
function expectAlwaysWithinWorldBounds(samples: HorizontalPosition[]): void {
  expect(samples.length).toBeGreaterThan(0)
  for (const s of samples) {
    expect(s.x).toBeLessThanOrEqual(HALF_WORLD_M + BOUNDARY_TOLERANCE_M)
    expect(s.x).toBeGreaterThanOrEqual(-HALF_WORLD_M - BOUNDARY_TOLERANCE_M)
    expect(s.z).toBeLessThanOrEqual(HALF_WORLD_M + BOUNDARY_TOLERANCE_M)
    expect(s.z).toBeGreaterThanOrEqual(-HALF_WORLD_M - BOUNDARY_TOLERANCE_M)
  }
}

describe('RQ-30/GA-50: 월드 경계 클램프 — 플레이 면적(60×60m) ±30m 이탈 불가', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  /**
   * 핵심(GA-50) — 네 방향(±X, ±Z) 각각: 경계 근처에서 바깥 방향 입력을
   * 지속해도 서버가 확정하는 위치가 관측 구간 내내 ±30m 안에 머문다.
   * "붙어서 못 움직인다"는 별개 우려(안쪽 이동 자유)는 아래 전용
   * 테스트가 다룬다 — 이 테스트는 각 축의 클램프 자체만 확인한다.
   */
  it.each([
    { label: '+X', dirX: 1, dirZ: 0, start: { x: START_COORD_M, z: 0 } },
    { label: '-X', dirX: -1, dirZ: 0, start: { x: -START_COORD_M, z: 0 } },
    { label: '+Z', dirX: 0, dirZ: 1, start: { x: 0, z: START_COORD_M } },
    { label: '-Z', dirX: 0, dirZ: -1, start: { x: 0, z: -START_COORD_M } },
  ])(
    'RQ-30/GA-50: 경계($label) 근처에서 지속적인 바깥쪽 이동 입력에도 서버가 확정하는 위치의 x·z가 항상 ±30m 안에 머문다',
    async ({ dirX, dirZ, start }) => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)

      placePlayer(seam, room.sessionId, start)
      const baseline = await waitForServerCondition(
        seam,
        room.sessionId,
        (p) => Math.abs(p.x - start.x) < BOUNDARY_TOLERANCE_M && Math.abs(p.z - start.z) < BOUNDARY_TOLERANCE_M,
        `RQ-30: 화이트박스 순간이동(${JSON.stringify(start)}) 반영 대기`,
        BASELINE_TIMEOUT_MS,
      )

      // "다음 입력이 올 때까지 유지"모델(GameRoom.ts pendingInputs) — 한 번만
      // 보내도 이후 모든 틱에 이 입력이 그대로 계속 적용된다("지속해서
      // 보냄"의 서버 쪽 구현).
      room.send('move', { dirX, dirZ, mode: 'run', jump: false })

      const samples = await sampleServerPositionOverWindow(seam, room.sessionId, SUSTAINED_PUSH_WINDOW_MS)
      expectAlwaysWithinWorldBounds(samples)

      // 정지가 아니라 "출발점에서 실제로 밀리다가 경계에서 멈췄다"는 것도
      // 함께 확인한다 — 그러지 않으면 "출발점에 영원히 고정"하는 구현도
      // (우연히) 이 테스트를 통과할 수 있다.
      const last = lastSample(samples)
      expect(Math.abs(last.x)).toBeGreaterThan(Math.abs(baseline.x) - BOUNDARY_TOLERANCE_M)
      expect(Math.abs(last.z)).toBeGreaterThan(Math.abs(baseline.z) - BOUNDARY_TOLERANCE_M)
      const movedAlongAxis = dirX !== 0 ? Math.abs(last.x) - Math.abs(baseline.x) : Math.abs(last.z) - Math.abs(baseline.z)
      expect(movedAlongAxis).toBeGreaterThan(0)

      await leaveRoom(room)
    },
    15_000,
  )

  /**
   * 확장(GA-50, 모서리) — x·z가 동시에 경계를 넘으려 할 때 두 축 모두
   * 항상 ±30m 안에 갇힌다. 위 네 방향 테스트는 각 축을 독립적으로
   * 스트레스하지만, 이 테스트는 두 축을 **동시에** 바깥으로 미는
   * 대각선 입력에서 두 축 모두 동시에 클램프되는지를 확인한다(한 축만
   * 클램프하고 다른 축은 놓치는 구현을 잡아낸다).
   */
  it(
    'RQ-30/GA-50 확장(모서리): x·z 동시 경계 이탈 시도에도 두 축 모두 항상 ±30m 안에 머문다',
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)

      const start = { x: START_COORD_M, z: START_COORD_M }
      placePlayer(seam, room.sessionId, start)
      const baseline = await waitForServerCondition(
        seam,
        room.sessionId,
        (p) => Math.abs(p.x - start.x) < BOUNDARY_TOLERANCE_M && Math.abs(p.z - start.z) < BOUNDARY_TOLERANCE_M,
        `RQ-30: 화이트박스 순간이동(${JSON.stringify(start)}) 반영 대기`,
        BASELINE_TIMEOUT_MS,
      )

      const diag = Math.SQRT1_2 // 1/√2 — 정규화된 대각선 방향
      room.send('move', { dirX: diag, dirZ: diag, mode: 'run', jump: false })

      const samples = await sampleServerPositionOverWindow(seam, room.sessionId, SUSTAINED_PUSH_WINDOW_MS)
      expectAlwaysWithinWorldBounds(samples)

      // 두 축 모두 실제로 경계 쪽으로 밀렸는지("한쪽만 클램프됐다"는 반쪽
      // 짜리 구현을 배제) — 출발점(29,29)보다 경계(30)에 더 가까워졌어야
      // 한다.
      const last = lastSample(samples)
      expect(last.x).toBeGreaterThan(baseline.x - BOUNDARY_TOLERANCE_M)
      expect(last.z).toBeGreaterThan(baseline.z - BOUNDARY_TOLERANCE_M)

      await leaveRoom(room)
    },
    15_000,
  )

  /**
   * 확장(GA-50) — 경계에서 멈추되 안쪽 이동은 자유롭다. 바깥쪽 입력으로
   * 경계에 도달시킨 뒤, 입력을 안쪽 방향으로 바꾸면 위치가 실제로
   * 안쪽으로 이동한다 — 클램프가 "그 지점에 고착"이 아니라 "그 지점을
   * 넘지 못함"이라는 것을 확인한다.
   */
  it(
    'RQ-30/GA-50 확장(고착 금지): 경계에 닿은 뒤 안쪽 방향 입력은 정상 반영되어 위치가 안쪽으로 이동한다',
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)

      const start = { x: START_COORD_M, z: 0 }
      placePlayer(seam, room.sessionId, start)
      await waitForServerCondition(
        seam,
        room.sessionId,
        (p) => Math.abs(p.x - start.x) < BOUNDARY_TOLERANCE_M,
        `RQ-30: 화이트박스 순간이동(${JSON.stringify(start)}) 반영 대기`,
        BASELINE_TIMEOUT_MS,
      )

      // 1단계 — 바깥쪽(+X)으로 밀어 경계에 도달시킨다.
      room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
      const atBoundarySamples = await sampleServerPositionOverWindow(seam, room.sessionId, SUSTAINED_PUSH_WINDOW_MS)
      expectAlwaysWithinWorldBounds(atBoundarySamples)
      const atBoundary = lastSample(atBoundarySamples)
      // 전제 확인 — 실제로 경계 근처까지 밀렸어야 다음 단계("경계에서
      // 멈춘 뒤")가 의미를 갖는다.
      expect(atBoundary.x).toBeGreaterThan(HALF_WORLD_M - 2)

      // 2단계 — 안쪽(-X)으로 방향을 바꾼다. 클램프가 "그 좌표에 고착"이면
      // 이 입력도 무시되고 위치가 변하지 않을 것이다.
      room.send('move', { dirX: -1, dirZ: 0, mode: 'run', jump: false })
      const movedInward = await waitForServerCondition(
        seam,
        room.sessionId,
        (p) => p.x < atBoundary.x - 0.5,
        'RQ-30: 안쪽(-X) 입력 후 위치가 유의미하게 감소하는지 대기',
        BASELINE_TIMEOUT_MS + INWARD_RETURN_WINDOW_MS,
      )
      expect(movedInward.x).toBeLessThan(atBoundary.x - 0.5)
      // 안쪽으로 움직인 결과도 당연히 여전히 경계 안이다.
      expect(movedInward.x).toBeLessThanOrEqual(HALF_WORLD_M + BOUNDARY_TOLERANCE_M)

      await leaveRoom(room)
    },
    15_000,
  )

  /**
   * 양성 대조군(GA-50) — 경계에서 충분히 먼 이동은 클램프의 영향을 받지
   * 않는다. 이것이 없으면 "모든 이동을 통째로 막았다"(또는 속도를
   * 임의로 줄였다) 같은 구현도 위 클램프 테스트들을 통과할 수 있다 —
   * 클램프는 경계 **근처에서만** 개입해야 하고, 맵 중앙의 이동 속도는
   * RQ-92 기본값(`MOVEMENT.SPEED`=6m/s) 그대로여야 한다.
   */
  it(
    'RQ-30/GA-50 양성 대조 — 경계에서 먼(맵 중앙) 이동은 클램프의 영향을 받지 않고 RQ-92 기본 속도 그대로 진행한다',
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)

      const start = { x: 0, z: 0 } // 맵 중앙 — 어느 경계로부터도 HALF_WORLD_M(30m) 거리
      placePlayer(seam, room.sessionId, start)
      await waitForServerCondition(
        seam,
        room.sessionId,
        (p) => Math.abs(p.x) < BOUNDARY_TOLERANCE_M && Math.abs(p.z) < BOUNDARY_TOLERANCE_M,
        'RQ-30: 화이트박스 순간이동(맵 중앙) 반영 대기',
        BASELINE_TIMEOUT_MS,
      )

      room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
      const samples = await sampleServerPositionOverWindow(seam, room.sessionId, FAR_FROM_BOUNDARY_WINDOW_MS)
      const last = lastSample(samples)

      // 경계 근처에도 못 갔다(클램프가 개입할 상황 자체가 아니었다는
      // 사전 확인) — 여유 있게 경계에서 10m 이상 떨어져 있다.
      expect(last.x).toBeLessThan(HALF_WORLD_M - 10)

      // 속도 검증 — 실 네트워크·실 타이머 통합 테스트라 첫 메시지 왕복
      // 지연만큼의 타이밍 지터를 허용한다(관대한 구간, 정밀 산술은
      // `tests/unit/sim-movement.test.ts`의 책임). 그래도 "거의 안
      // 움직였다"(속도가 죽었다)나 "비정상적으로 더 갔다"는 잡아낸다.
      const elapsedSeconds = FAR_FROM_BOUNDARY_WINDOW_MS / 1000
      const expectedDisplacementM = MOVEMENT.SPEED * elapsedSeconds
      expect(last.x).toBeGreaterThan(expectedDisplacementM * 0.4)
      expect(last.x).toBeLessThan(expectedDisplacementM * 1.3)

      // z는 dirZ=0이었으므로 표류하지 않는다.
      expect(Math.abs(last.z)).toBeLessThan(0.01)

      await leaveRoom(room)
    },
    15_000,
  )
})
