import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { applySpread, eyeOrigin, raycastHitbox, type Vec3 } from '@shared/sim/combat'
import { createRng } from '@shared/sim/rng'
import { DEFAULT_HITBOX, type SpreadTuning } from '@shared/config/combat-tuning'
import { PLAYER } from '@shared/constants'
import { SPAWN_POINTS } from '@shared/sim/spawn'
import { escapeSafeZone, releaseSpawnProtectionAndEscape, computeRadialEscape, type SafeZoneEscapeSeam } from '../support/safe-zone'

/**
 * RQ-90/22v·22w — 제품 시드 발급 경로(`GameRoom.issueSpreadSeed`) 커버리지
 * (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직은 Red-first 영역).
 *
 * **매핑된 골든 케이스**: 없음 — 이 파일은 GA를 닫지 않는다. 리뷰 blocker
 * 22v(원장 22v 착수 트리거 미처리 — "탄퍼짐이 도입 즉시 무력화된 채
 * 출하된다")·22w(제품 시드 발급 경로 커버리지 0)에 대응한다.
 *
 * **REV(전면 재설계 1차, team-lead 지시·coder 실측)**: 이전 버전은 경계 콘
 * 반경에서 hp 결과의 hit/miss로 "시드가 다른가"를 간접 관측했다 — coder가
 * 몬테카를로(2만 회)로 이 설계의 치명적 결함을 수치로 찾았다: 그 경계에서
 * seed=0의 hit-rate는 13.96%이고, 두 독립 랜덤 시행이 서로 다른 쪽에
 * 떨어질 확률은 `2p(1-p)`(약 24.0%)뿐이다 — salt가 완벽히 구현돼도 이
 * 단언은 약 24%만 통과한다. `issueSpreadSeed()`가 내놓는 **시드 값 자체**를
 * 화이트박스로 직접 비교하는 것으로 바꿔 기하·경계 확률 의존을 제거했다.
 *
 * **REV(전면 재설계 2차, team-lead 지시) — (2) 재설계 + tick 주입**:
 *
 * 1. **`forcedRoomSalt` 계약이 재교정됐다**(coder, 리뷰 지적 대응): 처음엔
 *    `fork`를 건너뛰고 시드를 그대로 반환해(`forcedSpreadSeed`와 기능
 *    중복) "salt"라는 이름과 실제 동작이 어긋났다 — 지금은
 *    `createRng(forcedRoomSalt ?? spreadSalt).fork(tick).fork(counter)`로
 *    salt **자리에서만** 대체하고 `fork(tick)`·`fork(counter)`는 그대로
 *    거친다. (2)의 옛 오프라인 오라클(salt를 그대로 seed로 가정)이 이
 *    교정으로 깨졌다.
 * 2. **(2)를 hp 기반에서 시드 기반으로 재설계**(team-lead 제안 채택) —
 *    hp 수준의 "시드→명중" 배선은 `forcedSpreadSeed` 계열의 기존 테스트가
 *    이미 덮으므로 (2)가 중복할 이유가 없었다: (1)이 "자연 salt 두 룸 →
 *    시드가 다르다"를 보이고, (2)는 **같은** `forcedRoomSalt`를 두 룸에
 *    주입했을 때 "시드가 같다"를 보인다 — 둘을 합치면 "salt가 시드를
 *    가르는 원인"이라는 인과가 닫힌다. 오라클도 확률도 필요 없다(순수
 *    비교, 결정론 100%).
 *
 *    **REV(델타 평가 FAIL G-1, team-lead 지시) — "같다"만으로는 fork
 *    우회를 못 잡는다**: `seedP===seedQ`는 **대칭 조작에 무감각**하다 —
 *    `forcedRoomSalt`가 `fork(tick)`·`fork(counter)`를 건너뛰고(리뷰가
 *    잡아 `724da06`으로 고친 바로 그 결함, "M-nofork" 변이) salt 값을
 *    그대로 반환해도 두 룸이 **똑같이** 우회하므로 여전히 같다 — 평가자
 *    변이 실측으로 7/7 미검출 확인됨. **수정**: "같다"에 더해 **기대값을
 *    명시적으로 못박는다** — `effectiveSeedForSalt`(coder의 실제 공식을
 *    그대로 재현, (3)의 오프라인 오라클과 동일 함수)가 예측하는 정확한
 *    값과 실제 값이 같은지 확인한다. 이 한 줄이 M-nofork를 죽인다(§31.1
 *    에서 격리 워크트리 재현으로 직접 확인).
 * 3. **(1)(2)(3) 전부 tick을 관측 대신 주입한다**(team-lead 지시,
 *    coder의 실측이 근거) — 이전엔 두 룸의 tick이 "우연히 같기를" 기다린
 *    뒤 전제 가드로 확인했다. coder가 전체 파일 10회는 항상 결정론적
 *    이었지만 `-t "(3)"`로 **(3)만 격리 실행**하면 5회 중 3회 tick
 *    불일치 가드가 발화하는 것을 관측했다 — "앞선 (1)(2)가 서버를
 *    워밍업해 줘서 (3)이 안정적"이라는 **숨은 결합**이었다(순서가
 *    바뀌거나 `--shard`·`-t`가 쓰이면 조용히 깨진다). `seam.state.tick`을
 *    양쪽 룸에 같은 고정값으로 **써서** tick을 구조적으로 동일하게
 *    만든다 — 전제 가드 자체가 불필요해지고, 워밍업·실행 순서·`-t` 필터와
 *    무관해진다(§27.1에서 쓰기 부작용 여부를 직접 확인했다 — 결과 없음).
 *
 * hp 관측 경로는 완전히 버리지 않는다 — (3)이 여전히 `handleFire()`+hp
 * 비교로 "발급된 salt가 실제로 `applySpread`까지 도달하는가"(배선 누락
 * 방지, F1/F3류 결함 재발 방지)와 "join 옵션이 시드에 안 섞이는가"(22v)
 * 둘 다 결정론적 형태(고정 salt)로 남겨 확인한다.
 *
 * **`forcedSpreadSeed`를 쓰지 않는다(변함없는 핵심 전제)**: 아래
 * `SeedSaltTestSeam`에 그 필드를 아예 선언하지 않았다 — 시드는 오직
 * `issueSpreadSeed()`(제품 경로) 또는 그 경로가 소비하는 `forcedRoomSalt`
 * (salt 소스만 교체)만 거친다.
 *
 * **화이트박스 메서드/필드 호출**: `issueSpreadSeed`·`handleFire`는
 * `private` 메서드지만 TypeScript의 `private`는 컴파일 타임 표시일 뿐
 * 런타임 접근을 막지 않는다(`#private` ES 문법이 아니다) — 이 파일의
 * 다른 필드 화이트박스와 동일한 `as unknown as SeedSaltTestSeam` 결합으로
 * 메서드도, `state.tick` 같은 필드도 그대로 읽고 쓸 수 있다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000

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

/** `joinOrCreate`가 아니라 `create`다 — 기존 룸에 합류할 가능성을 완전히
 * 배제하고 **항상 새 룸 인스턴스**를 강제한다(colyseus.js `Client.create`
 * 계약, `node_modules/colyseus.js/lib/Client.d.ts`). 이 파일의 핵심 전제
 * (독립된 두 룸 인스턴스 비교)가 여기서 성립한다. */
