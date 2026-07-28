import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { MOVEMENT } from '@shared/constants'

/**
 * RQ-92 공중 가속 미허용 — 서버 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus
 * 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스 **GA-18**(`verify` 필드가 이 파일 경로를 정확히
 * 지정한다):
 * - given: 플레이어가 점프해 공중에 있으며 점프 이륙 시점의 수평 속도가
 *   v0로 고정됨.
 * - when: 공중에 있는 동안 이동 방향키(전후좌우)를 입력.
 * - then: 수평 속도는 v0에서 변하지 않는다 — 방향키 입력이 공중 가속을
 *   일으키지 않으며 에어 스트레이프·버니합이 불가능하다(공중 가속 미허용).
 *
 * **레벨 분리(ADR-0008) — 기존 커버리지와 겹치지 않는 지점(원장 21b)**:
 * `tests/unit/sim-movement.test.ts`의 GA-32가 `stepMovement`(순수 함수)를
 * 직접 호출해 "공중에서 방향 입력이 수평 속도를 바꾸지 않는다"를 이미
 * 단위 레벨에서 고정했다. 이 파일은 그 산술이 실 `GameRoom` 30Hz 틱 루프의
 * 메시지 배선(`registerMessageHandlers`의 `'move'` 핸들러 → `pendingInputs`
 * → `stepPlayerMovement` → `moveStates`/`Player.vx·vz`)에 실제로 이어져
 * 있는지를 실 WebSocket으로 블랙박스 확인한다 — 순수 함수 자체가 옳아도
 * 서버 경계면의 배선이 틀리는 결함류가 이 저장소에서 세 번(RQ-43·RQ-64·
 * RQ-81, 원장 22m)이나 있었기 때문이다(예: 핸들러가 `mode`를 잘못
 * 매핑하거나, `jump`를 엣지 트리거가 아니라 레벨 트리거로 잘못 배선해
 * 공중에서도 매 틱 재이륙을 시도하는 등 — 단위 테스트는 이런 배선 결함을
 * 검출하지 못한다).
 *
 * **관측 지점(화이트박스, 신규 계약 아님)**: `matchMaker.getLocalRoomById`
 * (`rq-18-fall-damage.test.ts`·`rq-61-server-authoritative-position
 * .test.ts`가 이미 확립한 기법)로 테스트 프로세스 안에서 실행 중인
 * `GameRoom`에 접근해 `state.players`(Player 스키마의 `vx`·`vz`·
 * `lastProcessedInputSeq` — 이미 존재하는 필드, 신규 아님)와 `moveStates`
 * (RQ-20 때부터 있던 기존 private map, `grounded` 필드 — `rq-18-fall
 * -damage.test.ts`의 `FallDamageTestSeam`이 이미 화이트박스로 참조하는
 * 선례)를 직접 읽는다. 클라이언트 패치 배치(기본 20Hz)를 거치지 않는
 * 정본(ground truth)이라 배치 지연이 관측 타이밍을 좌우하지 않는다.
 *
 * **대기 술어(단조·안정 신호만 — `rq-61` "대기 술어" 원칙과 동일)**:
 * `lastProcessedInputSeq`가 보낸 `seq` 값으로 오를 때까지 기다린다 — 한 번
 * 오르면 되돌아가지 않는 안정 신호다. `pendingInputs`가 "최근 수신값을
 * 다음 메시지가 올 때까지 유지"하는 모델이므로(`GameRoom.ts` 코멘트),
 * "직전 값과 달라졌다"만으로 판정하면 무관한 원인(예: 이전 메시지의 재적용)
 * 으로도 조건이 참이 될 수 있다 — `lastProcessedInputSeq === N`은 그
 * 함정이 없다. `vx`·`vz`·`lastProcessedInputSeq`·`moveStates.grounded`는
 * 전부 같은 `stepPlayerMovement` 반복 안에서 동기적으로 함께 쓰이므로
 * (`GameRoom.ts` 확인 — `moveStates.set` → `player.vx/vz` → `lastProcessed
 * InputSeq` 순서가 전부 같은 for-each 반복 하나 안이다), 폴링 한 번의 읽기
 * 안에서 이 값들 사이에 경합이 없다.
 *
 * **"공중 유지" 전제는 대기 술어가 아니라 별도 단언으로 확인한다(중요
 * 설계 결정)**: seq 대기 predicate에 `grounded === false`를 함께 넣지
 * 않는다 — 만약(비정상적으로 빠른 물리 구현이거나 극단적 CI 부하로) 그
 * 메시지가 처리되는 바로 그 틱에 이미 착지해 버렸다면, seq와 grounded를
 * **함께** 기다리는 predicate는 영원히 참이 될 수 없어(착지 후에는 `jump:
 * false`를 계속 보내므로 재이륙이 없다) 정보 없는 타임아웃으로만 실패한다.
 * 대신 seq 하나만으로 기다리고(이건 항상 유한 시간 안에 참이 된다 —
 * 메시지가 처리되는 것 자체는 시간이 걸릴 뿐 불확실하지 않다), 그 직후
 * `grounded === false`를 **별도의 명시적 단언**으로 확인한다 — 전제가
 * 깨지면 "무의미한 타임아웃"이 아니라 "grounded가 false가 아니라 true였다"
 * 는 즉시 진단 가능한 실패로 드러난다.
 *
 * **틱 캐치업 안전 여유(수치로 확인, RQ-18 REV3/REV5가 실측으로 겪은
 * 함정에 대한 사전 대응)**: 현재 구현(`@shared/sim/movement`)의 점프
 * 궤적은 g=20m/s²로 약 19틱(≈632ms) 동안 공중에 머문다(`rq-18-fall
 * -damage.test.ts`의 `LANDING_OBSERVE_TIMEOUT_MS` 코멘트가 이미 실측한
 * 값과 동일 — "매우 완만한 g=0.5조차 약 170틱"이라는 상한 논의와는 별개로,
 * 실제 채택된 g=20에서의 실측 소요가 그 파일 곳곳에 "약 632ms"로 명시돼
 * 있다). 서버 틱 구동(`GameRoom.startTickLoop` → `createTickDriver`)의
 * 캐치업 상한(`maxTicksPerAdvance` 기본값 15, `tickDriver.ts`)은 15 < 19
 * 이므로, **단 한 번의 동기 캐치업 버스트가 이륙~착지 전체 구간을 통째로
 * 삼킬 수 없다** — 어떤 단일 콜백도 최대 15틱까지만 처리하고 반환하므로,
 * 이 테스트가 보내는 후속 메시지를 이벤트 루프가 처리할 기회가 최소 한 번은
 * 생긴다. 이 여유는 GA-18을 위해 물리 상수를 바꾼 것이 아니라 기존
 * 구현값을 그대로 관찰한 결과다(중력은 구현 자유 값 — `sim-movement
 * .test.ts` "점프 궤적 유도" 참고). 그럼에도 예외적으로 착지가 먼저
 * 일어나면 위 단락의 "별도 단언" 설계가 무의미한 행 대신 즉시 진단 가능한
 * 실패로 이를 드러낸다.
 *
 * **결정론 메모**: 기존 RQ-02/03/04/20/60/61/62/64 통합 테스트와 동일하게
 * 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008 허용 예외). 모든
 * 대기에 `timeoutMs` 상한을 강제한다.
 *
 * **스폰 보호(RQ-16)와 무관**: 이 파일은 HP·데미지를 다루지 않으므로
 * 자기 사격으로 스폰 보호를 해제하는 워밍업이 필요 없다(`rq-18-fall
 * -damage.test.ts`와의 차이점).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
/** 서버 화이트박스 상태 폴링 간격 — `rq-61-server-authoritative-position
 * .test.ts` `SERVER_POLL_INTERVAL_MS`와 동일 값·동일 근거. */
