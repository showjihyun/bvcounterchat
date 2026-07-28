import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WORLD } from '@shared/constants'
import { SPAWN_POINTS } from '@shared/sim/spawn'

/**
 * RQ-31 Safe Zone — 스폰 지점 순환 로테이션(직전 사용 지점 회피), 통합
 * 테스트 (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직 Red-first
 * 영역).
 *
 * RQ-31 전문 중 로테이션 절: "스폰 지점은 14~16개를 배치하고, 직전에
 * 사용된 지점을 회피하는 순환 로테이션으로 선택해야 한다."
 *
 * 매핑된 골든 케이스 **GA-20**(`verify` 필드가 이 파일 경로를 정확히
 * 지정):
 * - given: 맵에 14~16개의 스폰 지점이 배치되어 있고, 플레이어 B가
 *   마지막으로 스폰 지점 P1에서 스폰됨.
 * - when: B가 사망 후 다시 리스폰.
 * - then: 재배치되는 스폰 지점은 P1이 아닌 다른 지점이다 — 순환
 *   로테이션이 직전 사용 지점을 회피한다.
 *
 * **실측 상태(원장 25f) — 이 파일은 GA-11·GA-19와 성격이 다르다**:
 * `nextSpawnIndex(previousIndex, total)`는 이미 `(previousIndex + 1) %
 * total`로 직전 인덱스를 회피하도록 구현돼 있고(`@shared/sim/spawn.ts`),
 * `GameRoom.allocateSpawnPoint`가 룸 전역 `spawnCursor`로 이미 배선돼
 * 있다(`GameRoom.ts`). 순수 로직 계약은
 * `tests/unit/sim-spawn.test.ts`(그린필드 계약을 그은 test-writer 파일)가
 * 이미 전수 검증했다 — "직전 인덱스와 항상 다르다"·"wrap-around"·"항상
 * 유효한 인덱스" 등. **이 통합 테스트는 그 이미 검증된 순수 로직이 실
 * Colyseus 룸 경계(사망→리스폰)에 실제로 결합돼 굴러가는지를 블랙박스로
 * 확인하는 것**이라 첫 실행부터 **Green일 것으로 예상된다** — 통합
 * 레벨의 커버리지 갭을 메우는 것이지 결함을 재현하는 것이 아니다.
 * 팀리드 지시대로, 이 경우 Red로 위장하지 않고 실제 실행 결과를 그대로
 * 보고하며, 대신 **검출력을 변이 심기로 직접 증명**한다(격리 워크트리,
 * `_workspace/RQ-31/01_test-writer_red.md` §GA-20 변이 검증 참고 — R1:
 * `(previousIndex + 1) % total` → `previousIndex ?? 0`(항상 같은 지점),
 * R2: `previousIndex === undefined` 분기 제거).
 *
 * **화이트박스 텔레포트를 쓰는 이유 — GA-31의 다른 절(Safe Zone 피해
 * 무효화·사격 불가)과의 간섭 회피**: 이 GA-20 시나리오는 B를 죽여야
 * 리스폰을 관측할 수 있다. 그런데 B는 join 직후 자신의 스폰 지점(=Safe
 * Zone 내부, 거리 0)에 있고, 이번 라운드는 **같은 PR에서** Safe Zone
 * 피해 무효화(GA-11)·사격 불가(GA-19)도 함께 구현된다 — 그 구현이 들어온
 * 뒤에는 "B가 자기 스폰 지점에 있는 채로 A가 쏴서 죽인다"는 이전 방식
 * (`rq-15-respawn-timer.test.ts`의 `killAndWaitForRespawn`과 동일 정신)이
 * (a) B가 Safe Zone 안이라 피해가 무효화되고 (b) A도 자기 스폰 지점 안에
 * 있다면 애초에 발사조차 되지 않아 이중으로 막힐 수 있다. 그래서 이
 * 테스트는 킬 시퀀스를 시작하기 전에 A·B 둘 다 화이트박스 텔레포트
 * (`rq-31-safe-zone.test.ts`의 `teleportPlayer`·§반경-방사 기하와 동일
 * 기법)로 모든 Safe Zone 밖으로 옮겨 둔다. **주의**: 이 텔레포트는
 * `moveStates`(현재 위치)만 바꾸는 테스트 전용 장치이지 `allocateSpawnPoint`
 * 를 다시 호출하는 "스폰" 이벤트가 아니다 — 그래서 GA-20의 "P1"(B가
 * 마지막으로 **스폰**된 지점)은 이 텔레포트로 바뀌지 않고 여전히 B의 join
 * 시점 위치(`baselineB`) 그대로다. 이 파일이 Safe Zone 자체를 검증하지는
 * 않는다(그건 `rq-31-safe-zone*.test.ts` 두 파일의 몫) — 여기서는 오직
 * "죽이기 위한 사전 조건"으로만 쓴다.
 *
 * **관측 지점(팀리드 지시)**: 클라이언트 시야가 아니라
 * `matchMaker.getLocalRoomById`로 얻은 서버 상태를 직접 읽어 리스폰
 * 전후(P1 vs P2) 좌표를 비교한다.
 *
 * **"P1이 아닌 다른 지점"만 확인한다(스코프 절제)**: `nextSpawnIndex`는
 * 직전 "하나만" 회피한다(`(previousIndex + 1) % total`) — GA-20의 then도
 * "P1이 아닌 다른 지점"이라고만 하지 N개 이력 회피를 요구하지 않는다.
 * 이 파일도 그 이상(예: 여러 번 리스폰시켜 이력 전체를 회피하는지)을
 * 요구하지 않는다 — 스펙에 없는 것을 시험하지 않는다.
 *
 * **결정론 메모**: 실 WebSocket 의존(ADR-0008 허용 예외). 리스폰
 * 대기(`PLAYER.RESPAWN_MS`=3000ms)는 `rq-15-respawn-timer.test.ts`와
 * 동일한 이유(서버 시간을 앞당길 훅이 없다)로 실제로 기다린다. 모든
 * 대기에 상한을 강제한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
const SERVER_POLL_INTERVAL_MS = 15
/** `rq-31-safe-zone.test.ts`의 동일 상수와 동일 근거. */
const TELEPORT_SETTLE_MS = 150
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300
/** RQ-15 리스폰 관측 상한(`rq-15-respawn-timer.test.ts`의
 * `RESPAWN_OBSERVE_TIMEOUT_MS`와 동일 값·동일 근거). */
