import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON, WORLD } from '@shared/constants'

/**
 * RQ-10 탄창 10발·예비 무한 — 서버 권위(RQ-61) 통합 테스트 (ADR-0008:
 * Colyseus 룸 경계, ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-03** (`harness/evals/golden/track-a-product.jsonl`).
 * GA-03: "given: 플레이어가 Pistol을 장착, 탄창 10발 가득 참, 예비 탄약
 * 무한 / when: 플레이어가 10발을 모두 발사 / then: 탄창이 0이 되어도 예비
 * 탄약 소진으로 인한 사격 불가 상태는 발생하지 않는다(재장전하면 계속 사격
 * 가능)." `verify` 필드가 이 파일 경로를 정확히 지정한다.
 *
 * **레벨 분리(ADR-0008/ADR-0011)**: "정확히 60틱(2000ms)째에 재장전이
 * 완료되는가" 같은 경계 로직 자체는 `tests/unit/sim-ammo.test.ts`(A계층,
 * 결정론 — 틱 정수만 주입)가 고정한다. 이 파일(B계층)은 그 로직이 실
 * Colyseus 룸(`GameRoom`)에 실제로 결합돼 굴러가는지를 블랙박스로 확인한다.
 *
 * **결정론 메모(실 대기 — 최후 수단, `rq-15-respawn-timer.test.ts` 상단과
 * 동일한 이유)**: `GameRoom`의 틱 루프는 Colyseus `setSimulationInterval`
 * (실측 `Date.now()` 기반)로 구동돼 테스트 프로세스에서 서버 시간을 앞당길
 * 방법이 없다 — 재장전 완료(2초) 관측만은 실제로 기다린다. 모든 대기는
 * 상한(`HP_TIMEOUT_MS`)이 있거나 고정 길이(길이 명시)다.
 *
 * **가정(coder에게)**: `rq-12-server-hitscan.test.ts`의 가정 1~4(`Player.hp`
 * 필드, `'fire'` payload 형태, 즉시 판정, `DEFAULT_HITBOX`)와 동일한 기반
 * 위에, `tests/unit/sim-ammo.test.ts` 상단 그린필드 계약(`@shared/sim/ammo`)
 * 및 그 "가정(coder에게 — GameRoom 배선)" 절 1~6이 이 파일에도 그대로
 * 적용된다 — 특히 항목 3(발사가 실제로 처리될 때마다 명중 여부와 무관하게
 * 탄약을 소모하고, 소모 후 탄창이 0이면 자동으로 재장전을 시작한다)이 이
 * 파일의 핵심 전제다.
 *
 * **스폰 보호와의 상호작용**: 방금 접속한 플레이어는 최초 입장에도 스폰
 * 보호(RQ-16)가 걸린다(`rq-16-spawn-protection.test.ts` REV) — 사수 A의
 * 사격 자체는 보호와 무관하게 항상 나가지만(탄약 소모에 영향 없음), 피해자
 * B가 보호 중이면 명중해도 HP가 줄지 않아 "탄약이 있어서 명중했다"와
 * "보호로 무효화됐다"를 구분할 수 없게 된다. B가 테스트 시작 직후 스스로
 * (빗나가는 방향으로) 한 발 쏴 자신의 보호를 즉시 해제한다 — 그 사격은
 * B 자신의 탄약을 소모할 뿐 이 테스트가 관측하는 A의 탄약과는 무관하다.
 *
 * **공허화(vacuity) 방지 설계(팀리드 지시)**: "사격이 무시된다"는 음성
 * 단언만 있으면 rate-limit(150ms)·스폰 보호·사망 등 **다른 이유**로도
 * 무시될 수 있어 탄약 메커니즘 자체가 없어도 테스트가 통과할 수 있다. 이
 * 파일은 양성 대조군으로 이를 막는다: (1) 탄창을 비우기 **직전**(1번째
 * 사격)에 같은 조준 벡터로 실제 명중(HP 감소)을 먼저 확인해 "이 조준은
 * 명중한다"는 것을 고정하고, (2) 탄창이 빈 직후의 재사격 시도는 **같은
 * 조준 벡터**로 HP 불변을 확인하며, (3) 재장전 완료 후에는 다시 **같은
 * 조준 벡터**로 HP 감소를 확인한다. (2)의 무변화가 rate-limit 때문이 아님을
 * 보장하기 위해 직전 사격과의 간격을 rate-limit(150ms)을 명백히 초과하는
 * `IMMEDIATE_RETRY_DELAY_MS`(300ms)로 둔다. 데미지 총합도 최대 2회 명중
 * (1번째 + 재장전 후)으로 제한해 — 최악의 경우(2회 모두 헤드샷, 50+50=100)
 * 에도 "무변화 확인" 시점(1회 명중 후, HP≥50)에는 B가 살아있음이 보장돼,
 * 시신 제외 필터(`canAct` 히트 후보 가드, `GameRoom.ts:265`)가 "무변화"의
 * 원인이 되는 혼선을 피한다.
 *
 * **제외**: 클라 탄약 HUD(RQ-53), 재장전 애니메이션·사운드, 리스폰 시
 * 탄창 초기화(스펙 침묵 — 이 파일은 리스폰이 개입하지 않는 시간대에서만
 * 관측한다).
 *
 * **REV(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19, `86fddf1`) 이후 두 가지가 새로
 * 필요해졌다. (1) B의 최초 입장 스폰 보호(RQ-16) 해제를 자기-사격
 * (`UP_MISS_AIM`)이 아니라 `firedSinceSpawn` 화이트박스 직접 기입으로
 * 한다 — B는 자기 스폰 지점(Safe Zone 내부, 거리 0)에 있으므로 그 자기
 * 사격 자체가 이제 GA-19 게이트에 막힌다. (2) **A(이 파일의 실제
 * 사수)도 자신의 스폰 지점(Safe Zone 내부)에 그대로 있으므로, A의 실제
 * 조준 사격(양성 대조군·탄창 소모 루프 전부)도 A를 옮기지 않으면 똑같이
 * 막힌다 — `rq-31-safe-zone.test.ts`의 반경-방사(radial-outward) 기하로
 * A를 자신의 스폰 지점 기준 방사 방향으로 화이트박스 텔레포트해 모든
 * Safe Zone 밖으로 옮긴다(고정 방향(+X) 실이동은 15개 스폰 지점 중 4곳에서
 * 다른 스폰 지점의 Safe Zone에 새로 들어가는 것이 실측돼 채택하지 않았다).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300
/** 탄창을 비운 직후 즉시 재사격을 시도하는 간격 — rate-limit(150ms)을
 * 명백히 초과해, 이후 "명중하지 않음"이 rate-limit이 아니라 탄약/재장전
 * 잠금 때문임을 보장한다. */
