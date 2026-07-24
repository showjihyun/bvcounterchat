import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'

/**
 * RQ-20 이동 — 서버 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus 룸 경계).
 *
 * 매핑된 골든 케이스: GA-33 (`harness/evals/golden/track-a-product.jsonl`).
 * GA-33: "given: 플레이어가 접속해 이동 중 / when: 클라이언트가 임의
 * 좌표를 직접 보고 / then: 서버는 보고된 좌표를 무시하고 입력(방향·상태)만으로
 * 시뮬레이션한 위치를 유지한다 (RQ-61 서버 권위)."
 * RQ-61 전문: "위치·HP·킬 등 모든 게임 상태의 진실 공급원은 서버이며,
 * 클라이언트가 보고한 상태는 그대로 반영하지 않아야 한다."
 *
 * **레벨 분리(ADR-0008) — 이 파일은 서버 권위(입력만 신뢰) 확인 전담**:
 * 이동 산술의 정밀 검증(6m/s·앉기 3m/s·천천히 4.2m/s·점프 궤적·공중 가속
 * 미허용)은 `tests/unit/sim-movement.test.ts`(순수 함수 결정론 단위)의
 * 책임이다. 이 파일은 "클라이언트가 보낸 좌표가 서버 상태에 그대로
 * 반영되지 않는다"만 실 Colyseus 룸 경계에서 확인한다 — 값의 정밀도가
 * 아니라 권위의 소재(RQ-61)가 검증 대상이다. 그래서 이 테스트는
 * `@shared/sim/movement`를 임포트하지 않는다 — 서버 내부 구현 모듈에
 * 결합하지 않는 블랙박스 통합 테스트(ADR-0008 "Colyseus 룸 경계")다.
 *
 * **가정 1(coder에게 — Player 스키마 위치 필드)**: `Player`
 * (`@shared/schema/GameState`)에 `x`·`y`·`z`(number) 필드가 추가되고,
 * 서버의 30Hz 틱 루프가 매 틱 `stepMovement`로 각 플레이어 위치를 갱신해
 * 브로드캐스트한다고 가정한다. 이 테스트는 스키마 클래스를 직접 임포트하지
 * 않는다 — `colyseus.js` 클라이언트로 상태 동기화만 관측하는 블랙박스
 * 방식이다. `room.state.players.get(sessionId)`에서 `x`·`y`·`z`를 읽는
 * 관측 지점만 가정하며, 필드명이 다르면 이 파일의 `readPosition()` 헬퍼
 * 한 곳만 조정하면 된다.
 *
 * **가정 2(coder에게 — 'move' 메시지 shape)**: 클라이언트는
 * `room.send('move', { dirX, dirZ, mode, jump })`로 이동 입력을 보낸다.
 * `dirX`·`dirZ`는 정규화된 수평 방향, `mode`는 `'run'|'walk'|'crouch'`,
 * `jump`는 boolean — `tests/unit/sim-movement.test.ts`의 `MoveInput`과
 * 같은 필드 구성이다(클라 예측 RQ-62가 서버와 어긋나지 않으려면 같은
 * shape을 공유해야 한다는 것이 그 파일의 근거이며, 이 파일은 그 shape을
 * 별도로 정의해 재확인한다 — 임포트 결합은 피하되 계약은 동일하게
 * 유지한다). 서버는 각 플레이어의 **가장 최근에 수신한 입력을 다음 입력이
 * 올 때까지 유지**하며 매 틱 시뮬레이션에 그대로 반영한다고 가정한다
 * (실시간 FPS 이동 입력의 표준 모델 — 클라이언트가 매 프레임 재전송).
 *
 * **가정 3(coder에게 — GA-33 "임의 좌표 직접 보고"의 구체화)**: GA-33의
 * "클라이언트가 임의 좌표를 직접 보고"를 "`move` 메시지 페이로드에
 * 방향·상태 필드와 함께 조작된 절대 좌표(x·y·z)를 실어 보낸다"로
 * 구체화했다 — 이 프로젝트에 좌표를 직접 실어 보내는 메시지 채널이
 * `move` 하나뿐이라고 가정하기 때문이다(별도 `teleport`류 메시지는
 * 스펙·기존 코드 어디에도 없다). 서버가 이 메시지의 여분 필드(x·y·z)를
 * 무시하고 방향·상태 필드만 읽어 시뮬레이션에 반영하는지가 이 파일의
 * 핵심 단언이다.
 *
 * **결정론 메모**: RQ-02/03/04/60 통합 테스트와 동일하게 실 WebSocket
 * (localhost, 임의 포트)에 의존한다(ADR-0008 허용 예외). 모든 대기에
 * `withTimeout()` 상한을 걸고, 위치 관측은 고정 슬립 대신 `onStateChange`로
 * 실제 갱신을 기다린다 — "직전 값과 달라질 때까지" 폴링하는 방식으로,
 * 메시지 전송 직후 도착하는 무관한 상태 갱신(예: 매 틱 갱신되는
 * `tick` 필드, RQ-60)을 우리가 보낸 메시지의 효과로 착각하는 경합을 피한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const POSITION_TIMEOUT_MS = 5_000
/** 스푸핑 대상 좌표 — 60×60m 맵(RQ-30, WORLD.SIZE_M)을 아득히 벗어나는
 * 값이라 "이 좌표 근처에도 못 온다"를 관대한 오차 없이 단언할 수 있다. */
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

/** 새 사용자의 접속을 흉내낸다 — Client 자체는 접속을 만들지 않는다. */
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

