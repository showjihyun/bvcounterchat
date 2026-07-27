import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { StoreApi } from 'zustand/vanilla'
import { buildServer } from '@server/index'
import { createGameStore, type GameStoreState } from '@client/store/gameStore'
import { connectToGame } from '@client/net/connection'
import { NET } from '@shared/constants'

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
 * **REV(RQ-64/F1, `_workspace/RQ-64/03_evaluator_report.md`) — `getRttMs()`
 * 추가**: 평가 blocker(클라이언트가 `rttMs`를 전혀 보내지 않아 RQ-64 랙보상이
 * 제품에서 발화하지 않음) 대응 — `GameConnection`에 `getRttMs(): number`가
 * 추가된다. 내부적으로 `sendMoveInput`이 `predictor.applyInput`이 반환하는
 * `seq`를 `@client/net/rttEstimator`의 `RttEstimator.recordSend(seq,
 * now())`에 기록하고, `handleStateChange`가 `readSelfAuthoritativeState`로
 * 확인한 `lastProcessedInputSeq`를 `RttEstimator.onAck(...)`에 전달한다
 * (그린필드 계약은 `tests/unit/rq-64-rtt-estimator.test.ts` 상단 참고). 이
 * 파일 맨 끝의 새 `describe`가 이 왕복이 실 WebSocket으로 실제로 표본을
 * 만드는지 검증한다 — `rq-64-rtt-estimator.test.ts`(순수 로직)와의 A/B
 * 레벨 분리: 그 파일이 "표본·평활 계산이 정확한가", 이 파일이 "그 계산이
 * 실 연결에 배선됐는가".
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
      // `unsubscribe`는 `tryResolve`(아래) 안에서 참조되지만, 그 참조는
      // `tryResolve`가 실제로 호출될 때만 평가된다 — `store.subscribe`는
      // 등록 시점에 리스너를 동기 호출하지 않으므로(zustand vanilla 구현
      // 확인: `subscribe`는 Set에 추가만 하고 반환한다) 아래 `const` 대입이
      // 끝난 뒤에야 `tryResolve`가 처음 호출된다. 따라서 `let` 대신
      // `const`로 선언·대입을 한 번에 할 수 있다.
      const tryResolve = (): void => {
        const state = store.getState()
        if (predicate(state)) {
          unsubscribe()
          resolve(state)
        }
      }
      const unsubscribe = store.subscribe(tryResolve)
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

/**
 * RQ-40/M1 — netcode 레이어(`connectToGame`)의 'chat'·'chat-history' 구독이
 * 실제로 store까지 닿는지(evaluator 델타 재평가 3회차 FAIL 보강,
 * `_workspace/RQ-40/03_evaluator_report.md` §D5-2·§D6-(b)).
 *
 * 그물이 없었던 실증: `connection.ts`에서 이 두 구독(`room.onMessage('chat',
 * ...)`·`room.onMessage('chat-history', ...)`)을 통째로 삭제해도(=M1이 고친
 * 결함이 그대로 되돌아오는 변이) 이전에는 통합 스위트가 전부 통과했다.
 * 아래 두 describe는 그 변이에서 각각 `[timeout] chatLog에 live-1 반영`·
 * `[timeout] chatLog에 이력 복원`으로 실패하는 것을 evaluator가 프로브로
 * 직접 확인한 형태다.
 *
 * **describe를 둘로 나누고 각자 새 서버를 기동하는 이유**: `GameRoom`은
 * `autoDispose = false`(GA-29 단일 룸, RQ-04)라 한 서버(=한 룸)를 여러
 * `it()`이 공유하면 서버 쪽 `chatHistory` 배열이 `it()` 사이에도 계속
 * 누적된다(`rq-40-chat-history-restore.test.ts` 파일 상단 "격리 주의"와
 * 동일한 함정 — 실제로 처음엔 한 describe 안에 묶었다가 첫 it의 'live-1'이
 * 두 번째 it의 이력에 섞여 `toEqual(['past-1','past-2'])`가
 * `['live-1','past-1','past-2']`로 거짓 실패하는 것을 직접 겪어 분리했다).
 * 이 파일의 다른 describe들도 각자 `beforeAll`에서 새 서버를 기동하는
 * 관례를 따른다.
 */
