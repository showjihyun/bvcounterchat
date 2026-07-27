import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { CAPACITY, WEAPON } from '@shared/constants'

/**
 * RQ-41 개정(2026-07-27) — 슬롯 승격을 **사유 무관**으로 확장한 통합
 * 테스트(ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 골든 매핑 없음 — RQ-41 개정 EARS 문면 근거로 진행한다(`rq-41-chat-
 * spectator-participation.test.ts` 상단과 동일한 방식): "플레이어 슬롯이
 * 비면 사유와 무관하게(정상 퇴장·연결 끊김·AFK 자동 퇴장) 시스템은 대기
 * 중인 관전자 한 명을 플레이어로 승격시켜야 한다. 승격 순서는 대기가
 * 시작된 순서(FIFO)여야 한다."
 *
 * **파일 분리**: 기존 `rq-41-chat-spectator-participation.test.ts`는 RQ-41의
 * "채팅 참여" 절반을 다룬다 — 이 파일은 "슬롯 승격" 절반을 다룬다(같은
 * RQ, 다른 관심사, 다른 파일 — 두 파일 모두 `describe` 제목에 RQ-41을
 * 명시해 추적 가능하게 한다).
 *
 * **AFK 경로와의 관계**: `tests/integration/rq-43-afk-kick.test.ts`가 이미
 * AFK 자동 퇴장 → 승격 경로(FIFO 포함 관측은 아니었음)를 전담한다 — 이
 * 파일은 그 파일을 수정하지도, 그 경로를 다시 검증하지도 않는다(팀리드
 * 지시 — 중복 금지). 이 파일이 다루는 것은 **정상(consented) 퇴장** 경로
 * 하나뿐이다 — 이번 개정 전에는 `onLeave`가 컬렉션에서 지우기만 하고
 * `promoteWaitingSpectator()`를 부르지 않았다(원장 22g "제외" 항목,
 * `GameRoom.ts` `onLeave` 확인 완료). 그래서 아래 핵심 테스트는 **현재
 * 코드에서 반드시 Red**다.
 *
 * ## 이번 라운드가 회수하는 이월(원장 22i·22j·22k, `harness/progress.md`)
 *
 * - **22i**: `initializePlayer`가 `pendingInputs`를 정리하지 않아
 *   `respawnPlayer`(리스폰 시 지움)와 비대칭이다. `onMessage('move', ...)`
 *   (`GameRoom.ts`)는 발신자가 플레이어인지 검사하지 않고 `pendingInputs`를
 *   무조건 갱신하므로, **관전 중에 보낸 move 입력**이 그 세션의
 *   sessionId 아래 남아 있다가 승격 직후 첫 틱부터 그대로 적용될 수 있다
 *   — "승격 직후 이동 입력을 보내지 않았는데 움직이는가"를 고정한다.
 * - **22j**: `promoteWaitingSpectator`의 정원 가드(`players.size >=
 *   CAPACITY.PLAYERS`)는 유일한 호출자(`kickAfkPlayer`)가 슬롯을 먼저
 *   비우므로 정상 경로에서 도달 불가 — 방어선 자체를 검증하는 그물이
 *   없었다. 정원이 찬 상태로 직접 호출해도 승격이 일어나지 않음을
 *   화이트박스로 고정한다.
 * - **22k**: `onLeave`의 세션별 부기 정리(맵 11개)에 회귀 가드가 없다.
 *   (a) 퇴장한 세션의 키가 부기 맵 전부에서 사라지는지, (b) 승격된
 *   세션이 이전 점유자의 부기(예: 소진된 탄창)를 이어받지 않고 항상
 *   가득 찬 탄창으로 시작하는지 — 두 갈래로 고정한다.
 *
 * 22h(FIFO가 `MapSchema` 내부 구현 의존 + 무테스트)도 이 라운드에서
 * 함께 고정한다 — 팀리드가 "이번에 함께 고정하라"고 명시했다.
 *
 * ## 대기 술어 컨벤션(팀리드 지시, `rq-43-afk-kick.test.ts` 선례 그대로 준수)
 *
 * ① 대기 조건은 단조·안정 신호만 쓴다 — 이 파일의 모든 `waitForCondition`
 *    호출은 "한 번 참이 되면 이후 계속 참인" 상태(컬렉션 멤버십 전환)만
 *    기다린다. 전이 중간 상태를 관측하는 대기는 없다.
 * ② 구독 시점에 술어가 거짓임이 보장돼야 한다 — 각 호출부는 (a) 직전
 *    동기 단언으로 시작 상태를 확인하고 (b) 그 즉시(사이에 `await` 없이)
 *    리스너를 등록한 **다음에만** 트리거(퇴장 요청)를 호출한다.
 *
 * ## 자기 시야 규칙(팀리드 지시)
 *
 * 이 파일의 트리거는 AFK 파일과 달리 **서버가 강제로 끊는 것이 아니라
 * 클라이언트 자신이 `room.leave(true)`를 호출하는 정상 퇴장**이다 — 퇴장
 * *주체*(departingPlayer) 자신의 연결이 실제로 닫히므로, `leaveRoom()`이
 * 반환하는 프라미스(자기 자신의 close 완료)를 트리거 완료 신호로 쓰는
 * 것은 안전하다(그 세션에 대해 더 이상 알아낼 것이 없다 — 이미 나갔다).
 * 반면 **승격되는 관전자는 연결이 끊기지 않는다** — 슬롯만 바뀔 뿐 같은
 * 소켓이 계속 살아있으므로, 그 세션 자신의 시야로 자신의 승격을 확인하는
 * 것도 안전하다(F2 규칙이 경계하는 "연결이 끊길 수 있는 세션의 자기 시야"에
 * 해당하지 않는다). 그럼에도 이 파일은 모든 최종 단언을 **제3자
 * (bystander) 시야로도** 교차 확인한다 — "교차 클라이언트 시야 어긋남"
 * (같은 틱 브로드캐스트도 클라이언트별 프레임 도착은 독립) 방지 목적이다.
 *
 * ## 결정론(ADR-0008)
 *
 * `matchMaker.getLocalRoomById`(RQ-18·RQ-43 선례)로 테스트 프로세스 안에서
 * 실행 중인 `GameRoom` 인스턴스에 화이트박스로 접근한다. 22i(pendingInputs
 * 잔류) 케이스만 "승격 후 몇 틱이 지나도 안 움직인다"는 **부재**를
 * 실시간으로 관측해야 해서 고정 `sleep()`을 쓴다(`rq-43-afk-kick.test.ts`의
 * `SURVIVE_AFTER_RESET_MS`/`IDLE_HEARTBEAT_SURVIVE_MS`와 동일한 정신 —
 * "아무 일도 안 일어남"은 이벤트로 기다릴 수 없다). 그 외 모든 대기는
 * `withTimeout()` 상한이 있는 이벤트 구독이다. 케이스마다 서버(=룸)를
 * `beforeEach`/`afterEach`로 새로 기동·종료한다(RQ-40/43 라운드 교훈 —
 * `autoDispose=false` 상설 룸이 세션 간 부기를 자연히 리셋하지 않는다).
 *
 * ## 메시지 처리 순서 동기화(sleep 없이 "서버가 이미 처리했음"을 확인하는 기법)
 *
 * `fire`/`reload`/`move`는 처리 완료를 알리는 응답 브로드캐스트가 없다
 * (`chat`만 전원에게 echo된다, `handleChat`). 같은 WebSocket 연결로 보낸
 * 메시지는 서버에 도착 순서 그대로 처리된다(단일 TCP 연결의 순서 보장 +
 * 각 `onMessage` 핸들러가 전부 동기 함수 — `rq-40-chat-ordering.test.ts`가
 * 이미 이 순서 보장에 의존한다). 그래서 "먼저 보낸 메시지가 서버에서 이미
 * 처리됐다"를 확인하려면, 그 뒤에 `chat`을 보내고 **자기 자신의 echo**를
 * 기다리면 된다 — echo가 도착했다는 것은 그보다 먼저 같은 연결로 보낸
 * 모든 메시지의 처리가 이미 끝났다는 뜻이다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const STATE_TIMEOUT_MS = 5_000
const PROMOTION_TIMEOUT_MS = 10_000
const SYNC_TIMEOUT_MS = 5_000
/** "승격 직후 아무 입력도 안 보냈는데 움직이는가"를 관측하는 실시간
 * 간격(ms) — 30Hz 틱 기준 약 30틱. 서버 패치 지연(기본 20Hz)을 여러 번
 * 흡수하고도 남는 여유다. */
