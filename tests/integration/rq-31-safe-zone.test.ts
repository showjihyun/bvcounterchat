import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WORLD } from '@shared/constants'

/**
 * RQ-31 Safe Zone — 피해 무효화, 통합 테스트 (ADR-0008: Colyseus 룸 경계,
 * ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * RQ-31 전문(`harness/specs/requirements.md`): "스폰 구역은 Safe Zone이어야
 * 하며, 시스템은 Safe Zone 내부의 플레이어가 받는 피해를 무효화해야 한다.
 * Safe Zone은 스폰 지점 반경 4m이며, 플레이어가 반경을 벗어나면 즉시 보호가
 * 해제되어야 한다."
 *
 * 매핑된 골든 케이스 **GA-11**(`verify` 필드가 이 파일 경로를 정확히 지정):
 * - given: 플레이어 B가 스폰 구역(Safe Zone) 내부에 위치.
 * - when: Safe Zone 내부의 B가 다른 플레이어의 공격을 받음.
 * - then: 피해가 무효화되어 B의 HP가 감소하지 않는다.
 *
 * **최초 작성 시점의 실측 상태(원장 25f)**: `WORLD.SAFE_ZONE_RADIUS_M`(당시 5)·
 * `WORLD.SAFE_ZONE_ALLOWS_FIRING`(false) 상수는 이미 있었으나(`constants.ts`),
 * `GameRoom`에 `SAFE_ZONE` 참조가 0건이라 피해 무효화가 구현되지 않았고 이
 * 파일은 **Red**였다(그때 실행하면 아래 (1)(2) 단언이 실패했다). **지금은
 * 구현이 있어 Green이며 반경도 v1.5에서 4m로 개정됐다**(원장 26s) — 이
 * 단락은 그 Red 시점을 남기는 이력이다.
 *
 * **RQ-16과의 경계(공허함 함정 회피, team-lead 지시)**: RQ-16(스폰 후 3초
 * 무적)은 **시간 기반**이고 이 RQ-31 Safe Zone은 **위치 기반**이다. 이
 * 파일이 B의 스폰 보호 3초가 아직 안 지난 시점에 관측하면, "3초 무적 때문에
 * 통과"하는 공허한 테스트가 된다 — Safe Zone 로직이 전혀 없어도 초록일 수
 * 있다. 그래서 B가 사격을 받기 **전에** RQ-16 보호를 화이트박스로 즉시
 * 해제한다(`seam.firedSinceSpawn.set(B, true)` — `isSpawnProtected`의
 * "사격한 적이 있으면 경과와 무관하게 즉시 해제" 규약을 그대로 이용, 아래
 * §해제 방법 참고). 이 시점 이후의 모든 "HP 불변" 관측은 RQ-16이 이미 꺼진
 * 상태에서 나온 것이므로 Safe Zone 자체의 효과로 귀속시킬 수 있다.
 *
 * **왜 `fire`로 자기 자신을 쏴서 해제하지 않는가(REV — GA-19와의 상호
 * 오염 방지)**: 기존 관례(`rq-16-spawn-protection.test.ts`,
 * `rq-64-lag-compensation-bound.test.ts`의 `clearSpawnProtection`)는 대상이
 * 위로 빗나가는 자기 사격(`UP_MISS_AIM`)을 한 발 쏴서 스스로 RQ-16 보호를
 * 해제한다. 그런데 이 저장소는 **이번 라운드에 GA-19(Safe Zone 내부 사격
 * 불가)도 함께 구현된다** — B는 자기 스폰 지점(Safe Zone 내부, 거리 0)에
 * 있으므로, GA-19가 구현된 뒤에는 그 자기-해제 사격 자체가 Safe Zone에
 * 막혀 무위가 될 수 있다(사격이 전혀 발사되지 않으므로 RQ-16 해제도 일어나지
 * 않는다 — 완전히 다른 이유로 이 파일이 타임아웃되는 혼란). 화이트박스로
 * `firedSinceSpawn`을 직접 세팅하면 'fire' 메시지 자체를 보내지 않으므로
 * GA-19(아직 구현 전이든 후든)와 완전히 독립적이다.
 *
 * **화이트박스 대상(`firedSinceSpawn`) 근거**: `GameRoom`의 기존 private
 * 필드이고, `PromotionTestSeam`(`rq-41-slot-promotion.test.ts`)이 이미 이
 * 정확한 이름으로 읽기 접근하는 화이트박스 대상이다(그린필드가 아니다) —
 * 이 파일이 처음으로 **쓰기**에 쓰지만, `seam.magazines.set(...)`
 * (`rq-41`)·`teleportPlayer`의 `seam.moveStates.set(...)`(`rq-90`)과 동일한
 * "as unknown as 캐스팅으로 결합한 private Map을 테스트가 직접 조작한다"는
 * 이미 확립된 관례를 그대로 따른다.
 *
 * **GA-19와의 교차 오염 방지(설계 결정, 중요)**: GA-19("Safe Zone 내부에서
 * 사격 불가")는 **사수(A)**의 위치를 본다. 이 파일(GA-11)은 **피격자(B)**의
 * 위치를 본다. 두 메커니즘이 함께 구현되면, A가 자기 스폰 지점(Safe Zone
 * 내부)에 그대로 머문 채 쏘면 "B의 HP가 안 줄었다"는 관측이 "B가
 * 보호받아서"가 아니라 "A가 애초에 쏘지 못해서"일 수 있다 — GA-11이
 * GA-19에 의해 가려지는 공허화다. 그래서 이 파일은 **A를 모든 Safe Zone
 * 밖으로 미리 옮겨**(아래 §반경-방사 기하) A의 사격 능력 자체를 이
 * 테스트의 관심사에서 제거한다 — 이후 관측되는 "HP 불변"은 오직 B의
 * 위치(Safe Zone 내부)로만 설명될 수 있다.
 *
 * **반경-방사(radial-outward) 기하 — "모든 Safe Zone 밖"을 구성하는 방법**:
 * `SPAWN_POINTS`(`@shared/sim/spawn`)는 원점을 중심으로 한 원 위에 절차적으로
 * 배치된다(`buildSpawnPoints`, 반지름 `WORLD.SIZE_M/2 - 8` ≈ 22m). 스폰
 * 지점 P에서 "원점→P 방향"(방사 방향)으로 더 밀어내는 이동은 P 자신과의
 * 거리는 정확히 그 이동량이 되고(자명), **다른 모든 스폰 지점과의 거리는
 * 결코 줄어들지 않는다**(증명: 다른 점 Q가 원점에서 같은 반지름 R, 각도차
 * θ(>0)에 있다고 하면 P-Q 거리의 제곱은 r²+R²-2rR·cosθ로, r(P의 반지름)이
 * R 이상으로 커지는 구간에서 r에 대해 항상 증가한다 — r=R일 때 미분값이
 * 2R(1-cosθ)>0이고 r이 커질수록 더 커진다). 이 저장소의 실제 15개
 * `SPAWN_POINTS`(반지름≈22m, 등각 24°)로 오프셋 0~20m 전 구간을 실측
 * 스크립트로 직접 확인했다 — 어느 지점에서 출발해도 "다른 스폰 지점과의
 * 거리"가 5m 아래로 내려가지 않는다(이 5m는 **반경이 아니라 반경과 무관한
 * 실측 하한**이다 — 반경 5m 시절에 측정했고, 반경이 4m로 낮아진 지금은
 * 여유가 오히려 커졌다. 스폰 지점이 나중에 바뀌어도 이 증명은
 * 일반적인 원 배치라면 그대로 성립한다). 그래서 "방사 방향으로 충분히
 * 미는" 것만으로 **어느 스폰 지점을 배정받았는지 몰라도** "모든 Safe
 * Zone 밖"을 구성할 수 있다 — 맵 중심 좌표를 별도로 가정하거나 계산할
 * 필요가 없다.
 *
 * **경계값은 상수에서 유도하되(하드코딩 금지), 그 자체를 고정하는 단언은
 * 별도 파일의 리터럴에 맡긴다(원장 21b 교훈)**: `INSIDE_BOUNDARY_OFFSET_M`
 * ·`OUTSIDE_BOUNDARY_OFFSET_M`은 `WORLD.SAFE_ZONE_RADIUS_M`(상수)에서
 * ±0.5m로 유도한다 — 상수가 바뀌면 경계 테스트도 함께 따라간다. 반경
 * 값이 정확히 4m라는 사실 자체을 리터럴로 고정하는 단언은
 * `tests/unit/shared-constants.test.ts:88`(`expect(WORLD
 * .SAFE_ZONE_RADIUS_M).toBe(4)`)가 이미 담당한다 — 이 파일에서 중복하지
 * 않는다.
 *
 * **"스폰 지점"의 해석(스펙 문면 그대로, 단일 해석에 의존하지 않음)**:
 * RQ-31 원문은 "Safe Zone은 스폰 지점 반경 4m"라고만 하고 "자신의 마지막
 * 스폰 지점"인지 "맵의 모든 스폰 지점 각각"인지 명시하지 않는다. 이 파일은
 * 둘 중 어느 쪽으로 구현되어도 성립하도록 설계했다 — "내부" 관측은 B
 * 자신의 방금 배정된 스폰 지점(거리 0)이라 두 해석 모두에서 "Safe Zone
 * 내부"이고, "외부" 관측(A의 위치, 양성 대조군의 B 위치)은 **모든** 스폰
 * 지점으로부터 4m를 초과하는 좌표라 두 해석 모두에서 "Safe Zone 밖"이다
 * (양성 대조군 B는 `OUTSIDE_BOUNDARY_OFFSET_M` = 반경 + 0.5 = 4.5m).
 *
 * **대기 술어**: 무효화(음성) 관측은 "일정 시간 뒤에도 값이 그대로"이므로
 * 조건 대기가 아니라 고정 관찰창(`NO_DAMAGE_OBSERVE_MS`) 뒤 스냅샷이다
 * (`rq-16-spawn-protection.test.ts`의 동일 패턴). 양성 대조군(피해가
 * 실제로 든다)은 `waitForServerCondition`(단조 조건: hp가 실제로
 * 줄어든다)으로 상한을 두고 기다린다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외 — 기존 통합 테스트와 동일). 모든 대기에 상한을 강제한다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** 서버 화이트박스 상태 폴링 간격(`rq-61`/`rq-64`와 동일 값·동일 근거). */
