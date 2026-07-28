import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'

/**
 * RQ-61 서버 권위(Server Authoritative) — 위치 참칭 거부, 통합 테스트
 * (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * RQ-61 전문(`harness/specs/requirements.md:159-161`): "시스템은 서버
 * 권위(Server Authoritative) 모델이어야 한다. 위치·HP·킬 등 모든 게임
 * 상태의 진실 공급원은 서버이며, 클라이언트가 보고한 상태는 그대로
 * 반영하지 않아야 한다."
 *
 * 매핑된 골든 케이스 **GA-15**(`verify` 필드가 이 파일 경로를 정확히
 * 지정한다):
 * - given: 악의적 클라이언트가 서버가 계산한 실제 위치와 다른(예: 벽
 *   반대편 또는 순간이동한) 좌표를 자신의 위치로 서버에 보고.
 * - when: 서버가 해당 위치 보고를 수신.
 * - then: 서버는 클라이언트가 보고한 위치를 그대로 반영하지 않고, 서버
 *   자체 시뮬레이션이 계산한 위치만 **다른 플레이어에게 브로드캐스트**한다.
 *
 * **기존 테스트와의 경계(중복 방지)**:
 * - `rq-20-movement-authority.test.ts`(GA-33)는 스푸핑 좌표 무시를 이미
 *   확인하지만, 관측 지점이 **자기 자신의 연결**(`room.state.players
 *   .get(room.sessionId)`) 하나뿐이다.
 * - `rq-62-input-sequence-authority.test.ts`도 동일하게 자기 시야 하나만
 *   쓴다(seq 배선 확인이 주 목적).
 * - `rq-12-client-hit-claim-rejected.test.ts`는 두 클라이언트(A·B)를 쓰지만
 *   각자 **자기 자신의 값**을 자기 연결로 읽는다(HP·킬 참칭 검증, 위치는
 *   대상이 아니다).
 * 이 파일은 GA-15 then의 "다른 플레이어에게 브로드캐스트"를 문자 그대로
 * 검증한다 — **자기 시야로 자기 값을 읽지 않는다**(`rq-64
 * -lag-compensation-bound.test.ts` 상단 "대기 술어 원칙" 4번째 항목과 동일
 * 원칙). 두 관측 지점을 모두 잡는다:
 *   (a) 서버 자체 상태 — `matchMaker.getLocalRoomById`로 테스트 프로세스
 *       안에서 실행 중인 실제 `GameRoom` 인스턴스에 화이트박스로 접근해
 *       `state.players`를 직접 읽는다(`rq-18-fall-damage.test.ts`·
 *       `rq-43-afk-kick.test.ts`·`rq-64-lag-compensation-bound.test.ts`가
 *       이미 확립한 기법). 클라이언트 패치 배치(기본 20Hz)를 거치지 않는
 *       정본(ground truth)이다.
 *   (b) 제3자 클라이언트(B)의 시야 — B 자신의 연결로 A의 상태를
 *       (`roomB.state.players.get(roomA.sessionId)`) 관측한다. 이것이
 *       GA-15가 명시하는 "다른 플레이어에게 브로드캐스트"되는 값 그 자체다.
 *
 * **메시지 표면 조사(coder 구현, `GameRoom.ts` 실측)**: 이 프로젝트에서
 * 클라이언트가 절대 좌표를 실어 보낼 수 있는 채널은 `'move'` 메시지
 * payload뿐이다(별도 `teleport`류 메시지는 스펙·코드 어디에도 없다).
 * `GameRoom.registerMessageHandlers`의 `'move'` 핸들러는
 * `sanitizeMoveInput(payload)`로 `dirX`·`dirZ`·`mode`·`jump`만 뽑고, 같은
 * payload에 `x`·`y`·`z`가 실려 있어도 그 필드를 읽는 코드 경로가 아예
 * 없다(`GameRoom.ts` 63~71행 `sanitizeMoveInput` 정의와 그 docblock이
 * RQ-61을 명시적으로 근거로 든다). 즉 **참칭 표면은 이미 코드 레벨에서
 * 방어돼 있다** — 이 파일은 그 방어가 (1) 서버 자체 상태 (2) 다른
 * 클라이언트로의 브로드캐스트 양쪽에서 실제로 관측 가능한 결과로
 * 이어지는지를 실 Colyseus 룸 경계에서 확인하는 회귀 방지 테스트다(팀리드
 * 지시 — "표면이 없다"면 참칭 시도를 실제로 보내 권위 유지를 양성으로
 * 확인).
 *
 * Colyseus 스키마(`@shared/schema/GameState`)에는 필드별 `@filter`가 없다
 * — `players` 맵 전체가 룸에 연결된 모든 클라이언트에게 동일하게
 * 브로드캐스트된다. 따라서 관측 지점 (a)와 (b)가 값 자체는 원리상 같은
 * 정본에서 파생되지만, (b)는 클라이언트 패치 왕복(네트워크 + 배치 지연)을
 * 실제로 거친다는 점에서 (a)와 독립적인 관측이다 — 스키마 필터링이
 * 나중에 도입되는 회귀(예: 위치만 자기 자신에게 숨기는 등)를 잡아낼 수
 * 있는 것은 (b) 하나뿐이다.
 *
 * **대기 술어**: `seq`(RQ-62, ADR-0003)를 포함해 보내고
 * `lastProcessedInputSeq`가 그 값으로 오르는 것을 기다린다 — 단조·안정
 * 신호다. `pendingInputs`가 "최근 수신 입력을 다음 메시지가 올 때까지
 * 매 틱 재적용"하는 모델이라(`GameRoom.ts` `pendingInputs` 필드 코멘트),
 * "직전 값과 달라졌다"만으로 두 번째(스푸핑) 메시지의 처리 여부를
 * 판정하면 첫 메시지의 재적용만으로도 조건이 참이 될 수 있다(무관한
 * 원인으로 만족되는 대기 술어 — `rq-62-input-sequence-authority.test.ts`
 * REV가 CI에서 실제로 겪은 레이스). `lastProcessedInputSeq`는 한 번
 * 오르면 되돌아가지 않으므로 이 함정이 없다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다
 * (ADR-0008 허용 예외 — 기존 RQ-02/03/04/20/60/62/64 통합 테스트와 동일).
 * 모든 대기에 상한(`timeoutMs`)을 강제한다.
 *
 * **REV(평가 F1 blocker 수정, `_workspace/RQ-61/03_evaluator_report.md`
 * §5.4·§6)**: 첫 회차 테스트는 GA-15 `then`의 첫째("그대로 반영하지
 * 않는다")·셋째("다른 플레이어에게 브로드캐스트") 절만 단언하고, 둘째 절
 * ("**서버 자체 시뮬레이션이 계산한 위치만**")은 단언하지 않았다.
 * `not.toBeCloseTo(9999, 0)`("그 센티넬이 아니다")·`toBeGreaterThan(...)`
 * ("전진했다")는 둘 다 클라가 **맵 안** 좌표(GA-15 given의 "벽 반대편"
 * 예시)를 참칭해도 통과한다 — 평가자가 서버가 참칭 좌표를 맵 범위로
 * 절단해 그대로 채택하는 변이(M5)를 심었을 때 이 파일을 포함한 통합
 * 스위트 전체가 초록이었던 것으로 실증됐다. 아래 두 번째 `it()`가 그
 * 간극을 메운다 — 참칭 좌표를 **정지 입력**(`dirX:0, dirZ:0`)과 함께
 * 보내 "서버 시뮬레이션 결과(=정지 상태, 직전 위치)와 **정확히 같다**"를
 * 단언한다("센티넬이 아니다"가 아니라 "그 값이다"로 전환). 기존
 * 9999-센티넬 케이스는 그대로 둔다(M1·M2 검출력은 이미 확인됨,
 * `02_test-writer_mutation.md`) — 새 케이스는 그 위에 M5까지 덮는
 * **추가** 커버리지다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const SNAPSHOT_TIMEOUT_MS = 5_000
/** 서버 화이트박스 상태 폴링 간격 — `rq-64-lag-compensation-bound.test.ts`
 * `SERVER_POLL_INTERVAL_MS`와 동일 값·동일 근거. */