const RESPAWN_OBSERVE_TIMEOUT_MS = 8_000

/** "모든 Safe Zone 밖"을 구성하는 방사 오프셋 — `rq-31-safe-zone.test.ts`
 * §반경-방사 기하 문서와 동일 값·동일 근거(실측 확인 범위 0~20m 안). */
const FAR_OUTSIDE_OFFSET_M = WORLD.SAFE_ZONE_RADIUS_M + 15

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

/** 화이트박스 접근 대상 계약 — `rq-31-safe-zone.test.ts`의
 * `SafeZoneTestSeam`과 동일한 근거(전부 그린필드가 아닌 기존 private
 * 필드). `firedSinceSpawn`은 B의 RQ-16 스폰 보호를 즉시 해제하는 데만
 * 쓴다(자기 사격 트릭을 쓰지 않는 이유는 `rq-31-safe-zone.test.ts` 상단
 * 문서와 동일). */
interface SpawnRotationTestSeam {
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number; hp?: number } | undefined
    }
  }
  moveStates: Map<string, MoveStateSnapshot>
  positionHistory: Map<string, unknown[]>
  firedSinceSpawn: Map<string, boolean>
}

function getServerRoom(room: Room): SpawnRotationTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as SpawnRotationTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-31 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function readServerPlayer(seam: SpawnRotationTestSeam, sessionId: string): PlayerSnapshot | undefined {
  const p = seam.state.players.get(sessionId)
  if (typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.z === 'number' && typeof p?.hp === 'number') {
    return { x: p.x, y: p.y, z: p.z, hp: p.hp }
  }
  return undefined
}

