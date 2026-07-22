import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'

/**
 * RQ-02 닉네임 식별 + 자동 접미사 통합 테스트 (ADR-0008: Colyseus 룸 경계).
 *
 * 매핑된 골든 케이스: GA-01 (`harness/evals/golden/track-a-product.jsonl`).
 * RQ-02 전문: "사용자가 접속하면, 시스템은 닉네임 입력만으로 사용자를
 * 식별해야 한다(계정·비밀번호 없음). 이미 사용 중인 닉네임이 입력되면,
 * 시스템은 자동 접미사를 붙여 고유한 닉네임을 부여해야 한다."
 *
 * **가정 1(join options로 닉네임 전달)**: Colyseus 관례대로 닉네임은
 * `client.joinOrCreate('game', { nickname })`의 join options로 전달한다.
 * 스펙·기존 코드 어디에도 이 파라미터명의 명명 규칙이 없어 test-writer가
 * 정했다 — coder가 다른 옵션 키를 쓰기로 하면 이 파일의 `joinWithNickname()`
 * 헬퍼 한 곳만 손보면 된다.
 *
 * **가정 2(관측 채널 — team-lead 지시)**: 서버가 확정한 최종 닉네임은
 * 룸 state의 `players` 컬렉션(Map 유사 — Colyseus MapSchema 관례)에서
 * 자기 sessionId로 조회한 엔트리의 `nickname` 필드로 노출된다고 가정한다 —
 * `room.state.players.get(room.sessionId).nickname`. 이 테스트는 그
 * shape을 강제하는 서버 내부 모듈을 직접 임포트하지 않는다 — `colyseus.js`
 * 클라이언트로 접속해 상태 동기화(Schema)만 관측하는 블랙박스 방식이다
 * (ADR-0008 "Colyseus 룸 경계"). 이 가정이 달라지면(예: 별도 메시지로
 * 노출) 이 파일의 `waitForNickname()` 헬퍼 하나만 그 channel에 맞게
 * 조정하면 되고, 각 `it()`의 단언 로직(최종 닉네임 값 비교)은 그대로
 * 유효하다.
 *
 * **단언 범위(과잉 결합 금지)**: GA-01의 "striker-2"는 예시일 뿐, 정확한
 * 접미사 형식에는 결합하지 않는다. 아래만 단언한다 — ① 충돌한 후발 접속자의
 * 최종 닉네임이 원본과 다르다 ② 선발 접속자의 닉네임은 그대로다
 * ③ 서로 다른 접속자들의 최종 닉네임은 전부 고유하다 ④ 후발 접속자의 최종
 * 닉네임은 원본 문자열로 시작한다(접미사가 "붙는" 것이므로 원본이
 * 보존된다) ⑤ 후발 접속자의 접속 자체는 성공한다(예외 없이 join이 끝난다).
 *
 * **스코프 밖(의도적으로 테스트하지 않음, team-lead 지시)**: 퇴장 후 닉네임
 * 재사용 가능 여부, 닉네임 길이·허용 문자 제한, UUID 통계 키잉(RQ-81),
 * 새로고침 시 닉네임 복원 — 스펙이 침묵하는 지점이며 이 파일이 임의로
 * 규정하지 않는다.
 *
 * **결정론 메모**: RQ-04 테스트(`rq-04-persistent-session.test.ts`)와 동일하게
 * 실 WebSocket(localhost, 임의 포트)에 의존한다 — ADR-0008이 넷코드 통합
 * 테스트에 명시적으로 허용한 예외다. 모든 대기(`listen`·`joinOrCreate`·
 * `leave`·`close`·닉네임 state 관측)에 `withTimeout()`으로 명시적 상한을
 * 건다 — hang 대신 fail로 죽는다. "N초 기다렸다 확인" 같은 실타이머 슬립은
 * 쓰지 않는다 — state 변경 이벤트(`onStateChange`)를 실제로 기다릴 뿐,
 * 임의 시간을 sleep하지 않는다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const NICKNAME_TIMEOUT_MS = 5_000

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

/** 닉네임을 join options로 전달해 접속한다(가정 1). */
async function joinWithNickname(client: Client, nickname: string): Promise<Room> {
  return withTimeout(
    client.joinOrCreate(ROOM_NAME, { nickname }),
    JOIN_TIMEOUT_MS,
    `joinOrCreate('${ROOM_NAME}', { nickname: '${nickname}' })`,
  )
}

