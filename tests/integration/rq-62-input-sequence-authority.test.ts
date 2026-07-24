import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { MOVEMENT } from '@shared/constants'

/**
 * RQ-62 클라이언트 예측 — 서버 측 입력 시퀀스 배선 통합 테스트
 * (ADR-0008: Colyseus 룸 경계).
 *
 * 골든 케이스 GA-34~36(`harness/evals/golden/track-a-product.jsonl`)의
 * `verify`는 `tests/unit/rq-62-prediction.test.ts` 하나만 지정한다 — 이
 * 파일은 그 골든 매핑 밖에서 team-lead가 명시적으로 요청한 통합 검증이다
 * ("통합: 실 서버로 (1) seq 포함 move 전송 → 스냅샷에 lastProcessedInputSeq·
 * vx/vy/vz 반영 (2) 스푸핑 좌표 여전히 무시(RQ-61 회귀 — GA-33 보강)").
 * 골든 파일 자체는 수정하지 않는다(정답은 사람이 쓴다,
 * `harness/evals/README.md`).
 *
 * **레벨 분리(ADR-0008)**: 예측 모듈 자체의 순수 로직(입력 즉시 반영·
 * 재조정·재생·궤적 일치)은 `tests/unit/rq-62-prediction.test.ts`가 담당한다.
 * 이 파일은 그 예측 모듈을 임포트하지 않는다 — "서버가 실제로 seq를 받아
 * 스냅샷에 반영하는가", "그 과정에서 좌표 스푸핑이 여전히 통하지 않는가"만
 * 블랙박스로 확인하는 서버 권위 테스트다(`rq-20-movement-authority.test.ts`와
 * 동일한 정신·패턴).
 *
 * **가정 1(coder에게 — Player 스키마 확장, `harness/progress.md` 20c
 * "21a-2 판단 확정" 그대로)**: `Player`(`@shared/schema/GameState`)에
 * 아래 4개 필드가 추가된다.
 *   - `vx: number` (기본 0) — 수평 속도 x
 *   - `vy: number` (기본 0) — 수직 속도
 *   - `vz: number` (기본 0) — 수평 속도 z
 *   - `lastProcessedInputSeq: number` (기본 0) — 서버가 처리를 반영한
 *     마지막 입력 시퀀스 번호(ADR-0003)
 * `grounded` 필드는 **추가하지 않는다** — 21a-2가 확정한 목록에 없다(자세한
 * 근거·잠재적 취약점은 `tests/unit/rq-62-prediction.test.ts`의 "참고" 절 —
 * 이 파일이 재론할 권한 밖이며, 이 파일은 그 4개 필드만 검증한다).
 *
 * **가정 2(coder에게 — 'move' 메시지 payload 확장)**: 기존 `{ dirX, dirZ,
 * mode, jump }`에 선택적 `seq?: number` 필드가 추가된다. 서버는 유효한
 * (유한한 숫자) `seq`를 받으면 그 값을 해당 세션의 `lastProcessedInputSeq`로
 * 기록하고, 이어지는 스냅샷 브로드캐스트에 정확히 그 값으로 반영한다 — 근사값도
 * 아니고 서버 자체 카운터도 아니라 **클라이언트가 보낸 그 seq 값 그대로**다
 * (ADR-0003 "처리된 마지막 시퀀스 번호를 스냅샷에 담아 반환한다"). `seq`가
 * 없거나 숫자가 아니면(레거시 호출 — 기존 `rq-20-movement-authority.test.ts`,
 * `20b-client-connect.test.ts`가 이미 그렇게 호출한다) `lastProcessedInputSeq`를
 * **갱신하지 않는다**(직전 값 유지) — 이 필드가 없다고 해서 예외를 던지거나
 * 이동 자체가 중단돼서는 안 된다(하위 호환, 기존 테스트 무회귀).
 *
 * 이 통합 테스트는 서버가 "틱당 정확히 1개 입력만 소비하는 이상적 FIFO
 * 커맨드 버퍼"를 구현했는지는 규정하지 않는다(ADR-0003 문면은 이상화된
 * 설명이고, 현재 `GameRoom`의 실제 모델은 "가장 최근 수신 입력을 다음
 * 입력이 올 때까지 매 틱 재적용"이다 — `pendingInputs` 맵, coder 판단
 * 영역). 오직 관찰 가능한 계약만 확인한다: 유효한 seq를 포함한 'move'를
 * 보내면, 그 값이 이어지는 스냅샷에서 `lastProcessedInputSeq`로 관측
 * 가능해야 한다.
 *
 * **가정 3(coder에게 — vx·vy·vz 갱신 시점)**: 서버는 이미 매 틱
 * `stepMovement`로 각 플레이어의 `MoveState`(x·y·z·vx·vy·vz·grounded)를
 * 갱신하고 있다(`GameRoom.stepPlayerMovement`, RQ-20) — x·y·z만 스키마에
 * 반영하던 것을 vx·vy·vz도 반영하도록 넓히면 된다. 별도의 새 계산 로직은
 * 필요 없다.
 *
 * **결정론 메모**: 기존 RQ-02/03/04/20/60 통합 테스트와 동일하게 실
 * WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008 허용 예외). 모든
 * 대기에 `withTimeout()` 상한을 걸고, 고정 슬립 대신 `onStateChange`로 실제
 * 값 변화를 폴링한다 — 무관한 갱신(예: 매 틱 갱신되는 `tick` 필드)을 우리가
 * 보낸 메시지의 효과로 착각하는 경합을 피한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const SNAPSHOT_TIMEOUT_MS = 5_000
/** 스푸핑 대상 좌표 — 60×60m 맵(RQ-30, WORLD.SIZE_M)을 아득히 벗어나는 값이라
 * "이 좌표 근처에도 못 온다"를 관대한 오차 없이 단언할 수 있다
 * (`rq-20-movement-authority.test.ts`와 동일한 상수). */
