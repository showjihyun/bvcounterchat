import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { WALL_EAST } from '@shared/sim/walls'
import { isWithinSafeZone } from '@shared/sim/spawn'
import type { WallAABB } from '@shared/sim/movement'
import { escapeSafeZone, releaseSpawnProtectionAndEscape, getSafeZoneSeam, type SafeZoneEscapeSeam } from '../support/safe-zone'

/**
 * RQ-57·58·59 공통 — 명중 이벤트의 식별자(ADR-0008: Colyseus 룸 경계,
 * ADR-0011: 서버 판정 로직 Red-first 영역, ADR-0016 결정 1 개정 —
 * 2026-08-15, 원장 24ct).
 *
 * EARS 문면(`harness/specs/requirements.md`, RQ-57·58·59 공통 절): "서버는
 * 명중 이벤트에 **사수의 식별자**를, 대상이 플레이어이면 **피격자의
 * 식별자**를 함께 담아야 한다. 클라이언트는 그 값으로 **자신과의 관계만**
 * 가르고 **데미지·HP·킬을 계산하지 않는다**(RQ-61 — 그 값은 서버 스냅샷에서만
 * 온다)."
 *
 * 매핑된 골든 케이스: **GA-119**
 * (`_workspace/RQ-57-59-identity/golden.json`).
 * - given: 서버가 플레이어 명중을 판정했다. 방에는 사수·피격자·제3자가 있다.
 * - when: 서버가 명중 이벤트를 브로드캐스트한다.
 * - then: 이벤트에 **사수의 식별자**와 **피격자의 식별자**가 담긴다. 세
 *   클라이언트가 **같은 이벤트**를 받고 각자 자기와의 관계를 가른다 —
 *   사수는 「내가 맞혔다」, 피격자는 「내가 맞았다」, 제3자는 **둘 다
 *   아니다**.
 *
 * 두 번째 `describe`는 GA-119(플레이어 명중)가 다루지 않는 **벽 명중** 사례를
 * 검증한다 — 공통 절 원문이 "대상이 플레이어이면 피격자의 식별자를 함께
 * 담아야 한다"고 조건부로 적어, 대칭 조건("벽이면 담지 않는다")도 정본
 * 문면 자체가 요구한다. 이 조건에는 전용 GA-ID가 없다(골든 파일에 GA-119
 * 하나뿐 — `_workspace/RQ-57-59-identity/golden.json` 실측) — `verify`
 * 필드가 아니라 EARS 문면 자체를 근거로 검증한다.
 *
 * **레벨 분리(ADR-0008)**: payload 내용은 이 파일이 실 Colyseus 룸 경계
 * 너머에서 세 클라이언트가 실제로 수신하는 값을 블랙박스로 관측한다.
 * 클라이언트가 그 식별자로 "나와의 관계"를 가르는 순수 판정 로직(GA-120)은
 * `tests/unit/rq-57-59-hit-relation.test.ts`가 담당한다 — 이 파일은 그
 * 판정 함수를 임포트하지 않는다(레벨 분리, `sim-combat-wall-hit.test.ts`/
 * `rq-12-wall-occlusion.test.ts` 관계와 동일한 정신).
 *
 * **좌표 설계**:
 * - **플레이어 명중**(GA-119): `rq-12-server-hitscan.test.ts`와 동일한
 *   반경-방사 탈출(`tests/support/safe-zone.ts`)로 사수 A·피격자 B를 각자의
 *   스폰 밖으로 민다(그 파일이 이미 이 설정에서 명중이 실제로 일어남을
 *   검증했다 — 벽 차폐 없이 명중하는 좌표라는 전제를 재사용). 제3자 C는
 *   **움직이지 않는다** — 자기 스폰 지점(반지름 22m 원)에 그대로 둬도
 *   A·B가 밀려난 반지름 28m대의 좁은 조준선(스폰 지점 사이 최소 각도
 *   24°, escape 후 최소 현 길이 ≈11.6m)과 우연히 겹칠 가능성은 무시할
 *   수준이다(`tests/support/safe-zone.ts`가 이미 확립한 오프셋 기하와
 *   같은 근거) — C의 유일한 역할은 **관찰**이므로 위치를 옮길 이유가 없다.
 * - **벽 명중**(요구 1·2): `rq-12-wall-occlusion.test.ts`의 검증된 좌표
 *   (사수 원점, `WALL_EAST` x:15~16·z:-5~5)를 재사용한다. 이 라운드는
 *   대상 플레이어를 아예 두지 않는다(사수 A 혼자 입장) — 그러면
 *   `GameRoom.handleFire`의 `closest`가 항상 `undefined`가 되어 벽 분기로
 *   가고(`GameRoom.ts` 844~859행 부근, "플레이어를 맞히지 못했다 — 벽
 *   명중은 여기서만 계산한다"), 다른 플레이어가 우연히 사이에 끼어 판정을
 *   흐릴 여지 자체가 없다.
 *
 * **화이트박스 계약**: `moveStates`·`positionHistory`·`firedSinceSpawn`은
 * 기존 rq-12/rq-31 계열이 이미 확립한 정확히 같은 이름의 private 필드다
 * (그린필드 아님, `tests/support/safe-zone.ts` 참고). `wallsOverride`도
 * `rq-12-wall-occlusion.test.ts`가 이미 확립한 필드를 그대로 재사용한다
 * (이 라운드의 신규 계약이 아니다 — 이 파일은 새 화이트박스 필드를 추가
 * 요구하지 않는다).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외, 기존 rq-12 계열과 동일). 모든 대기에 `withTimeout()` 상한을
 * 건다. 난수·`Date.now()` 직접 호출 없음.
 *
 * **그린필드 계약(test-writer 지정, coder에게) — 서버 쪽만**: 서버의
 * `HitEvent`(`GameRoom.ts`, 현재 `{ point, normal, target }`뿐)에
 * `shooterId: string`과 `victimId?: string`을 추가한다. 두
 * `broadcast('hit', ...)` 호출부(벽 — `GameRoom.ts` 856행 부근, 플레이어 —
 * 871행 부근) 모두 `shooterId`(현재 스코프의 `shooterId` 매개변수)를
 * 채운다. 플레이어 명중이면 `victimId`도 채운다(`closest.id`). 벽
 * 명중이면 `victimId` 필드를 아예 넣지 않는다(이 파일이
 * `toBeUndefined()`로 확인 — `JSON`/Colyseus 메시지 직렬화에서 존재하지
 * 않는 필드와 `undefined` 필드는 클라이언트에서 동일하게 관측된다).
 * 클라이언트 쪽 계약(`HitEvent` 타입 확장·`classifyHitRelation`)은
 * `tests/unit/rq-57-59-hit-relation.test.ts` 상단 참고 — 이 파일은 그
 * 타입을 임포트하지 않는다(payload 내용은 로컬 타입으로 블랙박스
 * 관측한다, 위 "레벨 분리" 참고).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HIT_TIMEOUT_MS = 5_000
/** 화이트박스 텔레포트/반경-방사 탈출 후 스키마 동기화 정착 대기. */
const SETTLE_MS = 200
const TELEPORT_SETTLE_MS = 150

