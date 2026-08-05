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
 * **REV(전면 재설계, team-lead 지시·coder 실측)**: 이전 버전은 경계 콘
 * 반경에서 hp 결과의 hit/miss로 "시드가 다른가"를 간접 관측했다 — coder가
 * 몬테카를로(2만 회)로 이 설계의 치명적 결함을 수치로 찾았다: 그 경계에서
 * seed=0의 hit-rate는 13.96%이고, **두 독립 랜덤 시행이 서로 다른 쪽에
 * 떨어질 확률은 `2p(1-p)`**(약 24.0%)뿐이다 — **salt가 완벽히 구현돼도
 * 이 단언은 약 24%만 통과한다**(실측 14회 중 4회 pass=28.6%, 수치와 부합).
 * both-miss(74%)·both-hit(2%)는 salt가 옳게 동작해도 "같음"으로 실패한다.
 * 콘 반경·기하를 어떻게 고쳐도 이 문제는 못 피한다 — 이진(hit/miss) 경계
 * 하나로 "다르다"를 보는 한 확률은 항상 그 경계의 hit-rate로 정해진다.
 *
 * **재설계**: `issueSpreadSeed()`가 내놓는 **시드 값 자체**를 화이트박스로
 * 직접 비교한다(기하·경계 확률에 전혀 기대지 않는다 — flaky 0). 22w
 * 문면이 요구하는 것은 "제품 **시드 발급** 경로"의 커버리지이지 편차·
 * 명중 판정이 아니다 — 시드→편차→hp 배선은 `forcedSpreadSeed` 계열의
 * 기존 테스트들이 이미 덮는다(책임 분리). 아래 (1)이 이 핵심 검증이다.
 *
 * hp 관측 경로는 완전히 버리지 않는다(발급된 salt가 실제로 `applySpread`
 * 까지 도달하는 배선 자체가 끊기면 — 이 라운드의 F1/F3류 배선 누락 결함과
 * 같은 계열 — 아무도 못 잡는다) — 대신 **결정론적으로 만들 수 있는 형태**
 * (`forcedRoomSalt`를 서로 다른 **고정값** 둘로 주입, 랜덤 없음)로만
 * 남긴다. 아래 (2)가 이 배선 확인이다.
 *
 * **tick 레이스도 이 재설계로 함께 사라진다**: (1)은 `issueSpreadSeed()`를
 * 화이트박스로 **직접(동기) 호출**한다 — 네트워크 메시지가 전혀 없으므로
 * "왕복 중 틱이 넘어간다"는 레이스 자체가 성립할 여지가 없다(async 경계가
 * 없는 한 줄짜리 동기 블록). (2)도 `'fire'` 메시지 대신 `handleFire()`를
 * 직접 호출해 같은 이유로 레이스를 없앤다.
 *
 * **`forcedSpreadSeed`를 쓰지 않는다(변함없는 핵심 전제)**: 아래
 * `SeedSaltTestSeam`에 그 필드를 아예 선언하지 않았다 — 시드는 오직
 * `issueSpreadSeed()`(제품 경로, (1)) 또는 그 경로가 소비하는
 * `forcedRoomSalt`((2), 제품 경로의 salt 소스만 교체)만 거친다.
 *
 * **화이트박스 메서드 호출(신규 관례, 이 라운드부터)**: `issueSpreadSeed`·
 * `handleFire`는 `private` 메서드이지만 TypeScript의 `private`는 컴파일
 * 타임 표시일 뿐 런타임에 접근을 막지 않는다(`#private` ES 문법이 아니다)
 * — 이 파일의 다른 필드 화이트박스(`spreadTuningOverride` 등)와 동일한
 * `as unknown as SeedSaltTestSeam` 결합으로 메서드도 그대로 호출 가능하다.
 * `handleFire`를 직접 부르는 것은 "네트워크 전송 계층"만 우회할 뿐(공격
 * 표면 자체가 전송 계층이 아니라 시드 예측 가능성이므로 22w 범위 밖이
 * 아니다) `effectiveSpreadConeRadius`·`applySpread`·`raycastHitbox`·
 * 데미지 적용까지 실제 로직은 전부 그대로 실행한다 — 이 저장소가 이미
 * 확립한 "화이트박스는 검증 대상 로직을 우회하지 않는다"는 원칙과 같다.
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
 * 탄다)를 타입 수준에서도 강제한다. `spreadSeedCounter`는 `GameRoom.ts:308`
 * 의 기존 private 필드를 이 파일이 처음으로 화이트박스 읽기 대상에
 * 추가한다(그린필드 아님 — 필드 자체는 이미 있었다). `state.players`는
 * `RewindTestSeam`(`rq-64-lag-compensation-bound.test.ts`)과 동일한 최소
 * 형태로, 클라 폴링 없이 서버 자신의 상태를 동기로 직접 읽는다.
 *
 * **`issueSpreadSeed`·`handleFire`(신규, 메서드 화이트박스)**: 위 파일
 * 상단 REV의 재설계 핵심 — 시드 발급과 사격 처리를 네트워크·기하 없이
 * 직접 호출해 관측한다.
 *
 * **`forcedRoomSalt`(team-lead 확정 사항)**: blocker 1(coder)이 노출할
 * 시드 재현용 오버라이드 — `spreadTuningOverride`·`forcedSpreadSeed`와
 * 동일한 private-field 패턴(`onCreate(options)` 경유는 `MatchMaker.js`의
 * `merge({}, clientOptions, handler.options)`가 목록에 없는 키를 클라
 * 값 그대로 통과시켜 위험하다는 것이 team-lead 실측으로 확정됨). **오늘은
 * 존재하지 않는다**(Red 전제). */