const IMMEDIATE_RETRY_DELAY_MS = 300
/** "명중하지 않는다"를 확인하는 관찰 창 — 여러 상태 갱신을 거치기 충분한
 * 여유(다른 통합 테스트의 NO_DAMAGE_OBSERVE_MS와 동일 패턴). */
const BLOCKED_OBSERVE_MS = 400
/** RQ-31 회귀 대응 — A의 화이트박스 Safe Zone 탈출 텔레포트가 스키마
 * (`player.x/y/z`)에 정착할 시간(서버 틱 ≈33ms의 몇 배 여유). */
const SELF_FIRE_SETTLE_MS = 300
/** 재장전(WEAPON.RELOAD_MS=2000ms) 완료를 확실히 넘기는 여유(스케줄링
 * 지터 흡수, `rq-16` PROTECTION_EXPIRE_WAIT_MS 산정과 동일 정신). */
const RELOAD_TOTAL_WAIT_MS = WEAPON.RELOAD_MS + 400

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

/** A(shooter)의 눈높이에서 target의 바디 중심을 겨누는 조준 벡터
 * (`rq-15`·`rq-16`·`rq-14`와 동일한 일반형 — A·B가 서로 다른 임의 위치에
 * 스폰되므로 두 위치 모두를 인자로 받는다). */
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

/** GA-06/GA-08과 동일한 근거로 기하학적으로 항상 빗나가는 방향(수직 위) —
 * 위치와 무관하게 안전하다. 탄약을 소모하되 대상에게는 절대 명중하지
 * 않는다 — 탄창을 비우는 반복 사격에 쓴다(명중으로 인한 사망 위험 없이
 * 탄약만 소모). */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

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

