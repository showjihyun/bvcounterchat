import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'

/**
 * RQ-11 재장전(요청 시 또는 탄창 0 시 2초, 재장전 중 사격 불가) — 서버
 * 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정
 * 로직 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-04** (`harness/evals/golden/track-a-product.jsonl`).
 * GA-04: "given: 플레이어가 재장전을 요청함(또는 탄창이 0) / when: 재장전
 * 진행 중(2초 이내) 사격 입력이 발생 / then: 사격이 무시되고 발사되지
 * 않으며, 2초 경과 후에는 정상적으로 사격 가능하다." `verify` 필드가 이
 * 파일 경로를 정확히 지정한다.
 *
 * GA-04의 given은 "요청함(또는 탄창이 0)"으로 **두 개의 독립된 갈래**를
 * 병기한다 — 아래 두 `describe` 블록이 각각을 별도로 검증한다: (a) 탄창이
 * 비지 않았어도 명시적 `'reload'` 요청만으로 잠금이 걸리는가, (b) 탄창이
 * 0이 되는 순간 요청 없이도 자동으로 같은 잠금이 걸리는가. 두 갈래 모두
 * "재장전 진행 중 사격 무시 → 2초 경과 후 정상 사격"이라는 동일한 then을
 * 공유하지만, 트리거 경로가 다르므로 각각 독립적으로 고정하지 않으면 한쪽
 * 경로만 구현되고 다른 쪽이 빠지는 결함을 놓칠 수 있다.
 *
 * **레벨 분리(ADR-0008/ADR-0011)**: "정확히 60틱(2000ms)째에 재장전이
 * 완료되는가" 같은 경계 로직 자체는 `tests/unit/sim-ammo.test.ts`(A계층,
 * 결정론)가 고정한다. 이 파일(B계층)은 그 로직이 실 Colyseus 룸에 실제로
 * 결합돼 굴러가는지를 블랙박스로 확인한다.
 *
 * **결정론 메모(실 대기 — 최후 수단)**: `rq-10-magazine-capacity.test.ts`
 * 상단과 동일한 이유(서버 시간을 앞당길 훅이 없다)로 재장전 완료(2초)
 * 관측만은 실제로 기다린다. 모든 대기는 상한이 있거나 고정 길이다.
 *
 * **가정(coder에게)**: `tests/unit/sim-ammo.test.ts` 상단 그린필드 계약
 * (`@shared/sim/ammo`)과 "가정(coder에게 — GameRoom 배선)" 절 1~6이 이
 * 파일의 전제다. 이 파일이 추가로 요구하는 것:
 * 1. 새 `'reload'` 메시지(payload 불요 — 빈 객체 `{}`)를 서버가 수신하면,
 *    사수 자신의 `reloadStartedAtTick`을 현재 tick으로 설정한다 — 탄창이
 *    가득 차 있지 않아도(마모 상태) 이 메시지만으로 잠금이 시작된다(GA-04
 *    given의 "요청함" 갈래, (a) 테스트가 직접 확인).
 * 2. `canFireAmmo`가 false를 반환하는 동안(위 잠금 포함, 탄창 소진 자동
 *    잠금 포함) `handleFire`는 요청을 완전히 무시한다 — 레이도 쏘지 않고
 *    피해도 발생하지 않는다.
 *
 * **공허화(vacuity) 방지 설계(팀리드 지시)**: `rq-10-magazine-capacity
 * .test.ts`와 동일한 원칙 — "무시된다"는 음성 단언 앞뒤에 **같은 조준
 * 벡터**로 실제 명중(HP 감소)을 확인하는 양성 대조군을 둔다. 무명중 확인
 * 직전 사격과의 간격은 rate-limit(150ms)을 명백히 초과하는
 * `IMMEDIATE_RETRY_DELAY_MS`(300ms)로 둬 rate-limit이 원인일 여지를
 * 배제한다. 각 `it()`의 명중(피해) 횟수는 최대 2회(재장전 전 1회 + 재장전
 * 후 1회)로 제한해, 최악의 경우(2회 모두 헤드샷, 50+50=100)에도 "무명중"을
 * 확인하는 시점(1회 명중 후, HP≥50)에는 대상이 반드시 생존해 있음을
 * 보장한다 — 시신 제외 필터(`canAct` 히트 후보 가드)가 "무명중"의 원인이
 * 되는 혼선을 피한다.
 *
 * **제외**: 클라 탄약 HUD(RQ-53), 재장전 애니메이션·사운드, 리스폰 시
 * 탄창 초기화(스펙 침묵).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
/** 연속 사격 사이의 여유 — ADR-0005 rate-limit(150ms)을 명백히 초과한다. */
const BETWEEN_SHOTS_MS = 300
/** 재장전 시작 직후 즉시 재사격을 시도하는 간격 — rate-limit(150ms)을
 * 명백히 초과해, 이후 "명중하지 않음"이 rate-limit이 아니라 재장전 잠금
 * 때문임을 보장한다. */
const IMMEDIATE_RETRY_DELAY_MS = 300
/** "명중하지 않는다"를 확인하는 관찰 창. */
const BLOCKED_OBSERVE_MS = 400
/** B의 최초 입장 스폰 보호를 스스로 해제하는 사격이 반영될 시간. */
const SELF_FIRE_SETTLE_MS = 300
/** 명시적 `'reload'` 메시지가 서버에 반영될 시간(로컬 WS라 짧아도 충분하나
 * 여유를 둔다). */
