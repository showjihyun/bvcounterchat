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
 * **왜 이 파일이 필요한가**: `tests/integration/rq-90-spread-seed
 * -determinism.test.ts`·`rq-90-spread-degradation.test.ts`의 사격 관측은
 * **전부** `forcedSpreadSeed`로 서버 발급 경로(`issueSpreadSeed`)를 우회한다
 * — 그 경로 자체의 취약점(22v)을 고치는 회귀를 잡을 그물이 없었다(리뷰
 * 지적). `issueSpreadSeed`는 `((state.tick << 16) ^ spreadSeedCounter) >>> 0`
 * 로만 시드를 만든다(`GameRoom.ts:794`) — `state.tick`은 `@type('number')`로
 * **전 클라이언트에 동기화**되고, `createRng`·`applySpread`는 `src/shared`라
 * 클라 번들에 그대로 들어간다(team-lead 실측). 공격자가 서버와 비트 단위로
 * 같은 함수를 쥔 채 시드만 맞추면(`tick`은 관측 가능, `spreadSeedCounter`는
 * 룸당 0부터 1씩 증가하는 예측 가능한 값) 편차를 사전 계산해 조준으로
 * 상쇄할 수 있다 — 탄퍼짐 기능이 도입되고도 사실상 무력화된 채 출하되는
 * 상태다. 수정(룸 인스턴스별 salt 도입)은 coder 몫이고, 이 파일은 그
 * 수정이 실제로 효과가 있는지 검증할 **Red 테스트**를 이 라운드가 먼저
 * 심는다(ADR-0011 — 서버 판정 로직은 Red-first).
 *
 * **검증 술어(team-lead 회신 그대로 채택)**: "같은 tick·같은
 * spreadSeedCounter 조합이 두 **독립된 룸 인스턴스**에서 서로 다른 편차를
 * 내는가(salt가 실제로 섞이는가)". `spreadSeedCounter`는 신선한(fresh) 룸의
 * **첫 사격**이면 두 룸 다 정확히 0이다(경합 아님 — `handleFire`가 호출된
 * 적이 없으므로 구조적으로 보장된다, 위 파일들이 이미 확립한 사실). 남는
 * 변수는 `state.tick`뿐이라, 사격 직전 두 룸에서 각각 관측한 tick이
 * **실제로 같은지**를 실행 시점에 재확인하는 전제 가드를 둔다(같지 않으면
 * "같은 tick" 비교 자체가 성립하지 않으므로 즉시·명확하게 실패시킨다 —
 * 이 저장소가 반복적으로 써 온 "정확한 전제 실시간 재확인" 관례, 예:
 * `rq-90-spread-degradation.test.ts`의 `AIRBORNE_INJECT_Y_M` 재분류 가드).
 *
 * **오늘(솔트 없음)은 왜 반드시 Red인가**: `spreadSeedCounter=0`이 두 룸 다
 * 보장되고 위 가드가 `tick` 일치까지 확인한 뒤에는, 현재 공식
 * `((tick<<16)^0)>>>0`이 **완전히 동일한 입력**을 받으므로 두 룸의 시드는
 * 비트 단위로 같다 — `applySpread`가 결정론(GA-17)이므로 편차 벡터도
 * 비트 단위로 같고, 관측 가능한 유일한 신호인 피격자 hp 변화도 반드시
 * 같다. 이 파일은 "**다르다**"를 요구하므로(salt가 생기면 성립할 성질)
 * 오늘은 반드시 실패한다 — 어떤 특정 tick 값이 관측되든 무관하게(0이든,
 * 스케줄링 지연으로 1·2든) 그 값이 **두 룸에서 같기만 하면** 이 논증은
 * 항상 성립한다(아래 "관측 지점 선택" 참고).
 *
 * **관측 지점 선택 — hp만 외부 관측 가능(기존 파일과 동일 제약)**:
 * `damageForRegion`은 부위(머리/몸통)만으로 고정 데미지를 낸다 — 편차가
 * 조금 다르더라도 둘 다 "몸통 명중"이면 hp 변화가 우연히 같아 보일 수
 * 있다(민감도 부족, 거짓 통과 위험). 그래서 아래 `BOUNDARY_CONE_RADIUS_RAD`는
 * 오프라인 오라클로 **오늘 공식의 seed=0(tick=0·counter=0일 때의 결과)이
 * 명중/이탈 경계에 아슬아슬하게 걸리는 콘 반경**을 이분탐색으로 찾는다 —
 * `_workspace/RQ-90-spread/01_test-writer_red.md` §17.2에 전체 스윕·경계값
 * 실측 기록(seed=0은 hit, 시드 1~200 중 hit은 17.0%뿐 — 대부분의 "다른"
 * 시드가 miss로 갈린다). **마진 설계 규칙 예외(경계 시드 탐색)**에 해당한다
 * — 이 파일의 목적 자체가 "이 특정 경계에서 결과가 바뀌는가"이므로(원장
 * 22y 규칙, `tests/support/safe-zone.ts` `DEFAULT_SAFE_ZONE_ESCAPE_OFFSET_M`
 * 코멘트 참고).
 *
 * **`forcedSpreadSeed`를 쓰지 않는다(이 파일의 핵심 전제)**: 아래
 * `SeedSaltTestSeam`에 그 필드를 아예 선언하지 않았다 — 실수로도 대입할
 * 방법이 없게 타입 수준에서 막는다. 시드는 오직 서버 자신의
 * `issueSpreadSeed()`(제품 경로)만 거친다.
 *
 * **처리 확인은 hp 변화가 아니라 tick 전진으로 한다**: 빗나감(miss)이면
 * hp가 영원히 바뀌지 않아 `waitForHpChange`류 대기가 타임아웃된다 — hit·
 * miss 어느 쪽이든 균일하게 통하는 신호가 필요하다. `state.tick`은
 * RQ-60 고정 30Hz 시뮬레이션 시계라 hit·miss와 무관하게 항상 전진한다 —
 * 이 전진을 신호로 "그 사이 'fire' 처리가 끝났다"를 확인한다(고정 길이
 * 실시간 `sleep` 없이, `room.onStateChange` 이벤트 기반 대기 — 기존
 * `waitForPlayerCondition`과 동일한 세 규칙: 참조 등록·즉시 충족 시 미등록·
 * 충족 시 해제).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
