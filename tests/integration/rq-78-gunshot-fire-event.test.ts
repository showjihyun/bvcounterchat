import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { WEAPON } from '@shared/constants'
import type { SpreadTuning } from '@shared/config/combat-tuning'
import { escapeSafeZone, type SafeZoneEscapeSeam } from '../support/safe-zone'

/**
 * RQ-78 발사음 — 발사 이벤트 브로드캐스트(GA-114) + 세 부작용의 원자성
 * (GA-116). 서버 판정 로직(ADR-0011: Colyseus 룸 경계, Red-first 영역).
 *
 * EARS 전문(`harness/specs/requirements.md` RQ-78): "사격(RQ-10)이 서버에서
 * **실제로 처리되면** — **서버가 사격을 수락하는 모든 게이트**(사망 상태
 * RQ-15 · 발사 간격 · 탄약과 재장전 상태 RQ-11 · 세이프존 RQ-31)를 통과하면
 * — 시스템은 **명중 여부와 무관하게** 발사음을 재생해야 한다. 발사 사실은
 * **서버가 전원에게 이벤트로 전달**하며, 이벤트에는 **사수의 식별자와 발사
 * 시점의 위치**가 담긴다."
 *
 * ADR-0014 결정 6: "그 시점은 새로 정의하지 않는다 — `handleFire`가 사격을
 * 수락하는 모든 게이트를 통과한 직후 `firedSinceSpawn`(RQ-16)을 세우고
 * 탄약을 소모하는 그 자리이며, ... 발사음은 그 사실의 **세 번째 소비자**다."
 *
 * 매핑된 골든: **GA-114**(`_workspace/RQ-78-gunshot/golden.json`) —
 * given: 사수가 세이프존 밖·탄약 있음·재장전 아님, 조준선이 벽·플레이어
 * 어느 것도 향하지 않음 / when: 사격 / then: 서버가 발사 이벤트를 전원에게
 * 보낸다. `hit`은 발생하지 않는다.
 * **GA-116** — given: 여섯 게이트를 모두 통과한 사격 / when: 처리 /
 * then: 발사 이벤트·`firedSinceSpawn=true`·탄약 1발 소모가 **같은 사건**으로
 * 일어난다(셋 중 하나만 일어나는 경로가 없다).
 *
 * ## 여섯 게이트(팀리드 실측, `GameRoom.ts:663-709`) — 이 파일의 시나리오는
 * 전부 통과시킨다
 *
 * `:674` 관전자(RQ-41) · `:675` 사망(RQ-15 `canAct`) · `:679` 발사 간격 ·
 * `:699` 탄약·재장전(RQ-11) · `:702` 이동 상태 부재 · `:714` 세이프존(RQ-31).
 * 이 파일의 사수는 매번 새로 접속한 플레이어(탄창 가득·재장전 아님·사망
 * 아님·`moveStates` 존재·발사 간격 미소진)이고 Safe Zone만 화이트박스
 * 탈출로 벗어난다 — 나머지 다섯 게이트는 자연히 통과한다.
 *
 * ## 이 파일이 확정하는 와이어 계약(test-writer 지정 — coder가 이대로
 * 구현하면 Green이 된다)
 *
 * - **브로드캐스트 이름**: `'gunshot'`. 기존 `'fire'`(클라→서버 요청)·
 *   `'hit'`(명중 이벤트)와 겹치지 않는 새 이름 — 클라이언트는 이 세 이벤트를
 *   각자 다른 리스너로 받는다.
 * - **payload 형태**(`GameRoom.ts` 서버 사본, `HitEvent`가 이미 세운 "서버가
 *   자신의 사본을 둔다" 선례와 동일 — `@client`를 import하지 않는다):
 *   ```ts
 *   interface GunshotEvent {
 *     shooterId: string
 *     /** 발사 시점 사수의 월드 좌표(발 위치, `moveStates`의 x·y·z를 그대로
 *      * — RQ-61: 재계산·클라 payload 재사용 금지, 서버가 이미 게이트 판정에
 *      * 쓴 `shooterState`를 그대로 옮긴다). 조준 방향(`spreadDirection`)이나
 *      * 눈높이 레이 원점(`ray.origin`)이 아니다 — "발사 시점의 위치"는
 *      * 사수가 서 있는 곳이지 총구가 겨눈 방향이 아니다. *\/
 *     position: { x: number; y: number; z: number }
 *   }
 *   ```
 * - **호출 지점**: `handleFire`의 여섯 번째 게이트(Safe Zone, `:714`) 통과
 *   **직후** — `firedSinceSpawn.set(shooterId, true)`(:718)과
 *   `consumeRound`(:724-728) **둘 다 실행된 뒤**, 명중 판정(조준 스프레드·
 *   레이캐스트·`hit` 브로드캐스트) **이전**. 순서 자체(`firedSinceSpawn` vs
 *   `consumeRound` vs `broadcast('gunshot', ...)` 셋의 상대 순서)는 이
 *   파일이 규정하지 않는다 — 셋 다 같은 동기 함수 호출 안에서 일어나
 *   Node 단일 스레드상 클라이언트가 이벤트를 받는 시점에는 이미 셋 다
 *   커밋돼 있다는 것만 이 파일이 요구한다(GA-116 단언이 그 순서 무관성에
 *   기댄다).
 * - **명중 여부와 무관**: 벽·플레이어 어느 쪽도 맞히지 못해도(`UP_MISS_AIM`)
 *   발사 이벤트는 나간다 — `hit` 브로드캐스트의 존재 여부와 완전히 독립.
 *
 * ## 좌표 설계
 *
 * `tests/support/safe-zone.ts`의 `escapeSafeZone`(반경-방사 탈출, 여러
 * 파일이 이미 검증)로 사수 A만 Safe Zone 밖으로 옮긴다. B·C는 옮기지 않는다
 * — `UP_MISS_AIM`(수직 위)으로 쏘므로 B·C의 위치는 결과에 영향을 주지
 * 않는다(플레이어를 맞힐 대상이 될 근거가 없다 — 아래 REV의 확률적 요소는
 * **벽**이지 플레이어가 아니다). GA-116은 사수 하나만 필요해 별도 `it()`으로
 * 분리한다(관측 대상이 다르다 — GA-114는 세 클라이언트의 payload 일치,
 * GA-116은 사수 자신의 화이트박스 부기 셋).
 *
 * ## REV(2026-08-21, CI 플레이키 진단·수정 — PR #91 CI run 32441143343,
 * team-lead 지시)
 *
 * **증상**: `expect(hitA.received.length).toBe(0)`이 간헐적으로 실패(로컬
 * 재현 3회 중 1회, `npx vitest run` 반복 실행)했다. GA-114의 given이
 * "조준선이 벽·플레이어 어느 것도 향하지 않는다"인데, `UP_MISS_AIM`이 그
 * 전제를 **결정론적으로** 성립시키지 못했다는 뜻이다.
 *
 * **진단(node 프로브, `raycastHitbox`·`findClosestWallHit`·`applySpread`를
 * 실제 값으로 20~200만 회 반복 실행해 확인, 사수는 이 파일과 동일하게
 * 스폰 인덱스 0 escape 좌표 `(28, 0, 0)`)**:
 * 1. **플레이어 명중은 기하학적으로 불가능**(팀리드 분석과 일치, 확률 0/2,000,000
 *    — B·C(스폰 인덱스 1·2)까지 수평 거리가 12~20m인데, 명중 판정에 필요한
 *    수직 판별식이 그 거리에서 거의 항상 깊은 음수라 실패한다).
 * 2. **범인은 벽이다.** `@shared/sim/walls`의 벽 4개는 **무한 높이 기둥**
 *    (`minY`/`maxY` 없음, 파일 자체가 "2D(XZ) 전용"이라고 명시 — 실제 맵
 *    지오메트리가 나올 때까지의 잠정 모델, RQ-30 이전 단계의 알려진 단순화).
 *    `applySpread`는 `spreadTuningOverride`를 안 주면 **룸마다 새로
 *    난수 발급되는 salt**(`spreadSalt = Math.floor(Math.random()*2**32)`,
 *    `GameRoom.ts`)로 기본 콘(0.5°)만큼 방향을 흩뿌린다 — 그 결과
 *    `dir.x`·`dir.z`가 정확히 0이 아니라 아주 작은(하지만 0이 아닌) 값이
 *    되고, 레이가 충분히 먼 t(수백~수천, 즉 명중 높이가 수백~수천 미터가
 *    되는 지점)까지 나아가면 그 미세한 수평 성분만으로도 XZ 평면상
 *    WALL_EAST 등의 슬랩을 "관통"할 수 있다 — 벽에 높이 제한이 없으므로
 *    이 우연한 관통도 유효한 `hit`(`target:'wall'`)이 된다. **실측 확률:
 *    이 사수 좌표에서 200,000회 중 36,661회(18.331%)**가 벽 명중으로
 *    떨어졌다(예: seed=1358723117 → `dir≈(-0.00499, 0.99999, -0.00107)`,
 *    `point=(16, 2406.2, -2.58)` — WALL_EAST를 **높이 2406m**에서 "맞힌다").
 *    18%는 국지적 CI 관측("3회 중 1회")과 이항분포로 정합적이다
 *    (`P(≥1 실패 | 3회, p=0.183) ≈ 45%`).
 * 3. **A의 좌표(스폰 인덱스 0, escape 후 `(28,0,0)`)가 이 확률을 특히 높인다**
 *    — `z=0`이 WALL_EAST(`z∈[-5,5]`)의 중심과 정확히 정렬돼, 수평 성분이
 *    아주 작아도(음수 x 방향) 그 z 구간 안에 들어가기 쉽다.
 *
 * **결론 — 구현 결함이 아니다.** `raycastHitbox`·`findClosestWallHit`·
 * `applySpread` 전부 각자의 계약(플레이어 판정·벽 XZ 슬랩·콘 편차)대로
 * 정확히 동작했다. "벽은 무한 높이"라는 **기존에 이미 문서화된, RQ-78과
 * 무관한 단순화**가 이 테스트가 골랐던 "수직 위 = 항상 안전한 빗나감"이라는
 * **전제를 깬 것**이다(`UP_MISS_AIM`을 쓰는 다른 파일들은 플레이어 HP만
 * 관찰하고 `hit` 채널 전체를 무차별 관찰하지 않아 이 문제를 겪지 않았다).
 * **수정**: 이 파일만 화이트박스로 `spreadTuningOverride = {coneRadiusRad:
 * 0, ...}`를 강제해 스프레드 자체를 끈다 — `dir`이 정확히 `(0,1,0)`이 되면
 * `dir.x===dir.z===0`이라 `intersectWallXZ`의 평행축 분기가 즉시
 * `o.x`(=28)가 네 벽의 `[minX,maxX]`(전부 `|x|<=16`) **밖**임을 확인하고
 * 무조건 `undefined`를 반환한다 — 확률이 아니라 **기하학적으로** 0%가
 * 된다(위 진단의 "플레이어 명중 불가능" 결론과 같은 성격의 확정적 배제).
 * `spreadTuningOverride`는 `rq-15-corpse-bullet-passthrough.test.ts`가 이미
 * 확립한 화이트박스 필드다(그린필드 아님) — 이 파일이 처음 도입하는
 * 계약이 아니다. **단언을 좁히지 않았다** — `hitA.received.length===0`은
 * 그대로다, 단언이 재는 대상이 아니라 **테스트가 그 전제를 성립시키는
 * 방식**만 고쳤다.
 *
 * ## 결정론 메모
 *
 * 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008 허용 예외, 기존
 * `rq-57-59-hit-event-identity.test.ts`와 동일). 모든 대기에 `withTimeout()`
 * 상한을 건다. 난수·`Date.now()` 직접 호출 없음(사격 자체는 실행하지만 시각
 * 비교를 하지 않는다).
 *
 * ## 스펙 질문 — 없음
 *
 * RQ-78·ADR-0014 결정 6이 이벤트 시점·payload 구성 요소(식별자·위치)를
 * 이미 못박았다. 필드명(`position` vs `point`)·이벤트 이름(`'gunshot'`)은
 * 이 문면이 정하지 않는 구현 세부라 test-writer가 계약으로 확정한다(위
 * "와이어 계약" 절 — coder 재량이 아니라 이 파일이 강제하는 계약이다,
 * `HitEvent`가 이미 세운 선례와 동일한 권한).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const GUNSHOT_TIMEOUT_MS = 5_000
/** 화이트박스 텔레포트 후 스키마 동기화 정착 대기. */
const TELEPORT_SETTLE_MS = 200
/** "hit이 안 났다"를 확인하는 고정 관찰창(공허화 방지 — 명중 이벤트
 * 부재를 조용한 무한 대기가 아니라 명시적 창으로 확인한다). */
