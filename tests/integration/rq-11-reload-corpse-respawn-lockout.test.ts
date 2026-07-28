import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WORLD } from '@shared/constants'

/**
 * RQ-11 리뷰 major-1 재현 — 시신이 재장전을 걸고, 그 잠금이 리스폰을 넘어
 * 살아난다 (ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * **출처 — 리뷰 major 재현(골든 신설 아님)**:
 * `_workspace/review/feat-RQ-10-11-ammo-reload.md` major 1. `handleFire`는
 * `canAct(shooterPlayer.hp)`(`GameRoom.ts:267`)로 시신의 사격을 막지만,
 * 이 PR이 추가한 `handleReload`(`GameRoom.ts:229-237`)에는 그 가드가 없다.
 * 사망해도 플레이어는 `state.players`에 남으므로(사망은 hp=0일 뿐 삭제가
 * 아니다) 시신이 `'reload'`를 보내면 `reloadStartedAtTick`이 설정된다.
 * `respawnPlayer`(`GameRoom.ts:510-524`)는 HP·위치·속도·스폰 보호·
 * `pendingInputs`를 전부 초기화하지만 `reloadStartedAtTick`은 지우지
 * 않으므로, 그 잠금이 리스폰을 넘어 살아남아 **방금 부활한 멀쩡한
 * 플레이어가 한동안 사격할 수 없는** 결함으로 관측된다. 리뷰·골든
 * 어디에도 없던 시나리오라 이 파일은 골든 케이스(GA-*)를 새로 만들지
 * 않는다 — 팀리드 지시로 재현 테스트만 추가한다.
 *
 * **시나리오**: 사수 A가 B를 사망시킨다 → B는 리스폰(`PLAYER.RESPAWN_MS`
 * =3000ms) 전, 시신 상태로 `'reload'`를 보낸다(현재 구현은 이 요청을
 * 그대로 받아들인다 — 가드 부재가 바로 이 결함의 전제) → B가 리스폰
 * (HP 100 복귀)한 직후, B가 A를 조준해 사격한다 → **스펙대로라면
 * 즉시 명중해야 하지만**, 현재 구현은 시신 시절 시작된 재장전 잠금이
 * 아직 살아 있어(아래 "타이밍" 참고) 이 사격이 무시된다 — 핵심 단언이
 * 타임아웃으로 실패한다(Red).
 *
 * **양성 대조군(별도 `describe`, 공허화 방지)**: 동일한 킬→리스폰 흐름을
 * B가 시신 상태에서 `'reload'`를 전혀 보내지 않고 반복한다 — 리스폰 직후
 * 사격이 즉시 명중해야 한다(현재 이미 성립 — 리스폰 로직 자체는 정상임을
 * 증명해, 위 결함이 "리스폰이 고장나서"가 아니라 "시신 재장전 잠금이
 * 리스폰을 넘어서기 때문"임을 분리한다).
 *
 * **타이밍(리뷰 지시대로 상수에서 유도, 하드코딩 아님)**: 시신 상태에서
 * `'reload'`를 보내는 시점 `CORPSE_RELOAD_SEND_DELAY_MS`는
 * `PLAYER.RESPAWN_MS`(3000ms)의 2/3 지점(2000ms)이다 — 두 조건을 동시에
 * 만족해야 한다: (1) `PLAYER.RESPAWN_MS`(3000ms) 미만이라 아직 리스폰
 * 전(시신)임이 보장되고, (2) `CORPSE_RELOAD_SEND_DELAY_MS + WEAPON
 * .RELOAD_MS`(2000+2000=4000ms)가 `PLAYER.RESPAWN_MS`(3000ms)를 넘어야
 * 재장전 완료가 리스폰 이후로 넘어가는 결함 시나리오가 성립한다(필요
 * 조건: `CORPSE_RELOAD_SEND_DELAY_MS > PLAYER.RESPAWN_MS - WEAPON
 * .RELOAD_MS` = 1000ms). 2000ms는 두 경계(1000ms·3000ms) 모두에서
 * 1000ms의 여유를 가져 서버 스케줄링 지터에 강건하다.
 *
 * **결정론 메모(실 대기 — 최후 수단)**: `rq-15-respawn-timer.test.ts`
 * 상단과 동일한 이유(서버 시간을 앞당길 훅이 없다)로 리스폰(3초)·재장전
 * 잠금(2초) 관측만은 실제로 기다린다. 모든 대기는 상한이 있거나 고정
 * 길이(길이 명시)다. 리스폰 후 보내는 단발 `'fire'`는 서버가 재시도하지
 * 않으므로(드롭되면 영구히 드롭) 관측 타임아웃을 넉넉히 둬도 뒤늦게
 * 우연히 통과할 위험이 없다.
 *
 * **가정**: `rq-15-respawn-timer.test.ts`의 `killPlayer` 패턴(부위 무관,
 * 매 사격 후 HP 변화만 확인)과 `rq-11-reload-lockout.test.ts`의 공허화
 * 방지 설계를 그대로 따른다.
 *
 * **제외**: 클라 탄약 HUD(RQ-53), 재장전 애니메이션·사운드.
 *
 * **REV(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19·GA-11, `86fddf1`) 이후 A(사수)·
 * B(피격자) 둘 다 각자의 스폰 지점(Safe Zone 내부, 거리 0)에 그대로 있으면
 * (1) GA-19가 A의 사격 자체를 막고 (2) B가 Safe Zone 안에 있으면 RQ-16과
 * 무관하게 GA-11(위치 기반 피해 무효화)이 계속 피해를 무효화한다. 킬
 * 시퀀스 전에 A·B 둘 다 화이트박스로 Safe Zone 밖으로 옮기고(반경-방사
 * 기하, `rq-31-safe-zone.test.ts` 참고), B의 RQ-16 해제도 자기 사격 대신
 * 화이트박스(`firedSinceSpawn`)로 한다. **리스폰 후 B는 새 스폰 지점(다시
 * Safe Zone 내부)으로 배치되므로, 부활 직후 사격(reviveAim) 전에 B를 다시
 * 한번 탈출시킨다** — A는 처음 탈출 이후 움직이지 않으므로 재탈출이 필요
 * 없다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300
/** RQ-31 회귀 대응 — 화이트박스 Safe Zone 탈출 텔레포트가 스키마
 * (`player.x/y/z`)에 정착할 시간(서버 틱 ≈33ms의 몇 배 여유). */
