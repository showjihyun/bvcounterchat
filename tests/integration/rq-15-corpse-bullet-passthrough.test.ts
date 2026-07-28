import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { MOVEMENT, NET, PLAYER, WEAPON, WORLD } from '@shared/constants'
import { escapeSafeZone, getSafeZoneSeam, releaseSpawnProtectionAndEscape } from '../support/safe-zone'

/**
 * 시신은 총알을 막지 않는다 — 서버 판정 로직(ADR-0011: `src/shared`·서버
 * 판정 로직 Red-first 영역) 통합 테스트.
 *
 * **출처 — 사용자 결정(골든 신설 아님)**: 리뷰(`_workspace/review/
 * feat-RQ-15-16-respawn-protection.md` minor-3)가 지적한 "시신이 최대
 * 3초(리스폰 전까지) 총알 방패가 된다"는 관찰에 대해, RQ-15/16 원문·
 * 골든 어디에도 규정이 없는 영역이라 사용자 판단을 요청했고, **"시신은
 * 판정 후보에서 제외한다"**로 결정됐다(team-lead 지시). 스펙·골든
 * 미규정 영역의 사용자 결정이므로 이 파일은 골든 케이스(GA-*)를 새로
 * 만들지 않는다 — 원장(`harness/progress.md`)에 결정 근거로 기록된다.
 *
 * **Red-first 근거(ADR-0011)**: `GameRoom.handleFire`의 후보 수집
 * (`this.state.players.forEach`)이 `hp`를 보지 않아, 사망한 플레이어
 * (hp<=0, 리스폰 전까지 최대 `PLAYER.RESPAWN_MS`=3000ms 동안 존재)가
 * `findClosestHit`의 최근접 후보가 되면 그 뒤에 정렬된 산 플레이어에게
 * 갈 총알을 흡수한다 — 서버 판정 로직(히트 후보 수집)이므로 Red-first
 * 영역이다.
 *
 * **시나리오**: 사수 A, 시신 B(A와 산 플레이어 C 사이에 정렬), 산
 * 플레이어 C. A가 B를 관통해 C를 겨누는 방향으로 사격하면, 현재 구현
 * (시신도 후보에 포함)에서는 B가 가장 가까운 후보로 판정돼 총알을
 * 흡수하고 C의 HP는 변하지 않는다 — 이 파일의 핵심 단언이 기대하는
 * "C의 HP가 감소한다"가 실패한다(Red). 시신이 후보에서 제외되면
 * `findClosestHit`가 B를 건너뛰고 C를 맞힌다.
 *
 * **음성 대조군(같은 `it()` 안, 팀리드 "재량" 요청 이행)**: B를 정렬
 * 시키기 **전에**(정확히는 B는 아예 움직이지 않는다 — 아래 "기하 설계"
 * 참고) A가 C의 **원래** 스폰 위치를 조준해 먼저 한 발 쏴 "장애물 없는
 * 기준 피해량"을 확보한다. 이후 C를 A-B 직선의 연장선 위로 이동시키고,
 * B를 죽인 뒤, **그 직선을 따라** 다시 쏴 두 번째 피해가 첫 번째와
 * **정확히 같은 값**인지 확인한다 — "시신이 있든 없든 C가 받는 피해가
 * 동일하다"는 것을 이 파일 하나가 자기완결적으로 증명한다(대조군 없이
 * "C가 맞는다"만 확인하면 부위가 달라졌다거나 하는 다른 이유로 우연히
 * 통과할 위험이 있다 — GA-06/GA-10 공허화 교훈, `01_test-writer_red.md`
 * §14·§15).
 *
 * **기하 설계 — 결정론적 정렬 + 오차 증폭 방지(우연에 기대지 않음)**:
 * 스폰 지점이 `SPAWN_POINTS`(15개 순환)로 고정돼 있어 A·B·C 셋 다 임의의
 * 서로 다른 지점에서 시작한다(방 전역 순환 커서 — 이 파일이 이 룸의
 * 첫 접속자 3명이므로 결정론적으로 인접한 세 지점을 받는다). 세 점을
 * 원하는 직선 위에 정확히 정렬시키려고 좌표를 하드코딩하지 않는다.
 *
 * **유지보수 참고(델타 재리뷰 minor 대응)**: 위 "첫 접속자 3명" 전제는
 * 이 `describe`가 이 파일에서 유일하게 서버를 기동하고, A·B·C가 그
 * 서버에 접속하는 첫 세 세션이라는 것에 의존한다 — 이 `describe`에
 * `it()`을 더 추가하면(같은 서버를 재사용하는 새 세션이 룸 전역 커서를
 * 이어받아) 좌표가 달라진다. 어긋나도 조용히 통과하지 않고 기하 검증
 * 단언(`perpDist` < 바디 반지름) 또는 뒤이은 타임아웃으로 즉시 드러나지만
 * (`_workspace/review/feat-RQ-15-16-respawn-protection.md` 델타 재리뷰
 * 확인), 새 `it()`을 추가하려면 서버를 새로 띄우거나(별도 `describe`)
 * 좌표를 다시 실측해 전제를 갱신하라.
 *
 * **왜 "B를 옮기지 않고 C를 멀리 옮기는가" — 오차 증폭 방지가 핵심**:
 * 최초 설계는 B를 A-C 직선의 중점으로 이동시켰다. 그런데 실측 결과,
 * 이동 후 정지(`move` → 대기 → 정지 `move`)만으로는 정지 명령이 서버에
 * 도달·적용되기까지의 네트워크 지연이 틱 반올림 오차 위에 더해져,
 * 목표 지점에서 최대 0.39m까지 벗어나는 사례를 실측했다 — 이는 바디
 * 히트박스 반지름(`DEFAULT_HITBOX.bodyRadiusM`=0.3m)을 넘어 이 파일의
 * 정렬 불변식을 깬다(간헐적으로 재현됨). 폐루프 반복 보정(이동 후 실측
 * 재측정 → 남은 오차만큼 재이동)을 시도해도, 이동의 최소 단위가 1틱
 * (`MOVEMENT.SPEED`×`NET.TICK_MS`≈0.2m)이라 그보다 미세한 정밀도로는
 * 수렴이 보장되지 않는다(관측: ~4% 빈도로 재발).
 *
 * 그래서 **B는 아예 움직이지 않는다**(자기 스폰 위치 그대로, 정지 명령
 * 타이밍 오차 자체가 없다 — 죽이는 조준도 정확한 실측 좌표라 오차가 0).
 * 대신 **C를 A→B 방향의 연장선을 따라 월드 경계 근처까지 멀리 이동**
 * 시킨다. 이동 오차 벡터 δ(=C의 실제 도달점이 계획한 먼 목표점에서
 * 벗어난 정도)가 있어도, A를 원점으로 하는 유사삼각형 관계상 **그
 * 오차가 B가 있는 지점(A로부터 훨씬 가까운 거리)에서 관측되는 수직
 * 이탈은 `(A-B 거리) / (A-C 거리)` 비율만큼 줄어든다** — C를 A로부터
 * B보다 여러 배 더 멀리 보낼수록 B 지점에서의 유효 오차가 그만큼
 * 작아진다(레이저 포인터를 먼 벽에 겨눌 때 손떨림 각도가 같아도 가까운
 * 지점에서는 흔들림이 작게 보이는 것과 같은 원리). 이 파일은 이
 * 축소된 실제 수직 이탈을 **직접 계산해 단언**한다(아래 "기하 검증"
 * 절) — 정렬이 "우연히 됐다"가 아니라 기하학적으로 보장됨을 실행
 * 시점에 재확인한다. 이동 목표 지점(월드 경계 근처)은
 * `maxDistanceWithinBounds`로 실제 월드 경계(`WORLD.SIZE_M`) 안에서
 * 계산한다 — 좌표를 하드코딩하지 않는다.
 *
 * **스폰 보호(RQ-16)**: B·C 둘 다 최초 입장 직후 3초간 보호된다 — 다른
 * 파일과 동일한 패턴(`UP_MISS_AIM` 자기 사격으로 즉시 해제)을 쓴다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존(ADR-0008
 * 허용 예외). 이동 목표·시간은 순수 산술로 계산하고(난수 없음), 모든
 * 대기에 `withTimeout()` 상한을 건다.
 *
 * **REV(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19·GA-11, `86fddf1`) 이후 A·B·C 셋
 * 다 각자의 스폰 지점(Safe Zone 내부, 거리 0)에 그대로 있으면 (1) GA-19가
 * A의 사격 자체를 막고 (2) B·C가 Safe Zone 안에 있으면 RQ-16과 무관하게
 * GA-11(위치 기반 피해 무효화)이 계속 피해를 무효화한다. B·C의 RQ-16
 * 해제는 자기 사격 대신 화이트박스(`firedSinceSpawn`)로 하고, A·B·C
 * 셋 다 각자의 스폰 지점 기준 방사 방향(`rq-31-safe-zone.test.ts` §반경
 * -방사 기하)으로 화이트박스 텔레포트해 Safe Zone 밖으로 옮긴다 — 이후
 * 모든 기하 계산(직선 정렬·수직 거리·조준)은 이 탈출 후 위치를 새
 * 기준으로 삼는다(원래 스폰 좌표와의 상대 관계가 아니라, 탈출 후 좌표
 * 자체가 이 파일의 "A·B·C 위치"가 된다 — 테스트 수학이 좌표를
 * 하드코딩하지 않고 실측값에서 유도하므로 이 치환은 안전하다).
 * **탈출 오프셋은 다른 파일보다 작게(반경+0.5m=5.5m)** 잡았다 — 이 파일은
 * C를 A→B 연장선을 따라 **월드 경계 근처**까지 보내는 `maxDistanceWithinBounds`
 * 계산에 의존하는데, 다른 파일의 큰 오프셋(반경+15m=20m)을 그대로 쓰면
 * A·B가 스폰 반지름(≈22m)에서 더 밀려나 60×60 월드 경계(절반 30m)를
 * 벗어날 위험이 있다. 5.5m 오프셋도 §반경-방사 기하의 실측 확인 범위
 * (0~20m) 안이라 다른 스폰 지점의 Safe Zone에 새로 들어가지 않음은
 * 동일하게 보장된다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300
/** 이동 정지 후 위치가 안정화될 때까지 기다리는 여유(수 틱, 33ms×n). */
const SETTLE_MS = 200
/** RQ-31 회귀 대응 — 화이트박스 Safe Zone 탈출 텔레포트가 스키마
 * (`player.x/y/z`)에 정착할 시간(서버 틱 ≈33ms의 몇 배 여유). */
