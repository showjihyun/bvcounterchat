import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { CAPACITY } from '@shared/constants'

/**
 * RQ-03 정원(합계 20 초과 시 접속 거부) 통합 테스트 (ADR-0008: Colyseus 룸 경계).
 *
 * 매핑된 골든 케이스: GA-21 (`harness/evals/golden/track-a-product.jsonl`).
 * RQ-03 전문: "...관전자 정원까지 찬 상태에서 접속이 시도되면, 시스템은
 * 접속을 거부하고 사유를 응답해야 한다."
 *
 * **이 파일의 범위(과잉 결합 금지 — GA-02와 관심사 분리)**: GA-21의 given은
 * "플레이어 10 + 관전자 10(합계 20)이 이미 접속 중"이지만, 그 20명이 실제로
 * players/spectators로 정확히 분류되는지는 `rq-03-spectator-overflow.test.ts`
 * (GA-02)의 책임이다. 이 파일은 그 분류를 다시 단언하지 않는다 — "합계
 * `CAPACITY.PLAYERS + CAPACITY.SPECTATORS`명이 이미 성공적으로 접속해
 * 있다"는 사실만 만들고, 이 파일이 검증하는 것은 오직 **21번째 접속의
 * 결과**(거부 여부와 사유 포함 여부)다. 두 파일이 서로 다른 verify 경로를
 * 갖는 이유이기도 하다(team-lead 지시).
 *
 * **가정(coder에게 — 반드시 확인)**: 21번째 접속은 `joinOrCreate`가
 * **에러로 실패**하는 것으로 관측한다(성공 후 별도 메시지로 거부를 알리는
 * 방식이 아니라고 가정한다). 정확한 에러 문구나 에러 클래스(`ServerError`
 * 여부, `.code` 존재 여부 등)에는 결합하지 않는다 — 아래 단언은 ①
 * `Error`가 던져진다 ② 그 `.message`가 빈 문자열이 아니다(=식별 가능한
 * 사유가 응답에 담겨 있다는 최소 증거)만 확인한다. coder가 다른 방식(예:
 * 거부 사유를 커스텀 이벤트로 push)을 택하면 이 파일의 관측 지점만
 * 조정하면 된다.
 *
 * **결정론 메모**: RQ-02/RQ-04/GA-02 테스트와 동일하게 실 WebSocket
 * (localhost, 임의 포트)에 의존한다 — ADR-0008이 넷코드 통합 테스트에
 * 명시적으로 허용한 예외다. 모든 대기(`listen`·`joinOrCreate`·`leave`·
 * `close`)에 `withTimeout()`으로 명시적 상한을 건다 — hang 대신 fail로
 * 죽는다. 정원 값은 리터럴로 복제하지 않고 `@shared/constants`의
 * `CAPACITY`를 그대로 임포트해 루프 상한으로 쓴다(ADR-0010).
 *
 * `CAPACITY.PLAYERS + CAPACITY.SPECTATORS + 1`(=21)개의 실 접속을 순차로
 * 만들어야 해서 다른 통합 테스트보다 훨씬 느리다 — `it()` 타임아웃을
 * 넉넉히 잡아 hang이 아니라 fail로 드러나게 했다. 매 테스트 뒤 `afterEach`가
 * 그 테스트가 연 접속을 전부 정리한다.
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

const TOTAL_CAPACITY = CAPACITY.PLAYERS + CAPACITY.SPECTATORS

describe('RQ-03 정원 — 합계 초과 시 접속 거부', () => {
  describe(`GA-21: 합계 ${TOTAL_CAPACITY}명(플레이어+관전자)이 찬 상태에서 다음 접속은 사유와 함께 거부된다`, () => {
    let server: RunningServer
    const rooms: Room[] = []

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterEach(async () => {
      // 접속 잔여물이 다음 테스트로 새지 않도록 매번 전부 정리한다.
      await Promise.all(rooms.splice(0).map((room) => leaveRoom(room).catch(() => undefined)))
    })

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      `RQ-03/GA-21: 플레이어+관전자 합계 ${TOTAL_CAPACITY}명이 이미 접속 중일 때, ${TOTAL_CAPACITY + 1}번째 접속은 거부되고 응답에 거부 사유가 포함된다`,
      async () => {
        // given: 합계 정원(TOTAL_CAPACITY)만큼 순차 접속시켜 채운다. 각
        // 접속의 players/spectators 분류 자체는 이 파일의 관심사가 아니다
        // (위 "이 파일의 범위" 참고) — 예외 없이 접속이 성립하는 것만
        // 확인한다.
        for (let i = 0; i < TOTAL_CAPACITY; i += 1) {
          const room = await joinGame(newClient(server))
          rooms.push(room)
        }

        // when: 합계 정원이 찬 상태에서 다음(정원+1번째) 접속을 시도한다.
        let rejection: unknown
        try {
          const overflowRoom = await joinGame(newClient(server))
          // 예상과 달리 성공했다면(=거부 로직 미구현) 정리 대상에 넣는다 —
          // 그래도 아래 expect가 이 상황을 실패로 드러낸다.
          rooms.push(overflowRoom)
        } catch (err) {
          rejection = err
        }

        // then: 접속이 거부된다 — 정확한 에러 클래스·문구에는 결합하지
        // 않고, Error가 던져졌다는 것과 그 사유(message)가 비어 있지
        // 않다는 것만 단언한다(식별 가능성만 확인, 문구 결합 금지).
        expect(rejection).toBeInstanceOf(Error)
        const message = rejection instanceof Error ? rejection.message : ''
        expect(message.length).toBeGreaterThan(0)
      },
      35_000,
    )
  })
})