const SERVER_POLL_INTERVAL_MS = 15
/** seq 처리 확인 상한 — `rq-61`의 `SNAPSHOT_TIMEOUT_MS`와 동일 근거
 * (실 WS 왕복 + 최대 1틱 처리 지연을 넉넉히 흡수). */
const SEQ_CONFIRM_TIMEOUT_MS = 5_000

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

interface AirSnapshot {
  vx: number
  vz: number
  lastProcessedInputSeq: number
  grounded: boolean
}

/** 화이트박스 접근 대상 계약 — `state`는 `Room.state`(public) 그대로이고
 * `vx`·`vz`·`lastProcessedInputSeq`는 이미 `Player` 스키마에 있다(신규
 * 필드 아님, `rq-61-server-authoritative-position.test.ts`의
 * `PositionTestSeam`과 동일한 결합 방식). `moveStates`는 RQ-20 때부터
 * 있던 기존 private map(`rq-18-fall-damage.test.ts`의
 * `FallDamageTestSeam`이 이미 이 정확한 필드명으로 화이트박스 접근한다). */
interface AirAccelTestSeam {
  state: {
    players: {
      get: (sessionId: string) => { vx?: unknown; vz?: unknown; lastProcessedInputSeq?: unknown } | undefined
    }
  }
  moveStates: Map<string, { grounded: boolean }>
}

function getServerRoom(room: Room): AirAccelTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as AirAccelTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-92 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function readSnapshot(seam: AirAccelTestSeam, sessionId: string): AirSnapshot | undefined {
  const player = seam.state.players.get(sessionId)
  const moveState = seam.moveStates.get(sessionId)
  if (
    typeof player?.vx === 'number' &&
    typeof player?.vz === 'number' &&
    typeof player?.lastProcessedInputSeq === 'number' &&
    moveState !== undefined
  ) {
    return { vx: player.vx, vz: player.vz, lastProcessedInputSeq: player.lastProcessedInputSeq, grounded: moveState.grounded }
  }
  return undefined
}

