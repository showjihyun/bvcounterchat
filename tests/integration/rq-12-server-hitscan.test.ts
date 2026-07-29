import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'
import { escapeSafeZone, getSafeZoneSeam, releaseSpawnProtectionAndEscape } from '../support/safe-zone'

/**
 * RQ-12 서버 hitscan — 서버 권위(RQ-61) 통합 테스트 (ADR-0008: Colyseus
 * 룸 경계, ADR-0011: 서버 판정 로직은 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-05** (`harness/evals/golden/track-a-product.jsonl`).
 * GA-05: "given: 플레이어 A가 플레이어 B를 조준 / when: A가 사격 / then:
 * 명중 여부는 클라이언트가 아닌 서버의 hitscan 레이캐스트 결과로 결정되며,
 * 서버가 계산한 결과만 HP에 반영된다." `verify` 필드가 이 파일 경로를
 * 정확히 지정한다.
 *
 * 이 파일은 추가로 **ADR-0005의 발사 속도 제한(rate-limit, 150ms)**도
 * 검증한다 — 별도 GA는 없지만 RQ-12의 서버 권위 발사 파이프라인(클라이언트가
 * 연사 속도를 조작해 서버에 보고하는 경로 차단)의 일부이므로 같은 파일에
 * 둔다. GA-06(악의적 명중 주장 거부)·GA-07(헤드샷)·GA-08(사망·킬)은 각자의
 * 전용 파일(`rq-12-client-hit-claim-rejected`·`rq-13-headshot-multiplier`·
 * `rq-14-death-kill-credit`)이 담당한다 — 이 파일에서 재검증하지 않는다.
 *
 * **레벨 분리(ADR-0008)**: 레이×히트박스 교차·부위별 데미지·HP 감산의
 * 순수 산술은 `tests/unit/sim-combat.test.ts`가 이미 결정론적으로 고정한다.
 * 이 파일은 그 산술을 직접 임포트하지 않는다 — "클라이언트가 조준 방향만
 * 보내고, 서버가 자신의 히트박스 판정으로 HP를 갱신하는가"만 실 Colyseus
 * 룸 경계에서 블랙박스로 관측한다(`rq-20-movement-authority.test.ts`와
 * 동일한 정신).
 *
 * **가정 1(coder에게 — Player 스키마 확장)**: `Player`(`@shared/schema/GameState`)에
 * `hp: number`(기본 `PLAYER.MAX_HP`=100)와 `kills: number`(기본 0) 필드가
 * 추가된다. 이 파일은 `hp`만 관측한다(`kills`는 `rq-14-death-kill-credit`
 * 담당).
 *
 * **가정 2(coder에게 — 'fire' 메시지 shape)**: 클라이언트는
 * `room.send('fire', { dirX, dirY, dirZ })`로 조준 방향(정규화된 단위
 * 벡터 — 서버가 방어적으로 재정규화해도 무방, `tests/unit/sim-combat.test.ts`
 * "정규화되지 않은 방향" 테스트 참고)만 보낸다. **클라이언트는 자신이
 * 무엇을 맞혔는지·얼마나 데미지를 입혔는지 주장하는 필드를 보내지 않으며,
 * 서버도 그런 필드가 있어도 읽지 않는다**(RQ-12 "클라이언트의 명중 주장은
 * 신뢰하지 않아야 한다") — `sanitizeMoveInput`이 `move` payload에서 방향·
 * 상태 필드만 뽑던 것과 동일한 패턴(`GameRoom.ts`).
 *
 * **가정 3(coder에게 — 레이 원점·판정 시점)**: 서버는 사수의 현재 추적
 * 위치(`moveStates`, RQ-20)에 `DEFAULT_HITBOX.eyeHeightM`만큼 y축 오프셋을
 * 더한 지점을 레이 원점으로 쓴다. 판정 대상은 사수를 제외한 **모든** 접속
 * 플레이어(RQ-17 — 팀 개념 없음, `tests/integration/rq-17-no-team-restriction.test.ts`
 * 참고)의 현재 추적 위치(발 기준)다. `'fire'` 메시지는 **수신 즉시**(다음
 * 시뮬레이션 틱을 기다리지 않고) 판정한다 — RQ-12 원문 "hitscan(**즉시**
 * 판정 레이캐스트)"의 직역. 히트박스 치수는 `@shared/config/combat-tuning`의
 * `DEFAULT_HITBOX`를 모든 플레이어에 동일 적용한다(캐릭터별 차등 없음, v1
 * 범위).
 *
 * **가정 4(coder에게 — rate-limit 추적 단위)**: 발사 간격은 사수(세션)별로
 * 독립 추적한다(다른 플레이어의 발사는 서로의 rate-limit에 영향을 주지
 * 않는다). 정확한 판정 함수는 `@shared/sim/combat`의 `canFire(lastFireAtMs,
 * nowMs, minIntervalMs)`(순수 함수, `tests/unit/sim-combat.test.ts` 참고)를
 * 그대로 쓰면 된다 — `nowMs`를 서버가 어떻게 조달하는지(틱 기반 또는
 * `Date.now()` — `src/server`는 ADR-0008 lint 대상이 아니다)는 이 테스트가
 * 규정하지 않는다. 이 테스트는 관대한 실시간 여유(수백 ms)로 경계를 확인해
 * 정확한 ms 양자화 방식에 결합하지 않는다 — 정밀한 150ms 경계 자체는
 * `canFire` 단위 테스트가 이미 고정했다.
 *
 * **좌표 설계(고정된 히트박스 값에 무관하게 견고한 기하)**: 사수 A는 원점에
 * 고정(이동 입력을 보내지 않는다), 대상 B는 +X 방향으로 실시간 이동시킨 뒤
 * 정지시켜 **실제 도달한 최종 위치를 읽어서** 조준 각도를 계산한다(가정한
 * 거리에 결합하지 않는다 — 실 네트워크 타이밍 변동에 견고). 수직 각도는
 * `DEFAULT_HITBOX`의 바디 중심 높이((bodyBottomM+bodyTopM)/2)와
 * `eyeHeightM`의 차이로 정확히 계산한다 — 바디 반지름(0.3m)·헤드 반지름
 * (0.12m) 대비 충분히 큰 각도차(수 도 단위)로 분리돼 오조준 리스크가 없다.
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한을 걸고, HP 관측은 고정
 * 슬립 대신 `onStateChange`로 실제 값 변화를 폴링한다. 이동-정지 구간의
 * "정지 대기"만 예외적으로 고정 시간을 쓴다(값이 더 이상 변하지 않는다는
 * 것 자체를 확인하려는 목적이라 이벤트 기반 대기가 부적합 — `rq-20`의
 * "무입력이면 표류하지 않는다" 테스트와 같은 필요성).
 *
 * **REV(구현 후 셋업 적응, RQ-15~16 라운드, team-lead 지시)**: RQ-16
 * item C(최초 입장도 스폰 보호)와 RQ-31(onJoin도 스폰 로테이션) 구현으로
 * 이 파일의 두 가지 전제가 깨졌다 — (1) B는 접속 직후 `SPAWN_PROTECTION_MS`
 * (3000ms) 동안 보호돼 즉시 사격이 무효화된다, (2) 사수 A가 더 이상
 * 원점(0,0,0)에 고정되지 않는다(`_workspace/RQ-15-16/02_coder_green.md`
 * §3.3 실측 근거). 대응: (1) 사격 시퀀스 전에 B가 스스로 빗나가는 방향
 * (수직 위)으로 한 발 쏴 자신의 보호를 즉시 해제한다(RQ-16 "사격하면 즉시
 * 해제" — 스펙이 제공하는 경로, 3초 대기보다 빠르다). (2) `aimAt`이 A의
 * 실제 위치를 읽어 상대 오프셋을 계산하도록 일반화했다(`rq-15`·`rq-16`의
 * `aimAtBody(shooter, target)` 패턴과 동일). 아래 `it()` 3건의 단언(HP
 * 감소량·rate-limit 경계) 자체는 손대지 않았다.
 *
 * **부가 수정 — "무관한 방향" 테스트의 조준(하드코딩된 -X)**: 이 테스트는
 * 원래 실패 목록에 없었지만(coder 실측상 우연히 계속 통과), 재검토 결과
 * "A가 -X로 쏘면 +X에 있는 B를 못 맞힌다"는 근거가 A 원점 고정을 전제해서만
 * 성립한다는 것을 발견했다 — A·B가 임의 위치가 되면 `dirY=0`(수평 레이,
 * A의 눈높이에서 z축 무관 직진)가 B의 헤드 볼륨 높이와 같은 z를 가진 다른
 * 스폰 지점을 지나가면 명중할 위험이 이론적으로 남는다(이번 SPAWN_POINTS
 * 배치에서는 어떤 두 지점도 같은 z를 갖지 않아 우연히 안전했을 뿐 —
 * 보장된 안전이 아니다). GA-06·GA-08이 이미 쓰는 검증된 안전 방향(수직 위,
 * `UP_MISS_AIM`)으로 바꿔 좌표와 완전히 무관하게 만들었다 — "명중 불가능한
 * 조준"이라는 given 의도는 그대로이고, HP 불변이라는 단언도 그대로다.
 *
 * **REV2(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`)**: RQ-31 Safe Zone 배선(GA-19·GA-11, `86fddf1`) 이후 두 가지가
 * 추가로 깨졌다. (1) B의 RQ-16 해제 자기 사격은 B 자신의 Safe Zone(거리
 * 0)에 막힐 수 있다 — 화이트박스(`firedSinceSpawn`)로 대체한다. (2) A는
 * 이 파일 전체에서 한 번도 움직이지 않아 A 자신의 스폰 지점(Safe Zone
 * 내부)에 그대로 있다 — GA-19가 A의 실제 조준 사격 자체를 막는다. **또한
 * 기존 `travelAndSettle`(고정 +X 방향, 900ms≈5.4m)은 특정 스폰 인덱스에서
 * 다른 스폰 지점의 Safe Zone에 새로 들어갈 수 있다는 것이 실측됐다**(15개
 * 지점 중 4개에서 위반, `rq-31-safe-zone.test.ts` §반경-방사 기하 문서
 * 참고) — 그래서 B의 이동도 `travelAndSettle`(실이동) 대신 반경-방사
 * 화이트박스 텔레포트로 대체했다. A·B 둘 다 각자의 스폰 지점 기준 방사
 * 방향으로 Safe Zone 밖으로 옮긴다.
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000

/** RQ-31 회귀 대응 — 화이트박스 Safe Zone 탈출 텔레포트가 스키마
 * (`player.x/y/z`)에 정착할 시간(서버 틱 ≈33ms의 몇 배 여유). */
