import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { StoreApi } from 'zustand/vanilla'
import { buildServer } from '@server/index'
import { createGameStore, type GameStoreState } from '@client/store/gameStore'
import { connectToGame } from '@client/net/connection'

/**
 * 20b(클라이언트 기본 1차 — 접속·씬·상태 표시) — netcode 레이어
 * (`src/client/net/`, `harness/workflow/fe.md` "netcode → game state" 배선)
 * 통합 테스트 (ADR-0008: Colyseus 룸 경계).
 *
 * 매핑된 골든 케이스: 없음(`harness/progress.md` 20b — RQ-02/03 클라 경로는
 * GA-01/02 서버 경계가 이미 커버). 이 파일이 검증하는 건 "서버가 확정한
 * 값이 실제로 클라이언트 store까지 도달하는가"이지, 확정 로직 자체(닉네임
 * 접미사·정원 판정·이동 산술)의 정확성이 아니다 — 그건 각자의 RQ가
 * 이미 검증했다(RQ-02: `rq-02-nickname-collision.test.ts`, RQ-03:
 * `rq-03-spectator-*.test.ts`, RQ-20: `rq-20-movement-authority.test.ts`,
 * `sim-movement.test.ts`).
 *
 * **범위(team-lead 지시, `harness/progress.md` 20b)**: 닉네임 입장 →
 * `joinOrCreate` → 서버 스냅샷 수신 → store 반영까지만. **예측(RQ-62)·
 * 보간(RQ-63)·입력 전송(키보드→네트워크 메시지 체계)·HUD는 이 PR의
 * 스코프 밖이다.** 아래 이동 시나리오(마지막 describe)는 "입력 전송
 * 기능"을 테스트하는 게 아니라 — 그런 기능은 이 PR에 없다 — store가 서버발
 * 위치 변화를 올바르게 반영하는지 확인하기 위해 시나리오를 구동하는
 * 수단으로 raw Colyseus room에 직접 `send()`한다. 이는
 * `rq-20-movement-authority.test.ts`가 이미 쓰는 것과 동일한
 * `room.send('move', ...)` 패턴이다.
 *
 * **가정 1(coder에게 — net 모듈 공개 계약, 이 모듈은 아직 없다)**:
 * `src/client/net/connection.ts`가 아래를 노출한다고 가정한다.
 *
 *   interface GameConnection {
 *     sessionId: string
 *     room: Room             // colyseus.js Room — 원본 그대로 노출.
 *                             // 이유: RQ-40(채팅)·RQ-42(스프레이) 등 후속
 *                             // PR이 메시지를 보낼 채널이 결국 이거고,
 *                             // net 모듈이 이를 감추면 그 PR들이 다시
 *                             // room 접근 경로를 만들어야 한다. 이 테스트도
 *                             // 이동 시나리오 구동에 이 필드를 쓴다(위 범위
 *                             // 설명 참고) — "입력 전송 기능"이 아니라
 *                             // 테스트 하네스의 시나리오 구동 수단이다.
 *     disconnect(): Promise<void>
 *   }
 *
 *   async function connectToGame(
 *     endpoint: string,
 *     nickname: string,
 *     store: StoreApi<GameStoreState>,
 *   ): Promise<GameConnection>
 *
 * 룸 이름은 기존 통합 테스트들과 동일하게 `'game'` 하나로 고정된다고
 * 가정한다(이 파일 안에 상수로 노출하지 않는다 — connectToGame 내부
 * 구현 세부).
 *
 * connectToGame은 내부적으로 (1) `new Client(endpoint).joinOrCreate('game',
 * { nickname })`로 접속하고 (2) 반환된 `room.sessionId`로
 * `store.getState().setSelfSessionId(...)`를 **동기적으로**(join 성공
 * 직후, 반환 전) 호출하며 (3) `room.onStateChange`를 구독해 매 패치마다
 * `store.getState().applyServerState(room.state)`를 호출한다고 가정한다.
 * (2)는 네트워크 상태 동기화 타이밍에 의존하지 않는 로컬 필드 설정이라
 * connectToGame이 resolve된 시점에 이미 반영돼 있어야 한다는 것을 아래
 * 테스트가 직접 단언한다(폴링 없이). 반면 (3)이 반영하는 플레이어/관전자
 * 컬렉션 내용은 서버 패치 도착 타이밍에 좌우될 수 있어 폴링
 * (`waitForStoreCondition`)으로 기다린다 — `rq-02-nickname-collision.test.ts`의
 * `waitForNickname`과 동일한 방어적 패턴이다.
 *
 * **가정 2(coder에게 — game state 레이어 계약)**: `src/client/store/gameStore.ts`의
 * `createGameStore()`/`GameStoreState` 계약은
 * `tests/unit/20b-client-store.test.ts`가 정의한 것과 동일하다(그 파일의
 * "가정" 절 참고). 이 통합 테스트는 그 계약 위에서 net 모듈의 배선만
 * 검증한다.
 *
 * **결정론 메모**: 기존 RQ-02/03/04/20/60 통합 테스트와 동일하게 실
 * WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008 허용 예외). 모든
 * 대기에 `withTimeout()` 상한을 걸고, "N초 슬립 후 확인" 대신 store
 * 구독(`store.subscribe`)으로 실제 값 변화를 기다린다.
 */

