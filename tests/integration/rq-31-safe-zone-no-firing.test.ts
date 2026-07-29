import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON, WORLD } from '@shared/constants'

/**
 * RQ-31 Safe Zone — 내부 사격 불가(무기 비활성화), 통합 테스트 (ADR-0008:
 * Colyseus 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * RQ-31 전문 중 사격 불가 절: "Safe Zone 내부에서는 사격이 불가능해야
 * 한다(무기 비활성화 — 세이프존을 엄폐물 삼은 스폰 캠핑 방지)."
 *
 * 매핑된 골든 케이스 **GA-19**(`verify` 필드가 이 파일 경로를 정확히 지정):
 * - given: 플레이어가 Safe Zone(스폰 지점 반경 5m) 내부에 위치.
 * - when: Safe Zone 내부에서 사격을 시도.
 * - then: 무기가 비활성화되어 발사되지 않는다 — Safe Zone을 엄폐물 삼은
 *   스폰 캠핑이 불가능하다.
 *
 * **실측 상태(원장 25f)**: `WORLD.SAFE_ZONE_ALLOWS_FIRING`(false) 상수는
 * 있으나 `GameRoom`에 `SAFE_ZONE` 참조가 0건 — 사격 비활성화가 전혀
 * 구현되지 않았다. 이 파일은 **Red**여야 한다(오늘 실행하면 아래 (1)(2)
 * 단언이 실패한다 — 현재는 Safe Zone 안에서도 정상적으로 발사된다).
 *
 * **GA-11과 이 파일의 관측 대상이 다르다(중요)**: GA-11(`rq-31-safe-zone
 * .test.ts`)은 **피격자**의 위치를 본다(피해자가 Safe Zone 안이면 피해
 * 무효화). 이 파일(GA-19)은 **사수**의 위치를 본다(사수가 Safe Zone
 * 안이면 무기 자체가 비활성화). 두 메커니즘이 함께 구현되므로, 이 파일이
 * B를 자신의 스폰 지점(Safe Zone 내부)에 그대로 둔 채 사수(A)만 옮겨가며
 * 시험하면, "B의 HP가 안 줄었다"는 관측이 "A의 무기가 비활성화돼서"가
 * 아니라 "B가 보호받아서"(GA-11의 메커니즘)일 수 있다 — GA-19가 GA-11에
 * 가려지는 공허화다. 그래서 이 파일은 시작할 때 **B를 모든 Safe Zone
 * 밖으로 미리 옮겨**(아래 §반경-방사 기하, `rq-31-safe-zone.test.ts`와
 * 동일한 증명) B가 피해를 받을 수 있는 상태로 고정한다 — 이후 관측되는
 * "HP 불변"은 오직 A의 위치(Safe Zone 내부)로만 설명될 수 있다.
 *
 * **관측 지점 — 효과로 잡는다(팀리드 지시)**: `handleFire`는 이미 여러
 * 게이트(rate-limit `canFire`, 탄약 `canFireAmmo`, `canAct`)를 순서대로
 * 통과한다. Safe Zone 게이트가 그중 어디에 들어가야 하는지는 스펙·골든이
 * 규정하지 않는 coder의 구현 결정이다 — 이 파일의 단언은 그 위치에
 * 무관하게 성립해야 한다. 그래서 판정 로직 내부를 들여다보지 않고 관측
 * 가능한 **효과** 두 가지를 함께 확인한다:
 *   (a) 피격 대상의 HP가 줄지 않는다 — "명중하지 않았다".
 *   (b) 사수의 탄창(`magazines`, 화이트박스)이 줄지 않는다 — "발사 자체가
 *       일어나지 않았다"(RQ-31 원문 "발사되지 않는다"의 직역 — 총알이
 *       나가지 않았다면 탄약도 소모되지 않아야 자연스럽다. "쐈지만
 *       빗나갔다"와 "애초에 쏘지 못했다"를 이 두 신호의 조합으로
 *       구별한다 — 탄약만 보면 전자와 후자를 구별할 수 없고, HP만 보면
 *       빗나간 정조준과 구별할 수 없다).
 * 두 신호를 **함께** 요구하므로, Safe Zone 게이트가 rate-limit·탄약 게이트
 * 이전/이후 어디에 있든(코더 재량) 이 단언은 그 배치와 무관하게 유효하다.
 *
 * **`magazines` 화이트박스 근거**: `GameRoom`의 기존 private 필드이고,
 * `AfkTestSeam`(`rq-43-afk-kick.test.ts`)·`PromotionTestSeam`
 * (`rq-41-slot-promotion.test.ts`)·`SpreadTestSeam`
 * (`rq-90-spread-seed-determinism.test.ts`)이 이미 이 정확한 이름으로
 * 화이트박스 결합하는 기존 필드다(그린필드가 아니다). 이 필드는 Colyseus
 * 스키마에 없다(`RQ-53` 클라 탄약 HUD가 이번 라운드 범위 밖이라 아직 클라
 * 노출 필드가 없다는 팀 결정, `GameRoom.ts` `magazines` 필드 코멘트) —
 * 그래서 클라이언트 시야(`room.state`)로는 관측할 수 없고 화이트박스가
 * 유일한 관측 경로다.
 *
 * **RQ-16과의 분리, 자기-해제 사격을 쓰지 않는 이유, 반경-방사 기하,
 * 경계값을 상수에서 유도하는 이유**: `rq-31-safe-zone.test.ts` 상단
 * 문서와 완전히 동일한 근거다 — 반복하지 않는다. 차이는 그 파일은
 * 피격자(B)를, 이 파일은 사수(A)를 대상으로 방사-오프셋을 적용한다는
 * 점뿐이다.
 *
 * **대기 술어·결정론 메모**: `rq-31-safe-zone.test.ts`와 동일 — 무효화
 * (음성) 관측은 고정 관찰창, 양성 대조군은 `waitForServerCondition`(단조
 * 조건)으로 상한을 둔다. 실 WebSocket(ADR-0008 허용 예외)에 의존하며 모든
 * 대기에 상한을 강제한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
const SERVER_POLL_INTERVAL_MS = 15
/** `rq-31-safe-zone.test.ts`의 동일 상수와 동일 근거 — 화이트박스
 * 텔레포트 후 스키마 동기화 정착 대기. */
