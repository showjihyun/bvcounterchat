import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { applySpread, eyeOrigin, raycastHitbox, type Vec3 } from '@shared/sim/combat'
import { createRng } from '@shared/sim/rng'
import { type PositionSnapshot } from '@shared/sim/rewind'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'
import { escapeSafeZone, getSafeZoneSeam, type SafeZoneEscapeSeam } from '../support/safe-zone'

/**
 * RQ-90 v1.8 — 정확도 저하 3단계(정지·앉기 ×1 · 이동 ×2 · 공중 ×4) 통합
 * 테스트 (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직은 Red-first
 * 영역).
 *
 * **골든 매핑 없음**: 이 라운드가 신설·마감하는 골든은 GA-17·GA-49뿐이고
 * (`tests/integration/rq-90-spread-seed-determinism.test.ts`가 이미 검증 —
 * 이 파일은 그 파일을 건드리지 않는다), 3단계 저하 자체는 골든이 아니라
 * `requirements.md` v1.8 RQ-90 본문("저하 단계는 세 가지... 각 단계의
 * 배수는 설정값이며 단조 증가해야 한다")을 직접 verify 대상으로 삼는다.
 *
 * **레벨 분리(ADR-0008)**: `tests/unit/sim-combat.test.ts`의 "RQ-90 v1.8
 * 정확도 저하 3단계" describe가 이미 `effectiveSpreadConeRadius`(순수 함수)
 * 수준에서 tier별 배율·단조성·판정 근거 제한(타입 잠금)을 결정론적으로
 * 고정했다 — **그 계약 자체는 이 파일이 재검증하지 않는다.** 이 파일이
 * 검증하는 것은 그와 다른 층위다: **`GameRoom.handleFire`가 실제로 사수의
 * 사격 시점 `mode`(가장 최근 'move' 메시지 값)와 `grounded`(현재
 * `moveStates`)를 읽어 `effectiveSpreadConeRadius`를 거친 실효 콘 반경으로
 * `applySpread`를 호출하는가** — 배선이 실 Colyseus 룸 경계에서 동작하는지.
 *
 * **현재 상태(코드 감사, 착수 전 실측)**: `GameRoom.handleFire`
 * (`GameRoom.ts:677-679`)는 `this.spreadTuningOverride ?? DEFAULT_SPREAD`의
 * `coneRadiusRad`를 **가공 없이 그대로** `applySpread`에 넘긴다 — `mode`·
 * `grounded`를 참조하는 어떤 저하 계산도 없다. 즉 이 파일의 아래 시나리오는
 * "정지·이동·공중 셋 다 콘 반경이 항상 같다"(오늘의 실제 동작)를 관측해
 * **당연히 실패해야 정상**이다(Red).
 *
 * **테스트 전용 화이트박스**: `spreadTuningOverride`/`forcedSpreadSeed`는
 * `rq-90-spread-seed-determinism.test.ts`가 이미 확립한 정확히 같은 이름의
 * 필드다(재사용 — 새로 만들지 않는다). 다만 `spreadTuningOverride`의 타입은
 * 이 라운드가 확장한 `SpreadTuning`(`movingMultiplier`·`airborneMultiplier`
 * 포함)이다 — 그 파일이 이 라운드 전에 쓰던 `{ coneRadiusRad }`만으로는
 * 이 새 타입에 대입할 수 없다(그 파일은 건드리지 않으므로 영향 없음).
 * `moveStates`(Safe Zone 탈출·"공중" 상태 주입 둘 다에 재사용)·
 * `positionHistory`·`firedSinceSpawn`은 `tests/support/safe-zone.ts`의
 * `SafeZoneEscapeSeam`(그린필드 아님 — 기존 화이트박스 계약)을 그대로
 * 확장한다. **`mode`는 화이트박스가 아니라 실제 'move' 메시지로 설정한다**
 * — `pendingInputs`(GameRoom의 기존 private 필드, `move` 메시지가 즉시
 * 채운다)를 통해 서버가 실제로 최근 이동 입력을 어떻게 저장하든, 이 파일은
 * 그 내부 구현을 가정하지 않고 블랙박스로 'move'를 보낸 뒤 결과만 관측한다
 * — 오직 "접지 상태" 하나만 자연적으로(점프) 재현하기 어려워(타이밍 취약,
 * 아래 "공중 상태 주입" 절 참고) `moveStates`를 화이트박스로 직접 쓴다.
 *
 * **공중 상태 주입(화이트박스, y·grounded만 조작 — 위치는 절대 바꾸지
 * 않는다)**: `handleFire`는 사수 자신의 레이 원점을 `moveStates`에서
 * **즉시(동기)** 읽는다(틱을 기다리지 않는다 — `rq-90-spread-seed
 * -determinism.test.ts`의 `teleportPlayer` 코멘트 "틱 경과를 기다릴 필요가
 * 없다"와 동일 근거, 이 파일도 그 전제를 그대로 재사용한다). 공중 tier를
 * 시험할 때마다 `seam.moveStates.set(shooterId, { ...현재 x/y/z, grounded:
 * false })`를 **fire 직전 동기 호출**로 매번 다시 세팅한다(한 번 세팅하고
 * 유지하지 않는다) — 자연스러운 점프 물리(`stepAirborne`)가 다음 30Hz
 * 틱(≤33ms)마다 `moveStates`를 다시 계산해 덮어쓰므로(예: `vy:0`은 정점
 * 재해석이라 다음 틱에 즉시 재착지할 수 있다, `@shared/sim/movement`
 * `airborneOutcome` "발밑 오프셋" 코멘트), fire 직전 매번 재주입하면 그
 * 물리 재계산과 경쟁할 필요가 없다(둘 다 사수의 x/y/z는 그대로 유지하므로
 * 조준 기하·오프라인 오라클 계산에 영향 없다 — y도 탈출 후 값(0)을 그대로
 * 쓴다, "높이 자체가 진짜 공중이어야 한다"는 물리적 사실성은 이 파일의
 * 검증 대상이 아니다 — `MoveState`는 "값의 완전한 스냅샷"이라는 이
 * 저장소의 기존 정신, `@shared/sim/movement` 파일 상단 코멘트를 그대로
 * 따른다).
 *
 * **우선순위(확정 — `sim-combat.test.ts` 상단 REV와 동일, team-lead
 * 회신·원장 25a-10 REV)**: `grounded===false`면 `mode`와 무관하게 공중
 * 배율을 쓴다 — v1.8이 저하 단계를 "정지·앉기 / 이동 / 공중(비접지)"로
 * 나누고 공중을 직접 "비접지"로 정의했으므로, 접지 여부가 mode보다
 * 먼저 갈린다는 것이 스펙 문면 자체의 해석이다(재개정 아님). 이 파일의
 * (5)가 이 확정을 실 서버 배선에서도 재확인한다(mode='crouch'인데도
 * grounded=false면 공중 tier여야 한다).
 *
 * **기하·오프라인 오라클**: `rq-90-spread-seed-determinism.test.ts`와 동일
 * 기법 — A(사수)→B(피격자) 바디 중심을 겨냥하는 단위 벡터를 실측 좌표로
 * 계산하고, 이미 결정론이 고정된 순수 함수(`applySpread`+`raycastHitbox`+
 * `eyeOrigin`)를 이 파일 안에서 그대로 호출해 "이 시드·이 콘 반경 조합이
 * 실제로 명중/이탈 어느 쪽을 내는지"를 미리 계산한다(진짜 무작위성 없음 —
 * 재실행해도 항상 같은 답). `DEGRADATION_CONE_MULTIPLIER`(=3, 그 파일의
 * `SPREAD_CONE_MULTIPLIER`와 동일값·동일 근거)로 콘 반경을 확대해 시드
 * 한 자릿수~두 자릿수 안에서 tier 간 명중/이탈이 갈리게 한다(스크래치
 * 검증 — `_workspace/RQ-90-spread/01_test-writer_red.md` §5 참고, 저장소에
 * 커밋되지 않음).
 *
 * **단조성 증명 전략**: 시드 하나(`transitionSeed12`)로 "기본 tier에서는
 * 명중하지만 이동 tier에서는 빗나간다"를 보여 기본<이동을 증명하고, 다른
 * 시드(`transitionSeed23`)로 "이동 tier에서는 명중하지만 공중 tier에서는
 * 빗나간다"를 보여 이동<공중을 증명한다 — 두 시드를 합치면 세 tier
 * 모두가 서로 다른(엄격히 증가하는) 실효 콘을 쓴다는 것이 pairwise로
 * 증명된다. `findSeedForBuckets`가 오프라인 오라클로 이 시드를 실측
 * 좌표에서 직접 탐색한다(하드코딩된 매직넘버가 아니다).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외). 모든 대기에 `withTimeout()` 상한을 건다. hp 변화 관측은
 * `onStateChange` 이벤트 기반 폴링이고, "변화 없음"(미스 예측) 확인만
 * 고정 슬립 뒤 값을 읽는다(그 자체가 확인 대상이라 이벤트 기반 대기가
 * 부적합 — `rq-12`·`rq-90-spread-seed-determinism`과 동일 근거). 오프라인
 * 오라클은 순수 산술이라 실행마다 항상 같은 답을 낸다(플레이키 아님).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000

/** 연속 사격 사이 여유(ADR-0005 rate-limit 150ms + 네트워크 왕복 여유) —
 * "빗나감" 확인의 정착 대기로도 재사용한다. */
