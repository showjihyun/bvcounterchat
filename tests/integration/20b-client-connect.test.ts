import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { StoreApi } from 'zustand/vanilla'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { createGameStore, type GameStoreState } from '@client/store/gameStore'
import { connectToGame } from '@client/net/connection'
import { AUDIO, MOVEMENT, NET, PLAYER } from '@shared/constants'
import { getStats, openStatsDb, type StatsDb, type StatsRow } from '@server/persistence/statsDb'
import { DEFAULT_HITBOX, type SpreadTuning } from '@shared/config/combat-tuning'
import { EFFECTS_TUNING } from '@shared/config/effects-tuning'
import { WALL_EAST } from '@shared/sim/walls'
import { escapeSafeZone, getSafeZoneSeam, type SafeZoneEscapeSeam } from '../support/safe-zone'

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
 * F1을 닫으려고 초기에 채택했다 폐기된 "move/seq 왕복 재사용" 방식은 표본에 서버
 * 지연(다음 틱까지 0~33.3ms + 다음 패치까지 0~50ms, Colyseus 기본
 * `patchRate`=20Hz)이 구조적으로 섞여 실측 편향 **+62.28ms**를 냈다(평가
 * §F3 — 순수 소켓 왕복 0.48ms vs 추정값 62.76ms). 이 편향은 RQ-64 원문의
 * 두 수치 보장(사수 RTT만큼 되감기·150ms 이내 정상 보장)을 실제로 깬다.
 *
 * 아래 기존 케이스에 **정밀 상한 단언**을 순증했다 — 표본 출처가 무엇이든
 * (폐기된 move/seq 왕복이든, 최종 채택된 전용 ping/pong이든)
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
describe('20b/RQ-64/F1: connection.getRttMs()가 실 ping↔pong 왕복(실 WebSocket)으로 측정된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    '접속 직후 짧은 시간 안에 되감기 웜업이 끝나고(RQ-64 리뷰 major 1 회귀 가드), 반복된 이동 입력·서버 확인 왕복 후에도 connection.getRttMs()가 실 소켓 왕복 자릿수 안에 머문다(RQ-64/F3 회귀 가드)',
    async () => {
      const store = createGameStore()
      const connection: Connection = await withTimeout(
        connectToGame(server.endpoint, 'pinger', store),
        CONNECT_TIMEOUT_MS,
        "connectToGame(nickname: 'pinger')",
      )

      // 공허화 방지(리뷰 major 1 대응, `_workspace/review/feat-RQ-64-
      // lag-compensation.md`) — 원래는 "첫 ping이 NET.RTT_PING_INTERVAL_MS
      // (1000ms) 뒤에야 나간다"는 웜업 지연을 전제로, 그 창 안에서
      // `getRttMs()`가 계속 0인지 먼저 확인한 뒤 "양수로 바뀐다"는 단언이
      // 우연히 항상 참인 상수 때문이 아님을 대조했다. 그런데 major 1
      // 수정(접속 즉시 첫 ping 발사)이 그 창 자체를 없애므로, 이 단언은
      // 더 이상 "1초 동안 0"이라는 안전한 시간 여유에 기댈 수 없다 —
      // **그 목적(하드코딩된 상수가 아니라는 증거)을 그대로 지키면서**
      // 위치만 옮겼다. `connectToGame`이 resolve된 바로 다음 줄(중간에
      // 다른 `await` 없음)에서 읽는 것은 즉시 ping이 있어도 여전히
      // 안전하다 — Node의 이벤트 루프는 프라미스 마이크로태스크를 전부
      // 비운 뒤에야 다음 매크로태스크(소켓 'message' 이벤트 등 실 I/O
      // 콜백)로 넘어간다. `connectToGame` 내부에서 동기로 `sendPing()`을
      // 호출해도, 그 pong 응답은 실제 네트워크 I/O를 한 바퀴 거쳐야
      // 도착하므로 **이 시점(같은 마이크로태스크 체인 안)에는 아직
      // 도착할 수 없다** — 아무리 빠른 루프백이라도 성립하는, 실측
      // 네트워크 속도가 아니라 JS 실행 모델 자체가 주는 보장이다. (아래
      // `rq-64-rtt-estimator.test.ts`의 "표본 없음 → 0" 단위 계약과
      // 합쳐, "이 값이 배선에서 나온 진짜 표본이지 하드코딩된 상수가
      // 아니다"는 원래 목적이 그대로 유지된다.)
      expect(connection.getRttMs()).toBe(0)

      // 리뷰 major 1 회귀 가드 — 접속 직후 짧은 시간 안에 되감기가 실제로
      // 적용 가능한 상태(getRttMs() > 0)가 되는지 확인한다. 수정 전 구현은
      // 첫 ping을 NET.RTT_PING_INTERVAL_MS(1000ms) 뒤로 미뤄, 그 창
      // 전체에서 되감기가 전혀 적용되지 않았다(RQ-64 EARS 문면에는 웜업
      // 예외가 없다). 새 매직 넘버를 넣지 않고 기존 상수의 절반을
      // 임계값으로 쓴다 — "옛 방식(1주기 뒤 첫 발화)이라면 이 시간 안에
      // 도달할 수 없다"는 것과 "정상 네트워크 변동에는 넉넉한 여유"라는
      // 것이 동시에 성립하는 값이다.
      const IMMEDIATE_PING_TIMEOUT_MS = NET.RTT_PING_INTERVAL_MS / 2
      await waitForRttCondition(
        connection,
        (value) => value > 0,
        IMMEDIATE_PING_TIMEOUT_MS,
        `RQ-64 리뷰 major 1: 접속 후 ${IMMEDIATE_PING_TIMEOUT_MS}ms 안에 connection.getRttMs()가 양수가 되길 대기 — 계속 0이면 첫 ping이 아직 NET.RTT_PING_INTERVAL_MS만큼 지연되고 있다는 뜻(되감기 웜업 창 미해소)`,
      )

      await waitForSelfNickname(store, connection.sessionId)

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

/**
 * ping 타이머 발화 횟수를 센다 — `globalThis.setInterval`을 감싸,
 * **`connectToGame`이 직접 등록한 호출만** 계수한다.
 *
 * **실측으로 발견한 함정(주기만으로는 부족하다)**: 처음에는
 * `NET.RTT_PING_INTERVAL_MS`(1000ms)와 주기가 일치하는 호출만 걸렀는데,
 * 이 저장소의 의존성 `@colyseus/core → @pm2/io`가 `colyseus`를 최초
 * 임포트하는 시점에 **자신의 메트릭 수집용 `setInterval`을 정확히 같은
 * 1000ms 주기로 4개**(`PMX.init` → `metrics`/`notify` 기능들) 설치한다는
 *것을 실행 중 트레이스로 확인했다(`node_modules/@pm2/io/build/main/
 * features/{metrics,notify}.js`). 이 초기화가 **딱 한 번**(모듈 최초
 * 로드 시점, Node 모듈 캐시로 이후 재호출 없음) 일어나는 시점이 테스트
 * 실행 순서에 따라 달라져(이 파일을 단독 실행하면 이 `it()`의
 * `startServer()`가 그 최초 트리거가 될 수 있다) 계수기 설치 **이후**에
 * 걸릴 수도, 이전에 이미 끝나 있을 수도 있다 — 순서 의존적이라 주기만
 * 보는 필터는 신뢰할 수 없다(실측: 단독 실행 시 PM2의 4개까지 잡혀
 * 발화 횟수가 부풀었다).
 *
 * **해법**: 호출 시점의 스택 트레이스에서 `connectToGame`(정확히 이
 * 함수 이름 — `connection.ts`의 `setInterval(sendPing, NET
 * .RTT_PING_INTERVAL_MS)` 호출부가 있는 그 함수)이 보이는 경우만
 * 계수한다. 이 판별은 주기·모듈 로딩 순서와 무관하게 항상 정확하다 —
 * 스택은 "누가 이 setInterval을 실제로 호출했는가"라는 사실 자체이기
 * 때문이다.
 *
 * **전역 오염 방지**: 원본 `setInterval`을 클로저에 보관하고 `restore()`
 * 가 되돌린다 — 호출자가 `afterEach`에서 항상 호출한다.
 */
function wrapGlobalSetIntervalForPingCount(targetIntervalMs: number): {
  getFireCount: () => number
  restore: () => void
} {
  const original = globalThis.setInterval
  let fireCount = 0
  globalThis.setInterval = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
    const isPingTimer = timeout === targetIntervalMs && (new Error().stack ?? '').includes('connectToGame')
    if (isPingTimer) {
      const counting = (...cbArgs: unknown[]): void => {
        fireCount += 1
        handler(...cbArgs)
      }
      return original(counting, timeout, ...args)
    }
    return original(handler, timeout, ...args)
  }) as typeof setInterval
  return {
    getFireCount: () => fireCount,
    restore: () => {
      globalThis.setInterval = original
    },
  }
}