const TELEPORT_SETTLE_MS = 150
/** "발사되지 않는다"(HP·탄약 불변)를 확인하는 고정 관찰창. */
const NO_FIRE_OBSERVE_MS = 500
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300

const RADIUS_M = WORLD.SAFE_ZONE_RADIUS_M
const INSIDE_BOUNDARY_OFFSET_M = RADIUS_M - 0.5
const OUTSIDE_BOUNDARY_OFFSET_M = RADIUS_M + 0.5
const FAR_OUTSIDE_OFFSET_M = RADIUS_M + 15

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
 * `SafeZoneTestSeam`과 동일한 근거에 `magazines`(`AfkTestSeam`
 * ·`PromotionTestSeam`·`SpreadTestSeam`이 이미 이 이름으로 화이트박스
 * 결합하는 기존 필드)를 더한 것. */
interface FireGateTestSeam {
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number; hp?: number } | undefined
    }
  }
  moveStates: Map<string, MoveStateSnapshot>
  positionHistory: Map<string, unknown[]>
  firedSinceSpawn: Map<string, boolean>
  magazines: Map<string, number>
}

function getServerRoom(room: Room): FireGateTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as FireGateTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-31 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function readServerPlayer(seam: FireGateTestSeam, sessionId: string): PlayerSnapshot | undefined {
  const p = seam.state.players.get(sessionId)
  if (typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.z === 'number' && typeof p?.hp === 'number') {
    return { x: p.x, y: p.y, z: p.z, hp: p.hp }
  }
  return undefined
}

/** `handleFire`가 미소모 상태를 표현하는 것과 동일한 규약
 * (`this.magazines.get(shooterId) ?? WEAPON.MAGAZINE`, `GameRoom.ts`) —
 * 아직 한 번도 쏘지 않은 세션은 맵에 키가 없다. */
function readAmmo(seam: FireGateTestSeam, sessionId: string): number {
  return seam.magazines.get(sessionId) ?? WEAPON.MAGAZINE
}