const TICK_TIMEOUT_MS = 5_000

/** 'fire' 처리가 확실히 끝났음을 확인하기 위해 기다릴 최소 틱 전진 수 —
 * RQ-60 고정 30Hz(1틱≈33ms)이므로 2틱≈66ms면 로컬 WS 왕복+처리에 넉넉하다
 * (이 저장소의 기존 실측 — 통상 왕복은 한 자릿수 ms). 부족하면 타임아웃
 * (5초, 위)까지 계속 대기하므로 과소평가의 위험은 없다(이벤트 기반 대기,
 * 고정 sleep이 아니다). */
const CONFIRM_TICK_ADVANCE = 2

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
 * (독립된 두 룸 인스턴스 비교)가 여기서 성립한다 — `joinOrCreate`를 썼다면
 * 두 번째 호출이 첫 번째가 만든 같은 룸에 합류해(정원 10명 이내) 이 파일이
 * 검증하려는 "룸 인스턴스 간" 비교 자체가 무의미해진다. */
async function createRoom(client: Client, label: string): Promise<Room> {
  return withTimeout(client.create(ROOM_NAME), JOIN_TIMEOUT_MS, `create('${ROOM_NAME}') ${label}`)
}

async function joinRoomById(client: Client, roomId: string, label: string): Promise<Room> {
  return withTimeout(client.joinById(roomId), JOIN_TIMEOUT_MS, `joinById('${roomId}') ${label}`)
}

