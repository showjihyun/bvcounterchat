import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { MOVEMENT, NET } from '@shared/constants'
import { LADDER_ALPHA } from '@shared/sim/ladders'

/**
 * RQ-21 사다리 이동 — **프로덕션 배선** 통합 테스트(원장 25a-7, team-lead
 * 지시). 골든 **GA-54**(`harness/evals/golden/track-a-product.jsonl:54`,
 * `verify` 필드가 이 파일 경로를 정확히 지정 — 이 파일이 GA-54 자체의
 * 행동 검증을 수행한다):
 * - given: 플레이어가 사다리 볼륨 밖 지면에 서 있음.
 * - when: 사다리 볼륨에 진입한 뒤 이동 입력의 수평 방향을 사다리 면 쪽으로
 *   유지하고, 이어서 반대 방향으로 바꾸고, 마지막으로 입력을 놓음.
 * - then: 면 쪽 입력 중에는 일정 속도로 상승, 반대 방향 입력 중에는 같은
 *   속도로 하강, 입력이 없으면 그 높이에 정지 — 볼륨 안에서는 중력이
 *   적용되지 않는다. 볼륨을 벗어나면 즉시 중력이 복귀한다.
 *
 * **이 파일이 존재하는 이유(RQ-30/F1·RQ-22/GA-55 선례, 원장 25a-2/25a-4)**:
 * 순수 함수 계약(`tests/unit/sim-movement-ladders.test.ts`)만으로는
 * `GameRoom`이 실제로 `PRODUCTION_LADDERS`(→`PRODUCTION_GEOMETRY`, 25a-5)를
 * `stepMovement`에 상시 주입하는지 어떤 테스트도 관측하지 않는다 — 벽·박스
 * 때 그 배선 자체가 고아 상태로 남았던 전례가 각각 있다(평가 FAIL F1,
 * `1170aab`). 이 파일은 **서버가 확정하는 위치**(공개 스키마 `player.y`·
 * `player.grounded`)가 실제 Colyseus 룸에서 사다리를 존중하는지를 관측한다.
 *
 * **가정(coder에게)**: `src/shared/sim/ladders.ts`(그린필드)가 `LADDER_ALPHA`·
 * `PRODUCTION_LADDERS`를 export하고, `src/shared/sim/geometry.ts`(그린필드,
 * 25a-5)가 `PRODUCTION_GEOMETRY`를 export하며, `GameRoom.stepPlayerMovement`의
 * `stepMovement(previous, input, PRODUCTION_WALLS, PRODUCTION_BOXES)` 호출이
 * `stepMovement(previous, input, PRODUCTION_GEOMETRY)`(단일 객체 인자)로
 * 갱신된다 — 정확한 계약은 `tests/unit/sim-movement-ladders.test.ts` 상단
 * docblock을 참고(이 파일이 반복하지 않는다).
 *
 * **화이트박스 기법(`moveStates`, 신규 계약 아님)**: `matchMaker
 * .getLocalRoomById`(`rq-30-wall-collision-wiring.test.ts`·`rq-22-box-jump
 * .test.ts`가 이미 확립)로 `moveStates`(x·y·z·vx·vy·vz·grounded 7필드)를
 * 직접 읽는다 — 클라 패치 배치(기본 20Hz)를 거치지 않는 정본이라 배치
 * 지연이 관측 타이밍을 좌우하지 않는다. `grounded`는 RQ-22 라운드부터 공개
 * 스키마(`state.players`)에도 있으므로 정본(moveStates)과 공개 스키마
 * 둘 다 확인한다(같은 이유 — "정본은 맞는데 스키마에 안 실었다"는 배선
 * 누락까지 잡는다).
 *
 * **given을 실제로 재현한다(box-jump 선례와 다른 점)**: `rq-22-box-jump
 * .test.ts`는 박스 바로 앞에 순간이동시키고 곧장 점프했지만, 이 파일은
 * GA-54의 given("볼륨 밖 지면에 서 있음")·when("볼륨에 진입한 뒤...")을
 * 문자 그대로 재현한다 — 사다리 근접면 3m 앞(`LADDER_ALPHA.minX - 3`)에
 * 순간이동시킨 뒤, **같은 방향 입력(dirX=1)을 한 번만 눌러 유지**해 먼저
 * 걸어서 볼륨에 진입하고 이어서 그 입력이 자연스럽게 상승으로 전환되는
 * 것을 관찰한다(CS류 사다리의 실제 조작 감각 — "사다리를 향해 계속 전진"
 * 키 하나로 접근과 등반이 이어진다).
 *
 * **좌표(`LADDER_ALPHA`를 그대로 임포트 — ADR-0010 값 복제 금지)**:
 * `sim-movement-ladders.test.ts`가 회귀 안전 대역으로 계산한 값을 그대로
 * 프로덕션 후보로 제안하며, 이 파일은 리터럴을 복제하지 않고 그 정본을
 * 가져와 쓴다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * §5 허용 예외, 기존 RQ-18/22/30/92 통합 테스트와 동일). 모든 대기에
 * `timeoutMs` 상한을 강제한다.
 *
 * **스코프 밖**: 사다리의 시각 표현, 사다리 위 사격/차폐 상호작용,
 * GA-52/53(클러스터 배치·`.glb`) — 이 파일이 시험하지 않는다. 원장
 * 25a-7의 "이 라운드가 닫지 않는 것" 목록에 실제로 있는 것은 "사다리에서
 * 이탈하며 **점프**"뿐이고, 그 항목은 여전히 스코프 밖이다.
 *
 * **"발판 없는 꼭대기 이탈"은 더 이상 스코프 밖이 아니다(F1 수정)** —
 * 초판 문서가 이 동작을 25a-7의 배제 목록에 있는 것으로 잘못 인용했으나,
 * 실제로 그 목록에는 없었다. 독립 평가가 이 오귀속을 FAIL(F1,
 * `_workspace/RQ-21-ladder/03_evaluator_report.md`)로 지적했다 — 발판
 * 없이 꼭대기를 이탈하면 즉시 접지 스냅(4↔0 무한 요요)이 되어 RQ-18 낙하
 * 데미지가 전혀 적용되지 않았다. 위쪽(GA-54) describe는 여전히 **바닥 쪽
 * 이탈**만 다룬다(바닥은 실제 지면과 일치해 발판 없이도 안전하게 관측
 * 가능하다).
 *
 * **REV 2026-08-06(RQ-33 v2.0 — F1 재현 describe를 이 파일에서 제거함)**:
 * 위 단락이 가리키던 "이 파일 하단의 F1 재현 describe"는 더 이상 이
 * 파일에 없다. RQ-33(고지대 플랫폼, GA-61/62)이 "모든 프로덕션 사다리는
 * 반드시 플랫폼 측면에 접한다"를 명문화하면서, F1이 전제한 상황("발판
 * **없는** 프로덕션 사다리 꼭대기 이탈")이 실제 `PRODUCTION_GEOMETRY`
 * 에서는 더 이상 일어날 수 없는 상태가 됐다(GA-59가 요구하는 "등반이
 * 끝나는 지점에서 플랫폼 윗면으로 이동한다"와, F1이 요구하던 "지지면 없이
 * 낙하한다"가 같은 위치·같은 입력에 대해 정반대를 요구해 양립 불가 —
 * 사용자 결정 2026-08-06, `_workspace/RQ-33/03_test-writer_f1-migration
 * .md` §1 참고). **F1이 지키던 계약("지지면 없는 사다리 꼭대기 이탈은
 * 즉시 접지 스냅이 아니라 실제 낙하여야 하고, 요요에 빠지지 않는다")은
 * 순수 함수 레벨로 이전했다** — `tests/unit/sim-movement-ladders
 * .test.ts`의 "F1(합성, RQ-33 이후 — 발판 없는 사다리 낙하 폴백 경로)"
 * describe가 이제 그 계약을 합성(synthetic) `LadderVolume` +
 * `EMPTY_GEOMETRY` 기반으로 고정한다(더 이상 `LADDER_ALPHA`에 결합되지
 * 않는다 — 프로덕션 사다리는 이제 항상 플랫폼이 있으므로). "꼭대기 발판
 * **있는** 이탈"(GA-59, 실제 프로덕션 시나리오)의 서버 확정 검증은
 * `tests/integration/rq-33-platform-reach.test.ts`가 맡는다. F1이 함께
 * 확인하던 "서버 확정 HP가 낙하 데미지만큼 감소한다"는 일반 축은
 * `tests/integration/rq-18-fall-damage.test.ts`(GA-44/45/46, 화이트박스
 * 높이 주입으로 사다리와 무관하게 이미 전수 검증)가 계속 담당한다 —
 * 확인 결과는 `_workspace/RQ-33/03_test-writer_f1-migration.md` §3.
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
/** 접근(걸어서 진입) + 등반 관측 상한 — 3m 접근(0.5s) + 목표 고도 도달
 * 여유를 넉넉히 얹었다. */
