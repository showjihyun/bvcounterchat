import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { buildServer } from '@server/index'
import { applySpread, eyeOrigin, raycastHitbox, type Vec3 } from '@shared/sim/combat'
import { createRng } from '@shared/sim/rng'
import { type PositionSnapshot } from '@shared/sim/rewind'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'
import { escapeSafeZone, getSafeZoneSeam, type SafeZoneEscapeSeam } from '../support/safe-zone'

/**
 * RQ-90 v1.8/v1.9 — 정확도 저하 3단계(정지·앉기 ×1 · 이동 ×2 · 공중 ×4) 통합
 * 테스트 (ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직은 Red-first
 * 영역).
 *
 * **골든 매핑 없음**: 이 라운드가 신설·마감하는 골든은 GA-17·GA-49뿐이고
 * (`tests/integration/rq-90-spread-seed-determinism.test.ts`가 이미 검증 —
 * 이 파일은 그 파일을 건드리지 않는다), 3단계 저하 자체는 골든이 아니라
 * `requirements.md` v1.9 RQ-90 본문("저하 단계는 세 가지... 각 단계의
 * 배수는 설정값이며 단조 증가해야 한다")을 직접 verify 대상으로 삼는다.
 *
 * **REV(RQ-90 v1.9, 2026-08-04) — "정지" 판정에 수평 입력 추가**: v1.8이
 * 판정 근거를 `mode`·`grounded` 둘뿐이라고 적었는데, `MoveInput.mode`는
 * 이동 속도 설정(`run`/`walk`/`crouch`)이지 "지금 움직이는 중"이 아니고
 * idle 값이 없어(`IDLE_MOVE_INPUT.mode==='run'`) **"정지" 단계가 도달
 * 불가능**했다(coder가 Green 작업 중 실측 발견 — 표준 테스트 거리에서
 * 헤드샷 마진이 구조적으로 음수가 되는 통합 4파일 회귀로 드러났다).
 * v1.9는 "정지"를 **수평 이동 입력이 없는 상태**(`dirX===0 && dirZ===0`)
 * 로 판정한다 — 판정 근거가 `dirX`·`dirZ`·`mode`·`grounded` 넷으로
 * 늘었다. 아래 (1)이 바로 이 신설 경로("서 있지만 입력이 없음")를
 * 시험한다 — v1.8 시절엔 이 상태를 표현할 방법 자체가 없었다.
 *
 * **레벨 분리(ADR-0008)**: `tests/unit/sim-combat.test.ts`의 "RQ-90
 * v1.8/v1.9 정확도 저하 3단계" describe가 이미 `effectiveSpreadConeRadius`
 * (순수 함수) 수준에서 tier별 배율·단조성·판정 근거 제한(타입 잠금)을
 * 결정론적으로 고정했다 — **그 계약 자체는 이 파일이 재검증하지 않는다.**
 * 이 파일이 검증하는 것은 그와 다른 층위다: **`GameRoom.handleFire`가
 * 실제로 사수의 사격 시점 `dirX`·`dirZ`·`mode`(가장 최근 이동 입력)와
 * `grounded`(현재 `moveStates`)를 읽어 `effectiveSpreadConeRadius`를 거친
 * 실효 콘 반경으로 `applySpread`를 호출하는가** — 배선이 실 Colyseus
 * 룸 경계에서 동작하는지.
 *
 * **테스트 전용 화이트박스**: `spreadTuningOverride`/`forcedSpreadSeed`는
 * `rq-90-spread-seed-determinism.test.ts`가 이미 확립한 정확히 같은 이름의
 * 필드다(재사용 — 새로 만들지 않는다). 다만 `spreadTuningOverride`의 타입은
 * 이 라운드가 확장한 `SpreadTuning`(`movingMultiplier`·`airborneMultiplier`
 * 포함)이다. `moveStates`(Safe Zone 탈출·"공중" 상태 주입 둘 다에 재사용)·
 * `positionHistory`·`firedSinceSpawn`은 `tests/support/safe-zone.ts`의
 * `SafeZoneEscapeSeam`(그린필드 아님 — 기존 화이트박스 계약)을 그대로
 * 확장한다.
 *
 * **REV2(pendingInputs 화이트박스 전환)**: 1차 버전은 `mode`를 실제
 * 'move' 메시지로(블랙박스) 설정했다. v1.9가 `dirX`·`dirZ`(실제 수평
 * 이동 입력)까지 판정에 관여시키면서, 0이 아닌 dirX/dirZ를 실제 'move'로
 * 보내면 서버 물리(`stepPlayerMovement`)가 그 입력을 매 틱 소비해 사수의
 * **실제 위치가 이동**한다 — 조준 기하·오프라인 오라클이 `escapedA`(고정
 * 좌표)를 전제하므로 위치 드리프트는 계산을 깨뜨린다. 그래서 `mode`뿐
 * 아니라 `dirX`·`dirZ`도 **화이트박스로 `pendingInputs`(GameRoom의 기존
 * private 필드, `move` 메시지가 채우는 것과 정확히 같은 맵 — coder의
 * 진행 중 구현이 `this.pendingInputs.get(shooterId) ?? IDLE_MOVE_INPUT`로
 * 읽는 것을 코드 감사로 확인했다)에 직접 쓴다** — 실제 'move' 메시지도,
 * 그로 인한 물리 이동도 전혀 발생하지 않는다. **동시에 `moveStates`의
 * x/y/z도 `escapedA`로 재고정한다**(같은 동기 호출 안에서) — 화이트박스
 * 쓰기가 서버 물리 틱과 경쟁하지 않도록(공중 상태 주입과 동일한 "fire
 * 직전 동기 재주입" 원칙, 아래 참고). `moveStates`·`pendingInputs`를
 * 세팅하고 **그 자리에서 곧바로(sleep 없이) fire를 보낸다** — JS는
 * 단일 스레드라 이 세 문장 사이에 서버 틱이 끼어들 수 없다(같은 근거로
 * `rq-90-spread-seed-determinism.test.ts`의 `teleportPlayer`가 "틱 경과를
 * 기다릴 필요가 없다"고 이미 명시했다).
 *
 * **공중 상태 주입(화이트박스) — REV3(§14 flaky 수정, team-lead 지시)**:
 * 최초 버전은 `y`를 탈출 후 값(0)에 그대로 두고 `grounded:false`·`vy:0`만
 * 주입했다 — **물리적으로 자기모순**이었다(team-lead가 코드로 확정:
 * `@shared/sim/movement`에서 `vy===0`은 항상 "궤적 정점"으로 역산되는데,
 * `y=0`에서의 정점 재해석은 `tookOffFrom`이 음수가 되어 **바로 다음
 * 틱(≤33ms)에 자동 재착지**한다). 화이트박스 쓰기와 `'fire'` 메시지의
 * 네트워크 왕복 사이에 서버 틱이 단 한 번이라도 끼어들면 `grounded`가
 * 이미 `true`로 되돌아간 뒤라 "정지" tier로 오판정됐다 — `npm run check`
 * 전체 스위트(부하 있음)에서만 재현되고 이 파일 단독 재실행(부하 없음)
 * 에서는 재현되지 않는 회귀로 실측됐다(격리 5/5 통과 vs 전체 2/2 실패,
 * `_workspace/RQ-90-spread/01_test-writer_red.md` §14.4).
 *
 * **수정**: `y`를 `AIRBORNE_INJECT_Y_M`(고정 상수, 아래)만큼 살짝
 * 띄운다 — `vy:0`이 여전히 "정점"으로 재해석되지만, 이번엔 정점
 * **자체가 지면 위**라 재해석된 하강 궤적이 즉시 지면을 뚫지 않는다.
 * 정점 근방은 속도가 0에 가까워(포물선의 곡률) 첫 몇 틱의 높이 변화가
 * 아주 작다 — 실측(스크래치, 커밋 안 함): `y=1`에서 tick0 드리프트
 * ≈0.011m, tick1 ≈0.044m, tick2 ≈0.1m, **300ms(9틱) 동안 재착지 없음**.
 * 원점이 0.5~1m 높아지므로 **사격 원점 기하가 바뀐다** — 오프라인
 * 오라클을 그 새 원점으로 다시 계산해야 한다(team-lead 지시대로): 아래
 * `airborneOrigin`/`airborneAim`이 그 재계산이고, (4)(5)는 `aim` 대신
 * `airborneAim`을 쏜다. **그런데도 기존 `transitionSeed12`/`23`을 그대로
 * 재사용할 수 있다** — 원점이 겨우 0.5~1m 높아진 정도로는 이미 탐색해
 * 둔 두 시드의 분류(공중 콘에서 'miss')가 뒤집히지 않음을 스크래치로
 * 직접 검증했다(거리 변화 ≤0.13m, 두 시드 모두 재분류 없음). **다만
 * "겨우 안 바뀐다"에 기대지 않는다** — 아래 (4) 직전에 이 사실 자체를
 * 실행 시점에 재확인하는 가드를 둔다(전제가 깨지면 즉시·명확하게 실패
 * 하도록, `F1_SEED_SEQUENCE` 가드와 동일 관례). `MoveState`는 "값의
 * 완전한 스냅샷"이라는 이 저장소의 기존 정신은 그대로 따른다 — 물리적
 * 사실성(진짜 점프인가)은 여전히 검증 대상이 아니고, 이번 수정의 목적은
 * 오직 "재착지 경합 제거"다.
 *
 * **우선순위(확정 — `sim-combat.test.ts` 상단 REV와 동일, team-lead
 * 회신·원장 25a-10 REV, v1.9 판정표에도 유지)**: `grounded===false`면
 * `dirX`·`dirZ`·`mode`와 무관하게 공중 배율을 쓴다 — 접지 여부가 가장
 * 먼저 갈린다는 것이 스펙 문면 자체의 해석이다(재개정 아님). 이 파일의
 * (5)가 이 확정을 실 서버 배선에서도 재확인한다("정지" 조합(idle+run)인
 * 채로 grounded=false면 공중 tier여야 한다).
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
 * **마진 설계 규칙(team-lead 지시, `_workspace/RQ-90-spread/
 * 01_test-writer_red.md` §11 근거) — 이 파일은 "경계 시드 탐색" 예외에
 * 해당한다**: 이 파일의 모든 명중/빗나감 단언은 `findSeedForBuckets`로
 * **미리 탐색한 특정 시드**에 의존한다(고정 콘 반경에서 "우연히 맞는
 * 넓은 마진"이 아니라 "이 시드는 이 콘에서 반드시 이 결과를 낸다"는
 * 결정론적 사실). 이게 결정론적인 이유: `applySpread`+`raycastHitbox`가
 * 순수 함수라 같은 (시드, 콘 반경, 기하) 조합은 실행마다 항상 같은
 * 결과를 내고, `findSeedForBuckets`가 바로 그 순수 함수를 오프라인에서
 * 먼저 돌려 조건을 만족하는 시드를 찾은 뒤에야 서버에 그 시드를
 * 강제한다(`forcedSpreadSeed`) — "시드 의존"이 이 파일의 검증 **대상**
 * 자체다(tier마다 실제로 다른 콘 반경이 쓰이는지 확인하는 것이 목적이므로,
 * 오히려 "아무 시드에서나 성립" 쪽이 공허해진다 — 콘 반경이 달라도
 * 우연히 같은 쪽으로 떨어지는 시드만 골랐을 수 있기 때문이다). 따라서
 * "최악 편차 기준 양의 마진(명중)/최선 편차 기준 음의 마진(빗나감)"
 * 설계 규칙은 이 파일에는 적용하지 않는다 — 그 규칙이 겨냥하는 것
 * ("시드 운에 기대는 단언")과 이 파일의 실제 구조(시드를 결과가 갈리는
 * 정확한 지점으로 **의도적으로** 겨냥)가 다르다.
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

/** 콘 반경 = (바디 반지름의 각반경) × 이 배율 — `rq-90-spread-seed
 * -determinism.test.ts`의 `SPREAD_CONE_MULTIPLIER`와 동일값·동일 근거
 * (스크래치 검증으로 시드 한 자릿수~두 자릿수 안에서 tier 전이가 갈림을
 * 확인). */