const SERVER_POLL_INTERVAL_MS = 15
/** 화이트박스 텔레포트(`moveStates` 직접 기입) 후, 스키마(`player.x/y/z`)
 * 동기화를 위한 정착 대기 — 서버 틱(`NET.TICK_MS`≈33ms)의 몇 배 여유를 둔다.
 * Safe Zone 판정이 스키마 필드를 읽는지 `moveStates`를 직접 읽는지는
 * coder의 구현 선택이라(팀리드 지시) 이 파일은 둘 다 최신 값을 갖도록
 * 정착시킨 뒤에만 사격한다. */
const TELEPORT_SETTLE_MS = 150
/** "피해 무효화"를 확인하는 고정 관찰창(`rq-16`의 `NO_DAMAGE_OBSERVE_MS`와
 * 동일 값·동일 근거 — 여러 상태 갱신을 거치기 충분한 여유). */
const NO_DAMAGE_OBSERVE_MS = 500
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300

/** Safe Zone 반경(상수에서 유도 — 하드코딩 금지). */
const RADIUS_M = WORLD.SAFE_ZONE_RADIUS_M
/** 경계 바로 안쪽(보호 유지) — 반경보다 0.5m 작다. */
const INSIDE_BOUNDARY_OFFSET_M = RADIUS_M - 0.5
/** 경계 바로 바깥쪽(보호 즉시 해제) — 반경보다 0.5m 크다. */
const OUTSIDE_BOUNDARY_OFFSET_M = RADIUS_M + 0.5
/** "모든 Safe Zone 밖"을 확실히 구성하는 큰 방사 오프셋 — 위 §반경-방사
 * 기하 문서의 실측 확인 범위(0~20m) 안이다. */
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

