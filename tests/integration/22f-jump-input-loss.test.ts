import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { MOVEMENT } from '@shared/constants'

/**
 * 원장 22f — 클라 점프 입력 유실(제품 결함) 재현 (ADR-0008: Colyseus 룸
 * 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * ## 결함 (원장 22f, RQ-18 최종 리뷰 F1)
 *
 * `src/server/rooms/GameRoom.ts`의 `pendingInputs`(private `Map<string,
 * MoveInput>`)는 엣지 트리거가 아니라 **"최근값 유지"** 모델이다 —
 * `'move'` 메시지 핸들러가 `this.pendingInputs.set(sessionId, input)`으로
 * 입력 전체를 통째로 덮어쓰고, 30Hz 틱 루프(`stepPlayerMovement`)는
 * `this.pendingInputs.get(sessionId)`로 그 시점의 값 하나만 읽어
 * `stepMovement`(`@shared/sim/movement`)에 넘긴다. 그 결과, 서버 틱(33ms)
 * 사이에 `jump:true`가 먼저 도착한 뒤 같은 틱 경계가 오기 **전에**
 * `jump:false`가 도착하면, 틱 루프는 `jump:true`를 단 한 번도 읽지 못한
 * 채 그대로 덮어써진 `jump:false`만 보게 되어 **점프가 통째로 사라진다**.
 *
 * 이 결함은 테스트 인프라만의 문제가 아니다 — 실제 플레이어가 점프 키를
 * 33ms보다 짧게(키다운~키업) 누르면 게임 안에서도 동일하게 점프가
 * 사라진다. `tests/integration/rq-18-fall-damage.test.ts`의 REV5 절이 이미
 * 이 결함을 실측으로 확정했다: "`jump:true`·`jump:false` 사이의 고정
 * 50ms를 제거하고 두 메시지를 간격 없이 연속 전송" 했더니 GA-44·GA-45·
 * GA-46·리뷰 minor 5 케이스가 전부 착지 대기 타임아웃으로 재현됐다(로컬·
 * CI 문자 단위 일치) — 이 파일은 그 재현 기법을 이 결함 자체를 향한
 * 전용 테스트로 분리한 것이다. rq-18 파일은 이 경합을 **피하는**
 * `waitForServerTakeoff`(화이트박스 폴링)로 우회했을 뿐, 결함 자체를
 * 고정하는 테스트는 없었다 — 이 파일이 그 공백을 메운다.
 *
 * ## 관련 스펙 (`harness/specs/requirements.md` 전문 인용)
 *
 * - **RQ-20**: "시스템은 걷기·달리기·점프·앉기·천천히 걷기(조용한 이동)를
 *   지원해야 한다. 앉기와 천천히 걷기는 이동 속도를 감소시켜야 한다."
 * - **RQ-61**: "시스템은 서버 권위(Server Authoritative) 모델이어야 한다.
 *   위치·HP·킬 등 모든 게임 상태의 진실 공급원은 서버이며, 클라이언트가
 *   보고한 상태는 그대로 반영하지 않아야 한다."
 * - **RQ-62**: "클라이언트는 자신의 입력을 즉시 로컬에 반영(Client
 *   Prediction)해야 하며, 서버 상태가 도착하면 차이를 조정
 *   (reconciliation)해야 한다."
 * - **RQ-92**: 점프 높이 1.0m — `@shared/constants`의 `MOVEMENT.JUMP_HEIGHT`가
 *   정본이다.
 *
 * ## 매핑된 골든 — **GA-56**(RQ-20)
 *
 * 이 파일이 작성될 당시에는 매핑된 골든이 없었다(신규 결함 재현). 독립 평가
 * PASS 이후 사용자 승인으로 **GA-56이 신설**됐고 이 파일이 그 `verify`다.
 * GA-56의 `then`은 **양방향**이다 — "짧게 누른 입력이 유실되지 않는다"와
 * "한 번의 입력이 재발화해 자동 연속 점프가 되지 않는다"를 함께 요구한다.
 * 유실 금지만 적으면 *"항상 점프시킨다"* 는 구현도 정답지를 만족하는데,
 * 그것이 이 수정이 열 수 있었던 회귀이기 때문이다(아래 케이스 1·3이 각각 대응).
 *
 * GA-32(RQ-20, `tests/unit/sim-movement.test.ts`)는 "점프 입력 → 최고점
 * 1.0m 도달 → 착지"라는 **정상 경로의 물리**만 규정한다 — 입력이 두
 * 메시지로 쪼개져 한 틱 경계 안에서 경합하는 시나리오는 다루지 않는다.
 * 이 결함류를 덮는 골든은 아직 없다(팀리드 지시, 골든 신설은 사용자
 * 권한 — `harness/evals/golden/**`를 이 파일이 수정하지 않는다). 이 파일은
 * `rq-62-input-sequence-authority.test.ts`의 "RQ-62 리뷰 blocker 재현"
 * describe 블록과 동일한 성격이다 — 골든 매핑 밖에서 결함 자체를 고정하는
 * 회귀 테스트다.
 *
 * ## 레벨 판단 (ADR-0008/0011)
 *
 * `pendingInputs`는 `GameRoom`(서버 판정 로직)의 private 상태이고 순수
 * 함수로 추출돼 있지 않다 — 단위 테스트로 검증할 pure 함수가 없으므로
 * (ADR-0011의 "서버 판정 로직" red-first 대상), 이 파일 하나가 Colyseus
 * 룸 경계 통합 테스트로 결함 전체를 고정한다. `rq-18-fall-damage.test.ts`·
 * `rq-20-movement-authority.test.ts`·`rq-60-fixed-tickrate.test.ts`·
 * `rq-62-input-sequence-authority.test.ts`와 동일하게 실 WebSocket(로컬,
 * 임의 포트)에 의존한다(ADR-0008 넷코드 통합 테스트 허용 예외).
 *
 * ## 결정론 재현 기법 — 실 타이머 대기가 아니라 "틈 없는 연속 전송"
 *
 * 이 결함은 실시간 타이머의 발화 여부가 아니라 **두 네트워크 메시지의
 * 도착 순서·간격**이 원인이다. `src/shared/sim/{clock,tickDriver,scheduler}`
 * 결정론 하네스는 순수 시뮬레이션(`tests/support/harness.ts`)을 위한
 * 것이라 Colyseus 룸(실 소켓 위에서 도는 `setSimulationInterval`)에는
 * 직접 연결되지 않는다 — 이 파일이 검증할 대상은 "그 결정론 드라이버가
 * 실 네트워크 메시지 도착 타이밍과 어떻게 상호작용하는가"이므로, 오히려
 * 그 실 네트워크 조건 자체를 통제 가능하게 재현해야 한다. 채택한 방법:
 * `room.send()` 두 번을 그 사이에 `await`(이벤트 루프 양보)를 전혀 두지
 * 않고 연달아 호출한다 — 같은 동기 구간 안에서 실행되므로 두 메시지는
 * 실측으로 서버 틱(33ms)보다 훨씬 좁은 간격(로컬 WS에서 수 ms 이내)으로
 * 도착한다(`rq-18-fall-damage.test.ts` REV5가 이 기법으로 로컬·CI 양쪽에서
 * 100% 재현을 이미 확인했다 — 새로 발명한 기법이 아니라 이 저장소가 이미
 * 검증한 기법을 재사용한다). 화이트박스(`matchMaker.getLocalRoomById`)는
 * 쓰지 않는다 — `Player` 스키마의 `y` 필드만으로 충분하다
 * (`GameState.ts`의 `Player.vx`·`vy`·`vz` 주석이 "`grounded === (y === 0)`이
 * 항상 성립한다"를 이미 명문화하고 있다 — 평지 전용 이번 스코프에서는
 * `y > 0` 관측이 곧 공중 상태 관측이다).
 *
 * 점프 전체 체공 시간은 약 632ms다(`JUMP_GRAVITY_MPS2=20`·
 * `MOVEMENT.JUMP_HEIGHT=1.0`, `@shared/sim/movement` 주석 및
 * `rq-18-fall-damage.test.ts` 동일 실측 근거) — 이 파일의 관측 창은 전부
 * 그보다 넉넉한 여유를 둔다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const SNAPSHOT_TIMEOUT_MS = 5_000
/** 점프 전체 체공(≈632ms)보다 넉넉한 공중 상태(y>0) 관측 상한 — 결함이
 * 있으면(점프 자체가 사라짐) 이 상한까지 y가 계속 0이라 타임아웃된다. */