const RELOAD_REQUEST_SETTLE_MS = 200
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
 * (`rq-15`·`rq-16`·`rq-14`·`rq-10`과 동일한 일반형). */
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
 * 않는다. */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

describe('RQ-11/GA-04 (a): 명시적 재장전 요청 — 탄창이 남아 있어도 요청만으로 잠기고, 2초 후 정상 사격', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-11/GA-04 (a): 탄창이 아직 남은 상태에서 재장전을 요청하면 진행 중(2초 이내) 사격은 무시되고, 2초 경과 후에는 같은 조준으로 다시 명중한다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        roomB.send('fire', UP_MISS_AIM) // 자신의 최초 입장 스폰 보호를 즉시 해제(RQ-16)
        await sleep(SELF_FIRE_SETTLE_MS)

        const aim = aimAtBody(baselineA, baselineB)

        // 양성 대조군 1(공허화 방지) — 재장전을 요청하기 전, 이 조준
        // 벡터가 실제로 명중함을 먼저 고정한다(탄창 10 → 9, 아직 가득 차
        // 있지 않지만 소진과는 거리가 멀다).
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

        await sleep(BETWEEN_SHOTS_MS)

        // GA-04 given (a) — 탄창이 남아 있는데도(9/10) 명시적으로 재장전을
        // 요청한다.
        roomA.send('reload', {})
        await sleep(RELOAD_REQUEST_SETTLE_MS)
        const reloadStartedAtMs = Date.now()

        // 핵심 관찰 1(GA-04 when/then 앞부분) — 재장전 진행 중(2초 이내)
        // 사격 입력은 무시된다. 탄창에 실탄이 남아 있는데도(9발) 잠기는
        // 것이 이 갈래의 핵심 — rate-limit은 IMMEDIATE_RETRY_DELAY_MS로
        // 이미 배제했다.
        await sleep(IMMEDIATE_RETRY_DELAY_MS)
        roomA.send('fire', aim)
        await sleep(BLOCKED_OBSERVE_MS)
        const afterLockedAttempt = readPlayer(roomB, roomB.sessionId)
        expect(afterLockedAttempt?.hp).toBe(hpAfterFirstShot)

        // 재장전 완료(2초)까지 남은 시간을 마저 기다린다.
        const elapsedSinceReloadStart = Date.now() - reloadStartedAtMs
        const remainingWaitMs = Math.max(0, RELOAD_TOTAL_WAIT_MS - elapsedSinceReloadStart)
        await sleep(remainingWaitMs)

        // 핵심 관찰 2(GA-04 then 뒷부분) — 2초 경과 후에는 정상적으로
        // 사격 가능하다.
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

describe('RQ-11/GA-04 (b): 탄창이 0이 되면 요청 없이도 자동으로 재장전이 시작되고, 동일하게 잠기고 풀린다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-11/GA-04 (b): 탄창을 모두 소진하면(요청 없이) 재장전이 자동 시작되어 진행 중(2초 이내) 사격은 무시되고, 2초 경과 후에는 같은 조준으로 다시 명중한다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      try {
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        roomB.send('fire', UP_MISS_AIM) // 자신의 최초 입장 스폰 보호를 즉시 해제(RQ-16)
        await sleep(SELF_FIRE_SETTLE_MS)

        const aim = aimAtBody(baselineA, baselineB)

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

        // 남은 9발은 명중해도 대상이 죽지 않도록(공허화 방지 설계 — 파일
        // 상단 참고) 항상 빗나가는 방향으로 소모한다. 이 9발 + 위 1발 =
        // 정확히 WEAPON.MAGAZINE(10)발 — 요청 없이 탄창이 0이 된다.
        for (let shot = 1; shot <= WEAPON.MAGAZINE - 1; shot += 1) {
          roomA.send('fire', UP_MISS_AIM)
          await sleep(BETWEEN_SHOTS_MS)
        }

        const reloadStartedAtMs = Date.now()

        // 핵심 관찰 1(GA-04 given (b) — 탄창 0 갈래) — 요청 메시지를 전혀
        // 보내지 않았는데도, 탄창이 빈 직후 같은 조준으로 즉시 재사격하면
        // 명중하지 않는다(자동 재장전 잠금). rate-limit은
        // IMMEDIATE_RETRY_DELAY_MS로 이미 배제했다.
        await sleep(IMMEDIATE_RETRY_DELAY_MS)
        roomA.send('fire', aim)
        await sleep(BLOCKED_OBSERVE_MS)
        const afterEmptyAttempt = readPlayer(roomB, roomB.sessionId)
        expect(afterEmptyAttempt?.hp).toBe(hpAfterFirstShot)

        // 재장전 완료(2초)까지 남은 시간을 마저 기다린다.
        const elapsedSinceReloadStart = Date.now() - reloadStartedAtMs
        const remainingWaitMs = Math.max(0, RELOAD_TOTAL_WAIT_MS - elapsedSinceReloadStart)
        await sleep(remainingWaitMs)

        // 핵심 관찰 2(GA-04 then 뒷부분) — 2초 경과 후에는 정상적으로
        // 사격 가능하다.
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