const NO_HIT_OBSERVE_MS = 500

/** GA-06/GA-08 계열이 이미 확립한, 위치와 무관하게 항상 빗나가는 방향
 * (`rq-11-reload-lockout.test.ts`의 `UP_MISS_AIM`과 동일). */
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
    GUNSHOT_TIMEOUT_MS,
    `초기 스냅샷(sessionId=${sessionId}) 관측`,
  )
}

/** 서버 'gunshot' 브로드캐스트 payload를 블랙박스로 관측하기 위한 로컬
 * 타입 — 위 "와이어 계약" 절이 정본이다. `@client`의 타입을 임포트하지
 * 않는다(`rq-57-59-hit-event-identity.test.ts`의 `HitEventPayload`와 동일한
 * "레벨 분리" 근거). */
interface GunshotEventPayload {
  shooterId: string
  position: { x: number; y: number; z: number }
}

interface HitEventPayload {
  point: { x: number; y: number; z: number }
  normal: { x: number; y: number; z: number }
  target: 'wall' | 'player'
  shooterId?: string
  victimId?: string
}

function watchGunshot(room: Room): { received: GunshotEventPayload[] } {
  const watcher = { received: [] as GunshotEventPayload[] }
  room.onMessage<GunshotEventPayload>('gunshot', (event) => {
    watcher.received.push(event)
  })
  return watcher
}

