import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WORLD } from '@shared/constants'
import { isWithinSafeZone } from '@shared/sim/spawn'

/**
 * RQ-31 v1.6 — Safe Zone 플레이어의 **총알 차단**, 통합 테스트 (ADR-0008:
 * Colyseus 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * RQ-31 v1.6이 추가한 절(`harness/specs/requirements.md`): "Safe Zone
 * 내부의 플레이어는 월드에 물리적으로 존재하며 총알을 차단해야 한다 —
 * 무효화되는 것은 그가 받는 피해뿐이고, 그의 몸이 사선을 막는 성질은
 * 유지된다. 따라서 사수와 표적 사이에 Safe Zone 플레이어가 서 있으면 그
 * 표적은 피격되지 않는다."
 *
 * **이 라운드는 Red가 없다(팀리드 지시, 중요) — characterization test**:
 * `GameRoom.handleFire`는 이미 (1) 사수를 제외한 살아 있는 전원을 후보로
 * 모으고 (2) `findClosestHit`(`combat.ts`, "가정 F — 관통 없음: 레이 경로상
 * 여러 후보가 명중 가능해도 가장 가까운 하나만 반환한다")로 **최근접 하나만**
 * 골라 (3) 그 뒤에야 `isWithinSafeZone`으로 **피해만** 무효화한다. 이
 * 세 동작(사수 제외 전원 후보·최근접 단일 판정·피해만 무효화)은 전부 이번
 * 라운드 이전부터 있던 기존 동작이라, 사수·Safe Zone 플레이어·그 뒤 표적을
 * 일직선에 두면 "Safe Zone 플레이어가 최근접으로 뽑혀 레이를 흡수하고, 그
 * 피해가 무효화되며, 뒤 표적은 애초에 판정조차 되지 않는다"는 RQ-31 v1.6의
 * 요구 동작이 **코드 변경 없이 이미 성립**한다 — 이 파일은 그 상태를
 * 실행부터 Green으로 확인하고, **통과 자체가 아니라 검출력**(아래 §변이
 * 검증)으로 존재 이유를 증명한다.
 *
 * **골든 케이스 부재 보고**: 이 "총알 차단" 절을 전담하는 GA-* 항목이
 * `harness/evals/golden/track-a-product.jsonl`에 아직 없다(GA-11은 피격자
 * 위치 기반 피해 무효화, GA-19는 사수 위치 기반 발사 불가 — 둘 다 이
 * 시나리오의 "제3자 차단" 절을 다루지 않는다). 이 파일은 team-lead가
 * 직접 지정한 시나리오(위 지시 메시지)를 그대로 구현한 것이며, 정식
 * GA-* 등재는 이 보고서 이후 team-lead·evaluator의 몫이다.
 *
 * **기존 3개 파일과의 중복 없음(확인 완료)**: `rq-31-safe-zone.test.ts`
 * (GA-11, 피격자 위치)·`rq-31-safe-zone-no-firing.test.ts`(GA-19, 사수
 * 위치)·`rq-31-spawn-rotation.test.ts`(GA-20, 로테이션) 세 파일 모두
 * **플레이어 2명**(A=사수, B=대상)만 등장하고, "제3자가 사선을 막는다"는
 * 시나리오는 어디에도 없다 — 이 파일이 다루는 것은 새 커버리지다.
 *
 * **일직선 구성 — 원점을 사수로 쓴다(기존 3개 파일의 "방사-바깥으로 밀기"
 * 기법을 한 단계 더 일반화)**: `SPAWN_POINTS`(`@shared/sim/spawn`)는
 * 원점을 중심으로 한 원 위에 배치된다(`buildSpawnPoints`). 사수 A를
 * **원점(0,0,0)**에 두면:
 *   1. **정정(팀리드 리뷰, 2026-08-03 실측 — 최초 버전의 "정확히 같은
 *      반지름" 서술은 틀렸다)**: `buildSpawnPoints`가 `x`·`z`를
 *      `Math.round()`로 정수화하므로 15개 스폰 지점은 **정확한 원 위에
 *      있지 않다** — 원점까지의 거리는 균일하지 않고 2026-08-03 기준
 *      실측값으로 21.9317m~22.5610m 사이에 분포한다(이 값 자체가 지금의
 *      `SPAWN_RADIUS_M`=22·`SPAWN_COUNT`=15 조합에서 나온 스냅샷이며,
 *      맵 라운드(RQ-30~32)가 스폰 지점을 실제 지오메트리로 바꾸면 낡는다).
 *      그래도 원점이 항상 모든 Safe Zone 밖이라는 **결론**은 참이다 —
 *      근거는 "정확한 원"이 아니라 **여유가 압도적으로 크다는 것**이다:
 *      가장 가까운 스폰 지점(21.9317m)도 Safe Zone 반경(4m)보다
 *      17.9317m나 더 멀다. 이 문단은 산문으로 그 사실을 "증명"하지
 *      않는다 — **아래 `it` 블록의 `expect(isWithinSafeZone(ORIGIN)).toBe(false)`·
 *      `expect(isWithinSafeZone(cPoint)).toBe(false)` 기계 단언이 매 실행마다
 *      실측으로 검증**한다(파일 상단 docblock 편집으로 줄 번호가 밀리는
 *      것을 피하려 특정 줄 번호 대신 코드로 지칭한다). 이 두 단언은 동시에
 *      **맵 라운드의 안전장치**이기도 하다 — `SPAWN_POINTS`가 실제
 *      지오메트리로 교체되어 이 전제가 깨지면, 이 파일이 (다른 어떤
 *      파일보다 먼저) 그 자리에서 바로 실패해 알려준다.
 *   2. B(안전지대 플레이어)는 자신의 스폰 지점(원점에서 뻗어나가는
 *      방향의 스칼라배, 그 자체)에 그대로 둔다.
 *   3. C(뒤 표적)는 B를 **B 자신의 방사 방향으로** `TARGET_RADIAL_OFFSET_M`
 *      만큼 더 밀어낸 지점(`radialOutwardPoint`, 기존 3개 파일과 동일
 *      기법·동일 반경-방사 기하 증명)에 둔다 — C = B·(1 + offset/|B|),
 *      즉 C도 원점에서 뻗어나가는 **같은 방향**의 스칼라배다.
 *   원점·B·C가 전부 같은 방향 벡터의 스칼라배이므로 셋은 **정확히
 *   일직선**이고(근사 아님, 대수적으로 성립), C가 B보다 원점에서 더 멀다
 *   (|B| < |C|)는 것도 자명하다. `radialOutwardPoint`의 기존 반경-방사
 *   기하 증명(다른 스폰 지점과의 거리는 결코 줄지 않는다)이 그대로
 *   C에 적용되므로 C는 항상 모든 Safe Zone 밖이다(양성 대조군이 이
 *   전제 없이는 성립하지 않는다 — B가 없어도 C가 안전지대라 피해가
 *   또 무효화되면 무엇을 쳐냈는지 구별 불가).
 *
 * **조준 — 사수 눈높이와 같은 수평면을 겨눈다(거리 무관 이중 명중 증명)**:
 * 다른 rq-31 파일의 `aimAtBody`는 대상의 "몸 중심" 높이를 겨누는데, 이는
 * 대상까지의 수평 거리에 따라 낙차가 달라져(고정된 dy를 서로 다른 수평
 * 거리로 나눈 값이라 시선의 수직각이 거리마다 다르다) 서로 다른 거리에
 * 있는 B·C를 **동시에** 명중시키는 것을 보장하지 못한다. 이 파일은
 * 대신 **완전히 수평**(`dirY = 0`)인 조준을 쓴다 — A의 눈높이
 * (`DEFAULT_HITBOX.eyeHeightM` = 1.7m)와 발높이(0, A는 원점 y=0)이므로
 * 레이는 **원점 y=1.7에서 시작해 끝까지 높이가 정확히 1.7로 일정**하다.
 * B·C 둘 다 발높이가 0(스폰 지점 규약, `spawn.ts`)이므로 이 레이가
 * 지나가는 높이(1.7)는 항상 둘의 헤드 구체 대역
 * (`headCenterM`±`headRadiusM` = [1.5, 1.8])에 정확히 포함된다.
 * 게다가 조준 방향이 정확히 원점→C의 **XZ 방향**(B도 그 방향의 스칼라배
 * 이므로)이라, 레이의 파라미터 t=|B|(B의 원점으로부터 거리) 지점의 XZ
 * 좌표가 **정확히** B의 좌표와 일치한다(오프셋 0 — 근사 아님, 대수적
 * 증명은 위 §일직선 구성 참고). 따라서 이 하나의 조준으로 B·C 둘 다
 * (거리와 무관하게) 헤드 판정이 확정된다 — `raycastHitbox`의 바디
 * 원통은 높이 조건이 `[bodyBottomM(0), bodyTopM(1.5)]`인데 레이 높이가
 * 항상 1.7이라 결코 바디로는 안 걸린다(부위가 'head'로 고정되므로 어느
 * 쪽이 이겼는지 헷갈릴 여지도 없다).
 *
 * **RQ-16과의 분리**: B·C 둘 다 화이트박스로 `firedSinceSpawn`을 즉시
 * 세팅해 스폰 후 3초 시간 기반 보호를 미리 꺼둔다(다른 rq-31 파일과
 * 동일 근거 — 이 파일이 관측하는 "HP 불변/HP 감소"가 RQ-16이 아니라
 * RQ-31 v1.6(위치 기반 차단)에만 귀속되게 하기 위함).
 *
 * **화이트박스 대상**: `moveStates`·`positionHistory`·`firedSinceSpawn`은
 * 세 rq-31 자매 파일이 이미 이 정확한 이름으로 결합하는 기존 private
 * 필드다(그린필드가 아니다) — `rq-31-safe-zone.test.ts` 상단 문서와
 * 동일 근거.
 *
 * **검출력 — 변이 A·B(격리 워크트리에서만 실험, `harness/workflow/tdd.md`
 * §변이 실험 규약)**:
 *   - **변이 A**(25l이 제안했던 "관통" 구현 재현): `candidates.push` 전에
 *     `isWithinSafeZone(targetState)`인 후보를 건너뛰는 가드를 넣는다.
 *     B가 후보에서 아예 빠지므로 `findClosestHit`은 C를 최근접으로
 *     고르고, 이 파일의 핵심 단언 "C의 HP 불변"이 실패해야 한다 —
 *     이것이 이 테스트가 존재하는 이유다.
 *   - **변이 B**: `isProtected = isSpawnTimeProtected || isSafeZoneProtected`
 *     에서 `isSafeZoneProtected` 항을 제거(또는 `false`로 고정)한다. B가
 *     여전히 최근접으로 뽑히지만 피해가 무효화되지 않으므로, 핵심 단언
 *     "B의 HP 불변"이 실패해야 한다.
 *
 * **대기 술어·결정론 메모**: 무효화(음성) 관측은 고정 관찰창
 * (`NO_DAMAGE_OBSERVE_MS`, 다른 rq-31 파일과 동일 패턴), 양성 대조군은
 * `waitForServerCondition`(단조 조건)으로 상한을 둔다. 실 WebSocket
 * (ADR-0008 허용 예외, 기존 통합 테스트와 동일)에 의존하며 모든 대기에
 * 상한을 강제한다. 난수·`Date.now()` 직접 호출 없음(ADR-0008).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** 서버 화이트박스 상태 폴링 간격(다른 rq-31 파일과 동일 값·동일 근거). */