/** `lastProcessedInputSeq === targetSeq`가 될 때까지 서버 상태를 직접
 * 폴링한다(화이트박스, 클라 패치 배치를 거치지 않는다). 단조·안정 신호라
 * "그 메시지가 실제로 처리됐다"만 보장하며, "그 순간 공중이었는가"는
 * 호출자가 반환값의 `grounded`로 별도 단언한다(위 파일 상단 설계 결정 참고). */
function waitForSeqProcessed(
  seam: AirAccelTestSeam,
  sessionId: string,
  targetSeq: number,
  label: string,
  timeoutMs: number,
): Promise<AirSnapshot> {
  return new Promise<AirSnapshot>((resolve, reject) => {
    const tryResolve = (): boolean => {
      const current = readSnapshot(seam, sessionId)
      if (current && current.lastProcessedInputSeq === targetSeq) {
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

describe('RQ-92/GA-18: 공중 가속 미허용 — 서버 틱 루프를 통과한 관측(에어 스트레이프·버니합 불가능)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "RQ-92/GA-18: 이륙 시 고정된 수평 속도(v0)는 공중에서 전후좌우 방향 입력을 받아도 변하지 않는다",
    async () => {
      const room = await joinGame(newClient(server))
      const seam = getServerRoom(room)
      const sessionId = room.sessionId

      try {
        // 이륙 — 전진(dirX=1) + 점프. v0 = (MOVEMENT.SPEED, 0)로 고정된다.
        room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: true, seq: 1 })
        const takeoff = await waitForSeqProcessed(seam, sessionId, 1, 'RQ-92: 이륙(seq=1) 처리 대기', SEQ_CONFIRM_TIMEOUT_MS)
        expect(takeoff.grounded).toBe(false) // 전제 확인 — 실제로 공중 상태가 됐다
        const v0 = { vx: takeoff.vx, vz: takeoff.vz }
        expect(v0.vx).toBe(MOVEMENT.SPEED) // dirX=1(정규화된 단위 벡터) → 그대로 6m/s
        expect(v0.vz).toBe(0)

        // 이후 메시지는 전부 jump:false — 착지 시 재이륙(버니합)을 유발하지 않는다.

        // 뒤(back) — 이륙 방향의 정반대.
        room.send('move', { dirX: -1, dirZ: 0, mode: 'run', jump: false, seq: 2 })
        const afterBack = await waitForSeqProcessed(seam, sessionId, 2, 'RQ-92: back 입력(seq=2) 처리 대기', SEQ_CONFIRM_TIMEOUT_MS)
        expect(afterBack.grounded).toBe(false) // 아직 공중이어야 이 케이스가 의미를 갖는다
        expect(afterBack.vx).toBe(v0.vx)
        expect(afterBack.vz).toBe(v0.vz)

        // 오른쪽(right).
        room.send('move', { dirX: 0, dirZ: 1, mode: 'run', jump: false, seq: 3 })
        const afterRight = await waitForSeqProcessed(seam, sessionId, 3, 'RQ-92: right 입력(seq=3) 처리 대기', SEQ_CONFIRM_TIMEOUT_MS)
        expect(afterRight.grounded).toBe(false)
        expect(afterRight.vx).toBe(v0.vx)
        expect(afterRight.vz).toBe(v0.vz)

        // 왼쪽(left).
        room.send('move', { dirX: 0, dirZ: -1, mode: 'run', jump: false, seq: 4 })
        const afterLeft = await waitForSeqProcessed(seam, sessionId, 4, 'RQ-92: left 입력(seq=4) 처리 대기', SEQ_CONFIRM_TIMEOUT_MS)
        expect(afterLeft.grounded).toBe(false)
        expect(afterLeft.vx).toBe(v0.vx)
        expect(afterLeft.vz).toBe(v0.vz)

        // 다시 앞(forward) — "이미 v0와 같은 방향이라 우연히 값이 같다"는
        // 의심을 지운다(방향 전환뿐 아니라 같은 방향 재입력도 가산되지
        // 않아야 한다).
        room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: 5 })
        const afterForwardAgain = await waitForSeqProcessed(
          seam,
          sessionId,
          5,
          'RQ-92: forward 재입력(seq=5) 처리 대기',
          SEQ_CONFIRM_TIMEOUT_MS,
        )
        expect(afterForwardAgain.grounded).toBe(false)
        expect(afterForwardAgain.vx).toBe(v0.vx)
        expect(afterForwardAgain.vz).toBe(v0.vz)
      } finally {
        await leaveRoom(room)
      }
    },
    20_000,
  )
})