const DEGRADATION_CONE_MULTIPLIER = 3
/** 오프라인 오라클 탐색 상한 — 순수 결정론 계산이라 느리지 않다. */
const SEARCH_LIMIT = 5_000

/** 공중 상태 주입 시 `y`를 이만큼 띄운다 — 파일 상단 "공중 상태 주입
 * REV3" 절 참고. `vy:0`이 "정점"으로 재해석되는 것 자체는 막지 않지만,
 * 정점이 지면 위(`y=0` 아님)에 있으면 재해석된 하강 궤적이 즉시 지면을
 * 뚫지 않는다 — 재착지까지 300ms(9틱, 스크래치 실측) 여유가 생긴다.
 * 원점이 이만큼 높아져 사격 기하가 바뀌므로 `airborneOrigin`/
 * `airborneAim`을 별도로 다시 계산한다(아래). 0.5m로도 200ms(6틱)
 * 여유가 나오지만(스크래치 실측), 부하가 큰 `npm run check` 전체
 * 스위트에서의 관측된 실패가 "틱 1개 정도"의 지연이었다는 정황에 여유를
 * 더 두기 위해 1m를 택했다 — 어느 쪽도 시드 재분류를 일으키지 않음을
 * 아래 가드로 확인한다. */
const AIRBORNE_INJECT_Y_M = 1

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

