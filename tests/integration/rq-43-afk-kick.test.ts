import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { CAPACITY } from '@shared/constants'
import { AFK_TICKS } from '@shared/sim/afk'

/**
 * RQ-43 AFK 자동 퇴장 + 관전자 승격 — 서버 권위(RQ-61) 통합 테스트
 * (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-13** (`harness/evals/golden/track-a-product.jsonl`,
 * `verify` 필드가 이 파일 경로를 정확히 지정한다).
 * - given: 플레이어 A가 5분간 이동·사격·채팅 등 어떤 입력도 보내지 않았고,
 *   대기 중인 관전자가 존재.
 * - when: 5분이 경과.
 * - then: A는 자동으로 퇴장 처리되고, 대기 중이던 관전자 중 한 명이 A의
 *   슬롯으로 플레이어 전환된다.
 *
 * RQ-43 전문: "플레이어가 5분간 입력이 없으면, 시스템은 그 플레이어를
 * 자동 퇴장시켜야 한다(AFK). 퇴장 시 그 슬롯은 대기 중인 관전자에게
 * 열려야 한다."
 *
 * **레벨 분리(ADR-0008/ADR-0011)**: "경과 틱이 정확히 임계(9000틱=5분)에
 * 도달하는 순간"이라는 타이트한 경계 판정은 `tests/unit/sim-afk.test.ts`
 * (A계층, 틱 정수만 주입)가 이미 고정했다. 이 파일(B계층)은 그 판정 로직이
 * 실 `GameRoom` 30Hz 틱 루프·메시지 핸들러·`spectators`↔`players` 전환에
 * 실제로 배선돼 있는지를 실 WebSocket으로 블랙박스 확인한다 — 경계 정밀도
 * 대신 "임계를 한참 넘김 vs 아직 충분히 여유 있음"이라는 여유 있는 두
 * 극단만 다룬다(`rq-15-respawn-timer.test.ts`/`rq-18-fall-damage.test.ts`가
 * 이미 채택한 A/B 레벨 분리와 동일한 정신).
 *
 * ---
 *
 * ## 설계 쟁점 1 — 5분을 실제로 기다릴 수 없다
 *
 * `PLAYER.AFK_TIMEOUT_MS`(5분)를 실 WebSocket 대기로 검증하면 이 파일
 * 하나가 5분 넘게 걸린다 — CI 게이트 예산(ADR-0008 §7, 3분)을 이 파일
 * 혼자 넘긴다. 그래서 `rq-18-fall-damage.test.ts`가 낙하 높이를 화이트박스로
 * 주입한 것과 동일한 이유로, 이 파일은 "마지막 입력 처리 틱"을 화이트박스로
 * 직접 주입해 5분 경과 상황을 즉시 만든다(팀리드 지시 — "5분을 실제로
 * 기다리지 않는다").
 *
 * ## 설계 쟁점 2 — 화이트박스 기법(RQ-18 선례 재사용)
 *
 * `matchMaker.getLocalRoomById(roomId)`(`rq-18-fall-damage.test.ts`가 이미
 * 확립한 기법, `node_modules/@colyseus/core/build/MatchMaker.d.ts` 실측
 * 확인)로 테스트 프로세스 **안에서** 실제로 기동 중인 `GameRoom` 인스턴스를
 * 직접 얻어, 그 인스턴스의 신규 private map `lastInputAtTick`(그린필드
 * 계약, `sim-afk.test.ts` 상단 "가정" 절 참고)에 "마지막 입력 처리 틱"을
 * 직접 심는다. `src/`를 수정하는 것이 **아니다** — 같은 프로세스 안에서
 * 이미 실행 중인 서버 상태를 테스트가 조작하는 것이다.
 *
 * `GameRoom.state`(서버 권위 `GameState`, `@colyseus/core`의 `Room.state`가
 * public이라 이 접근도 신규 계약이 아니다)의 `tick`도 함께 읽어, 클라이언트
 * 패치 지연(기본 20Hz)에 흔들리지 않는 서버 권위 값을 기준으로 주입량을
 * 계산한다.
 *
 * **RQ-18과의 차이(더 단순함)**: RQ-18의 화이트박스는 "주입 후 실제 물리
 * (점프)가 그 값을 소비할 때까지" 실 WebSocket 왕복·틱 캐치업과 경합했다
 * (REV3~5가 그 경합을 순차로 해결). 이 파일의 "AFK 임계를 한참 넘김" 주입은
 * 그런 경합이 없다 — 주입 자체가 동기 프로세스 내 직접 대입이고, 그 다음
 * 어떤 실 메시지 왕복도 필요 없이 다음 실 틱(≈33ms)이 곧바로 그 값을 읽어
 * 판정한다. 유일하게 실 WS 왕복과 경합하는 것은 "입력이 타이머를 리셋하는가"
 * 테스트뿐이다(아래 "설계 쟁점 3" 참고).
 *
 * ## 설계 쟁점 3 — 입력 리셋 검증과 레이스
 *
 * "아직 임계 전" 상태를 만든 뒤 그 세션에 실제 입력 메시지를 보내 타이머가
 * 리셋되는지 확인하려면, 주입 시점에 **충분한 여유(REMAINING_TICKS_BEFORE_
 * DUE, 30틱≈1000ms)**를 남겨 둔다 — 리셋 메시지의 실 WS 왕복(로컬에서 통상
 * 수~수십 ms, CI 지터를 감안해도 이 파일의 다른 여유값(300ms대)보다 넉넉한
 * 1000ms 여유 안에 도착한다고 가정)이 그 여유를 초과하지 않는 한 "리셋
 * 전에 먼저 킥되어 버리는" 거짓 실패가 생기지 않는다.
 *
 * **양성 대조군(공허화 방지, `rq-18-fall-damage.test.ts` "양성 대조군 설계"와
 * 동일 정신)**: "리셋 후 살아있다"는 음성 단언만으로는 AFK 킥 자체가
 * 배선되지 않은 경우와 구분되지 않는다. 그래서 각 입력-리셋 케이스는 생존을
 * 확인한 직후, **같은 세션**에 이번엔 확실히 임계를 넘긴 값을 주입해 실제로
 * 킥되는 것까지 반증한다(`assertInputResetsAfkTimer` 헬퍼).
 *
 * ## 대기 술어 컨벤션(팀리드 지시 — 반드시 준수, 근거는 각 호출부에 명시)
 *
 * ① 대기 조건은 단조·안정 신호만 쓴다 — 이 파일의 모든 `waitForCondition`/
 *    `waitForLeave` 호출은 "한 번 참이 되면 이후 계속 참인" 상태(연결 종료,
 *    컬렉션 멤버십 전환)만 기다린다. 전이 중간 상태를 관측하는 대기는 없다.
 * ② 구독 시점에 술어가 거짓임이 보장돼야 한다 — 이 파일은 매번 (a) 직전
 *    동기 단언으로 시작 상태를 확인하고 (b) 그 즉시(사이에 `await`나 다른
 *    비동기 경계 없이) 리스너를 등록한 **다음에만** 화이트박스 주입(트리거)을
 *    호출한다. 주입 자체가 동기 same-process 대입이고 판정은 다음 비동기
 *    틱에서만 일어나므로, 리스너 등록 시점에는 아직 트리거조차 실행되지
 *    않은 상태다 — "구독 전에 이미 참"이 될 경로가 없다(RQ-18처럼 실 WS
 *    왕복이 끼어들 필요가 없어 이 보장이 더 직접적이다, 설계 쟁점 2 참고).
 *
 * ## 격리(팀리드 지시 — RQ-40 라운드 교훈)
 *
 * `GameRoom`은 `autoDispose=false`(GA-29 단일 룸)라 룸이 살아있는 한 세션별
 * 부기 상태가 `it()` 사이에 자연히 리셋되지 않는다. `rq-40-chat-history-
 * restore.test.ts`가 이미 겪은 문제(공유 서버 + 정확 일치 단언의 오염)와
 * 동일한 리스크를 피하기 위해, 이 파일은 (다른 통합 테스트 파일들과 달리)
 * `beforeAll`/`afterAll`이 아니라 **`beforeEach`/`afterEach`로 매 `it()`마다
 * 서버(=룸)를 새로 기동·종료**한다.
 *
 * ## 스코프 밖(팀리드 지시 — 원장 22g)
 *
 * - **정상 접속 종료(voluntary disconnect) 시 승격** — RQ-43 원문은 AFK
 *   퇴장 경로만 명시한다. 이 파일은 그 경로만 검증하고, 자발적 `room.leave()`
 *   시에도 관전자가 승격돼야 하는지는 스펙 침묵이라 다루지 않는다(질의로
 *   이월, 원장 22g).
 * - AFK 경고·카운트다운 HUD 표시 — 스펙 없음.
 *
 * ## 입력 종류(RQ-43 "이동·사격·채팅 등 어떤 입력도")
 *
 * `'move'`·`'fire'`·`'chat'`·`'reload'` 4종 전부를 개별 검증한다 — 하나라도
 * 빠지면 그 경로로 AFK가 오작동한다(팀리드 지시). 각 케이스는 살아있는
 * (사망하지 않은) 갓 접속한 플레이어가 그 메시지를 정상적으로 처리 가능한
 * 상태에서 보낸다 — "게임 로직상 거부되는 입력(예: 시신의 사격)도 수신
 * 자체로 리셋되는가"는 이 파일이 다루지 않는다(스펙·골든 미규정, `sim-afk
 * .test.ts` 상단 "가정" 절 참고 — coder의 구현 자유).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const STATE_TIMEOUT_MS = 5_000

/** AFK 킥이 실제로 처리될 때까지의 관측 상한 — 화이트박스 주입 직후 다음
 * 실 틱(≈33ms) 안에 처리될 것으로 예상하나, CI 스케줄링 지터를 넉넉히
 * 흡수한다(`rq-18-fall-damage.test.ts`의 유사 상수들과 동일한 여유 원칙). */