const SERVER_POLL_INTERVAL_MS = 15
/** 스푸핑 대상 좌표 — 60×60m 맵(RQ-30, `WORLD.SIZE_M`)을 아득히 벗어나는
 * 값이라 "이 좌표 근처에도 못 온다"를 관대한 오차 없이 단언할 수 있다
 * (`rq-20-movement-authority.test.ts`·`rq-62-input-sequence-authority
 * .test.ts`와 동일한 상수). */
const SPOOFED_COORD = 9999
/** REV(F1 수정) — GA-15 given "벽 반대편"을 재현하는 **맵 안** 참칭 좌표
 * (60×60m 맵, `WORLD.SIZE_M`, 절반 30m 안쪽). 정수가 아닌 `.5` 값을 쓴다
 * — `SPAWN_POINTS`(`@shared/sim/spawn`)는 전부 `Math.round`로 정수 좌표만
 * 갖고 y는 항상 0(접지)이므로, `x`·`z`의 `.5` 성분과 `y=1.5`(y≠0) 둘 다
 * 어느 스폰 지점과도 우연히 일치할 수 없다 — 이 테스트가 어느 스폰
 * 지점을 배정받든(룸 전역 순환 커서, 이전 `it()`들의 접속 수에 따라
 * 달라진다) 검출력이 좌표 우연 일치로 무력화되지 않는다는 것을 보장하는
 * 설계다. 평가자가 동일 형태(x:12.5·y:1.5·z:-12.5)로 검출력을 직접
 * 실행해 확인했다(`03_evaluator_report.md` §6). */