describe("20b/RQ-40 M1: connectToGame이 실시간 'chat' 브로드캐스트를 store.chatLog에 반영한다", () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "20b/RQ-40 M1: 실시간 'chat' 브로드캐스트가 store.chatLog에 반영된다",
    async () => {
      const store = createGameStore()
      const connection: Connection = await withTimeout(
        connectToGame(server.endpoint, 'talker', store),
        CONNECT_TIMEOUT_MS,
        "connectToGame(nickname: 'talker')",
      )

      connection.room.send('chat', { text: 'live-1' })

      const updated = await waitForStoreCondition(
        store,
        (s) => s.chatLog.some((m) => m.text === 'live-1'),
        STORE_TIMEOUT_MS,
        'chatLog에 live-1 반영',
      )
      expect(updated.chatLog.map((m) => m.text)).toEqual(['live-1'])

      await withTimeout(connection.disconnect(), LEAVE_TIMEOUT_MS, 'connection.disconnect()')
    },
    20_000,
  )
})

/**
 * 이력 복원 경로는 위 실시간 경로와 별개 describe(= 별도 서버)로 검증한다
 * — `room.onJoin`이 보내는 `'chat-history'`는 `joinOrCreate` resolve와
 * **같은 태스크**에서 도착할 수 있어(connection.ts 상단 주석의 경합 설명
 * 참고) seeder가 먼저 이력을 채워둔 뒤 두 번째 `connectToGame` 호출이 그
 * 이력을 store에 반영하는지 확인한다.
 */
describe("20b/RQ-40 M1: connectToGame이 'chat-history' 이력 복원을 store.chatLog에 반영한다", () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "20b/RQ-40 M1: 이미 오간 메시지가 있는 상태에서 접속하면 'chat-history' 복원분이 store.chatLog에 반영된다",
    async () => {
      const seederStore = createGameStore()
      const seeder: Connection = await withTimeout(
        connectToGame(server.endpoint, 'seeder', seederStore),
        CONNECT_TIMEOUT_MS,
        "seeder: connectToGame(nickname: 'seeder')",
      )

      seeder.room.send('chat', { text: 'past-1' })
      seeder.room.send('chat', { text: 'past-2' })
      await waitForStoreCondition(
        seederStore,
        (s) => s.chatLog.length >= 2,
        STORE_TIMEOUT_MS,
        'seeder가 자신의 2개 메시지 전부 수신(이력 반영 대기)',
      )

      const newcomerStore = createGameStore()
      const newcomer: Connection = await withTimeout(
        connectToGame(server.endpoint, 'newcomer', newcomerStore),
        CONNECT_TIMEOUT_MS,
        "newcomer: connectToGame(nickname: 'newcomer')",
      )

      const restored = await waitForStoreCondition(
        newcomerStore,
        (s) => s.chatLog.length >= 2,
        STORE_TIMEOUT_MS,
        'chatLog에 이력 복원',
      )
      expect(restored.chatLog.map((m) => m.text)).toEqual(['past-1', 'past-2'])

      await Promise.all([
        withTimeout(seeder.disconnect(), LEAVE_TIMEOUT_MS, 'seeder: disconnect'),
        withTimeout(newcomer.disconnect(), LEAVE_TIMEOUT_MS, 'newcomer: disconnect'),
      ])
    },
    25_000,
  )
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `connection.getRttMs()`는 store가 아니라 net 모듈이 직접 들고 있는
 * 동기 getter다(`readSelfAuthoritativeState`처럼 room.state를 즉시
 * 읽는 값과 동일한 위상 — store 구독이 아니라 짧은 간격 폴링으로
 * 기다린다). 단일 틱(≈33ms)을 노리는 폴링이 아니라 "여러 왕복이 누적돼
 * 0에서 양수로 바뀌는" 훨씬 넓은 창을 노리므로(`rq-18` REV3 "정확히 그
 * 틱을 잡아야 하는" 폴링과는 성격이 다르다) 지터에 안전하다. */
