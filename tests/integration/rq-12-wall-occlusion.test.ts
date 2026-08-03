import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'
import { WALL_EAST } from '@shared/sim/walls'
import { isWithinSafeZone } from '@shared/sim/spawn'
import type { WallAABB } from '@shared/sim/movement'

/**
 * RQ-12 v1.7 사격 차폐(맵 정적 지오메트리에 의한 hitscan 차단) — 서버 권위
 * (RQ-61) 통합 테스트 (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정
 * 로직 Red-first 영역, ADR-0013: 충돌 형상의 진실 공급원은 서버).
 *
 * 매핑된 골든 케이스: **GA-58** (`harness/evals/golden/track-a-product.jsonl`).
 * - given: 사수 A와 표적 B가 서로 조준선상에 있고, 둘 사이에 맵 정적
 *   지오메트리(벽)가 놓여 있음.
 * - when: A가 B를 조준해 사격하고 서버가 hitscan을 판정.
 * - then: 서버는 명중으로 판정하지 않고 B의 HP가 변하지 않는다. 같은
 *   배치에서 **벽만 치우면 같은 사격이 명중해 B의 HP가 줄어든다**(양성
 *   대조군 — 차폐가 사격 자체를 죽인 것이 아님을 보인다). **벽이 B보다
 *   뒤에 있는 배치에서는 차폐가 아니므로 명중한다**. `verify` 필드가 이
 *   파일 경로를 직접 지정한다.
 *
 * **레벨 분리(ADR-0008)**: 레이 × 벽 AABB 교차 거리 비교의 순수 산술(차폐
 * 여부·경계값 결정)은 `tests/unit/sim-combat-occlusion.test.ts`가 이미
 * `findClosestHit`의 4번째 인자(`walls`)로 결정론적으로 고정했다. **이
 * 파일은 그 산술을 직접 임포트하지 않는다** — 실 `GameRoom.handleFire`가
 * `@shared/sim/walls`의 `PRODUCTION_WALLS`를 실제로 그 4번째 인자에
 * 배선하는가만 실 Colyseus 룸 경계에서 블랙박스(+화이트박스 상태 주입)로
 * 관측한다. **원장 25a-2의 F1 재발 방지가 이 파일의 존재 이유다** — 순수
 * 함수가 계약대로 동작해도 프로덕션 호출부가 실제로 그 계약을 쓰지
 * 않으면(배선 누락) 위 GA-58이 거짓으로 통과할 수 있다.
 *
 * **회귀 사전 실측(팀리드 지시 — 좌표 값으로 조사, 이름이 아니라)**:
 * 1. `PRODUCTION_WALLS`(`@shared/sim/walls`) 4개 벽의 절댓값 좌표(15~16m
 *    대역)를 리터럴로 복제하는 기존 사격 통합 테스트는 없다(전수 grep
 *    `x:\s*1[4-8]|z:\s*1[4-8]|x:\s*-1[4-8]|z:\s*-1[4-8]` — 매치는
 *    `sim-movement-walls.test.ts`·`rq-30-wall-collision-wiring.test.ts`
 *    (이동 충돌, 이 라운드와 무관)뿐이고 사격(`fire`) 테스트는 0건).
 * 2. **동적 좌표(스폰 지점 기반) 사격 테스트**: 대부분의 2인 사격 통합
 *    테스트(`rq-12-*`·`rq-13`·`rq-14`·`rq-90` 등)는 신선한 서버에서 처음
 *    입장한 두 클라이언트가 인접 스폰 인덱스(각도차 24°)를 받고, 이후
 *    반경-방사(`escapeSafeZone`, 오프셋 6m → 반경 28m)로 서로에게서 벌어진
 *    지점으로 이동한 뒤 서로를 조준한다 — 두 점(반경 28, 각도차 24°)을
 *    잇는 현의 원점 최근접 거리는 `28·cos(12°)`≈27.4m로 벽 대역(15.8~
 *    16.8m)에서 한참 벗어난다(전수 안전). **원점을 사수로 쓰는 유일한
 *    기존 사격 테스트**(`rq-31-safe-zone-blocks-bullets.test.ts`, RQ-31
 *    v1.6 총알 차단)는 사수를 원점에 고정하고 표적을 "B(2번째 입장,
 *    인덱스1, 각도24°)의 방사 방향"으로 두는데, 이 각도(24°)는
 *    `WALL_EAST`의 원점 기준 반각(`atan(5/15.5)`≈17.88°)보다 커서 그
 *    사선이 벽 대역을 지나는 순간(x≈15~16) z가 이미 6.3~6.7(벽의 z 범위
 *    [-5,5] 밖)에 도달해 있다 — 실측 확인, 벽과 겹치지 않는다. **한계**:
 *    `send('fire'` 기준 25개 파일 전수를 각 파일의 실제 입장 순서·화이트
 *    박스 텔레포트 좌표까지 전부 대수적으로 추적하지는 못했다(3인 이상
 *    동시 입장 파일 — `rq-64-lag-compensation-bound`(21회 입장, `beforeEach`
 *    매 케이스 신규 서버라 각 케이스 내 입장 순서만 보면 되지만 전부
 *    추적하지 않음)·`rq-81-*`·`rq-43-afk-kick`·`rq-41-slot-promotion` 등) —
 *    이 배선이 실제로 들어간 뒤 `npm run check`(전체 스위트)가 최종
 *    확인이다. coder는 이 파일들에서 새로 실패가 나면 "회귀"가 아니라
 *    "이 라운드가 처음으로 검출한, 원래도 존재했어야 할 차폐"인지부터
 *    구분해 보고해야 한다(사격선이 실제로 벽을 지난다면 그것이 맞는
 *    동작이다 — 그 경우 그 테스트 파일의 좌표를 조정하는 것은 이 라운드
 *    범위이지만, 이 test-writer는 그 파일들을 수정하지 않는다 — team-lead
 *    지시 "기존 테스트를 수정하지 마라. 회귀가 나면 고치지 말고 보고하라").
 *
 * **신규 화이트박스 계약(그린필드 — RQ-90 `spreadTuningOverride`/
 * `forcedSpreadSeed` 선례와 동일한 권한)**: GA-58의 "같은 배치에서 벽만
 * 치우면"이라는 양성 대조군은 `PRODUCTION_WALLS`가 코드 상수로 고정돼
 * 있어(런타임에 실제로 벽 배열을 바꿀 수단이 없으면) 같은 좌표로 재현할
 * 수 없다 — 그래서 `GameRoom`에 테스트 전용 오버라이드를 하나 추가한다:
 *
 *   - `wallsOverride?: readonly WallAABB[] | undefined` — **설정돼
 *     있으면**(`[]`도 유효한 설정값이다 — "벽 없음"과 "오버라이드 없음"은
 *     구분된다) `handleFire`의 hitscan 차폐 질의(`findClosestHit`의 4번째
 *     인자)가 `PRODUCTION_WALLS` 대신 이 값을 쓴다. **설정돼 있지
 *     않으면**(`undefined`, 기본값) 기존처럼 `PRODUCTION_WALLS`를 그대로
 *     쓴다. **범위 한정 — 이동 충돌에는 적용하지 않는다**:
 *     `stepPlayerMovement`가 `stepMovement`에 넘기는 벽 목록(RQ-30 이동
 *     충돌)은 이 오버라이드와 **무관**하다 — 그쪽은 계속 무조건
 *     `PRODUCTION_WALLS`만 쓴다. 이 오버라이드는 오직 hitscan 차폐
 *     질의(RQ-12 v1.7, 이 파일)만을 위한 테스트 전용 스위치다 — 이동
 *     충돌까지 함께 꺼버리면 RQ-30 회귀(`rq-30-wall-collision-wiring
 *     .test.ts` 등)를 이 세션이 검증할 수 없는 곳에서 건드리게 된다.
 *
 * **좌표 설계 — 실제 `WALL_EAST` 좌표 기준(`@shared/sim/walls`, x:15~16m,
 * z:-5~5m)**: 사수 A를 원점(0,0,0)에, 표적 B를 항상 z=0(벽의 z 범위 안)에
 * 두고 x만 바꿔 세 배치를 만든다 — 원점→x축 직선이므로 A의 실제 눈높이
 * (`DEFAULT_HITBOX.eyeHeightM`)와 무관하게 XZ 평면상 경로는 항상 z=0
 * 직선이다(벽은 무한 높이 기둥이므로 조준의 수직각과 무관하게 이 직선이
 * 벽의 x∈[15,16] 대역을 지나면 반드시 교차한다).
 *   - **차폐 배치**: B를 `x=17`(벽 뒤, `WALL_EAST.maxX`=16보다 큼)에 둔다.
 *   - **벽이 표적보다 뒤 배치**: B를 `x=10`(벽 앞, `WALL_EAST.minX`=15보다
 *     작음)에 둔다.
 *   - **양성 대조군**: 차폐 배치와 **완전히 같은 좌표**(x=17)에서
 *     `wallsOverride=[]`만 바꾼다 — GA-58 "같은 배치에서 벽만 치우면"의
 *     직역.
 * 세 좌표(0/10/17) 모두 15개 스폰 지점(반지름 22 원, Safe Zone 반경 4m)
 * 전부와의 거리가 4m를 넘는다(전수 계산: 최근접 스폰 지점은 인덱스0
 * `(22,0,0)`이며 각각 22m·12m·5m — 아래 guard가 매 실행마다 기계적으로
 * 재확인한다, `rq-31-safe-zone-blocks-bullets.test.ts`의 `isWithinSafeZone`
 * 가드와 동일 근거) — Safe Zone 재배치 없이 그대로 사격이 가능하다.
 *
 * **RQ-16과의 분리**: B(피격자)의 스폰 후 3초 시간 기반 보호는 화이트박스로
 * `firedSinceSpawn`을 즉시 세팅해 꺼둔다(다른 rq-31/rq-12 파일과 동일
 * 근거 — 이 파일이 관측하는 HP 변화가 RQ-16이 아니라 RQ-12 v1.7(벽 차폐)
 * 에만 귀속되게 하기 위함). A(사수)는 원점이 이미 모든 Safe Zone 밖이라
 * 별도 조치가 필요 없다(위 guard가 확인).
 *
 * **화이트박스 대상**: `moveStates`·`positionHistory`·`firedSinceSpawn`은
 * 기존 rq-12/rq-31 파일들이 이미 이 정확한 이름으로 결합하는 private
 * 필드다(그린필드가 아니다) — `wallsOverride`만 이 라운드의 신규 계약.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외, 기존 rq-12 파일과 동일). 서버 상태는 `matchMaker
 * .getLocalRoomById`로 직접 읽는다(`rq-31-safe-zone-blocks-bullets.test.ts`
 * 와 동일 패턴 — `handleFire`가 메시지 수신과 동기로 HP를 갱신하므로,
 * 클라이언트 패치 배치 지연과 무관하게 서버 프로세스 안의 상태를 직접
 * 폴링한다). 모든 대기에 `withTimeout()` 또는 poll timeout 상한을 건다.
 * "HP 불변" 관측은 고정 관찰창(`NO_DAMAGE_OBSERVE_MS`)으로 확인한다(변화
 * 없음 자체가 확인 대상이라 이벤트 기반 대기가 부적합 — 기존 파일들과
 * 동일한 이유). 난수·`Date.now()` 직접 호출 없음(ADR-0008).
 *
 * **it()마다 오버라이드를 명시적으로 재설정한다**(RQ-90 22z4 교훈 —
 * "이전 it()의 값에 기대지 않는다": 같은 describe 안에서 room 인스턴스가
 * it() 경계를 넘어 재사용될 수 있다는 것이 이미 실증됐다).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
/** 서버 화이트박스 상태 폴링 간격(`rq-31-safe-zone-blocks-bullets.test.ts`와 동일). */
const SERVER_POLL_INTERVAL_MS = 15
/** 화이트박스 텔레포트 후 스키마 동기화 정착 대기. */
const TELEPORT_SETTLE_MS = 150
/** "피해가 없다"(차폐)를 확인하는 고정 관찰창. */
const NO_DAMAGE_OBSERVE_MS = 500
/** 서버 상태 조건 대기 상한(양성 대조군·"벽이 표적보다 뒤" 명중 확인). */
const HP_CONDITION_TIMEOUT_MS = 5_000