const RELEASE_PROTECTION_SETTLE_MS = 300
/** RQ-31 회귀 대응 — Safe Zone 탈출 오프셋. 이 파일은 C를 월드 경계
 * 근처까지 보내는 계산에 의존하므로(파일 상단 REV 참고) 다른 파일의
 * 오프셋(반경+15m)보다 작게(반경+0.5m) 잡아 A·B가 월드 경계를 넘지 않게
 * 한다. */
const SAFE_ZONE_ESCAPE_OFFSET_M = WORLD.SAFE_ZONE_RADIUS_M + 0.5
/** C를 A→B 연장선 위로 보낼 때, 월드 경계까지 계산한 최대 거리에 곱하는
 * 안전 계수 — 부동소수점 경계·근사 오차로 경계를 넘지 않도록 여유를 둔다. */
const FAR_TARGET_SAFETY_FACTOR = 0.9

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
    HP_TIMEOUT_MS,
    label,
  )
}


/** shooter(발 위치)에서 target(발 위치)의 바디 중심을 정확히 조준하는
 * 방향 벡터(정규화) — 다른 RQ-15/16 파일들과 동일한 일반형 패턴. */
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


interface Vec2 {
  x: number
  z: number
}

function sub2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z }
}

function add2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, z: a.z + b.z }
}