/** `getCount()`가 `threshold` 이상이 될 때까지 폴링한다 — 발화 횟수는
 * 감소하지 않는 단조 신호이므로 `waitForRttCondition`(이 파일 §20b/F1)과
 * 동일한 정신의 안전한 대기 술어다. 폴링 간격(15ms)은
 * `NET.RTT_PING_INTERVAL_MS`(1000ms)와 달라 `wrapGlobalSetIntervalFor
 * PingCount`의 계수 대상이 되지 않는다(전역 오염 없음). resolve·timeout
 * 어느 쪽으로 끝나도 `interval`을 정리한다. */
function waitForFireCountAtLeast(getCount: () => number, threshold: number, timeoutMs: number, label: string): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve, reject) => {
      const tryResolve = (): void => {
        const count = getCount()
        if (count >= threshold) {
          clearInterval(interval)
          resolve(count)
        }
      }
      tryResolve()
      const interval = setInterval(tryResolve, 15)
      // withTimeout이 바깥에서 시간 초과를 던지면 이 인터벌은 정리할
      // 기회가 없다 — 별도 안전망으로 timeoutMs 시점에 직접 clearInterval
      // 하고 reject한다(withTimeout의 reject와 경합해도 Promise는 한 번만
      // 정착하므로 안전하다).
      setTimeout(() => {
        clearInterval(interval)
        reject(new Error(`[timeout ${timeoutMs}ms] ${label}`))
      }, timeoutMs)
    }),
    timeoutMs,
    label,
  )
}

/**
 * RQ-64/O-2(평가, `_workspace/RQ-64/09_evaluator_delta2.md`·`10_coder_o2.md`)
 * — 회귀 가드: 침묵 disconnect(서버 강제 종료 — `disconnect()`를 부르지
 * 않는 연결 종료, 네트워크 단절·서버 재시작·AFK 강제 퇴장이 모두 이
 * 경로다) 이후 ping 타이머가 계속 발화하면 죽은 룸에 영원히 `send`를
 * 시도하고, 재접속 시 이전 타이머가 새 타이머와 함께 누적된다.
 *
 * **관측 방식 선택 근거**: 평가·coder가 이미 쓴 "`setInterval`을 감싸
 * 발화 횟수를 계수"하는 방식을 그대로 채택했다 — `connection.ts`가
 * ping 타이머 id(`pingIntervalId`)를 모듈 내부에 캡슐화해 노출하지
 * 않으므로(공개 계약 `GameConnection`에 그 id를 얻는 방법이 없다),
 * 화이트박스로 클로저 내부를 직접 찌를 수 없다 — 유일하게 관측 가능한
 * 지점은 "타이머를 만드는 전역 API 자체"뿐이다. 대안(서버가 수신한
 * `'ping'` 메시지 횟수를 화이트박스로 셈)은 기각했다 — `GameRoom`에
 * ping 수신 횟수를 보관하는 상태가 없어(즉시 echo만 하고 버린다) 새
 * 계약을 만들어야 하는데, 그건 `src/`를 건드리는 일이다(이 라운드 제약).
 *
 * **전역 오염 방지**: `afterEach`에서 항상 `restore()`한다 — 이 describe의
 * 모든 `it()`(현재 1건)이 끝나면 원본 `setInterval`로 되돌아간다.
 *
 * **대기 술어**: "발화 횟수 ≥ N"은 단조 신호(감소하지 않는다)이고,
 * "그 이상 발화하지 않는다"는 rq-12의 "HP 불변" 확인과 동일한 이유로
 * 사건 기반 대기가 불가능해(부재를 증명하는 것이라 이벤트가 없다)
 * 고정 대기를 쓴다 — 전부 `NET.RTT_PING_INTERVAL_MS`의 배수로 계산해
 * 매직 넘버를 넣지 않았다.
 */
describe('20b/RQ-64/O-2: 침묵 disconnect 시 ping 타이머가 정리되고, 재접속 시 중복 생성되지 않는다', () => {
  let counter: ReturnType<typeof wrapGlobalSetIntervalForPingCount>

  afterEach(() => {
    counter.restore()
  })

  it(
    '정상 접속 중에는 ping이 주기적으로 발화하고(양성 대조군), 서버 강제 종료(침묵 disconnect) 후에는 발화가 멈추며, 재접속 후에는 단일 타이머 속도로만 발화한다',
    async () => {
      // 카운터는 connectToGame 호출(내부에서 setInterval을 동기적으로
      // 만든다) **전에** 설치해야 그 호출을 가로챌 수 있다.
      counter = wrapGlobalSetIntervalForPingCount(NET.RTT_PING_INTERVAL_MS)

      let server1: RunningServer | undefined = await startServer()
      const store1 = createGameStore()
      const conn1: Connection = await withTimeout(
        connectToGame(server1.endpoint, 'leaker', store1),
        CONNECT_TIMEOUT_MS,
        "connectToGame(nickname: 'leaker')",
      )

      try {
        // 양성 대조군 — 정상 접속 중에는 ping이 실제로 주기적으로
        // 발화한다(2회 이상 관측해 "1회만 우연히" 발화한 것이 아님을
        // 확인한다). 이게 없으면 아래 "더 이상 늘지 않는다"는 애초에
        // ping이 돌지 않아도 통과해 버린다.
        const baselineTimeoutMs = NET.RTT_PING_INTERVAL_MS * 4
        await waitForFireCountAtLeast(
          counter.getFireCount,
          2,
          baselineTimeoutMs,
          `ping이 정상 접속 중 2회 이상 발화하길 대기(양성 대조군) — ${baselineTimeoutMs}ms 안에 2회가 안 되면 ping 타이머 자체가 배선되지 않았다는 뜻`,
        )

        // 침묵 disconnect — 서버를 강제 종료한다(`connection.disconnect()`를
        // 부르지 않는다). `connection.onDisconnect`는 `room.onLeave`와
        // 같은 신호를 쓰고, `connection.ts`의 `cleanupPingTimer`도 같은
        // `room.onLeave`를 구독한다 — `cleanupPingTimer`가 **먼저**
        // 등록되므로(connectToGame 내부, 이 테스트의 onDisconnect 구독보다
        // 먼저) 표준 이벤트 리스너 등록 순서상 이 프라미스가 resolve되는
        // 시점에는 타이머가 이미 정리돼 있다.
        const disconnected = new Promise<void>((resolve) => {
          conn1.onDisconnect(resolve)
        })
        const countBeforeStop = counter.getFireCount()
        await stopServer(server1)
        server1 = undefined
        await withTimeout(
          disconnected,
          LEAVE_TIMEOUT_MS,
          'RQ-64/O-2: 서버 강제 종료 후 connection.onDisconnect(침묵 disconnect 신호) 대기',
        )
        const countAtDisconnect = counter.getFireCount()
        // 강제 종료 시점과 disconnect 확정 시점 사이에 최대 한 번의
        // "이미 예약된" 발화가 겹칠 수 있다는 것을 인정하되(타이머 콜백과
        // 소켓 종료 이벤트가 같은 매크로태스크 경합에 들어갈 아주 좁은
        // 창), 그 이후로는 절대 늘지 않아야 한다.
        expect(countAtDisconnect).toBeGreaterThanOrEqual(countBeforeStop)

        // "더 이상 발화하지 않는다"는 부재를 증명하는 것이라 이벤트 기반
        // 대기가 불가능하다(rq-12 "HP 불변" 확인과 동일한 이유) — 고정
        // 대기를 쓴다. `NET.RTT_PING_INTERVAL_MS`의 배수로 계산(매직
        // 넘버 없음) — 평가·coder가 실측 확인한 "3.3주기 동안 증가분 0"
        // 보다 여유 있게 3주기를 그대로 기다린다.
        await sleep(NET.RTT_PING_INTERVAL_MS * 3)
        expect(counter.getFireCount()).toBe(countAtDisconnect)

        // 재접속 — 새 서버(이전 서버는 이미 멈췄다)에 새 연결을 맺는다.
        // 이전 타이머가 살아있다면 여기서부터 두 타이머가 겹쳐 발화
        // 속도가 약 2배가 된다.
        const server2 = await startServer()
        try {
          const store2 = createGameStore()
          const conn2: Connection = await withTimeout(
            connectToGame(server2.endpoint, 'leaker2', store2),
            CONNECT_TIMEOUT_MS,
            "connectToGame(nickname: 'leaker2') — 재접속",
          )
          try {
            const countAtReconnect = counter.getFireCount()
            // "속도가 중복되지 않는다"는 고정 관측 창이 필요하다(순간값이
            // 아니라 구간당 증가량을 봐야 하므로) — 2주기어치를 넉넉히
            // 웃도는 2.5주기를 기다린 뒤 그 구간의 증가분을 확인한다.
            await sleep(NET.RTT_PING_INTERVAL_MS * 2.5)
            const increaseAfterReconnect = counter.getFireCount() - countAtReconnect
            // 단일 타이머라면 2.5주기 동안 2회 근처(웜업 지연으로 t=1.0·2.0
            // 주기에 발화) — 중복 타이머라면 그 두 배 근처(약 4회 이상)가
            // 된다. 팀리드 지시("2주기에 2회, 중복이면 ~4회")대로 3을
            // 경계로 확실히 가른다(2 이하는 단일, 4 근처는 중복 — 그
            // 사이에 여유가 크다).
            expect(increaseAfterReconnect).toBeGreaterThanOrEqual(1) // 새 연결의 타이머는 실제로 돈다(양성 대조군)
            expect(increaseAfterReconnect).toBeLessThan(3) // 중복 타이머(약 4회)라면 여기서 죽는다
          } finally {
            await withTimeout(conn2.disconnect(), LEAVE_TIMEOUT_MS, 'conn2.disconnect()')
          }
        } finally {
          await stopServer(server2)
        }
      } finally {
        if (server1) {
          await stopServer(server1)
        }
      }
    },
    // 정상 발화 대기(≤4주기) + 침묵 disconnect 확인 + 3주기 무발화 대기 +
    // 재접속 2.5주기 관측 — 전부 실 시간(NET.RTT_PING_INTERVAL_MS=1000ms
    // 기준)이라 다른 RQ-64 케이스보다 오래 걸린다(팀리드 지시 — 소요 시간
    // 보고 대상, `_workspace/RQ-64/11_test-writer_o2-guard.md` 참고).
    30_000,
  )
})

