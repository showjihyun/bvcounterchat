import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { CAPACITY } from '@shared/constants'

/**
 * RQ-02 v1.2 닉네임 새니타이즈 통합 테스트 (ADR-0008: Colyseus 룸 경계).
 *
 * 원장 19b-1(PR #7 리뷰 major 이월). RQ-02 v1.2 전문(`harness/specs
 * /requirements.md`, 2026-07-24 개정): "시스템은 입력 닉네임을 권위 상태
 * 저장·브로드캐스트 전에 새니타이즈해야 한다: 유니코드 제어문자(Cc — 개행·
 * 탭 포함)를 제거하고 양끝 공백을 트림하며, 유니코드 코드포인트 기준 16자
 * (서로게이트 쌍은 1자)를 초과하는 부분은 잘라낸다. 그 외 문자(이모지·특수
 * 문자 포함)는 허용한다(최소 개입). 새니타이즈 결과가 빈 문자열이면 닉네임
 * 미제공과 동일하게 처리한다(기본 닉네임 부여). 중복 회피 자동 접미사는
 * 길이 제한 적용 후에 붙는다. 이 규칙은 플레이어와 관전자(RQ-03) 입장 경로
 * 모두에 적용된다."
 *
 * **골든 케이스**: 신설 없음(팀리드 지시, 20a-1·20a-2 선례를 따름) — 이
 * 파일은 위 v1.2 EARS 문장 자체를 근거로 삼는다. RQ-02 기존 매핑 골든
 * GA-01(중복 접미사)은 `rq-02-nickname-collision.test.ts`가 이미 검증하며,
 * 이 파일은 그 단언을 반복하지 않는다 — 여기서 접미사가 등장하는 유일한
 * 시나리오(아래 "절단 후 접미사" describe)는 GA-01 자체가 아니라 "절단이
 * 접미사 부착보다 먼저 적용되는지"라는 v1.2 고유의 순서 규칙을 검증하기
 * 위한 수단이다.
 *
 * **테스트 레벨 선택 근거(통합, 단위 아님)**: 새니타이즈 규칙은 스펙상
 * "권위 상태 저장·브로드캐스트 전"이라는 시점에 결부돼 있고, 현재 코드베이스
 * (`src/server/rooms/GameRoom.ts` `onJoin`)에도 새니타이즈를 위한 별도
 * pure 모듈이 아직 없다 — 새니타이즈를 `src/shared`의 독립 순수 함수로
 * 뽑을지, `GameRoom` 내부 private 메서드로 둘지는 coder의 재량이며 이
 * 파일이 그 결정을 강제하지 않는다(구현 방식을 규정하는 테스트 금지). 그래서
 * `rq-02-nickname-collision.test.ts`와 동일하게 `colyseus.js` 클라이언트로
 * 접속해 룸 state(Schema 동기화)에 노출된 최종 닉네임만 블랙박스로 관측한다.
 *
 * **가정 1(join options로 닉네임 전달)**: `rq-02-nickname-collision.test.ts`
 * 와 동일 — `client.joinOrCreate('game', { nickname })`.
 *
 * **가정 2(관측 채널)**: `rq-02-nickname-collision.test.ts`와 동일 —
 * `room.state.players.get(room.sessionId).nickname` (관전자는
 * `room.state.spectators.get(...)`). 이 가정이 달라지면 아래
 * `waitForNicknameIn()` 헬퍼 하나만 조정하면 된다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 넷코드 통합 테스트 허용 예외). 모든 대기에 `withTimeout()`으로 명시적
 * 상한을 건다. 임의 시간 sleep은 쓰지 않는다 — `onStateChange` 이벤트로만
 * 재확인한다. 난수·실시간 시계를 이 테스트 코드가 직접 호출하지 않는다.
 *
 * **경계값 설계 근거**: 원장 19b-1 지시가 명시한 6개 경계값(정확히 16자·
 * 17자·서로게이트 쌍 경계·제어문자만 구성·트림 후 빈 문자열·절단 후 접미사)
 * 전부를 각각 독립된 describe로 다룬다. 추가로 기본 새니타이즈 규칙(제어문자
 * 제거·양끝 트림 각각 단독)과 관전자 입장 경로(팀리드 지시로 필수)를 더한다.
 * "이모지·특수문자 허용(최소 개입)"은 별도 테스트를 새로 만들지 않는다 —
 * 서로게이트 쌍 경계 테스트의 "정확히 16자, 절단 없음" 케이스가 이미 이모지가
 * 그대로 보존됨을 정확히 검증하므로 중복이다.
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
    `joinOrCreate('${ROOM_NAME}', { nickname: ${JSON.stringify(nickname)} })`,
  )
}

/** 닉네임 옵션 자체를 아예 주지 않고 접속한다 — "닉네임 미제공" 경로
 * (새니타이즈 결과 빈 문자열과 동일 취급돼야 하는 대상, RQ-02 v1.2). */