const SERVER_POLL_INTERVAL_MS = 15
/** 화이트박스 텔레포트 후 스키마 동기화 정착 대기(다른 rq-31 파일과 동일). */
const TELEPORT_SETTLE_MS = 150
/** "피해가 없다"(무효화·미판정)를 확인하는 고정 관찰창(다른 rq-31 파일과
 * 동일 값·동일 근거). */
const NO_DAMAGE_OBSERVE_MS = 500
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300

/** Safe Zone 반경(상수에서 유도 — 하드코딩 금지, 다른 rq-31 파일과 동일). */
const RADIUS_M = WORLD.SAFE_ZONE_RADIUS_M
/** C를 B의 방사 방향으로 밀어내는 오프셋 — `rq-31-safe-zone*.test.ts`의
 * `FAR_OUTSIDE_OFFSET_M`과 동일 값·동일 반경-방사 기하 증명(실측 확인
 * 범위 0~20m 안) — C가 항상 모든 Safe Zone 밖에 있도록 보장한다. */
const TARGET_RADIAL_OFFSET_M = RADIUS_M + 15
/** 양성 대조군에서 B를 사선 밖으로 치우는 수직(사선에 대해) 오프셋 —
 * 히트박스 폭(바디 반지름 0.3m + 헤드 반지름 0.15m, `DEFAULT_HITBOX`)의
 * 수십 배라 "빗맞았다"가 아니라 "애초에 사선에서 벗어났다"를 명확히
 * 만든다. Safe Zone 반경과는 무관한 값이라 그 상수에서 유도하지 않는다. */
