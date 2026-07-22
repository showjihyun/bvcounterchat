import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { CAPACITY } from '@shared/constants'

/**
 * RQ-03 정원(플레이어 초과 시 관전자 전환) 통합 테스트 (ADR-0008: Colyseus 룸 경계).
 *
 * 매핑된 골든 케이스: GA-02 (`harness/evals/golden/track-a-product.jsonl`).
 * RQ-03 전문: "...플레이어 정원이 찬 상태에서 접속이 시도되면, 시스템은 그
 * 사용자를 관전자로 입장시켜야 한다(RQ-41)."
 *
 * **스코프 경계(오케스트레이터 지정 — 반드시 지킬 것)**: GA-02 then의 "월드에
 * 물리적으로 존재하지 않는다(RQ-41)"는 이 테스트가 검증하지 않는다. 월드·
 * 물리·위치 개념은 로드맵 4단계(Rapier 물리)가 붙기 전까지 존재하지 않으므로
 * 지금은 관측 자체가 불가능하다. 이 테스트가 지금 관측 가능한 것으로 범위를
 * 좁힌다:
 *   ① 정원 초과 접속자가 `players` 컬렉션에 포함되지 않는다
 *   ② 대신 `spectators` 컬렉션에 소속되어 입장 자체는 성공한다
 * "물리적으로 존재하지 않는다"의 검증은 4단계 통합 테스트로 미루며, 여기서는
 * 물리 관련 단언을 만들지 않는다(team-lead 지시).
 *
 * **가정(coder에게 — team-lead 지시로 확정, 반드시 확인)**: 관전자는 룸
 * state에 `players`와 별도인 `spectators` 컬렉션(MapSchema 관례, sessionId
 * 키, 최소 필드)으로 나타난다. 정원(`CAPACITY.PLAYERS`)을 넘긴 접속자는
 * `players`가 아니라 `spectators`에 등장해야 한다. 이 가정이 달라지면(예:
 * `players` 안에 `isSpectator` 플래그로 구분) 아래 `waitForOwnMembership()`
 * 헬퍼 하나만 그 channel에 맞게 조정하면 되고, `it()`의 단언 로직(소속
 * 컬렉션 비교)은 그대로 유효하다.
 *
 * **결정론 메모**: RQ-02/RQ-04 테스트와 동일하게 실 WebSocket(localhost,
 * 임의 포트)에 의존한다 — ADR-0008이 넷코드 통합 테스트에 명시적으로 허용한
 * 예외다. 모든 대기(`listen`·`joinOrCreate`·`leave`·`close`·소속 컬렉션
 * 관측)에 `withTimeout()`으로 명시적 상한을 건다 — hang 대신 fail로 죽는다.
 * "N초 기다렸다 확인" 같은 실타이머 슬립은 쓰지 않는다 — state 변경 이벤트
 * (`onStateChange`)를 실제로 기다릴 뿐, 임의 시간을 sleep하지 않는다. 정원
 * 값은 리터럴로 복제하지 않고 `@shared/constants`의 `CAPACITY`를 그대로
 * 임포트해 루프 상한으로 쓴다(ADR-0010).
 *
 * `CAPACITY.PLAYERS + 1`개의 실 접속을 순차로 만들어야 해서 다른 통합
 * 테스트보다 느리다 — `it()` 타임아웃을 넉넉히 잡아 hang이 아니라 fail로
 * 드러나게 했다. 매 테스트 뒤 `afterEach`가 그 테스트가 연 접속을 전부
 * 정리한다 — 이 파일은 시나리오가 하나뿐이지만, 접속 잔여물이 다음 테스트로
 * 새는 것을 구조적으로 막는다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const MEMBERSHIP_TIMEOUT_MS = 5_000

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

interface MembershipLike {
  get?: (key: string) => unknown
  size?: number
}

interface RoomStateLike {
  players?: MembershipLike
  spectators?: MembershipLike
}

/**
 * 자기 sessionId가 `players`·`spectators` 중 어느 컬렉션에 먼저 나타나는지
 * 관측한다(위 "가정" 참고). 서버가 join 시점에 확정하는 소속이므로, 최초
 * 상태를 즉시 확인한 뒤 이후로는 `onStateChange` 이벤트가 발생할 때만
 * 재확인한다 — 임의 시간 sleep은 쓰지 않는다.
 */
function waitForOwnMembership(room: Room): Promise<'players' | 'spectators'> {
  return withTimeout(
    new Promise<'players' | 'spectators'>((resolve) => {
      const tryResolve = (): void => {
        const state = room.state as RoomStateLike | null
        if (state?.players?.get?.(room.sessionId) !== undefined) {
          resolve('players')
          return
        }
        if (state?.spectators?.get?.(room.sessionId) !== undefined) {
          resolve('spectators')
        }
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    MEMBERSHIP_TIMEOUT_MS,
    `sessionId=${room.sessionId} 소속 컬렉션(players/spectators) 관측`,
  )
}

describe('RQ-03 정원 — 플레이어 초과 시 관전자 전환', () => {
  describe(`GA-02: 플레이어 ${CAPACITY.PLAYERS}명이 찬 상태에서 다음 접속자는 관전자로 입장한다`, () => {
    let server: RunningServer
    const rooms: Room[] = []

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterEach(async () => {
      // 이 파일은 시나리오가 하나뿐이지만, 향후 케이스가 늘어도 접속
      // 잔여물이 다음 테스트로 새지 않도록 매번 전부 정리한다.
      await Promise.all(rooms.splice(0).map((room) => leaveRoom(room).catch(() => undefined)))
    })

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      `RQ-03/GA-02: 이미 플레이어 ${CAPACITY.PLAYERS}명이 접속 중(정원 가득)일 때, 다음 접속자는 players가 아닌 spectators로 입장한다`,
      async () => {
        // given: 정원(CAPACITY.PLAYERS)만큼 순차 접속시켜 players를 채운다.
        for (let i = 0; i < CAPACITY.PLAYERS; i += 1) {
          const room = await joinGame(newClient(server))
          rooms.push(room)
          const membership = await waitForOwnMembership(room)
          expect(membership).toBe('players')
        }

        // when: 정원이 찬 상태에서 다음(정원+1번째) 접속을 시도한다.
        const overflowRoom = await joinGame(newClient(server))
        rooms.push(overflowRoom)

        // then: players가 아니라 spectators로 입장한다 — 접속 자체는
        // 예외 없이 성공한다(여기까지 도달한 것 자체가 증거). "월드에
        // 물리적으로 존재하지 않는다(RQ-41)"는 위 스코프 경계에 따라 이
        // 테스트가 단언하지 않는다 — 4단계(Rapier)에서 검증할 몫이다.
        const overflowMembership = await waitForOwnMembership(overflowRoom)
        expect(overflowMembership).toBe('spectators')

        // players 컬렉션 자체가 정원을 넘겨 늘어나지 않았음을 재확인한다.
        const state = overflowRoom.state as RoomStateLike | null
        expect(state?.players?.size).toBe(CAPACITY.PLAYERS)
      },
      25_000,
    )
  })
})