const CLIMB_OBSERVE_TIMEOUT_MS = 8_000
/** 하강 관측 상한. */
const DESCEND_OBSERVE_TIMEOUT_MS = 8_000
/** 정지 상태에서 y가 유지되는지(1틱 반짝임 아님) 관찰하는 창. */
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
 * private map(신규 아님). `state.players`(공개 스키마)의 `grounded`는
 * RQ-22 라운드부터 있다(둘 다 `rq-22-box-jump.test.ts` `BoxJumpSeam`과
 * 동일 계약, 새로 발명하지 않는다).
 *
 * **REV 2026-08-06(RQ-33 v2.0)**: `firedSinceSpawn`·`hp` 필드는 이
 * 파일이 "F1 재현" describe(발판 없는 사다리 꼭대기 이탈 → 낙하 데미지)
 * 전용으로만 썼다 — 그 describe를 제거하면서(위 파일 docblock REV
 * 참고) 함께 걷어낸다. `waitForPublicHpBelow`도 같은 이유로 제거했다.
 * 두 필드·그 헬퍼가 필요했던 검증 축은 `tests/unit/sim-movement-ladders
 * .test.ts`(궤적 연속성)와 `tests/integration/rq-18-fall-damage.test.ts`
 * (서버 확정 HP)로 이전했다 — `_workspace/RQ-33/03_test-writer_f1
 * -migration.md` 참고. */
