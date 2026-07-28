import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { FALL_DAMAGE, PLAYER } from '@shared/constants'

/**
 * RQ-92 낙하 데미지 곡선 — 안전 높이 경계(포함)와 중간 초과값 통합 테스트
 * (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스 **GA-25**(`verify` 필드가 이 파일 경로를 정확히
 * 지정한다):
 * - given: 플레이어가 낙하 높이 3m 이하로 착지하는 경우와 5m로 착지하는
 *   경우를 각각 확인.
 * - then: 3m 이하 착지는 무피해다(즉사 임계 없음과 무관하게 3m까지는
 *   데미지 자체가 0). 5m 착지는 초과분 2m × 1m당 10데미지 = 20의 낙하
 *   데미지가 적용된다.
 *
 * **기존 커버리지와의 관계 — 순증 검출력은 0이다(원장 21b 리뷰 major M1 정정)**:
 * 이 파일이 고정하는 두 좌표(3m·5m)는 **A계층에 이미 전부 존재한다** —
 * `tests/unit/sim-fall-damage.test.ts`가 `fallDamageForHeight`를 직접 호출해
 * `0 / 0.5 / 2 / 2.9999 / 3 / 3.1 / 5 / 8 / 20 / 1000 / -5 / NaN / Infinity`를
 * 고정하고(`:85·98·99·105·109·113·117·121-122·133·137`), B계층에서도
 * `rq-18-fall-damage.test.ts`가 서버 경로로 `≈1.0m`·`8m`·`5m`·치명 낙하를
 * 관측한다. **초안 docblock이 기존 커버리지를 "두 점만"이라 적었던 것은
 * 틀렸다** — 리뷰가 실측으로 반증했다.
 *
 * 그래서 이 파일의 존재 이유는 "새로 잡는 회귀가 있어서"가 **아니다**:
 * ① 골든 GA-25의 `verify` 매핑을 이행하고 ② 같은 산술을 **B계층(서버 배선)**
 * 에서 한 번 더 관측한다. 이 저장소는 "서버도 옳고 클라도 옳은데 조합이
 * 틀린" 경계면 결함을 RQ-43·RQ-64·RQ-81에서 세 번 겪었고(원장 22m), B계층
 * 중복 관측은 그에 대한 방어다. **이 사실을 지우지 마라** — 지우면 다음
 * 사람이 이 파일을 "경계를 지키는 유일한 그물"로 오인하거나, 반대로
 * 중복이라며 삭제했다가 GA-44의 맹점(원장 21d)이 실해로 전환된다.
 *
 * **이 케이스가 잡는 변이와 못 잡는 변이(전부 실행으로 확인)**:
 * - **못 잡는다** — `fallDamageForHeight`의 조기 반환 연산자를 `<=`→`<`로
 *   뒤집는 변이는 **등가 변이(equivalent mutant)**다. 정확히 `SAFE_HEIGHT_M`
 *   에서는 초과분 `(h-SAFE)*DPM`이 이미 0이라 조기 반환 여부가 관측에 영향을
 *   주지 않는다(반증: 관련 4파일 33테스트 전부 통과).
 * - **못 잡는다** — 조기 반환 임계만 3→2로 하드코딩하고 **상수는 그대로 두는**
 *   변이. `h=3`에서 `3 <= 2`가 거짓이 되어 뺄셈 `(3-3)*10 = 0`이 반환되므로
 *   데미지가 0이고 `hp`는 100 그대로다. **초안 docblock이 이 변이에서
 *   `hp 90≠100`으로 죽는다고 적었던 것은 틀렸다** — 리뷰가 그 변이를 그대로
 *   심어 이 파일 2건이 전부 통과함을 확인했다(실패는 `sim-fall-damage.test.ts`
 *   1건뿐). `hp 90`이 나오려면 조기 반환과 뺄셈이 **함께** 움직여야 하고,
 *   그건 곧 아래의 상수 드리프트다.
 * - **잡는다** — **상수 `SAFE_HEIGHT_M` 자체의 드리프트**(3→2). 이때
 *   `afterLanding.hp`가 `90≠100`으로 죽는다. 주입값을 상수 참조가 아니라
 *   **리터럴 3**으로 고정한 이유가 여기다 — 상수 참조였다면 주입값이 상수를
 *   따라 움직여 행위 단언은 통과하고 리터럴 가드만 죽었을 것이고, 그 가드와
 *   등가인 단언은 `tests/unit/sim-fall-damage.test.ts:98`
 *   (`expect(FALL_DAMAGE.SAFE_HEIGHT_M).toBe(3)`)에 **이미 있다**. 그래서 그
 *   가드는 항진 명제가 되어 삭제했다. (초안이 그 소재지를
 *   `shared-constants.test.ts`로 지목한 것도 틀렸다 — 그 파일은 상수를
 *   리터럴로 고정하지 않고 산술 공식을 복제해 단언한다. 원장 21e.)
 * - **잡는다(5m 케이스)** — `DAMAGE_PER_METER` 계수 변형(10→15). 서로 다른
 *   두 초과분에서 동시에 정확한 선형 관계가 성립해야 하므로 자유도가 줄어든다.
 *
 * **레벨 분리(ADR-0008)**: "낙하 높이 → 데미지"의 정밀 산술 경계는
 * `tests/unit/sim-fall-damage.test.ts`(A계층, 결정론 — `fallDamageForHeight`
 * 직접 호출)가 이미 고정했다. 이 파일(B계층)은 그 산술이 실 `GameRoom`
 * 30Hz 틱 루프의 착지 판정에 실제로 배선돼 있는지를 실 WebSocket으로
 * 블랙박스 확인한다(`rq-18-fall-damage.test.ts`와 동일한 A/B 분리 정신).
 *
 * **화이트박스 기법·헬퍼(재사용이 아니라 동일 패턴 재구현)**:
 * `rq-18-fall-damage.test.ts`가 REV1~REV5(파일 상단 리비전 이력 참고)를
 * 거치며 확립한 기법 — `matchMaker.getLocalRoomById`로 `fallPeakY`·
 * `moveStates`(둘 다 RQ-18 라운드가 이미 만든 기존 계약, 신규 아님)에
 * 직접 접근해 착지 시작 높이를 **점프 전송 전**(접지 상태)에 미리 심고,
 * `jump:true`·`jump:false` 사이에는 서버가 실제로 이륙을 반영했음을
 * (`moveStates` 화이트박스 폴링) 확인한 **뒤에만** `jump:false`를 보낸다
 * — 이 순서를 지키지 않으면 두 가지 이미 실측된 함정에 걸린다: (1) 틱
 * 캐치업이 공중 구간 전체를 한 콜백에서 삼켜 관측 시점과 결과가 어긋나는
 * 경우(REV3), (2) `pendingInputs`의 "다음 메시지가 올 때까지 최근값 유지"
 * 모델 때문에 `jump:true`·`jump:false`가 겹쳐 도착하면 이륙 자체가
 * 통째로 사라지는 경우(REV5). 이 파일은 같은 기법을 새 파일에 재구현한다
 * (헬퍼를 import로 공유하지 않는다 — 골든 `verify` 경로가 파일을
 * 지정하고, 기존 통합 테스트 전부가 파일별 자기 완결 방식이다).
 *
 * **자기 사격 워밍업**: 최초 입장 스폰 보호(RQ-16, 3초)가 낙하 데미지도
 * 무효화하므로(`trackFallDamage`가 `handleFire`와 동일한 보호 게이트를
 * 재사용 — RQ-16 "모든 피해" 문면의 직접 이행), 점프 전에 위쪽으로
 * 자기 사격(`UP_MISS_AIM`, 기하학적으로 항상 빗나감)해 보호를 즉시
 * 해제한다(`rq-15/16/18` 파일들과 동일 패턴).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다
 * (ADR-0008 허용 예외 — 기존 RQ-15/16/18/61 통합 테스트와 동일). 모든
 * 대기에 상한을 강제한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const SNAPSHOT_TIMEOUT_MS = 5_000
/** 자기 사격(스폰 보호 해제)이 서버에 반영될 시간 — 기존 RQ-15/16/18
 * 파일들과 동일한 값·동일한 근거. */
