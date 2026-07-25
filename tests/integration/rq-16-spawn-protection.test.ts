import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER } from '@shared/constants'

/**
 * RQ-16 스폰 보호 — 서버 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus 룸 경계,
 * ADR-0011: 서버 판정 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-10** (`harness/evals/golden/track-a-product.jsonl`).
 * GA-10: "given: 플레이어 B가 방금 스폰(리스폰)되어 스폰 보호가 시작됨 /
 * when: (1) 보호 중 다른 플레이어의 공격을 받는 경우, (2) 보호 중인 B가
 * 먼저 사격하는 경우, (3) 사격 없이 3초가 자연 경과하는 경우를 각각 확인 /
 * then: (1) 3초 이내의 피해는 무효화된다. (2) B가 사격하면 그 즉시 보호가
 * 해제되어 이후 피해는 정상 적용된다. (3) 사격이 없어도 3초가 지나면 보호는
 * 자연히 해제된다." `verify` 필드가 이 파일 경로를 정확히 지정한다.
 *
 * GA-10의 given은 "스폰(리스폰)"으로 특정하지만, RQ-16 전문("플레이어가
 * 스폰되면...")과 팀리드 지시(item C)는 최초 입장·리스폰 **양쪽 다** 스폰
 * 보호를 요구한다 — 이 파일의 마지막 describe 블록이 최초 입장 케이스를
 * 별도로(GA-10이 아니라 RQ-16 전문 매핑으로) 보강한다.
 *
 * **레벨 분리(ADR-0008/ADR-0011)**: "정확히 90틱째에 보호가 풀리는가"라는
 * 경계 로직 자체는 `tests/unit/sim-lifecycle.test.ts`(A계층, 결정론)가 이미
 * 고정했다. 이 파일(B계층)은 그 로직이 실 Colyseus 룸에 실제로 결합돼
 * 굴러가는지를 블랙박스로 확인한다.
 *
 * **결정론 메모(실 3초 대기 — 최후 수단)**: `rq-15-respawn-timer.test.ts`
 * 상단과 동일한 이유(서버 시간을 앞당길 훅이 없다)로, (2)(3) 사례를 만들기
 * 위해 리스폰(3초)까지 먼저 실제로 기다린다. (3) 자연 만료 확인은 추가로
 * `SPAWN_PROTECTION_MS` 이상을 더 기다린다. 모든 대기는 `waitForPlayerCondition`
 * (상태 변화 이벤트 기반, 명시적 상한)이거나 길이가 명시된 고정 대기다.
 *
 * **가정(coder에게)**: `rq-15-respawn-timer.test.ts`의 가정과 동일 기반 위에,
 * 이 파일이 추가로 요구하는 것:
 * 1. 스폰(최초 입장·리스폰 공통) 시점에 해당 세션의 보호 타이머가
 *    시작된다(`@shared/sim/lifecycle`의 `isSpawnProtected`,
 *    `spawnedAtTick`을 그 시점의 `state.tick`으로 설정).
 * 2. `handleFire`가 피해를 적용하기 직전, 피해자가 보호 중이면
 *    `applyDamageWithProtection`으로 피해를 무효화한다(GA-10 (1)).
 * 3. `handleFire`가 사수의 사격 요청을 실제로 처리(canAct·rate-limit 통과)
 *    할 때마다, **명중 여부와 무관하게** 그 사수 자신의 `firedSinceSpawn`을
 *    true로 갱신한다(GA-10 (2) — RQ-16 "사격하면"은 발사 행위 자체를
 *    가리킨다, 아래 (2) 테스트가 정조준이 아닌 빗나가는 방향의 자기 사격만
 *    으로도 보호가 풀리는지 확인해 이 가정을 직접 검증한다).
 * 4. 자연 만료(GA-10 (3))는 별도 처리 없이 `isSpawnProtected`가 경과 시간만
 *    으로 false를 반환하는 것으로 충분하다 — 만료 시점에 별도 이벤트·필드
 *    갱신이 필요하지 않다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300
/** RQ-15 리스폰 관측 상한 — rq-15 파일과 동일 근거. */
const RESPAWN_OBSERVE_TIMEOUT_MS = 8_000
/** "피해 무효화"를 확인하는 관찰 창 — 여러 상태 갱신을 거치기 충분한 여유
 * (다른 통합 테스트의 NO_CHANGE_OBSERVATION_MS와 동일 패턴). */
const NO_DAMAGE_OBSERVE_MS = 500
/** GA-10 (1) — 보호 지속을 "3초 내내"로 뒷받침하기 위해 보호 창 막바지
 * (SPAWN_PROTECTION_MS=3000ms에 근접하되 넘지 않는 지점)에서도 재확인한다. */