function scale2(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, z: v.z * s }
}

function magnitude2(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.z * v.z)
}

function normalize2(v: Vec2): Vec2 {
  const m = magnitude2(v)
  return { x: v.x / m, z: v.z / m }
}

function distance2(a: Vec2, b: Vec2): number {
  return magnitude2(sub2(b, a))
}

/** 점 `p`에서 `lineStart`-`lineEnd` 직선까지의 수직 거리(2D, XZ 평면). */
function perpendicularDistanceToLine(p: Vec2, lineStart: Vec2, lineEnd: Vec2): number {
  const lineVec = sub2(lineEnd, lineStart)
  const pointVec = sub2(p, lineStart)
  const lineLength = magnitude2(lineVec)
  const cross = lineVec.x * pointVec.z - lineVec.z * pointVec.x
  return Math.abs(cross) / lineLength
}

/** `origin`에서 단위 방향 `dir`을 따라 이동할 때, 한 변 `2*halfExtent`인
 * 정사각형(WORLD, 원점 중심) 경계를 벗어나기 직전까지의 최대 거리 —
 * "기하 설계" 절의 오차 증폭 방지 전략에 필요한 "가능한 한 먼 목표점"을
 * 좌표 하드코딩 없이 계산한다. */
function maxDistanceWithinBounds(origin: Vec2, dir: Vec2, halfExtent: number): number {
  let maxT = Infinity
  const axes: Array<readonly [number, number]> = [
    [origin.x, dir.x],
    [origin.z, dir.z],
  ]
  for (const [o, d] of axes) {
    if (Math.abs(d) < 1e-9) continue // 이 축 방향 성분이 없으면 이 축은 경계에 제약을 걸지 않는다
    const boundary = d > 0 ? halfExtent : -halfExtent
    const t = (boundary - o) / d
    if (t > 0) maxT = Math.min(maxT, t)
  }
  return maxT
}