function waitForRttCondition(
  connection: Connection,
  predicate: (rttMs: number) => boolean,
  timeoutMs: number,
  label: string,
): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve) => {
      const tryResolve = (): boolean => {
        const rtt = connection.getRttMs()
        if (predicate(rtt)) {
          resolve(rtt)
          return true
        }
        return false
      }
      if (tryResolve()) return
      const interval = setInterval(() => {
        if (tryResolve()) clearInterval(interval)
      }, 15)
    }),
    timeoutMs,
    label,
  )
}

/**
 * RQ-64/F1(`_workspace/RQ-64/03_evaluator_report.md`) — 경계면 교차 검증.
 * 서버(`GameRoom.handleFire`)가 `rttMs`를 신뢰하지 않고 절단하는 로직은
 * `rq-64-lag-compensation-bound.test.ts`가 이미 고정했고, 그 값을 계산하는
 * 순수 로직은 `rq-64-rtt-estimator.test.ts`가 고정한다. 이 테스트는 그
 * 둘 사이 — **"클라이언트가 실 네트워크 왕복으로 실제로 rttMs를 만들어
 * 내는가"**를 확인한다. 평가가 실증했듯 이 배선이 없으면 RQ-64는 제품에서
 * 전혀 발화하지 않는다(원장 22g의 RQ-43 선례와 동일한 결함 계열).
 *
 * 실 이동 입력을 `sendMoveInput`(client-side seq 부여 경로, `room.send`
 * 직접 호출이 아니다 — 그러면 seq가 실리지 않아 RTT를 측정할 경로 자체가
 * 없다)로 반복 전송해 서버 확인(`lastProcessedInputSeq`) 왕복을 여러 번
 * 만든 뒤, `connection.getRttMs()`가 0(초기값)에서 양수로 바뀌는지 확인한다.
 *
 * **REV(RQ-64/F3, `_workspace/RQ-64/06_evaluator_delta.md` F3 — blocker)**:
 * F1을 닫으려고 채택한 "기존 move/seq 왕복 재사용" 방식은 표본에 서버
 * 지연(다음 틱까지 0~33.3ms + 다음 패치까지 0~50ms, Colyseus 기본
 * `patchRate`=20Hz)이 구조적으로 섞여 실측 편향 **+62.28ms**를 냈다(평가
 * §F3 — 순수 소켓 왕복 0.48ms vs 추정값 62.76ms). 이 편향은 RQ-64 원문의
 * 두 수치 보장(사수 RTT만큼 되감기·150ms 이내 정상 보장)을 실제로 깬다.
 *
 * 아래 기존 케이스에 **정밀 상한 단언**을 순증했다 — 표본 출처가 무엇이든
 * (현재의 move/seq 왕복이든, 이 결함을 고치기 위한 전용 ping/pong이든)
 * `connection.getRttMs()`라는 **관측 가능한 계약**만 검사하므로, 표본
 * 출처 교체(coder 몫)가 일어나도 이 테스트 자체는 손댈 필요가 없다 —
 * "표본이 실제로 흐르는가"(기존 `>0` 대기)와 "그 표본이 틱·패치 지연으로
 * 오염되지 않았는가"(신규 상한) 두 조건을 **함께** 요구해야 어느 한쪽만
 * 만족하는 회귀(예: ping은 있지만 결과를 안 씀 / 값이 있지만 편향됨)를
 * 모두 잡는다.
 *
 * **임계값 근거 — `NET.TICK_MS`(≈33.33ms)**: 새 매직 넘버를 만들지 않고
 * 기존 공유 상수를 재사용한다(ADR-0010). 이 값을 고른 이유는 정확히
 * "틱·패치 지연이 섞이지 않았다"를 검사하는 것과 의미가 통하기
 * 때문이다 — 평가가 유도한 현재 방식의 **이론적 하한**(평균 ≈41.7ms,
 * 최악 ≈83ms, 둘 다 `NET.TICK_MS`보다 크다)보다 낮으므로, 이 상한을
 * 만족하려면 표본에 틱·패치 지연이 구조적으로 섞이지 않는 출처여야
 * 한다. 반대로 순수 소켓 왕복(평가 실측 중앙값 0.48ms, 최댓값 1.3ms)은
 * 이 값보다 한 자릿수 이상 작아 여유가 크다.
 *
 * **루프백 전제(과적합 방지 근거를 명시)**: 이 값은 **같은 프로세스 안에서
 * 기동한 서버 + `127.0.0.1` 루프백**(이 파일의 `startServer()`, 다른 모든
 * 통합 테스트와 동일 — 실 인터넷 구간이 아니다)이라는 전제 위에서만
 * 의미가 있다. 실 네트워크 RTT가 수십ms를 넘는 배포 환경(원거리)에서
 * 이 단언을 그대로 쓰면 정상적으로도 거짓 실패할 수 있다 — 그런 환경의
 * 회귀 검증은 이 테스트의 스코프가 아니다(RQ-80 "사내망 단일 서버" 전제와
 * 별개로, **테스트 자체**가 실행되는 이 프로세스 내 루프백 조건 위에서만
 * 성립한다는 뜻).
 */