function waitForServerCondition(
  seam: SpawnRotationTestSeam,
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

/** `teleportPlayer`(`rq-90-spread-seed-determinism.test.ts`)와 동일한
 * 형태 — `rq-31-safe-zone.test.ts` 상단 문서 참고. 이 파일에서는 오직
 * "죽이기 위한 사전 조건"(모든 Safe Zone 밖으로 이동)으로만 쓴다 — GA-20의
 * "스폰"과는 무관하다(파일 상단 §화이트박스 텔레포트를 쓰는 이유 참고). */
function teleportPlayer(seam: SpawnRotationTestSeam, sessionId: string, position: { x: number; y: number; z: number }): void {
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

/** `rq-31-safe-zone.test.ts`의 동명 헬퍼와 동일 — §반경-방사 기하 문서 참고. */
function radialOutwardPoint(base: { x: number; y: number; z: number }, offsetM: number): { x: number; y: number; z: number } {
  const radialMagnitude = Math.hypot(base.x, base.z)
  if (radialMagnitude < 1e-6) {
    throw new Error(`RQ-31 테스트 전제 위반 — base(${base.x},${base.z})가 원점에 있어 방사 방향을 정의할 수 없다`)
  }
  const ux = base.x / radialMagnitude
  const uz = base.z / radialMagnitude
  return { x: base.x + ux * offsetM, y: base.y, z: base.z + uz * offsetM }
}

/** `rq-16-spawn-protection.test.ts`의 동명 헬퍼와 동일. */
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

describe('RQ-31/GA-20: 스폰 지점 순환 로테이션 — 리스폰은 직전 사용 지점(P1)을 회피한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-31/GA-20: B가 마지막으로 스폰된 지점 P1에서 사망 후 리스폰하면, 재배치되는 스폰 지점은 P1이 아닌 다른(그러나 여전히 SPAWN_POINTS 중 하나인) 지점이다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        const baselineA = await waitForServerCondition(seam, roomA.sessionId, () => true, 'A 초기 서버 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)
        // GA-20 given "B가 마지막으로 스폰 지점 P1에서 스폰됨" — P1은 B의
        // join 시점 위치(=`allocateSpawnPoint`가 실제로 배정한 지점) 그대로다.
        const p1 = { x: baselineB.x, y: baselineB.y, z: baselineB.z }

        // RQ-16과의 분리 — B의 스폰 보호를 화이트박스로 즉시 해제한다.
        seam.firedSinceSpawn.set(roomB.sessionId, true)

        // 킬 시퀀스를 위한 사전 조건(파일 상단 §화이트박스 텔레포트를 쓰는
        // 이유) — A·B 둘 다 모든 Safe Zone 밖으로 옮긴다. P1은 위에서 이미
        // 고정해 뒀으므로 이 이동으로 바뀌지 않는다.
        const aFarPoint = radialOutwardPoint(baselineA, FAR_OUTSIDE_OFFSET_M)
        teleportPlayer(seam, roomA.sessionId, aFarPoint)
        const bFarPoint = radialOutwardPoint(baselineB, FAR_OUTSIDE_OFFSET_M)
        teleportPlayer(seam, roomB.sessionId, bFarPoint)
        await sleep(TELEPORT_SETTLE_MS)

        const aim = aimAtBody(aFarPoint, bFarPoint)
        let previousHp = baselineB.hp
        const MAX_KILL_SHOTS = 4 // 바디샷만 맞을 때의 상한(헤드샷이 섞이면 더 일찍 끝난다) — rq-15/16과 동일 관례
        for (let shot = 1; shot <= MAX_KILL_SHOTS && previousHp > 0; shot += 1) {
          roomA.send('fire', aim)
          const afterShot = await waitForServerCondition(
            seam,
            roomB.sessionId,
            (p) => p.hp !== previousHp,
            `${shot}번째 사격 후 B의 HP 변화 대기(직전 HP=${previousHp})`,
            HP_TIMEOUT_MS,
          )
          previousHp = afterShot.hp
          if (previousHp > 0) await sleep(BETWEEN_SHOTS_MS)
        }
        expect(previousHp).toBe(0)

        const afterRespawn = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (p) => p.hp === PLAYER.MAX_HP,
          'GA-20: 사망 후 리스폰(HP 100 복귀) 대기',
          RESPAWN_OBSERVE_TIMEOUT_MS,
        )
        const p2 = { x: afterRespawn.x, y: afterRespawn.y, z: afterRespawn.z }

        // then ① — 재배치된 지점(P2)은 실제로 SPAWN_POINTS 중 하나다
        // (`rq-15-respawn-timer.test.ts`의 GA-09 멤버십 확인과 동일 패턴).
        const isKnownSpawnPoint = SPAWN_POINTS.some((point) => point.x === p2.x && point.y === p2.y && point.z === p2.z)
        expect(isKnownSpawnPoint).toBe(true)

        // then ② — GA-20 핵심 단언: P2는 P1이 아니다.
        expect(p2).not.toEqual(p1)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )
})
