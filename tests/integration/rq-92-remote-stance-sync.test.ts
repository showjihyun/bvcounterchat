import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'

/**
 * RQ-92 v2.4 — 자세(mode)의 서버 확정·와이어 동기화(원장 24az) — 서버 권위
 * (RQ-61) 통합 테스트 (ADR-0008: Colyseus 룸 경계, ADR-0011: `src/shared`
 * 스키마 + 서버 판정 로직은 Red-first 영역).
 *
 * 매핑된 골든 케이스: 직접 매핑된 GA는 없다(GA-72~75는 이 값을 **소비하는**
 * 클라이언트 쪽 계약이다 — `tests/unit/rq-92-remote-mesh-height.test.ts`
 * (GA-72)·`tests/unit/rq-56-nameplate-target.test.ts`(GA-73·74)·
 * `tests/unit/rq-63-interpolation.test.ts`(GA-75) 참고). 이 파일은 그
 * 계약들이 전제하는 **와이어 프로토콜 확장 자체**(RQ-92 v2.4 본문: "자세는
 * 서버가 확정해 동기화한다")를 검증한다 — `grounded` 필드의 선례(원장
 * 21a-2 최초 확정 → RQ-22가 파생 전제를 깸 → 원장 25a-4가 스키마에 값으로
 * 실음)를 그대로 따른다.
 *
 * **레벨 판단(`grounded` 선례와 동일 구조, `rq-22-box-jump.test.ts` "레벨
 * 판단" 절 참고)**: "원격 플레이어가 화면에서 자세를 따라간다"는 두
 * 조각이다. ① **서버가 각 플레이어 자신의 최근 입력(`mode`)을 공개
 * 스키마에 그대로 싣는가** — `src/shared`(스키마) + 서버 판정 로직이라
 * ADR-0011상 Red-first, **이 파일이 담당**. ② **클라이언트
 * (`gameStore.ts`/`connection.ts`/`PlayerMeshes.tsx`/`nameplateTarget.ts`
 * 호출부)가 그 필드를 실제로 읽어 렌더·이름표에 반영하는가** — `src/client`
 * 배선이지만, 이번 라운드는 스펙 신설(RQ-92 v2.4)이라 **team-lead 지시로
 * 전부 Red-first로 간다** — 그 쪽 계약은 위에 나열한 클라 단위 테스트
 * 파일들이 각각 담당한다(순수 함수 경계까지만 — 렌더 배선 자체는 ADR-0008
 * §6 면제 대상, 각 파일 docblock 참고). 이 파일은 ①만 다룬다.
 *
 * **가정(coder에게 — `grounded` 필드와 동일한 위치·관례)**:
 * `Player`(`@shared/schema/GameState`)에 `@type('string') mode:
 * 'run' | 'walk' | 'crouch' = 'run'` 필드가 추가된다(기본값은
 * `IDLE_MOVE_INPUT.mode`와 동일 — 아직 'move'를 한 번도 안 보낸 상태의
 * 안전한 기본값). 서버의 30Hz 틱 루프(`GameRoom.stepPlayerMovement`)가
 * `player.grounded = next.grounded`를 쓰는 바로 그 자리(`GameRoom.ts`
 * 1258행 부근)에서 `player.mode = input.mode`도 함께 쓴다 — `input`은 이미
 * 그 지점에 있는 `this.pendingInputs.get(sessionId) ?? IDLE_MOVE_INPUT`
 * 변수이므로 새로 조달할 값이 없다(`grounded`가 `next.grounded`를 쓰듯
 * `mode`는 `input.mode`를 쓴다 — 물리 시뮬레이션 결과가 아니라 입력 자체를
 * 그대로 반영한다는 점만 다르다).
 *
 * **`grounded`와 다른 점 — 사망자도 자세를 유지한다는 규정은 없다**: 이
 * 파일은 사망(canAct=false) 분기의 `mode` 동작을 규정하지 않는다 —
 * RQ-92 v2.4 원문·GA-72~75 어디에도 시신의 자세가 언급되지 않는다(시신은
 * 애초에 렌더 대상에서 빠지지도 않는다 — RQ-15가 그 문제를 다룬다). 스펙에
 * 없는 행동을 테스트화하지 않는다(CLAUDE.md 금지 1항).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한을 걸고, 값 변화는
 * `onStateChange` 기반으로 "직전 값과 달라질 때까지" 폴링한다(RQ-60 매 틱
 * `tick` 갱신이 무관한 `onStateChange` 발화를 계속 만들기 때문 — `rq-20
 * -movement-authority.test.ts`의 `waitForPositionChange`와 동일 근거).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const MODE_TIMEOUT_MS = 5_000

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

/** 룸 state에서 지정한 세션의 공개 자세 필드를 읽는다(가정). 필드가 아직
 * 없거나 patch가 아직 도착하지 않았으면 undefined. */