const SETTLE_MS = 200
/** 재사격 시도 사이 아주 짧은 간격(명백히 150ms 미만) — rate-limit 거부 확인용. */
const RAPID_REFIRE_MS = 40
/** rate-limit 해제를 명백히 보장하는 여유(150ms 및 30Hz 양자화 오차 모두 충분히 초과). */
const RATE_LIMIT_CLEAR_MS = 400

/** GA-06/GA-08과 동일한 근거로 기하학적으로 항상 빗나가는 방향(수직 위) —
 * 위치와 무관하게 안전하다. REV: (a) B가 이 방향으로 자기 자신을 쏘면
 * 자신의 스폰 보호가 즉시 해제된다(RQ-16). (b) "무관한 방향" 테스트의
 * 조준으로도 쓴다(하드코딩된 -X보다 좌표에 강건 — 파일 상단 REV 참고). */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

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

interface PlayerFields {
  x: number
  y: number
  z: number
  hp: number
}

function readPlayer(room: Room, sessionId: string): PlayerFields | undefined {
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
    `초기 스냅샷(hp 포함, sessionId=${sessionId}) 관측`,
  )
}

/** hp가 predicate를 만족할 때까지 관측한다("다음 한 번의 onStateChange"만
 * 신뢰하면 무관한 갱신(RQ-60 tick)을 우리가 기다리는 변화로 착각한다). */
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