async function joinWithoutNickname(client: Client): Promise<Room> {
  return withTimeout(client.joinOrCreate(ROOM_NAME), JOIN_TIMEOUT_MS, `joinOrCreate('${ROOM_NAME}') (닉네임 없음)`)
}

async function leaveRoom(room: Room): Promise<void> {
  // consented=true — 정상적인 접속 종료(비정상 단절이 아니다).
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface MembershipLike {
  get?: (key: string) => { nickname?: unknown } | undefined
}

interface RoomStateLike {
  players?: MembershipLike
  spectators?: MembershipLike
}

/**
 * 서버가 확정한 최종 닉네임을 룸 state의 지정된 컬렉션(`players` 또는
 * `spectators`)에서 관측한다(가정 2). 접속 시점에 이미 상태가 반영돼 있을
 * 수도, 첫 patch를 기다려야 할 수도 있어 두 경로 모두 확인한다 — 임의 시간
 * sleep 없이 `onStateChange` 이벤트로만 재확인한다.
 */
function waitForNicknameIn(room: Room, collection: 'players' | 'spectators'): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve) => {
      const tryResolve = (): void => {
        const state = room.state as RoomStateLike | null
        const nickname = state?.[collection]?.get?.(room.sessionId)?.nickname
        if (typeof nickname === 'string' && nickname.length > 0) {
          resolve(nickname)
        }
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    NICKNAME_TIMEOUT_MS,
    `${collection} 컬렉션에서 sessionId=${room.sessionId}의 닉네임 관측`,
  )
}

/** `players` 소속을 기본 가정하는 축약 헬퍼(대부분의 시나리오는 플레이어
 * 경로만 다룬다 — 관전자 경로는 전용 describe에서 `waitForNicknameIn`을
 * 직접 'spectators'로 호출한다). */
function waitForNickname(room: Room): Promise<string> {
  return waitForNicknameIn(room, 'players')
}

/** 유니코드 코드포인트 기준으로 앞 n개만 남긴다(서로게이트 쌍을 쪼개지
 * 않는다) — RQ-02 v1.2 "유니코드 코드포인트 기준 16자"를 그대로 재현한
 * 기대값 계산기. `Array.from`은 문자열을 코드포인트 단위로 순회하므로
 * (JS 명세), UTF-16 code unit 기준(`.slice`)과 달리 서로게이트 쌍을
 * 안전하게 다룬다. src/의 구현을 임포트하지 않는 순수 테스트 유틸리티다.
 */
function truncateToCodepoints(input: string, maxCodepoints: number): string {
  return Array.from(input).slice(0, maxCodepoints).join('')
}

/** 유니코드 제어문자(Cc — 개행·탭·NUL·DEL 등)를 전부 제거한 기대값을
 * 계산한다. RQ-02 v1.2 "유니코드 제어문자(Cc)"를 그대로 재현한 기대값
 * 계산기 — src/의 구현을 임포트하지 않는 순수 테스트 유틸리티다. */
function stripControlChars(input: string): string {
  return input.replace(/\p{Cc}/gu, '')
}

/** 폭발 이모지(U+1F4A5) — UTF-16에서 서로게이트 쌍(2 code unit)이지만
 * 유니코드 코드포인트로는 1자다. 서로게이트 쌍 경계 테스트에 쓴다. */
const EMOJI = '\u{1F4A5}'

