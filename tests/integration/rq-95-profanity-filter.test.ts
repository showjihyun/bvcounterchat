import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_PROFANITY_WORDS } from '@shared/chat/profanityFilter'

/**
 * RQ-95 금칙어 필터 — 서버 왕복(Colyseus 룸 경계) 통합 테스트
 * (ADR-0008: 판정 로직은 서버 경계에서 통합 검증).
 *
 * 매핑된 골든 케이스: GA-24 (`harness/evals/golden/track-a-product.jsonl`).
 * GA-24: "given: 기본 금칙어 목록에 포함된 단어를 담은 채팅 메시지 / when:
 * 플레이어가 해당 메시지를 전송 / then: 서버가 금칙어를 필터링(치환 또는
 * 차단)해 전달한다 — 원문 그대로 다른 사용자에게 노출되지 않는다."
 *
 * **레벨 분리(ADR-0008)**: 필터 판정 자체(단어 매칭·치환 로직)의 순수
 * 정확성은 `tests/unit/rq-95-profanity-filter.test.ts`가 이미 검증한다.
 * 이 파일은 "서버가 실제로 그 필터를 채팅 파이프라인에 적용해 브로드캐스트
 * 하는가"만 실 Colyseus 룸 경계에서 확인한다 — 그래서 이 파일은
 * `filterProfanity` 함수 자체를 임포트하지 않는다(블랙박스). 단,
 * `DEFAULT_PROFANITY_WORDS`(단어 **목록**, 로직이 아니라 데이터)는 예외적으로
 * 임포트한다 — 아래 "단어 값을 이 테스트가 발명하지 않는 이유" 참고.
 *
 * **가정(coder에게)**: `rq-40-chat-ordering.test.ts`와 동일한 채널 계약을
 * 공유한다 — `room.send('chat', { text })` → 서버가 필터링 후
 * `this.broadcast('chat', { nickname, text })`로 전달(ADR-0002 "메시지
 * 채널"). 필터는 서버가 브로드캐스트하기 **전에** 적용된다고 가정한다 —
 * 그래야 원문이 네트워크를 아예 타지 않는다(단순히 클라이언트에서 표시만
 * 가리는 방식이면 원문이 이미 전송된 것이므로 RQ-95 취지에 어긋난다).
 *
 * **단어 값을 이 테스트가 발명하지 않는 이유**: 실제 목록은 아직 없는
 * `src/shared/chat/profanityFilter.ts`(단위 테스트 파일의 "가정" 참고)가
 * 정의한다. 이 통합 테스트가 임의의 문자열을 "금칙어"라고 가정하고
 * 하드코딩하면, 그 문자열이 실제 목록에 없을 경우 이 테스트는 필터가
 * 전혀 동작하지 않아도 (아무것도 필터링되지 않아서 원문이 그대로 와도)
 * "우연히 통과"하거나 "우연히 실패"하는 근거 없는 테스트가 된다 —
 * `DEFAULT_PROFANITY_WORDS[0]`을 그대로 재사용해 이 불확실성을 없앤다
 * (ADR-0010 "값 복제 금지" 정신의 연장 — 목록은 한 곳에만 존재해야 한다).
 *
 * **공허화 방지(team-lead 경고, 필수)**: `it 1`(양성 대조군)이 금칙어가
 * 없는 메시지는 원문 그대로 전달됨을 먼저 고정한다 — 이게 없으면 "서버가
 * 모든 메시지를 깨진 문자열로 바꿔버린다"거나 "채팅 자체가 고장나 아무것도
 * 안 온다" 같은 퇴화한 구현도 `it 2`("원문이 그대로 없다")를 통과시켜버릴
 * 수 있다. `it 2`도 메시지가 실제로 **전달됐는지**(GA-24 then의 "전달한다"
 * — 차단은 해당 단어에 대한 처리 방식이지 메시지 자체를 묵살하는 것이
 * 아니다)부터 확인한 뒤에 원문 비노출을 단언한다.
 *
 * **결정론 메모**: 기존 통합 테스트와 동일하게 실 WebSocket(localhost,
 * 임의 포트)에 의존한다(ADR-0008 허용 예외). 모든 대기에 `withTimeout()`
 * 상한을 건다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const CHAT_TIMEOUT_MS = 5_000

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

/** 방이 다음 'chat' 브로드캐스트 1개를 받을 때까지 대기한다(단발 대기 —
 * 이 파일은 방마다 필요한 대기가 최대 1회뿐이라 `rq-40-chat-ordering`의
 * 누적 watcher가 필요 없다). */
function waitForNextChat(room: Room, timeoutMs: number, label: string): Promise<ChatBroadcast> {
  return withTimeout(
    new Promise<ChatBroadcast>((resolve) => {
      room.onMessage<ChatBroadcast>('chat', (message) => resolve(message))
    }),
    timeoutMs,
    label,
  )
}

describe('RQ-95 금칙어 필터 — 서버 왕복(GA-24)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    '양성 대조군 — 금칙어가 없는 메시지는 원문 그대로 전달된다(과잉 필터링 방지)',
    async () => {
      const sender = await joinWithNickname(server, 'clean-sender')
      const receiver = await joinWithNickname(server, 'clean-receiver')

      const cleanText = 'hello world, nice shot!'
      const pending = waitForNextChat(receiver, CHAT_TIMEOUT_MS, '수신자가 정상 메시지 수신')
      sender.send('chat', { text: cleanText })
      const received = await pending

      expect(received.text).toBe(cleanText)

      await Promise.all([leaveRoom(sender), leaveRoom(receiver)])
    },
    20_000,
  )

  it(
    'RQ-95/GA-24: 기본 금칙어 목록의 단어를 담은 메시지를 보내면, 전달은 되되 그 단어가 원문 그대로 노출되지 않는다',
    async () => {
      const word = DEFAULT_PROFANITY_WORDS[0]
      if (word === undefined) {
        throw new Error('DEFAULT_PROFANITY_WORDS가 비어 있다 — 단위 테스트의 "설계 전제" 케이스가 이미 이 상태를 잡아야 한다')
      }

      const sender = await joinWithNickname(server, 'foul-sender')
      const receiver = await joinWithNickname(server, 'foul-receiver')

      const rawText = `hello ${word} there`
      const pending = waitForNextChat(receiver, CHAT_TIMEOUT_MS, '수신자가 필터링된 메시지 수신')
      sender.send('chat', { text: rawText })
      const received = await pending

      // "전달한다"(GA-24 then) — 메시지 자체는 묵살되지 않고 도착한다.
      expect(typeof received.text).toBe('string')
      // 핵심 단언 — 원문이 그대로 노출되지 않는다. 치환·차단 중 어느 방식을
      // 택했는지에는 결합하지 않는다(단위 테스트 헤더 참고).
      expect(received.text).not.toBe(rawText)
      expect(received.text).not.toContain(word)

      await Promise.all([leaveRoom(sender), leaveRoom(receiver)])
    },
    20_000,
  )
})
