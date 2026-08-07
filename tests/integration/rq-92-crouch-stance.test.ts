import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { CROUCH_HITBOX, DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'
import { isWithinSafeZone } from '@shared/sim/spawn'
import type { WallAABB } from '@shared/sim/movement'

/**
 * RQ-92 v2.2 — 앉은 자세 눈높이·히트박스, 실 `GameRoom.handleFire` 배선
 * (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직은 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-64~68** (`harness/evals/golden/track-a-product
 * .jsonl`, 사용자 확정 2026-08-07).
 * - GA-64: 앉은 사수의 hitscan 레이 원점은 발 + 1.222m다(선 자세 1.700이
 *   아니다). 자세 판정은 서버가 관측하는 `mode`로만 한다(RQ-61).
 * - GA-65: 앉은 대상의 헤드 볼륨은 [1.050,1.350], 바디 볼륨은 [0,1.050]이다.
 * - GA-66: 사수·대상 사이 정적 지오메트리가 있으면 앉은 대상의 실제 머리를
 *   정확히 겨냥해도 차폐로 미명중이다(RQ-12 v1.7). **한계**: 아래 describe
 *   docblock 참고 — 이 코드베이스의 벽 모델은 무한 높이라 "1.5m 높이"라는
 *   유한 높이 차등 자체는 검증하지 못한다.
 * - GA-67: `crouch`→`run` 전환은 같은 판정 경로에서 즉시 반영된다(전환
 *   보간·자세 진행도 상태 없음).
 * - GA-68: 선 자세(mode 무관 또는 'run')의 판정값은 자세 도입 이전과
 *   완전히 동일하다(회귀 가드).
 *
 * **레벨 분리(ADR-0008)**: 순수 산술(`hitboxForMode`·`CROUCH_HITBOX`의
 * 형상·경계)은 `tests/unit/sim-combat.test.ts`(REV3 절)가 이미 결정론적으로
 * 고정했다. 이 파일은 그 산술을 직접 임포트하지 않는다 — 실
 * `GameRoom.handleFire`가 **사수 자신의** `mode`를 자신의 레이 원점에,
 * **각 피격 후보 자신의** `mode`를 그 후보의 히트박스에 반영해 배선하는가만
 * 실 Colyseus 룸 경계에서 HP 변화(블랙박스)로 관측한다.
 *
 * **신규 배선 계약(coder에게, test-writer 지정)**: `GameRoom`은 지금까지
 * 사수 자신의 `pendingInputs.mode`만 읽었다(RQ-90 탄퍼짐 판정). 이 라운드는
 * **각 피격 후보 자신의** `pendingInputs.get(candidateId)?.mode`(없으면
 * `IDLE_MOVE_INPUT`, 기존 폴백과 동일 관례)도 읽어 그 후보의 히트박스를
 * `hitboxForMode`로 개별 해석하도록 요구한다 — `raycastHitbox`/
 * `findClosestHit`의 기존 시그니처(균일 `hitbox` 인자)는 이 라운드가 바꾸지
 * 않는다(`tests/unit/sim-combat.test.ts` REV3 "블라스트 반경 결정" 절
 * 참고) — 서로 다른 자세가 섞인 후보 집합은 호출부가 자세별로 묶어
 * `findClosestHit`을 여러 번 호출하는 식으로 처리하면 된다(정확한 구현
 * 방식은 coder 재량).
 *
 * **좌표 설계**: `tests/integration/rq-12-wall-occlusion.test.ts`와 동일한
 * 검증된 좌표를 재사용한다 — 사수 A는 원점(0,0,0), 대상 B는 x=10(같은
 * z=0 직선). 두 좌표 모두 15개 스폰 지점(Safe Zone 반경 4m) 전부와의 거리가
 * 4m를 넘는다(그 파일의 "좌표 설계" 문서 실측 — 각각 22m·12m). 조준은
 * 순수 x/y 평면(z=0 고정)에서 높이(`dirY`)만 바꿔 헤드/바디/차폐 경계를
 * 구분한다.
 *
 * **화이트박스 계약**: `moveStates`·`positionHistory`·`firedSinceSpawn`·
 * `wallsOverride`는 기존 `rq-12-wall-occlusion.test.ts`/`rq-90-spread
 * -degradation.test.ts`가 이미 확립한 정확히 같은 이름의 private 필드다
 * (그린필드 아님). `pendingInputs`도 `rq-90-spread-degradation.test.ts`가
 * 이미 화이트박스로 확립한 필드(그 파일 "REV2" 절 참고) — 이 파일은
 * **대상(B) 자신의** `pendingInputs`도 함께 쓴다는 점이 새롭다(그 파일은
 * 사수만 썼다).
 *
 * **탄퍼짐 무력화**: `spreadTuningOverride.coneRadiusRad=0`으로 고정한다 —
 * 이 파일의 관심사는 자세별 히트박스 경계(수 cm~수십 cm 간격)이고, 기본
 * 콘(0.5°)도 표준 사격 거리(10m)에서 최대 편차 ≈0.087m로 그 간격과
 * 같은 자릿수라 결정론이 깨질 위험이 있다(ADR-0008).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외). 서버 상태는 `matchMaker.getLocalRoomById`로 직접 읽는다
 * (`rq-12-wall-occlusion.test.ts`와 동일 패턴 — 클라이언트 패치 동기 지연과
 * 무관하게 서버 프로세스 안의 상태를 직접 폴링한다). 모든 대기에
 * `withTimeout()` 또는 poll timeout 상한을 건다. "HP 불변"(차폐·미명중)
 * 관측은 고정 관찰창(`NO_DAMAGE_OBSERVE_MS`)으로 확인한다. 난수·
 * `Date.now()` 직접 호출 없음.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_CONDITION_TIMEOUT_MS = 5_000
/** 서버 화이트박스 상태 폴링 간격(`rq-12-wall-occlusion.test.ts`와 동일). */
const SERVER_POLL_INTERVAL_MS = 15
/** 화이트박스 텔레포트 후 스키마 동기화 정착 대기. */
const TELEPORT_SETTLE_MS = 150
/** "피해가 없다"(미명중·차폐)를 확인하는 고정 관찰창. */
const NO_DAMAGE_OBSERVE_MS = 500
/** 연속 사격 사이 여유(ADR-0005 rate-limit 150ms + 네트워크 왕복 여유) —
 * `rq-90-spread-degradation.test.ts`의 `SHOT_GAP_MS`와 동일 근거. */
const SHOT_GAP_MS = 400

/** 사수 A — 항상 원점(`rq-12-wall-occlusion.test.ts`의 `SHOOTER_POS`와
 * 동일 좌표·동일 안전성 근거: 최근접 스폰 지점까지 22m). */
const SHOOTER_POS = { x: 0, y: 0, z: 0 }
/** 대상 B — x=10, 같은 z=0 직선(그 파일의 `TARGET_BEFORE_WALL_POS`와 동일
 * 좌표·동일 안전성 근거: 최근접 스폰 지점까지 12m). */
const TARGET_POS = { x: 10, y: 0, z: 0 }
/** GA-66 전용 — A·B를 잇는 z=0 직선(x: 0~10)을 가로지르는 벽. */
const WALL_BETWEEN: WallAABB = { minX: 4, maxX: 6, minZ: -1, maxZ: 1 }

const HEADSHOT_DAMAGE = WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER

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

/** `GameRoom`의 기존 `pendingInputs: Map<string, MoveInput>` 필드와 동일한
 * 최소 형태(그린필드 아님 — `rq-90-spread-degradation.test.ts`의
 * `PendingInputSnapshot`과 동일 패턴). */
interface PendingInputSnapshot {
  dirX: number
  dirZ: number
  mode: 'run' | 'walk' | 'crouch'
  jump: boolean
}

/** 화이트박스 접근 대상 계약 — `moveStates`·`positionHistory`·
 * `firedSinceSpawn`·`wallsOverride`는 기존(`rq-12-wall-occlusion.test.ts`의
 * `WallOcclusionTestSeam`과 동일). `pendingInputs`는
 * `rq-90-spread-degradation.test.ts`가 이미 확립한 필드이며, 이 파일은
 * 대상(B) 자신의 값도 함께 쓴다(파일 상단 docblock 참고). */
interface CrouchTestSeam {
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number; hp?: number } | undefined
    }
  }
  moveStates: Map<string, MoveStateSnapshot>
  positionHistory: Map<string, unknown[]>
  firedSinceSpawn: Map<string, boolean>
  pendingInputs: Map<string, PendingInputSnapshot>
  wallsOverride?: readonly WallAABB[] | undefined
  spreadTuningOverride?: { coneRadiusRad: number; movingMultiplier: number; airborneMultiplier: number }
}