const SPOOFED_COORD = 9999

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
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface PlayerSnapshot {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  lastProcessedInputSeq: number
}

/** 룸 state에서 자신의 스냅샷을 읽는다(가정 1). 확장 필드가 아직 없거나
 * patch가 아직 도착하지 않았으면 undefined. */
function readPlayerSnapshot(room: Room): PlayerSnapshot | undefined {
  const state = room.state as {
    players?: {
      get?: (key: string) =>
        | {
            x?: unknown
            y?: unknown
            z?: unknown
            vx?: unknown
            vy?: unknown
            vz?: unknown
            lastProcessedInputSeq?: unknown
          }
        | undefined
    }
  } | null
  const player = state?.players?.get?.(room.sessionId)
  if (
    typeof player?.x === 'number' &&
    typeof player?.y === 'number' &&
    typeof player?.z === 'number' &&
    typeof player?.vx === 'number' &&
    typeof player?.vy === 'number' &&
    typeof player?.vz === 'number' &&
    typeof player?.lastProcessedInputSeq === 'number'
  ) {
    return {
      x: player.x,
      y: player.y,
      z: player.z,
      vx: player.vx,
      vy: player.vy,
      vz: player.vz,
      lastProcessedInputSeq: player.lastProcessedInputSeq,
    }
  }
  return undefined
}

/** 확장 필드(vx·vy·vz·lastProcessedInputSeq)를 포함한 스냅샷이 처음
 * 관측될 때까지 기다린다. */
function waitForDefinedSnapshot(room: Room): Promise<PlayerSnapshot> {
  return withTimeout(
    new Promise<PlayerSnapshot>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayerSnapshot(room)
        if (current) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    SNAPSHOT_TIMEOUT_MS,
    '초기 스냅샷(vx·vy·vz·lastProcessedInputSeq 포함) 관측',
  )
}

/** predicate를 만족하는 스냅샷이 관측될 때까지 반복 확인한다("다음 한 번의
 * onStateChange"만 신뢰하면 무관한 갱신을 우리가 기다리는 변화로 착각하는
 * 경합이 생긴다 — `rq-20-movement-authority.test.ts`의
 * `waitForPositionChange`와 동일한 정신). */