const RELEASE_PROTECTION_SETTLE_MS = 300
/** 사망 후 이 시점에 시신 상태로 'reload'를 보낸다 — 파일 상단 "타이밍"
 * 절 참고. `PLAYER.RESPAWN_MS`(3000ms)에서 유도(하드코딩 아님). */
const CORPSE_RELOAD_SEND_DELAY_MS = (PLAYER.RESPAWN_MS / 3) * 2
/** 리스폰 관측 상한 — 3000ms + 실 서버 스케줄링 지터를 넉넉히 흡수하는 여유
 * (`rq-15-respawn-timer.test.ts`의 `RESPAWN_OBSERVE_TIMEOUT_MS`와 동일 근거). */
const RESPAWN_OBSERVE_TIMEOUT_MS = 8_000

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
  z: number
  hp: number
}

function readPlayer(room: Room, sessionId: string): PlayerSnapshot | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; z?: unknown; hp?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (typeof player?.x === 'number' && typeof player?.z === 'number' && typeof player?.hp === 'number') {
    return { x: player.x, z: player.z, hp: player.hp }
  }
  return undefined
}

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
        if (current && predicate(current)) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    timeoutMs,
    label,
  )
}

/** shooter(발 위치)에서 target(발 위치)의 바디 중심을 정확히 조준하는
 * 방향 벡터(정규화) — 다른 RQ-10/11/15/16 파일들과 동일한 일반형. */
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
 * 지점×오프셋 0~20m 전수 확인됨). 고정 방향(예: +X) 실이동은 특정 스폰
 * 인덱스에서 다른 스폰 지점의 Safe Zone에 새로 들어갈 수 있어(실측
 * 4/15 위반) 쓰지 않는다. */
function escapeSafeZone(
  seam: SafeZoneEscapeSeam,
  sessionId: string,
  base: { x: number; z: number },
): { x: number; y: number; z: number } {
  const radialMagnitude = Math.hypot(base.x, base.z)
  if (radialMagnitude < 1e-6) {
    throw new Error(`RQ-31 회귀 대응 전제 위반 — base(${base.x},${base.z})가 원점에 있어 방사 방향을 정의할 수 없다`)
  }
  const offsetM = WORLD.SAFE_ZONE_RADIUS_M + 15
  const ux = base.x / radialMagnitude
  const uz = base.z / radialMagnitude
  // 이 파일의 PlayerSnapshot은 y를 추적하지 않는다 — 모든 스폰 지점은
  // 평지(y=0)이므로 0으로 고정한다.
  const escaped = { x: base.x + ux * offsetM, y: 0, z: base.z + uz * offsetM }
  seam.moveStates.set(sessionId, { x: escaped.x, y: escaped.y, z: escaped.z, vx: 0, vy: 0, vz: 0, grounded: true })
  seam.positionHistory.delete(sessionId)
  return escaped
}