const DRIFT_OBSERVE_MS = 1_000
/** 22j 케이스(정원 가드) 교차 확인용 — 서버 권위 판정(동기, 즉시 유효) 뒤에
 * 클라 복제본이 그 값으로 수렴하는지 확인하는 여유(ms). 20Hz 패치 주기
 * (50ms)의 10배로 CI 지터를 흡수한다(평가 FAIL 수정, `_workspace/RQ-41/
 * 05_test-writer_capacity-fix.md` §1 참고 — 서버 권위 읽기가 판정
 * 근거이고 이 대기는 그 결과가 클라에도 어긋나지 않는지 보는 부가
 * 확인이다). */
const POST_MUTATION_SETTLE_MS = 500

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

async function joinGame(server: RunningServer, nickname: string): Promise<Room> {
  return withTimeout(
    newClient(server).joinOrCreate(ROOM_NAME, { nickname }),
    JOIN_TIMEOUT_MS,
    `joinOrCreate('${ROOM_NAME}', { nickname: '${nickname}' })`,
  )
}

async function leaveRoom(room: Room): Promise<void> {
  // consented=true — 정상 접속 종료(비정상 단절이 아니다). 이 함수가
  // 반환하는 프라미스는 이 세션 **자신의** close 완료를 뜻한다 — 파일
  // 상단 "자기 시야 규칙" 참고, 퇴장 주체 자신에 대해서는 안전한 신호다.
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

/** 정원(`CAPACITY.PLAYERS`)만큼 순차 접속시켜 players를 채운다. 순차로
 * 하는 이유(rq-03/rq-43 선례와 동일): 동시 접속 경합에 판정 로직을
 * 노출시키지 않기 위함 — 이 파일의 관심사는 승격이지 입장 경합이 아니다. */
async function fillPlayers(server: RunningServer, namePrefix: string): Promise<Room[]> {
  const rooms: Room[] = []
  for (let i = 0; i < CAPACITY.PLAYERS; i += 1) {
    rooms.push(await joinGame(server, `${namePrefix}-${i}`))
  }
  return rooms
}

interface PlayerLike {
  x?: number
  z?: number
  nickname?: string
  lastProcessedInputSeq?: number
}
interface MembershipLike<T> {
  get?: (key: string) => T | undefined
  has?: (key: string) => boolean
  size?: number
}
interface RoomStateLike {
  players?: MembershipLike<PlayerLike>
  spectators?: MembershipLike<{ nickname?: string }>
}

function isPlayer(room: Room, sessionId: string): boolean {
  const state = room.state as RoomStateLike | null
  return state?.players?.has?.(sessionId) === true
}

function isSpectator(room: Room, sessionId: string): boolean {
  const state = room.state as RoomStateLike | null
  return state?.spectators?.has?.(sessionId) === true
}

function playersCount(room: Room): number {
  const state = room.state as RoomStateLike | null
  return state?.players?.size ?? -1
}

function spectatorsCount(room: Room): number {
  const state = room.state as RoomStateLike | null
  return state?.spectators?.size ?? -1
}

/** 22i 드리프트 관측용 — 승격된 세션의 현재 x/z를 제3자(bystander) 시야로
 * 읽는다. 존재하지 않으면(아직 승격 전 등) `undefined`. */
function readPlayerXZ(room: Room, sessionId: string): { x: number; z: number } | undefined {
  const state = room.state as RoomStateLike | null
  const player = state?.players?.get?.(sessionId)
  if (!player || typeof player.x !== 'number' || typeof player.z !== 'number') return undefined
  return { x: player.x, z: player.z }
}

/** 리뷰 blocker 회귀 가드(pendingSeqs 보존, `_workspace/RQ-41/
 * 07_coder_seq-fix.md`) 관측용 — 지정한 sessionId의 `lastProcessedInputSeq`
 * 를 클라 복제본(`room.state`)에서 읽는다. 아직 `players`에 없거나(관전
 * 중) 필드가 스키마 타입이 아니면(패치 미도착) `undefined` — 호출부는
 * `waitForCondition`으로 이 값이 기대 seq에 도달할 때까지 기다린다(대기
 * 술어 컨벤션 ①: 한 번 도달하면 이후 계속 유지되는 단조 신호 — 이
 * 테스트는 승격 후 추가 `move`를 보내지 않으므로 값이 다시 바뀌지 않는다). */
function readLastProcessedInputSeq(room: Room, sessionId: string): number | undefined {
  const state = room.state as RoomStateLike | null
  const player = state?.players?.get?.(sessionId)
  return typeof player?.lastProcessedInputSeq === 'number' ? player.lastProcessedInputSeq : undefined
}

/** RQ-18/43 선례와 동일한 일반화된 상태 술어 대기 — 대기 술어 컨벤션 ①②를
 * 만족하도록 호출부가 구성한다. */
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

/** `joinOrCreate()` resolve 직후에도 `room.state`가 아직 `undefined`일 수
 * 있다(rq-43 REV 선례) — 자기 소속을 동기 `expect()`하기 전에 항상 이
 * 함수로 최초 동기화를 기다린다. */
function waitForOwnMembership(room: Room, timeoutMs: number): Promise<'players' | 'spectators'> {
  return withTimeout(
    new Promise<'players' | 'spectators'>((resolve) => {
      const tryResolve = (): void => {
        if (isPlayer(room, room.sessionId)) {
          resolve('players')
          return
        }
        if (isSpectator(room, room.sessionId)) {
          resolve('spectators')
        }
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    timeoutMs,
    `sessionId=${room.sessionId} 소속 컬렉션(players/spectators) 최초 동기화 대기`,
  )
}

interface ChatEcho {
  nickname: string
  text: string
}

/** 메시지 처리 순서 동기화(파일 상단 "메시지 처리 순서 동기화" 절 참고) —
 * `text`와 정확히 일치하는 자기 자신의 chat echo를 기다린다. 이 프라미스가
 * resolve됐다는 것은 같은 연결로 그보다 먼저 보낸 모든 메시지가 이미 서버에서
 * 처리 완료됐다는 뜻이다. */
function waitForOwnChatEcho(room: Room, text: string, timeoutMs: number, label: string): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      room.onMessage<ChatEcho>('chat', (message) => {
        if (message.text === text) resolve()
      })
    }),
    timeoutMs,
    label,
  )
}