function getServerRoom(room: Room): CrouchTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as CrouchTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-92 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function readServerPlayer(seam: CrouchTestSeam, sessionId: string): PlayerSnapshot | undefined {
  const p = seam.state.players.get(sessionId)
  if (typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.z === 'number' && typeof p?.hp === 'number') {
    return { x: p.x, y: p.y, z: p.z, hp: p.hp }
  }
  return undefined
}

function waitForServerCondition(
  seam: CrouchTestSeam,
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

/** 위치·자세(mode)를 한 번에, 화이트박스로 고정한다(`positionHistory`도
 * 함께 비운다 — RQ-64 되감기가 낡은 위치를 반환하는 결함을 피한다,
 * `tests/support/safe-zone.ts` "묶는 이유" 문서와 동일 근거). */
function setPosture(
  seam: CrouchTestSeam,
  sessionId: string,
  position: { x: number; y: number; z: number },
  mode: 'run' | 'walk' | 'crouch',
): void {
  seam.pendingInputs.set(sessionId, { dirX: 0, dirZ: 0, mode, jump: false })
  seam.moveStates.set(sessionId, { x: position.x, y: position.y, z: position.z, vx: 0, vy: 0, vz: 0, grounded: true })
  seam.positionHistory.delete(sessionId)
}

/** 위치는 그대로 두고 자세(mode)만 바꾼다 — GA-67(즉시 전환)이 이동 없이
 * 순수하게 자세만 전이하는 것을 검증하기 위한 최소 쓰기. */
function setMode(seam: CrouchTestSeam, sessionId: string, mode: 'run' | 'walk' | 'crouch'): void {
  seam.pendingInputs.set(sessionId, { dirX: 0, dirZ: 0, mode, jump: false })
}

/** shooter(발 위치 + 실제 눈높이)에서 target(발 위치)의 특정 절대 높이를
 * 정확히 조준하는 방향 벡터(정규화) — `rq-12-server-hitscan.test.ts`의
 * `aimAt`을 일반화한 형태(절대 높이를 직접 받는다 — 바디 중심 고정이
 * 아니라 헤드/바디/차폐 경계를 임의로 겨냥해야 하므로). */
function aimAtHeight(
  shooter: { x: number; z: number },
  shooterEyeHeightM: number,
  target: { x: number; z: number },
  targetHeightM: number,
): { dirX: number; dirY: number; dirZ: number } {
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = targetHeightM - shooterEyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

describe('RQ-92 v2.2/GA-64~68: 앉은 자세 눈높이·히트박스가 실 GameRoom.handleFire에서 동작한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "GA-64: 앉은 사수(mode='crouch')가 선 대상을 수평(dirY=0)으로 정조준하면, 레이 원점이 발+1.222m라 바디에 명중한다(선 자세 1.700이었다면 헤드에 명중했을 높이)",
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수 — 앉음
      const roomB = await joinGame(newClient(server)) // 대상 — 선 자세(기본)
      const seam = getServerRoom(roomA)

      try {
        expect(isWithinSafeZone(SHOOTER_POS)).toBe(false)
        expect(isWithinSafeZone(TARGET_POS)).toBe(false)

        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = []
        seam.spreadTuningOverride = { coneRadiusRad: 0, movingMultiplier: 1, airborneMultiplier: 1 }
        seam.firedSinceSpawn.set(roomB.sessionId, true) // RQ-16과 분리
        setPosture(seam, roomA.sessionId, SHOOTER_POS, 'crouch')
        setPosture(seam, roomB.sessionId, TARGET_POS, 'run') // 대상은 선 자세(DEFAULT_HITBOX)
        await sleep(TELEPORT_SETTLE_MS)

        // dirY=0(수평) — targetHeightM을 사수의 (앉은) 눈높이와 같은 값으로
        // 줘서 dy=0을 만든다. 대상은 선 자세이므로 이 높이(1.222m)는 대상의
        // 바디 범위([0,1.5]) 안이다 — 서버가 여전히 선 자세 눈높이(1.700)를
        // 쓴다면 이 높이는 대상의 헤드 범위([1.5,1.8]) 안이 되어 오히려
        // 헤드샷(50)으로 오판정된다.
        const aim = aimAtHeight(SHOOTER_POS, CROUCH_HITBOX.eyeHeightM, TARGET_POS, CROUCH_HITBOX.eyeHeightM)
        expect(aim.dirY).toBeCloseTo(0, 9)
        roomA.send('fire', aim)

        const afterShot = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (s) => s.hp < PLAYER.MAX_HP,
          'GA-64: 앉은 사수의 사격 후 B의 HP 감소 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(afterShot.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY) // 바디 명중(25) — 헤드샷(50)이 아니다
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )

  it(
    'GA-65: 대상이 앉으면(mode=crouch) 헤드 볼륨은 [1.050,1.350]·바디 볼륨은 [0,1.050]이다 — 세 높이(앉은 헤드 중심/경계 밖/앉은 바디 중앙)로 순서대로 확인',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수 — 선 자세(기본)
      const roomB = await joinGame(newClient(server)) // 대상 — 앉음
      const seam = getServerRoom(roomA)

      try {
        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = []
        seam.spreadTuningOverride = { coneRadiusRad: 0, movingMultiplier: 1, airborneMultiplier: 1 }
        seam.firedSinceSpawn.set(roomB.sessionId, true)
        setPosture(seam, roomA.sessionId, SHOOTER_POS, 'run')
        setPosture(seam, roomB.sessionId, TARGET_POS, 'crouch')
        await sleep(TELEPORT_SETTLE_MS)

        // (1) 앉은 헤드 중심(1.200m) — 헤드 명중, 데미지 50.
        const headAim = aimAtHeight(SHOOTER_POS, DEFAULT_HITBOX.eyeHeightM, TARGET_POS, CROUCH_HITBOX.headCenterM)
        roomA.send('fire', headAim)
        const afterHead = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (s) => s.hp < PLAYER.MAX_HP,
          'GA-65 (1) 앉은 헤드 중심 명중 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(afterHead.hp).toBe(PLAYER.MAX_HP - HEADSHOT_DAMAGE)
        await sleep(SHOT_GAP_MS)

        // (2) 앉은 헤드 볼륨 상단(1.350m)과 선 자세 바디 상단(1.500m) 사이의
        // 빈 공간 — 앉은 대상에게는 아무 볼륨도 없어 미명중이어야 한다
        // (선 자세였다면 여전히 바디 범위 안이었을 높이).
        const gapHeightM = (CROUCH_HITBOX.headCenterM + CROUCH_HITBOX.headRadiusM + DEFAULT_HITBOX.bodyTopM) / 2
        const gapAim = aimAtHeight(SHOOTER_POS, DEFAULT_HITBOX.eyeHeightM, TARGET_POS, gapHeightM)
        roomA.send('fire', gapAim)
        await sleep(NO_DAMAGE_OBSERVE_MS)
        const afterGap = readServerPlayer(seam, roomB.sessionId)
        expect(afterGap?.hp).toBe(afterHead.hp) // 변화 없음 — 미명중
        await sleep(SHOT_GAP_MS)

        // (3) 앉은 바디 중앙(0.525m) — 바디 명중, 데미지 25(양성 대조군 —
        // (2)의 미명중이 사격 자체의 문제가 아님을 확인).
        const bodyMidM = (CROUCH_HITBOX.bodyBottomM + CROUCH_HITBOX.bodyTopM) / 2
        const bodyAim = aimAtHeight(SHOOTER_POS, DEFAULT_HITBOX.eyeHeightM, TARGET_POS, bodyMidM)
        roomA.send('fire', bodyAim)
        const afterBody = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (s) => s.hp < afterHead.hp,
          'GA-65 (3) 앉은 바디 중앙 명중 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(afterBody.hp).toBe(afterHead.hp - WEAPON.DAMAGE_BODY)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    30_000,
  )

  it(
    'GA-66: 사수·대상 사이를 가로막는 벽이 있으면, 앉은 대상의 실제 머리(1.200m)를 정확히 겨냥해도 차폐로 미명중이다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = [WALL_BETWEEN]
        seam.spreadTuningOverride = { coneRadiusRad: 0, movingMultiplier: 1, airborneMultiplier: 1 }
        seam.firedSinceSpawn.set(roomB.sessionId, true)
        setPosture(seam, roomA.sessionId, SHOOTER_POS, 'run')
        setPosture(seam, roomB.sessionId, TARGET_POS, 'crouch')
        await sleep(TELEPORT_SETTLE_MS)

        const aim = aimAtHeight(SHOOTER_POS, DEFAULT_HITBOX.eyeHeightM, TARGET_POS, CROUCH_HITBOX.headCenterM)
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
    'GA-66 양성 대조군: 같은 배치·같은 조준에서 wallsOverride=[]로 벽만 치우면(대상은 여전히 앉은 채) 정상 명중해 헤드샷(50)이 들어간다 — 위 미스가 진짜 차폐 때문임을 확인',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = [] // 벽 없음
        seam.spreadTuningOverride = { coneRadiusRad: 0, movingMultiplier: 1, airborneMultiplier: 1 }
        seam.firedSinceSpawn.set(roomB.sessionId, true)
        setPosture(seam, roomA.sessionId, SHOOTER_POS, 'run')
        setPosture(seam, roomB.sessionId, TARGET_POS, 'crouch') // 차폐 테스트와 동일 자세
        await sleep(TELEPORT_SETTLE_MS)

        const aim = aimAtHeight(SHOOTER_POS, DEFAULT_HITBOX.eyeHeightM, TARGET_POS, CROUCH_HITBOX.headCenterM)
        roomA.send('fire', aim)

        const afterShot = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (s) => s.hp < PLAYER.MAX_HP,
          'GA-66 양성 대조군 — 벽 제거 후 B의 HP 감소 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(afterShot.hp).toBe(PLAYER.MAX_HP - HEADSHOT_DAMAGE)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )

  it(
    "GA-67: 대상의 mode가 'crouch'→'run'으로 바뀌면, 바뀐 다음 판정에서 같은 조준(1.200m 높이)이 즉시 헤드(앉음)에서 바디(선 자세)로 전환된다 — 전환 보간·잔여 자세 상태가 없다",
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = []
        seam.spreadTuningOverride = { coneRadiusRad: 0, movingMultiplier: 1, airborneMultiplier: 1 }
        seam.firedSinceSpawn.set(roomB.sessionId, true)
        setPosture(seam, roomA.sessionId, SHOOTER_POS, 'run') // 사수는 고정 — 대상의 전환만 관찰
        setPosture(seam, roomB.sessionId, TARGET_POS, 'crouch')
        await sleep(TELEPORT_SETTLE_MS)

        const aim = aimAtHeight(SHOOTER_POS, DEFAULT_HITBOX.eyeHeightM, TARGET_POS, CROUCH_HITBOX.headCenterM)

        // (1) 앉은 상태 — 헤드 명중(50).
        roomA.send('fire', aim)
        const after1 = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (s) => s.hp < PLAYER.MAX_HP,
          'GA-67 (1) 앉은 상태 헤드 명중 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(after1.hp).toBe(PLAYER.MAX_HP - HEADSHOT_DAMAGE)
        await sleep(SHOT_GAP_MS) // rate-limit(150ms) 해제 여유

        // (2) 자세 전환(화이트박스) 직후 — sleep 없이 곧바로 같은 조준으로
        // 재사격한다(JS 단일 스레드라 이 두 문장 사이에 서버 틱이 끼어들
        // 수 없다 — `rq-90-spread-degradation.test.ts`의 "fire 직전 동기
        // 재주입" 원칙과 동일). 같은 높이(1.200m)가 이제 선 자세 바디
        // 범위([0,1.5]) 안이라 바디 명중(25)이어야 한다 — 헤드로 남아있거나
        // (전환 미반영) 미명중(중간 보간 상태로 어느 볼륨에도 안 걸림)이면
        // 안 된다.
        setMode(seam, roomB.sessionId, 'run')
        roomA.send('fire', aim)
        const after2 = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (s) => s.hp < after1.hp,
          'GA-67 (2) 전환 직후 바디 명중 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(after2.hp).toBe(after1.hp - WEAPON.DAMAGE_BODY) // 헤드샷(50)이 아니라 바디(25) — 즉시 전환 확인
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    30_000,
  )

  it(
    'GA-68 회귀 가드: 둘 다 선 자세(기본)면 헤드 중심(1.650m) 조준이 여전히 헤드샷(50)이다 — 자세 도입이 선 자세 판정을 건드리지 않았다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = []
        seam.spreadTuningOverride = { coneRadiusRad: 0, movingMultiplier: 1, airborneMultiplier: 1 }
        seam.firedSinceSpawn.set(roomB.sessionId, true)
        setPosture(seam, roomA.sessionId, SHOOTER_POS, 'run')
        setPosture(seam, roomB.sessionId, TARGET_POS, 'run')
        await sleep(TELEPORT_SETTLE_MS)

        const aim = aimAtHeight(SHOOTER_POS, DEFAULT_HITBOX.eyeHeightM, TARGET_POS, DEFAULT_HITBOX.headCenterM)
        roomA.send('fire', aim)

        const afterShot = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (s) => s.hp < PLAYER.MAX_HP,
          'GA-68 회귀 가드 — 선 자세 헤드샷 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(afterShot.hp).toBe(PLAYER.MAX_HP - HEADSHOT_DAMAGE)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )
})

/**
 * RQ-92 검출력 보강(F1, evaluator FAIL blocker — `_workspace/RQ-92-crouch/
 * 03_evaluator_report.md`) — 위 6개 시나리오는 전부 **대상 1명**이라
 * `GameRoom.handleFire`의 "그룹 간(선 자세·앉은 자세) 최단 거리 비교"
 * 분기(`standingHit && crouchHit`일 때 실제 거리로 비교하는 코드)가 한
 * 번도 양쪽 다 채워진 채로 실행되지 않았다 — 변이 실측(evaluator):
 * 그 비교를 삭제하고 `standingHit ?? crouchHit`로 바꿔도(M1), 승자를
 * 반대로 뒤집어도(M6) 913/913 그대로 초록이었다.
 *
 * **A·B 둘 다 필요한 이유(오프라인 오라클로 직접 검증 — `_workspace/
 * RQ-92-crouch/04_test-writer_detection.md` §1 재현 가능)**: 근접 쪽의
 * 자세를 고정한 시나리오 하나만으로는 "그룹을 무조건 한쪽으로 편향해
 * 고르는 구현"이 근접 쪽과 우연히 일치하는 경우를 잡지 못한다 — 시드
 * 값으로 직접 확인한 결과, M1(`standingHit ?? crouchHit`)은 F1-A(근접=
 * 앉음) 단독으로는 죽지만 F1-B(근접=섬) 단독으로는 **살아남는다**(표준
 * 자세 그룹을 항상 우선하는 M1이 "근접=섬" 배치에서는 정답과 우연히
 * 같은 답을 내기 때문). 두 배치를 함께 요구해야 어느 방향의 편향에도
 * 견고하다.
 *
 * **좌표·방향**: 사수(0,1.7,0=선 자세 눈높이) → 방향(1,-0.05,0). 두 대상
 * 모두 이 하나의 사격으로 관통(hit=true)되도록 조준을 살짝 아래로
 * 기울였다 — 오프라인 오라클(`raycastHitbox`를 그대로 복제한 순수 산술
 * 스크립트, 커밋 안 함)로 사전 확인: x=10 거리 9.8624921972(region은
 * 대상의 자세에 따라 head/body로 갈린다), x=12 거리 11.7146158707. 근접이
 * 항상 더 가까우므로(관통 없음, 가정 F) 명중은 항상 근접 쪽이어야 한다 —
 * 원거리 쪽 HP가 그대로임을 함께 확인해 "관통 없음"도 같이 고정한다.
 */
const F1_NEAR_POS = { x: 10, y: 0, z: 0 }
const F1_FAR_POS = { x: 12, y: 0, z: 0 }
const F1_RAW_AIM = { dirX: 1, dirY: -0.05, dirZ: 0 }

describe('RQ-92 검출력 보강(F1) — 대상 2명·자세가 섞이면 그룹 간 최단 거리 비교가 실제로 승자를 가른다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'F1-A(근접=앉음): 근접 대상이 앉고 원거리 대상이 서 있으면, 실제로 더 가까운 근접(앉은) 대상이 명중한다(헤드샷) — 원거리(선 자세)는 그대로다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomNear = await joinGame(newClient(server))
      const roomFar = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        expect(isWithinSafeZone(F1_NEAR_POS)).toBe(false)
        expect(isWithinSafeZone(F1_FAR_POS)).toBe(false)

        const baselineNear = await waitForServerCondition(seam, roomNear.sessionId, () => true, 'Near 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        const baselineFar = await waitForServerCondition(seam, roomFar.sessionId, () => true, 'Far 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineNear.hp).toBe(PLAYER.MAX_HP)
        expect(baselineFar.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = []
        seam.spreadTuningOverride = { coneRadiusRad: 0, movingMultiplier: 1, airborneMultiplier: 1 }
        seam.firedSinceSpawn.set(roomNear.sessionId, true)
        seam.firedSinceSpawn.set(roomFar.sessionId, true)
        setPosture(seam, roomA.sessionId, SHOOTER_POS, 'run')
        setPosture(seam, roomNear.sessionId, F1_NEAR_POS, 'crouch') // 근접 = 앉음
        setPosture(seam, roomFar.sessionId, F1_FAR_POS, 'run') // 원거리 = 선 자세
        await sleep(TELEPORT_SETTLE_MS)

        roomA.send('fire', F1_RAW_AIM)

        const afterNear = await waitForServerCondition(
          seam,
          roomNear.sessionId,
          (s) => s.hp < PLAYER.MAX_HP,
          'F1-A 근접(앉은) 대상 명중 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(afterNear.hp).toBe(PLAYER.MAX_HP - HEADSHOT_DAMAGE) // 오프라인 오라클 — region='head'
        await sleep(NO_DAMAGE_OBSERVE_MS)
        const afterFar = readServerPlayer(seam, roomFar.sessionId)
        expect(afterFar?.hp).toBe(PLAYER.MAX_HP) // 관통 없음(가정 F) — 원거리는 그대로
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomNear), leaveRoom(roomFar)])
      }
    },
    20_000,
  )

  it(
    'F1-B(근접=섬): 근접 대상이 서 있고 원거리 대상이 앉으면, 실제로 더 가까운 근접(선 자세) 대상이 명중한다(바디샷) — 원거리(앉은)는 그대로다. F1-A만으로는 잡히지 않는 편향(항상 선 자세 그룹을 우선)을 이 배치가 잡는다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomNear = await joinGame(newClient(server))
      const roomFar = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        const baselineNear = await waitForServerCondition(seam, roomNear.sessionId, () => true, 'Near 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        const baselineFar = await waitForServerCondition(seam, roomFar.sessionId, () => true, 'Far 초기 서버 스냅샷', HP_CONDITION_TIMEOUT_MS)
        expect(baselineNear.hp).toBe(PLAYER.MAX_HP)
        expect(baselineFar.hp).toBe(PLAYER.MAX_HP)

        seam.wallsOverride = []
        seam.spreadTuningOverride = { coneRadiusRad: 0, movingMultiplier: 1, airborneMultiplier: 1 }
        seam.firedSinceSpawn.set(roomNear.sessionId, true)
        seam.firedSinceSpawn.set(roomFar.sessionId, true)
        setPosture(seam, roomA.sessionId, SHOOTER_POS, 'run')
        setPosture(seam, roomNear.sessionId, F1_NEAR_POS, 'run') // 근접 = 선 자세
        setPosture(seam, roomFar.sessionId, F1_FAR_POS, 'crouch') // 원거리 = 앉음
        await sleep(TELEPORT_SETTLE_MS)

        roomA.send('fire', F1_RAW_AIM)

        const afterNear = await waitForServerCondition(
          seam,
          roomNear.sessionId,
          (s) => s.hp < PLAYER.MAX_HP,
          'F1-B 근접(선 자세) 대상 명중 대기',
          HP_CONDITION_TIMEOUT_MS,
        )
        expect(afterNear.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY) // 오프라인 오라클 — region='body'
        await sleep(NO_DAMAGE_OBSERVE_MS)
        const afterFar = readServerPlayer(seam, roomFar.sessionId)
        expect(afterFar?.hp).toBe(PLAYER.MAX_HP)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomNear), leaveRoom(roomFar)])
      }
    },
    20_000,
  )
})