/** 사수 A — 항상 원점. `WALL_EAST.minX`보다 한참 안쪽이라 벽 앞이다. */
const SHOOTER_POS = { x: 0, y: 0, z: 0 }
/** 차폐·양성 대조군 배치의 표적 B 위치 — `WALL_EAST.maxX`(16)보다 큰 x. */
const TARGET_BEHIND_WALL_POS = { x: 17, y: 0, z: 0 }
/** "벽이 표적보다 뒤" 배치의 표적 B 위치 — `WALL_EAST.minX`(15)보다 작은 x. */
const TARGET_BEFORE_WALL_POS = { x: 10, y: 0, z: 0 }

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

interface MoveStateSnapshot {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  grounded: boolean
}

/** 화이트박스 접근 대상 계약 — `moveStates`·`positionHistory`·
 * `firedSinceSpawn`은 기존(`rq-31-safe-zone-blocks-bullets.test.ts`의
 * `BulletBlockTestSeam`과 동일). `wallsOverride`만 이 파일이 요구하는
 * 신규 계약(파일 상단 docblock 참고). */
interface WallOcclusionTestSeam {
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number; hp?: number } | undefined
    }
  }
  moveStates: Map<string, MoveStateSnapshot>
  positionHistory: Map<string, unknown[]>
  firedSinceSpawn: Map<string, boolean>
  wallsOverride?: readonly WallAABB[] | undefined
}