async function leaveRoom(room: Room): Promise<void> {
  // consented=true — 정상적인 접속 종료(비정상 단절이 아니다).
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

/**
 * 서버가 확정한 최종 닉네임을 룸 state에서 관측한다(가정 2). 접속 시점에
 * 이미 상태가 반영돼 있을 수도, 첫 patch를 기다려야 할 수도 있어 두 경로
 * 모두 확인한다 — 임의 시간 sleep 없이 `onStateChange` 이벤트로만
 * 재확인한다.
 */
function waitForNickname(room: Room): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve) => {
      const tryResolve = (): void => {
        const state = room.state as { players?: { get?: (key: string) => { nickname?: unknown } | undefined } } | null
        const nickname = state?.players?.get?.(room.sessionId)?.nickname
        if (typeof nickname === 'string' && nickname.length > 0) {
          resolve(nickname)
        }
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    NICKNAME_TIMEOUT_MS,
    `players 컬렉션에서 sessionId=${room.sessionId}의 닉네임 관측`,
  )
}

describe('RQ-02 닉네임 식별 + 자동 접미사', () => {
  describe('GA-01: 동일 닉네임으로 접속하면 후발 접속자가 자동 접미사를 받는다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      "RQ-02/GA-01: user1이 'striker'로 접속 중일 때 user2가 동일 닉네임으로 접속하면, user2는 고유한 접미사 붙은 닉네임을 받고 user1의 닉네임은 그대로다",
      async () => {
        const room1 = await joinWithNickname(newClient(server), 'striker')
        const nickname1 = await waitForNickname(room1)
        expect(nickname1).toBe('striker')

        // user2 접속 자체가 예외 없이 끝난다 — 접속 성공의 증거(단언 ⑤).
        const room2 = await joinWithNickname(newClient(server), 'striker')
        const nickname2 = await waitForNickname(room2)

        // 단언 ①②③④ — 정확한 접미사 형식("-2" 등)에는 결합하지 않는다.
        expect(nickname2).not.toBe('striker')
        expect(nickname2.startsWith('striker')).toBe(true)
        expect(nickname2).not.toBe(nickname1)

        // user1의 닉네임은 후발 접속자의 존재와 무관하게 그대로다(단언 ②,
        // 재조회로 재확인 — 최초 관측 이후 변경되지 않았는지 확인한다).
        const nickname1Again = await waitForNickname(room1)
        expect(nickname1Again).toBe('striker')

        await Promise.all([leaveRoom(room1), leaveRoom(room2)])
      },
      20_000,
    )
  })

  describe('GA-01(보강): 3자 충돌 — 동일 닉네임으로 3명이 접속하면 셋 다 고유하다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      "RQ-02/GA-01: 'scout'으로 3명이 순차 접속하면, 첫 접속자는 원본 그대로, 이후 두 접속자는 서로 다르고 원본으로 시작하는 고유 닉네임을 받는다",
      async () => {
        const room1 = await joinWithNickname(newClient(server), 'scout')
        const nickname1 = await waitForNickname(room1)

        const room2 = await joinWithNickname(newClient(server), 'scout')
        const nickname2 = await waitForNickname(room2)

        const room3 = await joinWithNickname(newClient(server), 'scout')
        const nickname3 = await waitForNickname(room3)

        // 첫 접속 시점에는 충돌이 없었으므로 원본 그대로다.
        expect(nickname1).toBe('scout')

        // 이후 두 접속자는 원본으로 시작하되 원본과 다르다.
        expect(nickname2).not.toBe('scout')
        expect(nickname2.startsWith('scout')).toBe(true)
        expect(nickname3).not.toBe('scout')
        expect(nickname3.startsWith('scout')).toBe(true)

        // 세 닉네임 전부 서로 다르다(고유) — Set 크기로 검증.
        expect(new Set([nickname1, nickname2, nickname3]).size).toBe(3)

        await Promise.all([leaveRoom(room1), leaveRoom(room2), leaveRoom(room3)])
      },
      25_000,
    )
  })

  describe('GA-01(기본 경로): 충돌이 없으면 접미사 없이 원본 닉네임을 그대로 받는다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      "RQ-02: 충돌 없는 유일한 닉네임 'lonewolf'로 접속하면 그대로 부여된다",
      async () => {
        const room = await joinWithNickname(newClient(server), 'lonewolf')
        const nickname = await waitForNickname(room)
        expect(nickname).toBe('lonewolf')

        await leaveRoom(room)
      },
      15_000,
    )
  })
})