const STATS_TIMEOUT_MS = 5_000

/** RQ-81 통계 검증 전용 서버 기동 — 이 파일의 다른 describe들이 쓰는
 * `startServer()`(RQ-81 이전부터 존재, 인자 없음)는 건드리지 않는다. 이
 * 헬퍼만 `statsDbPath`를 받아 격리된 SQLite 파일로 서버를 띄운다
 * (`rq-81-uuid-stat-persistence.test.ts`와 동일한 패턴). */
async function startServerWithStats(statsDbPath: string): Promise<RunningServer> {
  const app = buildServer({ logger: false, statsDbPath })
  const address = await withTimeout(
    app.listen({ port: 0, host: '127.0.0.1' }),
    LISTEN_TIMEOUT_MS,
    'app.listen({ port: 0 }, statsDbPath)',
  )
  const { port } = new URL(address)
  return { app, endpoint: `ws://127.0.0.1:${port}` }
}

function createTempStatsDbPath(prefix: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { path: join(dir, 'stats.db'), dir }
}

/**
 * SQLite 통계 행이 predicate를 만족할 때까지 폴링한다 — 서버가 실제로 쓴
 * 파일을 테스트가 직접 읽으므로(관측 지점 근거는 `rq-81-uuid-stat-persistence
 * .test.ts` 상단 "관측 지점" 절과 동일 — 어느 클라이언트의 `room.state`도
 * 거치지 않는다) 이 파일의 다른 store 기반 대기와는 다른 종류의 신호를
 * 본다. `waitForFireCountAtLeast`(이 파일 §RQ-64/O-2)와 같은 폴링 정신이되,
 * **인터벌 생성을 첫 동기 `tryResolve()` 호출보다 먼저 둔다** — 그 반대
 * 순서(이 파일의 기존 `waitForFireCountAtLeast`가 쓰는 순서)는 술어가 구독
 * *즉시* 참이 될 수 있는 경우(이 함수가 그렇다 — `disconnect()` 이후에
 * 호출되므로 그 시점에 이미 행이 존재할 수 있다) `clearInterval(interval)`
 * 이 아직 초기화되지 않은 `const interval`을 참조해 TDZ `ReferenceError`가
 * 날 수 있다(기존 헬퍼들은 첫 호출에서 술어가 항상 거짓이라 이 경로를
 * 타지 않아 드러나지 않았을 뿐이다 — 기존 헬퍼는 이번 라운드 범위 밖이라
 * 건드리지 않는다). */
function waitForStatsCondition(
  db: StatsDb,
  uuid: string,
  predicate: (row: StatsRow | undefined) => boolean,
  timeoutMs: number,
  label: string,
): Promise<StatsRow | undefined> {
  return withTimeout(
    new Promise<StatsRow | undefined>((resolve, reject) => {
      const interval = setInterval(tryResolve, 15)
      // 성공 경로에서도 타임아웃 타이머를 반드시 해제한다 — 안 하면 이 파일이
      // 끝난 뒤에도 타이머가 남아 워커 종료와 경합한다(리뷰 minor).
      const timer = setTimeout(() => {
        clearInterval(interval)
        reject(new Error(`[timeout ${timeoutMs}ms] ${label}`))
      }, timeoutMs)
      function tryResolve(): void {
        const row = getStats(db, uuid)
        if (predicate(row)) {
          clearInterval(interval)
          clearTimeout(timer)
          resolve(row)
        }
      }
      tryResolve()
    }),
    timeoutMs,
    label,
  )
}

/**
 * RQ-81(평가 major 3, `_workspace/RQ-81/04_evaluator_report.md` §5.1) —
 * `connectToGame`이 uuid를 실제로 join 옵션에 실어 보내는지 덮는 테스트가
 * 없었다: 평가가 변이 M6(`connection.ts`에서 uuid를 아예 안 보내도록
 * 바꿈)를 심었을 때 기존 통합 스위트(RQ-81 5파일 포함) 364건이 **전부
 * 그대로 통과**했다 — 두 검증(서버측 UUID 키잉 계약, 클라 저장소 읽기·생성
 * 로직) 사이에 **배선 구간 자체가 비어 있었다**(RQ-43·RQ-64 선례, 원장
 * 22m와 동일한 결함 계열 — `02_coder_green.md` §6의 "이 둘을 합치면 함께
 * 증명된다"는 주장은 실제로는 성립하지 않았다).
 *
 * 이 describe는 그 구간의 **`connectToGame` 이후 절반**
 * (`connection.ts`→`joinOrCreate`→`GameRoom.onJoin`→SQLite)을 덮는다.
 * `App.tsx`(로컬스토리지 읽기·생성)까지 포함하려면 jsdom 도입이 필요해
 * 비용이 크다 — 평가 보고서 §5.1이 권고한 그대로 `connection.ts` 구간만
 * 덮어도 M6는 잡히고 위험의 대부분이 사라진다. `App.tsx`가 넘기는 값 자체
 * (로컬스토리지에서 읽거나 없으면 생성)의 정확성은
 * `tests/unit/rq-81-client-stats-uuid.test.ts`가 이미 담당한다 — 이
 * describe는 "connectToGame에 넘겨진 uuid가 실제로 서버까지 도달해 SQLite
 * 키가 되는가"만 검증해, 두 검증 사이의 빈 구간을 정확히 메운다.
 *
 * **양성 대조군(팀리드 지시)**: "uuid가 전송된다"만 확인하면 값이 빈
 * 문자열이어도 통과할 수 있다 — 그래서 `connectToGame`에 넘긴 uuid
 * 문자열과 SQLite 행의 `uuid` 컬럼이 **정확히 일치**하는지까지 단언한다.
 * 임의의 다른 문자열(빈 문자열·별개 uuid)로는 행이 없다는 것도 함께
 * 확인해 "아무 값이나 키가 됐다"가 아니라는 것을 못박는다.
 *
 * **관측 트리거로 킬 대신 플레이타임을 쓰는 이유**: 이 파일은 조준·발사
 * 헬퍼를 갖고 있지 않고, 새로 들이면 이 파일의 스코프(netcode 배선)를
 * 벗어난다. `GameRoom.onLeave`가 세션의 uuid가 있을 때만 `addPlaytimeMs`를
 * 호출하는 경로(RQ-81)는 접속 → (짧은 대기) → 퇴장만으로 관측 가능한 가장
 * 단순한 통계 쓰기 이벤트다 — M6를 죽이는 데는 "SQLite에 이 uuid로 아무
 * 행이나 쓰이는가"만 있으면 충분하다.
 *
 * **관측 지점**: `openStatsDb`/`getStats`로 서버가 쓴 SQLite 파일을 직접
 * 읽는다 — RQ-81 통합 5파일과 동일한 근거(어느 클라이언트의 `room.state`도
 * 거치지 않는다).
 */