function waitForSnapshotCondition(
  room: Room,
  predicate: (s: PlayerSnapshot) => boolean,
  ms: number,
  label: string,
): Promise<PlayerSnapshot> {
  return withTimeout(
    new Promise<PlayerSnapshot>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayerSnapshot(room)
        if (current && predicate(current)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    ms,
    label,
  )
}

describe('RQ-62 입력 시퀀스 — 서버가 처리한 seq가 스냅샷의 lastProcessedInputSeq로 관측된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "RQ-62: 'move' 메시지에 seq를 포함해 보내면, 서버가 처리한 마지막 시퀀스 번호가 스냅샷의 lastProcessedInputSeq로 정확히 관측된다",
    async () => {
      const room = await joinGame(newClient(server))
      const baseline = await waitForDefinedSnapshot(room)
      expect(baseline.lastProcessedInputSeq).toBe(0) // 아직 seq를 보낸 적 없음 — 기본값

      room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: 1 })
      const afterSeq1 = await waitForSnapshotCondition(
        room,
        (s) => s.lastProcessedInputSeq === 1,
        SNAPSHOT_TIMEOUT_MS,
        'lastProcessedInputSeq === 1 대기',
      )
      expect(afterSeq1.lastProcessedInputSeq).toBe(1)

      room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: 2 })
      const afterSeq2 = await waitForSnapshotCondition(
        room,
        (s) => s.lastProcessedInputSeq === 2,
        SNAPSHOT_TIMEOUT_MS,
        'lastProcessedInputSeq === 2 대기',
      )
      expect(afterSeq2.lastProcessedInputSeq).toBe(2)

      await leaveRoom(room)
    },
    20_000,
  )

  it(
    'RQ-62/21a-2: 달리기(run) 이동 중 서버가 시뮬레이션한 수평 속도(vx)가 스냅샷에 반영된다',
    async () => {
      const room = await joinGame(newClient(server))
      await waitForDefinedSnapshot(room)

      room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: 1 })
      const moving = await waitForSnapshotCondition(
        room,
        (s) => s.vx !== 0,
        SNAPSHOT_TIMEOUT_MS,
        '이동 중 vx 반영 대기',
      )

      expect(moving.vx).toBeCloseTo(MOVEMENT.SPEED, 5)
      expect(moving.vz).toBeCloseTo(0, 5)

      await leaveRoom(room)
    },
    15_000,
  )

  it(
    'RQ-62/RQ-61(GA-33 보강): seq가 포함된 move 메시지에 스푸핑 좌표를 함께 실어도 서버 위치는 여전히 그 값을 무시하며, seq 추적도 정상 유지된다',
    async () => {
      const room = await joinGame(newClient(server))
      const baseline = await waitForDefinedSnapshot(room)

      room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: 1 })
      const afterLegit = await waitForSnapshotCondition(
        room,
        (s) => s.x !== baseline.x,
        SNAPSHOT_TIMEOUT_MS,
        '정상 이동 후 위치 변화 대기',
      )
      expect(afterLegit.x).toBeGreaterThan(baseline.x)

      room.send('move', {
        dirX: 1,
        dirZ: 0,
        mode: 'run',
        jump: false,
        seq: 2,
        x: SPOOFED_COORD,
        y: SPOOFED_COORD,
        z: SPOOFED_COORD,
      })
      const afterSpoofed = await waitForSnapshotCondition(
        room,
        (s) => s.x !== afterLegit.x,
        SNAPSHOT_TIMEOUT_MS,
        '스푸핑 메시지 이후 위치 변화 대기',
      )

      expect(afterSpoofed.x).not.toBeCloseTo(SPOOFED_COORD, 0)
      expect(afterSpoofed.y).not.toBeCloseTo(SPOOFED_COORD, 0)
      expect(afterSpoofed.z).not.toBeCloseTo(SPOOFED_COORD, 0)
      expect(afterSpoofed.x).toBeGreaterThan(afterLegit.x)
      // 스푸핑 필드 동봉이 시퀀스 추적 자체를 깨서는 안 된다.
      expect(afterSpoofed.lastProcessedInputSeq).toBe(2)

      await leaveRoom(room)
    },
    20_000,
  )

  it(
    'RQ-62 하위 호환: seq 없이 기존 방식으로 move를 보내도 크래시 없이 정상 동작하고, lastProcessedInputSeq는 갱신되지 않는다(기본값 유지)',
    async () => {
      const room = await joinGame(newClient(server))
      const baseline = await waitForDefinedSnapshot(room)
      expect(baseline.lastProcessedInputSeq).toBe(0)

      // seq 필드 없음 — 기존 rq-20-movement-authority.test.ts/20b 통합
      // 테스트와 동일한 레거시 호출 형태.
      room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
      const afterMove = await waitForSnapshotCondition(
        room,
        (s) => s.x !== baseline.x,
        SNAPSHOT_TIMEOUT_MS,
        'seq 없는 이동 후 위치 변화 대기',
      )

      expect(afterMove.x).toBeGreaterThan(baseline.x) // 이동 자체는 정상 동작(회귀 없음)
      expect(afterMove.lastProcessedInputSeq).toBe(0) // seq를 보낸 적이 없으므로 갱신되지 않는다

      await leaveRoom(room)
    },
    15_000,
  )
})
