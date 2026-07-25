import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { UI } from '@shared/constants'
import { DEFAULT_PROFANITY_WORDS } from '@shared/chat/profanityFilter'

/**
 * RQ-40 Global Chat — 최근 50개 이력 보관 + 접속/재접속 시 복원 통합 테스트
 * (ADR-0008: Colyseus 룸 경계).
 *
 * 골든 매핑 없음(`harness/evals/golden/track-a-product.jsonl`에 이 문면을
 * 다루는 GA가 없다 — team-lead 지시: "히스토리 50개... RQ-40 문면 — 골든
 * 없음, EARS 근거로 진행"). RQ-40 전문(관련 부분): "시스템은 최근 **50개**
 * 메시지를 보관하고 접속·재접속 시 이를 복원해야 한다. 메시지에는 기본
 * 금칙어 필터(RQ-95)를 적용한다." `UI.CHAT_HISTORY`(`@shared/constants`)가
 * 이미 50으로 확정돼 있다(ADR-0010 값 복제 금지 — 리터럴 50을 다시 쓰지
 * 않고 이 상수를 재사용한다).
 *
 * **레벨 분리(ADR-0008)**: 도착 순서 자체는 `rq-40-chat-ordering.test.ts`가
 * 전담한다. 이 파일은 "보관 개수 상한(50)"과 "접속/재접속 시 그 보관분을
 * 그대로 받는가"만 다룬다.
 *
 * **가정 1(coder에게 — 채널, `rq-40-chat-ordering.test.ts`와 공유)**:
 * `room.send('chat', { text })` → 서버가 필터링 후
 * `this.broadcast('chat', { nickname, text })`(ADR-0002 메시지 채널).
 *
 * **가정 2(coder에게 — 이력 복원 채널, 이 파일이 새로 정한다)**: 서버는
 * `onJoin` 시점에 그 클라이언트에게만(`client.send`, 브로드캐스트 아님)
 * 보관 중인 이력을 배열 그대로 전송한다고 가정한다 —
 * `client.send('chat-history', history: Array<{ nickname: string; text: string
 * }>)`. 순서는 오래된 것이 배열 앞쪽(도착 순서 그대로)이라고 가정한다.
 * 이 이벤트명·shape은 test-writer가 신설하는 계약이라, coder가 다른 채널을
 * 택하면(예: 룸 state의 별도 컬렉션) 이 파일의 `waitForChatHistory` 헬퍼
 * 하나만 조정하면 되고 각 `it()`의 단언 로직은 그대로 유효하다.
 *
 * **"재접속"의 해석(가정 3)**: 이 프로젝트는 Colyseus의 세션 재개 토큰
 * (`allowReconnection`)을 어디서도 쓰지 않는다(`GameRoom.ts` 확인 —
 * `onLeave`가 항상 즉시 컬렉션에서 제거한다). 따라서 "재접속"을 "이전에
 * 접속했다가 퇴장한 사용자가 새 연결로 다시 `joinOrCreate`하는 것"으로
 * 해석한다(세션 연속성 토큰이 아니라 일반 재입장) — `onJoin`이 접속마다
 * (최초든 재입장이든 구분 없이) 이력을 보낸다면 이 해석에서 자동으로
 * 충족된다.
 *
 * **금칙어 필터와의 상호작용(팀리드 경고 — "기존 규칙 간섭 확인" 반영)**:
 * 이력에 원문이 아니라 **필터링된** 텍스트가 저장되는지도 `it 4`가 확인한다
 * — 그렇지 않으면 실시간 브로드캐스트는 RQ-95를 지키면서 이력 복원 경로로
 * 원문이 새 접속자에게 노출되는 우회로가 생긴다(RQ-40과 RQ-95의 교차
 * 지점 — 두 RQ 중 하나만 보고 테스트를 짜면 놓치는 결함이다).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한을 건다. 50개 상한 테스트
 * (`it 3`)는 `UI.CHAT_HISTORY + 1`개의 메시지를 한 소켓에서 await 없이
 * 연속 송신한다 — 같은 TCP 연결·단일 룸 이벤트 루프이므로 순서가 흐트러질
 * 위험이 없고(같은 발신자, `rq-40-chat-ordering`이 이미 다자간 순서를
 * 전담 검증), 송신자 자신이 그 개수만큼 브로드캐스트를 전부 수신할 때까지
 * 기다리는 것으로 "서버가 이력 갱신(50개 상한 적용 포함)을 전부 마쳤다"는
 * 것을 임의 슬립 없이 결정론적으로 확인한다(각 'chat' 핸들러는 히스토리
 * 갱신 → 브로드캐스트를 같은 동기 처리 안에서 마친다고 가정 — 비동기 처리로
 * 순서가 흐트러지는 문제는 `rq-40-chat-ordering.test.ts`가 별도로 잡는다).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const CHAT_TIMEOUT_MS = 5_000
const HISTORY_TIMEOUT_MS = 5_000

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

async function joinWithNickname(server: RunningServer, nickname: string): Promise<Room> {
  return withTimeout(
    newClient(server).joinOrCreate(ROOM_NAME, { nickname }),
    JOIN_TIMEOUT_MS,
    `joinOrCreate('${ROOM_NAME}', { nickname: '${nickname}' })`,
  )
}

async function leaveRoom(room: Room): Promise<void> {
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface ChatBroadcast {
  nickname: string
  text: string
}

/** 방 하나가 수신한 'chat' 브로드캐스트를 지속적으로 누적한다(가정 1,
 * `rq-40-chat-ordering.test.ts`의 `watchChat`과 동일한 패턴 — 채팅은 상태
 * 조회가 불가능한 순수 이벤트라 등록을 한 번만 하고 누적 배열을 재사용한다). */