describe('20b/RQ-81(평가 major 3): connectToGame이 uuid를 실제로 서버에 실어 보내 SQLite 통계 행의 키가 된다(M6 가드)', () => {
  let server: RunningServer
  let statsDb: StatsDb
  let tempDir: string

  beforeAll(async () => {
    const temp = createTempStatsDbPath('20b-rq81-uuid-')
    tempDir = temp.dir
    server = await startServerWithStats(temp.path)
    statsDb = openStatsDb(temp.path)
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    statsDb.close()
    await stopServer(server)
    rmSync(tempDir, { recursive: true, force: true })
  })

  it(
    '20b/RQ-81: connectToGame(endpoint, nickname, store, uuid)로 접속·퇴장하면, 그 uuid와 정확히 일치하는 SQLite 통계 행이 생기고 플레이타임이 기록된다',
    async () => {
      // 실제 App.tsx가 localStorage에서 읽거나 새로 생성해 넘기는 값의
      // 대역(형식은 동일 — crypto.randomUUID() 산출물). 이 테스트의 관심사는
      // "이 값이 connectToGame 이후 어디로도 새지 않고 정확히 SQLite 키가
      // 되는가"다 — 로컬스토리지 자체의 읽기·생성 로직은 위 docblock이
      // 가리키는 별도 파일의 몫이다.
      const statsUuid = randomUUID()
      const store = createGameStore()
      const connection: Connection = await withTimeout(
        connectToGame(server.endpoint, 'stats-wiring', store, statsUuid),
        CONNECT_TIMEOUT_MS,
        `connectToGame(nickname: 'stats-wiring', uuid: ${statsUuid})`,
      )
      await waitForSelfNickname(store, connection.sessionId)

      // 측정 가능한 플레이타임을 만들기 위한 짧은 대기 — Date.now() 차분이
      // 0보다 커야 한다는 것뿐이라 값 자체에 의미를 두지 않는다.
      await sleep(100)

      await withTimeout(connection.disconnect(), LEAVE_TIMEOUT_MS, 'connection.disconnect()')

      const stats = await waitForStatsCondition(
        statsDb,
        statsUuid,
        (row) => row !== undefined && row.playtimeMs > 0,
        STATS_TIMEOUT_MS,
        'SQLite 통계 행에 플레이타임이 적재되길 대기 — M6(uuid 미전송) 변이라면 이 행 자체가 영원히 생기지 않아 타임아웃난다',
      )

      // 핵심 단언(팀리드 지시 — 양성 대조군): 값이 존재하기만 하는 게
      // 아니라 connectToGame에 넘긴 그 uuid 문자열과 정확히 일치한다.
      expect(stats?.uuid).toBe(statsUuid)
      expect(stats?.playtimeMs).toBeGreaterThan(0)

      // 임의의 다른 문자열로는 행이 생기지 않았다 — "아무 값이나 키가
      // 됐다"가 아니라 정확히 그 uuid라는 것을 한 번 더 못박는다.
      expect(getStats(statsDb, '')).toBeUndefined()
      expect(getStats(statsDb, randomUUID())).toBeUndefined()
    },
    20_000,
  )
})

/**
 * RQ-72 발소리 구현 2/2-b — 원장 **28ab** 배선 통합 잠금(PR #75 델타 재평가
 * 권고 1·델타 재리뷰 major D2, `_workspace/RQ-72b/04_evaluator_delta.md`
 * §9 Q1).
 *
 * **왜 이 두 describe가 필요한가**: `connection.ts`의 `addSnapshot` 호출
 * 리터럴에서 `grounded`·`hp` 스프레드를 지우고 원복해도(MD2·MD3, 각각
 * "생략하면 항상 접지"·"생략하면 항상 만피"라는 **그럴듯한** 기본값으로
 * 조용히 대체된다) 기존 828 unit + 169 integration 스위트가 **전부
 * 통과했다** — 이 배선에 자동 검출력이 0이었다. 델타 평가가 제시한 최소
 * 재현("클라 2개 → 한쪽이 점프 **또는** 사망→리스폰 → 다른 쪽
 * `connection.interpolator.getFootstepCount(remoteSessionId)` 단언")을
 * 그대로 구현하되, **둘 다** 쓴다 — 각 필드가 정확히 어떤 실패 모드를
 * 덮는지가 다르기 때문이다(아래 두 describe 각각의 "왜 이 시나리오인가"
 * 참고, test-writer 실측 분석).
 *
 * **이 두 describe는 지금(production 코드 828+169 시점) GREEN이 기대값이다.**
 * ADR-0011(선별 Red)상 클라이언트 배선은 test-after 허용 영역이고
 * (CLAUDE.md "TDD — 선별 Red"), 이 배선 자체는 이미 구현돼 있다(원장
 * 24bs·PR #75) — 이 라운드가 새로 만드는 결함 재현이 아니라, **미래에
 * 이 배선이 회귀했을 때 잡는 그물**이다(선례: `20b/RQ-64/F1` describe가
 * `connection.getRttMs()`를 단언하는 이유와 동일 — "이 배선 없으면 RQ-72는
 * 제품에서 조용히 틀린 소리를 낸다"). 실제 검출력(변이 실험)은 이 라운드의
 * 몫이 아니라 격리된 evaluator 세션이 확인한다(CLAUDE.md "검증 판정은
 * 반드시 별도 에이전트 세션").
 *
 * ⚠️ **순증 규칙**: 이 파일의 기존 `it()`은 한 글자도 고치지 않았다 — 이
 * 두 describe와 상단 helper 함수 추가, import 3줄 추가(`AUDIO`·
 * `MOVEMENT`·`PLAYER`, `DEFAULT_HITBOX`, `escapeSafeZone`/`getSafeZoneSeam`)
 * 뿐이다.
 */

/** 사격 사이 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다
 * (`rq-15-respawn-timer.test.ts`의 동명 상수와 동일 값·근거). */
const BETWEEN_SHOTS_MS = 300
/** 리스폰 관측 상한(ms) — `PLAYER.RESPAWN_MS`(3000) + 실 서버 스케줄링
 * 지터를 넉넉히 흡수하는 여유(`rq-15-respawn-timer.test.ts`와 동일 근거). */
const RESPAWN_OBSERVE_TIMEOUT_MS = 8_000
/** "3초보다 눈에 띄게 이르게 리스폰되면 안 된다"는 하한(ms) —
 * `rq-15-respawn-timer.test.ts`의 동명 상수와 동일 값·근거. */
const MIN_RESPAWN_ELAPSED_MS = 2_500
/** 위치·모드 선언 메시지가 서버에 반영될 시간(로컬 WS라 짧아도 충분하나
 * 여유를 둔다) — `rq-15-respawn-timer.test.ts`의
 * `RELEASE_PROTECTION_SETTLE_MS`와 동일 정신, 이 파일은 용도가 하나 더
 * 넓어(위치 탈출 + mode 선언 + 안정화 확인 3곳) 이름을 일반화했다. */
const SETTLE_MS = 300

/** `connection.interpolator.getFootstepCount(sessionId)`가 `undefined`가
 * 아니게 될 때까지(그 세션의 첫 스냅샷이 도착할 때까지) 폴링한다 — 첫
 * 스냅샷은 계약상 항상 무음(0)이므로(`interpolation.ts` "첫 addSnapshot"
 * 규칙) 이 값 자체가 0이어도 "관측 시작"의 신호로 유효하다. 이 파일 §RQ-64/F1의
 * `waitForRttCondition`과 동일한 폴링 정신.
 */