/** shooter(발 위치)에서 target(발 위치)의 바디 또는 헤드 중심을 정확히
 * 조준하는 방향 벡터(정규화)를 계산한다. REV: A가 더 이상 원점에 고정되지
 * 않으므로(RQ-31 onJoin 로테이션) 두 위치 모두를 인자로 받는 일반형이다 —
 * `rq-15`·`rq-16`의 `aimAtBody(shooter, target)`와 동일한 패턴. */
function aimAt(
  shooter: { x: number; z: number },
  target: { x: number; z: number },
  verticalCenterM: number,
): { dirX: number; dirY: number; dirZ: number } {
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = verticalCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

function bodyCenterM(): number {
  return (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
}

describe('RQ-12/GA-05: 서버 hitscan 레이캐스트가 명중을 결정하며 그 결과만 HP에 반영된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-12/GA-05: A가 B를 정확히 조준해 사격하면, 서버가 계산한 hitscan 결과로 B의 HP가 바디 데미지만큼 감소한다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수
      const roomB = await joinGame(newClient(server)) // +X로 이동, 피격자

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      // REV2(RQ-31 회귀 대응, 파일 상단 REV2) — B의 RQ-16 해제는 화이트박스로
      // 한다. A·B 둘 다 Safe Zone 밖으로 옮긴다(반경-방사 텔레포트,
      // 고정 +X 실이동보다 안전 — 파일 상단 REV2 근거).
      const seam = getSafeZoneSeam(roomA)
      const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
      const escapedB = releaseSpawnProtectionAndEscape(seam, roomB.sessionId, baselineB)
      await sleep(SETTLE_MS)
      expect(escapedB.x).not.toBe(baselineB.x) // 실제로 이동했다는 전제 확인(원점 가정 제거)

      const aim = aimAt(escapedA, escapedB, bodyCenterM())
      roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ })

      const afterShot = await waitForHpCondition(
        roomB,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'A의 조준 사격 후 B의 HP 감소 대기',
      )
      expect(afterShot.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )

  it(
    'RQ-12/GA-05: A가 B와 무관한 방향(반대쪽)으로 사격하면, 실제로 명중하지 못했으므로 B의 HP는 그대로다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)

      // REV2(공허화 해소, evaluator FAIL 대응): B가 먼저 자신의 최초 입장
      // 스폰 보호를 해제하지 않으면, 아래 "HP 불변"이 진짜 미스가 아니라
      // 보호 때문일 수 있다(evaluator PROBE-A가 GA-06에서 실증한 것과
      // 동일한 함정) — 이 파일의 다른 두 it()(GA-05 본 테스트·rate-limit
      // 테스트)가 이미 같은 환경에서 "진짜 명중은 HP를 정확히 줄인다"를
      // 증명해 뒀으므로(양성 대조군 역할), 이 테스트에는 별도 대조군을
      // 추가하지 않았다 — 자세한 판단 근거는 `_workspace/RQ-15-16/
      // 01_test-writer_red.md` §14 참고.
      // RQ-31 회귀 대응(파일 상단 REV2) — B의 해제는 화이트박스로. A도
      // Safe Zone 밖으로 옮긴다 — 그러지 않으면 A의 사격 자체가 GA-19에
      // 막혀 "HP 불변"이 진짜 미스가 아니라 사격 자체가 막혀서일 수 있다.
      const seam = getSafeZoneSeam(roomA)
      escapeSafeZone(seam, roomA.sessionId, baselineA)
      releaseSpawnProtectionAndEscape(seam, roomB.sessionId, baselineB)
      await sleep(SETTLE_MS)

      // REV: 수직 위(UP_MISS_AIM)를 조준 — A·B의 실제 XZ 위치와 무관하게
      // 기하학적으로 항상 빗나간다(파일 상단 REV "부가 수정" 근거). 원래의
      // 하드코딩 -X 방향은 A가 원점에 고정된다는, 더 이상 성립하지 않는
      // 전제에 의존했다.
      roomA.send('fire', UP_MISS_AIM)

      // "변화가 없음"은 순간 스냅샷 하나로 증명할 수 없다 — 몇 차례의 상태
      // 갱신(RQ-60 tick 포함)을 거치는 동안에도 hp가 그대로인지 확인한다.
      await sleep(500)
      const stillBaseline = readPlayer(roomB, roomB.sessionId)
      expect(stillBaseline?.hp).toBe(baselineB.hp)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    20_000,
  )
})

