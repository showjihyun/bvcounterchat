import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { CAPACITY } from '@shared/constants'

/**
 * RQ-41 관전 모드 — 채팅 참여 통합 테스트 (ADR-0008: Colyseus 룸 경계).
 *
 * 골든 매핑 없음 — RQ-41 EARS 문면 근거로 진행한다: "관전자는 채팅에
 * 참여할 수 있어야 하며, 월드에 물리적으로 존재하지 않아야 한다(피격·충돌
 * 대상 아님)." RQ-40도 "플레이어 또는 관전자가 채팅 메시지를 보내면..."
 * 이라고 명시해 발신 주체에 관전자를 포함한다.
 *
 * **스코프 경계(`rq-03-spectator-overflow.test.ts`와 동일한 절제)**: "월드에
 * 물리적으로 존재하지 않는다" 부분은 이 파일이 검증하지 않는다 — 물리
 * (Rapier)가 아직 붙지 않아 관측 자체가 불가능하다(그 RQ-03 통합 테스트의
 * 스코프 경계 코멘트와 동일한 근거). 이 파일은 "채팅 참여" 절반만 다룬다.
 *
 * **가정 1(coder에게 — 채널, `rq-40-chat-ordering.test.ts`와 공유)**:
 * `room.send('chat', { text })` → 서버가 `this.broadcast('chat', { nickname,
 * text })`로 **접속 중인 전원**에게 전달한다(ADR-0002 메시지 채널). "전원"은
 * 서버가 관리하는 `players`/`spectators` 컬렉션 구분과 무관하게 Colyseus가
 * 이 룸에 연결된 모든 클라이언트를 뜻한다고 가정한다 — RQ-41이 관전자도
 * 발신·수신 양쪽에 참여한다고 명시하므로, `broadcast()`가 만약 코더 구현에서
 * `players`로만 좁혀졌다면(예: 대상 목록을 직접 순회) 이 테스트가 그 결함을
 * 잡는다.
 *
 * **관전자 상태를 만드는 방법(`rq-03-spectator-overflow.test.ts`와 동일한
 * 절차)**: `CAPACITY.PLAYERS`(정원)만큼 먼저 접속시켜 플레이어 슬롯을 채운
 * 뒤, 그다음 접속자를 관전자로 확보한다(RQ-03). 정원 값은 `@shared/constants`의
 * `CAPACITY`를 그대로 재사용한다(ADR-0010 값 복제 금지).
 *
 * **비용 절감(rq-03 선례를 따름)**: `CAPACITY.PLAYERS`+1개의 실 접속이
 * 필요해 다른 통합 테스트보다 느리다 — 그 비용을 한 번만 지불하도록 두
 * 방향(관전자→플레이어, 플레이어→관전자) 검증을 한 `it()` 안에서 같은
 * 접속 세트로 처리한다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한을 건다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const CHAT_TIMEOUT_MS = 5_000

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

async function joinGame(server: RunningServer, nickname: string): Promise<Room> {
  return withTimeout(
    newClient(server).joinOrCreate(ROOM_NAME, { nickname }),
    JOIN_TIMEOUT_MS,
    `joinOrCreate('${ROOM_NAME}', { nickname: '${nickname}' })`,
  )
}

async function leaveRoom(room: Room): Promise<void> {
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface ChatBroadcast {
  nickname: string
  text: string
}

/** `text`와 정확히 일치하는 'chat' 메시지 1개를 대기한다(단발 대기 — 이
 * 파일은 방마다 관측이 최대 1회뿐이다). */
function waitForChatText(room: Room, text: string, timeoutMs: number, label: string): Promise<ChatBroadcast> {
  return withTimeout(
    new Promise<ChatBroadcast>((resolve) => {
      room.onMessage<ChatBroadcast>('chat', (message) => {
        if (message.text === text) resolve(message)
      })
    }),
    timeoutMs,
    label,
  )
}

/** join 시점에 수신하는 이력 복원 메시지를 대기한다(RQ-40 가정 2,
 * `rq-40-chat-history-restore.test.ts`의 동일 이름 헬퍼와 같은 계약). */
function waitForChatHistory(room: Room, timeoutMs: number, label: string): Promise<ChatBroadcast[]> {
  return withTimeout(
    new Promise<ChatBroadcast[]>((resolve) => {
      room.onMessage<ChatBroadcast[]>('chat-history', (history) => resolve(history))
    }),
    timeoutMs,
    label,
  )
}

