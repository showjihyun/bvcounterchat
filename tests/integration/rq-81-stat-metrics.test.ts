import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '@server/index'
import { getStats, openStatsDb, type StatsDb } from '@server/persistence/statsDb'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'

/**
 * RQ-81 통계 절반(B계층 — 네 지표 각각의 기록 확인: 킬·데스·헤드샷·
 * 플레이타임) — 서버 권위(RQ-61) 통합 테스트(ADR-0008: Colyseus 룸 경계,
 * ADR-0011: SQLite 영속 Red-first 영역).
 *
 * RQ-81 전문의 "누적 통계(킬·데스·헤드샷·플레이타임)" 네 지표를 각각
 * 개별적으로 고정한다. 전용 골든 케이스는 없다(GA-22/23은 UUID 키잉
 * 자체에 집중 — 이 파일은 그 키잉된 행 **안의 값**이 맞는지를 본다).
 *
 * **설계 결정 — "헤드샷" 통계의 정의(`tests/unit/rq-81-stats-math.test.ts`
 * 상단 docblock "설계 결정 1"과 동일 근거, 요약)**: 헤드샷은 킬의 부분집합
 * (헤드샷으로 죽인 킬만 카운트, 헤드샷 명중 자체는 별도로 세지 않는다).
 * 이 파일은 그 결정을 실제 Colyseus 판정(`RQ-13` 헤드샷 배율)과 결합해
 * 재현한다 — 헤드샷 킬 1회, 바디샷 킬 1회를 각각 만들어
 * `headshots <= kills`이고 바디킬은 `headshots`를 올리지 않는 것을 함께
 * 확인한다(단위 테스트가 이미 고정한 산술이 실제 서버 hitscan 판정
 * 경로에도 배선돼 있는지의 B계층 확인 — ADR-0008 레벨 분리).
 *
 * **설계 결정 — 플레이타임 기록 시점(팀리드 위임 "설계 포크 2")**: 접속
 * 중에는 계속 갱신하지 않고 **퇴장(`onLeave`) 시점에 한 번 적재**한다
 * (`_workspace/RQ-81/01_test-writer_red.md` §2.2 근거 — RQ-81이 요구하는
 * 저빈도 이벤트 로그 정신에 맞고, RQ-80/81이 이미 "재시작 시 접속 중
 * 세션은 끊긴다"를 수용해 그 손실 범위와 대칭적이다). 이 파일은 그 결정을
 * 두 단계로 확인한다: (a) 접속 중에는 아직 반영되지 않는다 (b) 퇴장 직후
 * 경과 시간만큼 반영된다.
 *
 * **가정(coder에게)**: `rq-81-uuid-stat-persistence.test.ts`(GA-22)의
 * "가정" 절과 완전히 동일. 추가로 이 파일 전용 — `onLeave`가 세션의
 * 접속 시각(`Date.now()` 기준, `src/server`는 ADR-0008 lint 대상이 아니다
 * — `handleFire`의 rate-limit과 동일한 시간 조달 방식)부터 퇴장까지의
 * 경과를 `addPlaytimeMs`로 적재한다. uuid가 없는(미제공·형식 오류) 세션은
 * 플레이타임도 적재하지 않는다(다른 세 지표와 동일 원칙).
 *
 * **관측 지점**: `openStatsDb`/`getStats`로 SQLite 파일 직접 읽기(근거는
 * GA-22 파일 상단 참고).
 *
 * **결정론 메모**: 실 WebSocket 의존(ADR-0008 허용 예외). 플레이타임
 * 단언은 실시간 `sleep` 경과에 묶이므로(서버가 실제 벽시계로 기록하는
 * 값이라 다른 방법이 없다) 관대한 하한만 확인한다(CI 지터 허용).
 *
 * **REV(fix-02, 타이밍 결함 수정)**: 최초 버전은 "K가 V1을 헤드샷킬 →
 * V2가 K를 바디샷킬(K 사망) → K가 V3를 바디샷킬"순이었다. `handleFire`는
 * `canAct(player.hp)`가 거짓이면(RQ-15 시신 규칙, 이번 라운드가 건드리지
 * 않은 기존 로직) 사격 요청을 조용히 무시하고 `PLAYER.RESPAWN_MS`
 * (3000ms)가 지나야 다시 사격할 수 있는데, 2·3번 사이 간격은
 * `BETWEEN_SHOTS_MS`(300ms)뿐이라 3번의 K 사격이 매번 버려져 V3의 HP가
 * 영원히 바뀌지 않고 타임아웃났다(coder가 독립 스크립트로 재현·확인,
 * `_workspace/RQ-81/03_test-writer_metrics-fix.md` 근거 전문). **수정**:
 * K가 죽는 사건(V2의 킬)을 시퀀스 맨 끝으로 재배치했다 — K는 자신이 죽기
 * 전까지만 사격하므로 이 게이트와 부딪힐 여지가 시퀀스 구조상 없어진다.
 * 리스폰 대기(고정 sleep이든 조건 대기든)를 추가하는 대안도 검토했으나
 * 채택하지 않았다 — 근거는 `03_test-writer_metrics-fix.md` §1(요지: 이
 * 파일이 검증하는 것은 "세 카운터가 서로 독립적으로 자기 사건에만
 * 반응하는가"이지 "죽었다 살아난 뒤에도 사격할 수 있는가"(RQ-15의
 * 관심사)가 아니다 — 재배치가 대기 없이 동일한 계약을 검증한다). 세
 * `expect` 묶음(헤드샷 킬·바디샷 킬·데스 각각의 카운터 독립성)은 순서만
 * 바뀌었을 뿐 전부 그대로 유지했다 — 약화가 아니다(값은 최종적으로
 * `kills=2·headshots=1·deaths=1`로 이전과 동일).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const STATE_TIMEOUT_MS = 5_000
const TRAVEL_MS = 900
const SETTLE_MS = 200
const BETWEEN_SHOTS_MS = 300
/** 플레이타임 관측 구간 — 서버 벽시계에 의존하므로 CI 지터를 감안해
 * 여유 있게 잡는다(허용 RTT·rate-limit보다 한 자릿수 위). */