const LATE_IN_WINDOW_MS = 2_700
/** 자기 사격이 서버에 반영될 시간을 준다(로컬 WS라 짧아도 충분하나 여유를 둔다). */
const SELF_FIRE_SETTLE_MS = 300
/** GA-10 (3) — SPAWN_PROTECTION_MS(3000ms)를 확실히 넘기는 여유(스케줄링
 * 지터 흡수, rq-60-overflow-warning.test.ts의 BLOCK_MS 여유 산정과 동일 정신). */
const PROTECTION_EXPIRE_WAIT_MS = 3_400

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

/** A(shooter)의 눈높이에서 target의 바디 중심을 겨누는 조준 벡터(`rq-15
 * -respawn-timer.test.ts`의 동명 헬퍼와 동일 — 이 파일도 A·B가 서로 다른
 * 임의 위치에 스폰되므로 두 위치 모두를 인자로 받는 일반형이 필요하다). */
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
 * 위치와 무관하게 안전하다. GA-10 (2)에서 "명중 여부와 무관하게 사격
 * 행위만으로 보호가 풀린다"를 증명하는 데 정확히 필요한 성질이다. */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

/** B를 A의 사격으로 사망시키고, 리스폰(HP 100 복귀)까지 기다린다. GA-10의
 * given("B가 방금 스폰(리스폰)되어 스폰 보호가 시작됨")을 만드는 공통 절차 —
 * (1)(2)(3) 세 케이스가 각각 독립된 방(같은 룸, 새 세션)에서 이 절차를 거쳐
 * "막 리스폰된" 상태에서 출발한다.
 *
 * **부위(헤드/바디) 무관 설계**: 이 헬퍼의 목적은 "정확히 몇 발에 죽는가"가
 * 아니라 "B를 죽여서 리스폰·보호 시나리오를 준비하는 것"이다 — 그 정밀
 * 산술(바디샷 4회=사망)은 이미 `sim-combat.test.ts`(GA-08)·
 * `rq-14-death-kill-credit.test.ts`(GA-08)가 고정했다. 만약 이 헬퍼가
 * "매 사격은 정확히 바디 데미지(25)"를 가정하면, A·B의 스폰 위치가 아직
 * 분리되지 않은 상태(이번 라운드 이전 코드)에서는 두 플레이어가 같은 좌표에
 * 겹쳐 있어 조준 벡터가 거의 수직이 되고 헤드샷으로 판정될 수 있어(각도
 * 우연) 이 헬퍼가 RQ-15/16과 무관한 이유로 타임아웃될 위험이 있다 — 매
 * 사격 후 "hp가 직전 값에서 실제로 줄었는가"만 확인해 부위와 무관하게
 * 강건하게 만든다. */
async function killAndWaitForRespawn(
  roomA: Room,
  roomB: Room,
): Promise<{ a: PlayerSnapshot; bAfterRespawn: PlayerSnapshot }> {
  const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
  const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)
  expect(baselineB.hp).toBe(PLAYER.MAX_HP)

  const aim = aimAtBody(baselineA, baselineB)
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
  expect(previousHp).toBe(0)

  const bAfterRespawn = await waitForPlayerCondition(
    roomB,
    roomB.sessionId,
    (p) => p.hp === PLAYER.MAX_HP,
    'RQ-15: 사망 후 리스폰(HP 100 복귀, GA-10 given 준비) 대기',
    RESPAWN_OBSERVE_TIMEOUT_MS,
  )

  return { a: baselineA, bAfterRespawn }
}