interface SeedSaltTestSeam extends SafeZoneEscapeSeam<unknown> {
  state: {
    tick: number
    players: { get: (sessionId: string) => { hp?: number } | undefined }
  }
  spreadTuningOverride?: SpreadTuning
  spreadSeedCounter: number
  forcedRoomSalt?: number
  /** 프로덕션 자연 salt(읽기 전용, 이미 구현됨) — `GameRoom.ts:344`
   * `private readonly spreadSalt: number = Math.floor(Math.random() *
   * 0x100000000) >>> 0`, 룸 생성 시점(생성자, `onCreate`보다 먼저) 정확히
   * 1회 발급되고 그 뒤 불변이다. **이름을 바꾸지 않는다**(team-lead 확정 —
   * `forcedRoomSalt`와 짝을 이루는 이름, 두 세션이 갈리지 않게 못 박음).
   * (3)의 보강 단언이 이 필드를 직접 읽어 override 우선순위와 무관하게
   * `onCreate` 시점의 옵션 오염 여부를 그 자리에서 직접 관측한다. */
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

/** `rq-90-spread-seed-determinism.test.ts`와 동일한 오프라인 오라클
 * 기법 — 이미 결정론이 고정된 순수 함수(`applySpread`+`raycastHitbox`)를
 * 그대로 호출한다. (2)의 결정론적 배선 확인에만 쓰인다 — (1)은 이 기하를
 * 전혀 참조하지 않는다. */
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

// --- 모듈 스코프 기하 확정((2)의 결정론적 배선 확인 전용, 오프라인 계산) ---

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

/** `seed`(오늘 공식의 tick=0·counter=0 결과) 기준 hit→miss 전환 콘 반경을
 * 이분탐색으로 찾는다. `loHit`은 hit, `hiMiss`는 miss라는 사전조건은
 * 스크래치 검증으로 확인했다(`_workspace/RQ-90-spread/01_test-writer_red.md`
 * §17.2·§20 — 0.1=hit, 0.15=miss). */
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

/** (2) 전용 — coder의 실제 `issueSpreadSeed()` 공식
 * (`createRng(forcedRoomSalt ?? spreadSalt).fork(state.tick).fork(counter)
 * .nextU32()`, `GameRoom.ts` REV — "forcedRoomSalt를 진짜 salt로 교정")을
 * 그대로 재현해 오프라인으로 시드를 계산한다.
 *
 * **REV(오라클 재계산, coder 리뷰 대응)**: 최초 버전은 `forcedRoomSalt`가
 * `fork` 없이 그대로 반환된다고 가정해 `SALT_HIT=0`·`SALT_MISS=1`을
 * 하드코딩했다 — coder가 리뷰 지적으로 `forcedRoomSalt`도 `spreadSalt`
 * 자리에서만 대체되고 `fork(tick)`·`fork(counter)`는 그대로 거치도록
 * 교정했다(salt라는 이름과 실제 동작을 일치시키기 위함, `forcedSpreadSeed`
 * 와의 역할 중복 해소). 그 결과 이 파일의 (2) 오프라인 오라클이 더 이상
 * 맞지 않아 1건 실패했다(coder 커밋 메시지가 직접 통보) — `fork(tick)`이
 * 섞이므로 "이 salt가 hit인지 miss인지"가 **관측된 tick에 따라 달라진다**
 * (하드코딩된 고정 salt로는 tick이 조금만 달라져도 깨진다, 아래 스윕
 * 실측 — tick=0에서 hit인 salt 7이 tick=1에서는 miss). 그래서 이제
 * `BOUNDARY_CONE_RADIUS_RAD`와 같은 정신으로 **런타임에 관측된 tick
 * 기준으로 오프라인 검색**한다(`findSeedWithBucket`과 동일 기법 — 하드
 * 코딩된 매직넘버가 아니다). */
function effectiveSeedForSalt(salt: number, tick: number, counter: number): number {
  return createRng(salt).fork(tick).fork(counter).nextU32()
}

/** 관측된 `tick`·`counter`(둘 다 두 룸에서 이미 같음이 확인된 값) 기준으로,
 * 서로 다른 `forcedRoomSalt` 두 개(하나는 hit, 하나는 miss)를 오프라인
 * 이분 없는 순차 탐색으로 찾는다 — 결정론적 순수 계산이라 수천 회도
 * 밀리초 미만(`findSeedWithBucket`과 동일 근거). */
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
      `RQ-90 22w(2) 전제 위반 — tick=${tick}·counter=${counter}에서 salt 0..${searchLimit - 1} 안에 ` +
        `hit·miss 쌍을 못 찾았다(hitSalt=${String(hitSalt)}, missSalt=${String(missSalt)}) — 탐색 상한을 늘려야 한다.`,
    )
  }
  return { hitSalt, missSalt }
}
/** 탐색 상한 — 순수 결정론 계산이라 느리지 않다(`rq-90-spread-seed
 * -determinism.test.ts`의 `SEARCH_LIMIT`과 동일 근거). */
