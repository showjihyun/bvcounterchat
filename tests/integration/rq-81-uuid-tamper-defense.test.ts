import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '@server/index'
import { getStats, openStatsDb, type StatsDb } from '@server/persistence/statsDb'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON, WORLD } from '@shared/constants'

/**
 * RQ-81 통계 절반(B계층 — 변조·형식 오류 UUID 방어) — 서버 권위(RQ-61)
 * 통합 테스트(ADR-0008: Colyseus 룸 경계, ADR-0011: SQLite 영속 Red-first
 * 영역).
 *
 * **ADR-0006과의 관계(오해 방지 — `tests/unit/rq-81-uuid-validation.test.ts`
 * 상단과 동일한 경고를 여기도 반복한다)**: ADR-0006은 "서버가 UUID의
 * **소유권**(누구 것인가)을 검증하지 않는다"를 명시적으로 확정했다 — 이
 * 파일은 그걸 어기지 않는다. 즉 **"UUID-A를 아는 누군가가 UUID-A를
 * 자칭하는 것"은 이 파일이 막지 않는다**(ADR이 수용한 위험, 정상
 * 동작이다). 이 파일이 막는 것은 그와 다른 층위 하나뿐이다 — **payload가
 * 애초에 UUID 형식조차 아닌 경우**(타입 오류·빈 문자열·구조 불일치) 서버가
 * (a) 크래시하거나 (b) 서로 무관한 그런 세션들의 기록을 같은 fallback
 * 키 하나로 뭉쳐 실제 UUID 행을 오염시키지 않는가.
 *
 * **가정(coder에게)**: `rq-81-uuid-stat-persistence.test.ts`(GA-22)의
 * "가정" 절 1~5와 동일. 이 파일의 케이스들이 요구하는 추가 동작 —
 * `options.uuid`가 `@shared/stats/uuid`의 `isValidStatsUuid`를 통과하지
 * 못하면(미제공·타입 오류·형식 오류) 서버는 (a) 접속 자체는 정상 진행하고
 * (RQ-61 "크래시보다 안전한 기본값" 원칙 — 정원(RQ-03)·닉네임(RQ-02) 검사와
 * 무관한 별개 관심사이므로 이 이유만으로 접속을 거부할 근거가 없다) (b)
 * 그 세션에 uuid를 아예 매핑하지 않는다(통계 미추적) — 즉 "잘못된 값이면
 * 안전한 대체 키로 대체"가 아니라 "이번 판은 통계에서 아예 빠진다"가
 * 안전한 기본값이다. 대체 키 방식을 쓰면 서로 무관한 여러 형식 오류
 * 세션이 같은 키로 수렴해 그 자체로 교차 오염이 된다 — 이게 이 파일이
 * 명시적으로 반증하는 대상이다.
 *
 * **관측 지점**: `openStatsDb`/`getStats`로 SQLite 파일 직접 읽기.
 *
 * **양성 대조군**: "형식 오류 uuid는 통계가 안 남는다"만으로는 통계
 * 기능이 통째로 없는 것과 구분되지 않는다 — 그래서 이 파일은 **유효한
 * UUID-A의 행이 먼저 실제 값(kills=1)을 갖도록 만든 뒤**, 그 값이 뒤이은
 * 형식 오류 세션들의 활동에도 **불변**임을 확인한다.
 *
 * **결정론 메모**: 실 WebSocket 의존(ADR-0008 허용 예외). 모든 대기에
 * `withTimeout()` 상한.
 *
 * **REV(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19·GA-11, `86fddf1`) 이후 사수·피격자
 * 둘 다 각자의 스폰 지점(Safe Zone 내부, 거리 0)에 그대로 있으면 킬
 * 시퀀스 자체가 성립하지 않는다. 기존 `unlockProtectionAndSettle`(자기
 * 사격 + 고정 +X 실이동)을 화이트박스 Safe Zone 탈출(`firedSinceSpawn`
 * 직접 기입 + 반경-방사 텔레포트, `rq-31-safe-zone.test.ts` §반경-방사
 * 기하)로 대체했다 — 고정 +X 실이동은 15개 스폰 지점 중 4개에서 다른
 * 스폰 지점의 Safe Zone에 새로 들어가는 것이 실측됐다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const STATE_TIMEOUT_MS = 5_000
/** RQ-31 회귀 대응 — 화이트박스 Safe Zone 탈출 텔레포트가 스키마
 * (`player.x/y/z`)에 정착할 시간(서버 틱 ≈33ms의 몇 배 여유). */
