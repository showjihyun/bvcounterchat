import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'

/**
 * RQ-40 Global Chat — 도착 순서 보존 통합 테스트 (ADR-0008: Colyseus 룸 경계).
 *
 * 매핑된 골든 케이스: GA-12 (`harness/evals/golden/track-a-product.jsonl`).
 * GA-12: "given: 플레이어 A·B·C가 접속 중이며 거의 동시에 서로 다른 채팅
 * 메시지를 전송 / when: 메시지들이 서버에 도착 / then: 모든 사용자는 서버
 * 도착 순서와 동일한 순서로 메시지를 수신한다(클라이언트 전송 시각이나
 * 네트워크 지연에 따른 순서 뒤바뀜이 없다)."
 * RQ-40 전문(관련 부분): "플레이어 또는 관전자가 채팅 메시지를 보내면,
 * 시스템은 접속 중인 모든 사용자에게 서버 도착 순서와 동일한 순서로
 * 전달해야 한다(Global Chat)."
 *
 * **레벨 분리(ADR-0008)**: 최근 50개 이력 보관·접속/재접속 복원은
 * `rq-40-chat-history-restore.test.ts`가, 관전자 채팅 참여(RQ-41)는
 * `rq-41-chat-spectator-participation.test.ts`가, 금칙어 필터(RQ-95)는
 * `rq-95-profanity-filter.test.ts`가 각각 전담한다 — 이 파일은 "도착 순서
 * 보존" 하나에 집중한다.
 *
 * **가정 1(coder에게 — 이 채널은 아직 없다, test-writer가 계약을 정한다)**:
 * ADR-0002가 명시한 "같은 Colyseus 룸의 메시지 채널" 설계를 그대로 따른다
 * (Schema state가 아니라 `onMessage`/`broadcast` 메시지 채널 — ADR-0002
 * 원문: "RQ-40 채팅도 별도 서버 없이 같은 Colyseus 룸의 메시지 채널로
 * 얹는다"). 구체적으로:
 *   - 클라이언트 → 서버: `room.send('chat', { text: string })`
 *   - 서버 → 전체 브로드캐스트: `this.broadcast('chat', { nickname, text })`
 *     (필터링 후 값, RQ-95). **전송자 자신도 포함**해 전원에게 브로드캐스트
 *     한다고 가정한다 — 그래야 클라이언트가 "내가 보낸 메시지"를 서버가
 *     확정한 최종 형태(닉네임 포함)로 동일한 채널에서 일관되게 렌더링할 수
 *     있다(다른 사용자의 메시지와 렌더링 경로가 갈릴 이유가 없다).
 * 이 파일은 `GameRoom`을 직접 임포트하지 않는다 — `colyseus.js` 클라이언트로
 * 메시지 왕복만 관측하는 블랙박스 통합 테스트다(ADR-0008 "Colyseus 룸
 * 경계"). 채널 이름·payload shape이 다르면 아래 `watchChat`/`waitForChat*`
 * 헬퍼만 조정하면 되고, 각 `it()`의 단언 로직은 그대로 유효하다.
 *
 * **"거의 동시에"를 결정론적으로 검증하는 방법(핵심 설계 결정)**: 3개의 별도
 * TCP 소켓(A·B·C)에서 진짜 동시 송신을 흉내내면, 실제 OS 스케줄링에 따른
 * "서버가 실제로 어떤 순서로 받았는가"는 이 블랙박스 테스트가 통제할 수
 * 없는 값이다 — 특정 순서(예: A,B,C)를 하드코딩해 단언하면 로컬 환경마다
 * 결과가 갈리는 flaky 테스트가 된다. 대신 GA-12 then이 실제로 요구하는
 * 불변식으로 분해한다: **"서버가 어떤 순서로 받았든, 그 순서가 모든 수신자
 * (A·B·C 자신 포함)에게 동일하게 전달된다"** — 이는 참가자 간 순서 일치
 * (cross-client consistency)로 결정론적으로 검증 가능하다(TCP 자체가 단일
 * 연결 내 순서는 보장하므로, 위반이 나타날 수 있는 지점은 서버가 브로드캐스트를
 * 만드는 로직이 도착 순서를 비동기 처리 등으로 흐트러뜨리는 경우뿐이다 —
 * 이 시나리오가 그 결함을 잡는다). 이걸로 부족한 "송신 시각이 아니라 도착
 * 순서"라는 나머지 절반은 `it 3`(제어된 순차 송신 — 각 송신이 이전 메시지의
 * 수신 확인 이후에만 일어나도록 강제해 서버 도착 순서를 우리가 직접
 * 고정한다)이 보강한다: 도착 순서가 A,B,C로 고정된 걸 알고 있는 상태에서
 * 수신 순서가 정확히 A,B,C인지 하드코딩 단언한다.
 *
 * **REV2(evaluator §7 지목 구멍 보강)**: `it 2`(교차 수신자 일관성)와 `it 3`
 * (제어된 순차)만으로는 "그 순서가 곧 서버 도착 순서다"가 **동시 in-flight
 * 구간**에서 비어 있었다 — `it 3`은 항상 "동시에 떠 있는 메시지가 1개뿐인"
 * 상태만 만들어, 도착 순서를 뒤바꾼 채 전원에게 균일하게 전달하는 결함(예:
 * 브로드캐스트 앞 배칭)을 놓쳤다(변이 프로브로 실증). `it 4`(단일 소켓
 * 버스트)가 이 구멍을 메운다 — 한 소켓 안에서는 TCP 순서 보장 + Colyseus
 * 동기 디스패치로 "도착 순서 == 송신 순서"가 결정론적으로 성립하므로, 여러
 * 메시지를 동시에 in-flight로 만들면서도 순서를 하드코딩 단언할 수 있다.
 *
 * **공허화 방지(team-lead 경고)**: `it 1`은 순서 검증 이전에 "메시지 전달
 * 자체가 실제로 동작하는가"를 양성 대조군으로 먼저 고정한다 — 이게 없으면
 * 브로드캐스트가 아예 고장나 아무도 메시지를 못 받는 상황에서도(모든 수신
 * 배열이 똑같이 텅 비어) `it 2`의 "배열이 서로 같다"는 순서 단언이 거짓으로
 * 통과해버릴 수 있다. `it 2`도 순서 비교 전에 각 수신자가 정확히 3개를,
 * 유실·중복 없이 받았는지 먼저 확인한다.
 *
 * **결정론 메모**: 기존 RQ-02/03/04/20/60 통합 테스트와 동일하게 실
 * WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008 허용 예외). 모든
 * 대기에 `withTimeout()` 상한을 건다.
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

async function joinWithNickname(server: RunningServer, nickname: string): Promise<Room> {
  return withTimeout(
    newClient(server).joinOrCreate(ROOM_NAME, { nickname }),
    JOIN_TIMEOUT_MS,
    `joinOrCreate('${ROOM_NAME}', { nickname: '${nickname}' })`,
  )
}

async function leaveRoom(room: Room): Promise<void> {
  // consented=true — 정상적인 접속 종료(비정상 단절이 아니다).
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface ChatBroadcast {
  nickname: string
  text: string
}

/**
 * 방 하나가 수신한 'chat' 브로드캐스트를 지속적으로 누적한다(가정 1).
 * 리스너 등록을 이 함수 호출 시 단 한 번만 해, 이후 여러 번의
 * `waitForChatCount`/`waitForChatText` 호출이 "이미 도착한 것 + 앞으로 올
 * 것" 양쪽을 모두 볼 수 있게 한다(채팅은 상태 조회가 불가능한 순수 이벤트라
 * `rq-20`의 `readPosition`류 폴링 패턴을 그대로 쓸 수 없다).
 */