const AIRBORNE_OBSERVE_TIMEOUT_MS = 3_000
/** 착지(y=0 복귀) 관측 상한 — 이륙 확인 이후이므로 체공 시간 하나만큼의
 * 여유면 충분하다. */
const LANDING_OBSERVE_TIMEOUT_MS = 3_000
/** 착지 후 "재이륙이 없어야 한다"를 확인하는 관측 창 — 최소 한 번의 전체
 * 체공(≈632ms)보다 길어야 "재이륙 없음"이 의미를 가진다. */
const NO_SECOND_JUMP_WINDOW_MS = 1_200

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
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface PlayerSnapshot {
  x: number
  y: number
  z: number
  vx: number
}

function readPlayer(room: Room, sessionId: string): PlayerSnapshot | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; y?: unknown; z?: unknown; vx?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (
    typeof player?.x === 'number' &&
    typeof player?.y === 'number' &&
    typeof player?.z === 'number' &&
    typeof player?.vx === 'number'
  ) {
    return { x: player.x, y: player.y, z: player.z, vx: player.vx }
  }
  return undefined
}

/** predicate를 만족하는 스냅샷이 관측될 때까지 반복 확인한다("다음 한 번의
 * onStateChange"만 신뢰하면 무관한 갱신(예: 매 틱 갱신되는 `tick` 필드)을
 * 우리가 기다리는 변화로 착각하는 경합이 생긴다 —
 * `rq-20-movement-authority.test.ts`/`rq-18-fall-damage.test.ts`와 동일한
 * 정신). */
