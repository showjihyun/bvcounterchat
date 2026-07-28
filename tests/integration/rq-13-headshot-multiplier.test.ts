import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON, WORLD } from '@shared/constants'

/**
 * RQ-13 헤드샷 배율 — 서버 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus
 * 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-07** (`harness/evals/golden/track-a-product.jsonl`).
 * GA-07: "given: 플레이어 A가 Pistol(바디 데미지 25, RQ-90)로 플레이어 B를
 * 조준 / when: 동일 조건에서 머리에 명중 / then: 적용된 데미지는 50이다 —
 * 바디 데미지 25의 정확히 2배(RQ-13이 정한 배율, RQ-90이 실수치를 확정)."
 * `verify` 필드가 이 파일 경로를 정확히 지정한다.
 *
 * **레벨 분리(ADR-0008)**: 헤드 데미지가 "바디의 정확히 2배"라는 산술
 * 자체(`damageForRegion('head') === damageForRegion('body') *
 * WEAPON.HEADSHOT_MULTIPLIER`)는 `tests/unit/sim-combat.test.ts`가 이미
 * 고정했다. 이 파일은 "서버가 실제로 머리 높이 조준을 '헤드'로 판정해
 * 그 배율을 적용하는가"를 실 Colyseus 룸 경계에서 블랙박스로 확인한다.
 *
 * **가정(coder에게)**: `rq-12-server-hitscan.test.ts`의 가정 1~4와 동일
 * (`Player.hp` 필드, `'fire'` 메시지 `{dirX,dirY,dirZ}`, 즉시 판정,
 * `DEFAULT_HITBOX` 전원 동일 적용). 조준 방향 계산은 그 파일과 동일한
 * 방식(`aimAt` 헬퍼)이되, 수직 목표를 바디 중심이 아니라
 * `DEFAULT_HITBOX.headCenterM`(헤드 구체 중심 높이)으로 바꾼다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한. 위치는 `rq-20` 패턴대로
 * 실제 이동 입력으로 구동하고, 도달한 최종 위치를 읽어 조준 각도를
 * 계산한다(가정한 거리에 결합하지 않는다).
 *
 * **REV(구현 후 셋업 적응, RQ-15~16 라운드, team-lead 지시)**: RQ-16
 * item C(최초 입장도 스폰 보호)와 RQ-31(onJoin도 스폰 로테이션) 구현으로
 * 이 파일의 두 전제가 깨졌다 — B가 접속 직후 3초간 보호돼 사격이
 * 무효화됐고, A가 더 이상 원점에 고정되지 않는다
 * (`_workspace/RQ-15-16/02_coder_green.md` §3.3). 대응은
 * `rq-12-server-hitscan.test.ts`의 REV와 동일: B가 킬 시퀀스 전에
 * 스스로(빗나가는 방향으로) 한 발 쏴 보호를 즉시 해제하고, `aimAt`이
 * A의 실제 위치를 읽어 상대 오프셋을 계산하도록 일반화했다. 단언(HP
 * 감소량 50) 자체는 손대지 않았다.
 *
 * **REV2(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19·GA-11, `86fddf1`) 이후 B의 RQ-16
 * 해제 자기 사격은 B 자신의 Safe Zone(거리 0)에 막힐 수 있어
 * 화이트박스(`firedSinceSpawn`)로 대체한다. A도 이 파일 전체에서 한 번도
 * 움직이지 않아 A 자신의 스폰 지점(Safe Zone 내부)에 그대로 있다 — GA-19가
 * A의 사격 자체를 막는다. 기존 `travelAndSettle`(고정 +X, 900ms≈5.4m)은
 * 15개 스폰 지점 중 4개에서 다른 스폰 지점의 Safe Zone에 새로 들어가는
 * 것이 실측됐다(`rq-31-safe-zone.test.ts` §반경-방사 기하 참고) — B의
 * 이동도 반경-방사 화이트박스 텔레포트로 대체한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** RQ-31 회귀 대응 — 화이트박스 Safe Zone 탈출 텔레포트가 스키마
 * (`player.x/y/z`)에 정착할 시간(서버 틱 ≈33ms의 몇 배 여유). */
const SETTLE_MS = 200


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

interface PlayerFields {
  x: number
  z: number
  hp: number
}

/** REV: `z` 필드를 추가했다 — A가 더 이상 원점에 고정되지 않아(RQ-31
 * onJoin 로테이션) 조준 벡터 계산에 두 플레이어의 z좌표가 모두 필요하다
 * (파일 상단 REV 참고, 원래는 x만으로 충분했다). */