interface LadderSeam {
  moveStates: Map<string, MoveState>
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number; grounded?: boolean } | undefined
    }
  }
}

function getServerRoom(room: Room): LadderSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as LadderSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-21 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** GA-54 given의 시작점 — 사다리 근접면(x=`LADDER_ALPHA.minX`) 3m 앞,
 * z는 사다리 z범위 한가운데. `sim-movement-boxes.test.ts`/`rq-22-box-jump
 * .test.ts`의 "근접면 3m 앞" 관례와 동일. */
const START_X_M = LADDER_ALPHA.minX - 3
const START_Z_M = (LADDER_ALPHA.minZ + LADDER_ALPHA.maxZ) / 2

/** 1틱 동안 사다리 위에서 오르내리는 높이(m) — RQ-21 v1.4(앉기 속도,
 * RQ-92)에서 유도. 리터럴 3을 쓰지 않는다(ADR-0010). */
const CLIMB_SPEED_MPS = MOVEMENT.SPEED * MOVEMENT.CROUCH_MULTIPLIER
const TICK_SECONDS = NET.TICK_MS / 1000
const DY_PER_TICK = CLIMB_SPEED_MPS * TICK_SECONDS

/** 실제로 상승이 시작됐다고 볼 수 있는 임계고도 — 걸어서 진입하는 동안의
 * y=0 유지 구간과 확실히 구분되도록 여러 틱 분(0.3m ≈ 3틱) 여유를 둔다. */
const ASCEND_CONFIRM_Y_M = 0.3
/** 지속 상승 목표 — 사다리 범위(0~4m) 중간 지점. */
const ASCEND_TARGET_Y_M = 1.5
/** 하강 목표 — 상승 목표보다 낮지만 바닥(0)보다는 높아, "하강했다"와
 * "바닥까지 눌렸다"를 구분한다. */
