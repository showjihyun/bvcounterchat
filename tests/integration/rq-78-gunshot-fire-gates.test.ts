import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { CAPACITY, PLAYER, WEAPON } from '@shared/constants'
import { escapeSafeZone, releaseSpawnProtectionAndEscape, type SafeZoneEscapeSeam } from '../support/safe-zone'

/**
 * RQ-78 발사음 — GA-115: 서버가 사격을 수락하는 **모든 게이트 중 어느
 * 하나라도** 걸리면 발사 이벤트가 **0건**이고 HP·탄약도 변하지 않는다.
 * 서버 판정 로직(ADR-0011: Colyseus 룸 경계, Red-first 영역).
 *
 * EARS(RQ-78, v2.12) · ADR-0014 결정 6 실측(`GameRoom.ts:686-728`, 팀리드
 * 지시 그대로 재확인): `firedSinceSpawn` 갱신(`:732`) 이전의 조기 return이
 * **여섯**이다. ⚠️ **이것이 `handleFire` 전체의 조기 return 개수는 아니다**
 * — `firedSinceSpawn`·`consumeRound`·`broadcast('gunshot', ...)` **뒤**에
 * 퇴화 조준 가드(`dirMagnitude`가 0에 가까우면 return, `:788`)가 하나 더
 * 있다. 그 일곱 번째는 발사음 브로드캐스트 **뒤**라 이 파일의 관측 대상
 * (발사 이벤트 발생 여부)과 무관하다 — 개수를 "여섯이 전부"로 못박지
 * 않는다(ADR-0014 결정 6, PR #91 리뷰 blocker가 정확히 이 실수를 잡았다).
 *
 * | 줄 | 게이트 | 이 파일의 절 |
 * |---|---|---|
 * | `:688` | `!shooterPlayer` — 관전자(RQ-41) | "게이트 1" |
 * | `:689` | `!canAct(hp)` — 사망(RQ-15) | "게이트 2" |
 * | `:693` | `!canFire(...)` — 발사 간격 | "게이트 3" |
 * | `:713` | `!canFireAmmo(...)` — 탄약·재장전(RQ-11) | "게이트 4" |
 * | `:716` | `!shooterState` — 이동 상태 부재 | "게이트 5" |
 * | `:728` | `isWithinSafeZone(shooterState)` — Safe Zone(RQ-31) | "게이트 6" |
 *
 * 매핑된 골든: **GA-115** — given: 사수가 세이프존 안, **또는** 사망 상태
 * (RQ-15 `canAct` 거부), **또는** 탄창이 비었거나 재장전 중 / when: 사격 /
 * then: 발사 이벤트가 **발생하지 않는다**. HP·탄약도 변하지 않는다.
 * ⚠️ **골든 given이 명시한 세 갈래(세이프존·사망·탄약)에 더해, ADR-0014
 * 결정 6이 "개수를 적지 않는다"로 못박은 나머지 두 게이트(관전자·이동
 * 상태 부재)도 이 파일이 함께 고정한다** — 원장 24cr-3이 "관전자가 게이트
 * 열거 어디에도 없다"를 이월 항목으로 남겼고, 팀리드가 이 라운드에
 * "게이트마다 하나씩" 덮으라고 명시했다.
 *
 * ## 와이어 계약 — `rq-78-gunshot-fire-event.test.ts` 상단과 동일
 *
 * `broadcast('gunshot', { shooterId, position })`. 이 파일은 그 이벤트가
 * **0건**임을 관측한다(수신 안 함 자체가 관측 대상이라 payload 형태는
 * 다루지 않는다 — `GunshotEventPayload`는 참고용으로만 선언한다).
 *
 * ## 공허화(vacuity) 방지 설계
 *
 * "0건"만 반복하면 **발사 이벤트 배선 자체가 통째로 죽어 있어도** 이
 * 파일의 모든 단언이 우연히 통과한다(`rq-31-safe-zone-no-firing.test.ts`가
 * 이미 겪은 함정과 같은 형태). 그래서 각 게이트마다 **그 게이트만 없으면
 * 발사가 성립한다는 양성 대조**를 함께 둔다:
 * - 게이트 1(관전자)·게이트 2(사망): **다른(막히지 않은) 플레이어**가 같은
 *   시나리오 안에서 정상적으로 gunshot을 만들어낸다는 것을 확인한다 —
 *   "이 세션만 막혔다"와 "이벤트 파이프라인 자체가 죽었다"를 가른다.
 * - 게이트 5(이동 상태 부재): 화이트박스로 지운 `moveStates`를
 *   `escapeSafeZone`으로 **복원**(+세이프존 탈출 겸함)한 뒤 같은 세션이
 *   정상적으로 gunshot을 만들어낸다.
 * - 게이트 3(발사 간격)·게이트 4(재장전)·게이트 6(세이프존): 게이트가
 *   **시간 경과 또는 위치 이동으로 자연히 풀리므로**, 같은 세션이 그 뒤에
 *   정상적으로 gunshot을 만들어내는 것을 같은 `it()` 안에서 이어서 확인한다.
 *
 * ## 결정론 메모
 *
 * 실 WebSocket(ADR-0008 허용 예외)에 의존. "0건"은 고정 관찰창
 * (`BLOCKED_OBSERVE_MS`)으로 확인하고, 양성 신호는 전부
 * `withTimeout()` 상한이 있는 이벤트 대기다. 재장전(2초)·리스폰(3초)
 * 관측만 실제로 기다린다(서버 시간을 앞당길 훅이 없다 — 기존
 * `rq-11-reload-lockout.test.ts`/`rq-15-respawn-timer.test.ts`와 동일한
 * 이유).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const GUNSHOT_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** 화이트박스 텔레포트/부기 조작 후 스키마 동기화 정착 대기. */