function waitForFootstepBaseline(
  connection: Connection,
  sessionId: string,
  timeoutMs: number,
  label: string,
): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve) => {
      const tryResolve = (): boolean => {
        const count = connection.interpolator.getFootstepCount(sessionId)
        if (count !== undefined) {
          resolve(count)
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

/** A(사수)의 눈높이에서 target의 바디 중심을 겨누는 조준 벡터.
 * `rq-15-respawn-timer.test.ts`의 동명 헬퍼와 동일 계산(그 파일은 이
 * 헬퍼를 export하지 않아 이 파일이 독립적으로 재선언한다 — 기존 통합
 * 테스트 파일들의 관례, 각 파일이 자기 몫의 조준 수학을 갖는다). */
function aimAtBody(
  shooter: { x: number; z: number },
  target: { x: number; z: number },
): { dirX: number; dirY: number; dirZ: number } {
  const bodyCenterM = (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = bodyCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

/**
 * 원장 28ab — **grounded** 배선 잠금(MD1·MD2·MD5를 겨냥).
 *
 * **왜 점프 시나리오인가**: `grounded`를 생략하면 `RemoteSnapshot.grounded`가
 * `true`로 기본 대체된다(`interpolation.ts` — "생략하면 true"). 접지
 * 이동(달리기) 중에는 실제 값도 거의 항상 `true`이므로 그 상태만 관찰하면
 * 기본값과 실제값이 우연히 일치해 결함이 **가려진다**. 공중 구간
 * (`grounded===false`)이 있어야 기본값(`true`)과 실제값(`false`)이
 * 갈라져 결함이 드러난다.
 *
 * **수치 근거(ADR-0014 결정 3·GA-85 — 이미 `sim-footsteps.test.ts`·
 * `rq-72-remote-footsteps.test.ts`가 재사용한 값)**: `JUMP_V0=√40·g=20`
 * (둘 다 `movement.ts`의 모듈 비공개 상수라 이 파일이 직접 임포트할 수
 * 없다 — ADR-0014 §결정 3·GA-85가 이미 유도해 둔 결과값 19틱을 그대로
 * 인용한다)이라 30Hz에서 체공은 **정확히 19틱**이고, 공중에서는
 * `AIR_CONTROL=false`라 이함 시점의 수평 속도(`MOVEMENT.SPEED`, run이므로
 * 감쇠 없음)가 착지까지 그대로 유지된다. 접지 이동은 가속이 없어
 * 틱당 수평 변위가 `MOVEMENT.SPEED / NET.TICK_HZ`로 고정이다(GA-85 근거
 * 문단과 동일 산술) — 그 값을 그대로 계산에 쓴다(하드코딩하지 않는다,
 * ADR-0010).
 *
 * `grounded`가 잘못 항상 `true`로 대체되면(MD1·MD2·MD5), 이함 틱부터
 * 이미 `wasGrounded && isGrounded && mode==='run'`이 참이 되어 공중
 * 변위가 즉시 누적되기 시작한다 — `Math.ceil(FOOTSTEP_STRIDE_M /
 * (SPEED/TICK_HZ))`(=10)틱만에 첫 발소리가 등록된다. 올바른 구현은 체공
 * 19틱 내내 0을 유지한다(이함·공중·착지 틱이 전부 배제되므로). 두 값의
 * 중간 지점(약 15틱)에서 확인하면 버그면 이미 1, 정상이면 여전히 0 —
 * 명확히 갈린다.
 */
describe('RQ-72 2/2-b/원장 28ab: 원격 발소리 grounded 배선 잠금 — 공중 구간의 변위가 발소리로 새지 않는다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "RQ-72/28ab: B가 달리며 점프(grounded=false 구간 발생) 하는 동안 A가 관측하는 B의 발소리 횟수가 체공 중에는 0을 유지하고, 착지 후 실제 접지 이동이 이어지면 정상적으로 등록된다(양성 대조군)",
    async () => {
      const storeA = createGameStore()
      const connA: Connection = await withTimeout(
        connectToGame(server.endpoint, 'listenerJump', storeA),
        CONNECT_TIMEOUT_MS,
        "A: connectToGame(nickname: 'listenerJump')",
      )
      const storeB = createGameStore()
      const connB: Connection = await withTimeout(
        connectToGame(server.endpoint, 'jumperB', storeB),
        CONNECT_TIMEOUT_MS,
        "B: connectToGame(nickname: 'jumperB')",
      )

      // A의 B에 대한 첫 관측(계약상 무음) — 이후 카운트 변화만 비교하면
      // 되므로 정확한 시작값은 몰라도 되지만, 아직 이동이 없었으므로
      // 0이어야 한다(양성 대조군의 전제).
      const baseline = await waitForFootstepBaseline(
        connA,
        connB.sessionId,
        STORE_TIMEOUT_MS,
        'A가 B의 첫 스냅샷을 관측(발소리 기준값 확립)하길 대기',
      )
      expect(baseline).toBe(0)

      // 단일 메시지 — dirX=1(run)과 jump=true를 동시에 보낸다. 서버
      // `pendingInputs`는 다음 'move' 메시지가 올 때까지 이 입력을
      // 유지하며 매 틱 적용한다(`GameRoom.ts` — jump는 소비 후 자동으로
      // false로 되돌지만 dirX·mode는 그대로 유지된다) — 그래서 이함 이후
      // 추가 메시지 없이도 AIR_CONTROL=false 하에 체공 내내 수평 이동이
      // 계속되고, 착지 후에도 같은 방향으로 접지 이동이 자연히 이어진다.
      connB.room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: true })

      const GROUND_TICK_DISTANCE_M = MOVEMENT.SPEED / NET.TICK_HZ // 0.2m/틱(GA-85 산술과 동일)
      const MUTATION_TRIGGER_TICKS = Math.ceil(AUDIO.FOOTSTEP_STRIDE_M / GROUND_TICK_DISTANCE_M) // 10틱 — grounded가 항상 true로 새면 이 시점에 이미 1회 등록된다
      const AIR_TIME_TICKS = 19 // ADR-0014 결정 3 / GA-85 — JUMP_V0=√40, g=20, 30Hz
      const MID_AIR_CHECK_TICKS = Math.round((MUTATION_TRIGGER_TICKS + AIR_TIME_TICKS) / 2) // 두 임계의 중간 — 버그면 1, 정상이면 아직 0

      await sleep(MID_AIR_CHECK_TICKS * NET.TICK_MS)

      const midAirCount = connA.interpolator.getFootstepCount(connB.sessionId)
      expect(midAirCount).toBe(0)

      // 양성 대조군 — 착지 후에도 같은 방향 입력이 이어지므로 실제 접지
      // 이동이 계속된다. 체공(19틱) 이후 보폭(2.0m)을 채우는 데 필요한
      // 틱 수만큼 더 기다리면 정상적으로 최소 1회는 등록돼야 한다("영원히
      // 0"인 별개의 결함과 이 테스트를 구분한다). 패치 전달 지연(≈20Hz)
      // 여유를 더한다.
      const EXTRA_GROUND_TICKS = Math.ceil(AUDIO.FOOTSTEP_STRIDE_M / GROUND_TICK_DISTANCE_M) + 5
      await sleep((AIR_TIME_TICKS - MID_AIR_CHECK_TICKS + EXTRA_GROUND_TICKS) * NET.TICK_MS + 200)

      const afterLandingCount = connA.interpolator.getFootstepCount(connB.sessionId)
      expect(afterLandingCount).toBeGreaterThanOrEqual(1)

      await Promise.all([
        withTimeout(connA.disconnect(), LEAVE_TIMEOUT_MS, 'A: disconnect'),
        withTimeout(connB.disconnect(), LEAVE_TIMEOUT_MS, 'B: disconnect'),
      ])
    },
    20_000,
  )
})

/**
 * 원장 28ab — **hp** 배선 잠금(MD3·MD4를 겨냥).
 *
 * **왜 사망→리스폰 시나리오인가**: `hp`를 생략하면 `RemoteSnapshot.hp`가
 * `PLAYER.MAX_HP`로 기본 대체된다. 죽지 않은 정상 플레이 중에는 실제 hp도
 * 대부분 `MAX_HP` 근처이므로(정확히 다른 값일 때만 갈린다) 사망(hp=0)이
 * 없으면 기본값과 실제값이 우연히 일치해 결함이 가려진다 — 위 점프
 * 시나리오가 hp를 전혀 건드리지 않는 것과 대칭이다(그래서 이 파일이 둘 다
 * 필요하다, 델타 평가 §9 Q1의 "또는" 표현이 한 종류의 필드만 가리키는
 * 것이 아님을 이 test-writer가 실측으로 재확인했다).
 *
 * `respawnPlayer`는 좌표를 스폰 지점으로 순간이동시키고 `grounded=true`를
 * 명시하지만 `mode`는 대입하지 않는다(`GameRoom.ts` — ADR-0014 결정 4
 * 근거 문단이 이미 정확히 이 조합을 지목한다: "부활 틱은 grounded===true
 * ∧ mode==='run' ∧ 수평 변위=스폰 간 거리이고, 새 누적 규칙이 정확히 그
 * 조합을 누적 대상으로 지정한다"). `hp`가 잘못 항상 `MAX_HP`로 새면(MD3·
 * MD4) 사망 직전 hp가 이미 0이었다는 사실 자체가 관측되지 않아
 * discontinuous 판정(직전 hp===0 ∧ 이번 hp===MAX_HP)이 **영원히 발동하지
 * 않고**, 스폰 지점 간 순간이동(최소 8.602325m, 원장 26s 실측 — 보폭
 * 2.0m보다 훨씬 크다)이 그대로 누적돼 리스폰 즉시 여러 번의 발소리가
 * 터진다.
 *
 * **화이트박스 텔레포트(Safe Zone 탈출) 오염 회피**: `escapeSafeZone`
 * (전투 준비용)은 그 자체로 실제 위치 점프이지만 hp를 건드리지 않으므로
 * discontinuous가 아니다 — 올바른 구현에서도 (조건이 맞으면) 발소리로
 * 새는 게 원리상 가능하다. 이 테스트는 그 오염을 원천 차단한다: **B를
 * 먼저 탈출시키고 나서 A를 접속시킨다** — A가 B를 처음 관측하는 스냅샷이
 * 이미 탈출 후 위치이므로 "첫 addSnapshot은 무음" 규칙이 탈출 점프를
 * 조용히 흡수한다(위 점프 시나리오와 달리 이 시나리오만 순서에 민감하다).
 */
describe('RQ-72 2/2-b/원장 28ab: 원격 발소리 hp 배선 잠금 — 사망→리스폰 순간이동이 발소리로 새지 않는다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-72/28ab: A의 사격으로 B가 사망한 뒤 리스폰(스폰 간 순간이동)해도 A가 관측하는 B의 발소리 횟수는 그대로이고, 리스폰 후 실제 이동은 정상적으로 등록된다(양성 대조군)',
    async () => {
      // B를 먼저 접속·탈출시킨다(오염 회피, 위 docblock).
      const storeB = createGameStore()
      const connB: Connection = await withTimeout(
        connectToGame(server.endpoint, 'victimHp', storeB),
        CONNECT_TIMEOUT_MS,
        "B: connectToGame(nickname: 'victimHp')",
      )
      const bNickname = await waitForSelfNickname(storeB, connB.sessionId)
      expect(bNickname).toBe('victimHp')
      const baselineB = storeB.getState().players.get(connB.sessionId)!
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      const seam = getSafeZoneSeam(connB.room)
      const escapedB = escapeSafeZone(seam, connB.sessionId, baselineB)

      // 정지 상태에서 mode만 'run'으로 선언한다(수평 변위 0, 위치는 전혀
      // 안 바뀐다) — ADR-0014 결정 4가 지목하는 "부활 시각에도 mode는
      // 'run'"이라는 정확한 조건을 재현하기 위함이다. 이게 없으면
      // `Player.mode`의 스키마 기본값이 이미 `'run'`이라(`GameState.ts`)
      // 사실 없어도 같은 조건이 성립하지만, 이 파일이 그 사실에 암묵적으로
      // 기대지 않고 명시적으로 만든다(다음에 스키마 기본값이 바뀌어도 이
      // 테스트의 전제가 스스로 깨지지 않는다).
      connB.room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
      await sleep(SETTLE_MS)

      // 이제 A를 접속시킨다 — A의 B에 대한 첫 관측은 이미 탈출 후 위치이므로
      // "첫 addSnapshot은 무음" 규칙이 탈출 점프를 흡수한다.
      const storeA = createGameStore()
      const connA: Connection = await withTimeout(
        connectToGame(server.endpoint, 'listenerHp', storeA),
        CONNECT_TIMEOUT_MS,
        "A: connectToGame(nickname: 'listenerHp')",
      )
      await waitForSelfNickname(storeA, connA.sessionId)
      const baseline = await waitForFootstepBaseline(
        connA,
        connB.sessionId,
        STORE_TIMEOUT_MS,
        'A가 B의 첫 스냅샷을 관측(발소리 기준값 확립)하길 대기 — 탈출 점프가 여기서 조용히 흡수된다',
      )
      expect(baseline).toBe(0)

      // A를 Safe Zone 밖으로 옮기고(사격 가능하게), B의 스폰 보호를
      // 해제한다(RQ-16 — 화이트박스, `rq-15-respawn-timer.test.ts`와 동일
      // 근거: 자기 사격 대신 화이트박스를 쓰는 이유는 RQ-31 회귀 대응).
      const baselineA = storeA.getState().players.get(connA.sessionId)!
      const escapedA = escapeSafeZone(seam, connA.sessionId, baselineA)
      seam.firedSinceSpawn.set(connB.sessionId, true)
      await sleep(SETTLE_MS)

      // 전투 직전에도 여전히 무음이어야 한다(탈출·설정 단계에서 아무 변위도
      // 실제로 발생하지 않았다는 확인 — 핵심 단언 전의 건전성 확인).
      expect(connA.interpolator.getFootstepCount(connB.sessionId)).toBe(baseline)

      const aim = aimAtBody(escapedA, escapedB)
      // `PLAYER.MAX_HP`는 `as const` 리터럴 타입(100)이라 명시적으로
      // `number`로 넓히지 않으면 아래 재대입에서 TS2322가 난다
      // (`rq-15-respawn-timer.test.ts`의 `killPlayer`가 `baselineB.hp`
      // 라는 이미 넓혀진 값에서 시작해 이 함정을 겪지 않은 것과 대비된다).
      let previousHp: number = PLAYER.MAX_HP
      const MAX_KILL_SHOTS = 4 // 바디샷만 맞을 때의 상한(헤드샷이 섞이면 더 일찍 끝난다)
      for (let shot = 1; shot <= MAX_KILL_SHOTS && previousHp > 0; shot += 1) {
        connA.room.send('fire', aim)
        const afterShot = await waitForStoreCondition(
          storeB,
          (s) => s.players.get(connB.sessionId)?.hp !== previousHp,
          STORE_TIMEOUT_MS,
          `${shot}번째 사격 후 B의 HP 변화 대기(직전 HP=${previousHp})`,
        )
        previousHp = afterShot.players.get(connB.sessionId)!.hp
        if (previousHp > 0) await sleep(BETWEEN_SHOTS_MS)
      }
      expect(previousHp).toBe(0)

      // 사망 직후에도 발소리 관측은 그대로다(사망 자체는 이동이 아니다).
      expect(connA.interpolator.getFootstepCount(connB.sessionId)).toBe(baseline)

      const deathAtMs = Date.now()
      const afterRespawn = await waitForStoreCondition(
        storeB,
        (s) => s.players.get(connB.sessionId)?.hp === PLAYER.MAX_HP,
        RESPAWN_OBSERVE_TIMEOUT_MS,
        'RQ-72/28ab: 사망 후 리스폰(HP 100 복귀) 대기',
      )
      const respawnElapsedMs = Date.now() - deathAtMs
      expect(respawnElapsedMs).toBeGreaterThanOrEqual(MIN_RESPAWN_ELAPSED_MS)

      const respawnedB = afterRespawn.players.get(connB.sessionId)!
      const teleportDistanceM = Math.hypot(respawnedB.x - escapedB.x, respawnedB.z - escapedB.z)
      // 스폰 지점 간 최소 거리는 8.602325m(원장 26s 실측, `sim-spawn.test.ts`
      // GA-51)이므로 이 순간이동은 항상 보폭(2.0m)보다 훨씬 크다 — 이 값이
      // 작으면 애초에 이 테스트가 hp 배선의 결함을 드러낼 수 없어 무의미하다.
      expect(teleportDistanceM).toBeGreaterThan(AUDIO.FOOTSTEP_STRIDE_M)

      // 핵심 단언 — 순간이동이 발소리로 새지 않았다. 아직 도착하지 않은
      // 패치가 있을 가능성까지 짧게 안정화시킨 뒤 다시 확인한다.
      await sleep(SETTLE_MS)
      expect(connA.interpolator.getFootstepCount(connB.sessionId)).toBe(baseline)

      // 양성 대조군 — 리스폰 후 실제로 보폭을 채우면 정상적으로 등록된다
      // ("영원히 0"인 별개의 결함과 이 테스트를 구분한다).
      connB.room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
      const GROUND_TICK_DISTANCE_M = MOVEMENT.SPEED / NET.TICK_HZ
      const RUN_AFTER_RESPAWN_TICKS = Math.ceil(AUDIO.FOOTSTEP_STRIDE_M / GROUND_TICK_DISTANCE_M) + 5
      await sleep(RUN_AFTER_RESPAWN_TICKS * NET.TICK_MS + 200)
      expect(connA.interpolator.getFootstepCount(connB.sessionId)).toBeGreaterThanOrEqual(baseline + 1)

      await Promise.all([
        withTimeout(connA.disconnect(), LEAVE_TIMEOUT_MS, 'A: disconnect'),
        withTimeout(connB.disconnect(), LEAVE_TIMEOUT_MS, 'B: disconnect'),
      ])
    },
    30_000,
  )
})