const ROOM_SALT_SEARCH_LIMIT = 5_000

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
      '(제품 시드 발급 경로 직접 비교, 기하·경계 확률 없음 — flaky 0) — 오늘은 Red',
    async () => {
      // 병렬 생성 — 순차 생성이면 두 룸의 "tick=0 시작 시각"이 그 왕복
      // 시간만큼 벌어져 구조적 편향이 생긴다(§17.4 실측 이력). 병렬 생성은
      // 그 편향을 줄인다. 이 테스트는 추가로 **네트워크 자체가 없어**
      // (아래 동기 블록) 레이스 여지가 훨씬 더 작다.
      const clientA = newClient(server)
      const clientB = newClient(server)
      const [roomA, roomB] = await Promise.all([createRoom(clientA, 'roomA'), createRoom(clientB, 'roomB')])
      rooms.push(roomA, roomB)
      expect(roomA.roomId).not.toBe(roomB.roomId) // 전제 확인 — 정말 독립된 두 인스턴스인가

      const seamA = getServerRoom(roomA)
      const seamB = getServerRoom(roomB)

      // 전제 가드 — 첫 호출 전이므로 spreadSeedCounter는 반드시 0이다
      // (경합 아님, issueSpreadSeed가 호출된 적이 없어 구조적으로 보장).
      if (seamA.spreadSeedCounter !== 0 || seamB.spreadSeedCounter !== 0) {
        throw new Error(
          `RQ-90 22w(1) 전제 위반 — 첫 호출 전인데 spreadSeedCounter가 0이 아니다` +
            `(A=${seamA.spreadSeedCounter}, B=${seamB.spreadSeedCounter})`,
        )
      }

      // ⚠️ 동기 블록 — 아래 네 줄 사이에 `await`가 전혀 없다. JS 단일
      // 스레드이므로 이 블록 실행 도중에는 어떤 타이머 콜백(RQ-60 틱
      // 스케줄러 포함)도 끼어들 수 없다 — 네트워크 메시지가 아예 없으므로
      // "왕복 중 틱 경과"라는 레이스 자체가 성립할 여지가 없다.
      const tickA = seamA.state.tick
      const seedA = seamA.issueSpreadSeed()
      const tickB = seamB.state.tick
      const seedB = seamB.issueSpreadSeed()

      // 전제 가드 — 그런데도 두 룸의 tick 자체가 애초에(생성 시점부터)
      // 다를 수는 있다(병렬 생성으로 줄였을 뿐 0으로 만들지는 못한다) —
      // 다르면 "같은 tick" 비교 조건이 성립하지 않으므로 즉시·명확하게
      // 실패시킨다.
      if (tickA !== tickB) {
        throw new Error(
          `RQ-90 22w(1) 전제 위반 — 두 룸의 tick이 다르다(A=${tickA}, B=${tickB}) — ` +
            `"같은 tick·같은 counter" 비교 조건이 이번 실행에서 성립하지 않았다(재실행 필요).`,
        )
      }

      // ⚠️ 이 단언은 coder의 실제 issueSpreadSeed() 공식이 무엇이든 성립
      // 해야 한다(구현 공식에 안 묶인 비교식 — team-lead 지시). 룸마다
      // 서로 다른 salt(coder 구현: `spreadSalt`, 룸 생성 시 1회 랜덤 발급)
      // 가 실제로 섞인다면 같은 tick·counter=0에서도 두 룸의 시드는
      // 달라야 한다 — salt가 없다면(과거 공식 `(tick<<16)^counter`처럼)
      // 완전히 같은 입력이 완전히 같은 시드를 내므로 이 단언은 실패한다.
      expect(seedA).not.toBe(seedB)
    },
  )

  it(
    '(2) forcedRoomSalt를 서로 다른 고정값(0·1)으로 주입하면 실제 hp 결과가 결정론적으로 갈린다' +
      '(발급된 salt가 applySpread까지 실제로 도달하는지 확인 — 배선 누락 방지, 랜덤 없음 — flaky 0)',
    async () => {
      const clientP1 = newClient(server)
      const clientQ1 = newClient(server)
      const [roomP1, roomQ1] = await Promise.all([createRoom(clientP1, 'roomP'), createRoom(clientQ1, 'roomQ')])
      rooms.push(roomP1, roomQ1)

      const clientP2 = newClient(server)
      const clientQ2 = newClient(server)
      const [roomP2, roomQ2] = await Promise.all([
        joinRoomById(clientP2, roomP1.roomId, 'roomP 피격자'),
        joinRoomById(clientQ2, roomQ1.roomId, 'roomQ 피격자'),
      ])
      rooms.push(roomP2, roomQ2)

      const seamP = getServerRoom(roomP1)
      const seamQ = getServerRoom(roomQ1)

      const baselineP = readHp(seamP, roomP2.sessionId)
      const baselineQ = readHp(seamQ, roomQ2.sessionId)
      expect(baselineP).toBe(PLAYER.MAX_HP)
      expect(baselineQ).toBe(PLAYER.MAX_HP)

      escapeSafeZone(seamP, roomP1.sessionId, SHOOTER_BASE)
      releaseSpawnProtectionAndEscape(seamP, roomP2.sessionId, TARGET_BASE)
      escapeSafeZone(seamQ, roomQ1.sessionId, SHOOTER_BASE)
      releaseSpawnProtectionAndEscape(seamQ, roomQ2.sessionId, TARGET_BASE)

      const tuning: SpreadTuning = { coneRadiusRad: BOUNDARY_CONE_RADIUS_RAD, movingMultiplier: 2, airborneMultiplier: 4 }
      seamP.spreadTuningOverride = tuning
      seamQ.spreadTuningOverride = tuning

      if (seamP.spreadSeedCounter !== 0 || seamQ.spreadSeedCounter !== 0) {
        throw new Error(
          `RQ-90 22w(2) 전제 위반 — 첫 사격 전인데 spreadSeedCounter가 0이 아니다` +
            `(P=${seamP.spreadSeedCounter}, Q=${seamQ.spreadSeedCounter})`,
        )
      }
      const tickP = seamP.state.tick
      const tickQ = seamQ.state.tick
      if (tickP !== tickQ) {
        throw new Error(`RQ-90 22w(2) 전제 위반 — 두 룸의 tick이 다르다(P=${tickP}, Q=${tickQ}) — 재실행 필요.`)
      }

      // 관측된 tick(두 룸이 같음을 위에서 이미 확인) 기준으로 hit·miss
      // salt 쌍을 그 자리에서 검색한다 — 하드코딩된 고정값이 아니다(위
      // "REV(오라클 재계산)" 참고, `fork(tick)`이 섞이므로 salt의 hit/miss
      // 여부가 tick에 따라 달라진다).
      const { hitSalt, missSalt } = findRoomSaltPair(tickP, 0, BOUNDARY_CONE_RADIUS_RAD, ROOM_SALT_SEARCH_LIMIT)
      seamP.forcedRoomSalt = hitSalt
      seamQ.forcedRoomSalt = missSalt

      // 네트워크 없이 직접 호출 — 'fire' 메시지 왕복이 사라져 레이스가
      // 발생할 여지가 없다(파일 상단 REV "화이트박스 메서드 호출" 참고).
      seamP.handleFire(roomP1.sessionId, { dirX: AIM.x, dirY: AIM.y, dirZ: AIM.z, rttMs: 0 })
      seamQ.handleFire(roomQ1.sessionId, { dirX: AIM.x, dirY: AIM.y, dirZ: AIM.z, rttMs: 0 })

      const afterP = readHp(seamP, roomP2.sessionId)
      const afterQ = readHp(seamQ, roomQ2.sessionId)
      if (afterP === undefined || afterQ === undefined) {
        throw new Error('RQ-90 22w(2) — 사격 후 관측 실패(피격자 상태를 읽지 못했다)')
      }

      // 오늘(솔트 미구현)은 `forcedRoomSalt`가 무시되고 P·Q 둘 다 같은
      // tick·counter=0의 자연 공식(그게 무엇이든)을 쓰므로 반드시 같다 —
      // 그래서 이 단언(다르다)은 오늘 Red다. Green 이후 실제로 배선되면
      // P는 hitSalt(명중 확정)·Q는 missSalt(빗나감 확정)를 강제로 써
      // 반드시 갈린다 — 결정론(0%/100%), 랜덤 확률에 기대지 않으므로
      // flaky가 없다.
      expect(afterP).not.toBe(afterQ)
    },
  )

  it(
    '(3) 클라 join 옵션에 임의의 salt류 키를 실어 보내도 서버가 실제로 쓰는 시드는 그 옵션과 무관하다' +
      '(coder가 착수 전 실측한 MatchMaker.js 함정 — merge({}, clientOptions, handler.options)는 ' +
      'handler.options에 없는 키를 클라 값 그대로 통과시킨다 — 의 재발 방지 그물) — ' +
      '비교식(구현 공식 무관) + 네트워크 없는 직접 호출(flaky 0, 22w 재설계 반영)',
    async () => {
      // 절대 예측(오늘의 공식) 대신 비교식을 쓴다(team-lead 지적 반영,
      // 이전 REV) — 악의적 옵션을 받은 룸 X와 받지 않은 룸 Y에 같은
      // `forcedRoomSalt`를 주입하고, 같은 tick·spreadSeedCounter=0에서
      // 두 룸의 결과가 같은지만 본다:
      //   - 오늘(솔트 미구현): `forcedRoomSalt`가 무시되고 X·Y 둘 다 같은
      //     공식(어떤 공식이든) → 같다. 통과.
      //   - Green 이후: 양쪽이 주입된 같은 salt를 쓰고 옵션은 안 읽힌다
      //     → 같다. 통과.
      //   - 옵션이 시드에 섞이면: X만 salt가 오염돼 갈린다 → 실패.
      //
      // ⚠️ 한계(§19.2에서 이미 지적) — team-lead가 인정한 대로 이 비교식
      // 단독으로는 "override가 옵션보다 우선한다"만 증명한다. `forcedRoomSalt`
      // 를 `onCreate` **이후에** 주입하는 이상, 옵션 오염이 `onCreate` 시점에
      // 이미 벌어졌어도 override가 그 뒤 전부 덮어써 오염 자체는 이 비교로
      // 관측 못 한다. **보강**(아래, team-lead 지시): 프로덕션이 이미 구현한
      // 자연 salt(`spreadSalt`, `GameRoom.ts:344`)를 override 없이 직접
      // 읽어 그 한계를 override 우선순위와 무관하게 닫는다 — 아래 비교식
      // 단언은 그대로 둔다(서로 다른 성질이라 둘 다 지킬 가치가 있다).
      //
      // **REV(22w 전면 재설계 반영)**: 이 (3)도 이전엔 `room.send('fire')`
      // +`waitForTickAtLeast`(네트워크 왕복)를 썼다 — (1)(2)와 통일해
      // `handleFire()` 직접 호출로 바꿔 잔여 tick 레이스를 제거한다.
      const FORCED_SALT_FOR_COMPARISON = 424242
      const MALICIOUS_OPTION_SALT = 999999999

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
      // 순위와 전혀 무관하게 옵션 오염 여부를 그 자리에서 본다.
      const clientX1b = newClient(server)
      const clientX1c = newClient(server)
      const [roomX1b, roomX1c] = await Promise.all([
        createRoom(clientX1b, '악의적 옵션(룸 X, 2번째)', { spreadSaltOverride: MALICIOUS_OPTION_SALT }),
        createRoom(clientX1c, '악의적 옵션(룸 X, 3번째)', { spreadSaltOverride: MALICIOUS_OPTION_SALT }),
      ])
      rooms.push(roomX1b, roomX1c)
      const seamX1b = getServerRoom(roomX1b)
      const seamX1c = getServerRoom(roomX1c)

      // 전제 가드 — `spreadSalt`는 coder의 blocker 1 구현(`GameRoom.ts:344`)
      // 대상이다. 그 구현이 아직 이 워크트리의 커밋 이력에 없으면(예: 메인
      // 트리에 미커밋 WIP로만 존재) 화이트박스 읽기가 `undefined`를 반환해
      // 아래 (a)(b) 비교가 "undefined !== undefined"류의 의미 없는 실패로
      // 흐려진다 — 그러기 전에 명시적으로, 무엇이 문제인지 알 수 있게
      // 실패시킨다(이 저장소의 "정확한 전제 실시간 재확인" 관례).
      if (
        typeof seamX.spreadSalt !== 'number' ||
        typeof seamX1b.spreadSalt !== 'number' ||
        typeof seamX1c.spreadSalt !== 'number'
      ) {
        throw new Error(
          'RQ-90 22w(3) 보강 전제 위반 — spreadSalt가 number가 아니다' +
            `(X=${String(seamX.spreadSalt)}, X1b=${String(seamX1b.spreadSalt)}, X1c=${String(seamX1c.spreadSalt)}) — ` +
            'coder의 spreadSalt 구현(GameRoom.ts:344)이 이 워크트리의 커밋 이력에 아직 없다는 뜻이다.',
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
      const tickX = seamX.state.tick
      const tickY = seamY.state.tick
      if (tickX !== tickY) {
        throw new Error(`RQ-90 22w(3) 전제 위반 — 두 룸의 tick이 다르다(X=${tickX}, Y=${tickY}) — 재실행 필요.`)
      }

      seamX.handleFire(roomX1.sessionId, { dirX: AIM.x, dirY: AIM.y, dirZ: AIM.z, rttMs: 0 })
      seamY.handleFire(roomY1.sessionId, { dirX: AIM.x, dirY: AIM.y, dirZ: AIM.z, rttMs: 0 })

      const afterX = readHp(seamX, roomX2.sessionId)
      const afterY = readHp(seamY, roomY2.sessionId)
      if (afterX === undefined || afterY === undefined) {
        throw new Error('RQ-90 22w(3) — 사격 후 관측 실패(피격자 상태를 읽지 못했다)')
      }

      // 악의적 옵션을 받은 룸(X)과 받지 않은 룸(Y)이 같은 forcedRoomSalt·
      // 같은 tick·같은 counter에서 **같은 결과**를 내야 한다 — 옵션이
      // 조금이라도 시드에 섞였다면 X만 갈려 이 단언이 깨진다.
      expect(afterX).toBe(afterY)
    },
  )
})