const CONNECT_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const STORE_TIMEOUT_MS = 5_000

/**
 * `connectToGame`의 반환 타입을 이름으로 고정한다 — 아래 각 `it()`에서
 * `withTimeout(connectToGame(...), ...)`의 결과를 받는 지역 변수에 명시적으로
 * 붙인다. 이유(구현 세부가 아니라 tsc 진단 순도 문제): `connectToGame`이
 * 아직 없는 모듈에서 오는 동안(TS2307) 그 타입은 `any`인데, 타입 인자가
 * 명시되지 않은 제네릭 `withTimeout<T>(promise: Promise<T>, ...)`에 `any`
 * 타입의 프라미스를 넘기면 TypeScript가 `T`를 `any`가 아니라 `unknown`으로
 * 추론하는 경우가 있다(실측 확인) — 그러면 `connection.sessionId` 같은 접근이
 * "TS18046: is of type 'unknown'"라는 **별도** 진단을 무더기로 낳는다. 이건
 * ADR-0008 §4가 정당한 그린필드 Red로 인정하는 TS2307/TS2305 범위 밖의
 * 진단이라 "깨진 테스트"로 분류된다 — 이 타입 별칭으로 각 수신 지점에
 * 명시적 타입을 달아 그 취급을 피한다(모듈이 없는 동안은 결국 `any`로
 * 귀결되고, 모듈이 생기면 실제 반환 타입으로 정확해진다).
 */
type Connection = Awaited<ReturnType<typeof connectToGame>>

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

/** store가 predicate를 만족할 때까지 기다린다 — "N초 슬립 후 확인" 대신
 * 실제 상태 변화를 구독해서 기다리는 방식(`rq-20-movement-authority.test.ts`의
 * `waitForPositionChange`와 동일한 정신: 값이 실제로 그 조건을 만족할 때까지
 * 반복 확인해, 무관한 갱신(예: 매 틱 tick 필드 변화)을 우리가 기다리는
 * 변화로 착각하는 경합을 피한다). */
function waitForStoreCondition(
  store: StoreApi<GameStoreState>,
  predicate: (state: GameStoreState) => boolean,
  ms: number,
  label: string,
): Promise<GameStoreState> {
  return withTimeout(
    new Promise<GameStoreState>((resolve) => {
      let unsubscribe: (() => void) | undefined
      const tryResolve = (): void => {
        const state = store.getState()
        if (predicate(state)) {
          unsubscribe?.()
          resolve(state)
        }
      }
      unsubscribe = store.subscribe(tryResolve)
      tryResolve()
    }),
    ms,
    label,
  )
}

/** 자기 자신의 확정 닉네임이 store에 반영될 때까지 기다리고 반환한다. */
async function waitForSelfNickname(store: StoreApi<GameStoreState>, sessionId: string): Promise<string> {
  const state = await waitForStoreCondition(
    store,
    (s) => typeof s.players.get(sessionId)?.nickname === 'string',
    STORE_TIMEOUT_MS,
    `sessionId=${sessionId}의 자기 닉네임이 store에 반영되길 대기`,
  )
  // predicate가 문자열임을 이미 확인했으므로 non-null 단언이 안전하다.
  return state.players.get(sessionId)!.nickname
}

describe('20b/RQ-61: 접속 직후 자기 sessionId와 서버 확정 닉네임이 store에 반영된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "20b: connectToGame이 resolve되면 store.selfSessionId가 connection.sessionId와 즉시 일치하고, players 컬렉션에 자기 닉네임이 나타난다",
    async () => {
      const store = createGameStore()
      const connection: Connection = await withTimeout(
        connectToGame(server.endpoint, 'edge', store),
        CONNECT_TIMEOUT_MS,
        "connectToGame(nickname: 'edge')",
      )

      // (2) 자기 식별은 네트워크 상태 동기화가 아니라 join 성공 자체에서
      // 나오는 로컬 값이므로 폴링 없이 즉시 단언한다(가정 1 참고).
      expect(connection.sessionId).toBeTruthy()
      expect(store.getState().selfSessionId).toBe(connection.sessionId)

      const nickname = await waitForSelfNickname(store, connection.sessionId)
      expect(nickname).toBe('edge')

      await withTimeout(connection.disconnect(), LEAVE_TIMEOUT_MS, 'connection.disconnect()')
    },
    20_000,
  )
})