const IN_MAP_SPOOF = { x: 12.5, y: 1.5, z: -12.5 }

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

interface PositionSnapshot {
  x: number
  y: number
  z: number
  lastProcessedInputSeq: number
}

/** 화이트박스 접근 대상 계약 — `state`는 `Room.state`(public) 그대로다.
 * `rq-18-fall-damage.test.ts`·`rq-43-afk-kick.test.ts`·
 * `rq-64-lag-compensation-bound.test.ts`와 동일한 `as unknown as` 결합
 * 방식(신규 필드를 추가하지 않으므로 이 계약 자체는 그린필드가 아니다 —
 * `x`·`y`·`z`·`lastProcessedInputSeq`는 이미 `Player` 스키마에 있다). */
interface PositionTestSeam {
  state: {
    players: {
      get: (sessionId: string) =>
        | { x?: number; y?: number; z?: number; lastProcessedInputSeq?: number }
        | undefined
    }
  }
}

/** `matchMaker.getLocalRoomById`(`rq-18-fall-damage.test.ts`가 확립한 기법)로
 * 테스트 프로세스 안에서 실행 중인 실제 `GameRoom` 인스턴스를 얻는다. */
function getServerRoom(room: Room): PositionTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as PositionTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-61 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function readServerPosition(seam: PositionTestSeam, sessionId: string): PositionSnapshot | undefined {
  const p = seam.state.players.get(sessionId)
  if (
    typeof p?.x === 'number' &&
    typeof p?.y === 'number' &&
    typeof p?.z === 'number' &&
    typeof p?.lastProcessedInputSeq === 'number'
  ) {
    return { x: p.x, y: p.y, z: p.z, lastProcessedInputSeq: p.lastProcessedInputSeq }
  }
  return undefined
}

/** 관측 지점 (a) — 서버 자체 상태를 직접 폴링한다(화이트박스). 클라이언트
 * 패치(기본 20Hz)를 기다리지 않으므로 배치 지연과 무관하게 확인된다
 * (`rq-64-lag-compensation-bound.test.ts` `waitForServerHp`와 동일 패턴). */