/** `GameRoom`의 기존 `pendingInputs: Map<string, MoveInput>` 필드와 동일한
 * 최소 형태 — `MoveInput`(`@shared/sim/movement`) 타입을 그대로 복제하지
 * 않고 이 파일이 실제로 쓰는 4개 필드만 적었다(그린필드 아님 — 코드 감사로
 * 실제 필드명·구조를 확인했다, 파일 상단 "REV2" 절 참고). */
interface PendingInputSnapshot {
  dirX: number
  dirZ: number
  mode: 'run' | 'walk' | 'crouch'
  jump: boolean
}

/** RQ-90 v1.8/v1.9 화이트박스 접근 대상 — `SafeZoneEscapeSeam`(그린필드
 * 아님, `tests/support/safe-zone.ts`)을 확장한다. `spreadTuningOverride`·
 * `forcedSpreadSeed`는 `rq-90-spread-seed-determinism.test.ts`가 이미
 * 확립한 이름을 그대로 재사용한다(다만 타입은 이 라운드가 확장한
 * `SpreadTuning` — `movingMultiplier`·`airborneMultiplier` 포함).
 * `pendingInputs`는 그린필드가 아니다 — `GameRoom`의 기존 private
 * 필드(`move` 메시지가 채우고, coder의 진행 중 구현이 탄퍼짐 판정에서
 * `this.pendingInputs.get(shooterId) ?? IDLE_MOVE_INPUT`로 읽는다, 파일
 * 상단 "REV2" 절 참고)를 그 정확한 이름으로 화이트박스 접근한다. */