/** `distanceM`을 이동하는 데 필요한 시간(ms) — 틱 단위로 올림한다(최소
 * 1틱). `distanceM`이 0에 가까우면(이미 목표 근처) 0을 반환해 불필요한
 * 이동을 건너뛴다. */
function requiredTravelMs(distanceM: number): number {
  if (distanceM < 0.01) return 0
  const neededMs = (distanceM / MOVEMENT.SPEED) * 1000
  return Math.ceil(neededMs / NET.TICK_MS) * NET.TICK_MS
}

/** `mover`를 `target`을 향해 실제 이동 입력으로 이동시키고, 실제 도달한
 * 위치를 읽어 반환한다(`travelAndSettle`의 목표 지점 지정 버전). 정지
 * 명령의 네트워크 반영 지연으로 단발 이동은 오차가 남을 수 있어(파일
 * 상단 "기하 설계" 절 참고), 이동 후 **실제 위치를 다시 읽어** 남은
 * 거리가 `toleranceM` 이내로 수렴할 때까지 반복한다(최대
 * `maxCorrectionRounds`회) — 매 라운드가 실측값에서 다시 계산하므로
 * 이동 계획을 앞서 가정하지 않는다. 이 파일은 이 함수의 정밀도에
 * 최종적으로 기대지 않는다 — C를 목표점 "근처"로만 보내고, 실제 안전
 * 마진은 "기하 설계"의 오차 증폭 방지(먼 목표점 선택)에서 나온다. */