function waitForServerCondition(
  seam: PositionTestSeam,
  sessionId: string,
  predicate: (s: PositionSnapshot) => boolean,
  label: string,
  timeoutMs: number,
): Promise<PositionSnapshot> {
  return new Promise<PositionSnapshot>((resolve, reject) => {
    const tryResolve = (): boolean => {
      const current = readServerPosition(seam, sessionId)
      if (current && predicate(current)) {
        resolve(current)
        return true
      }
      return false
    }
    if (tryResolve()) return
    const interval = setInterval(() => {
      if (tryResolve()) {
        clearInterval(interval)
        clearTimeout(timeout)
      }
    }, SERVER_POLL_INTERVAL_MS)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`[timeout ${timeoutMs}ms] ${label}`))
    }, timeoutMs)
  })
}

/** 관측 지점 (b) — `observerRoom`(제3자 B)의 연결로 `targetSessionId`(A)의
 * 상태를 읽는다. **자기 시야로 자기 값을 읽지 않는다** — `observerRoom`과
 * `targetSessionId`는 항상 서로 다른 세션이어야 한다(GA-15 then "다른
 * 플레이어에게 브로드캐스트"). */
function readCrossViewPosition(observerRoom: Room, targetSessionId: string): PositionSnapshot | undefined {
  const state = observerRoom.state as {
    players?: {
      get?: (key: string) =>
        | { x?: unknown; y?: unknown; z?: unknown; lastProcessedInputSeq?: unknown }
        | undefined
    }
  } | null
  const player = state?.players?.get?.(targetSessionId)
  if (
    typeof player?.x === 'number' &&
    typeof player?.y === 'number' &&
    typeof player?.z === 'number' &&
    typeof player?.lastProcessedInputSeq === 'number'
  ) {
    return { x: player.x, y: player.y, z: player.z, lastProcessedInputSeq: player.lastProcessedInputSeq }
  }
  return undefined
}

/** REV(평가 minor 1, `03_evaluator_report.md` §9-1): `observerRoom
 * .onStateChange(...)`가 반환하는 것이 아니라 `tryResolve` 자체를
 * `.remove()`로 해제해야 한다(colyseus.js `Signal`은 `register(cb)`로
 * 등록한 콜백 참조를 `remove(cb)`로 해제하는 API — `lib/core/signal.d.ts`).
 * 원래는 해제하지 않아, 이 파일에서만 `it()` 1건당 최대 4회 호출되며
 * 리스너가 계속 누적됐다(케이스 추가 시 더 누적). 조건이 충족돼 resolve할
 * 때 그 시점의 리스너를 명시적으로 제거한다 — 조건이 즉시(첫 `tryResolve()`
 * 호출) 충족되는 경우는 애초에 `onStateChange`를 등록하지 않으므로 해제할
 * 대상이 없다(정상, no-op). */
function waitForCrossViewCondition(
  observerRoom: Room,
  targetSessionId: string,
  predicate: (s: PositionSnapshot) => boolean,
  label: string,
): Promise<PositionSnapshot> {
  return withTimeout(
    new Promise<PositionSnapshot>((resolve) => {
      const tryResolve = (): void => {
        const current = readCrossViewPosition(observerRoom, targetSessionId)
        if (current && predicate(current)) {
          observerRoom.onStateChange.remove(tryResolve)
          resolve(current)
        }
      }
      // 즉시 충족되면 `onStateChange`를 아예 등록하지 않는다 — 해제할
      // 리스너 자체가 없으므로 이 경로는 처음부터 누수가 없다.
      const immediate = readCrossViewPosition(observerRoom, targetSessionId)
      if (immediate && predicate(immediate)) {
        resolve(immediate)
        return
      }
      observerRoom.onStateChange(tryResolve)
    }),
    SNAPSHOT_TIMEOUT_MS,
    label,
  )
}

