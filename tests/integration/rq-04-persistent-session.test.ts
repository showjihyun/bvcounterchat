import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from 'colyseus.js'
import type { Room } from 'colyseus.js'
import { buildServer } from '@server/index'

/**
 * RQ-04 상설 세션 통합 테스트 (ADR-0008: Colyseus 룸 경계).
 *
 * 매핑된 골든 케이스: GA-26~29 (`harness/evals/golden/track-a-product.jsonl`).
 * RQ-04 전문: "시스템은 라운드·매치 종료 없이 상시 접속 가능한 단일 상설
 * 세션으로 동작해야 한다. 서버는 플레이어가 0명이어도 종료되지 않아야 한다."
 *
 * **가정(coder에게)**: 룸 이름은 `'game'`으로 가정한다 — 스펙·기존 코드
 * 어디에도 명명 규칙이 없어 test-writer가 정했다. 다른 이름을 쓴다면 이
 * 파일의 `ROOM_NAME` 상수 한 줄만 바꾸면 된다. 룸 클래스 구현 파일 위치는
 * `src/server/rooms/GameRoom.ts`로 가정하되(team-lead 예시), **이 테스트는
 * 그 모듈을 직접 임포트하지 않는다** — Colyseus 룸 경계(ADR-0008)를
 * `colyseus.js` 클라이언트로만 접속해 검증하는 블랙박스 통합 테스트이므로,
 * 룸 구현이 실제로 어느 파일에 있든 이 테스트는 영향받지 않는다. `buildServer()`
 * (기존 `@server/index`, 이미 존재)가 내부적으로 Colyseus `Server`를 Fastify의
 * HTTP 서버에 부착하고 `'game'` 룸을 등록할 것으로 가정한다(ADR-0002).
 *
 * **결정론 메모**: 이 테스트는 실 WebSocket(localhost, 임의 포트)에
 * 의존한다 — ADR-0008이 넷코드 통합 테스트에 명시적으로 허용한 예외다("완전한
 * 격리는 아니다"). 대신:
 * - 모든 네트워크 대기(`listen`·`joinOrCreate`·`leave`·`close`)에
 *   `withTimeout()`으로 명시적 상한을 건다 — hang 대신 fail로 죽는다.
 * - "N초 기다렸다 확인" 같은 실타이머 슬립은 쓰지 않는다. 이벤트(join 성공·
 *   leave 완료)를 실제로 기다릴 뿐, 임의 시간을 sleep하지 않는다.
 * - GA-28("서버 재시작")은 실제 프로세스 kill이 아니라 **같은 테스트 프로세스
 *   안에서 `buildServer()`를 다시 호출**해 시뮬레이션한다(team-lead 지시) —
 *   새 Colyseus `Server` 인스턴스는 매치메이킹 드라이버를 새로 만들어 이전
 *   인스턴스가 만든 룸을 모른다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000

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
    "app.listen({ port: 0 })",
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

describe('RQ-04 상설 세션', () => {
  describe('GA-26: 플레이어·관전자 0명이 돼도 룸이 종료되지 않는다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      'RQ-04/GA-26: 두 접속이 모두 끊겨 0명이 돼도 세션이 유지되며, 다음 접속이 같은 세션에 정상 입장한다',
      async () => {
        const roomA = await joinGame(newClient(server))
        const persistentRoomId = roomA.roomId

        const roomB = await joinGame(newClient(server))
        expect(roomB.roomId).toBe(persistentRoomId)

        // 두 접속을 모두 종료 — 플레이어·관전자 0명 상태를 만든다.
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])

        // 새 접속(3번째 사용자)이 여전히 같은 세션(roomId)에 입장해야 한다 —
        // 룸이 폐기되고 새로 만들어졌다면 roomId가 달라진다.
        const roomC = await joinGame(newClient(server))
        expect(roomC.roomId).toBe(persistentRoomId)

        await leaveRoom(roomC)
      },
      15_000,
    )

    it(
      'RQ-04/GA-26: 0명↔재입장을 여러 번 반복해도 매번 같은 세션(roomId)으로 돌아온다',
      async () => {
        const roomIds: string[] = []
        for (let round = 0; round < 3; round += 1) {
          const room = await joinGame(newClient(server))
          roomIds.push(room.roomId)
          await leaveRoom(room)
        }
        expect(new Set(roomIds).size).toBe(1)
      },
      20_000,
    )
  })

  describe('GA-27: 임의 시점에 진행 중인 세션에 즉시 합류한다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      'RQ-04/GA-27: 기존 플레이어가 있는 세션에 새 사용자가 접속하면, 매치·라운드 종료를 기다리지 않고 즉시 합류한다',
      async () => {
        const existingRoom = await joinGame(newClient(server))

        // "임의 시점"의 새 접속 — 대기열·다음 판 옵션 없이 바로 joinOrCreate만
        // 호출한다. 이 호출이 유한 시간(JOIN_TIMEOUT_MS) 안에 성공하는 것
        // 자체가 "대기 상태·다음 판 개념이 없다"는 증거다 — 그런 게이트가
        // 있다면 join이 그 게이트가 열릴 때까지 끝나지 않는다.
        const newcomerRoom = await joinGame(newClient(server))

        expect(newcomerRoom.roomId).toBe(existingRoom.roomId)
        expect(newcomerRoom.sessionId).not.toBe(existingRoom.sessionId)

        await Promise.all([leaveRoom(existingRoom), leaveRoom(newcomerRoom)])
      },
      15_000,
    )
  })

  describe('GA-29: 서버 전체에 게임 세션은 단 하나뿐이다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      'RQ-04/GA-29: 여러 사용자가 동시에 접속해도 전부 같은 단일 세션에 합류한다 (룸 중복 없음)',
      async () => {
        const clients = Array.from({ length: 5 }, () => newClient(server))
        const rooms = await withTimeout(
          Promise.all(clients.map((client) => joinGame(client))),
          JOIN_TIMEOUT_MS,
          '5명 동시 joinOrCreate',
        )

        const roomIds = new Set(rooms.map((room) => room.roomId))
        expect(roomIds.size).toBe(1)

        await Promise.all(rooms.map((room) => leaveRoom(room)))
      },
      20_000,
    )
  })

  describe('GA-28: 서버 재시작 시 진행 중 세션 상태가 소실된다', () => {
    it(
      'RQ-04/GA-28: 새 서버 인스턴스는 이전 인스턴스가 만든 세션(roomId)을 모른다 — 재시작은 새 세션이다',
      async () => {
        // "재시작"은 실제 프로세스 kill이 아니라 서버 인스턴스를 새로 만드는
        // 것으로 시뮬레이션한다(team-lead 지시). 아래 before/after는 각각
        // 별개의 Colyseus Server 인스턴스를 갖는다(각 buildServer() 호출이
        // 새 인메모리 매치메이킹 드라이버를 만든다).
        const before = await startServer()
        const beforeRoom = await joinGame(newClient(before))
        const beforeRoomId = beforeRoom.roomId

        // 세션에 참여한 채로(정상 leave 없이) 서버가 내려간다 — 재시작과
        // 동일한 조건(RQ-11과 같은 인메모리 소실 정책, GA-28 given).
        await stopServer(before)

        const after = await startServer()
        try {
          const afterRoom = await joinGame(newClient(after))
          expect(afterRoom.roomId).not.toBe(beforeRoomId)
          await leaveRoom(afterRoom)
        } finally {
          await stopServer(after)
        }
      },
      20_000,
    )
  })
})