async function leaveRoom(room: Room): Promise<void> {
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface PlayerFields {
  x: number
  y: number
  z: number
  hp: number
}

function readPlayer(room: Room, sessionId: string): PlayerFields | undefined {
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

function readTick(room: Room): number | undefined {
  const state = room.state as { tick?: unknown } | null
  return typeof state?.tick === 'number' ? state.tick : undefined
}

/** 리스너 생명주기 정본 형태(`rq-90-spread-seed-determinism.test.ts`
 * `waitForPlayerCondition`과 동일한 세 규칙 — 참조 등록, 즉시 충족 시
 * 미등록, 충족 시 해제). hp가 아니라 `state.tick`을 관측 대상으로 삼아
 * hit·miss 어느 쪽이든 균일하게 통하는 "처리 완료" 신호로 쓴다(위 docblock
 * "처리 확인" 참고). */
function waitForPlayerCondition(
  room: Room,
  sessionId: string,
  predicate: (p: PlayerFields) => boolean,
  label: string,
  timeoutMs: number,
): Promise<PlayerFields> {
  return withTimeout(
    new Promise<PlayerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current && predicate(current)) {
          room.onStateChange.remove(tryResolve)
          resolve(current)
        }
      }
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

function waitForDefinedPlayer(room: Room, sessionId: string): Promise<PlayerFields> {
  return waitForPlayerCondition(room, sessionId, () => true, `초기 스냅샷(hp 포함, sessionId=${sessionId}) 관측`, HP_TIMEOUT_MS)
}

function waitForTickAtLeast(room: Room, minTick: number, label: string): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve) => {
      const tryResolve = (): void => {
        const current = readTick(room)
        if (current !== undefined && current >= minTick) {
          room.onStateChange.remove(tryResolve)
          resolve(current)
        }
      }
      const immediate = readTick(room)
      if (immediate !== undefined && immediate >= minTick) {
        resolve(immediate)
        return
      }
      room.onStateChange(tryResolve)
    }),
    TICK_TIMEOUT_MS,
    label,
  )
}

/** 화이트박스 접근 대상 — `rq-90-spread-seed-determinism.test.ts`의
 * `SpreadTestSeam`과 동일한 `as unknown as` 결합 관례. **`forcedSpreadSeed`를
 * 의도적으로 선언하지 않는다** — 이 파일의 핵심 전제(제품 발급 경로만
 * 탄다)를 타입 수준에서도 강제한다(실수로도 대입 불가). `spreadSeedCounter`
 * 는 `GameRoom.ts:308`의 기존 private 필드를 이 파일이 처음으로 화이트박스
 * 읽기 대상에 추가한다(그린필드 아님 — 필드 자체는 이미 있었다).
 *
 * **`forcedRoomSalt`(신규, Red 전제 — team-lead 확정 사항, 22v 대응 설계)**:
 * blocker 1(coder, 룸 인스턴스별 salt 도입)이 노출할 시드 재현용 오버라이드
 * 필드의 **계약**을 여기서 먼저 선언한다 — `spreadTuningOverride`·
 * `forcedSpreadSeed`와 정확히 같은 private-field 화이트박스 패턴(coder가
 * `onCreate(options)` 경유로 구현하려던 초안을 team-lead가 실측으로
 * 막았다: `MatchMaker.js`의 `merge({}, clientOptions, handler.options)`는
 * `handler.options`에 없는 키를 클라 값 그대로 통과시킨다 — 옵션 경유였다면
 * `joinOrCreate('game', { salt: X })`로 클라가 salt를 **직접 지정**할 수
 * 있었을 것이다, 아래 "옵션 도달 불가" 테스트가 이 함정의 재발을 막는다).
 * **오늘은 존재하지 않는다**(이 파일의 다른 필드들과 동일한 Red 전제 —
 * 이 라운드는 이 필드를 쓰는 테스트를 별도로 추가하지 않는다: "고정
 * salt로 재현"과 "두 룸이 다른 편차"는 team-lead가 명시적으로 나눈
 * **서로 다른 seam 사용법**이고, 위 메인 테스트는 후자에 속해 이 필드가
 * 필요 없다 — 재현용 테스트는 coder의 Green 이후, 실제 salt 소비 로직이
 * 생기면 그 계약에 맞춰 별도로 추가한다). */
interface SeedSaltTestSeam extends SafeZoneEscapeSeam<unknown> {
  state: { tick: number }
  spreadTuningOverride?: SpreadTuning
  spreadSeedCounter: number
  forcedRoomSalt?: number
}