describe('20b/RQ-02/RQ-61: 다른 사용자의 접속이 서버 확정 닉네임과 함께 내 store에 나타난다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "20b: 동일 닉네임('edge')으로 두 번째 사용자가 접속하면, 서버가 부여한 접미사 붙은 닉네임이 첫 사용자의 store에도 그대로 나타난다",
    async () => {
      const storeA = createGameStore()
      const connA: Connection = await withTimeout(
        connectToGame(server.endpoint, 'edge', storeA),
        CONNECT_TIMEOUT_MS,
        "A: connectToGame(nickname: 'edge')",
      )
      const nicknameA = await waitForSelfNickname(storeA, connA.sessionId)
      expect(nicknameA).toBe('edge')

      const storeB = createGameStore()
      const connB: Connection = await withTimeout(
        connectToGame(server.endpoint, 'edge', storeB),
        CONNECT_TIMEOUT_MS,
        "B: connectToGame(nickname: 'edge')",
      )
      // B 자신의 store에서도 충돌 해소된(접미사 붙은) 닉네임이 보여야 한다
      // — 클라는 자신이 보낸 원본이 아니라 서버가 확정한 값을 표시한다.
      const nicknameB = await waitForSelfNickname(storeB, connB.sessionId)
      expect(nicknameB).not.toBe('edge')
      expect(nicknameB.startsWith('edge')).toBe(true)

      // A의 store에도 B가 서버 확정 닉네임(접미사 포함) 그대로 나타나야 한다.
      const aView = await waitForStoreCondition(
        storeA,
        (s) => s.players.has(connB.sessionId),
        STORE_TIMEOUT_MS,
        'A의 store에 B가 나타나길 대기',
      )
      expect(aView.players.get(connB.sessionId)?.nickname).toBe(nicknameB)
      expect(aView.players.size).toBe(2)

      // A 자신의 닉네임은 B의 등장과 무관하게 그대로다.
      expect(storeA.getState().players.get(connA.sessionId)?.nickname).toBe('edge')

      await Promise.all([
        withTimeout(connA.disconnect(), LEAVE_TIMEOUT_MS, 'A: disconnect'),
        withTimeout(connB.disconnect(), LEAVE_TIMEOUT_MS, 'B: disconnect'),
      ])
    },
    25_000,
  )
})

describe('20b: 다른 사용자의 퇴장이 내 store에서 제거로 반영된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    '20b: B가 접속했다가 퇴장하면, A의 store에서 B가 등장했다가 다시 사라진다',
    async () => {
      const storeA = createGameStore()
      const connA: Connection = await withTimeout(
        connectToGame(server.endpoint, 'scout', storeA),
        CONNECT_TIMEOUT_MS,
        "A: connectToGame(nickname: 'scout')",
      )
      await waitForSelfNickname(storeA, connA.sessionId)

      const storeB = createGameStore()
      const connB: Connection = await withTimeout(
        connectToGame(server.endpoint, 'sniper', storeB),
        CONNECT_TIMEOUT_MS,
        "B: connectToGame(nickname: 'sniper')",
      )
      await waitForSelfNickname(storeB, connB.sessionId)

      await waitForStoreCondition(
        storeA,
        (s) => s.players.has(connB.sessionId),
        STORE_TIMEOUT_MS,
        'A의 store에 B 등장 대기',
      )
      expect(storeA.getState().players.size).toBe(2)

      await withTimeout(connB.disconnect(), LEAVE_TIMEOUT_MS, 'B: disconnect')

      await waitForStoreCondition(
        storeA,
        (s) => !s.players.has(connB.sessionId),
        STORE_TIMEOUT_MS,
        'A의 store에서 B 제거 대기',
      )
      expect(storeA.getState().players.size).toBe(1)
      expect(storeA.getState().players.has(connA.sessionId)).toBe(true)

      await withTimeout(connA.disconnect(), LEAVE_TIMEOUT_MS, 'A: disconnect')
    },
    20_000,
  )
})

describe('20b/RQ-20: 서버가 시뮬레이션한 위치 변화가 store에 반영된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "20b: 'move' 입력 이후 서버가 갱신한 x 위치가 store에도 반영되며, 그 값은 원래 방향으로 증가한다",
    async () => {
      const store = createGameStore()
      const connection: Connection = await withTimeout(
        connectToGame(server.endpoint, 'runner', store),
        CONNECT_TIMEOUT_MS,
        "connectToGame(nickname: 'runner')",
      )
      await waitForSelfNickname(store, connection.sessionId)

      const baselineX = store.getState().players.get(connection.sessionId)?.x
      expect(typeof baselineX).toBe('number')

      // 입력 전송은 이 PR의 스코프 밖(파일 상단 "범위" 참고) — 시나리오
      // 구동을 위해 raw Colyseus room에 직접 이동 메시지를 보낸다
      // (`rq-20-movement-authority.test.ts`와 동일한 room.send 패턴).
      connection.room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })

      const moved = await waitForStoreCondition(
        store,
        (s) => {
          const x = s.players.get(connection.sessionId)?.x
          return typeof x === 'number' && x !== baselineX
        },
        STORE_TIMEOUT_MS,
        '이동 입력 이후 store의 x 위치 변화 대기',
      )

      expect(moved.players.get(connection.sessionId)!.x).toBeGreaterThan(baselineX!)

      await withTimeout(connection.disconnect(), LEAVE_TIMEOUT_MS, 'connection.disconnect()')
    },
    20_000,
  )
})
