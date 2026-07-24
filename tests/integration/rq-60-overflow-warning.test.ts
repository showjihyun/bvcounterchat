import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'

/**
 * RQ-60 v1.1 "경고" 규범의 배선 갭 — GameRoom onOverflow 배선 실패 테스트
 * (원장 20a-2, PR #10 리뷰 major-2, ADR-0008: Colyseus 룸 경계 통합 테스트).
 *
 * RQ-60 v1.1 전문(`harness/specs/requirements.md`): "서버는 30Hz 고정
 * 틱으로 시뮬레이션을 진행해야 한다. 가변 프레임레이트로 시뮬레이션 스텝
 * 수가 흔들리지 않아야 하며, 짧은 처리 지연(0.5초 이내)의 밀린 틱은 유실
 * 없이 따라잡아야 한다. 단, 누적 밀림이 1초치를 초과하는 비정상 정지
 * (GC 장기 정지·OS 서스펜드)에서는 해당 밀림 전량의 유실을 허용하고
 * **경고를 남긴다**(빨리감기 없이 현재 시간으로 재정렬)."
 *
 * **갭**: `src/shared/sim/tickDriver.ts`가 노출하는 `onOverflow` 훅
 * 자체의 호출 동작(밀림이 `maxBacklogTicks`를 넘으면 전량을 버리고
 * `onOverflow(droppedTicks)`를 부른다)은 `tests/unit/sim-tick-driver.test.ts`
 * (원장 20a-1, "catch-up clamp" describe 블록)가 이미 결정론적으로
 * 검증했다 — 이 파일은 그것을 다시 검증하지 않는다. 이 파일이 겨냥하는
 * 것은 `src/server/rooms/GameRoom.ts`의 **배선**이다: `startTickLoop()`가
 * `createTickDriver(clock, scheduler)`를 옵션 없이 호출하면(현재 상태)
 * 훅이 비어 있어, 실 서버에서 긴 정지가 발생해도 경고 없이 조용히 시간이
 * 유실된다 — "경고를 남긴다"는 규범이 배선 계층에서 미이행이다.
 *
 * **테스트 레벨 선택 근거(ADR-0008)**: 이 갭은 tickDriver의 로직이 아니라
 * GameRoom이 그 로직을 호출하는 방식에 있다. `onOverflow`를 실제로
 * 넘기는지는 `startTickLoop()`(private)에 캡슐화된 결정이라 단위 테스트로
 * 직접 관측할 방법이 없고, 이 프로젝트의 통합 테스트는 서버 내부 구현
 * 모듈을 임포트하지 않는 블랙박스 방식을 따른다(`rq-20-movement-authority
 * .test.ts` 등과 동일 — `@shared/sim/tickDriver`를 이 파일에서 임포트하지
 * 않는다). 그래서 실 Colyseus 룸을 기동해 실제로 "1초치 초과 정지"를
 * 만들고, 관측 가능한 유일한 부수효과인 `console.warn` 호출을 스파이로
 * 확인한다. 로깅 정책(원장 20a-2, 팀리드 결정): stdout 경고
 * (`console.warn`) — GameRoom은 Fastify(pino)와 분리된 Colyseus 계층이고,
 * ADR-0009 배포(도커)의 로그 수집 경로가 stdout이기 때문이다. 경고에는
 * 최소한 버린 틱 수(droppedTicks)가 포함돼야 한다(운영자가 유실 규모를
 * 알 수 있게) — 이 파일의 핵심 단언이 이 값을 확인한다.
 *
 * **"1초 초과 정지"를 실제로 만드는 방법**: 이 테스트 프로세스 자신이
 * 서버를 in-process로 기동한다(다른 통합 테스트와 동일 패턴). 테스트
 * 코드가 동기적으로 이벤트 루프를 1.2초 이상 블록하면, 그 시간 동안은
 * `Room.setSimulationInterval`이 등록한 콜백을 포함해 프로세스의 어떤
 * 콜백도 실행되지 않는다 — 이는 GC 장기 정지·OS 서스펜드가 프로세스에
 * 미치는 영향과 관측 가능한 결과가 동일하다(다음 콜백이 큰 실측 deltaMs를
 * 한 번에 받는다). 이 시나리오를 실제로 재현하는 유일하고 정직한 방법이라
 * 채택했다 — GameRoom·tickDriver 어느 쪽도 수정하지 않고 실제 배선 경로를
 * 그대로 통과시킨다.
 *
 * **대기 상한(ADR-0008 결정론 요구)**: 의도적 블록(`blockEventLoopSync`)
 * 자체가 `Date.now()` 폴링 기반 유한 대기이며 그 길이(1.2초)가 곧 상한이다
 * (무한 대기 아님 — 실제 경과는 이 값 이상이 보장될 뿐, 위로 열려있지
 * 않다). 그 외 모든 네트워크 대기는 `withTimeout()`으로 명시적 상한을
 * 건다. 이 파일은 RQ-60 B계층(`rq-60-fixed-tickrate.test.ts`)과 마찬가지로
 * "실 경과 시간에 대한 서버의 반응"이 검증 대상 자체이므로 예외적으로
 * 고정 길이의 실시간 대기(`sleep`)를 쓴다(그 파일 상단 결정론 메모와 동일
 * 정신 — 다른 통합 테스트가 피하는 "임의 슬립 추측" 안티패턴과는 다르다).
 *
 * **결정론 메모(fake timer를 쓰지 않는 이유)**: `vi.useFakeTimers()`로
 * 전역 타이머를 가짜로 바꾸면 이 테스트가 실제로 여는 localhost WebSocket
 * (join·leave 핸드셰이크, ws ping/pong)까지 함께 영향을 받아 네트워크
 * I/O가 걸릴 위험이 있다 — Colyseus의 `ClockTimer`도 실측(Date.now 기반)
 * 이므로 가짜 시계로는 애초에 "실 경과 시간"이라는 갭의 관측 조건 자체를
 * 만들 수 없다. 동기 블록은 전역 타이머 체계를 건드리지 않고 프로세스의
 * 실제 실행을 지연시킬 뿐이라 이 위험이 없다.
 *
 * **리뷰 반영(원장 20a-2, `_workspace/review/fix-20a-2-onoverflow-wiring.md`,
 * APPROVE·major 1·minor 2)**:
 * - **[major] droppedTicks 단언 탈-tautology**: 이전 버전은 메시지의 모든
 *   숫자를 무차별로 뽑아 `> 30` 검사했는데, 실 구현 메시지("[GameRoom]
 *   RQ-60 v1.1: ...")의 고정 리터럴 "60"(RQ-60)만으로 이미 참이 되어
 *   구현이 droppedTicks를 아예 빼고 로깅해도 통과하는 허점이 있었다.
 *   `numbersNearTickWord()`로 "틱"이라는 단어에 인접한 숫자만 취하도록
 *   좁혀, 메시지 앞머리의 고정 리터럴("RQ-60"·"v1.1")은 배제되고 실제
 *   버린 틱 수 자리의 숫자만 신뢰하게 했다.
 * - **[minor] 대조군 flaky 제거**: "블록 이전에는 경고가 0회"라는 절대
 *   가정(`not.toHaveBeenCalled()`)은 콜드스타트에서 룸 생성 직후 첫
 *   deltaMs가 이례적으로 커 저확률로 깨질 수 있었다. 대조군을 삭제하는
 *   대신 "블록 이전 호출 수를 기준선으로 기록 → 블록 이후 새로 추가된
 *   호출만 검사"로 바꿔, 절대 0 가정 없이도 "관측된 경고가 이번 overflow
 *   이벤트에 의한 것"이라는 대조 의도를 그대로 유지했다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000

/** 룸이 첫 몇 틱을 정상적으로 굴리도록 주는 유예. 통상 이 구간에서는
 * 밀림이 쌓이지 않아 정상(catch-up) 구간과 이후 overflow 구간이 구분된다
 * (콜드스타트로 이 구간에도 드물게 overflow가 나더라도, 아래 본 검사는
 * "블록 이후에 새로 추가된 호출"만 보므로 결과에 영향이 없다 — 리뷰
 * minor, 원장 20a-2). */