const KICK_OBSERVE_TIMEOUT_MS = 5_000

/** "아직 임계 도달 전" 주입 시 남겨 두는 여유 틱 — 30틱≈1000ms. 입력
 * 리셋 메시지의 실 WS 왕복(로컬에서 통상 수~수십 ms)이 이 여유 안에 항상
 * 도착한다고 가정한다(파일 상단 "설계 쟁점 3" 참고). */
const REMAINING_TICKS_BEFORE_DUE = 30

/** 리셋 입력을 보낸 뒤, 원래(리셋이 없었다면) 킥됐을 시점을 명백히 지나서까지
 * 생존을 확인하는 대기(ms) — REMAINING_TICKS_BEFORE_DUE(≈1000ms)보다
 * 넉넉히 길게 잡는다. */
const SURVIVE_AFTER_RESET_MS = 1_800

/** 화이트박스로 주입하는 "이미 한참 지남" 값의 안전 여유(틱) — 정확히
 * AFK_TICKS만큼만 빼면 경계 정밀도에 좌우될 수 있으므로(그 정밀도는
 * `sim-afk.test.ts`의 책임) 넉넉히 더 뺀다. */
const OVERDUE_SAFETY_MARGIN_TICKS = 1_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

async function joinGame(client: Client): Promise<Room> {
  return withTimeout(client.joinOrCreate(ROOM_NAME), JOIN_TIMEOUT_MS, `joinOrCreate('${ROOM_NAME}')`)
}