function getServerRoom(room: Room): WallOcclusionTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as WallOcclusionTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-12 v1.7 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function readServerPlayer(seam: WallOcclusionTestSeam, sessionId: string): PlayerSnapshot | undefined {
  const p = seam.state.players.get(sessionId)
  if (typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.z === 'number' && typeof p?.hp === 'number') {
    return { x: p.x, y: p.y, z: p.z, hp: p.hp }
  }
  return undefined
}

function waitForServerCondition(
  seam: WallOcclusionTestSeam,
  sessionId: string,
  predicate: (s: PlayerSnapshot) => boolean,
  label: string,
  timeoutMs: number,
): Promise<PlayerSnapshot> {
  return new Promise<PlayerSnapshot>((resolve, reject) => {
    const tryResolve = (): boolean => {
      const current = readServerPlayer(seam, sessionId)
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

/** 화이트박스 텔레포트(`moveStates` + `positionHistory` 링버퍼 비우기 —
 * `tests/support/safe-zone.ts`의 "묶는 이유" 문서와 동일 근거, RQ-64
 * 되감기가 낡은 위치를 반환하는 결함을 피한다). */
function teleportPlayer(seam: WallOcclusionTestSeam, sessionId: string, position: { x: number; y: number; z: number }): void {
  seam.moveStates.set(sessionId, {
    x: position.x,
    y: position.y,
    z: position.z,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: true,
  })
  seam.positionHistory.delete(sessionId)
}

/** shooter(발 위치)에서 target(발 위치)의 바디 중심을 정확히 조준하는
 * 방향 벡터(정규화) — `rq-12-server-hitscan.test.ts`의 `aimAt`과 동일
 * 패턴. */
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

describe('RQ-12 v1.7/GA-58: 맵 정적 지오메트리(벽)에 의한 hitscan 차폐', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'GA-58 차폐: A(원점)와 벽 뒤(x=17)의 B가 조준선상에 있고 그 사이에 WALL_EAST가 있으면, 서버는 명중으로 판정하지 않고 B의 HP는 그대로다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        // 좌표 설계 전제 — 맵 라운드가 WALL_EAST 좌표를 바꾸면 이 guard가
        // 먼저 실패해 알려준다(파일 상단 "좌표 설계" 문서 참고).
        expect(SHOOTER_POS.x).toBeLessThan(WALL_EAST.minX)
        expect(TARGET_BEHIND_WALL_POS.x).toBeGreaterThan(WALL_EAST.maxX)
        expect(isWithinSafeZone(SHOOTER_POS)).toBe(false)
        expect(isWithinSafeZone(TARGET_BEHIND_WALL_POS)).toBe(false)

        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = undefined // 명시 초기화(22z4 교훈) — 프로덕션 기본값(PRODUCTION_WALLS) 사용
        seam.firedSinceSpawn.set(roomB.sessionId, true) // RQ-16과 분리
        teleportPlayer(seam, roomA.sessionId, SHOOTER_POS)
        teleportPlayer(seam, roomB.sessionId, TARGET_BEHIND_WALL_POS)
        await sleep(TELEPORT_SETTLE_MS)

        const aim = aimAtBody(SHOOTER_POS, TARGET_BEHIND_WALL_POS)
        roomA.send('fire', aim)
        await sleep(NO_DAMAGE_OBSERVE_MS)

        const afterShot = readServerPlayer(seam, roomB.sessionId)
        expect(afterShot?.hp).toBe(PLAYER.MAX_HP) // 벽이 막아 명중하지 않는다
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )

  it(
    'GA-58 양성 대조군: 차폐 배치와 완전히 같은 좌표(x=17)에서 wallsOverride=[]로 벽만 치우면, 같은 조준의 사격이 명중해 B의 HP가 WEAPON.DAMAGE_BODY만큼 준다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = [] // 벽 없음 — "같은 배치에서 벽만 치우면"의 직역
        seam.firedSinceSpawn.set(roomB.sessionId, true)
        teleportPlayer(seam, roomA.sessionId, SHOOTER_POS)
        teleportPlayer(seam, roomB.sessionId, TARGET_BEHIND_WALL_POS) // 차폐 테스트와 동일 좌표
        await sleep(TELEPORT_SETTLE_MS)

        const aim = aimAtBody(SHOOTER_POS, TARGET_BEHIND_WALL_POS)
        roomA.send('fire', aim)

        const afterShot = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (s) => s.hp < PLAYER.MAX_HP,
          '양성 대조군 — 벽 제거 후 B의 HP 감소 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(afterShot.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )

  it(
    'GA-58 "벽이 표적보다 뒤": A(원점)가 벽 앞(x=10)의 B를 조준해 사격하면(WALL_EAST는 B보다 더 먼 x=15~16에 있어 차폐가 아니다) 정상 명중해 B의 HP가 WEAPON.DAMAGE_BODY만큼 준다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        expect(TARGET_BEFORE_WALL_POS.x).toBeLessThan(WALL_EAST.minX)
        expect(isWithinSafeZone(TARGET_BEFORE_WALL_POS)).toBe(false)

        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = undefined // 명시 초기화 — 프로덕션 기본값(PRODUCTION_WALLS) 사용
        seam.firedSinceSpawn.set(roomB.sessionId, true)
        teleportPlayer(seam, roomA.sessionId, SHOOTER_POS)
        teleportPlayer(seam, roomB.sessionId, TARGET_BEFORE_WALL_POS)
        await sleep(TELEPORT_SETTLE_MS)

        const aim = aimAtBody(SHOOTER_POS, TARGET_BEFORE_WALL_POS)
        roomA.send('fire', aim)

        const afterShot = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (s) => s.hp < PLAYER.MAX_HP,
          '"벽이 표적보다 뒤" — B의 HP 감소 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(afterShot.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )
})
