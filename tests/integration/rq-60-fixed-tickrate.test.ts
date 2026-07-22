import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'

/**
 * RQ-60 서버 30Hz 고정 틱 — 실 서버 루프 통합 테스트 (ADR-0008: Colyseus 룸 경계).
 *
 * 매핑된 골든 케이스: GA-14 (`harness/evals/golden/track-a-product.jsonl`).
 * RQ-60 전문: "서버는 30Hz 고정 틱으로 시뮬레이션을 진행해야 한다."
 * GA-14: "given: 서버가 정상 기동 중 / when: N틱 동안 틱 간격을 측정 / then:
 * 틱 간격은 평균 33.3ms(30Hz)로 고정되며, 부하 유무와 무관하게 시뮬레이션
 * 스텝 수는 고정 틱레이트를 따른다(가변 프레임레이트로 시뮬레이션이 흔들리지
 * 않는다)."
 *
 * **레벨 분리(오케스트레이터 지시) — 이 파일은 B계층, flaky 방지가 최우선**:
 * GA-14의 then을 실시간 간격 측정만으로 검증하면 CI에서 flaky의 온상이
 * 된다. 정밀한 "평균 33.3ms 고정"·"드리프트 없음" 검증은
 * `tests/unit/sim-tick-driver.test.ts`(A계층, 결정론 — 실 타이머 없이
 * `advanceByElapsed(elapsedMs)`에 값을 직접 주입해 검증)의 책임이다. 이
 * 파일(B계층)은 그 결정론 드라이버가 실 서버 30Hz 루프에 실제로 결합돼
 * 굴러가는지만 **관대하게(±50%)** 확인한다 — 타이트한 33.3ms 단언은 절대
 * 하지 않는다. CI 러너의 스케줄링 지터(GC, 다른 프로세스와의 CPU 경합 등)는
 * 스펙 위반이 아니라 인프라 잡음이기 때문이다.
 *
 * **가정 1(coder에게 — GameState 확장)**: `GameState`에 `tick: number`
 * 필드가 추가되고, 서버의 실 30Hz 루프가 매 틱 이 필드를 갱신해
 * 브로드캐스트한다고 가정한다. 이 테스트는 그 스키마 클래스를 직접
 * 임포트하지 않는다 — `colyseus.js` 클라이언트로 접속해 상태 동기화만
 * 관측하는 블랙박스 통합 테스트(ADR-0008 "Colyseus 룸 경계")이므로, 실제
 * 구현 파일 위치·클래스 구조와 무관하게 `room.state.tick`이라는 관측
 * 지점만 가정한다. 필드명이 다르다면 이 파일의 `readTick()` 헬퍼 한 곳만
 * 조정하면 된다.
 *
 * **가정 2(coder에게 — 실 루프 위치)**: 실 시간 측정·`setInterval` 기반
 * 30Hz 구동은 `src/server`에 위치한다고 가정한다(ADR-0008: 실시간 API
 * 직접 호출 금지 lint는 `src/shared`에만 적용되고 `src/server`는 예외 —
 * 팀리드 지시).
 *
 * **결정론 메모**: 기존 RQ-02/03/04 통합 테스트와 동일하게 실 WebSocket
 * (localhost, 임의 포트)에 의존한다 — ADR-0008이 넷코드 통합 테스트에
 * 명시적으로 허용한 예외다. 모든 네트워크 대기(`listen`·`joinOrCreate`·
 * `leave`·`close`)에 `withTimeout()`으로 명시적 상한을 건다. 다만 GA-14
 * 자체가 "실제 경과 시간 대비 틱 증가량"을 검증 대상으로 요구하므로, 이
 * 파일만은 예외적으로 고정 길이의 실시간 대기(`sleep()`)를 쓴다 — 이는
 * "상태 변경 이벤트를 기다리지 않고 임의 시간을 추측해 슬립하는" 안티패턴
 * (다른 통합 테스트가 피하는 것)과는 다르다: 여기서 검증 대상 자체가
 * "실 시간 경과당 틱 증가율"이라 대안이 없고, 그래서 단언 범위를 관대하게
 * (15~45틱, 평균 30±50%) 잡아 지터를 흡수한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000

/** 서버가 첫 몇 틱을 굴릴 시간을 준다(join 직후 상태가 아직 비어 있을 수 있다). */
const SETTLE_MS = 200
/** 단조 증가 관측 창 — 30Hz 기준 이 창 안에 여러 틱이 지나가야 한다. */
const MONITOR_WINDOW_MS = 500
/** GA-14 "N틱 동안 틱 간격을 측정"의 관측 창 — 팀리드 지시대로 약 1초. */
const RATE_WINDOW_MS = 1_000
/** 30Hz 평균 ±50% — 타이트한 33.3ms 단언 대신 CI 지터를 흡수하는 관대한 하한. */
const RATE_MIN_TICKS = 15
/** 30Hz 평균 ±50% — 위와 대칭인 관대한 상한. */
const RATE_MAX_TICKS = 45

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