interface Position {
  x: number
  y: number
  z: number
}

/** 룸 state에서 자신의 위치를 읽는다(가정 1). 필드가 아직 없거나 patch가
 * 아직 도착하지 않았으면 undefined. */
function readPosition(room: Room): Position | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; y?: unknown; z?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(room.sessionId)
  if (typeof player?.x === 'number' && typeof player?.y === 'number' && typeof player?.z === 'number') {
    return { x: player.x, y: player.y, z: player.z }
  }
  return undefined
}

/** 위치 필드가 처음 관측될 때까지 기다린다(join 직후 아직 patch 전일 수
 * 있다). */
function waitForDefinedPosition(room: Room): Promise<Position> {
  return withTimeout(
    new Promise<Position>((resolve) => {
      const tryResolve = (): void => {
        const current = readPosition(room)
        if (current) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    POSITION_TIMEOUT_MS,
    '초기 위치 필드 관측',
  )
}

/**
 * `previous`와 값이 달라진 위치가 관측될 때까지 기다린다. 매 틱(RQ-60)마다
 * `tick` 필드가 갱신돼 `onStateChange`가 계속 발화하므로, "다음 한 번의
 * onStateChange"만 신뢰하면 우리가 보낸 메시지가 아직 처리되기 전의
 * 무관한 갱신을 붙잡는 경합이 생긴다 — 그래서 값이 실제로 달라질 때까지
 * 반복 확인한다(rq-02 통합 테스트의 `waitForNickname`과 동일한 패턴).
 */
function waitForPositionChange(room: Room, previous: Position): Promise<Position> {
  return withTimeout(
    new Promise<Position>((resolve) => {
      const tryResolve = (): void => {
        const current = readPosition(room)
        if (current && (current.x !== previous.x || current.y !== previous.y || current.z !== previous.z)) {
          resolve(current)
        }
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    POSITION_TIMEOUT_MS,
    '위치 변화 관측(직전 값과 달라질 때까지)',
  )
}

/** 다음 상태 갱신 1회를 기다린다(값 무관 — RQ-60 틱 갱신만으로도 발화). */
function waitForNextStateChange(room: Room): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      room.onStateChange.once(() => resolve())
    }),
    POSITION_TIMEOUT_MS,
    '다음 상태 갱신 대기',
  )
}

describe('RQ-20 이동 — 서버 권위(RQ-61), 클라이언트 좌표 보고 무시 (GA-33)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "RQ-20/GA-33: 'move' 메시지에 조작된 절대 좌표(x·y·z)를 실어 보내도, 서버의 플레이어 위치는 그 값이 아니라 입력 시뮬레이션 결과를 유지한다",
    async () => {
      const room = await joinGame(newClient(server))
      const baseline = await waitForDefinedPosition(room)

      // 정상 입력으로 방향 이동 — 서버가 실제로 시뮬레이션을 도는지 확인
      // 하는 전제 조건이다(이게 안 움직이면 아래 스푸핑 단언 자체가
      // 무의미해진다).
      room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
      const afterLegitMove = await waitForPositionChange(room, baseline)
      expect(afterLegitMove.x).toBeGreaterThan(baseline.x)

      // 스푸핑 시도 — 방향 필드(dirX·dirZ·mode·jump)는 정상값 그대로 두고
      // 조작된 절대 좌표를 함께 실어 보낸다("정상 이동 입력에 좌표만
      // 얹은" 시나리오 — 팀리드 지시 원문의 "조작된 move에 좌표 필드").
      room.send('move', {
        dirX: 1,
        dirZ: 0,
        mode: 'run',
        jump: false,
        x: SPOOFED_COORD,
        y: SPOOFED_COORD,
        z: SPOOFED_COORD,
      })
      const afterSpoofedMove = await waitForPositionChange(room, afterLegitMove)

      // 핵심 단언(RQ-61): 서버 위치가 스푸핑 좌표 근처로 가지 않는다.
      expect(afterSpoofedMove.x).not.toBeCloseTo(SPOOFED_COORD, 0)
      expect(afterSpoofedMove.y).not.toBeCloseTo(SPOOFED_COORD, 0)
      expect(afterSpoofedMove.z).not.toBeCloseTo(SPOOFED_COORD, 0)

      // 스푸핑 메시지도 방향 필드는 정상이었으므로, 위치는 계속 같은
      // 방향으로 전진했어야 한다 — "스푸핑이 반영되지 않았을 뿐 입력
      // 시뮬레이션 자체는 계속된다"(GA-33 then 원문 "유지한다")는 것을,
      // 단순 정지가 아니라는 방식으로 구분한다.
      expect(afterSpoofedMove.x).toBeGreaterThan(afterLegitMove.x)

      await leaveRoom(room)
    },
    20_000,
  )

  it(
    'RQ-20: 이동 입력 없이 접속만 하면(무입력) 위치가 스스로 표류하지 않는다',
    async () => {
      const room = await joinGame(newClient(server))
      const baseline = await waitForDefinedPosition(room)

      // 여러 상태 갱신(RQ-60 틱 갱신 포함)을 거쳐도 무입력 상태의 위치는
      // 그대로인지 확인한다 — 고정 슬립 대신 상태 변경 이벤트를 실제로
      // 3회 관측한다.
      for (let i = 0; i < 3; i += 1) {
        await waitForNextStateChange(room)
        expect(readPosition(room)).toEqual(baseline)
      }

      await leaveRoom(room)
    },
    15_000,
  )
})