const SELF_FIRE_SETTLE_MS = 300
/** 착지(y가 0으로 복귀) 관측 상한 — `rq-18-fall-damage.test.ts`
 * `LANDING_OBSERVE_TIMEOUT_MS`와 동일 값·동일 근거(실측: g=20에서
 * 약 632ms 소요, 넉넉한 여유). */
const LANDING_OBSERVE_TIMEOUT_MS = 10_000
/** `jump:true` 전송 뒤 서버가 실제로 이를 반영(이륙)했는지 확인하는
 * 상한 — `rq-18-fall-damage.test.ts` `TAKEOFF_CONFIRM_TIMEOUT_MS`와
 * 동일 근거. */
const TAKEOFF_CONFIRM_TIMEOUT_MS = 5_000
/** 서버 권위 상태(화이트박스) 폴링 간격 — `rq-18-fall-damage.test.ts`
 * `TAKEOFF_POLL_INTERVAL_MS`와 동일 값·동일 근거. */
const TAKEOFF_POLL_INTERVAL_MS = 15
/** 착지 직후 데미지 적용 틱이 반영될 시간(로컬 WS라 짧아도 충분, 여유). */
const POST_LANDING_SETTLE_MS = 300

/** GA-25: 안전 높이 "이하"(포함) 규칙의 경계 그 자체 — GA-44(0.1m 여유)와
 * 달리 정확히 3m을 주입한다. **리터럴 `3`으로 고정한다(상수 참조가 아님,
 * 평가 minor 1 수정)** — `FALL_DAMAGE.SAFE_HEIGHT_M`을 그대로 참조하면
 * 주입값이 상수를 따라 움직여, `SAFE_HEIGHT_M` 자체가 드리프트하는
 * 회귀(예: 3→2)에서 행위 단언(`afterLanding.hp`)은 통과하고 아래 파일
 * 안의 리터럴 가드만 죽는다 — 그 가드와 등가인 단언이 이미
 * `tests/unit/sim-fall-damage.test.ts:98`
 * (`expect(FALL_DAMAGE.SAFE_HEIGHT_M).toBe(3)`)에 있어 순증 커버리지가
 * 0이 된다(리뷰 major M1 정정 — 초안은 소재지를
 * `shared-constants.test.ts`로 잘못 지목했다).
 * 리터럴로 고정하면 그 회귀를 행위로도 잡는다 — 골든
 * `given` 자체가 "3m"을 리터럴 수치로 말하므로 문면과도 더 정확히
 * 대응한다. `<=`↔`<` 연산자 반전은 이 지점에서 **등가 변이**라 이 상수를
 * 무엇으로 두든 잡을 수 없다(파일 상단 docblock, 평가 blocker 2 참고). */