describe('RQ-61/GA-15: 위치 참칭 — 서버 자체 상태와 다른 플레이어(B)의 브로드캐스트 시야 양쪽에서 서버 권위가 유지된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "RQ-61/GA-15: A가 'move' payload에 조작된 절대 좌표(x·y·z)를 실어 보내도, (a) 서버 자체 상태와 (b) B가 자신의 연결로 관측하는 A의 브로드캐스트 위치 양쪽 모두 그 좌표를 반영하지 않고 서버 시뮬레이션 결과만 유지한다",
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA) // GA-29: 서버 전역 단일 룸 — roomA·roomB가 같은 룸

      // 베이스라인 — (a) 서버 자체 상태, (b) B의 시야(자기 시야 아님).
      const baselineServer = await waitForServerCondition(
        seam,
        roomA.sessionId,
        () => true,
        '서버 상태 — A의 초기 위치 관측',
        SNAPSHOT_TIMEOUT_MS,
      )
      const baselineCross = await waitForCrossViewCondition(
        roomB,
        roomA.sessionId,
        () => true,
        'B 시야 — A의 초기 위치 관측',
      )

      // 정상 이동(legit) — seq=1. 서버가 실제로 시뮬레이션을 도는지 확인하는
      // 전제 조건이자, 아래 스푸핑 단언의 대조 기준점이다.
      roomA.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false, seq: 1 })

      const afterLegitServer = await waitForServerCondition(
        seam,
        roomA.sessionId,
        (s) => s.lastProcessedInputSeq === 1,
        '서버 상태 — seq=1 처리 대기',
        SNAPSHOT_TIMEOUT_MS,
      )
      expect(afterLegitServer.x).toBeGreaterThan(baselineServer.x)

      const afterLegitCross = await waitForCrossViewCondition(
        roomB,
        roomA.sessionId,
        (s) => s.lastProcessedInputSeq === 1,
        'B 시야 — seq=1 처리 대기',
      )
      expect(afterLegitCross.x).toBeGreaterThan(baselineCross.x)

      // 스푸핑 시도 — 방향 필드(dirX·dirZ·mode·jump)는 정상값 그대로 두고,
      // 조작된 절대 좌표를 함께 실어 보낸다(GA-15 given "임의 좌표를 직접
      // 보고").
      roomA.send('move', {
        dirX: 1,
        dirZ: 0,
        mode: 'run',
        jump: false,
        seq: 2,
        x: SPOOFED_COORD,
        y: SPOOFED_COORD,
        z: SPOOFED_COORD,
      })

      // (a) 서버 자체 상태 — 스푸핑이 정본에 닿지 않았는지 직접 확인.
      const afterSpoofServer = await waitForServerCondition(
        seam,
        roomA.sessionId,
        (s) => s.lastProcessedInputSeq === 2,
        '서버 상태 — seq=2(스푸핑) 처리 대기',
        SNAPSHOT_TIMEOUT_MS,
      )
      expect(afterSpoofServer.x).not.toBeCloseTo(SPOOFED_COORD, 0)
      expect(afterSpoofServer.y).not.toBeCloseTo(SPOOFED_COORD, 0)
      expect(afterSpoofServer.z).not.toBeCloseTo(SPOOFED_COORD, 0)
      // 스푸핑 메시지도 방향 필드는 정상이었으므로, 위치는 계속 같은
      // 방향으로 전진했어야 한다 — "스푸핑이 반영되지 않았을 뿐 입력
      // 시뮬레이션 자체는 계속된다"는 것을 단순 정지와 구분한다.
      expect(afterSpoofServer.x).toBeGreaterThan(afterLegitServer.x)

      // (b) GA-15 then의 핵심 문구 — "다른 플레이어에게 브로드캐스트한다":
      // B 자신의 연결로 관측하는 A의 상태에도 스푸핑 좌표가 보이지 않아야
      // 한다. 이것이 이 파일이 기존 rq-20/rq-62(자기 시야만)와 다른
      // 지점이다.
      const afterSpoofCross = await waitForCrossViewCondition(
        roomB,
        roomA.sessionId,
        (s) => s.lastProcessedInputSeq === 2,
        'B 시야 — seq=2(스푸핑) 처리 대기',
      )
      expect(afterSpoofCross.x).not.toBeCloseTo(SPOOFED_COORD, 0)
      expect(afterSpoofCross.y).not.toBeCloseTo(SPOOFED_COORD, 0)
      expect(afterSpoofCross.z).not.toBeCloseTo(SPOOFED_COORD, 0)
      expect(afterSpoofCross.x).toBeGreaterThan(afterLegitCross.x)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    20_000,
  )

  it(
    'RQ-61/GA-15 보강(F1, 평가 blocker 수정): 정지 입력과 함께 맵 안쪽 참칭 좌표(GA-15 given "벽 반대편" 유형)를 보내도, (a) 서버 자체 상태와 (b) B의 브로드캐스트 시야 양쪽 모두 서버 시뮬레이션이 계산한 값(=정지 상태, 직전 위치)과 정확히 같다 — "센티넬이 아니다"가 아니라 "그 값이다"를 단언한다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      // seq=1: 정지 입력 — 서버 시뮬레이션 결과는 "그대로"(정지)다. 이후
      // seq=2의 참칭 시도가 이 값을 조금이라도 움직이면 검출된다.
      roomA.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false, seq: 1 })
      const idleServer = await waitForServerCondition(
        seam,
        roomA.sessionId,
        (s) => s.lastProcessedInputSeq === 1,
        '서버 상태 — seq=1(정지) 처리 대기',
        SNAPSHOT_TIMEOUT_MS,
      )
      const idleCross = await waitForCrossViewCondition(
        roomB,
        roomA.sessionId,
        (s) => s.lastProcessedInputSeq === 1,
        'B 시야 — seq=1(정지) 처리 대기',
      )

      // seq=2: 같은 정지 입력 + 맵 안쪽 참칭 좌표. 방향 입력이 정지이므로
      // 서버 시뮬레이션이 실제로 계산하는 값은 "직전과 동일"이어야
      // 한다(GA-15 then ② "서버 자체 시뮬레이션이 계산한 위치만").
      roomA.send('move', {
        dirX: 0,
        dirZ: 0,
        mode: 'run',
        jump: false,
        seq: 2,
        x: IN_MAP_SPOOF.x,
        y: IN_MAP_SPOOF.y,
        z: IN_MAP_SPOOF.z,
      })

      // (a) 서버 자체 상태 — 참칭 좌표가 아니라 정지 상태 그대로여야 한다.
      const afterServer = await waitForServerCondition(
        seam,
        roomA.sessionId,
        (s) => s.lastProcessedInputSeq === 2,
        '서버 상태 — seq=2(맵 안 참칭 + 정지 입력) 처리 대기',
        SNAPSHOT_TIMEOUT_MS,
      )
      expect(afterServer.x).toBeCloseTo(idleServer.x, 5)
      expect(afterServer.y).toBeCloseTo(idleServer.y, 5)
      expect(afterServer.z).toBeCloseTo(idleServer.z, 5)

      // (b) B의 브로드캐스트 시야에서도 동일하게 정지 상태 그대로여야 한다
      // — GA-15 then ③("다른 플레이어에게 브로드캐스트")과 ②를 함께 덮는다.
      const afterCross = await waitForCrossViewCondition(
        roomB,
        roomA.sessionId,
        (s) => s.lastProcessedInputSeq === 2,
        'B 시야 — seq=2(맵 안 참칭 + 정지 입력) 처리 대기',
      )
      expect(afterCross.x).toBeCloseTo(idleCross.x, 5)
      expect(afterCross.y).toBeCloseTo(idleCross.y, 5)
      expect(afterCross.z).toBeCloseTo(idleCross.z, 5)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    20_000,
  )
})