/** 화이트박스 상태 컬렉션 최소 계약 — `MapSchema`가 만족한다. `size`·
 * `has()` 둘 다 이미 `room.state.players`/`spectators`(클라 복제본)에서도
 * 쓰던 것과 동일한 모양이지만, 여기서는 **서버 권위** 인스턴스(`seam.state`)
 * 쪽에 붙인다 — 평가 FAIL 수정(아래 `state` 필드 docblock) 참고. */
interface StateCollectionSeam {
  size: number
  has(key: string): boolean
}

/** 화이트박스 접근 대상 계약(`rq-18-fall-damage.test.ts`/`rq-43-afk-
 * kick.test.ts` 선례와 동일한 `as unknown as` 캐스팅 결합 — `tsc`가
 * 대조하지 않는다). 전부 신규 계약이 아니다 — `GameRoom.ts`에 이미 이
 * 이름으로 존재한다(확인 완료). `promoteWaitingSpectator`는 현재 private —
 * 22j(정원 가드)를 실 호출자(`kickAfkPlayer`) 경로 없이 직접 검증하기
 * 위한 접근이다.
 *
 * **평가 FAIL 수정(2026-07-27, `_workspace/RQ-41/04_evaluator_report.md`
 * §7)으로 `state` 추가**: `@colyseus/core`의 `Room.state`가 이미 public이라
 * 신규 계약이 아니다(`rq-43-afk-kick.test.ts`의 `AfkTestSeam.state`가 이미
 * 같은 방식으로 노출한다). 22j 케이스가 `promoteWaitingSpectator()`를
 * **동기** 직접 호출한 직후 곧바로 값을 읽는데, 그 직후 읽어야 할 대상은
 * **서버 권위 상태**(`seam.state`)이지 클라이언트 복제본
 * (`bystander.state`, `playersCount`/`isSpectator` 등이 읽는 곳)이 아니다
 * — 복제본은 20Hz 패치로 나중에 갱신되므로 동기 호출 직후 읽으면 항상
 * 변경 이전 값을 돌려준다(평가자 프로브로 실증됨, 변이 M5에서 정원 가드를
 * 지워도 공허하게 통과한 원인). */
interface PromotionTestSeam {
  moveStates: Map<string, unknown>
  pendingInputs: Map<string, unknown>
  pendingSeqs: Map<string, number>
  lastFireAtMs: Map<string, number>
  diedAtTick: Map<string, number>
  spawnedAtTick: Map<string, number>
  firedSinceSpawn: Map<string, boolean>
  magazines: Map<string, number>
  reloadStartedAtTick: Map<string, number>
  fallPeakY: Map<string, number>
  lastInputAtTick: Map<string, number>
  state: { players: StateCollectionSeam; spectators: StateCollectionSeam }
  promoteWaitingSpectator(): void
}

function getServerRoom(room: Room): PromotionTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as PromotionTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-41 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** 부기 맵 전부에 해당 sessionId 키가 없음을 목록 하나로 단언한다(22k,
 * "앞으로 추가되는 맵도 같은 그물에 들어오도록"). */