const SAFE_BOUNDARY_PEAK_M = 3
/** GA-25: 중간값 — 기존 `rq-18-fall-damage.test.ts`의 8m(GA-45)과 다른
 * 세 번째 좌표. (5-3)×10=20. */
const MID_OVERRIDE_PEAK_M = 5

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

interface PlayerSnapshot {
  x: number
  y: number
  z: number
  hp: number
}

function readPlayer(room: Room, sessionId: string): PlayerSnapshot | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; y?: unknown; z?: unknown; hp?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (
    typeof player?.x === 'number' &&
    typeof player?.y === 'number' &&
    typeof player?.z === 'number' &&
    typeof player?.hp === 'number'
  ) {
    return { x: player.x, y: player.y, z: player.z, hp: player.hp }
  }
  return undefined
}

/**
 * 리스너 생명주기 정본 형태(평가 blocker 1 수정,
 * `_workspace/RQ-92/02_evaluator_report.md` §9) —
 * `rq-61-server-authoritative-position.test.ts`의 `waitForCrossViewCondition`
 * (`:289-316`)과 동일한 세 규칙을 따른다: (1) 등록은 **참조**로(익명 래퍼
 * 금지 — `colyseus.js`의 `EventEmitter.remove(cb)`는 미등록 콜백을 넘기면
 * `handlers[-1]=last; pop()`을 수행해 맨 뒤 정상 핸들러를 조용히 지운다,
 * 실측 확인됨) (2) **즉시 충족되면 `onStateChange`를 아예 등록하지
 * 않는다** — 해제할 리스너 자체가 없으므로 이 경로는 처음부터 누수가
 * 없다 (3) 조건 충족 시 그 자리에서 `remove`한다. 타임아웃 reject
 * 경로의 해제는 정본 자체에도 없는 잔여 한계다(그 파일 원장 20i 항목이
 * 이미 명시 — 48개 호출부 전체를 다루는 별도 PR의 범위).
 */
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
        if (current && predicate(current)) {
          room.onStateChange.remove(tryResolve)
          resolve(current)
        }
      }
      // 즉시 충족되면 `onStateChange`를 아예 등록하지 않는다 — 해제할
      // 리스너 자체가 없으므로 이 경로는 처음부터 누수가 없다.
      const immediate = readPlayer(room, sessionId)
      if (immediate && predicate(immediate)) {
        resolve(immediate)
        return
      }
      room.onStateChange(tryResolve)
    }),
    timeoutMs,
    label,
  )
}