function getServerRoom(room: Room): SeedSaltTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as SeedSaltTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-90 22w 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** `rq-90-spread-seed-determinism.test.ts`와 동일한 오프라인 오라클
 * 기법 — 이미 결정론이 고정된 순수 함수(`applySpread`+`raycastHitbox`)를
 * 그대로 호출한다. */
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

// --- 모듈 스코프 기하 확정(오프라인, 서버 없이 계산 가능 — 순수 함수만 사용) ---

/** 사수·피격자 배치 — 두 룸 다 정확히 같은 스폰 슬롯 쌍(SPAWN_POINTS[0]/[1])을
 * 쓴다. `computeRadialEscape`는 순수 함수라 두 룸에서 호출해도 항상 같은
 * 절대 좌표를 낸다 — 두 룸의 기하가 우연이 아니라 구조적으로 동일하다. */
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
 * 이분탐색으로 찾는다 — `rq-90-spread-seed-determinism.test.ts`의
 * `findSeedWithBucket`과 동일 정신(순수 결정론 계산, 수십 회 반복도 1ms
 * 미만). `loHit`은 hit, `hiMiss`는 miss라는 사전조건은 호출부(아래)가
 * 스크래치 검증으로 이미 확인했다(`_workspace/RQ-90-spread/
 * 01_test-writer_red.md` §17.2 — 0.1=hit, 0.15=miss). */
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

/** 경계보다 살짝 안쪽(hit 쪽)으로 여유를 둔다 — 이분탐색 자체의 부동소수점
 * 반복 오차를 흡수한다(60회 반복 후 lo·hi 차이는 이미 2^-60 스케일로
 * 무시 가능하지만, 여유를 명시적으로 두어 "정확히 경계선 위"라는 취약한
 * 상태에 기대지 않는다). */