const SHOT_GAP_MS = 400
/** 'move' 전송 후 서버가 그 값을 반영했다고 안전하게 가정할 수 있는 여유
 * (같은 WebSocket 연결이라 순서는 보장되지만, 서버 처리·틱 루프와의 여유를
 * 위해 둔다). */
const MOVE_SETTLE_MS = 150

/** 콘 반경 = (바디 반지름의 각반경) × 이 배율 — `rq-90-spread-seed
 * -determinism.test.ts`의 `SPREAD_CONE_MULTIPLIER`와 동일값·동일 근거
 * (스크래치 검증으로 시드 한 자릿수~두 자릿수 안에서 tier 전이가 갈림을
 * 확인). */
const DEGRADATION_CONE_MULTIPLIER = 3
/** 오프라인 오라클 탐색 상한 — 순수 결정론 계산이라 느리지 않다. */
const SEARCH_LIMIT = 5_000

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

/** 리스너 생명주기 정본 형태(`rq-90-spread-seed-determinism.test.ts`의
 * `waitForPlayerCondition`과 동일 — 세 규칙: 참조 등록·즉시 충족 시 미등록·
 * 충족 시 해제). */
function waitForPlayerCondition(
  room: Room,
  sessionId: string,
  predicate: (p: PlayerFields) => boolean,
  label: string,
  timeoutMs: number,
): Promise<PlayerFields> {
  return withTimeout(
    new Promise<PlayerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current && predicate(current)) {
          room.onStateChange.remove(tryResolve)
          resolve(current)
        }
      }
      const immediate = readPlayer(room, sessionId)
      if (immediate && predicate(immediate)) {
        resolve(immediate)
        return
      }
      room.onStateChange(tryResolve)
    }),
    timeoutMs,
    label,
  )
}