async function moveToward(
  mover: Room,
  from: PlayerSnapshot,
  target: Vec2,
  toleranceM = 0.1,
  maxCorrectionRounds = 3,
): Promise<PlayerSnapshot> {
  let current = from
  for (let round = 0; round <= maxCorrectionRounds; round += 1) {
    const distance = distance2(current, target)
    if (distance < toleranceM) break
    const travelMs = requiredTravelMs(distance)
    if (travelMs === 0) break
    const dirX = (target.x - current.x) / distance
    const dirZ = (target.z - current.z) / distance
    mover.send('move', { dirX, dirZ, mode: 'run', jump: false })
    await sleep(travelMs)
    mover.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false }) // 정지
    await sleep(SETTLE_MS)
    const settled = readPlayer(mover, mover.sessionId)
    if (!settled) throw new Error('moveToward: 이동 후 위치 관측 실패')
    current = settled
  }
  return current
}

/** A의 사격으로 대상을 사망(HP 0)까지 몰아간다. 부위(헤드/바디) 무관 —
 * `rq-15-respawn-timer.test.ts`의 `killPlayer`와 동일한 이유·동일한
 * 설계(각 사격 후 "hp가 직전 값에서 실제로 줄었는가"만 확인). */
async function killPlayer(
  shooter: Room,
  victim: Room,
  baselineHp: number,
  aim: { dirX: number; dirY: number; dirZ: number },
): Promise<PlayerSnapshot> {
  let previousHp = baselineHp
  const MAX_KILL_SHOTS = 4
  for (let shot = 1; shot <= MAX_KILL_SHOTS && previousHp > 0; shot += 1) {
    shooter.send('fire', aim)
    const afterShot = await waitForPlayerCondition(
      victim,
      victim.sessionId,
      (p) => p.hp !== previousHp,
      `${shot}번째 사격 후 HP 변화 대기(직전 HP=${previousHp})`,
    )
    previousHp = afterShot.hp
    if (previousHp > 0) await sleep(BETWEEN_SHOTS_MS)
  }
  const atDeath = readPlayer(victim, victim.sessionId)
  if (!atDeath) throw new Error('killPlayer: 사망 직후 스냅샷 관측 실패')
  expect(atDeath.hp).toBe(0)
  return atDeath
}