const SESSION_DURATION_MS = 2_000
/** 경과 시간 하한 — 정확히 SESSION_DURATION_MS를 요구하면 스케줄링 지연
 * 몇십 ms에도 flaky해진다. 25% 여유를 뺀 하한만 확인한다. */
const PLAYTIME_LOWER_BOUND_MS = 1_500

const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

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

async function joinGame(client: Client, options: { nickname: string; uuid: string }): Promise<Room> {
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

async function travelAndSettle(mover: Room): Promise<PlayerFields> {
  mover.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
  await sleep(TRAVEL_MS)
  mover.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
  await sleep(SETTLE_MS)
  const settled = readPlayer(mover, mover.sessionId)
  if (!settled) throw new Error('travelAndSettle: 이동 후 위치 관측 실패')
  return settled
}

async function unlockProtectionAndSettle(room: Room): Promise<PlayerFields> {
  room.send('fire', UP_MISS_AIM)
  return travelAndSettle(room)
}

function aimAt(shooter: { x: number; z: number }, target: { x: number; z: number }, verticalCenterM: number): { dirX: number; dirY: number; dirZ: number } {
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = verticalCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

async function killWithBodyshots(shooterRoom: Room, victimRoom: Room, shooterPos: PlayerFields, victimPos: PlayerFields): Promise<void> {
  const aim = aimAt(shooterPos, victimPos, (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2)
  for (let shot = 1; shot <= 4; shot += 1) {
    shooterRoom.send('fire', aim)
    const expectedHp = Math.max(0, PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * shot)
    await waitForHpCondition(victimRoom, victimRoom.sessionId, (hp) => hp === expectedHp, `${shot}번째 바디샷 후 HP=${expectedHp} 대기`)
    await sleep(BETWEEN_SHOTS_MS)
  }
}

/** RQ-13 헤드샷(데미지 50) 2연타 = 정확히 100 = 킬(`rq-13-headshot-multiplier
 * .test.ts` 확정값 재사용). */
async function killWithHeadshots(shooterRoom: Room, victimRoom: Room, shooterPos: PlayerFields, victimPos: PlayerFields): Promise<void> {
  const aim = aimAt(shooterPos, victimPos, DEFAULT_HITBOX.headCenterM)
  const headDamage = WEAPON.DAMAGE_BODY * WEAPON.HEADSHOT_MULTIPLIER
  expect(headDamage).toBe(50) // 전제 확인 — RQ-90 확정값(rq-13과 동일 가드)
  for (let shot = 1; shot <= 2; shot += 1) {
    shooterRoom.send('fire', aim)
    const expectedHp = Math.max(0, PLAYER.MAX_HP - headDamage * shot)
    await waitForHpCondition(victimRoom, victimRoom.sessionId, (hp) => hp === expectedHp, `${shot}번째 헤드샷 후 HP=${expectedHp} 대기`)
    await sleep(BETWEEN_SHOTS_MS)
  }
}

describe('RQ-81: 킬·데스·헤드샷·플레이타임 네 지표가 각각 올바르게 기록된다', () => {
  let server: RunningServer
  let statsDb: StatsDb
  let tempDir: string

  beforeAll(async () => {
    const temp = createTempStatsDbPath('rq-81-metrics-')
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
    'RQ-81: K가 V1을 헤드샷으로 죽이면 kills=1·headshots=1, K가 V3을 바디샷으로 죽이면 kills=2인데 headshots는 1로 불변, 마지막으로 V2가 K를 바디샷으로 죽이면 K의 deaths=1이고 kills·headshots는 그대로다',
    async () => {
      const uuidK = randomUUID()

      const k = await joinGame(newClient(server), { nickname: 'K', uuid: uuidK })
      const v1 = await joinGame(newClient(server), { nickname: 'V1', uuid: randomUUID() })
      const v2 = await joinGame(newClient(server), { nickname: 'V2', uuid: randomUUID() })
      const v3 = await joinGame(newClient(server), { nickname: 'V3', uuid: randomUUID() })

      const kPos = await unlockProtectionAndSettle(k)
      const v1Pos = await unlockProtectionAndSettle(v1)
      const v2Pos = await unlockProtectionAndSettle(v2)
      const v3Pos = await unlockProtectionAndSettle(v3)
      await waitForDefinedPlayer(v1, v1.sessionId)
      await waitForDefinedPlayer(v2, v2.sessionId)
      await waitForDefinedPlayer(v3, v3.sessionId)

      // 순서 — K가 죽는 사건(3번)을 시퀀스 맨 끝에 둔다(fix-02 재배치,
      // `_workspace/RQ-81/03_test-writer_metrics-fix.md` 근거 전문 참고).
      // K가 살아있는 동안(1·2번)에만 K 자신이 사격하므로, `handleFire`의
      // `canAct` 사망자 게이트(RQ-15, `GameRoom.ts` — 이번 라운드가 건드리지
      // 않은 기존 로직)와 부딪힐 여지가 시퀀스 구조상 없다. 세 사건(헤드샷
      // 킬·바디샷 킬·데스) 각각이 자신의 카운터만 올리고 다른 카운터를
      // 건드리지 않는다는 계약은 이전 순서와 동일하게 전부 검증된다 —
      // 순서만 바뀌었을 뿐 검증 대상(세 카운터의 독립성)은 그대로다.

      // 1) K가 V1을 헤드샷으로 죽인다 — kills=1, headshots=1.
      await killWithHeadshots(k, v1, kPos, v1Pos)
      const afterHeadshotKill = getStats(statsDb, uuidK)
      expect(afterHeadshotKill?.kills).toBe(1)
      expect(afterHeadshotKill?.headshots).toBe(1)
      expect(afterHeadshotKill?.deaths).toBe(0)

      // 2) K가 V3을 바디샷으로 죽인다 — kills=2이지만 headshots는 여전히 1
      //    (바디킬은 헤드샷 카운터를 올리지 않는다 — 설계 결정의 핵심 단언).
      //    K는 아직 한 번도 죽지 않았으므로(이 시점까지 deaths=0) 이 사격은
      //    canAct 게이트에 막히지 않는다.
      await killWithBodyshots(k, v3, kPos, v3Pos)
      const afterSecondKill = getStats(statsDb, uuidK)
      expect(afterSecondKill?.kills).toBe(2)
      expect(afterSecondKill?.headshots).toBe(1)
      expect(afterSecondKill?.deaths).toBe(0)

      // 3) V2가 K를 바디샷으로 죽인다(시퀀스의 마지막 사건) — K의 deaths=1
      //    (kills·headshots는 불변). K는 이 사건 이후 더 이상 사격하지
      //    않으므로 리스폰(PLAYER.RESPAWN_MS=3000ms) 대기가 필요 없다.
      await killWithBodyshots(v2, k, v2Pos, kPos)
      const afterDeath = getStats(statsDb, uuidK)
      expect(afterDeath?.deaths).toBe(1)
      expect(afterDeath?.kills).toBe(2)
      expect(afterDeath?.headshots).toBe(1)

      await Promise.all([leaveRoom(k), leaveRoom(v1), leaveRoom(v2), leaveRoom(v3)])
    },
    90_000,
  )

  it(
    'RQ-81: 플레이타임은 접속 중에는 반영되지 않다가 퇴장 시점에 경과 시간만큼 한 번에 적재된다',
    async () => {
      const uuidP = randomUUID()
      const p = await joinGame(newClient(server), { nickname: 'playtime-subject', uuid: uuidP })
      await waitForDefinedPlayer(p, p.sessionId)

      await sleep(SESSION_DURATION_MS / 2)

      // 설계 결정(팀리드 위임 "쓰기 시점") — 접속 중에는 아직 반영되지
      // 않는다. 행이 아예 없거나(아직 어떤 이벤트도 적재되지 않음) 있어도
      // playtimeMs가 0이어야 한다.
      const midSession = getStats(statsDb, uuidP)
      if (midSession !== undefined) {
        expect(midSession.playtimeMs).toBe(0)
      }

      await sleep(SESSION_DURATION_MS / 2)
      await leaveRoom(p)

      // withTimeout류 폴링이 아니라 onLeave가 동기 이벤트 핸들러 안에서
      // 즉시 적재한다는 가정(팀리드 "쓰기 시점" 결정) 아래, 소켓 close
      // 핸드셰이크 여유를 감안해 짧게 대기한 뒤 읽는다.
      await sleep(300)
      const afterLeave = getStats(statsDb, uuidP)
      expect(afterLeave?.playtimeMs).toBeGreaterThanOrEqual(PLAYTIME_LOWER_BOUND_MS)
    },
    30_000,
  )
})