/** 벽 명중 사수 — `rq-12-wall-occlusion.test.ts`의 `SHOOTER_POS`와 동일
 * 좌표·동일 안전성 근거(최근접 스폰 지점까지 22m, Safe Zone 밖). */
const SHOOTER_POS = { x: 0, y: 0, z: 0 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 모든 대기에 상한을 강제하는 래퍼 — 상한 초과는 hang이 아니라 즉시 실패다. */
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

interface PlayerXZ {
  x: number
  z: number
}

function readPlayerXZ(room: Room, sessionId: string): PlayerXZ | undefined {
  const state = room.state as { players?: { get?: (key: string) => { x?: unknown; z?: unknown } | undefined } } | null
  const player = state?.players?.get?.(sessionId)
  if (typeof player?.x === 'number' && typeof player?.z === 'number') {
    return { x: player.x, z: player.z }
  }
  return undefined
}

function waitForDefinedPlayer(room: Room, sessionId: string): Promise<PlayerXZ> {
  return withTimeout(
    new Promise<PlayerXZ>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayerXZ(room, sessionId)
        if (current) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HIT_TIMEOUT_MS,
    `초기 스냅샷(sessionId=${sessionId}) 관측`,
  )
}

/** shooter(발 위치)에서 target(발 위치)의 바디 중심을 정확히 조준하는
 * 방향 벡터(정규화) — `rq-12-server-hitscan.test.ts`의 `aimAt`과 동일 패턴. */
function aimAt(shooter: PlayerXZ, target: PlayerXZ, verticalCenterM: number): { dirX: number; dirY: number; dirZ: number } {
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = verticalCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

function bodyCenterM(): number {
  return (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
}

/** 서버 'hit' 브로드캐스트 payload를 블랙박스로 관측하기 위한 로컬 타입.
 * `@client/effects/hitFeedback`의 `HitEvent`를 임포트하지 않는다(위
 * "레벨 분리" 참고 — 클라이언트 타입 변경과 이 파일의 서버 payload
 * 관측을 결합하지 않는다). `shooterId`/`victimId`가 이 라운드의 신규
 * 요구다. */
interface HitEventPayload {
  point: { x: number; y: number; z: number }
  normal: { x: number; y: number; z: number }
  target: 'wall' | 'player'
  shooterId?: string
  victimId?: string
}

/** 방 하나가 수신한 'hit' 브로드캐스트를 지속적으로 누적한다
 * (`rq-40-chat-ordering.test.ts`의 `watchChat`과 동일 패턴 — 채팅과 마찬가지로
 * 명중도 상태 조회가 불가능한 순수 이벤트라 폴링이 아니라 리스너 누적이
 * 필요하다). */
function watchHit(room: Room): { received: HitEventPayload[] } {
  const watcher = { received: [] as HitEventPayload[] }
  room.onMessage<HitEventPayload>('hit', (event) => {
    watcher.received.push(event)
  })
  return watcher
}

/** `watcher.received.length`가 `count`에 도달할 때까지 대기한다
 * (`rq-40-chat-ordering.test.ts`의 `waitForChatCount`와 동일 패턴). */
function waitForHitCount(
  room: Room,
  watcher: { received: HitEventPayload[] },
  count: number,
  timeoutMs: number,
  label: string,
): Promise<HitEventPayload[]> {
  if (watcher.received.length >= count) return Promise.resolve(watcher.received)
  return withTimeout(
    new Promise<HitEventPayload[]>((resolve) => {
      room.onMessage<HitEventPayload>('hit', () => {
        if (watcher.received.length >= count) resolve(watcher.received)
      })
    }),
    timeoutMs,
    label,
  )
}

describe('RQ-57·58·59 공통/GA-119: 명중 이벤트에 사수·피격자 식별자가 담기고, 세 클라이언트가 같은 이벤트에서 각자 다른 관계를 가른다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'GA-119: A가 B를 명중시키면 사수 A·피격자 B·제3자 C가 같은 hit 이벤트를 받고, A는 「내가 맞혔다」·B는 「내가 맞았다」·C는 둘 다 아니다로 가른다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수
      const roomB = await joinGame(newClient(server)) // 피격자
      const roomC = await joinGame(newClient(server)) // 제3자 — 관찰만 한다, 움직이지 않는다

      try {
        const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
        const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
        await waitForDefinedPlayer(roomC, roomC.sessionId) // C도 초기 스냅샷이 도착했는지만 확인(좌표는 쓰지 않는다)

        // REV2 계열(RQ-31 Safe Zone) 대응 — `rq-12-server-hitscan.test.ts`와
        // 동일한 반경-방사 탈출로 A·B를 각자의 스폰 밖으로 옮긴다.
        const seam = getSafeZoneSeam(roomA)
        const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
        const escapedB = releaseSpawnProtectionAndEscape(seam, roomB.sessionId, baselineB)
        await sleep(SETTLE_MS)
        expect(escapedB.x).not.toBe(baselineB.x) // 실제로 이동했다는 전제 확인

        const watcherA = watchHit(roomA)
        const watcherB = watchHit(roomB)
        const watcherC = watchHit(roomC)

        const aim = aimAt(escapedA, escapedB, bodyCenterM())
        roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ })

        const [eventsA, eventsB, eventsC] = await Promise.all([
          waitForHitCount(roomA, watcherA, 1, HIT_TIMEOUT_MS, 'A(사수)의 hit 브로드캐스트 수신 대기'),
          waitForHitCount(roomB, watcherB, 1, HIT_TIMEOUT_MS, 'B(피격자)의 hit 브로드캐스트 수신 대기'),
          waitForHitCount(roomC, watcherC, 1, HIT_TIMEOUT_MS, 'C(제3자)의 hit 브로드캐스트 수신 대기'),
        ])

        const eventA = eventsA[0]!
        const eventB = eventsB[0]!
        const eventC = eventsC[0]!

        // 세 클라이언트가 받은 것은 같은 명중 사건이다(동일 payload).
        expect(eventA.target).toBe('player')
        expect(eventB).toEqual(eventA)
        expect(eventC).toEqual(eventA)

        // payload 자체에 두 식별자가 담긴다(공통 절 요구 1·2).
        expect(eventA.shooterId).toBe(roomA.sessionId)
        expect(eventA.victimId).toBe(roomB.sessionId)

        // 세 클라이언트가 같은 이벤트에서 각자 다른 관계를 가른다(GA-119 then).
        expect(eventA.shooterId === roomA.sessionId).toBe(true) // A: 내가 맞혔다
        expect(eventA.victimId === roomA.sessionId).toBe(false)

        expect(eventB.victimId === roomB.sessionId).toBe(true) // B: 내가 맞았다
        expect(eventB.shooterId === roomB.sessionId).toBe(false)

        expect(eventC.shooterId === roomC.sessionId).toBe(false) // C: 둘 다 아니다
        expect(eventC.victimId === roomC.sessionId).toBe(false)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB), leaveRoom(roomC)])
      }
    },
    30_000,
  )
})

