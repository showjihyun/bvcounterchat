import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER } from '@shared/constants'
import { escapeSafeZone, type SafeZoneEscapeSeam } from '../support/safe-zone'

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
 *
 * **REV(원장 20f 회수, 이월 항목 회수)**: 위 두 케이스는 전부 **살아있는**
 * 플레이어만 다룬다. `stepPlayerMovement`가 `!canAct`(시신)에서 위치·
 * `lastProcessedInputSeq` 갱신 코드(924~960행)에 도달하기 **전에** return하므로
 * (`GameRoom.ts:916-922`, 실측 확인) 오늘은 시신의 위치가 애초에 갱신되지
 * 않아 참칭 표면 자체가 없다 — **지금은 안전하다.** 하지만 이 그물은
 * 살아있는 플레이어 경로만 덮고, 시신 분기에 위치 쓰기가 들어오는 회귀가
 * 생기면 시신에 한해 참칭이 잔존할 수 있다(관전 카메라(RQ-91)가 시신을
 * 보여주면 표시 계층까지 오염). 아래 세 번째 `it()`가 이 그물을 시신
 * 상태까지 넓히는 **회귀 방지 추가**다(GA-15 자체는 이미 done — 새 골든
 * 없이 같은 GA-15의 커버리지 확장).
 *
 * **시신에게는 `lastProcessedInputSeq === seq` 대기 술어를 쓸 수 없다**:
 * 위에서 확인한 조기 return 때문에 이 필드는 시신에게 절대 오르지 않는다
 * (영원히 미충족 -> 타임아웃). 대신 `pendingSeqs`(private map -- `'move'`
 * 핸들러가 생사와 무관하게 무조건 갱신한다, `GameRoom.ts` 확인)를
 * 화이트박스로 직접 폴링해 "서버가 이 메시지를 수신·처리했다"는 단조
 * 신호로 쓴다(아래 `waitForServerPendingSeq`).
 *
 * **리스폰(3초)과의 경합 회피**: 사망 유도 -> 참칭 시도 -> 관측까지 총
 * 경과를 `PLAYER.RESPAWN_MS`(3000ms)보다 한참 작게(약 1.5~2초) 설계했고,
 * 관측 시점마다 `hp === 0`을 재확인해 리스폰이 끼어들지 않았음을 실측으로도
 * 확인한다(고정 슬립만으로 가정하지 않는다).
 *
 * **REV(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19·GA-11, `86fddf1`) 이후 원장 20f
 * 확장(`killVictim` 사용 케이스)의 A·B 둘 다 각자의 스폰 지점(Safe Zone
 * 내부)에 그대로 있으면 (1) GA-19가 A의 킬 시퀀스 사격 자체를 막고 (2)
 * B가 Safe Zone 안에 있으면 RQ-16과 무관하게 GA-11이 계속 피해를
 * 무효화한다. `killVictim` 시작 시 A·B 둘 다 화이트박스로 Safe Zone
 * 밖으로 옮기고(반경-방사 기하, `rq-31-safe-zone.test.ts` 참고), B의
 * RQ-16 해제도 자기 사격 대신 화이트박스(`firedSinceSpawn`)로 한다 —
 * 이 파일의 앞 두 `it()`(GA-15 본문·F1 수정)는 hitscan을 쓰지 않으므로
 * 영향받지 않는다.
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

/** 연속 사격 사이의 여유(원장 20f) — ADR-0005 rate-limit(150ms)을 명백히
 * 초과한다(`rq-14`/`rq-15`의 `BETWEEN_SHOTS_MS`와 동일 값·동일 근거). */
const BETWEEN_SHOTS_MS = 300
/** RQ-31 회귀 대응 — 화이트박스 Safe Zone 탈출 텔레포트가 스키마
 * (`player.x/y/z`)에 정착할 시간(서버 틱 ≈33ms의 몇 배 여유). */
const RELEASE_PROTECTION_SETTLE_MS = 300
/** 시신의 참칭 'move' 수신 확인 이후, 여러 서버 틱(`NET.TICK_MS`≈33ms)이
 * 지날 정착 대기(원장 20f) — C1류 회귀(시신 분기에서 return 전에 위치를
 * 쓰는 변이)가 있었다면 이 창 안에 이미 반영됐을 시간이다(`rq-15`의
 * `MOVE_IGNORE_OBSERVE_MS`=400ms와 동일 값·동일 근거). `PLAYER.RESPAWN_MS`
 * (3000ms)보다 한참 작아 리스폰과 섞이지 않는다. */
