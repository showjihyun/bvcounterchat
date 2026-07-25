import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'

/**
 * RQ-17 개인전(Free-For-All) — 팀 판정 없이 모든 플레이어 간 피해를
 * 허용한다 (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직
 * Red-first 영역).
 *
 * RQ-17 전문: "개인전이므로 시스템은 팀 판정 없이 모든 플레이어 간 피해를
 * 허용해야 한다(Friendly Fire = 아군 판정 없음)." 이 요구사항에 매핑된
 * 전용 GA는 없다 — team-lead 지시대로 **얇게**(thin) 확인한다: 현재
 * 스키마(`@shared/schema/GameState`)에 팀 필드가 아예 없으므로, "팀 개념
 * 부재"를 직접 증명하는 가장 확실한 방법은 **같은 두 플레이어 사이에서
 * 피해가 양방향으로 모두 성립한다**는 것을 보이는 것이다 — 만약 구현이
 * (스펙에 없는) 접속 순서·세션ID 기반의 암묵적 "편"을 가르는 버그가 있다면
 * 한쪽 방향의 피해만 성립하고 반대 방향은 막힐 것이다.
 *
 * **레벨 분리(ADR-0008)**: 명중·데미지 산술 자체는
 * `tests/unit/sim-combat.test.ts`·`rq-12-server-hitscan.test.ts`가 이미
 * 검증했다. 이 파일은 그 산술을 반복 검증하지 않고 "제3의 방향 제약(팀)이
 * 존재하지 않는가"만 thin하게 확인한다 — 그래서 데미지 값 자체는 A→B,
 * B→A 각각 1회씩만 쏘아 HP가 바디 데미지만큼 감소하는지만 본다(4연타
 * 사망까지는 가지 않는다 — 그건 GA-08/`rq-14`의 책임).
 *
 * **가정(coder에게)**: `rq-12-server-hitscan.test.ts`의 가정 1~4와 동일.
 * rate-limit(ADR-0005)은 **사수별 독립 추적**이라고 가정했으므로(그 파일
 * 가정 4), A→B 사격 직후 B→A 사격을 보내도 서로 다른 세션이라 rate-limit
 * 충돌이 없다 — 그래도 이 테스트는 A의 사격 처리가 HP 변화로 확인된 뒤에만
 * B의 반격을 보내 순서를 명확히 한다(레이스 방지).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한.
 *
 * **REV(구현 후 셋업 적응, RQ-15~16 라운드, team-lead 지시)**: RQ-16
 * item C(최초 입장도 스폰 보호)와 RQ-31(onJoin도 스폰 로테이션) 구현으로
 * A→B 사격이 B의 최초 입장 보호에 막혀 무효화됐고, "B → A: 반대 방향
 * (-distance)" 조준도 A가 원점(x=0)이라는, 더 이상 성립하지 않는 전제에
 * 의존했다(`_workspace/RQ-15-16/02_coder_green.md` §3.3). 대응: (1) B가
 * A의 사격 전에 스스로(빗나가는 방향으로) 한 발 쏴 자신의 보호를 즉시
 * 해제한다 — A는 자신이 쏘는 행위 자체로 자신의 보호가 자동 해제되므로
 * (RQ-16 "사격하면 즉시 해제"는 대상이 아니라 사수 자신에게 적용) 별도
 * 조치가 필요 없다. (2) `aimAtBody`가 두 플레이어의 실제 위치를 읽어
 * 상대 오프셋을 계산하도록 일반화했다. 단언(양방향 HP 감소량) 자체는
 * 손대지 않았다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
const TRAVEL_MS = 900
const SETTLE_MS = 200

/** GA-06/GA-08과 동일한 근거로 기하학적으로 항상 빗나가는 방향(수직 위) —
 * 위치와 무관하게 안전하다. REV: B가 이 방향으로 자기 자신을 쏘면 자신의
 * 스폰 보호가 즉시 해제된다(RQ-16). */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

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

/** REV: `z` 필드를 추가했다 — A·B 둘 다 더 이상 원점에 고정되지 않아
 * (RQ-31 onJoin 로테이션) 조준 벡터 계산에 두 플레이어의 z좌표가 모두
 * 필요하다(파일 상단 REV 참고). */
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

async function travelAndSettle(mover: Room): Promise<PlayerFields> {
  mover.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
  await sleep(TRAVEL_MS)
  mover.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
  await sleep(SETTLE_MS)
  const settled = readPlayer(mover, mover.sessionId)
  if (!settled) throw new Error('travelAndSettle: 이동 후 위치 관측 실패')
  return settled
}

/** shooter(발 위치)에서 target(발 위치)의 바디 중심을 조준하는 방향 벡터
 * (정규화). REV: 두 플레이어 모두 더 이상 원점에 고정되지 않으므로(RQ-31
 * onJoin 로테이션) 두 위치 모두를 인자로 받는 일반형이다(`rq-15`·`rq-16`과
 * 동일 패턴) — "B → A"(반대 방향) 조준도 이제 A의 실제 위치를 target으로
 * 넘기면 그대로 성립한다. */
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

describe('RQ-17: 팀 판정 없이 모든 플레이어 간 피해가 양방향으로 허용된다(Friendly Fire = 아군 판정 없음)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-17: A가 B를 쏘면 B의 HP가 줄고, 곧이어 B가 A를 쏘면 A의 HP도 똑같이 준다 — 어느 쪽도 상대의 사격을 "아군"으로 취급해 막지 않는다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server)) // +X로 이동

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineA.hp).toBe(PLAYER.MAX_HP)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      roomB.send('fire', UP_MISS_AIM) // REV: 자신의 최초 입장 스폰 보호를 즉시 해제(item C)
      const settledB = await travelAndSettle(roomB) // 1100ms 경과 — 위 해제 사격이 반영되기 충분하다

      // A → B: 명중해야 한다(팀 제약이 있다면 여기서부터 막힐 것이다).
      roomA.send('fire', aimAtBody(baselineA, settledB))
      const bAfterHit = await waitForHpCondition(
        roomB,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'A → B 사격 후 B의 HP 감소 대기',
      )
      expect(bAfterHit.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      // B → A: A의 실제 위치를 target으로 조준 — 이 사격도 동일하게 명중해야
      // 한다. "먼저 쏜 쪽만 유효하다" 같은 숨은 우선순위가 있다면 여기서
      // 실패한다. A는 스스로 사격한 적이 있어(위 A→B) 자신의 최초 입장
      // 보호가 이미 해제된 상태다(RQ-16 "사격하면 즉시 해제"는 사수 자신에게
      // 적용 — 별도 release 불필요).
      roomB.send('fire', aimAtBody(settledB, baselineA))
      const aAfterHit = await waitForHpCondition(
        roomA,
        roomA.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'B → A 반격 후 A의 HP 감소 대기',
      )
      expect(aAfterHit.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )
})