describe('20b/RQ-64/F1: connection.getRttMs()가 실 move↔seq 왕복(실 WebSocket)으로 측정된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    '반복된 이동 입력·서버 확인 왕복 후 connection.getRttMs()가 0에서 양수로 바뀌고, 실 소켓 왕복 자릿수 안에 머문다(RQ-64/F3 회귀 가드)',
    async () => {
      const store = createGameStore()
      const connection: Connection = await withTimeout(
        connectToGame(server.endpoint, 'pinger', store),
        CONNECT_TIMEOUT_MS,
        "connectToGame(nickname: 'pinger')",
      )
      await waitForSelfNickname(store, connection.sessionId)

      // 공허화 방지 — 배선 전이라면 이 값이 처음부터 계속 0이어야 한다는
      // 것 자체를 먼저 확인한다(아래 "양수로 바뀐다" 단언이 우연히 항상
      // 참인 상수 때문이 아님을 대조).
      expect(connection.getRttMs()).toBe(0)

      // 실 30Hz 전송 주기(NET.TICK_MS)로 여러 차례 이동 입력을 보내
      // seq↔lastProcessedInputSeq 왕복을 다수 발생시킨다.
      const SEND_COUNT = 20
      for (let i = 0; i < SEND_COUNT; i += 1) {
        connection.sendMoveInput({ dirX: 1, dirZ: 0, mode: 'run', jump: false })
        await sleep(NET.TICK_MS)
      }

      const rtt = await waitForRttCondition(
        connection,
        (value) => value > 0,
        STORE_TIMEOUT_MS,
        'connection.getRttMs()가 실 왕복으로 양수가 되길 대기 — 계속 0이면 클라이언트가 rttMs를 측정·전송하지 않는다는 뜻이다(평가 F1)',
      )
      // 로컬 루프백 + Colyseus 패치 배치(기본 20Hz) 지연을 감안해도 이
      // 자릿수를 넘으면 명백히 잘못된 값이다(터무니없이 큰 값만 배제하는
      // 관대한 상한 — 정밀한 상한 자체는 `rq-64-rtt-estimator.test.ts`의
      // 몫이 아니다, 그 파일은 순수 계산만 다룬다).
      expect(rtt).toBeLessThan(2_000)

      // RQ-64/F3(평가 blocker) 회귀 가드 — 위 관대한 상한과 별개로,
      // "실 소켓 왕복 자릿수 안"인지 정밀하게 확인한다(근거·루프백 전제는
      // 이 describe 상단 REV 절 참고). 현재(move/seq 재사용) 구현은
      // 구조적으로 이 상한을 넘긴다 — 이 단언은 지금 반드시 실패해야 한다.
      expect(rtt).toBeLessThan(NET.TICK_MS)

      await withTimeout(connection.disconnect(), LEAVE_TIMEOUT_MS, 'connection.disconnect()')
    },
    20_000,
  )
})