const SIDE_CLEAR_OFFSET_M = DEFAULT_HITBOX.bodyRadiusM * 30

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
 * `SafeZoneTestSeam`과 동일한 근거(그린필드가 아니다). */
interface BulletBlockTestSeam {
  state: {
    players: {
      get: (sessionId: string) => { x?: number; y?: number; z?: number; hp?: number } | undefined
    }
  }
  moveStates: Map<string, MoveStateSnapshot>
  positionHistory: Map<string, unknown[]>
  firedSinceSpawn: Map<string, boolean>
}

function getServerRoom(room: Room): BulletBlockTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as BulletBlockTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-31 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function readServerPlayer(seam: BulletBlockTestSeam, sessionId: string): PlayerSnapshot | undefined {
  const p = seam.state.players.get(sessionId)
  if (typeof p?.x === 'number' && typeof p?.y === 'number' && typeof p?.z === 'number' && typeof p?.hp === 'number') {
    return { x: p.x, y: p.y, z: p.z, hp: p.hp }
  }
  return undefined
}

function waitForServerCondition(
  seam: BulletBlockTestSeam,
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

/** `rq-31-safe-zone.test.ts`의 동명 함수와 동일 — 화이트박스 텔레포트
 * (`moveStates` + `positionHistory` 링버퍼 비우기). */
function teleportPlayer(seam: BulletBlockTestSeam, sessionId: string, position: { x: number; y: number; z: number }): void {
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

/** `rq-31-safe-zone*.test.ts`의 동명 헬퍼와 동일 — §반경-방사 기하 문서
 * 참고. `base`에서 "원점→base 방향"으로 `offsetM`만큼 더 밀어낸 좌표. */
function radialOutwardPoint(base: { x: number; y: number; z: number }, offsetM: number): { x: number; y: number; z: number } {
  const radialMagnitude = Math.hypot(base.x, base.z)
  if (radialMagnitude < 1e-6) {
    throw new Error(`RQ-31 테스트 전제 위반 — base(${base.x},${base.z})가 원점에 있어 방사 방향을 정의할 수 없다`)
  }
  const ux = base.x / radialMagnitude
  const uz = base.z / radialMagnitude
  return { x: base.x + ux * offsetM, y: base.y, z: base.z + uz * offsetM }
}

/** `base`에서 "원점→base 방향"에 **수직**인 방향으로 `offsetM`만큼 밀어낸
 * 좌표 — 양성 대조군에서 B를 A-C 사선 밖으로 치우는 데 쓴다(§조준 문서
 * 참고 — 사선은 원점→base 방향 그 자체이므로, 그 수직 방향으로 옮기면
 * 확실히 사선을 벗어난다). */
function perpendicularOffsetPoint(base: { x: number; y: number; z: number }, offsetM: number): { x: number; y: number; z: number } {
  const radialMagnitude = Math.hypot(base.x, base.z)
  if (radialMagnitude < 1e-6) {
    throw new Error(`RQ-31 테스트 전제 위반 — base(${base.x},${base.z})가 원점에 있어 수직 방향을 정의할 수 없다`)
  }
  const ux = base.x / radialMagnitude
  const uz = base.z / radialMagnitude
  // (ux, uz)를 90도 회전 — (-uz, ux).
  return { x: base.x - uz * offsetM, y: base.y, z: base.z + ux * offsetM }
}

/** A의 눈높이(`DEFAULT_HITBOX.eyeHeightM`)와 완전히 같은 수평면을 겨누는
 * 조준 벡터(`dirY = 0`) — §조준 문서(파일 상단)의 거리 무관 이중 명중
 * 증명이 성립하려면 수직 성분이 정확히 0이어야 한다. */
function aimHorizontalAtSameHeight(
  shooter: { x: number; z: number },
  target: { x: number; z: number },
): { dirX: number; dirY: number; dirZ: number } {
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const magnitude = Math.sqrt(dx * dx + dz * dz)
  return { dirX: dx / magnitude, dirY: 0, dirZ: dz / magnitude }
}

const ORIGIN = { x: 0, y: 0, z: 0 }

describe('RQ-31 v1.6: Safe Zone 플레이어의 총알 차단 — 사수-Safe Zone 플레이어-표적 일직선', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-31 v1.6: A·B(Safe Zone)·C가 일직선일 때 A가 C를 겨냥해 쏘면 B·C 둘 다 HP가 줄지 않고(B는 무효화, C는 애초에 판정되지 않음), B를 사선 밖으로 치우면 C가 즉시 정상 피격된다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      const roomC = await joinGame(newClient(server))
      const seam = getServerRoom(roomA)

      try {
        const baselineB = await waitForServerCondition(seam, roomB.sessionId, () => true, 'B 초기 서버 스냅샷', HP_TIMEOUT_MS)
        const baselineC = await waitForServerCondition(seam, roomC.sessionId, () => true, 'C 초기 서버 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)
        expect(baselineC.hp).toBe(PLAYER.MAX_HP)

        // RQ-16과의 분리 — B·C의 스폰 보호를 화이트박스로 즉시 해제한다
        // (자기 사격 트릭을 쓰지 않는 이유는 `rq-31-safe-zone.test.ts`
        // 상단 문서와 동일 — GA-19가 자기-해제 사격 자체를 막을 수 있다).
        seam.firedSinceSpawn.set(roomB.sessionId, true)
        seam.firedSinceSpawn.set(roomC.sessionId, true)

        // A를 원점으로 — §일직선 구성 문서의 가드: 원점이 실제로 모든
        // Safe Zone 밖인지 실측 확인한다(근사가 아니라 이 저장소의 실제
        // SPAWN_POINTS·SAFE_ZONE_RADIUS_M으로 직접 검증 — 하드코딩 금지).
        expect(isWithinSafeZone(ORIGIN)).toBe(false)
        teleportPlayer(seam, roomA.sessionId, ORIGIN)
        await sleep(TELEPORT_SETTLE_MS)

        // C를 B의 방사 방향으로 밀어내 원점-B-C 일직선을 구성하고, 동시에
        // C를 모든 Safe Zone 밖에 둔다(양성 대조군 전제 — 아래 가드로 확인).
        const cPoint = radialOutwardPoint(baselineB, TARGET_RADIAL_OFFSET_M)
        expect(isWithinSafeZone(cPoint)).toBe(false)
        teleportPlayer(seam, roomC.sessionId, cPoint)
        await sleep(TELEPORT_SETTLE_MS)

        // 원점(A)→C 수평 조준 — §조준 문서의 증명대로 이 방향 하나로
        // B(원점에서 더 가까움)·C(원점에서 더 멂) 둘 다 헤드 판정이
        // 확정된다.
        const aim = aimHorizontalAtSameHeight(ORIGIN, cPoint)

        // --- (1) 핵심 관측 — B가 사선을 막고 있을 때 ---
        roomA.send('fire', aim)
        await sleep(NO_DAMAGE_OBSERVE_MS)
        const bAfterCoreShot = readServerPlayer(seam, roomB.sessionId)
        const cAfterCoreShot = readServerPlayer(seam, roomC.sessionId)
        // B는 Safe Zone 내부라 최근접으로 뽑히더라도 피해가 무효화된다.
        expect(bAfterCoreShot?.hp).toBe(PLAYER.MAX_HP)
        // C는 이 테스트의 존재 이유 — B에 가려 애초에 최근접으로도
        // 뽑히지 못해(가정 F, 관통 없음) 피해를 받지 않는다.
        expect(cAfterCoreShot?.hp).toBe(PLAYER.MAX_HP)

        // --- (2) 양성 대조군 — B를 사선 밖으로 치우면 C가 정상 피격된다.
        // (1)의 "HP 불변"이 장치 자체가 꺼져 있어서(예: 조준이 빗나감)가
        // 아니라 실제로 B가 사선을 막고 있었기 때문이라는 것을 여기서
        // 확정한다. ---
        await sleep(BETWEEN_SHOTS_MS)
        const bOffAxis = perpendicularOffsetPoint(baselineB, SIDE_CLEAR_OFFSET_M)
        teleportPlayer(seam, roomB.sessionId, bOffAxis)
        await sleep(TELEPORT_SETTLE_MS)
        // A·C는 그대로 — 조준도 그대로 재사용한다(B만 치웠다는 것을
        // 최소 변경으로 보이기 위함).
        roomA.send('fire', aim)
        const cAfterControlShot = await waitForServerCondition(
          seam,
          roomC.sessionId,
          (p) => p.hp < PLAYER.MAX_HP,
          '양성 대조군 — B를 치운 뒤 C의 정상 피격 대기',
          HP_TIMEOUT_MS,
        )
        expect(cAfterControlShot.hp).toBeLessThan(PLAYER.MAX_HP)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB), leaveRoom(roomC)])
      }
    },
    20_000,
  )
})