/**
 * RQ-70/RQ-71 — **GA-100** (`harness/evals/golden/track-a-product.jsonl`,
 * `verify` 필드가 이 파일 경로를 직접 지정한다).
 *
 * **왜 통합이어야 하는가(골든 자신의 근거, `given`/`then` 절 그대로)**:
 * "명중 이벤트가 `connectToGame`이 **실제로 등록한 핸들러**를 통해
 * 도착한다"는 전제와 "탄흔·피격 수집기가 **실제로 호출된다**"는 결과
 * 둘 다 배선(wiring) 자체가 관측 대상이다 — 단위 테스트로 두면
 * `connection.ts`를 별도 모듈로 뽑아 그 모듈만 부르는 우회가 가능해
 * "`connectToGame`이 그것을 정말 부르는가"라는 한 홉이 남는다(RQ-73
 * 라운드에서 변이 4건이 1039/1039를 통과한 바로 그 구조, ADR-0016 결정 4
 * 참고). 그래서 이 describe 두 개는 **실 서버 + 실 `fire` 판정 + 실
 * WebSocket**으로 진짜 `hit` 브로드캐스트를 만들어 흘려보낸다 — 합성
 * `HitEvent` 객체를 직접 주입하지 않는다(그건 `rq-70-71-hit-feedback
 * .test.ts`의 GA-98 몫이다, 레벨 분리).
 *
 * **왜 시나리오가 둘인가(벽·플레이어)**: ADR-0016 결정 1이 "대상 종류
 * (벽/플레이어)"를 이벤트의 필수 축으로 못박았고, 서버가 그 두 갈래를
 * 각각 **판정해 만드는 경로 자체가 이번 라운드의 신규 코드**(맥락 —
 * `rq-12-wall-occlusion.test.ts`가 이미 "차폐"는 덮지만 "차폐되지 않았을
 * 때 벽 자체에 명중 이벤트가 생기는가"는 오늘 아무도 덮지 않는다). 한
 * 갈래만 배선하고 다른 갈래를 빠뜨리는 회귀(예: 벽 이벤트만 만들고 플레이어
 * 이벤트 브로드캐스트를 잊는 경우, 또는 그 반대)를 각각 잡으려면 두 경로
 * 모두 실제로 발화시켜야 한다 — RQ-72 2/2-b(원장 28ab)가 "필드 하나만
 * 생략해도 828+169건이 전부 통과했다"고 실측한 것과 같은 이유로, 한
 * 시나리오만으로는 나머지 갈래의 배선 누락이 조용히 가려진다.
 *
 * **결정론(탄착점) — `spreadTuningOverride`(RQ-90 그린필드 화이트박스
 * 계약, `rq-90-spread-seed-determinism.test.ts` 선례와 동일한 권한)로
 * 콘 반경을 0으로 고정한다.** 기본 탄퍼짐(0.5°)은 이 파일의 사거리
 * (15m·약 11.6m)에서도 대개 명중하지만, 이 테스트는 "배선이 있는가"만
 * 보고 싶을 뿐 탄퍼짐 확률에 기대고 싶지 않다 — 콘 반경 0이면 항상
 * 정확히 조준한 방향 그대로 나간다(`applySpread`의 `coneRadiusRad===0`
 * 항등 계약).
 *
 * **화이트박스 계약**: `moveStates`·`positionHistory`·`firedSinceSpawn`은
 * 그린필드가 아니다(기존 rq-12/rq-31/rq-90 파일들과 동일 필드).
 * `spreadTuningOverride`도 그린필드가 아니다(RQ-90 기존 계약,
 * `combat-tuning.ts`의 `SpreadTuning`을 그대로 재사용 — 이 필드 자체를
 * 새로 만들지 않는다). 이 describe 쌍이 **새로 요구하는 것은 오직**
 * `store.getState().bulletHoles`·`store.getState().hitEffects`
 * (`GameStoreState` 확장, `tests/unit/rq-70-71-hit-feedback.test.ts` 상단
 * "gameStore.ts/connection.ts 배선" 절이 요약한 계약)뿐이다.
 *
 * **정확한 명중 기하(라켓스캔 자체)는 이 파일의 검증 대상이 아니다** —
 * 벽 쪽은 `tests/unit/sim-combat-wall-hit.test.ts`, 플레이어 쪽은 기존
 * `sim-combat.test.ts`/`rq-12-server-hitscan.test.ts`가 이미 담당한다.
 * 이 describe 쌍은 "그 판정 결과가 실제로 `hit` 메시지로 나가 store까지
 * 닿는가"만 본다 — 벽 시나리오만 좌표를 정밀하게 검산한다(손으로 검산
 * 가능한 배치를 골랐을 뿐 그 자체가 이 파일의 핵심 관심사는 아니다),
 * 플레이어 시나리오는 "B 근방"이라는 느슨한 위치 확인으로 충분하다.
 */