async function leaveRoom(room: Room): Promise<void> {
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface StateLike {
  players?: { has?: (key: string) => boolean; size?: number }
  spectators?: { has?: (key: string) => boolean; size?: number }
}

function isPlayer(room: Room, sessionId: string): boolean {
  const state = room.state as StateLike | null
  return state?.players?.has?.(sessionId) === true
}

function isSpectator(room: Room, sessionId: string): boolean {
  const state = room.state as StateLike | null
  return state?.spectators?.has?.(sessionId) === true
}

function playersCount(room: Room): number {
  const state = room.state as StateLike | null
  return state?.players?.size ?? -1
}

/** RQ-18의 `waitForPlayerCondition`과 동일한 정신을 일반화한 버전 — 특정
 * 플레이어 스냅샷이 아니라 임의의 상태 술어를 기다린다(위 "대기 술어
 * 컨벤션" ①②를 만족하도록 호출부가 구성한다). */
function waitForCondition(room: Room, predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      const tryResolve = (): void => {
        if (predicate()) resolve()
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    timeoutMs,
    label,
  )
}

/** 서버가 이 연결을 강제 종료했음을 클라이언트 쪽에서 관측한다 —
 * `room.leave()`를 이 파일이 직접 호출하지 않은 세션에서 이 이벤트가
 * 발생했다면 그것은 서버측 강제 퇴장(AFK 킥)이라는 뜻이다. */
function waitForLeave(room: Room, timeoutMs: number, label: string): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve) => {
      room.onLeave((code) => resolve(code))
    }),
    timeoutMs,
    label,
  )
}