/** 벽 명중 전용 화이트박스 계약 — `wallsOverride`는
 * `rq-12-wall-occlusion.test.ts`가 이미 확립한 필드다(그린필드 아님). */
interface WallTestSeam extends SafeZoneEscapeSeam {
  wallsOverride?: readonly WallAABB[] | undefined
}

function getWallSeam(room: Room): WallTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as WallTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-57-59 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** 화이트박스 텔레포트(`moveStates` + `positionHistory` 링버퍼 비우기 —
 * `tests/support/safe-zone.ts`의 "묶는 이유" 문서와 동일 근거). */
function teleportPlayer(seam: WallTestSeam, sessionId: string, position: { x: number; y: number; z: number }): void {
  seam.moveStates.set(sessionId, { x: position.x, y: position.y, z: position.z, vx: 0, vy: 0, vz: 0, grounded: true })
  seam.positionHistory.delete(sessionId)
}

describe('RQ-57·58·59 공통(요구 1·2): 벽 명중은 사수 식별자만 담기고 피격자 식별자는 없다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "요구 1·2: A 혼자 입장해 벽을 쏘면 shooterId는 A의 sessionId이고 victimId는 없다(target='wall')",
    async () => {
      const roomA = await joinGame(newClient(server))
      const seam = getWallSeam(roomA)

      try {
        // 좌표 설계 전제 — 맵이 WALL_EAST를 바꾸면 이 guard가 먼저 실패한다
        // (`rq-12-wall-occlusion.test.ts` "좌표 설계" 문서와 동일 근거).
        expect(SHOOTER_POS.x).toBeLessThan(WALL_EAST.minX)
        expect(isWithinSafeZone(SHOOTER_POS)).toBe(false)

        seam.wallsOverride = undefined // 명시 초기화(22z4 교훈) — 프로덕션 기본값(PRODUCTION_WALLS) 사용
        teleportPlayer(seam, roomA.sessionId, SHOOTER_POS)
        await sleep(TELEPORT_SETTLE_MS)

        const watcherA = watchHit(roomA)
        roomA.send('fire', { dirX: 1, dirY: 0, dirZ: 0 }) // +X — WALL_EAST(x:15~16, z:-5~5)를 직선으로 관통, 대상 플레이어 없음

        const events = await waitForHitCount(roomA, watcherA, 1, HIT_TIMEOUT_MS, 'A의 벽 명중 hit 브로드캐스트 수신 대기')
        const event = events[0]!

        expect(event.target).toBe('wall')
        expect(event.shooterId).toBe(roomA.sessionId) // 요구 1 — 벽 명중에도 사수 식별자는 담긴다
        expect(event.victimId).toBeUndefined() // 요구 2 — 대상이 벽이면 피격자 식별자가 없다
      } finally {
        await leaveRoom(roomA)
      }
    },
    20_000,
  )
})