const SETTLE_MS = 200
const BETWEEN_SHOTS_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[timeout ${ms}ms] ${label}`)), ms)
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

function createTempStatsDbPath(prefix: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { path: join(dir, 'stats.db'), dir }
}

async function startServer(statsDbPath: string): Promise<RunningServer> {
  const app = buildServer({ logger: false, statsDbPath })
  const address = await withTimeout(app.listen({ port: 0, host: '127.0.0.1' }), LISTEN_TIMEOUT_MS, 'app.listen({ port: 0 })')
  const { port } = new URL(address)
  return { app, endpoint: `ws://127.0.0.1:${port}` }
}

async function stopServer(server: RunningServer): Promise<void> {
  await withTimeout(server.app.close(), CLOSE_TIMEOUT_MS, 'app.close()')
}

function newClient(server: RunningServer): Client {
  return new Client(server.endpoint)
}

/** GA-22/23과 달리 `uuid`가 임의의(잘못된) 값일 수 있으므로 옵션 타입을
 * `unknown`으로 느슨하게 받는다 — 실제 변조된 클라이언트가 보낼 수 있는
 * payload를 그대로 흉내낸다. */
async function joinGameWithRawOptions(client: Client, options: Record<string, unknown>): Promise<Room> {
  return withTimeout(client.joinOrCreate(ROOM_NAME, options), JOIN_TIMEOUT_MS, `joinOrCreate('${ROOM_NAME}', ${JSON.stringify(options)})`)
}

async function leaveRoom(room: Room): Promise<void> {
  await withTimeout(room.leave(true), LEAVE_TIMEOUT_MS, 'room.leave(true)')
}

interface PlayerFields {
  x: number
  z: number
  hp: number
}

function readPlayer(room: Room, sessionId: string): PlayerFields | undefined {
  const state = room.state as { players?: { get?: (key: string) => { x?: unknown; z?: unknown; hp?: unknown } | undefined } } | null
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
    STATE_TIMEOUT_MS,
    `초기 스냅샷(x·hp 포함, sessionId=${sessionId}) 관측`,
  )
}