/** 화이트박스 접근 대상 계약 — 파일 상단 "설계 쟁점 2" 참고.
 * `lastInputAtTick`은 아직 존재하지 않는 신규 필드다(Red 전제, `sim-afk
 * .test.ts` 상단 "가정" 절이 정본). `state`는 신규 계약이 아니다 —
 * `@colyseus/core`의 `Room.state`가 이미 public이다. */
interface AfkTestSeam {
  lastInputAtTick: Map<string, number>
  state: { tick: number }
}

/** `matchMaker.getLocalRoomById`(`rq-18-fall-damage.test.ts`가 이미 확립한
 * 기법)로 테스트 프로세스 안에서 실행 중인 실제 `GameRoom` 인스턴스를
 * 얻는다. 룸을 찾지 못하면(경로 오류) 이후 관측이 아니라 여기서 즉시
 * 실패해 원인을 분명히 한다. */
function getServerRoom(room: Room): AfkTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as AfkTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-43 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** 해당 세션이 AFK 임계를 이미 한참 넘겼다고 서버에 직접 주입한다 — 5분을
 * 실제로 기다리지 않는다(파일 상단 "설계 쟁점 1·2" 참고). 서버 권위
 * `state.tick`을 기준으로 계산해 클라이언트 패치 지연에 흔들리지 않는다. */
function forceImmediateAfkDue(room: Room, sessionId: string): void {
  const seam = getServerRoom(room)
  seam.lastInputAtTick.set(sessionId, seam.state.tick - AFK_TICKS - OVERDUE_SAFETY_MARGIN_TICKS)
}

/** 해당 세션의 AFK 마감까지 정확히 `remainingTicks`틱이 남은 상태로
 * 주입한다 — "곧 임계에 도달하지만 아직은 아니다"를 만들어, 그 직후 보내는
 * 입력이 타이머를 리셋하는지 확인하는 데 쓴다(설계 쟁점 3). */
function forceAfkRemaining(room: Room, sessionId: string, remainingTicks: number): void {
  const seam = getServerRoom(room)
  seam.lastInputAtTick.set(sessionId, seam.state.tick - (AFK_TICKS - remainingTicks))
}

/**
 * "아직 AFK 임계 전"인 상태를 화이트박스로 만든 뒤 `sendInput`으로 지정한
 * 종류의 메시지를 보내고, 원래(리셋이 없었다면) 킥됐을 시점을 명백히 지난
 * 뒤에도 여전히 접속 중임을 확인한다. 그 직후 양성 대조군(설계 쟁점 3)으로
 * 같은 세션에 확실히 임계를 넘긴 값을 주입해 실제로 킥되는 것까지
 * 반증한다 — 4종(move/fire/chat/reload) 공통 절차.
 */
