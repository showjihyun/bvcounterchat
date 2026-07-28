import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WORLD } from '@shared/constants'

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
 *
 * **REV(구현 후 셋업 적응, team-lead 지시)**: `killAndWaitForRespawn`
 * 헬퍼가 이제 킬 시퀀스 시작 전 B의 자기-보호-해제 사격을 보낸다(item C가
 * 최초 입장에도 적용되며 드러난 전제 붕괴 — 함수 docblock 참고). GA-10
 * (1)(2)(3) 세 `it()` 본문의 단언은 변경하지 않았다.
 *
 * **REV3(리뷰 major-2·minor-2 대응, `_workspace/review/
 * feat-RQ-15-16-respawn-protection.md`)**: (a) GA-10 (1)과 "최초 입장 스폰"
 * `it()` 끝에 양성 대조군(보호 해제 후 같은 조준 재사격 → HP 감소)을
 * 추가했다 — 기존 단언은 그대로 두고 뒤에 이어붙였다(순증). (b)
 * `LATE_IN_WINDOW_MS`를 2700ms→2000ms로 낮췄다 — 관측 지연(패치 주기)과
 * `sleep` 오버슈트가 겹쳐도 보호 창(3000ms)을 넘기지 않도록 여유를 넓혔다.
 *
 * **REV4(RQ-31 Safe Zone 회귀 대응, `_workspace/RQ-31/03_test-writer_regression
 * .md`) — 이 파일은 개별 판단 대상(team-lead 지시)**: 이 파일은 RQ-16
 * 자체(스폰 보호가 실제로 작동하는지)를 검증하므로, 보호를 화이트박스로
 * 꺼버리면 테스트가 무의미해진다. 대신 **위치**(Safe Zone)만 화이트박스로
 * 옮기고 **시간 기반 보호 로직 자체는 손대지 않는다** — 텔레포트는
 * `moveStates`만 바꿀 뿐 `spawnedAtTick`/`firedSinceSpawn`(RQ-16 상태)에는
 * 전혀 영향을 주지 않으므로 이 분리가 안전하다.
 * - **`killAndWaitForRespawn`의 최초 해제 사격**(킬 시퀀스 시작 전, B가
 *   스스로 쏴서 자신의 최초 입장 보호를 해제하는 것)은 **의도적 관측
 *   대상이 아니라 순수 셋업**이다(GA-10 자체와 무관 — 리스폰 이후 상태만
 *   GA-10의 관측 대상이다) — 화이트박스(`firedSinceSpawn`)로 대체한다.
 *   A·B 둘 다 Safe Zone 밖으로 옮겨야 A의 킬 시퀀스 사격 자체가 나가고
 *   (GA-19) B가 실제로 피해를 입는다(GA-11).
 * - **리스폰 후 B는 새 스폰 지점(다시 Safe Zone 내부)에 배치된다** —
 *   `killAndWaitForRespawn`이 반환하기 직전에 B를 다시 한번 Safe Zone
 *   밖으로 옮긴다. 이 텔레포트는 위치만 바꿀 뿐 RQ-16 타이머는 그대로라,
 *   GA-10 (1)(2)(3)의 "3초 이내 무효화·자기 사격 즉시 해제·자연 만료"
 *   관측은 **오직 RQ-16(시간 기반)만으로 설명된다** — Safe Zone(위치
 *   기반)이 섞여 어느 쪽 때문인지 불분명해지는 것을 막는다.
 * - **GA-10 (2)의 자기 사격과 (1)·"최초 입장" 테스트의 양성 대조군 자기
 *   사격은 그대로 자기 사격으로 남긴다** — RQ-16 "사격하면 즉시 해제"
 *   자체가 관측 대상이기 때문이다(team-lead 지시 "자기-사격이 의도적
 *   관측 대상인 it()이 있으면 사수를 Safe Zone 밖으로 옮기는 쪽이
 *   맞다"). B가 이미 Safe Zone 밖으로 옮겨져 있으므로 이 자기 사격은
 *   GA-19에 막히지 않고 정상적으로 나가 RQ-16 해제 여부만을 순수하게
 *   시험한다.
 * - **"최초 입장" describe**(리스폰 없음)는 `killAndWaitForRespawn`을
 *   거치지 않으므로 A·B를 별도로 Safe Zone 밖으로 옮긴다.
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
/** GA-10 (1) — 보호 지속을 "3초 내내"로 뒷받침하기 위해 보호 창 막바지에
 * 근접한 지점에서도 재확인한다. REV3(리뷰 minor-2 대응): 이 값은 **리스폰
 * 관측 시각**(`waitForPlayerCondition`이 resolve된 시각) 기준인데, 서버
 * 리스폰은 그보다 최대 패치 주기(~50ms) 앞서 이미 일어나 있다 — 관측 지연 +
 * 아래 `sleep`의 오버슈트가 겹치면 두 번째 사격이 실제 보호 창(3000ms)을
 * 넘겨 보내질 수 있다(오탐 실패 위험). 2700ms는 여유가 300ms뿐이라 얇다고
 * 판단해 2000ms로 낮췄다 — "막바지"라는 의도(3초 내내 무효화됨을 보임)는
 * 여전히 살아있고(0ms 시점만 확인하는 것보다 훨씬 강한 확인), 여유는
 * 1000ms로 3배 이상 늘었다. */
const LATE_IN_WINDOW_MS = 2_000
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

/** RQ-31 회귀 대응 화이트박스 접근 대상 — `moveStates`·`positionHistory`·
 * `firedSinceSpawn`은 `GameRoom`의 기존 private 필드다(`rq-90-spread-seed
 * -determinism.test.ts`의 `SpreadTestSeam`·`rq-41-slot-promotion.test.ts`의
 * `PromotionTestSeam`이 이미 이 이름들로 화이트박스 결합한다, 그린필드가
 * 아니다). 이 파일은 `moveStates`(위치)만 바꾸고 `spawnedAtTick`은 절대
 * 건드리지 않는다 — RQ-16 시간 기반 보호 로직 자체는 이 파일의 검증
 * 대상이라 손대지 않는다(파일 상단 REV4 참고). */
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

/** RQ-31 Safe Zone 회귀 대응 — 세션을 자신의 현재 위치 기준 방사
 * 방향(원점→현재 위치)으로 밀어내 모든 Safe Zone 밖으로 옮긴다
 * (`rq-31-safe-zone.test.ts` §반경-방사 기하와 동일 증명 — 15개 스폰
 * 지점×오프셋 0~20m 전수 확인됨). */
function escapeSafeZone(
  seam: SafeZoneEscapeSeam,
  sessionId: string,
  base: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const radialMagnitude = Math.hypot(base.x, base.z)
  if (radialMagnitude < 1e-6) {
    throw new Error(`RQ-31 회귀 대응 전제 위반 — base(${base.x},${base.z})가 원점에 있어 방사 방향을 정의할 수 없다`)
  }
  const offsetM = WORLD.SAFE_ZONE_RADIUS_M + 15
  const ux = base.x / radialMagnitude
  const uz = base.z / radialMagnitude
  const escaped = { x: base.x + ux * offsetM, y: base.y, z: base.z + uz * offsetM }
  seam.moveStates.set(sessionId, { x: escaped.x, y: escaped.y, z: escaped.z, vx: 0, vy: 0, vz: 0, grounded: true })
  seam.positionHistory.delete(sessionId)
  return escaped
}

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
 * 강건하게 만든다.
 *
 * **REV(구현 후 셋업 적응, team-lead 지시) — item C 대응**: coder 구현이
 * RQ-16 item C(최초 입장도 스폰 보호)를 정확히 이행하면서, B는 접속 직후
 * 부터 `SPAWN_PROTECTION_MS`(3000ms) 동안 보호된다 — 킬 시퀀스의 첫 발이
 * 이 보호 창 안에서 나가 전부 무효화됐다(`_workspace/RQ-15-16/
 * 02_coder_green.md` §3.2). 킬 시퀀스 시작 전에 B가 스스로(빗나가는
 * 방향으로) 한 발 쏴 **자신의 최초 입장 보호**를 즉시 해제한다 — RQ-16
 * "보호 중인 플레이어가 사격하면 즉시 해제"가 이미 제공하는 경로이며, 3초
 * 대기보다 빠르다. 이 사전 해제는 **리스폰 이후**(GA-10이 실제로 검증하는
 * 보호 상태)와는 다른 시점(사망 이전)의 별개 조치이므로, 아래 (1)(2)(3)
 * 테스트 본문의 단언은 전혀 건드리지 않았다. */
async function killAndWaitForRespawn(
  roomA: Room,
  roomB: Room,
): Promise<{ a: PlayerSnapshot; bAfterRespawn: PlayerSnapshot }> {
  const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
  const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)
  expect(baselineB.hp).toBe(PLAYER.MAX_HP)

  // RQ-31 회귀 대응(파일 상단 REV4) — 이 해제는 순수 셋업(GA-10의 관측
  // 대상이 아니다)이므로 화이트박스로 한다. A·B 둘 다 Safe Zone 밖으로
  // 옮긴다 — A의 킬 시퀀스 사격 자체가 나가려면(GA-19), B가 실제로 피해를
  // 입으려면(GA-11) 필요하다. `spawnedAtTick`은 건드리지 않는다.
  const seam = getSafeZoneSeam(roomA)
  seam.firedSinceSpawn.set(roomB.sessionId, true)
  const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
  const escapedB = escapeSafeZone(seam, roomB.sessionId, baselineB)
  await sleep(SELF_FIRE_SETTLE_MS)

  const aim = aimAtBody(escapedA, escapedB)
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

  const bAfterRespawnRaw = await waitForPlayerCondition(
    roomB,
    roomB.sessionId,
    (p) => p.hp === PLAYER.MAX_HP,
    'RQ-15: 사망 후 리스폰(HP 100 복귀, GA-10 given 준비) 대기',
    RESPAWN_OBSERVE_TIMEOUT_MS,
  )

  // RQ-31 회귀 대응 — 리스폰으로 B는 새 스폰 지점(다시 Safe Zone 내부)에
  // 배치된다. GA-10 (1)(2)(3)의 관측이 Safe Zone(위치 기반)과 섞이지 않고
  // 오직 RQ-16(시간 기반)만으로 설명되도록 다시 한번 Safe Zone 밖으로
  // 옮긴다 — `spawnedAtTick`/`firedSinceSpawn`(방금 리스폰이 초기화한 값)은
  // 건드리지 않는다.
  const escapedBAfterRespawn = escapeSafeZone(seam, roomB.sessionId, bAfterRespawnRaw)
  await sleep(SELF_FIRE_SETTLE_MS)

  const a: PlayerSnapshot = { ...escapedA, hp: baselineA.hp, kills: baselineA.kills }
  const bAfterRespawn: PlayerSnapshot = { ...escapedBAfterRespawn, hp: bAfterRespawnRaw.hp, kills: bAfterRespawnRaw.kills }
  return { a, bAfterRespawn }
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

        // REV3(리뷰 major-2 보조 대응) — 양성 대조군: 위 두 번의 "HP 불변"이
        // 보호 때문임을 이 `it()` 자체 안에서 닫는다. (2)(3)이 파일 수준에서
        // 이미 "같은 aimAtBody 헬퍼로 보호 해제 후 피해가 든다"를 보여주지만,
        // (1) 스스로도 자기완결적으로 증명하도록 리뷰가 요청했다 — hitscan이
        // 통째로 망가져도(예: findClosestHit 후보 수집이 비어도) 위 두 단언은
        // 계속 green일 수 있다는 것이 GA-06 공허화와 같은 유형의 위험이다.
        // B가 자기 보호를 해제한 뒤 **같은 aimAtRespawnedB 벡터**로 A가
        // 세 번째 사격을 보내면 이번에는 HP가 실제로 줄어야 한다.
        roomB.send('fire', UP_MISS_AIM)
        await sleep(SELF_FIRE_SETTLE_MS)
        roomA.send('fire', aimAtRespawnedB)
        const afterProtectionReleased = await waitForPlayerCondition(
          roomB,
          roomB.sessionId,
          (p) => p.hp < PLAYER.MAX_HP,
          'REV3 양성 대조군: 보호 해제 후 같은 조준 재사격 시 HP 감소 대기',
          HP_TIMEOUT_MS,
        )
        expect(afterProtectionReleased.hp).toBeLessThan(PLAYER.MAX_HP)
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
        const baselineA = await waitForPlayerCondition(roomA, roomA.sessionId, () => true, 'A 초기 스냅샷', HP_TIMEOUT_MS)
        const baselineB = await waitForPlayerCondition(roomB, roomB.sessionId, () => true, 'B 초기 스냅샷', HP_TIMEOUT_MS)
        expect(baselineB.hp).toBe(PLAYER.MAX_HP)

        // RQ-31 회귀 대응(파일 상단 REV4) — A·B 둘 다 Safe Zone 밖으로
        // 옮긴다(위치만 — `spawnedAtTick`/RQ-16 타이머는 건드리지 않는다).
        // 그러지 않으면 A의 사격 자체가 GA-19에 막히고, B가 Safe Zone
        // 안에 있으면 RQ-16과 무관하게 GA-11이 계속 피해를 무효화해
        // 아래 관측이 RQ-16만으로 설명되지 않는다.
        const seam = getSafeZoneSeam(roomA)
        const a = escapeSafeZone(seam, roomA.sessionId, baselineA)
        const b = escapeSafeZone(seam, roomB.sessionId, baselineB)
        await sleep(SELF_FIRE_SETTLE_MS)

        const aim = aimAtBody(a, b)
        roomA.send('fire', aim)
        await sleep(NO_DAMAGE_OBSERVE_MS)

        const afterAttack = readPlayer(roomB, roomB.sessionId)
        expect(afterAttack?.hp).toBe(PLAYER.MAX_HP)

        // REV3(리뷰 major-2 대응) — 양성 대조군: 이 describe는 자기 전용
        // 서버에서 `it()` 하나만 돌리고 위 단언이 순수 음성(HP 불변)이라,
        // hitscan이 통째로 망가져도(예: findClosestHit 후보 수집이 비어도)
        // green일 수 있었다(GA-06과 같은 유형의 공허화 위험 — 지금은
        // A=(22,0,0)·B=(20,0,9) 배치에서 `aim`이 우연히 바디 중심을
        // 정확히 관통해서 통과하지만, 맵 단계에서 SPAWN_POINTS가 실좌표로
        // 바뀌면 조용히 공허해질 수 있다). B가 자기 최초 입장 보호를 해제한
        // 뒤 **같은 aim 벡터**로 A가 재사격하면 HP가 실제로 준다는 것을
        // 이 describe 안에서 직접 증명한다.
        roomB.send('fire', UP_MISS_AIM)
        await sleep(SELF_FIRE_SETTLE_MS)
        roomA.send('fire', aim)
        const afterProtectionReleased = await waitForPlayerCondition(
          roomB,
          roomB.sessionId,
          (p) => p.hp < PLAYER.MAX_HP,
          'REV3 양성 대조군: 보호 해제 후 같은 조준 재사격 시 HP 감소 대기',
          HP_TIMEOUT_MS,
        )
        expect(afterProtectionReleased.hp).toBeLessThan(PLAYER.MAX_HP)
      } finally {
        await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
      }
    },
    15_000,
  )
})