const SETTLE_MS = 200

/**
 * 의도적 블록 길이. RQ-60 v1.1의 "1초치 초과"를 안전하게 넘기기 위해
 * 1000ms보다 여유 있게 큰 값을 쓴다 — 30Hz(`NET.TICK_MS`≈33.33ms) 기준
 * 1200ms는 약 36틱 분량이라 스펙이 말하는 "1초치"(30틱) 상한을 확실히
 * 초과한다. (참고: `src/shared/sim/tickDriver.ts`의 내부 기본
 * `maxBacklogTicks`도 30이라 같은 값이지만, 이 블랙박스 테스트는 그
 * 내부 상수를 임포트하지 않고 스펙 문구 "1초치"로부터 독립적으로
 * 재도출한 값을 쓴다.)
 */
const BLOCK_MS = 1_200
/** 경고에 실려야 하는 "버린 틱 수"의 하한 — 위 BLOCK_MS가 만드는 밀림
 * (약 36틱)이 확실히 이 값을 넘는다. "1초치"(1000ms / NET.TICK_MS ≈
 * 33.33ms ≈ 30틱)에서 직접 도출했다. */
const MIN_EXPECTED_DROPPED_TICKS = 30
/** 블록 해제 이후 지연됐던 setSimulationInterval 콜백이 실제로 실행되고
 * (있다면) console.warn까지 도달할 시간을 넉넉히 준다. */