describe('시신은 총알을 막지 않는다 (리뷰 minor-3, 사용자 결정 — 골든 미신설)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'A→B(시신)→C로 정렬된 상태에서 A가 B를 관통해 C를 조준해 사격하면, C가 (시신이 없을 때와 정확히 같은) 피해를 입는다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const roomC = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷')
        const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷')
        const baselineC = await waitForPlayerCondition(roomC, roomC.sessionId, () => true, 'C 초기 스냅샷')
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)
        expect(baselineC.hp).toBe(PLAYER.MAX_HP)

        // RQ-31 회귀 대응(파일 상단 REV) — B·C의 RQ-16 해제는 화이트박스로
        // 한다(자기 사격은 각자의 Safe Zone에 막힐 수 있다). A·B·C 셋 다
        // Safe Zone 밖으로 옮긴다 — 이후 모든 기하 계산은 이 탈출 후
        // 위치를 새 기준으로 삼는다(파일 상단 REV 근거).
        const seam = getSafeZoneSeam(roomA)
        const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA, SAFE_ZONE_ESCAPE_OFFSET_M)
        const escapedB = releaseSpawnProtectionAndEscape(seam, roomB.sessionId, baselineB, SAFE_ZONE_ESCAPE_OFFSET_M)
        const escapedC = releaseSpawnProtectionAndEscape(seam, roomC.sessionId, baselineC, SAFE_ZONE_ESCAPE_OFFSET_M)
        await sleep(RELEASE_PROTECTION_SETTLE_MS)

        // 음성 대조군(1/2) — C의 **탈출 후** 위치를 조준해 "장애물 없는
        // 기준 피해량"을 확보한다(B는 애초에 다시 움직이지 않으므로 이
        // 사격과 무관 — 일반적으로 A-C 직선과 겹치지 않는다).
        const aimAtOriginalC = aimAtBody(escapedA, escapedC)
        roomA.send('fire', aimAtOriginalC)
        const cAfterBaselineShot = await waitForPlayerCondition(
          roomC,
          roomC.sessionId,
          (p) => p.hp < PLAYER.MAX_HP,
          '기준(장애물 없음) 사격 후 C의 HP 감소 대기',
        )
        const baselineDamage = PLAYER.MAX_HP - cAfterBaselineShot.hp
        expect(baselineDamage).toBe(WEAPON.DAMAGE_BODY) // 전제 확인 — 바디 명중

        // C를 A→B 방향의 연장선을 따라 월드 경계 근처까지 이동시킨다
        // (파일 상단 "기하 설계" 절 — 오차 증폭 방지). B는 탈출 이후 다시
        // 움직이지 않는다.
        const dirAB = normalize2(sub2(escapedB, escapedA))
        const maxDist = maxDistanceWithinBounds(escapedA, dirAB, WORLD.SIZE_M / 2)
        const farTargetForC = add2(escapedA, scale2(dirAB, maxDist * FAR_TARGET_SAFETY_FACTOR))
        const cAligned = await moveToward(roomC, cAfterBaselineShot, farTargetForC)

        // 기하 검증 — B(탈출 이후 다시 움직이지 않음, 실측 좌표 그대로)가
        // A-C(정렬 후) 직선에서 벗어난 수직 거리가 바디 히트박스 반지름
        // (`DEFAULT_HITBOX.bodyRadiusM`) 안에 있는지 직접 계산해 확인한다
        // — "정렬이 우연이 아니라 기하학적으로 보장된다"는 설계 근거를
        // 실행 시점에 재확인한다.
        const perpDist = perpendicularDistanceToLine(escapedB, escapedA, cAligned)
        expect(perpDist).toBeLessThan(DEFAULT_HITBOX.bodyRadiusM) // B가 실제로 A-C 직선에 충분히 가깝다

        // B를 사망시킨다 — B는 탈출 이후 움직이지 않았으므로 탈출 후
        // 스냅샷(escapedB) 좌표가 곧 사망 시점 좌표다(오차 없음).
        const aimAtB = aimAtBody(escapedA, escapedB)
        await killPlayer(roomA, roomB, baselineB.hp, aimAtB)

        // rate-limit(ADR-0005, 150ms) 여유 — killPlayer의 마지막(사망 확정)
        // 사격 직후에는 대기가 없다(previousHp가 이미 0이라 루프 내부의
        // 사격 간 sleep을 건너뛴다). 아래 "핵심" 사격이 그 직후 바로
        // 나가면 A 자신의 rate-limit에 걸려 무시될 위험이 있다 — 다른
        // 파일들과 동일하게 명백히 150ms를 넘는 여유를 둔다.
        await sleep(BETWEEN_SHOTS_MS)

        // 핵심 Red 단언 — 음성 대조군(2/2): 이제 B(시신)가 A→C(정렬 후)
        // 직선 위에 있는 상태에서, C의 **실제 정렬된 위치**를 다시 조준해
        // 사격한다. 현재 구현(시신도 hitscan 후보에 포함)에서는 B가
        // 최근접 후보가 되어 총알을 흡수하므로 C의 HP는 변하지 않는다 —
        // 아래 단언이 실패한다(Red). 시신이 후보에서 제외되면 C가
        // baselineDamage와 정확히 같은 피해를(시신 유무와 무관하게
        // 동일하게) 다시 입는다.
        const aimAtAlignedC = aimAtBody(escapedA, cAligned)
        roomA.send('fire', aimAtAlignedC)
        const cAfterCorpseShot = await waitForPlayerCondition(
          roomC,
          roomC.sessionId,
          (p) => p.hp < cAfterBaselineShot.hp,
          '시신 관통 사격 후 C의 HP 추가 감소 대기 — 현재 구현에서는 타임아웃된다(시신이 흡수)',
        )
        expect(cAfterCorpseShot.hp).toBe(PLAYER.MAX_HP - baselineDamage * 2) // 시신 유무와 무관하게 동일한 피해량
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB), leaveRoom(roomC)])
      }
    },
    30_000,
  )
})