async function createRoom(client: Client, label: string, options?: Record<string, unknown>): Promise<Room> {
  return withTimeout(client.create(ROOM_NAME, options), JOIN_TIMEOUT_MS, `create('${ROOM_NAME}') ${label}`)
}

async function joinRoomById(client: Client, roomId: string, label: string): Promise<Room> {
  return withTimeout(client.joinById(roomId), JOIN_TIMEOUT_MS, `joinById('${roomId}') ${label}`)
}

async function leaveRoom(room: Room): Promise<void> {
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

/** 화이트박스 접근 대상 — `rq-90-spread-seed-determinism.test.ts`의
 * `SpreadTestSeam`과 동일한 `as unknown as` 결합 관례. **`forcedSpreadSeed`를
 * 의도적으로 선언하지 않는다** — 이 파일의 핵심 전제(제품 발급 경로만
 * 탄다)를 타입 수준에서도 강제한다. `spreadSeedCounter`는 `GameRoom.ts`의
 * 기존 private 필드를 이 파일이 화이트박스 읽기 대상에 추가한다(그린필드
 * 아님 — 필드 자체는 이미 있었다). `state.players`는 `RewindTestSeam`
 * (`rq-64-lag-compensation-bound.test.ts`)과 동일한 최소 형태로, 클라
 * 폴링 없이 서버 자신의 상태를 동기로 직접 읽는다.
 *
 * **`state.tick`을 이 라운드부터 쓰기 대상으로도 쓴다** — `moveStates`·
 * `spreadTuningOverride`와 동일한 화이트박스 관례(§27.1에서 부작용 없음을
 * 직접 확인했다, 아래 참고).
 *
 * **`forcedRoomSalt`**: blocker 1(coder)이 노출한 시드 재현용 오버라이드
 * — `spreadTuningOverride`·`forcedSpreadSeed`와 동일한 private-field
 * 패턴. **REV**: 최초 구현("값 그대로 반환")은 coder 스스로 리뷰 지적으로
 * "salt 자리에서만 대체, `fork(tick)`·`fork(counter)`는 그대로 거침"으로
 * 교정했다 — 지금은 진짜 salt 대체다. */
interface SeedSaltTestSeam extends SafeZoneEscapeSeam<unknown> {
  state: {
    tick: number
    players: { get: (sessionId: string) => { hp?: number } | undefined }
  }
  spreadTuningOverride?: SpreadTuning
  spreadSeedCounter: number
  forcedRoomSalt?: number
  /** 프로덕션 자연 salt(읽기 전용, 이미 구현됨) — `GameRoom.ts`
   * `private readonly spreadSalt: number = Math.floor(Math.random() *
   * 0x100000000) >>> 0`, 룸 생성 시점(생성자, `onCreate`보다 먼저) 정확히
   * 1회 발급되고 그 뒤 불변이다. **이름을 바꾸지 않는다**(team-lead 확정 —
   * `forcedRoomSalt`와 짝을 이루는 이름). (3)의 보강 단언이 이 필드를
   * 직접 읽어 override 우선순위와 무관하게 `onCreate` 시점의 옵션 오염
   * 여부를 그 자리에서 직접 관측한다. */
  readonly spreadSalt: number
  issueSpreadSeed: () => number
  handleFire: (shooterId: string, input: { dirX: number; dirY: number; dirZ: number; rttMs: number }) => void
}

function getServerRoom(room: Room): SeedSaltTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as SeedSaltTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-90 22w 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** 룸 생성 직후 `state.players`에서 hp를 직접 읽는다(클라 폴링 없음 —
 * `onJoin`은 서버가 join 확인 응답을 보내기 **전에** 이미 완료되므로,
 * `create`/`joinById` 프라미스가 풀린 시점엔 이 항목이 이미 존재한다). */
function readHp(seam: SeedSaltTestSeam, sessionId: string): number | undefined {
  return seam.state.players.get(sessionId)?.hp
}

/** 이 라운드부터 tick을 관측 대신 **주입**한다(파일 상단 REV 2차 참고) —
 * 모든 `it()`이 이 값을 두 룸에 동일하게 써서 tick을 구조적으로 맞춘다.
 * 임의의 큰 값을 쓴다(0 근방의 자연값과 우연히 겹치지 않게 하려는 의도일
 * 뿐 특별한 의미는 없다 — `issueSpreadSeed`가 tick 자체의 크기에 상한을
 * 두지 않는다, `fork(salt)`가 32비트 정수를 그대로 받는다). */
const FIXED_TICK = 7_777_777

/** (2) 전용 — 두 룸에 주입할 **같은** `forcedRoomSalt`. 값 자체는 임의다
 * (검증 대상은 "같은 salt를 넣으면 같은 시드가 나오는가"이지 이 값의
 * 크기가 아니다). */
const SAME_FORCED_SALT_FOR_SEED_EQUALITY = 555_555

/** (3) 전용 — 악의적 join 옵션에 실어 보낼 값. */
const MALICIOUS_OPTION_SALT = 999_999_999

/** (3)의 hp 기반 배선 확인에만 필요한 오프라인 오라클 — `rq-90-spread
 * -seed-determinism.test.ts`와 동일 기법(이미 결정론이 고정된 순수 함수
 * `applySpread`+`raycastHitbox`를 그대로 호출). (1)(2)는 이 기하를 전혀
 * 참조하지 않는다(순수 시드 비교라 기하 자체가 필요 없다). */
function bodyCenterM(): number {
  return (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
}

function aimAtBody(shooterFoot: { x: number; z: number }, targetFoot: { x: number; z: number }): Vec3 {
  const dx = targetFoot.x - shooterFoot.x
  const dz = targetFoot.z - shooterFoot.z
  const dy = bodyCenterM() - DEFAULT_HITBOX.eyeHeightM
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { x: dx / distance, y: dy / distance, z: dz / distance }
}

const SHOOTER_BASE_CANDIDATE = SPAWN_POINTS[0]
const TARGET_BASE_CANDIDATE = SPAWN_POINTS[1]
if (!SHOOTER_BASE_CANDIDATE || !TARGET_BASE_CANDIDATE) {
  throw new Error('RQ-90 22w 테스트 전제 위반 — SPAWN_POINTS에 슬롯 0·1이 없다')
}
const SHOOTER_BASE = SHOOTER_BASE_CANDIDATE
const TARGET_BASE = TARGET_BASE_CANDIDATE
const ESCAPED_SHOOTER = computeRadialEscape(SHOOTER_BASE)
const ESCAPED_TARGET = computeRadialEscape(TARGET_BASE)
const AIM = aimAtBody(ESCAPED_SHOOTER, ESCAPED_TARGET)
const ORIGIN: Vec3 = eyeOrigin({ x: ESCAPED_SHOOTER.x, y: 0, z: ESCAPED_SHOOTER.z }, DEFAULT_HITBOX.eyeHeightM)
const TARGET_FOOT: Vec3 = { x: ESCAPED_TARGET.x, y: 0, z: ESCAPED_TARGET.z }

function isHitAtCone(seed: number, coneRadiusRad: number): boolean {
  const deviated = applySpread(AIM, createRng(seed), coneRadiusRad)
  return raycastHitbox({ origin: ORIGIN, direction: deviated }, { position: TARGET_FOOT }, DEFAULT_HITBOX).hit
}

/** coder의 실제 `issueSpreadSeed()` 공식(`createRng(salt).fork(tick)
 * .fork(counter).nextU32()`)을 오프라인에서 그대로 재현한다. `FIXED_TICK`
 * 을 주입하므로 이 값은 항상 그 tick 기준으로 계산된다(런타임에 관측한
 * tick에 의존하지 않는다 — tick 자체가 이제 상수이기 때문이다). */
function effectiveSeedForSalt(salt: number, tick: number, counter: number): number {
  return createRng(salt).fork(tick).fork(counter).nextU32()
}

/** `FIXED_TICK`·`counter=0` 기준으로 hit·miss `forcedRoomSalt` 쌍을 오프
 * 라인 순차 탐색으로 찾는다(`rq-90-spread-seed-determinism.test.ts`의
 * `findSeedWithBucket`과 동일 기법 — 하드코딩된 매직넘버가 아니다).
 * tick이 이제 고정 상수이므로 이 탐색도 **모듈 스코프에서 한 번만**
 * 실행하면 된다(런타임 재탐색 불필요 — tick이 더 이상 관측값이 아니다). */
function findRoomSaltPair(
  tick: number,
  counter: number,
  coneRadiusRad: number,
  searchLimit: number,
): { hitSalt: number; missSalt: number } {
  let hitSalt: number | undefined
  let missSalt: number | undefined
  for (let salt = 0; salt < searchLimit; salt += 1) {
    const hit = isHitAtCone(effectiveSeedForSalt(salt, tick, counter), coneRadiusRad)
    if (hit && hitSalt === undefined) hitSalt = salt
    if (!hit && missSalt === undefined) missSalt = salt
    if (hitSalt !== undefined && missSalt !== undefined) break
  }
  if (hitSalt === undefined || missSalt === undefined) {
    throw new Error(
      `RQ-90 22w 전제 위반 — tick=${tick}·counter=${counter}에서 salt 0..${searchLimit - 1} 안에 ` +
        `hit·miss 쌍을 못 찾았다(hitSalt=${String(hitSalt)}, missSalt=${String(missSalt)}) — 탐색 상한을 늘려야 한다.`,
    )
  }
  return { hitSalt, missSalt }
}

function findHitMissBoundary(seed: number, loHit: number, hiMiss: number): number {
  let lo = loHit
  let hi = hiMiss
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2
    if (isHitAtCone(seed, mid)) lo = mid
    else hi = mid
  }
  return lo
}

const BOUNDARY_SAFETY_MARGIN = 0.002
const BOUNDARY_CONE_RADIUS_RAD = findHitMissBoundary(0, 0.1, 0.15) - BOUNDARY_SAFETY_MARGIN
/** (3) 전용 — 비교식(옵션 유출 검사)에 쓸 공통 `forcedRoomSalt`. `FIXED_TICK`
 * ·`counter=0` 기준으로 경계 콘에 걸리는 salt를 골라 쓴다(`hitSalt`를
 * 취하고 `missSalt`는 버린다 — (3)은 "같은 salt를 넣으면 같은 결과가
 * 나오는가"만 보므로 hit 쪽이든 miss 쪽이든 상관없지만, 경계에 가까운
 * 값을 써야 X의 결과가 조금이라도 오염되면 hit/miss가 갈려 드러난다 —
 * 임의의 값이면 오염이 있어도 우연히 "같은 버킷"에 남아 공허해질 위험이
 * 있다). `FIXED_TICK`이 이제 상수이므로 이 탐색도 모듈 스코프에서 한
 * 번만 실행한다(런타임 재탐색 불필요). */
const SEARCH_LIMIT = 5_000
const { hitSalt: FORCED_SALT_FOR_COMPARISON } = findRoomSaltPair(FIXED_TICK, 0, BOUNDARY_CONE_RADIUS_RAD, SEARCH_LIMIT)

describe('RQ-90/22v·22w — 제품 시드 발급 경로(issueSpreadSeed) 커버리지: 룸 인스턴스별 salt 검증', () => {
  let server: RunningServer
  const rooms: Room[] = []

  beforeAll(async () => {
    server = await startServer()
  })

  afterAll(async () => {
    for (const room of rooms) {
      try {
        await leaveRoom(room)
      } catch {
        // 이미 서버가 닫혔거나 세션이 끊긴 경우 — 정리 실패는 이 테스트의
        // 판정에 영향을 주지 않으므로 무시한다(다른 RQ-90 파일과 동일 관례).
      }
    }
    await stopServer(server)
  })

  it(
    '(1) 같은 tick·같은 spreadSeedCounter(둘 다 0)에서 issueSpreadSeed()가 두 독립 룸 인스턴스에서 서로 다른 시드를 낸다' +
      '(제품 시드 발급 경로 직접 비교, 기하·경계 확률 없음, tick 주입으로 타이밍 의존 제거 — flaky 0)',
    async () => {
      const clientA = newClient(server)
      const clientB = newClient(server)
      const [roomA, roomB] = await Promise.all([createRoom(clientA, 'roomA'), createRoom(clientB, 'roomB')])
      rooms.push(roomA, roomB)
      expect(roomA.roomId).not.toBe(roomB.roomId) // 전제 확인 — 정말 독립된 두 인스턴스인가

      const seamA = getServerRoom(roomA)
      const seamB = getServerRoom(roomB)

      // 전제 확인(타이밍 무관, 구조적 보장) — 첫 호출 전이므로
      // spreadSeedCounter는 반드시 0이다(issueSpreadSeed가 호출된 적이
      // 없다).
      if (seamA.spreadSeedCounter !== 0 || seamB.spreadSeedCounter !== 0) {
        throw new Error(
          `RQ-90 22w(1) 전제 위반 — 첫 호출 전인데 spreadSeedCounter가 0이 아니다` +
            `(A=${seamA.spreadSeedCounter}, B=${seamB.spreadSeedCounter})`,
        )
      }

      // tick을 **주입**한다(관측 후 가드하는 대신) — 두 룸의 tick이
      // 우연히 같기를 기다리지 않는다. 워밍업·실행 순서·`-t` 격리 필터와
      // 무관해진다(파일 상단 REV 2차 참고).
      seamA.state.tick = FIXED_TICK
      seamB.state.tick = FIXED_TICK

      const seedA = seamA.issueSpreadSeed()
      const seedB = seamB.issueSpreadSeed()

      // 이 단언은 coder의 실제 issueSpreadSeed() 공식이 무엇이든 성립
      // 해야 한다(구현 공식에 안 묶인 비교식). 룸마다 서로 다른 자연
      // salt(`spreadSalt`, 룸 생성 시 1회 랜덤 발급)가 실제로 섞인다면
      // 같은 tick(주입)·counter=0에서도 두 룸의 시드는 달라야 한다.
      expect(seedA).not.toBe(seedB)
    },
  )

  it(
    '(2) 같은 forcedRoomSalt를 두 독립 룸에 주입하면(같은 tick·counter=0) issueSpreadSeed()가 fork(tick).fork(counter)를 ' +
      '실제로 거친 정확한 값을 낸다((1)과 짝을 이뤄 "salt가 시드를 가르는 원인"이라는 인과를 닫고, fork 우회(M-nofork류)를 ' +
      '직접 검정한다 — 확률·오라클·기하 불필요, flaky 0)',
    async () => {
      // hp 수준의 "시드→명중" 배선은 (3)과 `forcedSpreadSeed` 계열의
      // 기존 테스트가 이미 덮는다 — 이 테스트는 순수하게 시드 발급
      // 자체만 본다. 사수·피격자 쌍이 필요 없다(룸 생성자 세션 하나면
      // 충분 — issueSpreadSeed는 tick·counter·salt만 읽는다).
      const clientP = newClient(server)
      const clientQ = newClient(server)
      const [roomP, roomQ] = await Promise.all([createRoom(clientP, 'roomP'), createRoom(clientQ, 'roomQ')])
      rooms.push(roomP, roomQ)
      expect(roomP.roomId).not.toBe(roomQ.roomId)

      const seamP = getServerRoom(roomP)
      const seamQ = getServerRoom(roomQ)

      if (seamP.spreadSeedCounter !== 0 || seamQ.spreadSeedCounter !== 0) {
        throw new Error(
          `RQ-90 22w(2) 전제 위반 — 첫 호출 전인데 spreadSeedCounter가 0이 아니다` +
            `(P=${seamP.spreadSeedCounter}, Q=${seamQ.spreadSeedCounter})`,
        )
      }

      seamP.state.tick = FIXED_TICK
      seamQ.state.tick = FIXED_TICK
      // **같은** forcedRoomSalt를 양쪽에 주입한다 — (1)과 반대 극성.
      seamP.forcedRoomSalt = SAME_FORCED_SALT_FOR_SEED_EQUALITY
      seamQ.forcedRoomSalt = SAME_FORCED_SALT_FOR_SEED_EQUALITY

      const seedP = seamP.issueSpreadSeed()
      const seedQ = seamQ.issueSpreadSeed()

      // 같은 salt·같은 tick(주입)·같은 counter(0) → 시드가 같아야 한다.
      // (1)이 "자연 salt가 다르면 시드가 다르다"를 보였고, 이 테스트가
      // "salt를 같게 하면 차이가 사라진다"를 더해 — salt가 실제로 시드를
      // 가르는 유일한 원인임을 인과적으로 닫는다.
      expect(seedP).toBe(seedQ)

      // ⚠️ REV(델타 평가 FAIL G-1 수정, team-lead 지시) — 위 단언 하나만으로는
      // `forcedRoomSalt`가 `fork(tick)`·`fork(counter)`를 건너뛰고(리뷰가
      // 지적해 `724da06`으로 고친 바로 그 결함, "M-nofork" 변이) 시드 값
      // 그 자체를 그대로 반환해도 **똑같이 통과한다** — 두 룸이 대칭으로
      // 같은 값을 우회해서 반환하면 여전히 "같다"이기 때문이다(평가자
      // 변이 실측: 7종 중 M-nofork만 7/7 미검출). "같다"에 더해 **기대값이
      // 무엇인지**를 명시적으로 못박아야 fork 우회가 갈린다 —
      // `effectiveSeedForSalt`(coder의 실제 공식을 그대로 재현, 위 (3)의
      // 오프라인 오라클과 동일 함수)가 예측하는 값과 실제로 일치하는지
      // 확인한다. `forcedRoomSalt`가 fork를 우회해 salt 값 그대로
      // (=555_555)를 반환한다면 이 단언이 즉시 깨진다(§31.1에서 이 변이를
      // 직접 재현해 실제로 죽는지 확인했다).
      expect(seedP).toBe(effectiveSeedForSalt(SAME_FORCED_SALT_FOR_SEED_EQUALITY, FIXED_TICK, 0))
    },
  )

  it(
    '(3) 클라 join 옵션에 임의의 salt류 키를 실어 보내도 서버가 실제로 쓰는 시드는 그 옵션과 무관하다' +
      '(coder가 착수 전 실측한 MatchMaker.js 함정 — merge({}, clientOptions, handler.options)는 ' +
      'handler.options에 없는 키를 클라 값 그대로 통과시킨다 — 의 재발 방지 그물) — ' +
      '비교식(구현 공식 무관) + 네트워크 없는 직접 호출 + tick 주입(flaky 0)',
    async () => {
      // 절대 예측(오늘의 공식) 대신 비교식을 쓴다(team-lead 지적 반영) —
      // 악의적 옵션을 받은 룸 X와 받지 않은 룸 Y에 같은 `forcedRoomSalt`
      // 를 주입하고, 같은 tick(주입)·spreadSeedCounter=0에서 두 룸의
      // 결과가 같은지만 본다.
      //
      // ⚠️ 한계(변함없음, `_workspace/RQ-90-spread/01_test-writer_red.md`
      // §19.2 참고): `forcedRoomSalt`가 다운스트림에서 절대 우선하므로,
      // 이 비교는 "override가 옵션보다 우선한다"를 증명할 뿐 "옵션이
      // 자연 spreadSalt에 전혀 안 섞인다" 그 자체는 못 잡을 수 있다 —
      // 아래 보강(spreadSalt 직접 관측)이 그 한계를 override와 무관하게
      // 닫는다.
      const clientX1 = newClient(server)
      const clientY1 = newClient(server)
      const [roomX1, roomY1] = await Promise.all([
        createRoom(clientX1, '악의적 옵션(룸 X)', { spreadSaltOverride: MALICIOUS_OPTION_SALT }),
        createRoom(clientY1, '옵션 없는 비교군(룸 Y)'),
      ])
      rooms.push(roomX1, roomY1)

      const seamX = getServerRoom(roomX1)
      const seamY = getServerRoom(roomY1)

      // --- 보강(team-lead 지시, §19.2 한계 해소) ---
      // 같은 악의적 옵션으로 만든 룸을 2개 더(합쳐서 3개) 만들어 자연
      // salt(`spreadSalt`)를 override 없이 직접 읽는다 — `onCreate`가
      // 이미 실행된 뒤의 실제 값이므로, override(`forcedRoomSalt`) 우선
      // 순위와 전혀 무관하게 옵션 오염 여부를 그 자리에서 본다. tick과
      // 무관한 검사라 주입이 필요 없다.
      const clientX1b = newClient(server)
      const clientX1c = newClient(server)
      const [roomX1b, roomX1c] = await Promise.all([
        createRoom(clientX1b, '악의적 옵션(룸 X, 2번째)', { spreadSaltOverride: MALICIOUS_OPTION_SALT }),
        createRoom(clientX1c, '악의적 옵션(룸 X, 3번째)', { spreadSaltOverride: MALICIOUS_OPTION_SALT }),
      ])
      rooms.push(roomX1b, roomX1c)
      const seamX1b = getServerRoom(roomX1b)
      const seamX1c = getServerRoom(roomX1c)

      if (
        typeof seamX.spreadSalt !== 'number' ||
        typeof seamX1b.spreadSalt !== 'number' ||
        typeof seamX1c.spreadSalt !== 'number'
      ) {
        throw new Error(
          'RQ-90 22w(3) 보강 전제 위반 — spreadSalt가 number가 아니다' +
            `(X=${String(seamX.spreadSalt)}, X1b=${String(seamX1b.spreadSalt)}, X1c=${String(seamX1c.spreadSalt)}) — ` +
            'coder의 spreadSalt 구현이 이 워크트리의 커밋 이력에 아직 없다는 뜻이다.',
        )
      }

      // (a) 악의적 옵션 값을 그대로 실어 보냈을 때, 구현이 `options
      // .spreadSaltOverride ?? Math.random()...` 형태였다면 `spreadSalt`가
      // 정확히 그 값이 된다 — 거짓 실패 확률 2⁻³²(32비트 랜덤 salt가 우연히
      // 이 정확한 리터럴과 같을 확률).
      expect(seamX.spreadSalt).not.toBe(MALICIOUS_OPTION_SALT)
      expect(seamX1b.spreadSalt).not.toBe(MALICIOUS_OPTION_SALT)
      expect(seamX1c.spreadSalt).not.toBe(MALICIOUS_OPTION_SALT)

      // (b) 같은 악의적 옵션으로 만든 룸 3개의 `spreadSalt`가 서로 달라야
      // 한다 — 옵션이 실제로 읽혔다면 셋 다 같은 값(=그 옵션 값)이 된다.
      expect(seamX.spreadSalt).not.toBe(seamX1b.spreadSalt)
      expect(seamX.spreadSalt).not.toBe(seamX1c.spreadSalt)
      expect(seamX1b.spreadSalt).not.toBe(seamX1c.spreadSalt)

      const clientX2 = newClient(server)
      const clientY2 = newClient(server)
      const [roomX2, roomY2] = await Promise.all([
        joinRoomById(clientX2, roomX1.roomId, '룸 X 피격자'),
        joinRoomById(clientY2, roomY1.roomId, '룸 Y 피격자'),
      ])
      rooms.push(roomX2, roomY2)

      const baselineX = readHp(seamX, roomX2.sessionId)
      const baselineY = readHp(seamY, roomY2.sessionId)
      expect(baselineX).toBe(PLAYER.MAX_HP)
      expect(baselineY).toBe(PLAYER.MAX_HP)

      escapeSafeZone(seamX, roomX1.sessionId, SHOOTER_BASE)
      releaseSpawnProtectionAndEscape(seamX, roomX2.sessionId, TARGET_BASE)
      escapeSafeZone(seamY, roomY1.sessionId, SHOOTER_BASE)
      releaseSpawnProtectionAndEscape(seamY, roomY2.sessionId, TARGET_BASE)

      const tuning: SpreadTuning = { coneRadiusRad: BOUNDARY_CONE_RADIUS_RAD, movingMultiplier: 2, airborneMultiplier: 4 }
      seamX.spreadTuningOverride = tuning
      seamY.spreadTuningOverride = tuning
      seamX.forcedRoomSalt = FORCED_SALT_FOR_COMPARISON
      seamY.forcedRoomSalt = FORCED_SALT_FOR_COMPARISON

      if (seamX.spreadSeedCounter !== 0 || seamY.spreadSeedCounter !== 0) {
        throw new Error(
          `RQ-90 22w(3) 전제 위반 — 첫 사격 전인데 spreadSeedCounter가 0이 아니다` +
            `(X=${seamX.spreadSeedCounter}, Y=${seamY.spreadSeedCounter})`,
        )
      }

      // tick을 주입한다(관측+가드 대신) — (3)만 격리 실행(`-t`)하면 5회
      // 중 3회 tick 불일치 가드가 발화했다(coder 관측, "앞선 (1)(2)의
      // 워밍업" 숨은 결합) — 주입으로 이 의존을 구조적으로 없앤다.
      seamX.state.tick = FIXED_TICK
      seamY.state.tick = FIXED_TICK

      // 네트워크 없이 직접 호출 — 'fire' 메시지 왕복이 사라져 레이스가
      // 발생할 여지가 없다.
      seamX.handleFire(roomX1.sessionId, { dirX: AIM.x, dirY: AIM.y, dirZ: AIM.z, rttMs: 0 })
      seamY.handleFire(roomY1.sessionId, { dirX: AIM.x, dirY: AIM.y, dirZ: AIM.z, rttMs: 0 })

      const afterX = readHp(seamX, roomX2.sessionId)
      const afterY = readHp(seamY, roomY2.sessionId)
      if (afterX === undefined || afterY === undefined) {
        throw new Error('RQ-90 22w(3) — 사격 후 관측 실패(피격자 상태를 읽지 못했다)')
      }

      // ⚠️ REV(델타 평가 지적 §5.2, 편측성 방지, team-lead 권고 채택) —
      // `afterX===afterY`만으로는 "둘 다 안 맞아서 우연히 같다"는 경로가
      // 열려 있다(예: 배선이 완전히 끊겨 아무 사격도 명중하지 않으면 둘 다
      // `baselineX`·`baselineY` 그대로라 "같다"가 공허하게 참이 된다).
      // `FORCED_SALT_FOR_COMPARISON`은 `hitSalt`(명중 확정, 위 모듈 스코프
      // 계산)이므로 실제로 명중해 hp가 줄어야 한다 — 이 확인이 있어야
      // 아래 "같다"가 "둘 다 정말 명중했고 그 데미지가 같다"는 뜻이 된다.
      expect(afterX).not.toBe(baselineX)

      // 악의적 옵션을 받은 룸(X)과 받지 않은 룸(Y)이 같은 forcedRoomSalt·
      // 같은 tick(주입)·같은 counter에서 **같은 결과**를 내야 한다 —
      // 옵션이 조금이라도 시드에 섞였다면 X만 갈려 이 단언이 깨진다.
      // `FORCED_SALT_FOR_COMPARISON`이 경계 콘 근방 값이라(위 모듈 스코프
      // 계산) 아주 작은 오염도 hit/miss를 갈라 드러난다.
      expect(afterX).toBe(afterY)
    },
  )
})