const DESCEND_TARGET_Y_M = 0.5

function placePlayer(seam: LadderSeam, sessionId: string, position: { x: number; y: number; z: number }): void {
  seam.moveStates.set(sessionId, { x: position.x, y: position.y, z: position.z, vx: 0, vy: 0, vz: 0, grounded: true })
}

function readMoveState(seam: LadderSeam, sessionId: string): MoveState | undefined {
  return seam.moveStates.get(sessionId)
}

function waitForMoveStateCondition(
  seam: LadderSeam,
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

function sampleMoveStateOverWindow(seam: LadderSeam, sessionId: string, windowMs: number): Promise<MoveState[]> {
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

describe('RQ-21 사다리 이동 — 프로덕션 배선(GA-54): 서버가 확정하는 위치가 사다리 등반을 반영한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'GA-54: 볼륨 진입 → 면 쪽 유지(상승) → 반대 방향(하강) → 무입력(정지) → 바닥까지 눌러도 지면 아래로 내려가지 않는다(볼륨 이탈 시 정상 접지 유지)',
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)
      const sessionId = room.sessionId

      try {
        // given — 사다리 볼륨 밖 지면에 서 있음.
        placePlayer(seam, sessionId, { x: START_X_M, y: 0, z: START_Z_M })
        await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => Math.abs(s.x - START_X_M) < 1e-6 && s.grounded,
          'RQ-21: 화이트박스 순간이동 반영 대기',
          BASELINE_TIMEOUT_MS,
        )

        // when① — 사다리 면 쪽(dirX=1) 입력을 유지 — 먼저 걸어서 볼륨에
        // 진입하고, 이어서 같은 입력이 상승으로 전환된다.
        room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })

        const climbing = await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => s.y >= ASCEND_CONFIRM_Y_M,
          'RQ-21①: 상승 시작(걸어서 진입 이후) 대기',
          CLIMB_OBSERVE_TIMEOUT_MS,
        )
        // 상승 중에도 계속 접지 상태다(자유낙하가 아니다) — RQ-18과의
        // 상호작용(단위 테스트 docblock 참고): 사다리 등반은 낙하로
        // 오귀속되지 않는다.
        expect(climbing.grounded).toBe(true)
        // 진입 후 x·z가 사다리 볼륨의 XZ 범위 안에 있다 — 원래 의도
        // (REV: 이전 `toBeCloseTo(center, 1)`은 정밀도 0.05m가 걷기
        // 보폭(0.2m/틱)보다 좁아 "정확히 중앙으로 스냅"을 요구하는
        // 의도치 않은 계약이 돼 버렸다. RQ-21 v1.4·GA-54 어디에도 사다리
        // 위 수평 중심 요구가 없으므로, 중심 스냅 여부와 무관하게 통과하는
        // 범위 단언으로 되돌린다 — `LADDER_ALPHA`의 경계에서 유도하며
        // 리터럴을 쓰지 않는다, ADR-0010). 사다리 판정 자체가 죽으면(y가
        // ASCEND_CONFIRM_Y_M에 끝내 도달하지 못해) 위 `waitForMoveStateCondition`
        // 이 타임아웃으로 먼저 죽으므로, 이 범위 단언이 공허하게 통과하는
        // 경로는 없다.
        expect(climbing.x).toBeGreaterThan(LADDER_ALPHA.minX)
        expect(climbing.x).toBeLessThan(LADDER_ALPHA.maxX)
        expect(climbing.z).toBeGreaterThan(LADDER_ALPHA.minZ)
        expect(climbing.z).toBeLessThan(LADDER_ALPHA.maxZ)
        // 공개 스키마도 같은 값을 확정한다(정본-스키마 배선 확인).
        const climbingPublic = seam.state.players.get(sessionId)
        expect(climbingPublic?.grounded).toBe(true)
        expect(climbingPublic?.y).toBeGreaterThanOrEqual(ASCEND_CONFIRM_Y_M - 1e-6)

        const ascended = await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => s.y >= ASCEND_TARGET_Y_M,
          'RQ-21①: 지속 상승 목표 고도 도달 대기',
          CLIMB_OBSERVE_TIMEOUT_MS,
        )
        expect(ascended.grounded).toBe(true)

        // when② — 반대 방향(dirX=-1) 입력으로 전환 — 하강.
        room.send('move', { dirX: -1, dirZ: 0, mode: 'run', jump: false })

        const descended = await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => s.y <= DESCEND_TARGET_Y_M,
          'RQ-21②: 하강 목표 고도 도달 대기',
          DESCEND_OBSERVE_TIMEOUT_MS,
        )
        expect(descended.grounded).toBe(true)
        expect(descended.y).toBeLessThan(ascended.y) // 실제로 내려왔다(전제 확인)

        // when③ — 입력을 놓음(dirX=dirZ=0) — 그 높이에 정지.
        room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })

        const settled = await sampleMoveStateOverWindow(seam, sessionId, SETTLE_OBSERVE_MS)
        expect(settled.length).toBeGreaterThan(0)
        const settledYAtStart = settled[0]!.y
        for (const s of settled) {
          expect(s.grounded).toBe(true)
          expect(s.y).toBeCloseTo(settledYAtStart, 1) // 정지 — 더 오르내리지 않는다(허용오차: 폴링 사이 미세 지연)
        }

        // then(마지막 문장) — 볼륨을 벗어나면 즉시 중력이 복귀한다. 바닥
        // 쪽으로 계속 눌러 실제로 이탈시킨다 — 사다리 최하단(minY)이 실제
        // 지면과 같은 높이라, 이탈해도 불연속 없이 접지가 유지된다(꼭대기
        // 이탈은 이 GA-54 describe의 관심사가 아니다 — RQ-33 이후에는
        // `tests/integration/rq-33-platform-reach.test.ts`의 GA-59가
        // 다룬다, 파일 하단 REV 참고).
        room.send('move', { dirX: -1, dirZ: 0, mode: 'run', jump: false })

        const atBottom = await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => s.y <= 1e-6,
          'RQ-21: 바닥(볼륨 이탈) 도달 대기',
          DESCEND_OBSERVE_TIMEOUT_MS,
        )
        expect(atBottom.grounded).toBe(true)

        // 바닥에서 더 눌러도 음수로 내려가지 않는다(클램프 확인).
        const stillAtBottom = await sampleMoveStateOverWindow(seam, sessionId, SETTLE_OBSERVE_MS)
        for (const s of stillAtBottom) {
          expect(s.y).toBeGreaterThanOrEqual(-1e-6)
          expect(s.grounded).toBe(true)
        }

        // 공개 스키마도 최종 상태를 동일하게 확정한다.
        const finalPublic = seam.state.players.get(sessionId)
        expect(finalPublic?.grounded).toBe(true)
        expect(finalPublic?.y).toBeCloseTo(0, 1)

        await leaveRoom(room)
      } catch (err) {
        await leaveRoom(room).catch(() => undefined)
        throw err
      }
    },
    30_000,
  )

  it(
    '양성 대조군 — 사다리 볼륨 밖(같은 z, 근접면에서 먼 x)에서 같은 입력을 유지하면 사다리 물리 없이 평지 수평 이동만 일어난다',
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)
      const sessionId = room.sessionId
      const FAR_FROM_LADDER_X = LADDER_ALPHA.maxX + 6 // 사다리 원면에서 6m — 볼륨 XZ 밖

      try {
        placePlayer(seam, sessionId, { x: FAR_FROM_LADDER_X, y: 0, z: START_Z_M })
        await waitForMoveStateCondition(
          seam,
          sessionId,
          (s) => Math.abs(s.x - FAR_FROM_LADDER_X) < 1e-6 && s.grounded,
          'RQ-21 양성 대조군: 화이트박스 순간이동 반영 대기',
          BASELINE_TIMEOUT_MS,
        )

        room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })

        const OBSERVE_MS = 500
        const samples = await sampleMoveStateOverWindow(seam, sessionId, OBSERVE_MS)
        expect(samples.length).toBeGreaterThan(0)
        for (const s of samples) {
          expect(s.y).toBeCloseTo(0, 6) // 사다리 물리가 아니다 — 상승하지 않는다
          expect(s.grounded).toBe(true)
        }
        const last = samples[samples.length - 1]!
        // 평지 수평 이동이 실제로 일어났다(사다리였다면 x가 거의 불변이었을 것).
        expect(last.x).toBeGreaterThan(FAR_FROM_LADDER_X + DY_PER_TICK)

        await leaveRoom(room)
      } catch (err) {
        await leaveRoom(room).catch(() => undefined)
        throw err
      }
    },
    15_000,
  )
})