function watchHit(room: Room): { received: HitEventPayload[] } {
  const watcher = { received: [] as HitEventPayload[] }
  room.onMessage<HitEventPayload>('hit', (event) => {
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

/** `rq-31-safe-zone-no-firing.test.ts`의 `FireGateTestSeam`과 동일한 근거 —
 * `magazines`·`firedSinceSpawn`은 기존 private 필드다(그린필드 아님).
 * `spreadTuningOverride`도 그린필드가 아니다 — `rq-15-corpse-bullet-
 * passthrough.test.ts`가 이미 이 정확한 이름으로 화이트박스 결합하는
 * 기존 필드다(위 REV 참고). */
interface FireEventTestSeam extends SafeZoneEscapeSeam {
  magazines: Map<string, number>
  spreadTuningOverride?: SpreadTuning
}

function getServerRoom(room: Room): FireEventTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as FireEventTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-78 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** `handleFire`가 미소모 상태를 표현하는 것과 동일한 규약
 * (`rq-31-safe-zone-no-firing.test.ts`의 `readAmmo`와 동일). */
function readAmmo(seam: FireEventTestSeam, sessionId: string): number {
  return seam.magazines.get(sessionId) ?? WEAPON.MAGAZINE
}

describe('RQ-78/GA-114: 여섯 게이트를 모두 통과하면 서버가 전원에게 발사 이벤트를 보낸다(명중 여부 무관)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'GA-114: A가 세이프존 밖에서 아무것도 맞히지 않는 방향으로 사격하면 A·B·C 전원이 같은 gunshot 이벤트를 받고, shooterId·position이 담기며, hit은 발생하지 않는다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수
      const roomB = await joinGame(newClient(server)) // 제3자 1 — 관찰만
      const roomC = await joinGame(newClient(server)) // 제3자 2 — 관찰만

      try {
        const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
        await waitForDefinedPlayer(roomB, roomB.sessionId)
        await waitForDefinedPlayer(roomC, roomC.sessionId)

        // 여섯 게이트 중 세이프존만 화이트박스로 벗어난다(위 "여섯 게이트"
        // 절 — 나머지 다섯은 신규 접속 상태에서 자연히 통과한다).
        const seam = getServerRoom(roomA)
        const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
        // REV(위 docblock) — 스프레드를 완전히 꺼서 UP_MISS_AIM이 정확히
        // (0,1,0)으로 판정되게 한다. 룸마다 새로 발급되는 난수 salt가 만드는
        // 미세한 수평 편차가 무한 높이 벽 기둥을 우연히 관통해 이 given
        // ("조준선이 벽·플레이어 어느 것도 향하지 않는다")을 확률적으로
        // 깨는 것을 막는다 — A의 x(=28)가 네 벽의 [minX,maxX](|x|<=16) 밖이므로
        // dir.x=dir.z=0이면 벽 명중이 기하학적으로 불가능해진다.
        seam.spreadTuningOverride = { coneRadiusRad: 0, movingMultiplier: 1, airborneMultiplier: 1 }
        await sleep(TELEPORT_SETTLE_MS)

        const gunshotA = watchGunshot(roomA)
        const gunshotB = watchGunshot(roomB)
        const gunshotC = watchGunshot(roomC)
        const hitA = watchHit(roomA)

        roomA.send('fire', UP_MISS_AIM)

        const [eventsA, eventsB, eventsC] = await Promise.all([
          waitForGunshotCount(roomA, gunshotA, 1, GUNSHOT_TIMEOUT_MS, 'A(사수) gunshot 수신 대기'),
          waitForGunshotCount(roomB, gunshotB, 1, GUNSHOT_TIMEOUT_MS, 'B(제3자) gunshot 수신 대기'),
          waitForGunshotCount(roomC, gunshotC, 1, GUNSHOT_TIMEOUT_MS, 'C(제3자) gunshot 수신 대기'),
        ])

        const eventA = eventsA[0]!
        const eventB = eventsB[0]!
        const eventC = eventsC[0]!

        // 세 클라이언트가 받은 것은 같은 발사 사건이다(동일 payload).
        expect(eventB).toEqual(eventA)
        expect(eventC).toEqual(eventA)

        // payload 자체에 사수 식별자와 발사 시점 위치가 담긴다(RQ-78 원문).
        expect(eventA.shooterId).toBe(roomA.sessionId)
        expect(typeof eventA.position.x).toBe('number')
        expect(typeof eventA.position.y).toBe('number')
        expect(typeof eventA.position.z).toBe('number')
        expect(Number.isFinite(eventA.position.x)).toBe(true)
        expect(Number.isFinite(eventA.position.y)).toBe(true)
        expect(Number.isFinite(eventA.position.z)).toBe(true)
        // 위치는 사수 자신의 실제 좌표다(탈출 후 위치, A는 이후 움직이지
        // 않았다) — 재계산·클라 payload 재사용이 아니라 서버가 게이트
        // 판정에 쓴 실제 값 그대로임을 확인한다.
        expect(eventA.position.x).toBeCloseTo(escapedA.x, 5)
        expect(eventA.position.z).toBeCloseTo(escapedA.z, 5)

        // 명중 여부와 무관 — UP_MISS_AIM은 벽·플레이어 어느 쪽도 맞히지
        // 않으므로 hit은 발생하지 않는다(고정 관찰창).
        await sleep(NO_HIT_OBSERVE_MS)
        expect(hitA.received.length).toBe(0)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB), leaveRoom(roomC)])
      }
    },
    30_000,
  )
})