describe('RQ-12/ADR-0005: 발사 속도 제한(rate-limit) — 150ms 미만 간격의 재사격은 무시된다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    `RQ-12/ADR-0005: 첫 사격은 명중 처리되고, ${RAPID_REFIRE_MS}ms 뒤(150ms 미만)의 재사격은 무시되며, 그 뒤(150ms 초과 경과 후) 사격은 다시 명중 처리된다`,
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)

      // RQ-31 회귀 대응(파일 상단 REV2) — B의 RQ-16 해제는 화이트박스로,
      // A·B 둘 다 Safe Zone 밖으로 옮긴다.
      const seam = getSafeZoneSeam(roomA)
      const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
      const escapedB = releaseSpawnProtectionAndEscape(seam, roomB.sessionId, baselineB)
      await sleep(SETTLE_MS)
      const aim = aimAt(escapedA, escapedB, bodyCenterM())

      // 1발 — 명중 처리(HP: 100 → 75).
      roomA.send('fire', aim)
      const afterFirst = await waitForHpCondition(
        roomB,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        '1발 사격 후 HP 감소 대기',
      )
      expect(afterFirst.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      // 2발(150ms보다 훨씬 짧은 간격) — rate-limit에 걸려 무시돼야 한다.
      roomA.send('fire', aim)
      await sleep(RAPID_REFIRE_MS)
      const afterRapidRefire = readPlayer(roomB, roomB.sessionId)
      expect(afterRapidRefire?.hp).toBe(afterFirst.hp) // 변화 없음 — 거부됨

      // rate-limit이 확실히 풀릴 만큼 충분히 기다린 뒤 3발 — 다시 명중 처리(HP: 75 → 50).
      await sleep(RATE_LIMIT_CLEAR_MS)
      roomA.send('fire', aim)
      const afterThird = await waitForHpCondition(
        roomB,
        roomB.sessionId,
        (hp) => hp < afterFirst.hp,
        '충분한 대기 후 3발째 사격의 HP 감소 대기',
      )
      expect(afterThird.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * 2)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )
})