/** 항상 빗나가는 방향(수직 위) — 자기 자신을 쏘면 최초 입장 스폰 보호가
 * 즉시 해제된다(RQ-16). 기존 RQ-15/16/18 파일들과 동일 상수. */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

/** 화이트박스 접근 대상 계약 — `fallPeakY`·`moveStates` 둘 다
 * `rq-18-fall-damage.test.ts`가 이미 확립한 기존 필드다(신규 계약 아님). */
interface FallDamageTestSeam {
  fallPeakY: Map<string, number>
  moveStates: Map<string, { grounded: boolean }>
}

function getServerRoom(room: Room): FallDamageTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as FallDamageTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-92 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** `jump:true` 전송 뒤 서버가 그 입력을 실제로 반영(이륙)했는지 화이트
 * 박스로 확인한다 — `rq-18-fall-damage.test.ts`의 `waitForServerTakeoff`
 * (REV5)와 동일한 이유·동일한 구현. 확인 전에는 `jump:false`를 보내지
 * 않아야 `pendingInputs`의 "최근값 유지" 모델에서 두 메시지가 겹쳐
 * 이륙 자체가 사라지는 경합을 피한다. */
function waitForServerTakeoff(room: Room, sessionId: string, overridePeakM: number, timeoutMs: number): Promise<void> {
  const seam = getServerRoom(room)
  const isConfirmed = (): boolean => {
    const airborne = seam.moveStates.get(sessionId)?.grounded === false
    const alreadyLandedAndConsumed = seam.fallPeakY.get(sessionId) === undefined
    return airborne || alreadyLandedAndConsumed
  }
  return new Promise<void>((resolve, reject) => {
    if (isConfirmed()) {
      resolve()
      return
    }
    const interval = setInterval(() => {
      if (isConfirmed()) {
        clearInterval(interval)
        clearTimeout(timeout)
        resolve()
      }
    }, TAKEOFF_POLL_INTERVAL_MS)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`[timeout ${timeoutMs}ms] RQ-92: 서버 권위 상태로 이륙 반영 확인 대기(입력 덮어쓰기 방지, peak=${overridePeakM})`))
    }, timeoutMs)
  })
}

/**
 * 실제 점프를 1회 실행하고, 화이트박스로 낙하 시작 높이(`overridePeakM`)를
 * 주입한 뒤, 착지까지 관측한다 — `rq-18-fall-damage.test.ts`의
 * `jumpAndObserveLanding`(REV3/REV5)과 동일한 순서·동일한 이유:
 *
 * 1. 점프를 보내기 **전에**(접지 상태) `fallPeakY`를 심는다 — 접지
 *    상태에서는 `trackFallDamage`가 매 틱 조기 반환하므로 실제로 이륙할
 *    때까지 그대로 보존된다.
 * 2. `jump: true`를 보낸다.
 * 3. `waitForServerTakeoff`로 서버가 이 입력을 실제로 반영했음을 확인한다.
 * 4. 확인 후에만 `jump: false`(유지 입력)를 보낸다 — 착지 후 재이륙
 *    (원치 않는 버니합)을 막는다.
 * 5. 이륙 후 실제 물리가 계산하는 높이(최고 1.0m 미만, `MOVEMENT
 *    .JUMP_HEIGHT`)는 항상 주입값(3m·5m)보다 작으므로 `Math.max` 갱신에서
 *    주입값이 그대로 살아남는다(`trackFallDamage`의 러닝 최댓값 규칙).
 * 6. 착지를 `p.y === 0` **그리고** `fallPeakY`가 소비돼 사라졌음으로
 *    판정한다 — 착지 전이가 실제로 일어나야만 삭제되는 값이라, 아직
 *    이륙조차 하지 않은 접지 기준 상태(y===0)에 허위로 매칭되지 않는다.
 */