function waitForServerCondition(
  seam: FireGateTestSeam,
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
 * 형태 — `rq-31-safe-zone.test.ts` 상단 문서 참고. */
function teleportPlayer(seam: FireGateTestSeam, sessionId: string, position: { x: number; y: number; z: number }): void {
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

describe('RQ-31/GA-19: Safe Zone — 내부 사격 불가(무기 비활성화) + 경계 즉시 해제', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-31/GA-19: A가 Safe Zone(자신의 스폰 지점 반경 5m) 내부에서 사격을 시도하면 무기가 비활성화되어 발사되지 않고(HP·탄약 불변), 경계(반경 ±0.5m) 바깥에서는 즉시 정상 발사된다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        const baselineA = await waitForServerCondition(seam, roomA.sessionId, () => true, 'A 초기 서버 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)
        expect(readAmmo(seam, roomA.sessionId)).toBe(WEAPON.MAGAZINE)

        // RQ-16과의 분리 — B의 스폰 보호를 화이트박스로 즉시 해제한다
        // (자기 사격 트릭을 쓰지 않는 이유는 `rq-31-safe-zone.test.ts`
        // 상단 문서와 동일).
        seam.firedSinceSpawn.set(roomB.sessionId, true)

        // GA-11과의 교차 오염 방지(파일 상단 §설계 결정) — B를 모든 Safe
        // Zone 밖으로 옮겨 B의 피해 수신 가능 여부를 이 테스트의 관심사
        // 에서 제거한다. B는 이후 이 위치에 고정된 채 움직이지 않는다.
        const bFarPoint = radialOutwardPoint(baselineB, FAR_OUTSIDE_OFFSET_M)
        teleportPlayer(seam, roomB.sessionId, bFarPoint)
        await sleep(TELEPORT_SETTLE_MS)
        const bAtFarPoint = readServerPlayer(seam, roomB.sessionId)
        if (!bAtFarPoint) throw new Error('RQ-31: B의 텔레포트 후 서버 스냅샷을 찾지 못했다')

        // --- (1) A가 자신의 스폰 지점(거리 0)에 그대로 있을 때 — GA-19
        // given/then 그대로: 무기 비활성화(HP·탄약 둘 다 불변) ---
        const aimFromSpawn = aimAtBody(baselineA, bAtFarPoint)
        roomA.send('fire', aimFromSpawn)
        await sleep(NO_FIRE_OBSERVE_MS)
        const afterSpawnShotB = readServerPlayer(seam, roomB.sessionId)
        expect(afterSpawnShotB?.hp).toBe(PLAYER.MAX_HP)
        expect(readAmmo(seam, roomA.sessionId)).toBe(WEAPON.MAGAZINE)

        // --- (2) 경계 바로 안쪽(반경-0.5m) — 여전히 비활성화 ---
        await sleep(BETWEEN_SHOTS_MS)
        const insidePoint = radialOutwardPoint(baselineA, INSIDE_BOUNDARY_OFFSET_M)
        teleportPlayer(seam, roomA.sessionId, insidePoint)
        await sleep(TELEPORT_SETTLE_MS)
        const aimFromInside = aimAtBody(insidePoint, bAtFarPoint)
        roomA.send('fire', aimFromInside)
        await sleep(NO_FIRE_OBSERVE_MS)
        const afterInsideShotB = readServerPlayer(seam, roomB.sessionId)
        expect(afterInsideShotB?.hp).toBe(PLAYER.MAX_HP)
        expect(readAmmo(seam, roomA.sessionId)).toBe(WEAPON.MAGAZINE)

        // --- (3) 경계 바로 바깥쪽(반경+0.5m) — 양성 대조군 + "즉시 해제"
        // 증명. (1)(2)의 "불변"이 장치가 꺼져 있어서가 아니라 실제로 Safe
        // Zone이 사격을 막아서라는 것을 여기서 확정한다. ---
        await sleep(BETWEEN_SHOTS_MS)
        const outsidePoint = radialOutwardPoint(baselineA, OUTSIDE_BOUNDARY_OFFSET_M)
        teleportPlayer(seam, roomA.sessionId, outsidePoint)
        await sleep(TELEPORT_SETTLE_MS)
        const aimFromOutside = aimAtBody(outsidePoint, bAtFarPoint)
        roomA.send('fire', aimFromOutside)
        const afterOutsideShotB = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (p) => p.hp < PLAYER.MAX_HP,
          '양성 대조군 — 경계 바깥에서 실제 명중(HP 감소) 대기',
          HP_TIMEOUT_MS,
        )
        expect(afterOutsideShotB.hp).toBeLessThan(PLAYER.MAX_HP)
        expect(readAmmo(seam, roomA.sessionId)).toBe(WEAPON.MAGAZINE - 1)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )
})