function watchChat(room: Room): { received: ChatBroadcast[] } {
  const watcher = { received: [] as ChatBroadcast[] }
  room.onMessage<ChatBroadcast>('chat', (message) => {
    watcher.received.push(message)
  })
  return watcher
}

function waitForChatCount(
  room: Room,
  watcher: { received: ChatBroadcast[] },
  count: number,
  timeoutMs: number,
  label: string,
): Promise<ChatBroadcast[]> {
  if (watcher.received.length >= count) return Promise.resolve(watcher.received)
  return withTimeout(
    new Promise<ChatBroadcast[]>((resolve) => {
      room.onMessage<ChatBroadcast>('chat', () => {
        if (watcher.received.length >= count) resolve(watcher.received)
      })
    }),
    timeoutMs,
    label,
  )
}

/** join 시점에 수신하는 이력 복원 메시지를 대기한다(가정 2). */
function waitForChatHistory(room: Room, timeoutMs: number, label: string): Promise<ChatBroadcast[]> {
  return withTimeout(
    new Promise<ChatBroadcast[]>((resolve) => {
      room.onMessage<ChatBroadcast[]>('chat-history', (history) => resolve(history))
    }),
    timeoutMs,
    label,
  )
}

describe('RQ-40 Global Chat — 최근 50개 이력 + 접속/재접속 시 복원', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-40: 이미 오간 메시지가 있는 상태에서 새로 접속한 클라이언트는 그 이력을 순서대로 즉시 받는다',
    async () => {
      const historian = await joinWithNickname(server, 'historian-1')
      const watcher = watchChat(historian)

      historian.send('chat', { text: 'h1' })
      historian.send('chat', { text: 'h2' })
      historian.send('chat', { text: 'h3' })
      // 송신자 자신이 3개를 전부 수신할 때까지 기다려 서버가 이력에 3개를
      // 전부 반영했음을 임의 슬립 없이 확인한다.
      await waitForChatCount(historian, watcher, 3, CHAT_TIMEOUT_MS, 'historian이 자신의 3개 메시지 전부 수신')

      const newcomer = await joinWithNickname(server, 'newcomer-1')
      const history = await waitForChatHistory(newcomer, HISTORY_TIMEOUT_MS, 'newcomer가 접속 직후 이력 복원 수신')

      expect(history.map((m) => m.text)).toEqual(['h1', 'h2', 'h3'])

      await Promise.all([leaveRoom(historian), leaveRoom(newcomer)])
    },
    20_000,
  )

  it(
    'RQ-40: 접속했다가 퇴장한 사용자가 다시 접속(재접속)해도 그 사이 쌓인 이력을 복원받는다',
    async () => {
      const first = await joinWithNickname(server, 'returning')
      const watcher = watchChat(first)

      first.send('chat', { text: 'r1' })
      first.send('chat', { text: 'r2' })
      await waitForChatCount(first, watcher, 2, CHAT_TIMEOUT_MS, '재접속 전 발신자가 자신의 2개 메시지 전부 수신')

      await leaveRoom(first)

      // 재접속 — 세션 재개 토큰이 아니라 새 연결로 다시 접속한다(가정 3).
      const rejoined = await joinWithNickname(server, 'returning')
      const history = await waitForChatHistory(rejoined, HISTORY_TIMEOUT_MS, '재접속 직후 이력 복원 수신')

      expect(history.map((m) => m.text)).toEqual(['r1', 'r2'])

      await leaveRoom(rejoined)
    },
    20_000,
  )

  it(
    `RQ-40: 이력은 최근 ${UI.CHAT_HISTORY}개까지만 보관하고, 그보다 오래된 메시지는 새 접속자에게 전달되지 않는다`,
    async () => {
      const historian = await joinWithNickname(server, 'capacity-historian')
      const watcher = watchChat(historian)

      const total = UI.CHAT_HISTORY + 1
      const texts = Array.from({ length: total }, (_, i) => `cap-${i}`)
      for (const text of texts) {
        historian.send('chat', { text })
      }
      // 전부(상한 초과분 포함) 브로드캐스트가 실제로 나갈 때까지 기다린다 —
      // 이 시점이면 서버 쪽 이력 배열도 상한 적용까지 전부 끝난 상태다
      // (핸들러가 동기적으로 이력 갱신 → 브로드캐스트를 처리한다는 가정,
      // 위 "결정론 메모" 참고).
      await waitForChatCount(historian, watcher, total, CHAT_TIMEOUT_MS, `historian이 ${total}개 메시지 전부 수신`)

      const newcomer = await joinWithNickname(server, 'capacity-newcomer')
      const history = await waitForChatHistory(newcomer, HISTORY_TIMEOUT_MS, 'newcomer가 상한 적용된 이력 수신')

      // 가장 오래된 'cap-0'은 상한을 넘겨 버려지고, 최근 UI.CHAT_HISTORY개만
      // (cap-1..cap-total-1) 순서 그대로 남아야 한다.
      expect(history.length).toBe(UI.CHAT_HISTORY)
      expect(history.map((m) => m.text)).toEqual(texts.slice(1))
      expect(history.map((m) => m.text)).not.toContain('cap-0')

      await Promise.all([leaveRoom(historian), leaveRoom(newcomer)])
    },
    20_000,
  )

  it(
    'RQ-40×RQ-95: 이력으로 복원되는 메시지에도 금칙어 필터가 적용돼 있다(복원 경로로 원문이 새어나가지 않는다)',
    async () => {
      const word = DEFAULT_PROFANITY_WORDS[0]
      if (word === undefined) {
        throw new Error('DEFAULT_PROFANITY_WORDS가 비어 있다 — 단위 테스트의 "설계 전제" 케이스가 이미 이 상태를 잡아야 한다')
      }

      const historian = await joinWithNickname(server, 'foul-historian')
      const watcher = watchChat(historian)

      const rawText = `careful ${word} here`
      historian.send('chat', { text: rawText })
      await waitForChatCount(historian, watcher, 1, CHAT_TIMEOUT_MS, 'historian이 자신의 필터링된 메시지 수신')

      const newcomer = await joinWithNickname(server, 'foul-newcomer')
      const history = await waitForChatHistory(newcomer, HISTORY_TIMEOUT_MS, 'newcomer가 이력 수신')

      expect(history.length).toBe(1)
      const restored = history[0]
      expect(restored).toBeDefined()
      expect(restored?.text).not.toBe(rawText)
      expect(restored?.text).not.toContain(word)

      await Promise.all([leaveRoom(historian), leaveRoom(newcomer)])
    },
    20_000,
  )
})