function readPlayer(room: Room, sessionId: string): PlayerFields | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; z?: unknown; hp?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (typeof player?.x === 'number' && typeof player?.z === 'number' && typeof player?.hp === 'number') {
    return { x: player.x, z: player.z, hp: player.hp }
  }
  return undefined
}

function waitForDefinedPlayer(room: Room, sessionId: string): Promise<PlayerFields> {
  return withTimeout(
    new Promise<PlayerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    `초기 스냅샷(x·hp 포함, sessionId=${sessionId}) 관측`,
  )
}

function waitForHpCondition(
  room: Room,
  sessionId: string,
  predicate: (hp: number) => boolean,
  label: string,
): Promise<PlayerFields> {
  return withTimeout(
    new Promise<PlayerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current && predicate(current.hp)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    label,
  )
}

/** RQ-31 회귀 대응 화이트박스 접근 대상 — `moveStates`·`positionHistory`·
 * `firedSinceSpawn`은 `GameRoom`의 기존 private 필드다(`rq-90-spread-seed
 * -determinism.test.ts`의 `SpreadTestSeam`·`rq-41-slot-promotion.test.ts`의
 * `PromotionTestSeam`이 이미 이 이름들로 화이트박스 결합한다, 그린필드가
 * 아니다). */
interface SafeZoneEscapeSeam {
  moveStates: Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean }>
  positionHistory: Map<string, unknown[]>
  firedSinceSpawn: Map<string, boolean>
}

function getSafeZoneSeam(room: Room): SafeZoneEscapeSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as SafeZoneEscapeSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-31 회귀 대응 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** RQ-31 Safe Zone 회귀 대응 — 세션을 자신의 현재 위치 기준 방사
 * 방향(원점→현재 위치)으로 밀어내 모든 Safe Zone 밖으로 옮긴다
 * (`rq-31-safe-zone.test.ts` §반경-방사 기하와 동일 증명 — 15개 스폰
 * 지점×오프셋 0~20m 전수 확인됨). */
function escapeSafeZone(
  seam: SafeZoneEscapeSeam,
  sessionId: string,
  base: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const radialMagnitude = Math.hypot(base.x, base.z)
  if (radialMagnitude < 1e-6) {
    throw new Error(`RQ-31 회귀 대응 전제 위반 — base(${base.x},${base.z})가 원점에 있어 방사 방향을 정의할 수 없다`)
  }
  const offsetM = WORLD.SAFE_ZONE_RADIUS_M + 15
  const ux = base.x / radialMagnitude
  const uz = base.z / radialMagnitude
  const escaped = { x: base.x + ux * offsetM, y: base.y, z: base.z + uz * offsetM }
  seam.moveStates.set(sessionId, { x: escaped.x, y: escaped.y, z: escaped.z, vx: 0, vy: 0, vz: 0, grounded: true })
  seam.positionHistory.delete(sessionId)
  return escaped
}

/** shooter(발 위치)에서 target(발 위치)의 verticalCenterM 높이를 정확히
 * 조준하는 방향 벡터(정규화)를 계산한다. REV: A가 더 이상 원점에 고정되지
 * 않으므로(RQ-31 onJoin 로테이션) 두 위치 모두를 인자로 받는 일반형이다. */
function aimAt(
  shooter: { x: number; z: number },
  target: { x: number; z: number },
  verticalCenterM: number,
): { dirX: number; dirY: number; dirZ: number } {
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = verticalCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

describe('RQ-13/GA-07: 머리 명중은 바디 데미지의 정확히 2배(50)를 적용한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-13/GA-07: A가 B의 머리 높이를 정확히 조준해 사격하면, B의 HP가 100에서 정확히 50(헤드 데미지 50 = 바디 25×2)만큼만 감소한다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      // RQ-31 회귀 대응(파일 상단 REV2) — B의 RQ-16 해제는 화이트박스로,
      // A·B 둘 다 Safe Zone 밖으로 옮긴다(모든 스폰 지점은 y=0 평지).
      const seam = getSafeZoneSeam(roomA)
      seam.firedSinceSpawn.set(roomB.sessionId, true)
      const escapedA = escapeSafeZone(seam, roomA.sessionId, { ...baselineA, y: 0 })
      const escapedB = escapeSafeZone(seam, roomB.sessionId, { ...baselineB, y: 0 })
      await sleep(SETTLE_MS)
      const aim = aimAt(escapedA, escapedB, DEFAULT_HITBOX.headCenterM)
      roomA.send('fire', aim)

      const afterShot = await waitForHpCondition(
        roomB,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        '헤드샷 사격 후 HP 감소 대기',
      )

      const headDamage = WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER
      expect(headDamage).toBe(50) // 전제 확인 — RQ-90 확정값
      expect(afterShot.hp).toBe(PLAYER.MAX_HP - headDamage)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )
})