function readMode(room: Room, sessionId: string): string | undefined {
  const state = room.state as {
    players?: { get?: (key: string) => { mode?: unknown } | undefined }
  } | null
  const player = state?.players?.get?.(sessionId)
  return typeof player?.mode === 'string' ? player.mode : undefined
}

function waitForDefinedMode(room: Room, sessionId: string): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve) => {
      const tryResolve = (): void => {
        const current = readMode(room, sessionId)
        if (current !== undefined) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    MODE_TIMEOUT_MS,
    `초기 mode 필드 관측(sessionId=${sessionId})`,
  )
}

/** `previous`와 값이 달라진 mode가 관측될 때까지 기다린다(RQ-60 매 틱
 * `tick` 갱신이 무관한 `onStateChange`를 계속 발화시키므로 "다음 한 번"만
 * 신뢰하면 안 된다 — `rq-20-movement-authority.test.ts`의
 * `waitForPositionChange`와 동일 근거). */
function waitForModeChange(room: Room, sessionId: string, previous: string, label: string): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve) => {
      const tryResolve = (): void => {
        const current = readMode(room, sessionId)
        if (current !== undefined && current !== previous) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    MODE_TIMEOUT_MS,
    label,
  )
}

describe('RQ-92 v2.4 — 자세(mode)가 공개 스키마에 서버 확정값으로 동기화된다(원장 24az)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    "최초 접속 시 mode 필드가 'run'(선 자세)이다 — IDLE_MOVE_INPUT과 동일한 안전 기본값",
    async () => {
      const room = await joinGame(newClient(server))
      try {
        const initialMode = await waitForDefinedMode(room, room.sessionId)
        expect(initialMode).toBe('run')
      } finally {
        await leaveRoom(room)
      }
    },
    20_000,
  )

  it(
    "'move' 메시지로 mode:'crouch'를 보내면 공개 스키마의 mode가 'crouch'로 바뀐다",
    async () => {
      const room = await joinGame(newClient(server))
      try {
        const initialMode = await waitForDefinedMode(room, room.sessionId)
        expect(initialMode).toBe('run')

        room.send('move', { dirX: 0, dirZ: 0, mode: 'crouch', jump: false })
        const afterCrouch = await waitForModeChange(room, room.sessionId, initialMode, "mode='crouch' 반영 대기")
        expect(afterCrouch).toBe('crouch')

        // 다시 선 자세로 — 왕복이 실제로 서버 판정(고정된 초기값이 아님)임을 확인.
        room.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
        const afterStand = await waitForModeChange(room, room.sessionId, afterCrouch, "mode='run' 복귀 반영 대기")
        expect(afterStand).toBe('run')
      } finally {
        await leaveRoom(room)
      }
    },
    20_000,
  )

  it(
    '두 플레이어가 각자 다른 자세를 보내면 서로 독립적으로 동기화된다 — 한쪽이 앉아도 다른 쪽 mode는 영향받지 않는다(GA-74가 전제하는 "각 후보 자신의 mode")',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))
      try {
        await waitForDefinedMode(roomA, roomA.sessionId)
        const initialB = await waitForDefinedMode(roomA, roomB.sessionId) // A의 스냅샷에서 B를 관측
        expect(initialB).toBe('run')

        roomA.send('move', { dirX: 0, dirZ: 0, mode: 'crouch', jump: false })
        const afterA = await waitForModeChange(roomA, roomA.sessionId, 'run', 'A 자신의 mode 변화 대기')
        expect(afterA).toBe('crouch')

        // B는 아무것도 보내지 않았다 — A의 관점에서도 B는 여전히 'run'이어야 한다.
        const stillB = readMode(roomA, roomB.sessionId)
        expect(stillB).toBe('run')
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    20_000,
  )
})