const SETTLE_MS = 200
/** "발사 이벤트가 0건"을 확인하는 고정 관찰창(`rq-31-safe-zone-no-firing
 * .test.ts`의 `NO_FIRE_OBSERVE_MS`와 동일 근거). */
const BLOCKED_OBSERVE_MS = 500
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300
/** 게이트 3(발사 간격) 전용 — rate-limit(150ms) **안쪽**에서 즉시 재사격해
 * 드롭을 트리거한다. */
const IMMEDIATE_RETRY_MS = 20
/** 재장전(WEAPON.RELOAD_MS=2000ms) 완료를 확실히 넘기는 여유(스케줄링
 * 지터 흡수, 기존 파일들과 동일 산정). */
const RELOAD_TOTAL_WAIT_MS = WEAPON.RELOAD_MS + 400

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

interface PlayerSnapshot {
  x: number
  y: number
  z: number
  hp: number
}

function readPlayer(room: Room, sessionId: string): PlayerSnapshot | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { x?: unknown; y?: unknown; z?: unknown; hp?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (
    typeof player?.x === 'number' &&
    typeof player?.y === 'number' &&
    typeof player?.z === 'number' &&
    typeof player?.hp === 'number'
  ) {
    return { x: player.x, y: player.y, z: player.z, hp: player.hp }
  }
  return undefined
}