describe('RQ-16/GA-10: 스폰 보호 — 피해 무효화·자기 사격 즉시 해제·자연 만료', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-16/GA-10 (1): 스폰 보호 중 다른 플레이어의 공격을 받아도 3초 이내의 피해는 무효화된다(HP 불변)',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      // try/finally — 단언 실패·타임아웃으로 중간에 던져도 방을 반드시
      // 떠난다(정리하지 않으면 좀비 플레이어가 이후 it()의 조준 판정을
      // 오염시킨다 — rq-15-respawn-timer.test.ts와 동일한 위생 규칙).
      try {
        const { a, bAfterRespawn } = await killAndWaitForRespawn(roomA, roomB)
        expect(bAfterRespawn.hp).toBe(PLAYER.MAX_HP)

        const aimAtRespawnedB = aimAtBody(a, bAfterRespawn)

        // 리스폰 직후 즉시 공격 — 보호가 막 시작된 시점.
        roomA.send('fire', aimAtRespawnedB)
        await sleep(NO_DAMAGE_OBSERVE_MS)
        const afterFirstAttack = readPlayer(roomB, roomB.sessionId)
        expect(afterFirstAttack?.hp).toBe(PLAYER.MAX_HP)

        // 보호 창 막바지(3000ms에 근접하되 넘지 않음)에도 여전히 무효화된다
        // (GA-10 "3초 이내의 피해는 무효화된다"가 순간이 아니라 구간 전체를
        // 가리킨다는 것을 확인 — rate-limit(150ms)은 이미 충분히 지났다).
        await sleep(LATE_IN_WINDOW_MS - NO_DAMAGE_OBSERVE_MS)
        roomA.send('fire', aimAtRespawnedB)
        await sleep(NO_DAMAGE_OBSERVE_MS)
        const afterSecondAttack = readPlayer(roomB, roomB.sessionId)
        expect(afterSecondAttack?.hp).toBe(PLAYER.MAX_HP)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )

  it(
    'RQ-16/GA-10 (2): 보호 중인 B가 먼저 사격하면(명중 여부 무관) 그 즉시 보호가 해제되어 이후 피해는 정상 적용된다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      try {
        const { a, bAfterRespawn } = await killAndWaitForRespawn(roomA, roomB)

        // B가 스스로 사격한다 — UP_MISS_AIM은 기하학적으로 항상 빗나가므로,
        // 이후 A의 공격이 통한다면 그것은 "B의 사격이 명중했기 때문"이
        // 아니라 "사격 행위 자체가 보호를 해제했기 때문"임이 분명해진다
        // (RQ-16 원문 "보호 중인 플레이어가 사격하면"의 직역 — 명중을
        // 요구하지 않는다).
        roomB.send('fire', UP_MISS_AIM)
        await sleep(SELF_FIRE_SETTLE_MS)

        // 데미지 "정상 적용"의 확인 기준은 정확한 부위별 수치(그건
        // GA-07/08의 몫)가 아니라 "0보다 큰 피해가 실제로 들어갔다"는 것
        // 그 자체다 — aimAtBody가 헤드/바디 어느 쪽에 맞을지는 리스폰
        // 좌표(잠정값)의 구체 기하에 좌우될 수 있어 이 파일이 정확한
        // 부위를 규정하지 않는다(killAndWaitForRespawn 코멘트와 동일한
        // 이유).
        const aimAtRespawnedB = aimAtBody(a, bAfterRespawn)
        roomA.send('fire', aimAtRespawnedB)
        const afterAttack = await waitForPlayerCondition(
          roomB,
          roomB.sessionId,
          (p) => p.hp < PLAYER.MAX_HP,
          'B 자기 사격 후 보호 해제 확인 — A의 공격으로 HP 감소 대기',
          HP_TIMEOUT_MS,
        )
        expect(afterAttack.hp).toBeLessThan(PLAYER.MAX_HP)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )

  it(
    'RQ-16/GA-10 (3): 사격 없이 스폰 보호 시간(3초)이 자연 경과하면 보호가 저절로 해제되어 이후 피해는 정상 적용된다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      try {
        const { a, bAfterRespawn } = await killAndWaitForRespawn(roomA, roomB)

        // B는 아무 것도 하지 않는다(사격 없음) — 보호 시간
        // (SPAWN_PROTECTION_MS=3000ms)을 확실히 넘기는 여유를 두고 기다린다.
        await sleep(PROTECTION_EXPIRE_WAIT_MS)

        // 위 (2)와 동일한 이유로 정확한 부위별 수치가 아니라 "피해가 정상
        // 적용됐는가"(HP 감소)만 확인한다.
        const aimAtRespawnedB = aimAtBody(a, bAfterRespawn)
        roomA.send('fire', aimAtRespawnedB)
        const afterAttack = await waitForPlayerCondition(
          roomB,
          roomB.sessionId,
          (p) => p.hp < PLAYER.MAX_HP,
          '자연 만료 후 A의 공격으로 HP 감소 대기',
          HP_TIMEOUT_MS,
        )
        expect(afterAttack.hp).toBeLessThan(PLAYER.MAX_HP)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )
})

describe('RQ-16(전문 — GA-10 보강): 최초 입장 스폰도 동일하게 보호된다(팀리드 지시 C)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-16: 방금 최초 입장한 플레이어도(리스폰 이력 없음) 스폰 보호로 피해가 무효화된다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      try {
        const a = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
        const b = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)
        expect(b.hp).toBe(PLAYER.MAX_HP)

        const aim = aimAtBody(a, b)
        roomA.send('fire', aim)
        await sleep(NO_DAMAGE_OBSERVE_MS)

        const afterAttack = readPlayer(roomB, roomB.sessionId)
        expect(afterAttack?.hp).toBe(PLAYER.MAX_HP)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    15_000,
  )
})