async function jumpAndObserveLanding(room: Room, overridePeakM: number): Promise<PlayerSnapshot> {
  const sessionId = room.sessionId

  getServerRoom(room).fallPeakY.set(sessionId, overridePeakM)

  room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: true })
  await waitForServerTakeoff(room, sessionId, overridePeakM, TAKEOFF_CONFIRM_TIMEOUT_MS)
  room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })

  const landed = await waitForPlayerCondition(
    room,
    sessionId,
    (p) => p.y === 0 && getServerRoom(room).fallPeakY.get(sessionId) === undefined,
    'RQ-92: 착지(y=0 복귀, 주입값 소비 확인) 관측 대기',
    LANDING_OBSERVE_TIMEOUT_MS,
  )
  await sleep(POST_LANDING_SETTLE_MS)
  const settled = readPlayer(room, sessionId)
  return settled ?? landed
}

describe('RQ-92/GA-25: 낙하 데미지 곡선 — 안전 높이 경계(3m, 포함)와 중간 초과값(5m→20)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-92/GA-25: 낙하 높이가 정확히 안전 높이(3m)이면 무피해다 — "이하"(포함) 규칙의 경계',
    async () => {
      const client = newClient(server)
      const room = await joinGame(client)

      try {
        const baseline = await waitForPlayerCondition(room, room.sessionId, () => true, '초기 스냅샷', SNAPSHOT_TIMEOUT_MS)
        expect(baseline.hp).toBe(PLAYER.MAX_HP)

        room.send('fire', UP_MISS_AIM) // 최초 입장 스폰 보호(RQ-16) 즉시 해제
        await sleep(SELF_FIRE_SETTLE_MS)

        // `SAFE_BOUNDARY_PEAK_M`은 리터럴 3(위 상수 docblock, 평가 minor 1
        // 수정) — `3 === 3`류 항진 단언은 없다. 검출력은 아래 행위 단언
        // (`afterLanding.hp`) 하나가 전부 짊어진다.
        const afterLanding = await jumpAndObserveLanding(room, SAFE_BOUNDARY_PEAK_M)

        expect(afterLanding.hp).toBe(PLAYER.MAX_HP)
      } finally {
        await leaveRoom(room)
      }
    },
    20_000,
  )

  it(
    'RQ-92/GA-25: 낙하 높이 5m 착지 → 초과분 2m × 1m당 10데미지 = 20의 낙하 데미지가 정확히 적용된다',
    async () => {
      const client = newClient(server)
      const room = await joinGame(client)

      try {
        const baseline = await waitForPlayerCondition(room, room.sessionId, () => true, '초기 스냅샷', SNAPSHOT_TIMEOUT_MS)
        expect(baseline.hp).toBe(PLAYER.MAX_HP)

        room.send('fire', UP_MISS_AIM) // 최초 입장 스폰 보호(RQ-16) 즉시 해제
        await sleep(SELF_FIRE_SETTLE_MS)

        const afterLanding = await jumpAndObserveLanding(room, MID_OVERRIDE_PEAK_M)

        const expectedDamage = (MID_OVERRIDE_PEAK_M - FALL_DAMAGE.SAFE_HEIGHT_M) * FALL_DAMAGE.DAMAGE_PER_METER
        expect(expectedDamage).toBe(20) // GA-25 given 그대로 — 리터럴로도 재확인
        expect(afterLanding.hp).toBe(PLAYER.MAX_HP - expectedDamage)
        expect(afterLanding.hp).toBe(80)
      } finally {
        await leaveRoom(room)
      }
    },
    20_000,
  )
})
