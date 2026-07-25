import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER } from '@shared/constants'
import { SPAWN_POINTS } from '@shared/sim/spawn'

/**
 * RQ-15 리스폰 — 서버 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus 룸 경계,
 * ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-09** (`harness/evals/golden/track-a-product.jsonl`).
 * GA-09: "given: 플레이어 B가 방금 사망 처리됨 / when: 사망 후 3초가 경과 /
 * then: B는 맵의 스폰 지점 중 하나에 재배치되며 HP가 100으로 초기화된다."
 * `verify` 필드가 이 파일 경로를 정확히 지정한다.
 *
 * **레벨 분리(ADR-0008/ADR-0011)**: "정확히 90틱(=3000ms)째에 무엇이
 * 바뀌는가"라는 경계 로직 자체는 `tests/unit/sim-lifecycle.test.ts`(A계층,
 * 결정론 — 틱 정수만 주입)가 이미 고정했다. 이 파일(B계층)은 그 결정론
 * 로직이 실 Colyseus 30Hz 루프(`GameRoom.startTickLoop`)에 실제로 결합돼
 * 굴러가는지를 실 WebSocket으로 블랙박스 확인한다 — 정밀한 프레임 경계
 * 대신 관대한 실시간 대기(아래 "결정론 메모")를 쓴다(`rq-60-fixed-tickrate
 * .test.ts`의 A/B 레벨 분리와 동일 정신).
 *
 * **결정론 메모(실 3초 대기 — 최후 수단, 팀리드 지시)**: `GameRoom`의 틱
 * 루프는 Colyseus `setSimulationInterval`(실측 `Date.now()` 기반)로 구동돼
 * 테스트 프로세스에서 서버 시간을 앞당길 방법이 없다(그런 훅이 현재
 * 아키텍처에 없다) — 그래서 리스폰 완료(HP 100 복귀) 관측만은 실제로 3초
 * 가까이 기다린다. 다만 "임의 슬립 추측" 안티패턴과는 다르다: (1) 대기는
 * 상태 변화 이벤트 기반(`onStateChange` 폴링, `waitForPlayerCondition`)이지
 * 고정 슬립이 아니고, (2) 상한(`RESPAWN_OBSERVE_TIMEOUT_MS`)이 명시돼 있으며,
 * (3) "3초보다 눈에 띄게 이르게 리스폰되면 안 된다"는 하한도
 * `MIN_RESPAWN_ELAPSED_MS`(2500ms, 스케줄링 지터를 흡수하는 관대한 여유)로
 * 실측 검증한다 — 즉시 리스폰되는 결함을 이 파일이 놓치지 않는다.
 *
 * **가정(coder에게)**: `rq-12-server-hitscan.test.ts`의 가정 1~4와 동일
 * (`Player.hp`·`Player.kills` 필드, `'fire'`/`'move'` payload 형태, 즉시
 * 판정, `DEFAULT_HITBOX`). 이 파일이 추가로 요구하는 것:
 * 1. `GameState.players`의 `x`·`y`·`z`·`hp` 필드가 사망(hp<=0) 후 정확히
 *    `PLAYER.RESPAWN_MS`(3000ms, `RESPAWN_TICKS`=90틱) 경과 시점에 함께
 *    갱신된다 — 위치는 `@shared/sim/spawn`의 `SPAWN_POINTS` 중 하나로,
 *    HP는 `PLAYER.MAX_HP`(100)로.
 * 2. 리스폰 위치 선택은 `@shared/sim/spawn`의 `nextSpawnIndex`(순환
 *    로테이션)로 결정되며, 최초 입장(`onJoin`)도 **같은 로테이션 커서**를
 *    공유한다(그래야 서로 다른 두 플레이어가 겹쳐 스폰하지 않는다 —
 *    아래 "사전조건" 테스트가 이 가정을 직접 확인한다).
 * 3. 사망자 갭 해소(팀리드 지시 D): `handleFire`·`stepPlayerMovement`
 *    양쪽 모두 대상 플레이어(사수/이동 주체)의 `hp<=0`이면 그 요청을
 *    완전히 무시한다(`@shared/sim/lifecycle`의 `canAct` 계약,
 *    `tests/unit/sim-lifecycle.test.ts` 참고) — 시신은 이동하지도, 사격
 *    으로 피해를 입히지도 않는다.
 *
 * **GA-06 재확인(팀리드 지시, `_workspace/RQ-15-16/01_test-writer_red.md`
 * §"GA-06 재확인"에 상세 근거)**: 이 라운드는 `combat-tuning.ts`의
 * `eyeHeightM`을 현실값으로 낮추고(item E) 스폰을 지점별로 분산시킨다
 * (item B). `rq-12-client-hit-claim-rejected.test.ts`(GA-06)는 A가
 * `dirY=1`(수직 위)을 조준해 "기하학적으로 명중 불가능"을 보장하는 방식
 * 인데, 이 방식은 **eyeHeight 값과 무관하게** A와 B의 XZ 좌표가 다르기만
 * 하면 항상 성립한다(레이 방향이 (0,1,0)이면 레이는 A의 XZ 열에서만
 * 움직이고, `intersectHeadSphere`의 판별식이 A·B의 수평 거리 제곱에 비례해
 * 음수가 된다 — 수식은 아래 "GA-06 재확인" 절 참고). 이 파일의 "사전조건"
 * 테스트가 "A·B는 항상 서로 다른 XZ 위치에 스폰된다"를 실측으로 고정하므로,
 * GA-06은 **테스트 파일 수정 없이도** 새 eyeHeight·새 스폰 체계에서 계속
 * 성립한다 — 검증력 저하 없음(기존 단언을 건드리지 않았다).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300
/** RQ-15 리스폰 관측 상한 — 3000ms + 실 서버 스케줄링 지터를 넉넉히 흡수하는 여유. */
const RESPAWN_OBSERVE_TIMEOUT_MS = 8_000
/** "3초보다 눈에 띄게 이르게 리스폰되면 안 된다"는 하한(ms) — RESPAWN_MS(3000)
 * 보다 500ms 관대하게 낮춰 스케줄링 지터로 인한 false-fail을 막으면서도,
 * "즉시 리스폰" 같은 명백한 결함은 여전히 잡는다. */