const BOUNDARY_SAFETY_MARGIN = 0.002
const BOUNDARY_CONE_RADIUS_RAD = findHitMissBoundary(0, 0.1, 0.15) - BOUNDARY_SAFETY_MARGIN

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
    '같은 tick·같은 spreadSeedCounter(둘 다 0, 각 룸의 첫 사격) 조합에서도 두 독립 룸 인스턴스는 서로 다른 탄퍼짐 결과를 내야 한다' +
      '(salt 미존재 — 22v/22w, forcedSpreadSeed 미사용, 제품 발급 경로 issueSpreadSeed 그대로 관측) — 오늘은 Red',
    async () => {
      // 룸 A(사수 A1, create로 새 인스턴스 강제)·룸 B(사수 B1, 마찬가지)를
      // **병렬로** 생성한다 — 순차 생성(A 전체 왕복 완료 후 B 시작)이면 B의
      // 내부 tick 시계가 A보다 그 왕복 시간만큼 "늦게" 0부터 출발해, 이후
      // 똑같이 "곧바로" 사격해도 A의 상대 tick이 B보다 앞서는 구조적
      // 편향이 생긴다(실측: 순차 생성 3회 중 1회, 아래 사격 직전 tick이
      // A=1·B=0으로 어긋나 전제 가드가 발화했다 — `_workspace/RQ-90-spread/
      // 01_test-writer_red.md` §17.4). 병렬 생성은 두 룸의 "tick=0 시작
      // 시각"을 최대한 같은 순간에 맞춰 이 구조적 편향 자체를 줄인다(RQ-64
      // 되감기 되감기 버퍼 레이스를 타이밍이 아니라 제어 흐름으로 없앤
      // 이 저장소의 기존 해법과 같은 정신 — "더 오래 기다리기"가 아니라
      // "애초에 벌어지지 않게").
      const clientA1 = newClient(server)
      const clientB1 = newClient(server)
      const [roomA1, roomB1] = await Promise.all([createRoom(clientA1, 'roomA'), createRoom(clientB1, 'roomB')])
      rooms.push(roomA1, roomB1)

      const clientA2 = newClient(server)
      const clientB2 = newClient(server)
      const [roomA2, roomB2] = await Promise.all([
        joinRoomById(clientA2, roomA1.roomId, 'roomA target'),
        joinRoomById(clientB2, roomB1.roomId, 'roomB target'),
      ])
      rooms.push(roomA2, roomB2)

      expect(roomA1.roomId).not.toBe(roomB1.roomId) // 전제 확인 — 정말 독립된 두 인스턴스인가

      const [baselineA, baselineB] = await Promise.all([
        waitForDefinedPlayer(roomA2, roomA2.sessionId),
        waitForDefinedPlayer(roomB2, roomB2.sessionId),
      ])
      expect(baselineA.hp).toBe(PLAYER.MAX_HP)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      const seamA = getServerRoom(roomA1)
      const seamB = getServerRoom(roomB1)

      // 동일 기하 배치 — 양쪽 다 SPAWN_POINTS[0]/[1] 기반, 순수 함수라 절대
      // 좌표가 완전히 같다(위 모듈 스코프 ESCAPED_SHOOTER/ESCAPED_TARGET).
      escapeSafeZone(seamA, roomA1.sessionId, SHOOTER_BASE)
      releaseSpawnProtectionAndEscape(seamA, roomA2.sessionId, TARGET_BASE)
      escapeSafeZone(seamB, roomB1.sessionId, SHOOTER_BASE)
      releaseSpawnProtectionAndEscape(seamB, roomB2.sessionId, TARGET_BASE)

      // 동일 콘 반경 오버라이드(양쪽 다 같은 값) — forcedSpreadSeed는 절대
      // 세팅하지 않는다(이 파일의 핵심 전제, 타입에도 그 필드가 없다).
      const tuning: SpreadTuning = { coneRadiusRad: BOUNDARY_CONE_RADIUS_RAD, movingMultiplier: 2, airborneMultiplier: 4 }
      seamA.spreadTuningOverride = tuning
      seamB.spreadTuningOverride = tuning

      // 전제 가드 1 — 첫 사격 전이므로 spreadSeedCounter는 반드시 0이다
      // (경합 아님, handleFire가 호출된 적이 없어 구조적으로 보장된다).
      if (seamA.spreadSeedCounter !== 0 || seamB.spreadSeedCounter !== 0) {
        throw new Error(
          `RQ-90 22w 전제 위반 — 첫 사격 전인데 spreadSeedCounter가 0이 아니다` +
            `(A=${seamA.spreadSeedCounter}, B=${seamB.spreadSeedCounter})`,
        )
      }

      // 전제 가드 2 — 사격 직전 두 룸의 tick이 같아야 "같은 tick" 비교가
      // 성립한다. 다르면 이번 실행에서 전제 자체가 깨진 것이므로 즉시·
      // 명확하게 실패시킨다(추측으로 넘어가지 않는다).
      const tickBeforeFireA = seamA.state.tick
      const tickBeforeFireB = seamB.state.tick
      if (tickBeforeFireA !== tickBeforeFireB) {
        throw new Error(
          `RQ-90 22w 전제 위반 — 사격 직전 두 룸의 tick이 다르다(A=${tickBeforeFireA}, B=${tickBeforeFireB}) — ` +
            `"같은 tick·같은 counter" 비교 조건이 이번 실행에서 성립하지 않았다(스케줄링 지연 의심, 재실행 필요).`,
        )
      }

      // 실제 사격 — 서버 자신의 issueSpreadSeed()가 시드를 발급한다(제품 경로).
      roomA1.send('fire', { dirX: AIM.x, dirY: AIM.y, dirZ: AIM.z })
      roomB1.send('fire', { dirX: AIM.x, dirY: AIM.y, dirZ: AIM.z })

      // 처리 확인 — hp가 아니라 tick 전진으로(위 docblock "처리 확인" 참고).
      await waitForTickAtLeast(roomA1, tickBeforeFireA + CONFIRM_TICK_ADVANCE, 'roomA 처리 확인(tick 전진)')
      await waitForTickAtLeast(roomB1, tickBeforeFireB + CONFIRM_TICK_ADVANCE, 'roomB 처리 확인(tick 전진)')

      const afterA = readPlayer(roomA2, roomA2.sessionId)
      const afterB = readPlayer(roomB2, roomB2.sessionId)
      if (!afterA || !afterB) {
        throw new Error('RQ-90 22w — 사격 후 관측 실패(피격자 상태를 읽지 못했다)')
      }

      // ⚠️ 오늘(솔트 없음)은 spreadSeedCounter=0·tick 동일 → 시드가 비트
      // 단위로 같다 → applySpread 결과가 비트 단위로 같다 → hp 변화가
      // 반드시 같다. salt가 있어야(=이 단언이 요구하는 성질) 서로 달라진다
      // — 그래서 이 단언은 오늘 반드시 실패해야 정상이다(Red, ADR-0011).
      expect(afterA.hp).not.toBe(afterB.hp)
    },
  )

  it(
    '클라 join 옵션에 임의의 salt류 키를 실어 보내도 서버가 실제로 쓰는 시드는 그 옵션과 무관하다' +
      '(coder가 착수 전 실측한 MatchMaker.js 함정 — merge({}, clientOptions, handler.options)는 ' +
      'handler.options에 없는 키를 클라 값 그대로 통과시킨다 — 의 재발 방지 그물) — ' +
      '비교식(구현 공식 무관, team-lead 지시로 REV)',
    async () => {
      // **REV(team-lead 지적)**: 이전 버전은 `expectedSeed=(tickBeforeFire<<16)^0`
      // (오늘의 정확한 공식)으로 hit/miss를 예측해 실제값과 비교했다 — coder가
      // salt를 넣으면 `issueSpreadSeed`가 더 이상 이 공식이 아니므로, 그
      // 예측이 깨지고 이 단언은 **옵션과 무관하게** Green 순간 거짓 실패를
      // 낸다("코드가 무엇을 단언하는지와 주석이 다르다"는 지적 — 정확했다).
      //
      // **수정**: 절대 예측(공식) 대신 **비교식**을 쓴다 — 악의적 옵션을 받은
      // 룸 X와 받지 않은 룸 Y에 **같은 `forcedRoomSalt`**를 주입하고, 같은
      // tick·spreadSeedCounter=0에서 두 룸의 결과가 같은지만 본다:
      //   - 오늘(솔트 미구현): `forcedRoomSalt`가 무시되고 X·Y 둘 다 같은
      //     공식(어떤 공식이든) → 같다. 통과.
      //   - Green 이후(솔트 구현): 양쪽이 주입된 같은 salt를 쓰고 옵션은
      //     안 읽힌다 → 같다. 통과.
      //   - 옵션이 시드에 섞이면: X만 salt가 오염돼 갈린다 → 실패.
      // 어느 쪽도 "오늘의 정확한 공식이 무엇인가"를 가정하지 않는다.
      //
      // ⚠️ **한 가지 한계를 숨기지 않는다**: `forcedRoomSalt`가(다른 override
      // 필드 `forcedSpreadSeed`·`spreadTuningOverride`와 동일한 이 저장소의
      // 확립된 관례대로) **다운스트림에서 절대 우선**한다면(예:
      // `this.forcedRoomSalt ?? this.roomSalt`), 이 비교는 X의 "옵션이 실제로
      // `roomSalt`를 오염시켰는가" 자체를 관측하지 못할 수 있다 — 두 룸 다
      // `forcedRoomSalt`가 그 이후의 모든 자연 경로(오염됐든 아니든)를
      // 덮어써 버리기 때문이다. 즉 이 테스트가 검증하는 것은 엄밀히는
      // "override가 옵션보다 우선한다"이지 "옵션이 자연 roomSalt에 전혀
      // 섞이지 않는다" 그 자체는 아닐 수 있다. team-lead 지시를 그대로
      // 구현하되 이 한계를 명시한다 — coder의 실제 우선순위 구현을 보고
      // 필요하면 재검토한다(`_workspace/RQ-90-spread/01_test-writer_red.md`
      // §19 참고).
      const FORCED_SALT_FOR_COMPARISON = 424242

      const clientX1 = newClient(server)
      const clientY1 = newClient(server)
      const [roomX1, roomY1] = await Promise.all([
        withTimeout(
          clientX1.create(ROOM_NAME, { spreadSaltOverride: 999999999 }),
          JOIN_TIMEOUT_MS,
          `create('${ROOM_NAME}', { spreadSaltOverride }) — 악의적 옵션(룸 X)`,
        ),
        createRoom(clientY1, '옵션 없는 비교군(룸 Y)'),
      ])
      rooms.push(roomX1, roomY1)

      const clientX2 = newClient(server)
      const clientY2 = newClient(server)
      const [roomX2, roomY2] = await Promise.all([
        joinRoomById(clientX2, roomX1.roomId, '룸 X 피격자'),
        joinRoomById(clientY2, roomY1.roomId, '룸 Y 피격자'),
      ])
      rooms.push(roomX2, roomY2)

      const [baselineX, baselineY] = await Promise.all([
        waitForDefinedPlayer(roomX2, roomX2.sessionId),
        waitForDefinedPlayer(roomY2, roomY2.sessionId),
      ])
      expect(baselineX.hp).toBe(PLAYER.MAX_HP)
      expect(baselineY.hp).toBe(PLAYER.MAX_HP)

      const seamX = getServerRoom(roomX1)
      const seamY = getServerRoom(roomY1)

      escapeSafeZone(seamX, roomX1.sessionId, SHOOTER_BASE)
      releaseSpawnProtectionAndEscape(seamX, roomX2.sessionId, TARGET_BASE)
      escapeSafeZone(seamY, roomY1.sessionId, SHOOTER_BASE)
      releaseSpawnProtectionAndEscape(seamY, roomY2.sessionId, TARGET_BASE)

      const tuning = { coneRadiusRad: BOUNDARY_CONE_RADIUS_RAD, movingMultiplier: 2, airborneMultiplier: 4 }
      seamX.spreadTuningOverride = tuning
      seamY.spreadTuningOverride = tuning
      // 같은 forcedRoomSalt를 양쪽에 주입 — 오늘은 존재하지 않는 필드라
      // 무시된다(Red 전제, 위 seam 코멘트). Green 이후에는 두 룸의 자연
      // random roomSalt 차이라는 잡음을 제거해 "옵션 효과"만 남긴다.
      seamX.forcedRoomSalt = FORCED_SALT_FOR_COMPARISON
      seamY.forcedRoomSalt = FORCED_SALT_FOR_COMPARISON

      if (seamX.spreadSeedCounter !== 0 || seamY.spreadSeedCounter !== 0) {
        throw new Error(
          `RQ-90 22w(옵션 도달 불가) 전제 위반 — 첫 사격 전인데 spreadSeedCounter가 0이 아니다` +
            `(X=${seamX.spreadSeedCounter}, Y=${seamY.spreadSeedCounter})`,
        )
      }
      const tickBeforeFireX = seamX.state.tick
      const tickBeforeFireY = seamY.state.tick
      if (tickBeforeFireX !== tickBeforeFireY) {
        throw new Error(
          `RQ-90 22w(옵션 도달 불가) 전제 위반 — 사격 직전 두 룸의 tick이 다르다` +
            `(X=${tickBeforeFireX}, Y=${tickBeforeFireY}) — 재실행 필요.`,
        )
      }

      roomX1.send('fire', { dirX: AIM.x, dirY: AIM.y, dirZ: AIM.z })
      roomY1.send('fire', { dirX: AIM.x, dirY: AIM.y, dirZ: AIM.z })

      await waitForTickAtLeast(roomX1, tickBeforeFireX + CONFIRM_TICK_ADVANCE, '룸 X 처리 확인(tick 전진)')
      await waitForTickAtLeast(roomY1, tickBeforeFireY + CONFIRM_TICK_ADVANCE, '룸 Y 처리 확인(tick 전진)')

      const afterX = readPlayer(roomX2, roomX2.sessionId)
      const afterY = readPlayer(roomY2, roomY2.sessionId)
      if (!afterX || !afterY) {
        throw new Error('RQ-90 22w(옵션 도달 불가) — 사격 후 관측 실패(피격자 상태를 읽지 못했다)')
      }

      // 악의적 옵션을 받은 룸(X)과 받지 않은 룸(Y)이 같은 forcedRoomSalt·
      // 같은 tick·같은 counter에서 **같은 결과**를 내야 한다 — 옵션이
      // 조금이라도 시드에 섞였다면 X만 갈려 이 단언이 깨진다.
      expect(afterX.hp).toBe(afterY.hp)
    },
  )
})