/** 고정 길이 실시간 대기 — GA-14가 요구하는 "실 경과 시간당 틱 증가율" 측정
 * 자체에 필요한 유일한 예외(파일 상단 "결정론 메모" 참고). 상한이 곧 대기
 * 시간이므로 이 값 자체가 hang 없는 유한 대기를 보장한다. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

/** 룸 state에서 tick 필드를 읽는다(가정 1). 아직 patch가 도착하지 않았거나
 * 필드가 없으면 undefined. */
function readTick(room: Room): number | undefined {
  const state = room.state as { tick?: unknown } | null
  return typeof state?.tick === 'number' ? state.tick : undefined
}

describe('RQ-60 서버 30Hz 고정 틱 — 실 루프 관대한 통합 검증 (GA-14 B계층)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-60/GA-14: 룸 state의 tick 필드가 시간이 지나면서 단조 증가한다(감소·역행 없음)',
    async () => {
      const room = await joinGame(newClient(server))
      const samples: number[] = []
      room.onStateChange(() => {
        const t = readTick(room)
        if (typeof t === 'number') samples.push(t)
      })

      await sleep(MONITOR_WINDOW_MS)
      await leaveRoom(room)

      // given: 서버가 정상 기동 중이므로 관측 창 안에 최소 1개 이상의 상태
      // 갱신이 있어야 한다 — 0건이면 tick 필드 자체가 없거나 갱신되지 않는
      // 것이므로 이미 실패다.
      expect(samples.length).toBeGreaterThan(0)
      for (let i = 1; i < samples.length; i += 1) {
        expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!)
      }
      // 관측 창(500ms)은 30Hz 기준 15틱에 해당하므로, 최소한 값이 한 번은
      // 증가해야 한다(시뮬레이션이 멈춰 있지 않다는 최소 증거).
      expect(samples[samples.length - 1]!).toBeGreaterThan(samples[0]!)
    },
    15_000,
  )

  it(
    'RQ-60/GA-14: ~1초 동안 tick 증가량이 30Hz 근방의 관대한 범위(15~45)에 있다 — ' +
      '부하 유무와 무관하게 고정 틱레이트를 따른다는 것의 최소 확인. 정밀한 평균 33.3ms 검증은 ' +
      '결정론 단위 테스트(tests/unit/sim-tick-driver.test.ts)가 담당한다',
    async () => {
      const room = await joinGame(newClient(server))
      await sleep(SETTLE_MS)
      const before = readTick(room)
      expect(before).toBeDefined()

      await sleep(RATE_WINDOW_MS)
      const after = readTick(room)
      expect(after).toBeDefined()

      await leaveRoom(room)

      const delta = (after ?? 0) - (before ?? 0)
      expect(delta).toBeGreaterThanOrEqual(RATE_MIN_TICKS)
      expect(delta).toBeLessThanOrEqual(RATE_MAX_TICKS)
    },
    15_000,
  )
})