function waitForPlayerCondition(
  room: Room,
  sessionId: string,
  predicate: (p: PlayerSnapshot) => boolean,
  label: string,
  timeoutMs: number,
): Promise<PlayerSnapshot> {
  return withTimeout(
    new Promise<PlayerSnapshot>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current && predicate(current)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    timeoutMs,
    label,
  )
}

/**
 * 짧은 점프 입력(키다운~키업 간격 < 1틱)을 흉내낸다 — `jump:true`와
 * `jump:false`를 그 사이에 `await` 없이 곧바로 연달아 전송한다. 두
 * `room.send()` 호출 사이에 이벤트 루프가 서버 틱 타이머에 양보할 기회가
 * 없으므로, 두 메시지는 항상 서버 틱(33ms)보다 훨씬 좁은 간격으로
 * 도착한다 — 원장 22f가 지목한 정확한 조건("한 틱 경계 안에 jump:true→
 * jump:false 연속 도착")을 실 네트워크로 재현하는 기법이다(파일 상단
 * "결정론 재현 기법" 절, `rq-18-fall-damage.test.ts` REV5와 동일 기법).
 */
function sendJumpPulse(room: Room): void {
  room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: true })
  room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
}

describe('원장 22f — 클라 점프 입력 유실 재현 (RQ-20/RQ-61/RQ-62, 골든 없음)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    '핵심 재현: 한 틱 경계 안에 jump:true→jump:false가 연속 도착해도 점프가 발생해야 한다(y가 상승했다가 다시 0으로 복귀)',
    async () => {
      const room = await joinGame(newClient(server))
      const sessionId = room.sessionId
      const baseline = await waitForPlayerCondition(room, sessionId, () => true, '초기 스냅샷 관측', SNAPSHOT_TIMEOUT_MS)
      expect(baseline.y).toBe(0) // 스폰은 항상 접지 상태(RQ-15/16, SPAWN_POINTS 전부 y=0)

      sendJumpPulse(room)

      // 현재(결함) 상태에서는 서버가 jump:true를 단 한 번도 소비하지 못해
      // y가 영원히 0으로 남는다 — 이 대기가 타임아웃되는 것이 원장 22f의
      // 직접 증거다.
      const airborne = await waitForPlayerCondition(
        room,
        sessionId,
        (p) => p.y > 0,
        'jump:true→jump:false 연속 도착 후 공중 상태(y>0) 관측 대기 — 원장 22f 결함이면 여기서 타임아웃',
        AIRBORNE_OBSERVE_TIMEOUT_MS,
      )
      expect(airborne.y).toBeGreaterThan(0)

      const landed = await waitForPlayerCondition(
        room,
        sessionId,
        (p) => p.y === 0,
        '점프 발생 후 착지(y=0 복귀) 관측 대기',
        LANDING_OBSERVE_TIMEOUT_MS,
      )
      expect(landed.y).toBe(0)

      await leaveRoom(room)
    },
    15_000,
  )

  it(
    '계약 고정: 연속값(dirX/dirZ/mode)은 합집합이 아니라 마지막 값이 적용된다 — 엣지 비트(jump)만 예외여야 한다',
    async () => {
      const room = await joinGame(newClient(server))
      const sessionId = room.sessionId
      await waitForPlayerCondition(room, sessionId, () => true, '초기 스냅샷 관측', SNAPSHOT_TIMEOUT_MS)

      // 위 "핵심 재현"과 동일한 기법(await 없이 연속 전송)으로, 한 틱
      // 경계 안에 서로 다른 두 방향 입력이 도착하는 상황을 흉내낸다.
      // 첫 메시지(dirX:+1)는 미끼다 — 어떤 틱도 이 값을 단독으로 소비하지
      // 못하도록 두 번째 메시지(dirX:-1)로 곧바로 덮어써 보낸다. 수정된
      // 서버가 jump만 엣지(합집합)로 다루고 dirX·dirZ·mode는 여전히
      // "마지막 값"으로 다뤄야 한다는 계약을 여기서 못박는다 — 그렇지
      // 않으면(예: 방향도 함께 합쳐 상쇄·평균) 이동 감각이 완전히 달라진다.
      room.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
      room.send('move', { dirX: -1, dirZ: 0, mode: 'run', jump: false })

      const moved = await waitForPlayerCondition(
        room,
        sessionId,
        (p) => p.vx !== 0,
        '연속 두 방향 입력 처리 후 vx 반영 대기',
        SNAPSHOT_TIMEOUT_MS,
      )

      // 핵심 계약: 최종 반영된 값은 "마지막에 도착한" dirX:-1이어야 한다.
      expect(moved.vx).toBeCloseTo(-MOVEMENT.SPEED, 5)
      expect(moved.vx).toBeLessThan(0)

      await leaveRoom(room)
    },
    15_000,
  )

  it(
    '회귀 가드: 한 번의 jump:true로 인한 점프는 착지 후 스스로 재발화하지 않는다(합집합 모델의 명백한 회귀 경로 차단)',
    async () => {
      const room = await joinGame(newClient(server))
      const sessionId = room.sessionId
      const baseline = await waitForPlayerCondition(room, sessionId, () => true, '초기 스냅샷 관측', SNAPSHOT_TIMEOUT_MS)
      expect(baseline.y).toBe(0)

      // 짧은 한 번의 키 입력 — 이후 이 세션은 어떤 move도 추가로 보내지
      // 않는다(클라이언트가 완전히 유휴 상태로 전환된 것과 동일).
      sendJumpPulse(room)

      const airborne = await waitForPlayerCondition(
        room,
        sessionId,
        (p) => p.y > 0,
        '단발 점프 펄스 후 공중 상태(y>0) 관측 대기',
        AIRBORNE_OBSERVE_TIMEOUT_MS,
      )
      expect(airborne.y).toBeGreaterThan(0)

      const landed = await waitForPlayerCondition(
        room,
        sessionId,
        (p) => p.y === 0,
        '단발 점프 후 착지(y=0 복귀) 관측 대기',
        LANDING_OBSERVE_TIMEOUT_MS,
      )
      expect(landed.y).toBe(0)

      // 착지 이후 추가 move를 전혀 보내지 않은 채, 최소 한 번의 전체
      // 체공(≈632ms)보다 긴 창을 계속 관측한다. `stepGrounded`는
      // `input.jump`가 참이면 쿨다운 없이 매 틱 재이륙시키므로
      // (`@shared/sim/movement`), "틱 소비 후 엣지 비트를 되돌린다"를
      // 빠뜨린 채 합집합만 구현하면(팀리드가 지목한 회귀 경로) 마지막
      // 저장값이 계속 jump:true로 남아 착지할 때마다 무한 버니합이
      // 벌어진다 — 이 창 안에서 y가 단 한 번도 다시 0을 벗어나지
      // 않아야 한다.
      const jumpedAgain = await new Promise<boolean>((resolve) => {
        let seenSecondLiftoff = false
        const check = (): void => {
          const current = readPlayer(room, sessionId)
          if (current && current.y > 0) seenSecondLiftoff = true
        }
        room.onStateChange(check)
        setTimeout(() => resolve(seenSecondLiftoff), NO_SECOND_JUMP_WINDOW_MS)
      })
      expect(jumpedAgain).toBe(false)

      await leaveRoom(room)
    },
    20_000,
  )

  it(
    '회귀 가드: 서버가 이륙을 반영한 뒤에 jump:false를 보내는 정상 속도 입력에서는 경합이 없어 점프가 그대로 동작한다',
    async () => {
      const room = await joinGame(newClient(server))
      const sessionId = room.sessionId
      const baseline = await waitForPlayerCondition(room, sessionId, () => true, '초기 스냅샷 관측', SNAPSHOT_TIMEOUT_MS)
      expect(baseline.y).toBe(0)

      room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: true })

      const airborne = await waitForPlayerCondition(
        room,
        sessionId,
        (p) => p.y > 0,
        '정상 속도 점프 후 공중 상태(y>0) 관측 대기',
        AIRBORNE_OBSERVE_TIMEOUT_MS,
      )
      expect(airborne.y).toBeGreaterThan(0)

      // 서버가 이미 이륙을 반영했음을(패치로) 확인한 뒤에만 jump:false로
      // 되돌린다 — 실제 플레이어가 점프 키를 누르고 있다가 정상적으로
      // 떼는 순서와 동일하다. 위 "핵심 재현"과 달리 두 메시지 사이에
      // 경합이 없다.
      room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })

      const landed = await waitForPlayerCondition(
        room,
        sessionId,
        (p) => p.y === 0,
        '정상 속도 점프 후 착지(y=0 복귀) 관측 대기',
        LANDING_OBSERVE_TIMEOUT_MS,
      )
      expect(landed.y).toBe(0)

      await leaveRoom(room)
    },
    15_000,
  )
})