describe('RQ-41 관전 모드 — Global Chat 참여(RQ-40)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    `RQ-41/RQ-40: 플레이어 정원(${CAPACITY.PLAYERS})이 찬 뒤 입장한 관전자가 보낸 채팅을 플레이어가 받고, 플레이어가 보낸 채팅을 관전자도 받는다`,
    async () => {
      // given: 정원만큼 순차 접속시켜 플레이어 슬롯을 채운다. 마지막(정원
      // 번째) 접속자를 "테스트 대상 플레이어"로 삼는다.
      const playerRooms: Room[] = []
      for (let i = 0; i < CAPACITY.PLAYERS; i += 1) {
        playerRooms.push(await joinGame(server, `filler-${i}`))
      }
      const testPlayer = playerRooms[playerRooms.length - 1]
      if (!testPlayer) throw new Error('플레이어 정원 채우기 실패 — playerRooms가 비어 있다')

      // when: 정원이 찬 상태에서 접속한 다음 사용자는 RQ-03에 따라
      // 관전자로 입장한다(이 파일은 그 판정 로직 자체를 재검증하지 않는다
      // — `rq-03-spectator-overflow.test.ts`가 이미 전담).
      const spectator = await joinGame(server, 'spectator-1')

      // then(관전자 → 플레이어): 관전자가 보낸 메시지를 플레이어가 받는다.
      const playerReceived = waitForChatText(testPlayer, 'from-spectator', CHAT_TIMEOUT_MS, '플레이어가 관전자의 메시지 수신')
      spectator.send('chat', { text: 'from-spectator' })
      const fromSpectator = await playerReceived
      expect(fromSpectator.text).toBe('from-spectator')
      expect(fromSpectator.nickname).toBe('spectator-1')

      // then(플레이어 → 관전자): 플레이어가 보낸 메시지를 관전자가 받는다.
      const spectatorReceived = waitForChatText(spectator, 'from-player', CHAT_TIMEOUT_MS, '관전자가 플레이어의 메시지 수신')
      testPlayer.send('chat', { text: 'from-player' })
      const fromPlayer = await spectatorReceived
      expect(fromPlayer.text).toBe('from-player')

      await Promise.all([...playerRooms.map((room) => leaveRoom(room)), leaveRoom(spectator)])
    },
    30_000,
  )
})

/**
 * RQ-41/RQ-40 — 관전자로 입장하는 접속도 'chat-history' 이력 복원을 받는지
 * (evaluator 델타 재평가 3회차 FAIL 보강, `_workspace/RQ-40/03_evaluator_report.md`
 * §D5-3·§D6-(c)).
 *
 * RQ-40 문면("접속·재접속 시 이를 복원해야 한다")은 발신·수신 주체를
 * 플레이어로 좁히지 않고, 같은 RQ가 발신 주체를 "플레이어 또는 관전자"로
 * 명시하며 RQ-41이 관전자의 채팅 참여를 못박는다 — 복원 대상을 플레이어로
 * 한정할 근거가 스펙에 없다.
 *
 * 위 describe와 서버(beforeAll/afterAll)를 공유하지 않고 새 describe로
 * 분리한다 — 이 파일의 기존 서버는 이미 'from-spectator'·'from-player' 두
 * 메시지를 이력에 쌓아 두므로, 그 서버를 재사용하면 아래 `toEqual(['before-
 * spectator'])`처럼 이력 내용을 정확히 단언하는 케이스가 오염된다
 * (`rq-40-chat-history-restore.test.ts` 파일 상단 "격리 주의"와 동일한 이유 —
 * `GameRoom`은 `autoDispose = false`라 룸이 살아있는 한 `chatHistory`가
 * `it()` 사이에 리셋되지 않는다). 새 `beforeAll`/`afterAll`로 이 describe만의
 * 빈 이력에서 시작하는 서버를 새로 기동한다.
 *
 * 그물이 없었던 실증: `onJoin`의 관전자 분기(`this.state.spectators.size <
 * CAPACITY.SPECTATORS` 아래)에서 `client.send('chat-history', ...)` 호출을
 * 지워도 이전에는 통합 스위트가 전부 통과했다(evaluator 프로브 A3,
 * `[timeout 5000ms] 관전자가 이력 복원 수신`으로 실패하는 것까지 확인 완료).
 */
describe('RQ-41 관전 모드 — 접속 시 채팅 이력 복원(RQ-40)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    `RQ-41/RQ-40: 플레이어 정원(${CAPACITY.PLAYERS})이 찬 뒤 플레이어가 남긴 메시지를, 그다음 입장한 관전자가 접속 직후 'chat-history'로 복원받는다`,
    async () => {
      // given: 정원만큼 순차 접속시켜 플레이어 슬롯을 채운다.
      const playerRooms: Room[] = []
      for (let i = 0; i < CAPACITY.PLAYERS; i += 1) {
        playerRooms.push(await joinGame(server, `hist-filler-${i}`))
      }
      const testPlayer = playerRooms[playerRooms.length - 1]
      if (!testPlayer) throw new Error('플레이어 정원 채우기 실패 — playerRooms가 비어 있다')

      // 플레이어가 메시지 1건을 남긴다 — 자신이 그 브로드캐스트를 수신할
      // 때까지 기다려 서버 쪽 이력 갱신이 끝났음을 임의 슬립 없이 확인한다.
      const ownReceived = waitForChatText(testPlayer, 'before-spectator', CHAT_TIMEOUT_MS, '플레이어가 자신의 메시지 수신(이력 반영 대기)')
      testPlayer.send('chat', { text: 'before-spectator' })
      await ownReceived

      // when: 정원이 찬 상태에서 접속한 다음 사용자는 RQ-03에 따라
      // 관전자로 입장한다.
      const spectator = await joinGame(server, 'history-spectator')
      const history = await waitForChatHistory(spectator, CHAT_TIMEOUT_MS, '관전자가 이력 복원 수신')

      // then: 관전자도 접속 직후 그 이력을 그대로 받는다.
      expect(history.map((m) => m.text)).toEqual(['before-spectator'])

      await Promise.all([...playerRooms.map((room) => leaveRoom(room)), leaveRoom(spectator)])
    },
    30_000,
  )
})