function watchChat(room: Room): { received: ChatBroadcast[] } {
  const watcher = { received: [] as ChatBroadcast[] }
  room.onMessage<ChatBroadcast>('chat', (message) => {
    watcher.received.push(message)
  })
  return watcher
}

/** `watcher.received.length`가 `count`에 도달할 때까지 대기한다. */
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

/** `text`와 정확히 일치하는 'chat' 메시지를 받을 때까지 대기한다(이미
 * 도착했으면 즉시 resolve). */
function waitForChatText(
  room: Room,
  watcher: { received: ChatBroadcast[] },
  text: string,
  timeoutMs: number,
  label: string,
): Promise<ChatBroadcast> {
  const existing = watcher.received.find((m) => m.text === text)
  if (existing) return Promise.resolve(existing)
  return withTimeout(
    new Promise<ChatBroadcast>((resolve) => {
      room.onMessage<ChatBroadcast>('chat', (message) => {
        if (message.text === text) resolve(message)
      })
    }),
    timeoutMs,
    label,
  )
}

describe('RQ-40 Global Chat — 도착 순서 보존', () => {
  describe('양성 대조군: 채팅 채널 자체가 동작한다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      "RQ-40: 접속 중인 두 사용자 모두(전송자 포함) 원문 그대로의 메시지를 수신한다",
      async () => {
        const roomA = await joinWithNickname(server, 'alice')
        const roomB = await joinWithNickname(server, 'bob')
        const watcherA = watchChat(roomA)
        const watcherB = watchChat(roomB)

        roomA.send('chat', { text: 'hello' })

        const [receivedByA, receivedByB] = await Promise.all([
          waitForChatText(roomA, watcherA, 'hello', CHAT_TIMEOUT_MS, 'A 자신도 자신의 메시지를 수신'),
          waitForChatText(roomB, watcherB, 'hello', CHAT_TIMEOUT_MS, 'B가 A의 메시지를 수신'),
        ])

        expect(receivedByA.text).toBe('hello')
        expect(receivedByA.nickname).toBe('alice')
        expect(receivedByB.text).toBe('hello')
        expect(receivedByB.nickname).toBe('alice')

        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      },
      20_000,
    )
  })

  describe('GA-12: 거의 동시 송신 — 모든 수신자가 동일한 순서로 받는다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      'RQ-40/GA-12: A·B·C가 거의 동시에 서로 다른 메시지를 보내면, 세 수신자(A·B·C 자신 포함)가 관측한 수신 순서가 서로 완전히 동일하다',
      async () => {
        const roomA = await joinWithNickname(server, 'alice')
        const roomB = await joinWithNickname(server, 'bob')
        const roomC = await joinWithNickname(server, 'carol')

        const watcherA = watchChat(roomA)
        const watcherB = watchChat(roomB)
        const watcherC = watchChat(roomC)

        // "거의 동시에" — 세 소켓에 await 없이 연속으로 송신한다. 실제
        // 서버 도착 순서는 이 테스트가 통제하지 않는다(위 헤더 설계 근거).
        roomA.send('chat', { text: 'm-alice' })
        roomB.send('chat', { text: 'm-bob' })
        roomC.send('chat', { text: 'm-carol' })

        const [viewA, viewB, viewC] = await Promise.all([
          waitForChatCount(roomA, watcherA, 3, CHAT_TIMEOUT_MS, 'A가 3개 메시지 전부 수신'),
          waitForChatCount(roomB, watcherB, 3, CHAT_TIMEOUT_MS, 'B가 3개 메시지 전부 수신'),
          waitForChatCount(roomC, watcherC, 3, CHAT_TIMEOUT_MS, 'C가 3개 메시지 전부 수신'),
        ])

        // 양성 대조군 — 유실·중복 없이 정확히 3개, 내용도 세 메시지 전부.
        const expectedTexts = ['m-alice', 'm-bob', 'm-carol']
        expect(viewA.map((m) => m.text).sort()).toEqual(expectedTexts)
        expect(viewB.map((m) => m.text).sort()).toEqual(expectedTexts)
        expect(viewC.map((m) => m.text).sort()).toEqual(expectedTexts)

        // GA-12 핵심 — 실제 순서가 A,B,C 중 무엇이었든, 그 순서를 세
        // 수신자 전원이 동일하게 관측해야 한다(순서 뒤바뀜이 없다).
        const orderA = viewA.map((m) => m.text)
        const orderB = viewB.map((m) => m.text)
        const orderC = viewC.map((m) => m.text)
        expect(orderB).toEqual(orderA)
        expect(orderC).toEqual(orderA)

        await Promise.all([leaveRoom(roomA), leaveRoom(roomB), leaveRoom(roomC)])
      },
      25_000,
    )

    it(
      'RQ-40/GA-12(제어된 순차): 도착 순서를 직접 고정(A→B→C, 각 송신은 이전 메시지의 전원 수신 확인 이후)했을 때, 수신 순서가 송신 시각·소켓 지연과 무관하게 그 도착 순서와 정확히 일치한다',
      async () => {
        const roomA = await joinWithNickname(server, 'seq-a')
        const roomB = await joinWithNickname(server, 'seq-b')
        const roomC = await joinWithNickname(server, 'seq-c')

        const watcherA = watchChat(roomA)
        const watcherB = watchChat(roomB)
        const watcherC = watchChat(roomC)

        roomA.send('chat', { text: 'seq-1' })
        await Promise.all([
          waitForChatText(roomA, watcherA, 'seq-1', CHAT_TIMEOUT_MS, 'seq-1 전원 수신(A)'),
          waitForChatText(roomB, watcherB, 'seq-1', CHAT_TIMEOUT_MS, 'seq-1 전원 수신(B)'),
          waitForChatText(roomC, watcherC, 'seq-1', CHAT_TIMEOUT_MS, 'seq-1 전원 수신(C)'),
        ])

        roomB.send('chat', { text: 'seq-2' })
        await Promise.all([
          waitForChatText(roomA, watcherA, 'seq-2', CHAT_TIMEOUT_MS, 'seq-2 전원 수신(A)'),
          waitForChatText(roomB, watcherB, 'seq-2', CHAT_TIMEOUT_MS, 'seq-2 전원 수신(B)'),
          waitForChatText(roomC, watcherC, 'seq-2', CHAT_TIMEOUT_MS, 'seq-2 전원 수신(C)'),
        ])

        roomC.send('chat', { text: 'seq-3' })
        await Promise.all([
          waitForChatText(roomA, watcherA, 'seq-3', CHAT_TIMEOUT_MS, 'seq-3 전원 수신(A)'),
          waitForChatText(roomB, watcherB, 'seq-3', CHAT_TIMEOUT_MS, 'seq-3 전원 수신(B)'),
          waitForChatText(roomC, watcherC, 'seq-3', CHAT_TIMEOUT_MS, 'seq-3 전원 수신(C)'),
        ])

        const expectedOrder = ['seq-1', 'seq-2', 'seq-3']
        expect(watcherA.received.map((m) => m.text)).toEqual(expectedOrder)
        expect(watcherB.received.map((m) => m.text)).toEqual(expectedOrder)
        expect(watcherC.received.map((m) => m.text)).toEqual(expectedOrder)

        await Promise.all([leaveRoom(roomA), leaveRoom(roomB), leaveRoom(roomC)])
      },
      25_000,
    )

    /**
     * REV2(team-lead 보강 지시, evaluator §7): `it 2`(교차 수신자 일관성)와
     * `it 3`(제어된 순차)만으로는 GA-12 then의 "그 순서가 곧 서버 도착
     * 순서다"가 **동시 in-flight 구간**(=GA-12의 given 자체)에서 비어 있다
     * — `it 3`은 매 송신이 이전 메시지의 전원 수신 확인 이후에만 일어나
     * 동시에 떠 있는 메시지가 항상 1개뿐이라, "도착 순서와 다르지만 전원에게
     * 동일하게" 전달하는 결함(예: 브로드캐스트 앞 배칭·비동기 단계 삽입)을
     * 놓친다(evaluator 프로브 P2b가 균일 전역 역순 변이로 3건 전부 통과함을
     * 실증). `it 2`는 3개의 독립 소켓이라 "실제 서버 도착 순서가 무엇이었나"
     * 자체를 이 테스트가 모른다(그래서 하드코딩 단언이 불가능했다 — 파일
     * 헤더 "설계 결정").
     *
     * 이 테스트는 **단일 TCP 소켓**에서 `await` 없이 5개를 연속 송신해 동시
     * in-flight를 만들되, TCP가 단일 연결 내 도착 순서를 보장하고 Colyseus가
     * 단일 이벤트 루프에서 메시지를 동기 디스패치하므로(`GameRoom.handleChat`
     * docblock "순서 보장(GA-12)" 참고) **서버 도착 순서 == 송신 순서**가
     * flaky 없이 성립한다 — 그래서 "송신 순서 그대로 도착"을 직접 하드코딩
     * 단언할 수 있다. 이 기법은 이미 `rq-40-chat-history-restore.test.ts`
     * (51개 연속 송신)가 쓰는 것과 동일하다. 다자 소켓에서 순서를
     * 하드코딩하지 않는다는 원래 설계 결정과 충돌하지 않는다 — 여기서
     * 하드코딩하는 것은 "단일 소켓의 송신 순서"이지 "여러 소켓 간 도착
     * 순서"가 아니다.
     */
    it(
      'RQ-40/GA-12(단일 소켓 버스트): 한 소켓에서 연속 송신한 5개가 수신자에게 송신 순서 그대로 도착한다',
      async () => {
        const sender = await joinWithNickname(server, 'burst-sender')
        const receiver = await joinWithNickname(server, 'burst-receiver')
        const watcher = watchChat(receiver)

        const texts = ['b-1', 'b-2', 'b-3', 'b-4', 'b-5']
        for (const text of texts) sender.send('chat', { text }) // await 없음 = 동시 in-flight

        await waitForChatCount(receiver, watcher, texts.length, CHAT_TIMEOUT_MS, '수신자가 5개 전부 수신')

        // GA-12 핵심(REV2로 보강되는 부분) — 도착 순서 == 송신 순서. 배칭·재정렬·
        // 역순 브로드캐스트가 끼어들면 이 단언이 깨진다(evaluator P2b가 반례로 확인).
        expect(watcher.received.map((m) => m.text)).toEqual(texts)

        await Promise.all([leaveRoom(sender), leaveRoom(receiver)])
      },
      25_000,
    )
  })
})