describe('RQ-02/19b-1 닉네임 새니타이즈', () => {
  describe('기본 규칙 1: 유니코드 제어문자(Cc)는 위치와 무관하게 제거된다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      'RQ-02/19b-1: NUL·TAB·LF·CR·DEL이 문자열 곳곳에 섞인 닉네임은 그 제어문자만 제거되고 나머지 문자는 그대로 남는다',
      async () => {
        // U+0000(NUL)·U+0009(TAB)·U+000A(LF)·U+000D(CR)·U+007F(DEL) — 전부
        // 유니코드 Cc(Control) 카테고리. 스펙 원문이 예시로 든 "개행·탭"
        // 외에 NUL·DEL까지 포함해 Cc 카테고리 전반이 제거 대상임을 검증한다.
        const raw = '\u0000ab\tcd\ndef\rgh\u007f'
        const expected = stripControlChars(raw)

        const room = await joinWithNickname(newClient(server), raw)
        const nickname = await waitForNickname(room)

        expect(nickname).toBe(expected)
        expect(nickname).not.toMatch(/\p{Cc}/u)

        await leaveRoom(room)
      },
      15_000,
    )
  })

  describe('기본 규칙 2: 양끝 공백은 트림되지만 내부 공백은 보존된다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      "RQ-02/19b-1: '   padded name   '처럼 양끝에만 공백이 있으면 양끝만 트림되고 단어 사이 공백은 그대로 남는다",
      async () => {
        const raw = '   padded name   '

        const room = await joinWithNickname(newClient(server), raw)
        const nickname = await waitForNickname(room)

        expect(nickname).toBe('padded name')

        await leaveRoom(room)
      },
      15_000,
    )
  })

  describe('경계값 1: 정확히 16 코드포인트 — 절단되지 않는다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      "RQ-02/19b-1: 정확히 16자('a' x16)인 닉네임은 절단 없이 그대로 저장된다",
      async () => {
        const raw = 'a'.repeat(16)

        const room = await joinWithNickname(newClient(server), raw)
        const nickname = await waitForNickname(room)

        expect(nickname).toBe(raw)

        await leaveRoom(room)
      },
      15_000,
    )
  })

  describe('경계값 2: 17 코드포인트 — 1자만 절단된다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      "RQ-02/19b-1: 17자('a' x17)인 닉네임은 앞 16자만 남고 마지막 1자가 잘린다",
      async () => {
        const raw = 'a'.repeat(17)

        const room = await joinWithNickname(newClient(server), raw)
        const nickname = await waitForNickname(room)

        expect(nickname).toBe(truncateToCodepoints(raw, 16))
        expect(nickname.length).toBe(16)

        await leaveRoom(room)
      },
      15_000,
    )
  })

  describe('경계값 3: 서로게이트 쌍(이모지)이 16자 경계에 걸리는 경우', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      'RQ-02/19b-1: 15자 + 이모지 1개(코드포인트 기준 정확히 16자, UTF-16 code unit 기준 17단위)는 절단되지 않고 이모지가 쪼개지지 않은 채 그대로 남는다',
      async () => {
        // 'a' x15(15 code unit) + EMOJI(2 code unit, 1 codepoint) = 코드포인트
        // 16개, UTF-16 code unit 17개. `.length`(code unit) 기준으로
        // 절단하면 서로게이트 쌍이 반으로 쪼개져 깨진 문자(론 서로게이트)가
        // 남는다 — 코드포인트 기준 구현만 이 케이스를 그대로 보존한다.
        const raw = 'a'.repeat(15) + EMOJI
        expect(Array.from(raw).length).toBe(16) // 전제 확인: 코드포인트 16개
        expect(raw.length).toBe(17) // 전제 확인: UTF-16 code unit 17개

        const room = await joinWithNickname(newClient(server), raw)
        const nickname = await waitForNickname(room)

        expect(nickname).toBe(raw)
        expect(nickname).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/)

        await leaveRoom(room)
      },
      15_000,
    )

    it(
      'RQ-02/19b-1: 16자 + 이모지 1개(코드포인트 기준 17자)는 코드포인트 16개로 절단되고 초과분인 이모지 전체가 통째로 제거된다(반쪽 서로게이트가 남지 않는다)',
      async () => {
        const raw = 'a'.repeat(16) + EMOJI
        expect(Array.from(raw).length).toBe(17) // 전제 확인: 코드포인트 17개

        const room = await joinWithNickname(newClient(server), raw)
        const nickname = await waitForNickname(room)

        expect(nickname).toBe(truncateToCodepoints(raw, 16))
        expect(nickname).not.toContain(EMOJI)
        expect(nickname).not.toMatch(/[\uD800-\uDFFF]/)

        await leaveRoom(room)
      },
      15_000,
    )

    it(
      'RQ-02/19b-1: 15자 + 이모지 1개 + 1자(코드포인트 기준 17자, 이모지가 정확히 16번째 코드포인트)는 이모지까지는 보존되고 그 뒤 1자만 잘린다',
      async () => {
        // 이 케이스는 케이스 2(16자+이모지)와 달리 이모지가 절단 경계
        // *안쪽*(16번째 코드포인트)에 위치한다 — code unit 기준 절단이면
        // 이모지가 반으로 쪼개지고(케이스 1과 동일 결함), 코드포인트 기준
        // 절단이면 이모지는 온전히 남고 마지막 'z'만 잘린다.
        const raw = 'a'.repeat(15) + EMOJI + 'z'
        expect(Array.from(raw).length).toBe(17) // 전제 확인: 코드포인트 17개

        const room = await joinWithNickname(newClient(server), raw)
        const nickname = await waitForNickname(room)

        expect(nickname).toBe(truncateToCodepoints(raw, 16))
        expect(nickname).not.toContain('z')
        expect(nickname).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/)

        await leaveRoom(room)
      },
      15_000,
    )
  })

  describe('경계값 4: 제어문자만으로 구성된 닉네임 — 닉네임 미제공과 동일 취급(기본 닉네임 폴백)', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      "RQ-02/19b-1: 닉네임 없이 접속한 user1과, 제어문자만으로 구성된 닉네임('\\u0000\\u0001\\u0002')으로 접속한 user2는 동일한 기본값으로 충돌해 user2가 자동 접미사를 받는다 — 즉 새니타이즈 결과 빈 문자열이 '미제공'과 동일 경로로 처리됨을 접미사 충돌로 간접 확인한다(기본 닉네임 리터럴 자체에는 결합하지 않는다)",
      async () => {
        const room1 = await joinWithoutNickname(newClient(server))
        const nickname1 = await waitForNickname(room1)
        expect(nickname1.length).toBeGreaterThan(0)

        const room2 = await joinWithNickname(newClient(server), '\u0000\u0001\u0002')
        const nickname2 = await waitForNickname(room2)

        // 빈 문자열로 처리됐다면 "미제공"과 동일한 기본값을 요청한 것이므로
        // user1과 충돌해 접미사가 붙는다(자동 접미사 로직 자체는 GA-01이
        // 이미 검증 — 여기서는 그 충돌이 "실제로 발생했는지"만으로 빈
        // 문자열 폴백 규범을 검증한다).
        expect(nickname2).not.toBe(nickname1)
        expect(nickname2.startsWith(nickname1)).toBe(true)
        expect(nickname2).not.toContain('\u0000')

        await Promise.all([leaveRoom(room1), leaveRoom(room2)])
      },
      20_000,
    )
  })

  describe('경계값 5: 트림 후 빈 문자열(공백만으로 구성) — 닉네임 미제공과 동일 취급', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      "RQ-02/19b-1: 닉네임 없이 접속한 user1과, 공백 3개('   ')만으로 구성된 닉네임으로 접속한 user2는 동일한 기본값으로 충돌해 user2가 자동 접미사를 받는다(트림 경로가 제어문자 제거 경로와 별개로 빈 문자열 폴백을 만족시키는지 확인 — 경계값 4와 동일한 오라클 기법, 공백은 Cc가 아니므로 별도 규칙이다)",
      async () => {
        const room1 = await joinWithoutNickname(newClient(server))
        const nickname1 = await waitForNickname(room1)
        expect(nickname1.length).toBeGreaterThan(0)

        const room2 = await joinWithNickname(newClient(server), '   ')
        const nickname2 = await waitForNickname(room2)

        expect(nickname2).not.toBe(nickname1)
        expect(nickname2.startsWith(nickname1)).toBe(true)

        await Promise.all([leaveRoom(room1), leaveRoom(room2)])
      },
      20_000,
    )
  })

  describe('경계값 6: 절단 결과가 기존 닉네임과 충돌 — 접미사는 절단 후에 붙고, 총 길이가 16을 넘어도 된다', () => {
    let server: RunningServer

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      "RQ-02/19b-1: user1이 정확히 16자('b' x16)로 접속해 있을 때, user2가 그 16자로 시작하되 원본은 21자('b' x16 + 'EXTRA')인 닉네임으로 접속하면, 절단(앞 16자만 남김) 후 user1과 충돌해 접미사가 붙는다 — 원본이 서로 다른데도 충돌한다는 사실 자체가 절단이 충돌 판정보다 먼저 적용됐다는 증거다. 접미사가 붙은 결과는 16자를 넘어도 된다(재절단하지 않는다)",
      async () => {
        const base = 'b'.repeat(16)

        const room1 = await joinWithNickname(newClient(server), base)
        const nickname1 = await waitForNickname(room1)
        expect(nickname1).toBe(base) // user1은 충돌 없이 원본(16자) 그대로

        const room2 = await joinWithNickname(newClient(server), `${base}EXTRA`)
        const nickname2 = await waitForNickname(room2)

        // 절단이 먼저 적용되지 않았다면(원본 21자 vs 원본 16자) 서로 다른
        // 문자열이라 충돌이 일어나지 않았을 것이다 — 충돌이 실제로
        // 일어났다는 것 자체가 "절단 후 비교"의 증거다.
        expect(nickname2).not.toBe(nickname1)
        expect(nickname2.startsWith(base)).toBe(true)
        // 접미사는 절단 후 부착되므로 재절단되지 않는다 — 총 길이가
        // 16 코드포인트를 넘어도 정상이다(스펙 "제한과 별도").
        expect(Array.from(nickname2).length).toBeGreaterThan(16)
        // 원본의 절단분("EXTRA")이 그대로 남아있지는 않다(절단이 실제로
        // 일어났다는 추가 확인 — 접미사만 붙었을 뿐 EXTRA 문자열 자체는
        // 결과에 없어야 한다).
        expect(nickname2).not.toContain('EXTRA')

        await Promise.all([leaveRoom(room1), leaveRoom(room2)])
      },
      20_000,
    )
  })

  describe('관전자 입장 경로: 새니타이즈 규칙은 관전자(RQ-03)에도 동일하게 적용된다', () => {
    let server: RunningServer
    const rooms: Room[] = []

    beforeAll(async () => {
      server = await startServer()
    }, LISTEN_TIMEOUT_MS + 5_000)

    afterEach(async () => {
      // 정원(CAPACITY.PLAYERS)만큼 채우는 접속이 많아 다음 테스트로 접속
      // 잔여물이 새지 않도록 매번 전부 정리한다(이 파일은 시나리오가
      // 하나뿐이지만 rq-03 통합 테스트의 기존 관례를 그대로 따른다).
      await Promise.all(rooms.splice(0).map((room) => leaveRoom(room).catch(() => undefined)))
    })

    afterAll(async () => {
      await stopServer(server)
    })

    it(
      `RQ-02/19b-1: 플레이어 정원(${CAPACITY.PLAYERS}명)이 찬 뒤 관전자로 입장하는 사용자가 제어문자 포함 + 16자 초과 닉네임('\\u0000' + 'z' x20)으로 접속하면, spectators 컬렉션에서 관측된 최종 닉네임도 제어문자가 제거되고 16 코드포인트로 절단돼 있다`,
      async () => {
        // given: 정원(CAPACITY.PLAYERS)만큼 순차 접속시켜 players를 채운다.
        // 새니타이즈 자체는 이 시나리오의 관심사가 아니므로 단순 닉네임을
        // 쓴다(서로 다른 값이라 충돌 걱정도 없다).
        for (let i = 0; i < CAPACITY.PLAYERS; i += 1) {
          const room = await joinWithNickname(newClient(server), `filler${i}`)
          rooms.push(room)
          const membership = await waitForNicknameIn(room, 'players')
          expect(membership.length).toBeGreaterThan(0)
        }

        // when: 정원이 찬 상태에서 제어문자+길이초과 닉네임으로 접속 —
        // RQ-03에 따라 관전자로 입장한다.
        const raw = '\u0000' + 'z'.repeat(20)
        const overflowRoom = await joinWithNickname(newClient(server), raw)
        rooms.push(overflowRoom)

        // then: spectators 컬렉션에서 관측된 닉네임에도 동일한 새니타이즈
        // 규칙(제어문자 제거 + 16 코드포인트 절단)이 적용돼 있다.
        const nickname = await waitForNicknameIn(overflowRoom, 'spectators')

        expect(nickname).not.toMatch(/\p{Cc}/u)
        expect(Array.from(nickname).length).toBeLessThanOrEqual(16)
        expect(nickname).toBe('z'.repeat(16))

        // players 컬렉션 자체는 정원을 넘겨 늘어나지 않았다(관전자 경로로
        // 빠졌다는 재확인).
        const state = overflowRoom.state as RoomStateLike | null
        expect(state?.players?.get?.(overflowRoom.sessionId)).toBeUndefined()
      },
      30_000,
    )
  })
})