function waitForPlayerCondition(
  room: Room,
  sessionId: string,
  predicate: (p: PlayerSnapshot) => boolean,
  label: string,
  timeoutMs = HP_TIMEOUT_MS,
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

interface MembershipLike {
  get?: (key: string) => unknown
  size?: number
}
interface RoomStateLike {
  players?: MembershipLike
  spectators?: MembershipLike
}

/** `rq-03-spectator-overflow.test.ts`의 동명 헬퍼와 동일 근거. */
function waitForOwnMembership(room: Room): Promise<'players' | 'spectators'> {
  return withTimeout(
    new Promise<'players' | 'spectators'>((resolve) => {
      const tryResolve = (): void => {
        const state = room.state as RoomStateLike | null
        if (state?.players?.get?.(room.sessionId) !== undefined) {
          resolve('players')
          return
        }
        if (state?.spectators?.get?.(room.sessionId) !== undefined) {
          resolve('spectators')
        }
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    `sessionId=${room.sessionId} 소속 컬렉션(players/spectators) 관측`,
  )
}

interface GunshotEventPayload {
  shooterId: string
  position: { x: number; y: number; z: number }
}

function watchGunshot(room: Room): { received: GunshotEventPayload[] } {
  const watcher = { received: [] as GunshotEventPayload[] }
  room.onMessage<GunshotEventPayload>('gunshot', (event) => {
    watcher.received.push(event)
  })
  return watcher
}

function waitForGunshotCount(
  room: Room,
  watcher: { received: GunshotEventPayload[] },
  count: number,
  timeoutMs: number,
  label: string,
): Promise<GunshotEventPayload[]> {
  if (watcher.received.length >= count) return Promise.resolve(watcher.received)
  return withTimeout(
    new Promise<GunshotEventPayload[]>((resolve) => {
      room.onMessage<GunshotEventPayload>('gunshot', () => {
        if (watcher.received.length >= count) resolve(watcher.received)
      })
    }),
    timeoutMs,
    label,
  )
}

/** `rq-31-safe-zone-no-firing.test.ts`의 `FireGateTestSeam`과 동일한
 * 화이트박스 계약에 게이트 5(이동 상태 부재) 검증에 필요한 `moveStates`
 * 직접 조작 권한을 더한 것(`SafeZoneEscapeSeam`이 이미 그 필드를 갖는다). */
interface FireGateTestSeam extends SafeZoneEscapeSeam {
  magazines: Map<string, number>
}

function getServerRoom(room: Room): FireGateTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as FireGateTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-78 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

function readAmmo(seam: FireGateTestSeam, sessionId: string): number {
  return seam.magazines.get(sessionId) ?? WEAPON.MAGAZINE
}

/** `rq-15`/`rq-11` 계열과 동일한 일반형 조준 헬퍼. */
function aimAtBody(shooter: { x: number; z: number }, target: { x: number; z: number }): { dirX: number; dirY: number; dirZ: number } {
  const bodyCenterM = (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = bodyCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

/** B의 사격으로 A를 사망(HP 0)까지 몰아간다(`rq-15-corpse-bullet-passthrough
 * .test.ts`의 `killPlayer`와 동일한 설계 — 부위 무관, 매 사격 후 HP 변화만
 * 확인). */
async function killPlayer(shooter: Room, victim: Room, baselineHp: number, aim: { dirX: number; dirY: number; dirZ: number }): Promise<void> {
  let previousHp = baselineHp
  const MAX_KILL_SHOTS = 5
  for (let shot = 1; shot <= MAX_KILL_SHOTS && previousHp > 0; shot += 1) {
    shooter.send('fire', aim)
    const afterShot = await waitForPlayerCondition(victim, victim.sessionId, (p) => p.hp !== previousHp, `${shot}번째 사격 후 HP 변화 대기(직전 HP=${previousHp})`)
    previousHp = afterShot.hp
    if (previousHp > 0) await sleep(BETWEEN_SHOTS_MS)
  }
  const atDeath = readPlayer(victim, victim.sessionId)
  if (!atDeath) throw new Error('killPlayer: 사망 직후 스냅샷 관측 실패')
  expect(atDeath.hp).toBe(0)
}

describe('RQ-78/GA-115: 모든 게이트 중 하나라도 걸리면 발사 이벤트는 0건이고 HP·탄약도 불변이다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    `게이트 1(관전자, RQ-41 · GameRoom.ts:688): 정원(${CAPACITY.PLAYERS}명)이 찬 뒤 입장한 관전자가 사격해도 gunshot이 0건이다 — 정상 플레이어는 같은 상황에서 정상적으로 gunshot을 만든다(공허화 방지)`,
    async () => {
      const playerRooms: Room[] = []
      let spectatorRoom: Room | undefined

      try {
        for (let i = 0; i < CAPACITY.PLAYERS; i += 1) {
          const room = await joinGame(newClient(server))
          playerRooms.push(room)
          expect(await waitForOwnMembership(room)).toBe('players')
        }
        spectatorRoom = await joinGame(newClient(server))
        expect(await waitForOwnMembership(spectatorRoom)).toBe('spectators')

        const spectatorWatcher = watchGunshot(spectatorRoom)
        spectatorRoom.send('fire', UP_MISS_AIM)
        await sleep(BLOCKED_OBSERVE_MS)
        expect(spectatorWatcher.received.length).toBe(0)

        // 공허화 방지 — 좌석에 앉은(관전자가 아닌) 플레이어는 같은 서버·같은
        // 시점에 정상적으로 gunshot을 만들어낸다. "관전자만 막혔다"임을
        // 증명해, 이벤트 파이프라인 자체가 죽어 있어서 위 0건이 나온 것이
        // 아님을 배제한다.
        const seatedPlayer = playerRooms[0]!
        const baseline = await waitForPlayerCondition(seatedPlayer, seatedPlayer.sessionId, () => true, '좌석 플레이어 초기 스냅샷')
        const seam = getServerRoom(seatedPlayer)
        escapeSafeZone(seam, seatedPlayer.sessionId, baseline)
        await sleep(SETTLE_MS)

        const seatedWatcher = watchGunshot(seatedPlayer)
        seatedPlayer.send('fire', UP_MISS_AIM)
        await waitForGunshotCount(seatedPlayer, seatedWatcher, 1, GUNSHOT_TIMEOUT_MS, '좌석 플레이어의 gunshot 수신 대기(양성 대조군)')
        expect(seatedWatcher.received[0]!.shooterId).toBe(seatedPlayer.sessionId)
      } finally {
        const all = spectatorRoom ? [...playerRooms, spectatorRoom] : playerRooms
        await Promise.allSettled(all.map((room) => leaveRoom(room)))
      }
    },
    60_000,
  )

  it(
    '게이트 2(사망, RQ-15 canAct · GameRoom.ts:689): 시신 상태의 사수가 사격해도 gunshot이 0건이고 탄약도 불변이다 — 살아 있는 다른 플레이어는 같은 상황에서 정상적으로 gunshot을 만든다(공허화 방지)',
    async () => {
      const roomA = await joinGame(newClient(server)) // 곧 시신이 될 사수
      const roomB = await joinGame(newClient(server)) // A를 죽이는 플레이어(RQ-17 — 아군 판정 없음)

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷')
        const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷')
        expect(baselineA.hp).toBe(PLAYER.MAX_HP)

        const seam = getServerRoom(roomA)
        const escapedA = releaseSpawnProtectionAndEscape(seam, roomA.sessionId, baselineA)
        const escapedB = escapeSafeZone(seam, roomB.sessionId, baselineB)
        await sleep(SETTLE_MS)

        const ammoBeforeDeath = readAmmo(seam, roomA.sessionId)

        await killPlayer(roomB, roomA, baselineA.hp, aimAtBody(escapedB, escapedA))

        // 핵심 단언 — 시신(A)이 사격을 시도해도 gunshot은 0건, 탄약도 불변.
        const corpseWatcher = watchGunshot(roomA)
        roomA.send('fire', UP_MISS_AIM)
        await sleep(BLOCKED_OBSERVE_MS)
        expect(corpseWatcher.received.length).toBe(0)
        expect(readAmmo(seam, roomA.sessionId)).toBe(ammoBeforeDeath)

        // 공허화 방지 — 살아 있는 B는 같은 시점에 정상적으로 gunshot을
        // 만들어낸다(B는 이미 세이프존을 탈출해 있다, rate-limit 여유만 둔다).
        await sleep(BETWEEN_SHOTS_MS)
        const bystanderWatcher = watchGunshot(roomB)
        roomB.send('fire', UP_MISS_AIM)
        await waitForGunshotCount(roomB, bystanderWatcher, 1, GUNSHOT_TIMEOUT_MS, 'B의 gunshot 수신 대기(양성 대조군)')
        expect(bystanderWatcher.received[0]!.shooterId).toBe(roomB.sessionId)
      } finally {
        await Promise.allSettled([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    30_000,
  )

  it(
    '게이트 3(발사 간격, GameRoom.ts:693): rate-limit(150ms) 안에서 즉시 재사격하면 두 번째 요청은 gunshot을 만들지 않는다 — 간격이 지난 뒤에는 다시 정상 발사된다',
    async () => {
      const roomA = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷')
        const seam = getServerRoom(roomA)
        escapeSafeZone(seam, roomA.sessionId, baselineA)
        await sleep(SETTLE_MS)

        const watcher = watchGunshot(roomA)

        // 1발째 — 정상 발사(이 자체가 이후 단언의 기준선이자 공허화 방지
        // 양성 대조군이다).
        roomA.send('fire', UP_MISS_AIM)
        await waitForGunshotCount(roomA, watcher, 1, GUNSHOT_TIMEOUT_MS, '1발째 gunshot 수신 대기')
        expect(watcher.received.length).toBe(1)

        // 2발째 — rate-limit(150ms) 안쪽에서 즉시 재사격. 드롭돼야 한다.
        roomA.send('fire', UP_MISS_AIM)
        await sleep(Math.max(IMMEDIATE_RETRY_MS, 0))
        await sleep(BLOCKED_OBSERVE_MS)
        expect(watcher.received.length).toBe(1) // 여전히 1건 — 2발째는 무시됐다

        // 3발째 — rate-limit을 명백히 넘긴 뒤 재사격하면 다시 정상 발사된다.
        await sleep(BETWEEN_SHOTS_MS)
        roomA.send('fire', UP_MISS_AIM)
        await waitForGunshotCount(roomA, watcher, 2, GUNSHOT_TIMEOUT_MS, '3발째(간격 경과 후) gunshot 수신 대기')
        expect(watcher.received.length).toBe(2)
      } finally {
        await leaveRoom(roomA)
      }
    },
    20_000,
  )

  it(
    '게이트 4(탄약·재장전, RQ-11 canFireAmmo · GameRoom.ts:713): 재장전 요청 직후(2초 이내) 사격은 gunshot을 만들지 않는다 — 2초 경과 후에는 다시 정상 발사된다',
    async () => {
      const roomA = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷')
        const seam = getServerRoom(roomA)
        escapeSafeZone(seam, roomA.sessionId, baselineA)
        await sleep(SETTLE_MS)

        roomA.send('reload', {})
        await sleep(SETTLE_MS)
        const reloadStartedAtMs = Date.now()

        const watcher = watchGunshot(roomA)
        roomA.send('fire', UP_MISS_AIM)
        await sleep(BLOCKED_OBSERVE_MS)
        expect(watcher.received.length).toBe(0) // 재장전 중 — gunshot 없음
        expect(readAmmo(seam, roomA.sessionId)).toBe(WEAPON.MAGAZINE) // 탄약도 불변

        const elapsed = Date.now() - reloadStartedAtMs
        await sleep(Math.max(0, RELOAD_TOTAL_WAIT_MS - elapsed))

        // 재장전 완료 후에는 다시 정상 발사된다(공허화 방지 양성 대조군).
        roomA.send('fire', UP_MISS_AIM)
        await waitForGunshotCount(roomA, watcher, 1, GUNSHOT_TIMEOUT_MS, '재장전 완료 후 gunshot 수신 대기')
        expect(watcher.received.length).toBe(1)
      } finally {
        await leaveRoom(roomA)
      }
    },
    20_000,
  )

  it(
    '게이트 5(이동 상태 부재, GameRoom.ts:716): moveStates 항목이 없는 사수는 사격해도 gunshot이 0건이다 — 상태를 복원하면 같은 세션이 다시 정상 발사된다',
    async () => {
      const roomA = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷')
        const seam = getServerRoom(roomA)

        // 화이트박스로 이동 상태 자체를 지운다 — `!shooterState`(:702)가
        // 안전존 판정(:714) *이전에* 걸리므로 A의 실제 위치(세이프존 내부)는
        // 이 케이스와 무관하다.
        seam.moveStates.delete(roomA.sessionId)

        const watcher = watchGunshot(roomA)
        roomA.send('fire', UP_MISS_AIM)
        await sleep(BLOCKED_OBSERVE_MS)
        expect(watcher.received.length).toBe(0)

        // 복원(+세이프존 탈출 겸함) — 같은 세션이 다시 정상 발사된다.
        escapeSafeZone(seam, roomA.sessionId, baselineA)
        await sleep(SETTLE_MS)
        roomA.send('fire', UP_MISS_AIM)
        await waitForGunshotCount(roomA, watcher, 1, GUNSHOT_TIMEOUT_MS, '이동 상태 복원 후 gunshot 수신 대기')
        expect(watcher.received.length).toBe(1)
      } finally {
        await leaveRoom(roomA)
      }
    },
    20_000,
  )

  it(
    '게이트 6(Safe Zone, RQ-31 · GameRoom.ts:728): 스폰 지점(세이프존) 안에서 사격해도 gunshot이 0건이고 탄약도 불변이다 — 세이프존을 벗어나면 즉시 정상 발사된다',
    async () => {
      const roomA = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷')
        const seam = getServerRoom(roomA)

        const watcher = watchGunshot(roomA)
        roomA.send('fire', UP_MISS_AIM) // A는 자신의 스폰 지점(세이프존) 그대로다
        await sleep(BLOCKED_OBSERVE_MS)
        expect(watcher.received.length).toBe(0)
        expect(readAmmo(seam, roomA.sessionId)).toBe(WEAPON.MAGAZINE)

        escapeSafeZone(seam, roomA.sessionId, baselineA)
        await sleep(SETTLE_MS)
        roomA.send('fire', UP_MISS_AIM)
        await waitForGunshotCount(roomA, watcher, 1, GUNSHOT_TIMEOUT_MS, '세이프존 이탈 후 gunshot 수신 대기')
        expect(watcher.received.length).toBe(1)
        expect(readAmmo(seam, roomA.sessionId)).toBe(WEAPON.MAGAZINE - 1)
      } finally {
        await leaveRoom(roomA)
      }
    },
    20_000,
  )
})