interface DegradationTestSeam extends SafeZoneEscapeSeam<PositionSnapshot> {
  spreadTuningOverride?: { coneRadiusRad: number; movingMultiplier: number; airborneMultiplier: number }
  forcedSpreadSeed?: number | undefined
  pendingInputs: Map<string, PendingInputSnapshot>
}

function getServerRoom(room: Room): DegradationTestSeam {
  return getSafeZoneSeam<PositionSnapshot>(room) as unknown as DegradationTestSeam
}

/** 사수의 이동 입력(`dirX`·`dirZ`·`mode`)과 위치·접지 상태를 한 번에,
 * 동기적으로 고정한다(파일 상단 "REV2" 절 참고) — 실제 'move' 메시지도,
 * 그로 인한 물리 이동도 전혀 발생하지 않는다. **fire 직전에 매번 호출해야
 * 한다**(호출과 `roomA.send('fire', ...)` 사이에 `await`/`sleep`을 두지
 * 않는다 — JS 단일 스레드라 그 사이에 서버 틱이 끼어들 수 없다, 공중 상태
 * 주입과 동일한 "fire 직전 동기 재주입" 원칙). `position`은 호출자가 넘긴
 * 값을 그대로 쓴다 — 접지 tier((1)(2)(3))는 `escapedA`(고정 좌표, y=0),
 * 공중 tier((4)(5))는 `airborneShooterFoot`(y가 `AIRBORNE_INJECT_Y_M`만큼
 * 높다 — "공중 상태 주입 REV3" 절 참고)를 넘긴다. 어느 쪽이든 조준
 * 기하·오프라인 오라클은 **그 좌표와 일치해야 한다**(호출부가 보장). */