/** A의 사격으로 B를 사망(HP 0)까지 몰아간다. 부위(헤드/바디) 무관 설계 —
 * `rq-15-respawn-timer.test.ts`의 `killPlayer`와 동일한 이유·동일한 설계
 * (매 사격 후 "hp가 직전 값에서 실제로 줄었는가"만 확인). B의 RQ-16 최초
 * 입장 스폰 보호는 화이트박스로 즉시 해제한다(REV — 자기 사격은 B 자신의
 * Safe Zone에 막힐 수 있다, 파일 상단 REV 참고). **호출자가 이미 A·B를
 * Safe Zone 밖으로 옮겨 뒀다는 전제**다(이 함수는 위치를 건드리지 않는다).*/
async function killPlayer(
  seam: SafeZoneEscapeSeam,
  roomA: Room,
  roomB: Room,
  baselineB: PlayerSnapshot,
  aim: { dirX: number; dirY: number; dirZ: number },
): Promise<PlayerSnapshot> {
  seam.firedSinceSpawn.set(roomB.sessionId, true)

  let previousHp = baselineB.hp
  const MAX_KILL_SHOTS = 4 // 바디샷만 맞을 때의 상한(헤드샷이 섞이면 더 일찍 끝난다)
  for (let shot = 1; shot <= MAX_KILL_SHOTS && previousHp > 0; shot += 1) {
    roomA.send('fire', aim)
    const afterShot = await waitForPlayerCondition(
      roomB,
      roomB.sessionId,
      (p) => p.hp !== previousHp,
      `${shot}번째 사격 후 HP 변화 대기(직전 HP=${previousHp})`,
      HP_TIMEOUT_MS,
    )
    previousHp = afterShot.hp
    if (previousHp > 0) await sleep(BETWEEN_SHOTS_MS)
  }
  const atDeath = readPlayer(roomB, roomB.sessionId)
  if (!atDeath) throw new Error('killPlayer: 사망 직후 B 스냅샷 관측 실패')
  expect(atDeath.hp).toBe(0)
  return atDeath
}

describe('RQ-11 리뷰 major-1 재현: 시신이 건 재장전 잠금이 리스폰을 넘어 살아난다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-11 major-1: 시신 상태에서 reload를 보내면, 리스폰 직후 정상적인(멀쩡한) 플레이어의 사격이 무시된다 — 현재 구현에서는 실패해야 한다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        // RQ-31 회귀 대응(파일 상단 REV) — A·B 둘 다 Safe Zone 밖으로 옮긴다.
        const seam = getSafeZoneSeam(roomA)
        const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
        const escapedB = escapeSafeZone(seam, roomB.sessionId, baselineB)
        await sleep(RELEASE_PROTECTION_SETTLE_MS)

        const killAim = aimAtBody(escapedA, escapedB)
        await killPlayer(seam, roomA, roomB, baselineB, killAim)
        const deathAtMs = Date.now()

        // 전제 확인 + 타이밍 확보 — CORPSE_RELOAD_SEND_DELAY_MS만큼
        // 기다린 뒤에도 B가 아직 시신 상태(hp===0, 리스폰 전)인지 먼저
        // 확인한다. 이 전제가 깨지면(예: 예상보다 빨리 리스폰) 아래
        // 'reload' 전송이 시신이 아닌 산 플레이어의 정상 요청이 되어
        // 시나리오 자체가 성립하지 않으므로, 조용히 넘어가지 않고 여기서
        // 즉시 드러나야 한다.
        await sleep(CORPSE_RELOAD_SEND_DELAY_MS)
        const stillCorpse = readPlayer(roomB, roomB.sessionId)
        if (!stillCorpse) throw new Error('시신 상태 스냅샷 관측 실패')
        expect(stillCorpse.hp).toBe(0)

        // 핵심 결함 트리거 — 시신 상태의 B가 'reload'를 보낸다. 현재
        // 구현(`handleReload`)은 canAct 가드가 없어 이 요청을 그대로
        // 받아들인다(major-1의 전제).
        roomB.send('reload', {})

        // 리스폰 대기(3초) — `killPlayer`가 아니라 사망 시점(deathAtMs)
        // 기준으로 남은 시간만 기다린다.
        const elapsedSinceDeath = Date.now() - deathAtMs
        const remainingUntilRespawnMs = Math.max(0, PLAYER.RESPAWN_MS - elapsedSinceDeath)
        await sleep(remainingUntilRespawnMs)

        const afterRespawn = await waitForPlayerCondition(
          roomB,
          roomB.sessionId,
          (p) => p.hp === PLAYER.MAX_HP,
          'RQ-11 major-1: 사망 후 3초 경과 리스폰(HP 100 복귀) 대기',
          RESPAWN_OBSERVE_TIMEOUT_MS,
        )
        expect(afterRespawn.hp).toBe(PLAYER.MAX_HP)

        // 핵심 Red 단언 — 리스폰 직후, 방금 부활한 B가 A를 조준해 쏘면
        // 스펙대로라면 즉시 명중해야 한다(HP 감소). 현재 구현은 시신
        // 시절 시작된 재장전 잠금이 respawnPlayer에서 지워지지 않아 아직
        // 살아 있으므로(파일 상단 "타이밍" 절 — 잠금은 사망+4000ms까지,
        // 리스폰은 사망+3000ms) 이 사격이 무시되고 아래 단언이 타임아웃
        // 으로 실패한다.
        // RQ-31 회귀 대응 — 리스폰으로 B는 새 스폰 지점(다시 Safe Zone
        // 내부)에 배치된다. A는 처음 탈출 이후 움직이지 않았으므로
        // `escapedA`를 그대로 쓴다.
        const escapedBAfterRespawn = escapeSafeZone(seam, roomB.sessionId, afterRespawn)
        await sleep(RELEASE_PROTECTION_SETTLE_MS)
        const reviveAim = aimAtBody(escapedBAfterRespawn, escapedA)
        roomB.send('fire', reviveAim)
        const afterReviveShot = await waitForPlayerCondition(
          roomA,
          roomA.sessionId,
          (p) => p.hp < baselineA.hp,
          'RQ-11 major-1: 리스폰 직후 사격 시 상대(A) HP 감소 대기 — 현재 구현에서는 시신 시절 잠금이 남아 타임아웃된다',
          HP_TIMEOUT_MS,
        )
        expect(afterReviveShot.hp).toBeLessThan(baselineA.hp)
      } finally {
        await Promise.allSettled([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    30_000,
  )
})