function waitForHpCondition(room: Room, sessionId: string, predicate: (hp: number) => boolean, label: string): Promise<PlayerFields> {
  return withTimeout(
    new Promise<PlayerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current && predicate(current.hp)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    STATE_TIMEOUT_MS,
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
function escapeSafeZone(seam: SafeZoneEscapeSeam, sessionId: string, base: { x: number; z: number }): PlayerFields {
  const radialMagnitude = Math.hypot(base.x, base.z)
  if (radialMagnitude < 1e-6) {
    throw new Error(`RQ-31 회귀 대응 전제 위반 — base(${base.x},${base.z})가 원점에 있어 방사 방향을 정의할 수 없다`)
  }
  const offsetM = WORLD.SAFE_ZONE_RADIUS_M + 15
  const ux = base.x / radialMagnitude
  const uz = base.z / radialMagnitude
  const escaped = { x: base.x + ux * offsetM, y: 0, z: base.z + uz * offsetM, hp: PLAYER.MAX_HP }
  seam.moveStates.set(sessionId, { x: escaped.x, y: 0, z: escaped.z, vx: 0, vy: 0, vz: 0, grounded: true })
  seam.positionHistory.delete(sessionId)
  return escaped
}

/** RQ-31 회귀 대응 — `room`의 RQ-16 최초 입장 보호를 화이트박스로 즉시
 * 해제하고(자기 사격은 자신의 Safe Zone에 막힐 수 있다), Safe Zone 밖으로
 * 텔레포트한다(`unlockProtectionAndSettle`의 대체). */
async function unlockProtectionAndSettle(seam: SafeZoneEscapeSeam, room: Room): Promise<PlayerFields> {
  const baseline = await waitForDefinedPlayer(room, room.sessionId)
  seam.firedSinceSpawn.set(room.sessionId, true)
  const escaped = escapeSafeZone(seam, room.sessionId, baseline)
  await sleep(SETTLE_MS)
  return escaped
}

function aimAtBody(shooter: { x: number; z: number }, target: { x: number; z: number }): { dirX: number; dirY: number; dirZ: number } {
  const bodyCenterM = (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = bodyCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

async function killWithBodyshots(shooterRoom: Room, victimRoom: Room, shooterPos: PlayerFields, victimPos: PlayerFields): Promise<void> {
  const aim = aimAtBody(shooterPos, victimPos)
  for (let shot = 1; shot <= 4; shot += 1) {
    shooterRoom.send('fire', aim)
    const expectedHp = Math.max(0, PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * shot)
    await waitForHpCondition(victimRoom, victimRoom.sessionId, (hp) => hp === expectedHp, `${shot}번째 바디샷 후 HP=${expectedHp} 대기`)
    await sleep(BETWEEN_SHOTS_MS)
  }
}

/** 형식 오류 uuid로 접속해 실제로 킬을 하나 만든다 — 접속 자체가
 * 거부되지 않고(크래시 없음), 그 킬이 어딘가의 공유 fallback 키로
 * 새어나가지 않는지를 뒤이은 단언이 확인한다. */
async function joinAndKillWithMalformedUuid(server: RunningServer, nickname: string, rawUuid: unknown): Promise<void> {
  const attacker = await joinGameWithRawOptions(newClient(server), { nickname, uuid: rawUuid })
  const victim = await joinGameWithRawOptions(newClient(server), { nickname: `${nickname}-victim`, uuid: randomUUID() })

  const seam = getSafeZoneSeam(attacker)
  const attackerPos = await unlockProtectionAndSettle(seam, attacker)
  const victimPos = await unlockProtectionAndSettle(seam, victim)
  await waitForDefinedPlayer(victim, victim.sessionId)

  await killWithBodyshots(attacker, victim, attackerPos, victimPos)

  await Promise.all([leaveRoom(attacker), leaveRoom(victim)])
}

describe('RQ-81: 형식 오류·변조된 UUID가 접속을 막지도, 다른 통계 행을 오염시키지도 않는다', () => {
  let server: RunningServer
  let statsDb: StatsDb
  let tempDir: string

  beforeAll(async () => {
    const temp = createTempStatsDbPath('rq-81-tamper-')
    tempDir = temp.dir
    server = await startServer(temp.path)
    statsDb = openStatsDb(temp.path)
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    statsDb.close()
    await stopServer(server)
    rmSync(tempDir, { recursive: true, force: true })
  })

  it(
    'RQ-81: 유효한 UUID-A로 킬 1을 먼저 쌓은 뒤, uuid 미제공·타입 오류·형식 오류 세션들이 각각 접속해 킬을 만들어도 크래시 없이 진행되고 UUID-A의 행은 kills=1로 불변이며, 어떤 흔한 폴백 키에도 행이 생기지 않는다',
    async () => {
      const uuidA = randomUUID()

      // === 양성 대조군 — 유효한 UUID-A가 먼저 실제 값을 갖는다 ===
      const a = await joinGameWithRawOptions(newClient(server), { nickname: 'alice', uuid: uuidA })
      const baselineVictim = await joinGameWithRawOptions(newClient(server), { nickname: 'baseline-victim', uuid: randomUUID() })
      const baselineSeam = getSafeZoneSeam(a)
      const aPos = await unlockProtectionAndSettle(baselineSeam, a)
      const baselineVictimPos = await unlockProtectionAndSettle(baselineSeam, baselineVictim)
      await waitForDefinedPlayer(baselineVictim, baselineVictim.sessionId)
      await killWithBodyshots(a, baselineVictim, aPos, baselineVictimPos)
      await Promise.all([leaveRoom(a), leaveRoom(baselineVictim)])

      const baseline = getStats(statsDb, uuidA)
      expect(baseline?.kills).toBe(1)

      // === 형식 오류 세션들 — 접속·플레이가 크래시 없이 끝까지 진행돼야 한다 ===
      await joinAndKillWithMalformedUuid(server, 'no-uuid-field', undefined) // uuid 필드 자체가 없음(payload에서 삭제)
      await joinAndKillWithMalformedUuid(server, 'number-uuid', 12345)
      await joinAndKillWithMalformedUuid(server, 'object-uuid', { evil: true })
      await joinAndKillWithMalformedUuid(server, 'array-uuid', [uuidA]) // 유효한 UUID를 배열로 감싸 우회 시도
      await joinAndKillWithMalformedUuid(server, 'empty-uuid', '')
      await joinAndKillWithMalformedUuid(server, 'garbage-uuid', 'not-a-uuid-at-all')
      await joinAndKillWithMalformedUuid(server, 'huge-uuid', 'a'.repeat(10_000))

      // === 핵심 단언 1 — 유효한 UUID-A 행은 위 7개 형식 오류 세션의 활동과
      // 무관하게 그대로다(교차 오염 없음). 서버가 여전히 정상 응답하는 것도
      // 이 조회 자체가 성공한다는 사실로 함께 확인된다. ===
      const afterMalformedSessions = getStats(statsDb, uuidA)
      expect(afterMalformedSessions?.kills).toBe(1)

      // === 핵심 단언 2 — 흔히 쓰일 법한 "폴백 키" 후보 전부에 행이 없다.
      // 이 중 하나라도 값이 있다면, 서로 무관한 여러 형식 오류 세션이 그
      // 키 하나로 수렴해 서로의 통계를 뒤섞었다는 뜻이다(정확히 이 파일이
      // 반증하려는 결함). ===
      const suspiciousFallbackKeys = ['undefined', 'null', '', '[object Object]', 'NaN', String(12345)]
      for (const key of suspiciousFallbackKeys) {
        expect(getStats(statsDb, key)).toBeUndefined()
      }
    },
    120_000,
  )
})