describe('RQ-78/GA-116: 발사 이벤트·firedSinceSpawn·탄약 소모가 같은 사건으로 함께 일어난다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'GA-116: 여섯 게이트를 통과한 사격 1회는 gunshot 이벤트 수신 시점에 firedSinceSpawn=true·탄약 1발 소모가 이미 함께 반영돼 있다',
    async () => {
      const roomA = await joinGame(newClient(server))

      try {
        const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
        const seam = getServerRoom(roomA)

        // 사전 상태 확인 — 아직 쏘지 않았으므로 firedSinceSpawn은 미설정
        // (RQ-16 기본값, `isSpawnProtected` 계약상 false로 취급됨)이고
        // 탄창은 가득 차 있다.
        expect(seam.firedSinceSpawn.get(roomA.sessionId) ?? false).toBe(false)
        expect(readAmmo(seam, roomA.sessionId)).toBe(WEAPON.MAGAZINE)

        escapeSafeZone(seam, roomA.sessionId, baselineA)
        await sleep(TELEPORT_SETTLE_MS)

        const gunshotA = watchGunshot(roomA)
        roomA.send('fire', UP_MISS_AIM)

        await waitForGunshotCount(roomA, gunshotA, 1, GUNSHOT_TIMEOUT_MS, 'A의 gunshot 수신 대기')

        // gunshot을 받은 시점에는 이미 같은 동기 호출 안에서 커밋된
        // firedSinceSpawn·탄약 소모를 화이트박스로 즉시(추가 대기 없이)
        // 관측할 수 있다 — 단일 Node 프로세스, 레이스 없음.
        expect(seam.firedSinceSpawn.get(roomA.sessionId)).toBe(true)
        expect(readAmmo(seam, roomA.sessionId)).toBe(WEAPON.MAGAZINE - 1)
      } finally {
        await leaveRoom(roomA)
      }
    },
    20_000,
  )
})