const POST_BLOCK_SETTLE_MS = 300

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

/** 고정 길이 실시간 대기(파일 상단 결정론 메모 참고). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 이벤트 루프를 동기적으로 최소 `ms`만큼 블록한다 — GC 장기 정지·OS
 * 서스펜드가 프로세스에 미치는 영향(그 시간 동안 어떤 콜백도 실행되지
 * 않음)을 실제로 재현하는 방법이다. `Date.now()` 스핀 폴링이라 실제
 * 경과는 항상 `ms` 이상이다(하한 보장). `ms` 자체가 이 함수의 실행 시간
 * 상한이기도 하다 — 무한정 도는 루프가 아니라 목표 시각에 도달하면
 * 즉시 반환한다.
 */
function blockEventLoopSync(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // 의도적 동기 블록 — 본문 없음. 이 구간 동안 프로세스의 어떤 타이머·
    // 네트워크 콜백도 실행되지 않는다(단일 스레드 이벤트 루프 특성).
  }
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

async function joinGame(client: Client): Promise<Room> {
  return withTimeout(client.joinOrCreate(ROOM_NAME), JOIN_TIMEOUT_MS, `joinOrCreate('${ROOM_NAME}')`)
}

async function leaveRoom(room: Room): Promise<void> {
  // consented=true — 정상적인 접속 종료(비정상 단절이 아니다).
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

/**
 * "틱" 문맥에 인접한 숫자가 문자열 안에 있는지 찾기 위한 창(문자 수).
 * 실 구현 메시지("...밀린 틱 36개를...")는 "틱"과 숫자 사이가 공백 1칸뿐
 * 이지만, 로그 문구가 조금 달라져도(예: "틱: 36개", "틱 약 36개") 깨지지
 * 않도록 여유를 둔다. 동시에 "RQ-60"·"v1.1" 같은 메시지 앞머리 고정
 * 리터럴(실측 거리 20자 이상)은 이 창 안에 들어오지 않는다 — 리뷰 major
 * (원장 20a-2)가 지적한 tautology(리터럴 60·1.1만으로 단언이 항상 참이
 * 되던 문제)를 막는 값이다.
 */
const TICK_CONTEXT_WINDOW_CHARS = 8

/**
 * 문자열에서 "틱"이라는 단어에 인접한 숫자만 뽑는다. 정확한 조사·접미사
 * (예: '개')까지는 요구하지 않는다 — 로그 포맷을 과하게 지정하지 않기
 * 위함(리뷰가 제시한 두 대안 중 느슨한 쪽 채택, `_workspace/review/
 * fix-20a-2-onoverflow-wiring.md` major 지적 참고). "RQ-60"·"v1.1"처럼
 * "틱"과 멀리 떨어진 자리의 숫자는 제외된다 — 그래서 이 함수가 반환하는
 * 숫자는 메시지의 고정 리터럴이 아니라 실제로 "틱" 개수를 의도한 자리의
 * 값일 가능성이 높다.
 */
function numbersNearTickWord(text: string): number[] {
  const tickIndices = [...text.matchAll(/틱/g)].map((m) => m.index).filter((i): i is number => i !== undefined)
  if (tickIndices.length === 0) return []

  const near: number[] = []
  for (const match of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const start = match.index
    if (start === undefined) continue
    const end = start + match[0].length
    const isNear = tickIndices.some((tickIdx) => {
      // 숫자가 "틱" 뒤에 있으면 그 사이 문자 수, 앞에 있으면 그 사이
      // 문자 수 — 어느 어순이든 대비한다(현재 구현은 "틱 N개" 순서).
      const gap = start > tickIdx ? start - (tickIdx + 1) : tickIdx - end
      return gap <= TICK_CONTEXT_WINDOW_CHARS
    })
    if (isNear) near.push(Number(match[0]))
  }
  return near
}

/**
 * `console.warn` 호출 인자들에서 "버린 틱 수"로 신뢰할 수 있는 숫자를
 * 뽑는다. 숫자 인자(`console.warn('...', droppedTicks)`)는 메시지 고정
 * 리터럴과 섞일 위험이 없으므로 그대로 신뢰한다. 문자열 인자
 * (`console.warn(\`...${droppedTicks}...\`)`)는 "틱" 문맥에 인접한
 * 숫자만 취한다(`numbersNearTickWord`) — 양쪽 다 "관찰 가능한 행위"로
 * 다루되, 문자열 인자 쪽은 메시지에 우연히 섞인 무관한 숫자(예:
 * "RQ-60"의 60)를 걸러낸다.
 */
function extractCredibleTickCounts(args: unknown[]): number[] {
  return args.flatMap((arg) => {
    if (typeof arg === 'number') return [arg]
    if (typeof arg === 'string') return numbersNearTickWord(arg)
    return []
  })
}

describe('RQ-60 v1.1 onOverflow 배선 — 긴 정지 시 경고 (원장 20a-2, PR #10 리뷰 major-2)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it(
    'RQ-60/20a-2: 1초치를 초과하는 정지(비정상 정지 재현) 후 console.warn이 버린 틱 수와 함께 호출된다',
    async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const room = await joinGame(newClient(server))
      await sleep(SETTLE_MS)

      // 대조군: "블록 이전 호출 수"를 절대 0으로 가정하지 않고 기준선으로만
      // 기록한다(리뷰 minor, 원장 20a-2 — 콜드스타트에서 룸 생성 직후 첫
      // deltaMs가 이례적으로 커 정착 구간에도 overflow가 발동할 저확률
      // 가능성을 배제할 수 없다). 이후 "블록 뒤에 새로 추가된 호출"만
      // 검사해 그 호출이 이번 overflow 이벤트에 의한 것임을 구분한다 —
      // 대조군을 삭제하는 것이 아니라 절대 0 가정만 제거한 것이다.
      const callsBeforeBlock = warnSpy.mock.calls.length

      blockEventLoopSync(BLOCK_MS)

      await sleep(POST_BLOCK_SETTLE_MS)
      await leaveRoom(room)

      const callsAfterBlock = warnSpy.mock.calls.slice(callsBeforeBlock)

      // 핵심 단언(RQ-60 v1.1 "경고를 남긴다"): 배선이 없으면 이 블록 이후
      // 구간에 새로 추가되는 호출 자체가 없어 실패한다 — 현재(Red) 상태를
      // 그대로 드러낸다.
      expect(callsAfterBlock.length).toBeGreaterThan(0)

      const droppedTicksReported = callsAfterBlock.some((callArgs) =>
        extractCredibleTickCounts(callArgs).some((n) => n > MIN_EXPECTED_DROPPED_TICKS),
      )
      expect(droppedTicksReported).toBe(true)
    },
    15_000,
  )
})