/** RQ-31 Safe Zone 회귀 대응 — 사수를 자신의 스폰 지점 기준 방사
 * 방향(원점→스폰 지점)으로 밀어내 모든 Safe Zone 밖으로 옮긴다
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

describe('RQ-10/GA-03: 탄창 10발 소진 후에도 영구 사격 불가 상태가 되지 않는다(재장전하면 계속 사격 가능)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-10/GA-03: 10발을 모두 발사해 탄창이 0이 되면 즉시 재사격은 무시되지만, 재장전(2초) 후에는 같은 조준으로 다시 명중한다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        // RQ-31 회귀 대응(파일 상단 REV) — B의 RQ-16 해제는 화이트박스로
        // (자기 사격은 B 자신의 Safe Zone에 막힐 수 있다). A(사수)·B(피격자)
        // 둘 다 Safe Zone 밖으로 옮긴다 — A가 남아 있으면 GA-19가 사격
        // 자체를 막고, B가 남아 있으면 RQ-16과 무관하게 GA-11(위치 기반
        // 피해 무효화)이 계속 피해를 무효화한다.
        const safeZoneSeam = getSafeZoneSeam(roomA)
        safeZoneSeam.firedSinceSpawn.set(roomB.sessionId, true)
        const escapedA = escapeSafeZone(safeZoneSeam, roomA.sessionId, baselineA)
        const escapedB = escapeSafeZone(safeZoneSeam, roomB.sessionId, baselineB)
        await sleep(SELF_FIRE_SETTLE_MS)

        const aim = aimAtBody(escapedA, escapedB)

        // 양성 대조군 1(공허화 방지) — 탄창을 비우기 전, 이 조준 벡터가
        // 실제로 명중함을 먼저 고정한다(탄약 10 → 9).
        roomA.send('fire', aim)
        const afterFirstShot = await waitForPlayerCondition(
          roomB,
          roomB.sessionId,
          (p) => p.hp < PLAYER.MAX_HP,
          '1번째 사격(양성 대조군) 후 HP 감소 대기',
          HP_TIMEOUT_MS,
        )
        expect(afterFirstShot.hp).toBeLessThan(PLAYER.MAX_HP)
        const hpAfterFirstShot = afterFirstShot.hp

        // 레이스 수정(REV): waitForPlayerCondition은 로컬 WS 왕복(30~50ms)
        // 만에 resolve되므로, 여기서 곧장 루프에 진입하면 루프의 첫 사격이
        // 직전 양성 대조군 사격과의 간격이 rate-limit(150ms) 미만이 되어
        // 그 발이 정당하게 드롭(ADR-0005)되고, 탄창 계산이 어긋난다(10발
        // 소모 의도가 9발만 소모됨 → 탄창에 1발이 남아 아래 "즉시 재사격은
        // 무명중" 단언이 깨진다). 대조군과 루프 사이에 BETWEEN_SHOTS_MS
        // 간격을 둬 루프의 모든 사격이 rate-limit을 명백히 초과하게 한다.
        await sleep(BETWEEN_SHOTS_MS)

        // 남은 9발은 명중해도 대상이 죽지 않도록(공허화 방지 설계 — 파일
        // 상단 참고) 항상 빗나가는 방향으로 소모한다. 이 9발 + 위 1발 =
        // 정확히 WEAPON.MAGAZINE(10)발이다.
        for (let shot = 1; shot <= WEAPON.MAGAZINE - 1; shot += 1) {
          roomA.send('fire', UP_MISS_AIM)
          await sleep(BETWEEN_SHOTS_MS)
        }

        // 탄창이 정확히 0이 된 시점(위 루프의 마지막 사격) — 재장전 완료
        // 대기의 기준 시각으로 삼는다.
        const reloadStartedAtMs = Date.now()

        // 핵심 관찰 1: 탄창이 빈 직후 같은 조준으로 즉시 재사격해도 명중하지
        // 않는다(HP 불변) — rate-limit은 IMMEDIATE_RETRY_DELAY_MS로 이미
        // 배제했으므로, 무명중의 원인은 탄약 소진/재장전 잠금뿐이다.
        await sleep(IMMEDIATE_RETRY_DELAY_MS)
        roomA.send('fire', aim)
        await sleep(BLOCKED_OBSERVE_MS)
        const afterEmptyAttempt = readPlayer(roomB, roomB.sessionId)
        expect(afterEmptyAttempt?.hp).toBe(hpAfterFirstShot)

        // 재장전 완료(2초)까지 남은 시간을 마저 기다린다.
        const elapsedSinceReloadStart = Date.now() - reloadStartedAtMs
        const remainingWaitMs = Math.max(0, RELOAD_TOTAL_WAIT_MS - elapsedSinceReloadStart)
        await sleep(remainingWaitMs)

        // 핵심 관찰 2(GA-03 then) — 재장전이 끝나면 같은 조준으로 다시
        // 명중한다: 탄약 소진이 영구적인 사격 불가 상태를 만들지 않는다.
        roomA.send('fire', aim)
        const afterReload = await waitForPlayerCondition(
          roomB,
          roomB.sessionId,
          (p) => p.hp < hpAfterFirstShot,
          '재장전 완료 후 같은 조준 재사격 시 HP 추가 감소 대기',
          HP_TIMEOUT_MS,
        )
        expect(afterReload.hp).toBeLessThan(hpAfterFirstShot)
      } finally {
        // allSettled — 정리 자체의 실패(예: 이미 끊긴 연결의 leave 타임아웃)가
        // try 블록에서 던져진 진짜 단언 실패를 가려서는 안 된다.
        await Promise.allSettled([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    30_000,
  )
})