const MIN_RESPAWN_ELAPSED_MS = 2_500
/** 사망자 이동 무시 관측 창 — RESPAWN_MS(3000ms)보다 충분히 작아 리스폰과 섞이지 않는다. */
const MOVE_IGNORE_OBSERVE_MS = 400
/** 사망자 사격 무시 관측 창 — 위와 동일한 이유로 짧게 잡는다. */
const FIRE_IGNORE_OBSERVE_MS = 400

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
  kills: number
}

function readPlayer(room: Room, sessionId: string): PlayerSnapshot | undefined {
  const state = room.state as {
    players?: {
      get?: (key: string) => { x?: unknown; y?: unknown; z?: unknown; hp?: unknown; kills?: unknown } | undefined
    }
  } | null
  const player = state?.players?.get?.(sessionId)
  if (
    typeof player?.x === 'number' &&
    typeof player?.y === 'number' &&
    typeof player?.z === 'number' &&
    typeof player?.hp === 'number' &&
    typeof player?.kills === 'number'
  ) {
    return { x: player.x, y: player.y, z: player.z, hp: player.hp, kills: player.kills }
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

/** A(shooter)의 눈높이에서 target의 바디 중심을 겨누는 조준 벡터. rq-14
 * 테스트의 `aimAtBody`(A가 원점 고정이라는 특수 가정)와 달리, 이 파일은
 * A·B가 서로 다른 임의 위치에 스폰되므로 두 위치 모두를 인자로 받는
 * 일반형이다. */
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

/**
 * A의 사격으로 B를 사망(HP 0)까지 몰아간다. **부위(헤드/바디) 무관 설계**:
 * 이 헬퍼의 목적은 "정확히 몇 발에 죽는가"가 아니라 "B를 죽여서 리스폰
 * 시나리오를 준비하는 것"이다 — 그 정밀 산술(바디샷 4회=사망)은 이미
 * `sim-combat.test.ts`·`rq-14-death-kill-credit.test.ts`(둘 다 GA-08)가
 * 고정했다. 만약 "매 사격은 정확히 바디 데미지(25)"를 가정하면, A·B의 스폰
 * 위치가 아직 분리되지 않은 상태(이번 라운드 이전 코드)에서는 두 플레이어가
 * 같은 좌표에 겹쳐 있어 조준 벡터가 거의 수직이 되고 헤드샷으로 판정될 수
 * 있어(각도 우연) 이 헬퍼가 RQ-15와 무관한 이유로 타임아웃될 위험이 있다 —
 * 매 사격 후 "hp가 직전 값에서 실제로 줄었는가"만 확인해 부위와 무관하게
 * 강건하게 만든다.
 */
async function killPlayer(
  roomA: Room,
  roomB: Room,
  baselineB: PlayerSnapshot,
  aim: { dirX: number; dirY: number; dirZ: number },
): Promise<PlayerSnapshot> {
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
  if (!atDeath) throw new Error('사망 직후 B 스냅샷 관측 실패')
  expect(atDeath.hp).toBe(0)
  return atDeath
}

describe('RQ-15/GA-09: 사망 후 3초 경과 시 스폰 지점 재배치 + HP 100 초기화', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-15 사전조건(item E 지원 — GA-06 재확인 근거): 두 플레이어가 각각 접속하면 서로 다른 스폰 지점에 위치한다(겹쳐 스폰 없음)',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      // try/finally — 단언 실패·타임아웃으로 중간에 던져도 방을 반드시
      // 떠난다. 정리하지 않으면 같은 룸을 공유하는 이후 it()들이 이 세션의
      // 좀비 플레이어(같은 좌표에 남는 리스크)와 뒤섞여 조준 판정이 엉뚱한
      // 대상에 명중하는 오염을 낳는다(이 파일이 실제로 겪은 문제 — 아래
      // "GA-06 재확인" 절과 무관하게 항상 지켜야 하는 위생 규칙이다).
      try {
        const a = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
        const b = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)

        // 겹쳐 스폰이면 eyeHeightM을 인위적으로 높게 유지해야 했던 이유
        // (item E, combat-tuning.ts 코멘트)가 사라진다 — 이 확인이 그
        // 전제가 실제로 성립함을 보증한다.
        expect(a.x !== b.x || a.z !== b.z).toBe(true)

        const isAKnownSpawnPoint = SPAWN_POINTS.some(
          (point: { x: number; y: number; z: number }) => point.x === a.x && point.y === a.y && point.z === a.z,
        )
        const isBKnownSpawnPoint = SPAWN_POINTS.some(
          (point: { x: number; y: number; z: number }) => point.x === b.x && point.y === b.y && point.z === b.z,
        )
        expect(isAKnownSpawnPoint).toBe(true)
        expect(isBKnownSpawnPoint).toBe(true)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    15_000,
  )

  it(
    'RQ-15/GA-09: A의 바디샷 4회로 B가 사망한 뒤 3초가 경과하면 B는 SPAWN_POINTS 중 하나로 재배치되고 HP가 100으로 초기화된다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        const aim = aimAtBody(baselineA, baselineB)
        const atDeath = await killPlayer(roomA, roomB, baselineB, aim)

        const deathAtMs = Date.now()

        // GA-09 when: "사망 후 3초 경과". 파일 상단 "결정론 메모" 참고 — 실
        // 서버 루프 결합 확인이 목적이라 실제로 기다린다. 정밀한 90틱 경계는
        // sim-lifecycle.test.ts(A계층)가 이미 고정했다.
        const afterRespawn = await waitForPlayerCondition(
          roomB,
          roomB.sessionId,
          (p) => p.hp === PLAYER.MAX_HP,
          'RQ-15: 사망 후 3초 경과 리스폰(HP 100 복귀) 대기',
          RESPAWN_OBSERVE_TIMEOUT_MS,
        )
        const respawnElapsedMs = Date.now() - deathAtMs

        expect(afterRespawn.hp).toBe(PLAYER.MAX_HP)
        // 즉시 리스폰(0초 지연) 같은 결함을 놓치지 않는 실측 하한(파일 상단 참고).
        expect(respawnElapsedMs).toBeGreaterThanOrEqual(MIN_RESPAWN_ELAPSED_MS)

        // "스폰 지점 중 하나"(GA-09 then) — SPAWN_POINTS 멤버십으로 확인한다
        // (정확한 좌표값 자체는 잠정값이라 이 파일이 규정하지 않는다).
        const isKnownSpawnPoint = SPAWN_POINTS.some(
          (point: { x: number; y: number; z: number }) =>
            point.x === afterRespawn.x && point.y === afterRespawn.y && point.z === afterRespawn.z,
        )
        expect(isKnownSpawnPoint).toBe(true)

        // 순환 로테이션(RQ-31 선택 규칙)이 실제로 작동했다는 최소 확인 —
        // 사망 시점 위치(=최초 입장 스폰)와 리스폰 위치가 같은 지점이
        // 아니어야 한다.
        expect(afterRespawn.x !== atDeath.x || afterRespawn.z !== atDeath.z).toBe(true)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )

  it(
    'RQ-15 사망자 갭 해소(팀리드 지시 D): 사망한 플레이어의 이동·사격 입력은 무시된다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)

        const aim = aimAtBody(baselineA, baselineB)
        const atDeath = await killPlayer(roomA, roomB, baselineB, aim)

        // 이동 무시 — 죽은 B가 강한 방향 입력을 보내도 위치가 그대로여야
        // 한다. 관찰 창은 RESPAWN_MS(3000ms)보다 충분히 작게 잡아 리스폰과
        // 섞이지 않는다.
        roomB.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
        await sleep(MOVE_IGNORE_OBSERVE_MS)
        const afterMoveAttempt = readPlayer(roomB, roomB.sessionId)
        expect(afterMoveAttempt?.x).toBe(atDeath.x)
        expect(afterMoveAttempt?.z).toBe(atDeath.z)

        // 사격 무시 — 죽은 B가 A를 정확히 겨눠도(B의 첫 발사라 rate-limit에
        // 걸리지 않는다) A는 전혀 피해를 입지 않아야 한다.
        const deadShooterAim = aimAtBody(atDeath, baselineA)
        roomB.send('fire', deadShooterAim)
        await sleep(FIRE_IGNORE_OBSERVE_MS)
        const afterFireAttempt = readPlayer(roomA, roomA.sessionId)
        expect(afterFireAttempt?.hp).toBe(baselineA.hp)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    15_000,
  )
})