/** 화이트박스 접근 대상 계약 — `moveStates`·`positionHistory`는
 * `SpreadTestSeam`(`rq-90-spread-seed-determinism.test.ts`)이 이미 이
 * 정확한 이름으로 화이트박스 결합하는 기존 private 필드다(그린필드가
 * 아니다). `firedSinceSpawn`은 `PromotionTestSeam`
 * (`rq-41-slot-promotion.test.ts`)이 읽기로 이미 결합한 필드이며, 이
 * 파일이 처음으로 쓰기 방향으로 쓴다(위 파일 상단 문서 참고). */
interface SafeZoneTestSeam {
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number; hp?: number } | undefined
    }
  }
  moveStates: Map<string, MoveStateSnapshot>
  positionHistory: Map<string, unknown[]>
  firedSinceSpawn: Map<string, boolean>
}

function getServerRoom(room: Room): SafeZoneTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as SafeZoneTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-31 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function readServerPlayer(seam: SafeZoneTestSeam, sessionId: string): PlayerSnapshot | undefined {
  const p = seam.state.players.get(sessionId)
  if (typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.z === 'number' && typeof p?.hp === 'number') {
    return { x: p.x, y: p.y, z: p.z, hp: p.hp }
  }
  return undefined
}

function waitForServerCondition(
  seam: SafeZoneTestSeam,
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

/** 화이트박스 텔레포트 — `moveStates`(현재 위치)와 `positionHistory`(RQ-64
 * 되감기 링버퍼)를 함께 갱신한다. `teleportPlayer`
 * (`rq-90-spread-seed-determinism.test.ts`)와 동일한 형태 — 되감기 버퍼를
 * 비우지 않으면 텔레포트 이전의 stale 스냅샷이 대상 포즈 조회에 남을 수
 * 있다(그 파일 상단 REV 문서의 근거를 그대로 재사용). */
function teleportPlayer(seam: SafeZoneTestSeam, sessionId: string, position: { x: number; y: number; z: number }): void {
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

/** 스폰 지점 P에서 "원점→P 방향"(방사 방향)으로 `offsetM`만큼 더 밀어낸
 * 좌표 — 파일 상단 §반경-방사 기하 문서의 그 이동이다. `base`가 원점에
 * 있으면(이 저장소의 `SPAWN_POINTS`는 원 위에 배치되므로 발생하지 않는다)
 * 방향을 정의할 수 없어 명시적으로 실패시킨다(조용한 오동작보다 낫다). */
function radialOutwardPoint(base: { x: number; y: number; z: number }, offsetM: number): { x: number; y: number; z: number } {
  const radialMagnitude = Math.hypot(base.x, base.z)
  if (radialMagnitude < 1e-6) {
    throw new Error(`RQ-31 테스트 전제 위반 — base(${base.x},${base.z})가 원점에 있어 방사 방향을 정의할 수 없다`)
  }
  const ux = base.x / radialMagnitude
  const uz = base.z / radialMagnitude
  return { x: base.x + ux * offsetM, y: base.y, z: base.z + uz * offsetM }
}

/** A(shooter)의 눈높이에서 target의 바디 중심을 겨누는 조준 벡터
 * (`rq-16-spawn-protection.test.ts`의 동명 헬퍼와 동일). */
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

describe('RQ-31/GA-11: Safe Zone — 스폰 지점 반경 4m 내부 피해 무효화 + 경계 즉시 해제', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-31/GA-11: B가 Safe Zone(자신의 스폰 지점 반경 4m) 내부에 있으면 공격을 받아도 HP가 감소하지 않고, 경계(반경 ±0.5m) 안쪽은 계속 무효화되다가 바깥쪽에서는 즉시 정상 피해가 든다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        const baselineA = await waitForServerCondition(seam, roomA.sessionId, () => true, 'A 초기 서버 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        // RQ-16과의 분리(파일 상단 §RQ-16과의 경계) — B의 스폰 보호를
        // 화이트박스로 즉시 해제한다. 자기 사격(UP_MISS_AIM)을 쓰지
        // 않는다 — GA-19가 구현되면 B 자신도 Safe Zone 내부(거리 0)라
        // 그 자기-해제 사격이 막힐 수 있다(위 §"왜 fire로 해제하지
        // 않는가" 참고).
        seam.firedSinceSpawn.set(roomB.sessionId, true)

        // GA-19와의 교차 오염 방지(파일 상단 §설계 결정) — A를 모든 Safe
        // Zone 밖으로 옮겨 A의 사격 가능 여부를 이 테스트의 관심사에서
        // 제거한다.
        const aFarPoint = radialOutwardPoint(baselineA, FAR_OUTSIDE_OFFSET_M)
        teleportPlayer(seam, roomA.sessionId, aFarPoint)
        await sleep(TELEPORT_SETTLE_MS)
        const aAtFarPoint = readServerPlayer(seam, roomA.sessionId)
        if (!aAtFarPoint) throw new Error('RQ-31: A의 텔레포트 후 서버 스냅샷을 찾지 못했다')

        // --- (1) B가 자신의 스폰 지점(거리 0)에 그대로 있을 때 — GA-11
        // given/then 그대로: 피해 무효화 ---
        const aimAtSpawn = aimAtBody(aAtFarPoint, baselineB)
        roomA.send('fire', aimAtSpawn)
        await sleep(NO_DAMAGE_OBSERVE_MS)
        const afterSpawnShot = readServerPlayer(seam, roomB.sessionId)
        expect(afterSpawnShot?.hp).toBe(PLAYER.MAX_HP)

        // --- (2) 경계 바로 안쪽(반경-0.5m) — 여전히 무효화 ---
        const insidePoint = radialOutwardPoint(baselineB, INSIDE_BOUNDARY_OFFSET_M)
        teleportPlayer(seam, roomB.sessionId, insidePoint)
        await sleep(TELEPORT_SETTLE_MS)
        const aimAtInside = aimAtBody(aAtFarPoint, insidePoint)
        roomA.send('fire', aimAtInside)
        await sleep(NO_DAMAGE_OBSERVE_MS)
        const afterInsideShot = readServerPlayer(seam, roomB.sessionId)
        expect(afterInsideShot?.hp).toBe(PLAYER.MAX_HP)

        // --- (3) 경계 바로 바깥쪽(반경+0.5m) — 양성 대조군 + "즉시 해제"
        // 증명. 이전 (1)(2)의 "HP 불변"이 장치 자체가 꺼져 있어서가
        // 아니라 실제로 Safe Zone이 작동해서라는 것을 여기서 확정한다. ---
        await sleep(BETWEEN_SHOTS_MS)
        const outsidePoint = radialOutwardPoint(baselineB, OUTSIDE_BOUNDARY_OFFSET_M)
        teleportPlayer(seam, roomB.sessionId, outsidePoint)
        await sleep(TELEPORT_SETTLE_MS)
        const aimAtOutside = aimAtBody(aAtFarPoint, outsidePoint)
        roomA.send('fire', aimAtOutside)
        const afterOutsideShot = await waitForServerCondition(
          seam,
          roomB.sessionId,
          (p) => p.hp < PLAYER.MAX_HP,
          '양성 대조군 — 경계 바깥에서 실제 피해 적용 대기',
          HP_TIMEOUT_MS,
        )
        expect(afterOutsideShot.hp).toBeLessThan(PLAYER.MAX_HP)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )
})