/** GA-100 화이트박스 접근 대상 — `SafeZoneEscapeSeam`(`../support/safe
 * -zone`, 그린필드 아님)에 RQ-90 기존 계약(`spreadTuningOverride`)만
 * 얹는다. `wallsOverride`는 쓰지 않는다 — 기본값(`PRODUCTION_WALLS`)에
 * 이미 `WALL_EAST`가 들어 있으므로 오버라이드가 필요 없다(간섭 표면을
 * 최소화한다). */
interface HitFeedbackTestSeam extends SafeZoneEscapeSeam<unknown> {
  spreadTuningOverride?: SpreadTuning
}

function getHitFeedbackSeam(room: { roomId: string }): HitFeedbackTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as HitFeedbackTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`GA-100 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** 콘 반경 0 — 탄착점을 결정론적으로 만든다(위 describe 상단 "결정론" 절). */
const ZERO_SPREAD: SpreadTuning = { coneRadiusRad: 0, movingMultiplier: 1, airborneMultiplier: 1 }

/** 화이트박스 텔레포트 후 스키마 동기화 정착 대기
 * (`rq-12-wall-occlusion.test.ts`의 `TELEPORT_SETTLE_MS`와 동일 근거·값). */
const HIT_TELEPORT_SETTLE_MS = 150

/** 사수를 원점(0,0,0)으로 텔레포트한다 — `WALL_EAST.minX`(15)보다 한참
 * 안쪽이고 모든 Safe Zone 밖(`rq-12-wall-occlusion.test.ts`의
 * `SHOOTER_POS`와 동일 좌표·동일 근거, 이 파일이 그 결론을 재검산하지
 * 않고 재사용한다). */
function teleportShooterToOrigin(seam: HitFeedbackTestSeam, sessionId: string): void {
  seam.moveStates.set(sessionId, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true })
  seam.positionHistory.delete(sessionId)
}

describe('20b/RQ-70/GA-100(벽): 실 사격으로 만들어진 벽 명중 이벤트가 connectToGame 경로로 도착해 store.bulletHoles를 갱신한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "GA-100(벽): 원점에서 WALL_EAST를 향해 수평으로 쏘면, 서버가 벽 명중 좌표·법선을 담은 'hit' 이벤트를 브로드캐스트하고 그것이 connectToGame이 등록한 핸들러를 통해 store.bulletHoles에 실제로 쌓인다(store.hitEffects는 비어 있다)",
    async () => {
      const store = createGameStore()
      const connection: Connection = await withTimeout(
        connectToGame(server.endpoint, 'wallShooter', store),
        CONNECT_TIMEOUT_MS,
        "connectToGame(nickname: 'wallShooter')",
      )
      await waitForSelfNickname(store, connection.sessionId)

      const seam = getHitFeedbackSeam(connection.room)
      seam.spreadTuningOverride = ZERO_SPREAD
      teleportShooterToOrigin(seam, connection.sessionId)
      await sleep(HIT_TELEPORT_SETTLE_MS)

      // 사수 눈높이(DEFAULT_HITBOX.eyeHeightM, mode 미선언이라 'run' 기본값
      // → 선 자세)에서 정확히 +x로 쏜다 — WALL_EAST(x:15~16, z:-5~5)의
      // minX 면(x=15)에 z=0에서 진입한다(손으로 검산 가능한 배치,
      // `sim-combat-wall-hit.test.ts`의 "x 슬랩이 tMin을 결정" 케이스와
      // 동일한 기하를 15m 거리에서 재현한다).
      connection.room.send('fire', { dirX: 1, dirY: 0, dirZ: 0 })

      const afterHit = await waitForStoreCondition(
        store,
        (s) => s.bulletHoles.length > 0,
        STORE_TIMEOUT_MS,
        "GA-100(벽): store.bulletHoles에 탄흔이 반영되길 대기 — 반영되지 않으면 'hit' 배선이 없다는 뜻",
      )

      expect(afterHit.bulletHoles).toHaveLength(1)
      const hole = afterHit.bulletHoles[0]!
      expect(hole.point.x).toBeCloseTo(WALL_EAST.minX, 6)
      expect(hole.point.y).toBeCloseTo(DEFAULT_HITBOX.eyeHeightM, 6)
      expect(hole.point.z).toBeCloseTo(0, 6)
      expect(hole.normal).toEqual({ x: -1, y: 0, z: 0 })

      // 대상 종류 구분도 실 배선에서 성립한다 — 벽 명중은 피격 컬렉션으로 새지 않는다.
      expect(store.getState().hitEffects).toHaveLength(0)

      // 1차 리뷰 blocker B1의 대칭 축 — RQ-70 「탄흔은 **시간으로는 사라지지
      // 않는다**. 상한이 유일한 제거 규칙이다」를 **실 배선 위에서** 잠근다.
      // 피격 효과와 같은 `advanceHitFeedback`을 통과하므로, 그 함수가 두
      // 컬렉션을 같은 규칙으로 만료시키도록 바뀌면(RQ-70 위반) 여기서 죽는다.
      // 순수 층은 GA-99가 고정하지만 배선 층에서 규칙이 섞이는 변경은 잡지 못한다.
      await sleep(EFFECTS_TUNING.HIT_EFFECT_DURATION_MS * 3)
      expect(store.getState().bulletHoles).toHaveLength(1)

      await withTimeout(connection.disconnect(), LEAVE_TIMEOUT_MS, 'connection.disconnect()')
    },
    20_000,
  )
})

describe('20b/RQ-71/GA-100(플레이어): 실 사격으로 만들어진 플레이어 명중 이벤트가 connectToGame 경로로 도착해 store.hitEffects를 갱신한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "GA-100(플레이어): A가 B를 조준 사격해 명중하면, 서버가 target='player'인 'hit' 이벤트를 브로드캐스트하고 그것이 A의 connectToGame 핸들러를 통해 store.hitEffects에 실제로 쌓인다(store.bulletHoles는 비어 있다)",
    async () => {
      const storeA = createGameStore()
      const connA: Connection = await withTimeout(
        connectToGame(server.endpoint, 'playerShooter', storeA),
        CONNECT_TIMEOUT_MS,
        "A: connectToGame(nickname: 'playerShooter')",
      )
      const storeB = createGameStore()
      const connB: Connection = await withTimeout(
        connectToGame(server.endpoint, 'playerTarget', storeB),
        CONNECT_TIMEOUT_MS,
        "B: connectToGame(nickname: 'playerTarget')",
      )
      await waitForSelfNickname(storeA, connA.sessionId)
      await waitForSelfNickname(storeB, connB.sessionId)

      const seam = getHitFeedbackSeam(connA.room)
      seam.spreadTuningOverride = ZERO_SPREAD
      const baselineA = storeA.getState().players.get(connA.sessionId)!
      const baselineB = storeB.getState().players.get(connB.sessionId)!
      // 반경-방사 탈출(`escapeSafeZone`) — 첫째·둘째 입장자는 인접 스폰
      // 인덱스(각도차 24°)를 받으므로 탈출 후 현의 원점 최근접 거리는
      // 28·cos(12°)≈27.4m로 WALL_EAST 등 벽 대역(15.8~16.8m)과 무관하다
      // (`rq-12-wall-occlusion.test.ts` 상단 "회귀 사전 실측" 절과 동일
      // 근거 — 이 파일이 그 결론을 재검산하지 않고 재사용한다).
      const escapedA = escapeSafeZone(seam, connA.sessionId, baselineA)
      const escapedB = escapeSafeZone(seam, connB.sessionId, baselineB)
      seam.firedSinceSpawn.set(connB.sessionId, true) // RQ-16과 분리 — 이 시나리오는 GA-100 배선만 본다
      await sleep(HIT_TELEPORT_SETTLE_MS)

      const aim = aimAtBody(escapedA, escapedB)
      connA.room.send('fire', aim)

      const afterHit = await waitForStoreCondition(
        storeA,
        (s) => s.hitEffects.length > 0,
        STORE_TIMEOUT_MS,
        "GA-100(플레이어): store.hitEffects에 피격 효과가 반영되길 대기 — 반영되지 않으면 'hit' 배선이 없다는 뜻",
      )

      expect(afterHit.hitEffects).toHaveLength(1)
      const effect = afterHit.hitEffects[0]!
      // 정확한 명중점 산술(raycastHitbox)은 sim-combat.test.ts/RQ-12
      // 통합 테스트가 이미 검증한다 — 여기서는 "B 근방"이라는 느슨한
      // 위치만 확인해 배선(GA-100)과 판정 정확도(다른 골든)를 섞지 않는다.
      const horizontalDistanceFromB = Math.hypot(effect.point.x - escapedB.x, effect.point.z - escapedB.z)
      expect(horizontalDistanceFromB).toBeLessThanOrEqual(DEFAULT_HITBOX.bodyRadiusM + 0.05)

      // 대상 종류 구분도 실 배선에서 성립한다 — 플레이어 명중은 탄흔 컬렉션으로 새지 않는다.
      expect(storeA.getState().bulletHoles).toHaveLength(0)

      // F1 재리뷰(`_workspace/RQ-70-71/03_evaluator_report.md` M1) — 플레이어
      // 명중 법선이 서버→클라 경계를 실제로 건너오는지 확인한다. `normal`
      // 자체의 값 정확성(부위별 공식)은 `sim-combat-hit-normal.test.ts`가
      // 이미 순수 산술로 고정한다 — 여기서는 그 값이 **와이어를 타고
      // 살아서 도착하는지**만 본다. 영벡터 변이라면 magnitude가 0이 되어
      // 아래 첫 단언이 죽는다. `aimAtBody`는 바디 중심을 조준하므로
      // (바디 명중, region 자체는 이 파일이 재검산하지 않는다) 법선의
      // y 성분은 원통 측면 정의(`combat.ts`)상 정확히 0이어야 한다.
      const normalMagnitude = Math.hypot(effect.normal.x, effect.normal.y, effect.normal.z)
      expect(normalMagnitude).toBeCloseTo(1, 6) // 영벡터가 아니라 실제 단위 법선이 건너왔다
      expect(effect.normal.y).toBe(0) // 바디 명중(aimAtBody) — 원통 측면 법선은 y를 버린다

      // 델타 재평가 FAIL / 델타 재리뷰 major D1 — **여기가 없으면 만료가
      // 「너무 일찍」 와도 아무도 안 죽는다**. `waitForStoreCondition`은
      // zustand 리스너 안에서 술어를 **동기 평가하고 그 자리의 스냅샷을
      // 포획**하므로(위 172~199행), 앞의 `length > 0` 대기는 `addHitEvent`가
      // `set`하는 순간 이미 resolve됐고 `afterHit`을 읽는 단언들은 **그 뒤의
      // 변화를 원리적으로 못 본다**. 그래서 스토어를 **다시 읽는다**.
      // ⚠️ 벽시계 `sleep`이 아니라 **틱 전진**을 기다리는 이유: 만료는
      // `handleStateChange`(= 상태 패치)에서만 일어나므로, 러너가 굶어
      // 패치가 안 온 사이 잠만 자면 변이를 **놓친다**(공허한 통과).
      // `tick`은 패치로만 갱신되니 2틱 전진은 「패치가 최소 한 번 왔다」의
      // 관측 가능한 증거다 — 그리고 2틱(≈67ms)은 TTL의 1/6이라 정상
      // 코드에서는 아직 살아 있어야 한다.
      const tickAtHit = afterHit.tick
      await waitForStoreCondition(
        storeA,
        (s) => s.tick > tickAtHit + 1,
        STORE_TIMEOUT_MS,
        'GA-100(플레이어): 명중 이후 상태 패치가 최소 한 번 처리되길 대기(틱 2 전진)',
      )
      expect(storeA.getState().hitEffects).toHaveLength(1) // TTL 이전에는 살아 있다 — 즉시 만료 변이가 여기서 죽는다

      // 1차 리뷰 blocker B1 — ADR-0016 결정 4가 「피격 효과가 시간이 지나면
      // 사라지는가」를 **이름으로** 면제 대상에서 제외한다(면제되는 것은
      // 렌더 배선뿐이다). 순수 층의 만료는 GA-99가 이미 고정하므로 여기서
      // 보는 것은 **`connectToGame`이 등록한 실 배선**(`handleStateChange`의
      // `advanceHitFeedback` 호출)이 TTL을 실제로 진행시키는지다. 이 단언이
      // 없으면 그 호출을 지워도 스위트가 전부 초록이고 제품에서는 피가
      // 영원히 쌓인다(`applyHitEvent`의 'player' 분기는 개수 상한이 없다).
      // 대기 상한(STORE_TIMEOUT_MS)은 `EFFECTS_TUNING.HIT_EFFECT_DURATION_MS`
      // 보다 한 자릿수 이상 크다 — 값을 여기 복제하지 않는다(ADR-0010).
      await waitForStoreCondition(
        storeA,
        (s) => s.hitEffects.length === 0,
        STORE_TIMEOUT_MS,
        'GA-100(플레이어): 피격 효과가 TTL 경과 후 실 배선을 통해 사라지길 대기 — 사라지지 않으면 advanceHitFeedback 배선이 없다는 뜻',
      )

      await Promise.all([
        withTimeout(connA.disconnect(), LEAVE_TIMEOUT_MS, 'A: disconnect'),
        withTimeout(connB.disconnect(), LEAVE_TIMEOUT_MS, 'B: disconnect'),
      ])
    },
    20_000,
  )
})