function setShooterState(
  seam: DegradationTestSeam,
  sessionId: string,
  position: { x: number; y: number; z: number },
  dirX: number,
  dirZ: number,
  mode: 'run' | 'walk' | 'crouch',
  grounded: boolean,
): void {
  seam.pendingInputs.set(sessionId, { dirX, dirZ, mode, jump: false })
  seam.moveStates.set(sessionId, { x: position.x, y: position.y, z: position.z, vx: 0, vy: 0, vz: 0, grounded })
}

describe('RQ-90 v1.8/v1.9: 사격 시점 dirX·dirZ·mode·grounded에 따라 서버가 실제로 3단계 탄퍼짐 콘을 적용한다(정지·앉기 ×1 < 이동 ×2 < 공중 ×4)', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-90 v1.9: "정지"(수평 입력 없음, mode=run)로는 명중하는 시드가 "이동"(dirX≠0, mode=walk)에서는 빗나가고, 이동으로 명중하는 다른 시드가 공중(비접지)에서는 빗나간다 — 우선순위(grounded가 dirX·dirZ·mode 전부보다 우선, team-lead 확정)도 함께 확인',
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

      // 시드 하나로 "정지=명중·이동=빗나감·공중=빗나감"을 동시에 만족시켜
      // (5)의 우선순위 확인에도 재사용한다 — 정지 조합(idle+run)+공중에서
      // 이 시드가 여전히 빗나가야 "grounded가 dirX·dirZ·mode를 이긴다"는
      // 증거가 된다.
      const transitionSeed12 = findSeedForBuckets(origin, aim, targetFoot, [baseCone, movingCone, airborneCone], [
        'body',
        'miss',
        'miss',
      ], SEARCH_LIMIT)
      // 이동 tier에서는 명중하지만 공중 tier에서는 빗나가는 별도 시드 —
      // 이동<공중을 독립적으로 증명한다(위 시드만으로는 이동·공중이 둘 다
      // '빗나감'이라 서로 구분되지 않는다).
      const transitionSeed23 = findSeedForBuckets(origin, aim, targetFoot, [movingCone, airborneCone], ['body', 'miss'], SEARCH_LIMIT)

      // 공중 tier((4)(5))는 원점을 AIRBORNE_INJECT_Y_M만큼 띄운다(파일
      // 상단 "공중 상태 주입 REV3" 절) — 원점이 바뀌므로 조준 방향·오라클을
      // 이 새 원점 기준으로 다시 계산한다(team-lead 지시). 시드는 재사용
      // 하되(transitionSeed12/23), 그 재사용이 여전히 유효한지는 아래
      // 가드가 실행 시점에 재확인한다.
      const airborneShooterFoot = { x: escapedA.x, y: AIRBORNE_INJECT_Y_M, z: escapedA.z }
      const airborneOrigin = eyeOrigin(airborneShooterFoot, DEFAULT_HITBOX.eyeHeightM)
      const { aim: airborneAim } = aimAtBodyWithDistance(airborneShooterFoot, escapedB)

      // 가드 — transitionSeed12/23이 이 새 원점·공중 콘에서도 여전히
      // 'miss'로 분류되는지 실행 시점에 재확인한다(스크래치 사전 검증은
      // 이미 통과했으나, 스폰 좌표·오프셋이 바뀌면 이 전제가 조용히
      // 깨질 수 있다 — `F1_SEED_SEQUENCE` 가드와 동일 관례). 깨지면
      // AIRBORNE_INJECT_Y_M을 줄이거나(원점 이동 축소) 시드를 다시
      // 탐색해야 한다.
      const seed12AtAirborne = classifySpreadSeed(airborneOrigin, airborneAim, targetFoot, airborneCone, transitionSeed12)
      const seed23AtAirborne = classifySpreadSeed(airborneOrigin, airborneAim, targetFoot, airborneCone, transitionSeed23)
      if (seed12AtAirborne !== 'miss' || seed23AtAirborne !== 'miss') {
        throw new Error(
          `RQ-90 v1.9 저하 테스트 전제 위반 — AIRBORNE_INJECT_Y_M(${AIRBORNE_INJECT_Y_M}m)만큼 원점을 띄운 뒤에도 ` +
            `transitionSeed12/23이 공중 콘에서 'miss'여야 하는데 각각 '${seed12AtAirborne}'/'${seed23AtAirborne}'였다 ` +
            `(스폰 기하가 스크래치 검증 때와 달라졌을 수 있다 — AIRBORNE_INJECT_Y_M 축소 또는 시드 재탐색 필요).`,
        )
      }

      seam.spreadTuningOverride = { coneRadiusRad: baseCone, movingMultiplier: 2, airborneMultiplier: 4 }

      // --- (1) 정지·앉기 tier — v1.9 신설 경로: 수평 입력 없음(dirX=dirZ=0)
      // + mode='run'(idle) + 접지. transitionSeed12는 오프라인 오라클상
      // 기본 콘에서 반드시 명중(body)한다. **v1.8에서는 이 조합("서
      // 있지만 입력 없음")이 표현 불가능해 항상 "이동"으로 오분류됐다** —
      // 이 단언이 그 회귀를 직접 잡는다.
      seam.forcedSpreadSeed = transitionSeed12
      setShooterState(seam, roomA.sessionId, escapedA, 0, 0, 'run', true)
      let hp = baselineB.hp
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      const after1 = await waitForHpChange(roomB, roomB.sessionId, hp, 'RQ-90 v1.9 (1) 정지(idle+run)+접지 기본 tier 명중 대기')
      expect(after1.hp).toBe(hp - WEAPON.DAMAGE_BODY) // 오프라인 오라클('body')과 일치
      hp = after1.hp
      await sleep(SHOT_GAP_MS)

      // --- (2) 이동 tier — 수평 입력 있음(dirX=1) + mode='walk' + 접지,
      // 같은 transitionSeed12는 오프라인 오라클상 이동 콘(기본×2)에서
      // 반드시 빗나간다(miss) — 정지<이동 증명. **이 단언이 오늘 Red다**:
      // 서버가 아직 dirX·dirZ·mode를 판정에 반영하지 않으므로 기본 콘
      // 그대로 판정해 여전히 명중해 버린다.
      seam.forcedSpreadSeed = transitionSeed12
      setShooterState(seam, roomA.sessionId, escapedA, 1, 0, 'walk', true)
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      await sleep(SHOT_GAP_MS)
      const after2 = readPlayer(roomB, roomB.sessionId)
      expect(after2?.hp).toBe(hp) // 변화 없음 — 오프라인 오라클('miss')과 일치

      // --- (3) 이동 tier 양성 대조 — 같은 이동 입력(dirX=1,walk) 유지,
      // transitionSeed23은 오프라인 오라클상 이동 콘에서 반드시 명중한다
      // (이동 tier의 콘이 "전부 빗나가는" 크기가 아니라는 것도 함께 증명
      // — (2)가 공허하지 않다는 근거).
      seam.forcedSpreadSeed = transitionSeed23
      setShooterState(seam, roomA.sessionId, escapedA, 1, 0, 'walk', true)
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      const after3 = await waitForHpChange(roomB, roomB.sessionId, hp, 'RQ-90 v1.9 (3) 이동(dirX=1+walk)+접지 이동 tier 명중 대기')
      expect(after3.hp).toBe(hp - WEAPON.DAMAGE_BODY) // 오프라인 오라클('body')과 일치 — 데미지 합 50 < 100, B 생존
      hp = after3.hp
      await sleep(SHOT_GAP_MS)

      // --- (4) 공중 tier — 이동 입력(dirX=1,walk)은 그대로 두고 grounded만
      // false로 바꾼다(위치는 AIRBORNE_INJECT_Y_M만큼 띄운다 — "공중 상태
      // 주입 REV3" 절). transitionSeed23은 새 원점·공중 콘(기본×4)에서
      // 반드시 빗나간다(위 가드로 재확인됨) — 이동<공중 증명. 조준
      // 방향도 새 원점 기준(`airborneAim`)으로 쏜다 — 이전 원점(`aim`)을
      // 그대로 쓰면 원점만 바뀌고 조준은 안 바뀌어 애초에 다른 곳을
      // 겨누게 된다.
      seam.forcedSpreadSeed = transitionSeed23
      setShooterState(seam, roomA.sessionId, airborneShooterFoot, 1, 0, 'walk', false)
      roomA.send('fire', { dirX: airborneAim.x, dirY: airborneAim.y, dirZ: airborneAim.z })
      await sleep(SHOT_GAP_MS)
      const after4 = readPlayer(roomB, roomB.sessionId)
      expect(after4?.hp).toBe(hp) // 변화 없음 — 오프라인 오라클('miss')과 일치

      // --- (5) 우선순위(확정, team-lead 회신) — 정지 조합(dirX=dirZ=0,
      // mode='run', (1)과 정확히 동일)으로 되돌리되 grounded만 false로
      // 유지한다(위치는 (4)와 동일하게 AIRBORNE_INJECT_Y_M만큼 띄운다).
      // transitionSeed12는 (1)에서 이 정지 조합+접지 기본 콘에 명중했던
      // 바로 그 시드다 — grounded가 dirX·dirZ·mode 전부를 이긴다면(확정된
      // 해석) 공중 콘이 적용돼 새 원점 기준 오프라인 오라클('miss', 위
      // 가드로 재확인됨)대로 빗나가야 한다. 이 단언이 실패하면(다시
      // 명중하면) 서버 구현이 확정된 우선순위와 반대로 배선됐다는 뜻이다
      // — 우선순위 확정을 실 서버 배선에서 직접 시험(회귀 그물)한다.
      seam.forcedSpreadSeed = transitionSeed12
      setShooterState(seam, roomA.sessionId, airborneShooterFoot, 0, 0, 'run', false)
      roomA.send('fire', { dirX: airborneAim.x, dirY: airborneAim.y, dirZ: airborneAim.z })
      await sleep(SHOT_GAP_MS)
      const after5 = readPlayer(roomB, roomB.sessionId)
      expect(after5?.hp).toBe(hp) // 변화 없음 — grounded가 이긴다면 공중 콘 적용, 오라클('miss')과 일치

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    45_000,
  )
})