const CORPSE_SETTLE_MS = 400

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
  /** 원장 20f 확장 — 시신 상태(hp<=0)를 관측 시점에 재확인하는 용도
   * (리스폰 3초와의 경합 회피). 기존 두 케이스는 이 필드를 읽지 않으므로
   * 살아있는 플레이어의 hp=100이 그대로 들어와도 아무 영향이 없다. */
  hp: number
}

/** 화이트박스 접근 대상 계약 — `state`는 `Room.state`(public) 그대로다.
 * `rq-18-fall-damage.test.ts`·`rq-43-afk-kick.test.ts`·
 * `rq-64-lag-compensation-bound.test.ts`와 동일한 `as unknown as` 결합
 * 방식(신규 필드를 추가하지 않으므로 이 계약 자체는 그린필드가 아니다 —
 * `x`·`y`·`z`·`hp`·`lastProcessedInputSeq`는 이미 `Player` 스키마에 있고,
 * `pendingSeqs`는 `AfkTestSeam`(`rq-43-afk-kick.test.ts`)이 이미 이 정확한
 * 이름으로 화이트박스 접근하는 기존 private 필드다). */
interface PositionTestSeam extends SafeZoneEscapeSeam {
  state: {
    players: {
      get: (sessionId: string) =>
        | { x?: number; y?: number; z?: number; hp?: number; lastProcessedInputSeq?: number }
        | undefined
    }
  }
  /** 원장 20f 확장 — 'move' 핸들러가 생사와 무관하게 무조건 갱신하는
   * seq map(`GameRoom.ts` 확인). 시신에게는 `lastProcessedInputSeq`가
   * 절대 오르지 않으므로(파일 상단 REV 절 참고) "서버가 이 메시지를
   * 수신·처리했다"는 대기 신호로 이 필드를 대신 쓴다. */
  pendingSeqs: Map<string, number>
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
    typeof p?.hp === 'number' &&
    typeof p?.lastProcessedInputSeq === 'number'
  ) {
    return { x: p.x, y: p.y, z: p.z, hp: p.hp, lastProcessedInputSeq: p.lastProcessedInputSeq }
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
        | { x?: unknown; y?: unknown; z?: unknown; hp?: unknown; lastProcessedInputSeq?: unknown }
        | undefined
    }
  } | null
  const player = state?.players?.get?.(targetSessionId)
  if (
    typeof player?.x === 'number' &&
    typeof player?.y === 'number' &&
    typeof player?.z === 'number' &&
    typeof player?.hp === 'number' &&
    typeof player?.lastProcessedInputSeq === 'number'
  ) {
    return { x: player.x, y: player.y, z: player.z, hp: player.hp, lastProcessedInputSeq: player.lastProcessedInputSeq }
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

/** 원장 20f 확장 — 시신에게는 절대 오르지 않는 `lastProcessedInputSeq`
 * 대신, 'move' 핸들러가 생사와 무관하게 무조건 갱신하는 `pendingSeqs`를
 * 화이트박스로 직접 폴링한다(파일 상단 REV 절 근거). "이 정확한 'move'
 * 메시지를 서버가 수신·처리했다"는 단조 신호(다음 메시지가 오기 전까지
 * 값이 유지된다) — `waitForServerCondition`과 동일한 폴링+타임아웃
 * 골격이나, 데이터 출처가 `state.players`가 아니라 `pendingSeqs`라 별도
 * 함수로 둔다. */
function waitForServerPendingSeq(
  seam: PositionTestSeam,
  sessionId: string,
  expectedSeq: number,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tryResolve = (): boolean => {
      if (seam.pendingSeqs.get(sessionId) === expectedSeq) {
        resolve()
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

/** A(사수)의 눈높이에서 B(피격자)의 바디 중심을 겨누는 조준 벡터(원장
 * 20f) — `rq-14-death-kill-credit.test.ts`/`rq-15-respawn-timer.test.ts`의
 * `aimAtBody`와 동일 산식(파일마다 자기 완결 복제, 저장소 관례). */
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
 * A의 사격으로 B를 사망(hp=0)까지 몰아간다(원장 20f) — `rq-14`/`rq-15`
 * (GA-08/GA-09)의 킬 헬퍼와 동일 목적이나, 이 파일은 이미 화이트박스
 * `seam`을 갖고 있으므로 서버 자체 상태(관측 지점 (a), 클라 패치 배치
 * 지연과 무관)로 hp를 직접 추적한다. 부위(헤드/바디) 무관 설계 — "몇
 * 발에 죽는가"의 정밀 산술은 GA-08(`sim-combat.test.ts`·
 * `rq-14-death-kill-credit.test.ts`)이 이미 고정했다, 이 헬퍼는 "죽여서
 * 사망 상태를 준비"만 한다. B 자신의 최초 입장 스폰 보호(RQ-16)를 먼저
 * 자기-빗나감 사격으로 즉시 해제한다(`rq-14`/`rq-15`와 동일 패턴).
 * **REV(RQ-31 회귀 대응)**: 화이트박스(`firedSinceSpawn`)로 해제한다 —
 * 자기 사격은 B 자신의 Safe Zone(거리 0)에 막힐 수 있다. **호출자가 이미
 * A·B를 Safe Zone 밖으로 옮겨 뒀다는 전제**다(이 함수는 위치를 건드리지
 * 않는다).
 */
async function killVictim(
  seam: PositionTestSeam,
  roomA: Room,
  roomB: Room,
  aim: { dirX: number; dirY: number; dirZ: number },
): Promise<PositionSnapshot> {
  seam.firedSinceSpawn.set(roomB.sessionId, true)

  let previousHp: number = PLAYER.MAX_HP
  const MAX_KILL_SHOTS = 4 // 바디샷만 맞을 때의 상한(헤드샷이 섞이면 더 일찍 끝난다) — GA-08 근거
  for (let shot = 1; shot <= MAX_KILL_SHOTS && previousHp > 0; shot += 1) {
    roomA.send('fire', aim)
    const afterShot = await waitForServerCondition(
      seam,
      roomB.sessionId,
      (s) => s.hp !== previousHp,
      `RQ-61/20f: ${shot}번째 사격 후 B의 서버 hp 변화 대기(직전 hp=${previousHp})`,
      SNAPSHOT_TIMEOUT_MS,
    )
    previousHp = afterShot.hp
    if (previousHp > 0) await sleep(BETWEEN_SHOTS_MS)
  }
  const atDeath = readServerPosition(seam, roomB.sessionId)
  if (!atDeath) throw new Error('RQ-61/20f: 사망 직후 B의 서버 상태 관측 실패')
  expect(atDeath.hp).toBe(0)
  return atDeath
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  it(
    'RQ-61/GA-15 확장(원장 20f — 사망 상태 회귀 방지): 사망(시신) 상태의 B가 참칭 좌표를 실은 move를 보내도, (a) 서버 자체 상태와 (b) A의 브로드캐스트 시야 양쪽 모두 사망 시점 위치 그대로다 — hp=0을 관측 시점에 재확인해 리스폰(3초)과 경합하지 않는다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수 + 크로스뷰 관찰자
      const roomB = await joinGame(newClient(server)) // 피격자 → 시신 → 스푸퍼
      const seam = getServerRoom(roomA) // GA-29: 서버 전역 단일 룸 — roomA·roomB가 같은 룸

      const baselineA = await waitForServerCondition(
        seam,
        roomA.sessionId,
        () => true,
        'RQ-61/20f: A 초기 서버 스냅샷',
        SNAPSHOT_TIMEOUT_MS,
      )
      const baselineB = await waitForServerCondition(
        seam,
        roomB.sessionId,
        () => true,
        'RQ-61/20f: B 초기 서버 스냅샷',
        SNAPSHOT_TIMEOUT_MS,
      )
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      // RQ-31 회귀 대응 — A·B 둘 다 Safe Zone 밖으로 옮긴다. 그러지 않으면
      // A의 킬 시퀀스 사격 자체가 GA-19에 막히고, B가 Safe Zone 안에
      // 있으면 RQ-16과 무관하게 GA-11이 계속 피해를 무효화한다.
      const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
      const escapedB = escapeSafeZone(seam, roomB.sessionId, baselineB)
      await sleep(RELEASE_PROTECTION_SETTLE_MS)

      const aim = aimAtBody(escapedA, escapedB)
      const atDeathServer = await killVictim(seam, roomA, roomB, aim)
      expect(atDeathServer.hp).toBe(0) // 재확인 1/3 — 사망 직후(서버 상태)

      // 크로스뷰(A)로도 사망을 확인한다 — 이후 "사망 시점 위치"의 크로스뷰
      // 기준점이 된다(GA-15 then "다른 플레이어에게 브로드캐스트").
      const atDeathCross = await waitForCrossViewCondition(
        roomA,
        roomB.sessionId,
        (s) => s.hp === 0,
        'RQ-61/20f: A 시야 — B의 사망(hp=0) 관측 대기',
      )
      expect(atDeathCross.hp).toBe(0) // 재확인 2/3 — 사망 직후(크로스뷰)

      // 참칭 시도 — 시신이 맵 안쪽 참칭 좌표(GA-15 given과 동일 형태,
      // `IN_MAP_SPOOF`)를 실은 'move'를 보낸다. 방향 입력은 정지로
      // 둔다(사망자의 방향 이동 자체는 `rq-15`의 "사망자 갭" 케이스가 이미
      // 고정했다 — 이 테스트가 확인하려는 것은 절대 좌표 참칭 쪽이다).
      const SPOOF_SEQ = 9001 // B는 사망 전까지 'move'를 전혀 보내지 않았다(`killVictim`은 'fire'만 쓴다) — pendingSeqs가 아직 없어 임의 양수로 충분히 구별된다.
      roomB.send('move', {
        dirX: 0,
        dirZ: 0,
        mode: 'run',
        jump: false,
        seq: SPOOF_SEQ,
        x: IN_MAP_SPOOF.x,
        y: IN_MAP_SPOOF.y,
        z: IN_MAP_SPOOF.z,
      })

      // 수신 확인(단조 신호) — `lastProcessedInputSeq`는 시신에게 절대
      // 오르지 않으므로(파일 상단 REV 절 참고) `pendingSeqs`를 대신 쓴다.
      await waitForServerPendingSeq(
        seam,
        roomB.sessionId,
        SPOOF_SEQ,
        SNAPSHOT_TIMEOUT_MS,
        'RQ-61/20f: 서버가 시신의 참칭 move(seq=9001)를 수신했는지 대기',
      )

      // 정착 대기 — 여러 서버 틱이 지날 시간을 준다(파일 상단
      // `CORPSE_SETTLE_MS` 코멘트 참고. C1류 회귀가 있었다면 이 창 안에
      // 이미 위치가 바뀌어 있었을 것이다).
      await sleep(CORPSE_SETTLE_MS)

      // (a) 서버 자체 상태 — "센티넬이 아니다"가 아니라 "사망 시점 위치
      // 그 값이다"를 단언한다(RQ-61 F1 교훈과 동일 형태, 위 두 번째
      // `it()` 참고).
      const afterServer = readServerPosition(seam, roomB.sessionId)
      expect(afterServer?.hp).toBe(0) // 재확인 3/3 — 아직 리스폰되지 않았다(경합 없음)
      expect(afterServer?.x).toBeCloseTo(atDeathServer.x, 5)
      expect(afterServer?.y).toBeCloseTo(atDeathServer.y, 5)
      expect(afterServer?.z).toBeCloseTo(atDeathServer.z, 5)

      // (b) A의 브로드캐스트 시야에서도 동일하게 사망 시점 위치 그대로여야
      // 한다(GA-15 then "다른 플레이어에게 브로드캐스트").
      const afterCross = readCrossViewPosition(roomA, roomB.sessionId)
      expect(afterCross?.hp).toBe(0)
      expect(afterCross?.x).toBeCloseTo(atDeathCross.x, 5)
      expect(afterCross?.y).toBeCloseTo(atDeathCross.y, 5)
      expect(afterCross?.z).toBeCloseTo(atDeathCross.z, 5)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    20_000,
  )
})