function expectNoResidualBookkeeping(seam: PromotionTestSeam, sessionId: string): void {
  const maps: Array<[string, Map<string, unknown>]> = [
    ['moveStates', seam.moveStates],
    ['pendingInputs', seam.pendingInputs],
    ['pendingSeqs', seam.pendingSeqs],
    ['lastFireAtMs', seam.lastFireAtMs],
    ['diedAtTick', seam.diedAtTick],
    ['spawnedAtTick', seam.spawnedAtTick],
    ['firedSinceSpawn', seam.firedSinceSpawn],
    ['magazines', seam.magazines],
    ['reloadStartedAtTick', seam.reloadStartedAtTick],
    ['fallPeakY', seam.fallPeakY],
    ['lastInputAtTick', seam.lastInputAtTick],
  ]
  for (const [name, map] of maps) {
    expect(map.has(sessionId), `부기 맵 '${name}'에 퇴장한 세션(${sessionId})의 잔여 항목이 남아있으면 안 된다`).toBe(false)
  }
}

describe('RQ-41 슬롯 승격(사유 무관) — 정상 퇴장 경로', () => {
  let server: RunningServer

  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  it(
    'RQ-41: 대기 중인 관전자가 있을 때, 플레이어가 정상 퇴장(consented leave)하면 그 슬롯으로 관전자 한 명이 승격된다',
    async () => {
      const players = await fillPlayers(server, 'filler')
      const departing = players[0]
      const bystander = players[1]
      if (!departing || !bystander) throw new Error('플레이어 정원 채우기 실패 — players가 비어 있다')

      const spectator = await joinGame(server, 'spectator-1')
      const departingId = departing.sessionId
      const spectatorId = spectator.sessionId

      try {
        // given: 대상들의 최초 소속을 확인한다(대기 술어 ②의 전제).
        await waitForCondition(bystander, () => isPlayer(bystander, departingId), '퇴장 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        const spectatorMembership = await waitForOwnMembership(spectator, STATE_TIMEOUT_MS)
        expect(spectatorMembership).toBe('spectators')
        expect(isSpectator(spectator, spectatorId)).toBe(true)
        expect(isPlayer(spectator, spectatorId)).toBe(false)

        // 대기 술어 ② — 리스너를 먼저 등록한(직전 동기 단언으로 시작
        // 상태 확인 완료) 다음에만 트리거(정상 퇴장)를 호출한다. 승격되는
        // spectator 자신의 연결은 끊기지 않으므로 그 자신의 시야도
        // 안전하다(파일 상단 "자기 시야 규칙") — 그래도 제3자(bystander)
        // 시야로 교차 확인한다.
        const spectatorSeesOwnPromotion = waitForCondition(
          spectator,
          () => isPlayer(spectator, spectatorId) && !isSpectator(spectator, spectatorId),
          'RQ-41: 관전자(spectator) 자신의 시야에서 승격 반영 대기',
          PROMOTION_TIMEOUT_MS,
        )
        const bystanderSeesFinalState = waitForCondition(
          bystander,
          () => !isPlayer(bystander, departingId) && isPlayer(bystander, spectatorId) && !isSpectator(bystander, spectatorId),
          'RQ-41: 제3자(bystander) 시야에서 퇴장 대상 제거 + 관전자 승격 모두 반영 대기',
          PROMOTION_TIMEOUT_MS,
        )

        // when: 대상이 정상 퇴장한다. 이 프라미스는 departing 자신의 close
        // 완료를 뜻한다(파일 상단 "자기 시야 규칙" — 퇴장 주체에게는 안전).
        const departed = leaveRoom(departing)

        await Promise.all([departed, spectatorSeesOwnPromotion, bystanderSeesFinalState])

        // then: 제3자 시야로 재확인 — "승격 클라이언트만의 착시"가 아니다.
        expect(isPlayer(bystander, departingId)).toBe(false)
        expect(isPlayer(bystander, spectatorId)).toBe(true)
        expect(isSpectator(bystander, spectatorId)).toBe(false)
        // 정원 유지 — 한 명 빠지고 한 명 들어왔다.
        expect(playersCount(bystander)).toBe(CAPACITY.PLAYERS)
        expect(spectatorsCount(bystander)).toBe(0)
      } finally {
        // departing은 이미 스스로 나갔다 — 다시 leave()를 부르면 이미
        // 닫힌 연결이라 reject할 수 있어 정리 대상에서 제외한다
        // (`rq-03-spectator-cap-reject.test.ts` 선례).
        await Promise.all([
          ...players.slice(1).map((room) => leaveRoom(room).catch(() => undefined)),
          leaveRoom(spectator).catch(() => undefined),
        ])
      }
    },
    30_000,
  )

  it(
    'RQ-41: 대기 중인 관전자가 없어도 정상 퇴장은 예외 없이 처리된다(퇴장 자체는 승격의 전제조건이 아니다)',
    async () => {
      const bystander = await joinGame(server, 'bystander')
      const departing = await joinGame(server, 'departing')
      const departingId = departing.sessionId
      const bystanderId = bystander.sessionId

      try {
        await waitForCondition(bystander, () => isPlayer(bystander, departingId), '퇴장 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)

        const removedPromise = waitForCondition(
          bystander,
          () => !isPlayer(bystander, departingId),
          'RQ-41: 관전자 없이도 players 컬렉션에서 퇴장 대상 제거 대기',
          STATE_TIMEOUT_MS,
        )

        await Promise.all([leaveRoom(departing), removedPromise])

        expect(isPlayer(bystander, departingId)).toBe(false)
        expect(isPlayer(bystander, bystanderId)).toBe(true) // 방관자 자신은 영향받지 않는다
        expect(playersCount(bystander)).toBe(1)
        expect(spectatorsCount(bystander)).toBe(0)
      } finally {
        await leaveRoom(bystander).catch(() => undefined)
      }
    },
    15_000,
  )

  it(
    'RQ-41 FIFO(원장 22h 회수): 관전자가 2명 이상 대기 중이면 먼저 접속한 관전자가 승격되고, 나중에 접속한 관전자는 계속 대기한다',
    async () => {
      const players = await fillPlayers(server, 'fifo-filler')
      const departing = players[0]
      const bystander = players[1]
      if (!departing || !bystander) throw new Error('플레이어 정원 채우기 실패 — players가 비어 있다')

      // given: spectator1을 먼저 접속·최초 동기화까지 완전히 기다린 뒤에만
      // spectator2를 접속시킨다 — 서버 도착 순서(FIFO 판정 기준)가 시험
      // 코드 자체의 접속 순서와 정확히 일치하도록 보장한다.
      const spectator1 = await joinGame(server, 'fifo-spec-1')
      const spectator1Membership = await waitForOwnMembership(spectator1, STATE_TIMEOUT_MS)
      expect(spectator1Membership).toBe('spectators')

      const spectator2 = await joinGame(server, 'fifo-spec-2')
      const spectator2Membership = await waitForOwnMembership(spectator2, STATE_TIMEOUT_MS)
      expect(spectator2Membership).toBe('spectators')

      const departingId = departing.sessionId
      const spectator1Id = spectator1.sessionId
      const spectator2Id = spectator2.sessionId

      try {
        await waitForCondition(bystander, () => isPlayer(bystander, departingId), '퇴장 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        await waitForCondition(
          bystander,
          () => spectatorsCount(bystander) === 2,
          '관전자 2명 최초 상태(spectators 전원 반영) 확인',
          STATE_TIMEOUT_MS,
        )

        // 대기 술어 ② — 리스너를 먼저 등록한 다음에만 트리거를 호출한다.
        const bystanderSeesFinalState = waitForCondition(
          bystander,
          () =>
            !isPlayer(bystander, departingId) &&
            isPlayer(bystander, spectator1Id) &&
            isSpectator(bystander, spectator2Id) &&
            !isPlayer(bystander, spectator2Id),
          'RQ-41 FIFO: 제3자(bystander) 시야에서 spectator1 승격 + spectator2 대기 유지 모두 반영 대기',
          PROMOTION_TIMEOUT_MS,
        )
        const spectator1SeesOwnPromotion = waitForCondition(
          spectator1,
          () => isPlayer(spectator1, spectator1Id),
          'RQ-41 FIFO: spectator1 자신의 시야에서 승격 반영 대기',
          PROMOTION_TIMEOUT_MS,
        )

        await Promise.all([leaveRoom(departing), bystanderSeesFinalState, spectator1SeesOwnPromotion])

        // then: 먼저 기다린 spectator1이 승격되고, spectator2는 여전히 대기.
        expect(isPlayer(bystander, spectator1Id)).toBe(true)
        expect(isSpectator(bystander, spectator1Id)).toBe(false)
        expect(isSpectator(bystander, spectator2Id)).toBe(true)
        expect(isPlayer(bystander, spectator2Id)).toBe(false)
        expect(spectatorsCount(bystander)).toBe(1)
      } finally {
        await Promise.all([
          ...players.slice(1).map((room) => leaveRoom(room).catch(() => undefined)),
          leaveRoom(spectator1).catch(() => undefined),
          leaveRoom(spectator2).catch(() => undefined),
        ])
      }
    },
    30_000,
  )

  it(
    'RQ-41 정원 가드(원장 22j 회수): players가 이미 정원(CAPACITY.PLAYERS)을 채운 상태에서 promoteWaitingSpectator()를 직접 호출해도 승격이 일어나지 않는다',
    async () => {
      const players = await fillPlayers(server, 'cap-filler')
      const bystander = players[0]
      if (!bystander) throw new Error('플레이어 정원 채우기 실패 — players가 비어 있다')

      const spectator = await joinGame(server, 'cap-spectator')
      const spectatorId = spectator.sessionId

      try {
        await waitForCondition(
          bystander,
          () => playersCount(bystander) === CAPACITY.PLAYERS,
          '플레이어 정원 최초 상태 확인',
          STATE_TIMEOUT_MS,
        )
        const spectatorMembership = await waitForOwnMembership(spectator, STATE_TIMEOUT_MS)
        expect(spectatorMembership).toBe('spectators')

        // 화이트박스 직접 호출 — 유일한 실 호출자(`kickAfkPlayer`)는 항상
        // 슬롯을 먼저 비운 뒤에만 부르므로, 정원이 찬 채로 이 메서드가
        // 불리는 경로는 정상 흐름에는 없다(도달 불가 방어선, 22j).
        //
        // **평가 FAIL 수정(`_workspace/RQ-41/04_evaluator_report.md`
        // §7)**: 이 메서드는 완전히 동기이므로 호출 직후 곧바로 읽어도
        // 안전하다는 전제 자체는 맞지만, 이전 버전은 **읽는 대상을
        // 잘못 골랐다** — `playersCount(bystander)` 등은 `bystander.state`
        // (클라 **복제본**)를 읽는데, 서버 상태 변경은 20Hz 패치로
        // 나중에 도착한다. 조작이 서버 상태를 직접(동기로) 건드렸으니
        // 판정도 같은 층 — `seam.state`(서버 권위) — 에서 읽어야
        // "네트워크 왕복 없이 안전하다"는 전제가 실제로 성립한다.
        const seam = getServerRoom(bystander)
        seam.promoteWaitingSpectator()

        // 판정 근거 — 서버 권위 상태(동기 직후 즉시 유효, `PromotionTestSeam
        // .state` docblock 참고).
        expect(seam.state.players.size).toBe(CAPACITY.PLAYERS) // 늘지 않았다
        expect(seam.state.spectators.size).toBe(1) // 소진되지 않았다
        expect(seam.state.spectators.has(spectatorId)).toBe(true)
        expect(seam.state.players.has(spectatorId)).toBe(false)

        // 교차 확인(강화, 대체 아님) — 클라 복제본도 결국 이 값에
        // 수렴하는지 실시간으로 확인한다. 서버가 실제로 승격했다면(가드가
        // 없다면) 이 대기 이후 클라도 그 변경을 반영해 아래 값이 달라진다
        // — "동기 직후 즉시 읽기"의 함정(공허화 원인, §7)을 피하려고
        // 여기서는 짧게 실시간을 기다린 뒤에만 클라 시야를 읽는다.
        await sleep(POST_MUTATION_SETTLE_MS)
        expect(playersCount(bystander)).toBe(CAPACITY.PLAYERS)
        expect(spectatorsCount(bystander)).toBe(1)
        expect(isSpectator(bystander, spectatorId)).toBe(true)
        expect(isPlayer(bystander, spectatorId)).toBe(false)
      } finally {
        await Promise.all([
          ...players.slice(1).map((room) => leaveRoom(room).catch(() => undefined)),
          leaveRoom(bystander).catch(() => undefined),
          leaveRoom(spectator).catch(() => undefined),
        ])
      }
    },
    30_000,
  )

  it(
    'RQ-41 회귀 가드(원장 22i 회수): 관전 중에 보낸 잔여 move 입력은 승격 직후 적용되지 않는다(승격 후 입력을 보내지 않은 세션은 움직이지 않는다)',
    async () => {
      const players = await fillPlayers(server, 'drift-filler')
      const departing = players[0]
      const bystander = players[1]
      if (!departing || !bystander) throw new Error('플레이어 정원 채우기 실패 — players가 비어 있다')

      const spectator = await joinGame(server, 'drift-spectator')
      const departingId = departing.sessionId
      const spectatorId = spectator.sessionId

      try {
        await waitForCondition(bystander, () => isPlayer(bystander, departingId), '퇴장 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        const spectatorMembership = await waitForOwnMembership(spectator, STATE_TIMEOUT_MS)
        expect(spectatorMembership).toBe('spectators')

        // given: 관전 중인 spectator가 실제 방향 성분이 있는 move 입력을
        // 보낸다 — `onMessage('move', ...)`가 발신자의 플레이어 여부를
        // 검사하지 않으므로(`GameRoom.ts`) `pendingInputs`에 그대로
        // 기록된다(22i가 지목한 비대칭). 그 뒤 chat 동기화 마커로 이
        // move가 서버에서 이미 처리됐음을 확인한다(파일 상단 "메시지
        // 처리 순서 동기화" 절).
        spectator.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: 1 })
        const syncMarker = 'rq-41-22i-sync-marker'
        await Promise.all([
          waitForOwnChatEcho(spectator, syncMarker, SYNC_TIMEOUT_MS, 'RQ-41 22i: 잔여 move 입력의 서버 처리 완료 동기화(chat echo) 대기'),
          (async () => {
            spectator.send('chat', { text: syncMarker })
          })(),
        ])

        // 대기 술어 ② — 리스너를 먼저 등록한 다음에만 트리거(정상 퇴장)를
        // 호출한다.
        const bystanderSeesPromotion = waitForCondition(
          bystander,
          () => !isPlayer(bystander, departingId) && isPlayer(bystander, spectatorId) && !isSpectator(bystander, spectatorId),
          'RQ-41 22i: 제3자(bystander) 시야에서 승격 반영 대기',
          PROMOTION_TIMEOUT_MS,
        )

        await Promise.all([leaveRoom(departing), bystanderSeesPromotion])

        // then: 승격 직후 이 세션은 move를 다시 보내지 않았다(위 1회뿐).
        // 잔여 입력이 적용되지 않는다면 첫 관측(x1)과 여유(DRIFT_OBSERVE_MS)
        // 이후 관측(x2)이 같아야 한다 — 잔여 입력이 매 틱 계속 적용되는
        // 결함이 있다면 그 사이 계속 움직여 달라진다("아무 일도 안
        // 일어남"은 이벤트로 기다릴 수 없어 고정 sleep을 쓴다, 파일 상단
        // "결정론" 절 참고).
        const p1 = readPlayerXZ(bystander, spectatorId)
        expect(p1, 'RQ-41 22i: 승격 직후 제3자 시야에서 위치를 읽을 수 있어야 한다').toBeDefined()

        await sleep(DRIFT_OBSERVE_MS)

        const p2 = readPlayerXZ(bystander, spectatorId)
        expect(p2, 'RQ-41 22i: 대기 후에도 제3자 시야에서 위치를 읽을 수 있어야 한다').toBeDefined()
        expect(p2).toEqual(p1)
      } finally {
        await Promise.all([
          ...players.slice(1).map((room) => leaveRoom(room).catch(() => undefined)),
          leaveRoom(spectator).catch(() => undefined),
        ])
      }
    },
    30_000,
  )

  it(
    'RQ-41 회귀 가드(원장 22k 회수 (a)): 정상 퇴장 후 부기 맵 전부에서 퇴장한 세션의 키가 사라진다',
    async () => {
      const bystander = await joinGame(server, 'cleanup-bystander')
      const departing = await joinGame(server, 'cleanup-departing')
      const departingId = departing.sessionId

      try {
        await waitForCondition(bystander, () => isPlayer(bystander, departingId), '퇴장 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)

        // given: 여러 부기 맵에 실제 항목을 채운다 — move(pendingInputs·
        // pendingSeqs)·fire(lastFireAtMs·magazines)·reload
        // (reloadStartedAtTick). moveStates·spawnedAtTick·firedSinceSpawn·
        // lastInputAtTick은 onJoin(initializePlayer)이 이미 채워둔다.
        // diedAtTick·fallPeakY는 실제로 죽거나 공중에 뜨는 물리 절차 없이
        // 화이트박스로 직접 채운다(이 테스트의 관심사는 사인·낙하 판정이
        // 아니라 onLeave 정리 자체다).
        const seam = getServerRoom(bystander)
        seam.diedAtTick.set(departingId, 1)
        seam.fallPeakY.set(departingId, 5)

        departing.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: 1 })
        departing.send('fire', { dirX: 0, dirY: 1, dirZ: 0 }) // 수직 위 — 명중 여부 무관, lastFireAtMs·magazines만 관심사
        departing.send('reload', {})

        const syncMarker = 'rq-41-22k-sync-marker'
        await Promise.all([
          waitForOwnChatEcho(departing, syncMarker, SYNC_TIMEOUT_MS, 'RQ-41 22k: move/fire/reload의 서버 처리 완료 동기화(chat echo) 대기'),
          (async () => {
            departing.send('chat', { text: syncMarker })
          })(),
        ])

        // 위 세 메시지가 실제로 부기를 채웠는지 사전 확인(정리 검증이
        // 무의미해지지 않도록 — 애초에 없던 키라면 삭제 여부를 검증한
        // 것이 아니다).
        expect(seam.pendingInputs.has(departingId)).toBe(true)
        expect(seam.pendingSeqs.has(departingId)).toBe(true)
        expect(seam.lastFireAtMs.has(departingId)).toBe(true)
        expect(seam.reloadStartedAtTick.has(departingId)).toBe(true)
        expect(seam.moveStates.has(departingId)).toBe(true)
        expect(seam.spawnedAtTick.has(departingId)).toBe(true)
        expect(seam.firedSinceSpawn.has(departingId)).toBe(true)
        expect(seam.lastInputAtTick.has(departingId)).toBe(true)
        expect(seam.magazines.has(departingId)).toBe(true)
        expect(seam.diedAtTick.has(departingId)).toBe(true)
        expect(seam.fallPeakY.has(departingId)).toBe(true)

        const removedPromise = waitForCondition(
          bystander,
          () => !isPlayer(bystander, departingId),
          'RQ-41 22k: players 컬렉션에서 퇴장 대상 제거 대기',
          STATE_TIMEOUT_MS,
        )

        await Promise.all([leaveRoom(departing), removedPromise])

        // then: 부기 맵 전부에서 사라졌다(목록 하나로 단언 — 22k 지시).
        expectNoResidualBookkeeping(seam, departingId)
      } finally {
        await leaveRoom(bystander).catch(() => undefined)
      }
    },
    15_000,
  )

  it(
    'RQ-41 회귀 가드(원장 22k 회수 (b)): 승격된 세션은 이전 점유자가 탄창을 소진한 채 나갔어도 이어받지 않고 항상 가득 찬 탄창(WEAPON.MAGAZINE)으로 시작한다',
    async () => {
      const players = await fillPlayers(server, 'ammo-filler')
      const departing = players[0]
      const bystander = players[1]
      if (!departing || !bystander) throw new Error('플레이어 정원 채우기 실패 — players가 비어 있다')

      const spectator = await joinGame(server, 'ammo-spectator')
      const departingId = departing.sessionId
      const spectatorId = spectator.sessionId

      try {
        await waitForCondition(bystander, () => isPlayer(bystander, departingId), '퇴장 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        const spectatorMembership = await waitForOwnMembership(spectator, STATE_TIMEOUT_MS)
        expect(spectatorMembership).toBe('spectators')

        // given: 이전 점유자(departing)가 탄약을 소진한 채로 퇴장한다 —
        // 화이트박스로 직접 0을 심는다(실 연사로 소진시키려면
        // ADR-0005 rate-limit(150ms)만큼 실시간이 들어 불필요하게
        // 느려진다 — 이 테스트의 관심사는 소진 절차가 아니라 그 값이
        // 승격자에게 새어나가지 않는지다).
        const seam = getServerRoom(bystander)
        seam.magazines.set(departingId, 0)

        const spectatorSeesOwnPromotion = waitForCondition(
          spectator,
          () => isPlayer(spectator, spectatorId) && !isSpectator(spectator, spectatorId),
          'RQ-41 22k: 관전자 자신의 시야에서 승격 반영 대기',
          PROMOTION_TIMEOUT_MS,
        )
        const bystanderSeesFinalState = waitForCondition(
          bystander,
          () => !isPlayer(bystander, departingId) && isPlayer(bystander, spectatorId),
          'RQ-41 22k: 제3자(bystander) 시야에서 퇴장 대상 제거 + 관전자 승격 모두 반영 대기',
          PROMOTION_TIMEOUT_MS,
        )

        await Promise.all([leaveRoom(departing), spectatorSeesOwnPromotion, bystanderSeesFinalState])

        // then: 승격된 세션(spectatorId)은 이전 점유자(departingId)의
        // 소진된 탄창을 이어받지 않는다 — 항상 WEAPON.MAGAZINE으로 시작.
        expect(seam.magazines.get(spectatorId)).toBe(WEAPON.MAGAZINE)
        // 이전 점유자의 키 자체도 남아있지 않다(22k (a)와 동일 원칙).
        expect(seam.magazines.has(departingId)).toBe(false)
      } finally {
        await Promise.all([
          ...players.slice(1).map((room) => leaveRoom(room).catch(() => undefined)),
          leaveRoom(spectator).catch(() => undefined),
        ])
      }
    },
    30_000,
  )

  /**
   * 리뷰 blocker 회귀 가드(원장 grep 없음 — 리뷰가 지적한 "그물 0건",
   * `_workspace/review/feat-RQ-41-slot-promotion.md`) — `initializePlayer`가
   * `pendingSeqs`까지 지우는 회귀(수정 커밋 `6a67f5c`가 되돌림)를 고정한다.
   *
   * **배경**: 22i 수정 당시 `pendingInputs`와 `pendingSeqs`를 **둘 다**
   * 지웠는데, 후자가 틀렸다 — `pendingSeqs`는 실 `move` 페이로드의 seq만
   * 기록하고(합성값이 아니다), 실 클라이언트는 관전 중에도 `move`를 계속
   * 보내 그 세션의 연결 단위 seq 카운터를 올린다. 승격 시 이걸 지우면
   * 승격 직후 첫 스냅샷의 `lastProcessedInputSeq`가 스키마 기본값 0으로
   * 나가는데, 클라 예측 버퍼는(관전 중 `reconcile`이 불리지 않아) seq가
   * 쌓인 채로 남아있어 "0보다 큰 건 전부 미확인"으로 해석해 관전 중 쌓인
   * 입력 전량을 재생한다(ADR-0003 "클라는 미확인 입력만 재생한다" 위반).
   * `6a67f5c`가 `this.pendingSeqs.delete(sessionId)` 한 줄을 제거해
   * 고쳤다 — 이 케이스가 그 동작을 관측하는 첫 그물이다.
   *
   * **관측 지점(팀리드 지시 — 이번 라운드에서 층 선택 실수로 FAIL이
   * 한 번 났다, `_workspace/RQ-41/05_test-writer_capacity-fix.md` 참고)**:
   * 이 값(`lastProcessedInputSeq`)은 **스키마 필드**라 서버 권위 상태가
   * 곧바로가 아니라 **다음 실 틱**(`stepPlayerMovement`)에서만 갱신되고,
   * 그 갱신이 클라 복제본에 보이려면 그 뒤 20Hz 패치까지 기다려야 한다
   * — 동기 화이트박스 조작(22j)과는 다른 층이다. 그래서 최종 단언은
   * 클라 복제본을 `waitForCondition`(패치 도착을 실제로 기다리는 구독형
   * 대기)으로 읽는다. 그 전에 "서버가 마지막 move까지 이미 처리했다"는
   * 것만은 화이트박스로 즉시(동기) 확인한다 — `seam.pendingSeqs`는 순수
   * 서버 부기 맵이라 동기 읽기가 그 자체로 안전하다(22j처럼 클라
   * 복제본과 혼동할 여지가 없다 — 애초에 클라로 전파되는 필드가 아니다).
   *
   * **대기 술어 컨벤션**: ① `readLastProcessedInputSeq`가 도달할 값은
   * 이 테스트가 승격 후 추가 `move`를 보내지 않으므로 한 번 도달하면
   * 계속 유지되는 단조 신호다. ② 리스너 등록 직전에 `spectatorMembership`
   * 을 동기 확인했고(관전자 상태), 그 뒤로 트리거(퇴장) 전까지 승격을
   * 유발할 이벤트가 전혀 없었다 — 구독 시점에 술어가 거짓임이 보장된다.
   * **자기 시야**: 승격되는 `spectator`는 연결이 끊기지 않으므로 자기
   * 시야 사용이 안전하다(파일 상단 "자기 시야 규칙") — 그래도 제3자
   * (bystander) 시야로 교차 확인한다.
   */
  it(
    'RQ-41 회귀 가드(리뷰 blocker — pendingSeqs 보존): 승격 직후 첫 스냅샷의 lastProcessedInputSeq는 관전 중 마지막으로 보낸 seq를 반영한다(0으로 후퇴하지 않는다)',
    async () => {
      const players = await fillPlayers(server, 'seq-filler')
      const departing = players[0]
      const bystander = players[1]
      if (!departing || !bystander) throw new Error('플레이어 정원 채우기 실패 — players가 비어 있다')

      const spectator = await joinGame(server, 'seq-spectator')
      const departingId = departing.sessionId
      const spectatorId = spectator.sessionId
      const LAST_SEQ = 9

      try {
        await waitForCondition(bystander, () => isPlayer(bystander, departingId), '퇴장 대상 최초 상태(players) 확인', STATE_TIMEOUT_MS)
        const spectatorMembership = await waitForOwnMembership(spectator, STATE_TIMEOUT_MS)
        expect(spectatorMembership).toBe('spectators')

        // given: 관전 중인 spectator가 서로 다른 seq 3개를 연속으로
        // 보낸다 — `onMessage('move')`가 발신자의 역할을 검사하지
        // 않으므로(22i가 이미 지목) 이동은 적용되지 않아도(관전 중이라
        // `stepPlayerMovement`가 순회하지 않는다) `pendingSeqs`는 그
        // 세션의 실제 진행값으로 계속 갱신된다. 값 3개를 다르게 골라
        // "아무 seq나"가 아니라 **가장 최근 값**이 반영되는지도 함께
        // 고정한다.
        spectator.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: 3 })
        spectator.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: 5 })
        spectator.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: LAST_SEQ })

        // 서버가 세 메시지를 전부 처리했음을 chat echo로 동기화한다(파일
        // 상단 "메시지 처리 순서 동기화" 절 — 같은 연결의 메시지는 도착
        // 순서대로 처리된다).
        const syncMarker = 'rq-41-seq-guard-sync-marker'
        await Promise.all([
          waitForOwnChatEcho(spectator, syncMarker, SYNC_TIMEOUT_MS, 'RQ-41 seq 가드: move 3건의 서버 처리 완료 동기화(chat echo) 대기'),
          (async () => {
            spectator.send('chat', { text: syncMarker })
          })(),
        ])

        // 결정론적 보조 단언(coder 제안, `07_coder_seq-fix.md` §5) — 서버
        // 권위 부기 맵을 직접 대조한다(클라 패치 타이밍 무관, 순수 서버
        // 전유 상태라 동기 읽기 자체가 안전하다).
        const seam = getServerRoom(bystander)
        expect(seam.pendingSeqs.get(spectatorId)).toBe(LAST_SEQ)

        // 대기 술어 ② — 리스너를 먼저 등록한 다음에만 트리거(정상 퇴장)를
        // 호출한다.
        const spectatorSeesOwnSeq = waitForCondition(
          spectator,
          () => isPlayer(spectator, spectatorId) && readLastProcessedInputSeq(spectator, spectatorId) === LAST_SEQ,
          'RQ-41 seq 가드: 관전자 자신의 시야에서 승격 + lastProcessedInputSeq 반영 대기',
          PROMOTION_TIMEOUT_MS,
        )
        const bystanderSeesSeq = waitForCondition(
          bystander,
          () => isPlayer(bystander, spectatorId) && readLastProcessedInputSeq(bystander, spectatorId) === LAST_SEQ,
          'RQ-41 seq 가드: 제3자(bystander) 시야에서 승격된 세션의 lastProcessedInputSeq 반영 대기',
          PROMOTION_TIMEOUT_MS,
        )

        await Promise.all([leaveRoom(departing), spectatorSeesOwnSeq, bystanderSeesSeq])

        // then: 회귀(pendingSeqs를 다시 지우는 변이) 시 이 값은 스키마
        // 기본값 0이 된다 — 관전 중 마지막으로 보낸 값을 그대로
        // 반영해야 한다(리뷰 blocker).
        expect(readLastProcessedInputSeq(bystander, spectatorId)).toBe(LAST_SEQ)
        expect(readLastProcessedInputSeq(spectator, spectatorId)).toBe(LAST_SEQ)
      } finally {
        await Promise.all([
          ...players.slice(1).map((room) => leaveRoom(room).catch(() => undefined)),
          leaveRoom(spectator).catch(() => undefined),
        ])
      }
    },
    30_000,
  )
})