/**
 * **REV 2026-08-06(RQ-33 v2.0) — "F1 재현" describe를 이 파일에서
 * 제거했다.** 이 자리에 있던 테스트는 "발판 **없는** 프로덕션 사다리
 * (`LADDER_ALPHA`) 꼭대기를 이탈하면 즉시 접지 스냅(요요)이 아니라 실제
 * 낙하로 이어지고, 서버 확정 HP가 낙하 데미지만큼 줄어든다"를 검증했다
 * (독립 평가 FAIL F1, `_workspace/RQ-21-ladder/03_evaluator_report.md`
 * F1 절 — ADR-0011 결정 1 "결함 수정 라운드의 재현 테스트").
 *
 * **제거 사유**: RQ-33(고지대 플랫폼, v2.0)이 "각 사다리는 플랫폼
 * 측면에 접해야 한다"(GA-61/62)를 명문화하면서, 이 테스트가 전제한
 * 상황("`LADDER_ALPHA` 꼭대기에 발판이 없다")이 실제
 * `PRODUCTION_GEOMETRY`에서는 더 이상 성립하지 않는다 — 모든 프로덕션
 * 사다리가 이제 항상 인접 플랫폼을 갖는다. 같은 위치·같은 입력(`x=
 * LADDER_CENTER_X`, `dirX: 1` 유지)에 대해 이 테스트는 "낙하 데미지가
 * 적용된다"를, `tests/integration/rq-33-platform-reach.test.ts`의
 * GA-59는 "플랫폼 위에 올라서고 낙하하지 않는다"를 요구해 **정반대로
 * 충돌**한다 — GA-59를 구현하면 이 테스트는 반드시 깨진다. 사용자 결정
 * (2026-08-06, `_workspace/RQ-33/03_test-writer_f1-migration.md` §1)에
 * 따라 통합 레벨에서는 GA-59가 이긴다(CS류 사다리 관례상 사다리 꼭대기
 * 이탈은 난간 위로 올라서는 것이 자연스럽다).
 *
 * **커버리지 이전(삭제가 아니라 이동 — 표로 추적)**:
 *
 * | 이 테스트가 지키던 것 | 이제 지키는 곳 |
 * |---|---|
 * | 지지면 없는 사다리 꼭대기 이탈 → 즉시 스냅이 아니라 실제 낙하(요요 방지) | `tests/unit/sim-movement-ladders.test.ts`의 "F1(합성, RQ-33 이후)" describe — 합성 `LadderVolume` + `EMPTY_GEOMETRY` 기반, `LADDER_ALPHA`와 완전히 분리 |
 * | 꼭대기 발판 **있는** 이탈(현재 프로덕션의 실제 모습) → 서버 확정 위치가 플랫폼을 반영 | `tests/integration/rq-33-platform-reach.test.ts`의 GA-59 |
 * | 서버 확정 HP가 낙하 데미지만큼 감소한다(RQ-18 일반 축) | `tests/integration/rq-18-fall-damage.test.ts`(GA-44/45/46) — 화이트박스 높이 주입으로 사다리와 무관하게 이미 전수 검증 중이었다(확인 결과는 `_workspace/RQ-33/03_test-writer_f1-migration.md` §3) |
 *
 * 삭제된 코드(`describe('F1 재현 — ...')`, `waitForPublicHpBelow`,
 * `LadderSeam`의 `firedSinceSpawn`/`hp` 필드)는 git 이력(이 파일의
 * 이전 커밋)에서 그대로 조회할 수 있다.
 */