async function assertInputResetsAfkTimer(room: Room, sendInput: () => void): Promise<void> {
  const sessionId = room.sessionId

  forceAfkRemaining(room, sessionId, REMAINING_TICKS_BEFORE_DUE)
  sendInput()
  await sleep(SURVIVE_AFTER_RESET_MS)
  expect(isPlayer(room, sessionId)).toBe(true)

  // 양성 대조군: 리스너를 먼저 등록한(대기 술어 ②) 다음에만 트리거한다.
  const kicked = waitForLeave(room, KICK_OBSERVE_TIMEOUT_MS, 'RQ-43 양성 대조군: 리셋 없이 재주입하면 실제로 AFK 킥이 발생하는지(onLeave) 대기')
  forceImmediateAfkDue(room, sessionId)
  await kicked
}

describe('RQ-43 AFK 자동 퇴장 + 관전자 승격', () => {
  let server: RunningServer

  // 팀리드 지시(원장 22g) — RQ-40 라운드 교훈과 동일한 이유로 케이스마다
  // 서버(=룸)를 새로 기동·종료한다(파일 상단 "격리" 절).
  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  it(
    `RQ-43/GA-13: 대기 중인 관전자가 있을 때, 입력 없는 플레이어는 AFK로 자동 퇴장되고 그 슬롯이 관전자에게 넘어간다`,
    async () => {
      const players: Room[] = []
      for (let i = 0; i < CAPACITY.PLAYERS; i += 1) {
        players.push(await joinGame(newClient(server)))
      }
      const afkTarget = players[0]
      const bystander = players[1]
      if (!afkTarget || !bystander) throw new Error('플레이어 정원 채우기 실패 — players가 비어 있다')

      const spectator = await joinGame(newClient(server))

      try {
        const afkTargetId = afkTarget.sessionId
        const spectatorId = spectator.sessionId

        // given: 정원이 찬 뒤 입장한 접속은 RQ-03에 따라 관전자다(그 분류
        // 판정 자체는 `rq-03-spectator-overflow.test.ts`가 전담 — 이
        // 파일은 전제로 삼아 확인만 한다).
        await waitForCondition(bystander, () => isPlayer(bystander, afkTargetId), 'AFK 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        expect(isSpectator(spectator, spectatorId)).toBe(true)
        expect(isPlayer(spectator, spectatorId)).toBe(false)

        // 대기 술어 ② — 리스너를 먼저 등록한(직전 동기 단언으로 시작 상태
        // 확인 완료) 다음에만 화이트박스 트리거를 호출한다.
        const leftPromise = waitForLeave(afkTarget, KICK_OBSERVE_TIMEOUT_MS, 'RQ-43/GA-13: AFK 대상의 서버측 강제 퇴장(onLeave) 대기')
        const promotedPromise = waitForCondition(
          spectator,
          () => isPlayer(spectator, spectatorId) && !isSpectator(spectator, spectatorId),
          'RQ-43/GA-13: 관전자 → 플레이어 승격 대기',
          KICK_OBSERVE_TIMEOUT_MS,
        )

        forceImmediateAfkDue(afkTarget, afkTargetId)

        await Promise.all([leftPromise, promotedPromise])

        // then: A(afkTarget)는 더 이상 플레이어가 아니다 — 승격된 클라이언트
        // (spectator) 자신의 관측과 제3자(bystander) 관측 양쪽으로 재확인해
        // "승격 클라이언트만의 착시"가 아님을 보인다.
        expect(isPlayer(spectator, afkTargetId)).toBe(false)
        expect(isPlayer(bystander, afkTargetId)).toBe(false)
        // 대기 중이던 관전자(spectator)가 그 슬롯으로 전환됐다.
        expect(isPlayer(spectator, spectatorId)).toBe(true)
        expect(isSpectator(spectator, spectatorId)).toBe(false)
        // 정원 유지 — 한 명 빠지고 한 명 들어왔다.
        expect(playersCount(bystander)).toBe(CAPACITY.PLAYERS)
      } finally {
        // afkTarget은 이미 서버가 강제 퇴장시켰다 — 다시 leave()를 호출하면
        // 이미 닫힌 연결이라 reject할 수 있으므로 정리 대상에서 제외한다
        // (`rq-03-spectator-cap-reject.test.ts`의 방어적 정리 패턴과 동일).
        await Promise.all([
          ...players.slice(1).map((room) => leaveRoom(room).catch(() => undefined)),
          leaveRoom(spectator).catch(() => undefined),
        ])
      }
    },
    30_000,
  )

  it(
    'RQ-43: 대기 중인 관전자가 없어도 입력 없는 플레이어는 AFK로 자동 퇴장된다(승격은 슬롯 처리일 뿐 퇴장 자체의 전제조건이 아니다)',
    async () => {
      const bystander = await joinGame(newClient(server))
      const afkTarget = await joinGame(newClient(server))
      const afkTargetId = afkTarget.sessionId
      const bystanderId = bystander.sessionId

      try {
        await waitForCondition(bystander, () => isPlayer(bystander, afkTargetId), 'AFK 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)

        const leftPromise = waitForLeave(afkTarget, KICK_OBSERVE_TIMEOUT_MS, 'RQ-43: 관전자 없이도 AFK 대상이 강제 퇴장되는지(onLeave) 대기')
        const removedPromise = waitForCondition(
          bystander,
          () => !isPlayer(bystander, afkTargetId),
          'RQ-43: 관전자 없이도 players 컬렉션에서 AFK 대상 제거 대기',
          KICK_OBSERVE_TIMEOUT_MS,
        )

        forceImmediateAfkDue(afkTarget, afkTargetId)

        await Promise.all([leftPromise, removedPromise])

        expect(isPlayer(bystander, afkTargetId)).toBe(false)
        expect(isPlayer(bystander, bystanderId)).toBe(true) // 방관자 자신은 영향받지 않는다
      } finally {
        await leaveRoom(bystander).catch(() => undefined)
      }
    },
    15_000,
  )

  it(
    "RQ-43: 'move' 입력은 AFK 타이머를 리셋한다",
    async () => {
      const room = await joinGame(newClient(server))
      try {
        await assertInputResetsAfkTimer(room, () => {
          room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
        })
      } finally {
        await leaveRoom(room).catch(() => undefined)
      }
    },
    15_000,
  )

  it(
    "RQ-43: 'fire' 입력은 AFK 타이머를 리셋한다",
    async () => {
      const room = await joinGame(newClient(server))
      try {
        await assertInputResetsAfkTimer(room, () => {
          room.send('fire', { dirX: 0, dirY: 1, dirZ: 0 }) // 항상 빗나가는 방향(수직 위) — 명중 여부는 이 테스트의 관심사가 아니다
        })
      } finally {
        await leaveRoom(room).catch(() => undefined)
      }
    },
    15_000,
  )

  it(
    "RQ-43: 'chat' 입력은 AFK 타이머를 리셋한다",
    async () => {
      const room = await joinGame(newClient(server))
      try {
        await assertInputResetsAfkTimer(room, () => {
          room.send('chat', { text: 'still here' })
        })
      } finally {
        await leaveRoom(room).catch(() => undefined)
      }
    },
    15_000,
  )

  it(
    "RQ-43: 'reload' 입력은 AFK 타이머를 리셋한다",
    async () => {
      const room = await joinGame(newClient(server))
      try {
        await assertInputResetsAfkTimer(room, () => {
          room.send('reload', {})
        })
      } finally {
        await leaveRoom(room).catch(() => undefined)
      }
    },
    15_000,
  )
})