function waitForDefinedPlayer(room: Room, sessionId: string): Promise<PlayerFields> {
  return waitForPlayerCondition(room, sessionId, () => true, `초기 스냅샷(hp 포함, sessionId=${sessionId}) 관측`, HP_TIMEOUT_MS)
}

function waitForHpChange(room: Room, sessionId: string, previousHp: number, label: string): Promise<PlayerFields> {
  return waitForPlayerCondition(room, sessionId, (p) => p.hp !== previousHp, label, HP_TIMEOUT_MS)
}

function bodyCenterM(): number {
  return (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
}

function aimAtBodyWithDistance(
  shooterFoot: { x: number; z: number },
  targetFoot: { x: number; z: number },
): { aim: Vec3; distance: number } {
  const dx = targetFoot.x - shooterFoot.x
  const dz = targetFoot.z - shooterFoot.z
  const dy = bodyCenterM() - DEFAULT_HITBOX.eyeHeightM
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { aim: { x: dx / distance, y: dy / distance, z: dz / distance }, distance }
}

type SpreadBucket = 'body' | 'head' | 'miss'

/** 오프라인 오라클 — 이미 결정론이 고정된 순수 함수(`applySpread`+
 * `raycastHitbox`)를 그대로 호출한다(`rq-90-spread-seed-determinism
 * .test.ts`의 `classifySpreadSeed`와 동일 기법). */
function classifySpreadSeed(origin: Vec3, aim: Vec3, targetFoot: Vec3, coneRadiusRad: number, seed: number): SpreadBucket {
  const deviated = applySpread(aim, createRng(seed), coneRadiusRad)
  const result = raycastHitbox({ origin, direction: deviated }, { position: targetFoot }, DEFAULT_HITBOX)
  if (!result.hit) return 'miss'
  return result.region === 'head' ? 'head' : 'body'
}

/** `radii[i]`에서 `wanted[i]` 버킷이 전부 동시에 성립하는 첫 시드를 찾는다
 * — tier 전이(예: [기본콘, 이동콘] → ['body','miss'])를 증명하는 시드
 * 탐색에 재사용한다. */
function findSeedForBuckets(
  origin: Vec3,
  aim: Vec3,
  targetFoot: Vec3,
  radii: readonly number[],
  wanted: readonly SpreadBucket[],
  searchLimit: number,
): number {
  for (let seed = 1; seed <= searchLimit; seed += 1) {
    if (radii.every((radius, i) => classifySpreadSeed(origin, aim, targetFoot, radius, seed) === wanted[i])) {
      return seed
    }
  }
  throw new Error(
    `RQ-90 v1.8 저하 테스트 셋업 실패 — radii=${JSON.stringify(radii)}에서 buckets=${JSON.stringify(
      wanted,
    )}를 내는 시드를 1..${searchLimit} 범위에서 찾지 못했다(DEGRADATION_CONE_MULTIPLIER 조정 필요 — 실제 스폰 기하가 스크래치 검증 때와 달라졌을 수 있다).`,
  )
}

/** RQ-90 v1.8 화이트박스 접근 대상 — `SafeZoneEscapeSeam`(그린필드 아님,
 * `tests/support/safe-zone.ts`)을 확장한다. `spreadTuningOverride`·
 * `forcedSpreadSeed`는 `rq-90-spread-seed-determinism.test.ts`가 이미
 * 확립한 이름을 그대로 재사용한다(다만 타입은 이 라운드가 확장한
 * `SpreadTuning` — `movingMultiplier`·`airborneMultiplier` 포함). */
interface DegradationTestSeam extends SafeZoneEscapeSeam<PositionSnapshot> {
  spreadTuningOverride?: { coneRadiusRad: number; movingMultiplier: number; airborneMultiplier: number }
  forcedSpreadSeed?: number | undefined
}

function getServerRoom(room: Room): DegradationTestSeam {
  return getSafeZoneSeam<PositionSnapshot>(room) as unknown as DegradationTestSeam
}

/** 사수를 지정한 `mode`로 표시한다 — 실제 'move' 메시지를 보낸다(화이트박스
 * 아님, 블랙박스). `dirX`·`dirZ`는 0으로 고정해 실제 위치가 움직이지
 * 않게 한다(조준 기하·오프라인 오라클 계산이 이동에 영향받지 않아야
 * 한다). */
async function setShooterMode(room: Room, mode: 'run' | 'walk' | 'crouch'): Promise<void> {
  room.send('move', { dirX: 0, dirZ: 0, mode, jump: false })
  await sleep(MOVE_SETTLE_MS)
}

/** 사수를 공중(`grounded:false`) 상태로 표시한다 — x/y/z는 손대지 않는다
 * (파일 상단 "공중 상태 주입" 절 참고). fire 직전에 매번 호출해야 한다 —
 * 이 함수가 세팅한 상태는 다음 물리 틱(≤33ms)에 자연 궤적으로 다시
 * 계산되어 덮어써질 수 있다. */
function markShooterAirborne(seam: DegradationTestSeam, sessionId: string, position: { x: number; y: number; z: number }): void {
  seam.moveStates.set(sessionId, { x: position.x, y: position.y, z: position.z, vx: 0, vy: 0, vz: 0, grounded: false })
}

describe('RQ-90 v1.8: 사격 시점 mode·grounded에 따라 서버가 실제로 3단계 탄퍼짐 콘을 적용한다(정지·앉기 ×1 < 이동 ×2 < 공중 ×4)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-90 v1.8: crouch+접지(기본 콘)로는 명중하는 시드가 walk+접지(이동 콘)에서는 빗나가고, walk+접지로는 명중하는 다른 시드가 공중(비접지) 콘에서는 빗나간다 — 우선순위(grounded가 mode보다 우선, team-lead 확정)도 함께 확인',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수
      const roomB = await joinGame(newClient(server)) // 피격자

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      // RQ-31 Safe Zone 회귀 대응 — A·B 둘 다 Safe Zone 밖으로 옮긴다(그러지
      // 않으면 A의 사격 자체가 GA-19에 막히고, B가 Safe Zone 안에 있으면
      // RQ-16과 무관하게 GA-11이 계속 피해를 무효화한다).
      const seam = getServerRoom(roomA)
      seam.firedSinceSpawn.set(roomB.sessionId, true)
      const escapedA = escapeSafeZone(seam, roomA.sessionId, baselineA)
      const escapedB = escapeSafeZone(seam, roomB.sessionId, baselineB)
      await sleep(SHOT_GAP_MS)

      const origin = eyeOrigin({ x: escapedA.x, y: escapedA.y, z: escapedA.z }, DEFAULT_HITBOX.eyeHeightM)
      const targetFoot: Vec3 = { x: escapedB.x, y: escapedB.y, z: escapedB.z }
      const { aim, distance } = aimAtBodyWithDistance(escapedA, escapedB)

      const baseCone = Math.atan(DEFAULT_HITBOX.bodyRadiusM / distance) * DEGRADATION_CONE_MULTIPLIER
      const movingCone = baseCone * 2 // v1.8 확정 배율
      const airborneCone = baseCone * 4 // v1.8 확정 배율

      // 시드 하나로 "기본=명중·이동=빗나감·공중=빗나감"을 동시에 만족시켜
      // (5)의 우선순위 확인에도 재사용한다 — crouch+공중 조합에서 이 시드가
      // 여전히 빗나가야 "grounded가 mode를 이긴다"는 증거가 된다.
      const transitionSeed12 = findSeedForBuckets(origin, aim, targetFoot, [baseCone, movingCone, airborneCone], [
        'body',
        'miss',
        'miss',
      ], SEARCH_LIMIT)
      // 이동 tier에서는 명중하지만 공중 tier에서는 빗나가는 별도 시드 —
      // 이동<공중을 독립적으로 증명한다(위 시드만으로는 이동·공중이 둘 다
      // '빗나감'이라 서로 구분되지 않는다).
      const transitionSeed23 = findSeedForBuckets(origin, aim, targetFoot, [movingCone, airborneCone], ['body', 'miss'], SEARCH_LIMIT)

      seam.spreadTuningOverride = { coneRadiusRad: baseCone, movingMultiplier: 2, airborneMultiplier: 4 }

      // --- (1) 기본(정지·앉기) tier — crouch+접지, transitionSeed12는
      // 오프라인 오라클상 기본 콘에서 반드시 명중(body)한다.
      seam.forcedSpreadSeed = transitionSeed12
      await setShooterMode(roomA, 'crouch')
      let hp = baselineB.hp
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      const after1 = await waitForHpChange(roomB, roomB.sessionId, hp, 'RQ-90 v1.8 (1) crouch+접지 기본 tier 명중 대기')
      expect(after1.hp).toBe(hp - WEAPON.DAMAGE_BODY) // 오프라인 오라클('body')과 일치
      hp = after1.hp
      await sleep(SHOT_GAP_MS)

      // --- (2) 이동 tier — walk+접지, 같은 transitionSeed12는 오프라인
      // 오라클상 이동 콘(기본×2)에서 반드시 빗나간다(miss) — 기본<이동 증명.
      // **이 단언이 오늘 Red다**: 서버가 아직 mode를 판정에 반영하지
      // 않으므로 기본 콘 그대로 판정해 여전히 명중해 버린다.
      seam.forcedSpreadSeed = transitionSeed12
      await setShooterMode(roomA, 'walk')
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      await sleep(SHOT_GAP_MS)
      const after2 = readPlayer(roomB, roomB.sessionId)
      expect(after2?.hp).toBe(hp) // 변화 없음 — 오프라인 오라클('miss')과 일치

      // --- (3) 이동 tier 양성 대조 — walk+접지 유지, transitionSeed23은
      // 오프라인 오라클상 이동 콘에서 반드시 명중한다(이동 tier의 콘이
      // "전부 빗나가는" 크기가 아니라는 것도 함께 증명 — (2)가 공허하지
      // 않다는 근거).
      seam.forcedSpreadSeed = transitionSeed23
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      const after3 = await waitForHpChange(roomB, roomB.sessionId, hp, 'RQ-90 v1.8 (3) walk+접지 이동 tier 명중 대기')
      expect(after3.hp).toBe(hp - WEAPON.DAMAGE_BODY) // 오프라인 오라클('body')과 일치 — 데미지 합 50 < 100, B 생존
      hp = after3.hp
      await sleep(SHOT_GAP_MS)

      // --- (4) 공중 tier — mode는 walk 그대로 두고 grounded만 false로
      // 표시한다(fire 직전 동기 세팅). transitionSeed23은 오프라인
      // 오라클상 공중 콘(기본×4)에서 반드시 빗나간다 — 이동<공중 증명.
      seam.forcedSpreadSeed = transitionSeed23
      markShooterAirborne(seam, roomA.sessionId, escapedA)
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      await sleep(SHOT_GAP_MS)
      const after4 = readPlayer(roomB, roomB.sessionId)
      expect(after4?.hp).toBe(hp) // 변화 없음 — 오프라인 오라클('miss')과 일치

      // --- (5) 우선순위(확정, team-lead 회신) — mode를 crouch로 되돌리되
      // (=단독이면 기본 tier) grounded는 계속 false로 유지한다.
      // transitionSeed12는 (1)에서 crouch+접지 기본 콘에 명중했던 바로 그
      // 시드다 — grounded가 mode를 이긴다면(확정된 해석) 공중 콘이 적용돼
      // 오프라인 오라클('miss', 위 탐색 조건 그대로)대로 빗나가야 한다.
      // 이 단언이 실패하면(다시 명중하면) 서버 구현이 확정된 우선순위와
      // 반대로 배선됐다는 뜻이다 — 우선순위 확정을 실 서버 배선에서
      // 직접 시험(회귀 그물)한다.
      seam.forcedSpreadSeed = transitionSeed12
      await setShooterMode(roomA, 'crouch')
      markShooterAirborne(seam, roomA.sessionId, escapedA) // mode 메시지 처리 후 다시 grounded:false로 확정(틱 경쟁 방지)
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      await sleep(SHOT_GAP_MS)
      const after5 = readPlayer(roomB, roomB.sessionId)
      expect(after5?.hp).toBe(hp) // 변화 없음 — grounded가 mode를 이긴다면 공중 콘 적용, 오라클('miss')과 일치

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    45_000,
  )
})