describe('RQ-11 major-1 양성 대조군: 시신이 reload를 보내지 않으면 리스폰 직후 사격은 정상 작동한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-11 major-1 양성 대조군: 시신 상태에서 reload를 보내지 않으면, 리스폰 직후 사격이 즉시 명중한다(리스폰 로직 자체는 정상)',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        // RQ-31 회귀 대응(파일 상단 REV) — A·B 둘 다 Safe Zone 밖으로 옮긴다.
        const seam = getSafeZoneSeam(roomA)
        const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
        const escapedB = escapeSafeZone(seam, roomB.sessionId, baselineB)
        await sleep(RELEASE_PROTECTION_SETTLE_MS)

        const killAim = aimAtBody(escapedA, escapedB)
        await killPlayer(seam, roomA, roomB, baselineB, killAim)
        const deathAtMs = Date.now()

        // 위 defect 시나리오와 동일한 흐름이되, 'reload'를 전혀 보내지
        // 않는다 — 리스폰 로직 자체의 건강함을 독립적으로 증명한다.
        const elapsedSinceDeath = Date.now() - deathAtMs
        const remainingUntilRespawnMs = Math.max(0, PLAYER.RESPAWN_MS - elapsedSinceDeath)
        await sleep(remainingUntilRespawnMs)

        const afterRespawn = await waitForPlayerCondition(
          roomB,
          roomB.sessionId,
          (p) => p.hp === PLAYER.MAX_HP,
          'RQ-11 major-1 대조군: 사망 후 3초 경과 리스폰(HP 100 복귀) 대기',
          RESPAWN_OBSERVE_TIMEOUT_MS,
        )
        expect(afterRespawn.hp).toBe(PLAYER.MAX_HP)

        // RQ-31 회귀 대응 — 리스폰으로 B는 새 스폰 지점(다시 Safe Zone
        // 내부)에 배치된다. A는 처음 탈출 이후 움직이지 않았으므로
        // `escapedA`를 그대로 쓴다.
        const escapedBAfterRespawn = escapeSafeZone(seam, roomB.sessionId, afterRespawn)
        await sleep(RELEASE_PROTECTION_SETTLE_MS)
        const reviveAim = aimAtBody(escapedBAfterRespawn, escapedA)
        roomB.send('fire', reviveAim)
        const afterReviveShot = await waitForPlayerCondition(
          roomA,
          roomA.sessionId,
          (p) => p.hp < baselineA.hp,
          'RQ-11 major-1 대조군: 리스폰 직후 사격 시 상대(A) HP 감소 대기 — 이미 성립해야 한다',
          HP_TIMEOUT_MS,
        )
        expect(afterReviveShot.hp).toBeLessThan(baselineA.hp)
      } finally {
        await Promise.allSettled([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    30_000,
  )
})
