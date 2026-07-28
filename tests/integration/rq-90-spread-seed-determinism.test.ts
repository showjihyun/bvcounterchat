import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { applySpread, eyeOrigin, raycastHitbox, type Vec3 } from '@shared/sim/combat'
import { createRng } from '@shared/sim/rng'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { PLAYER, WEAPON } from '@shared/constants'

/**
 * RQ-90 탄퍼짐(랜덤 콘) — **시드 결정론** 통합 테스트 (ADR-0008: Colyseus
 * 룸 경계, ADR-0011: 서버 판정 로직은 Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-17** (`harness/evals/golden/...`).
 * GA-17: "given: 서버가 사격 시 자신이 발급한 시드 값으로 탄퍼짐(랜덤 콘)
 * 난수를 생성한다(시뮬레이션 코드는 Math.random()을 직접 호출하지 않는다,
 * ADR-0008) / when: 동일한 시드로 동일한 사격 판정을 두 번 재현 / then: 두
 * 번의 탄착점(탄퍼짐 결과)이 완전히 동일하다 — 같은 시드는 같은 결과를
 * 낳는다." `verify` 필드가 이 파일 경로를 정확히 지정한다.
 *
 * **레벨 분리(ADR-0008)·기존 커버리지와의 차이**: `tests/unit/sim-combat.test.ts`
 * `describe('RQ-90 탄퍼짐 구조...')`(파일 하단, `applySpread` 직접 호출)가
 * 이미 순수 함수 수준에서 "같은 시드는 같은 결과·다른 시드는 다른 결과·콘
 * 반경 0이면 정조준"을 결정론적으로 고정해 뒀다 — **그 계약 자체는 이 파일이
 * 재검증하지 않는다.** 이 파일이 검증하는 것은 그와 다른 층위다: **서버
 * (`GameRoom.handleFire`)가 실제로 자신의 시드를 발급해 `applySpread`에
 * 넘기고 있는가** — 즉 클라이언트가 보낸 조준 방향을 그대로 레이로 쓰는 게
 * 아니라, 서버가 자신의(±테스트가 강제한) 시드로 편차를 얹은 뒤에 판정하는
 * 배선이 실제 Colyseus 룸 경계에서 동작하는가(`rq-12-server-hitscan.test.ts`와
 * 동일한 "클라 요청 → 서버 판정 → HP 반영"의 블랙박스 관측 정신).
 *
 * **현재 상태 확인(코드 감사, 착수 전 실측)**: `createRng`/`SeededRng`/
 * `applySpread`는 저장소 전체에서 `src/shared/sim/combat.ts` 자신과
 * `tests/unit/sim-combat.test.ts` **이외에는 참조되는 곳이 없다**
 * (`grep -rn "createRng\|SeededRng\|applySpread" src` 실행 결과). `GameRoom.
 * handleFire`(L562-565)는 `input.dirX/dirY/dirZ`를 **그대로** 레이 방향으로
 * 쓴다 — 탄퍼짐 적용 단계가 아예 없다. 즉 GA-17의 `given`("서버가... 시드
 * 값으로 탄퍼짐 난수를 생성한다")이 **지금 거짓**이다 — 이 파일은 오늘 실행하면
 * **실패해야 정상**이다(Red).
 *
 * **테스트 시드 주입 인터페이스(신규 화이트박스 계약 — 그린필드)**: 출하
 * 기본값 `DEFAULT_SPREAD.coneRadiusRad`는 0(정조준)이며 이번 라운드는 그
 * 기본값을 바꾸지 않는다(팀리드 결정, "시드 배선만 한다") — 그런데 반경 0에서는
 * `applySpread`가 항등 함수라 시드가 결과에 전혀 드러나지 않는다("공허함
 * 함정"). 그래서 이 테스트는 **테스트 전용 오버라이드 두 개**를 `GameRoom`
 * 인스턴스에 요구한다 — `matchMaker.getLocalRoomById`로 살아있는 서버 룸
 * 객체를 얻어 `as unknown as SpreadTestSeam`으로 직접 필드를 쓰는, 이 저장소가
 * 이미 확립한 화이트박스 관례(`FallDamageTestSeam`·`AfkTestSeam`·
 * `PositionTestSeam`·`RewindTestSeam`과 동일한 `as unknown as` 결합 — `tsc`가
 * 대조하지 않으므로 TS2307/TS2305 없이 컴파일된다):
 *
 *   - `spreadTuningOverride?: { coneRadiusRad: number }` — 있으면 이 룸
 *     인스턴스의 `DEFAULT_SPREAD`를 대체한다(없으면 기존처럼
 *     `DEFAULT_SPREAD`, 즉 반경 0). 룸 생성 시점 옵션(`statsDbPath`처럼
 *     `gameServer.define()`의 3번째 인자)이 아니라 **인스턴스 필드**로 둔
 *     이유: 이 테스트가 한 룸 안에서 반경을 0 → 0이 아닌 값 → 다시 0으로
 *     시나리오 도중에 바꿔야 하기 때문이다(생성 시점 옵션은 재생성 없이
 *     못 바꾼다).
 *   - `forcedSpreadSeed?: number` — 있으면 **다음 'fire' 메시지부터(발신자
 *     무관, 테스트가 다시 바꾸기 전까지 계속)** `applySpread`에 넘길 시드로
 *     이 값을 그대로 쓴다(=`createRng(forcedSpreadSeed)`) — 서버 자신이
 *     고르는 값을 테스트가 대체한다. **자동 소비/초기화되지 않는다**(매
 *     사격마다 다시 세팅할 필요 없음 — 계약을 단순하게 유지하기 위한
 *     선택). 없을 때 서버가 실제로 시드를 어떻게 조달하는지(예: `state.tick`
 *     +내부 카운터 조합)는 **이 테스트가 규정하지 않는다** — coder 재량.
 *     단, ADR-0008 위반 방지를 위해 프로덕션 경로도 반드시 `createRng`를
 *     거쳐야 한다(`Math.random()` 직접 호출 금지, `src/shared`의 규율).
 *     **주의**: `src/server`(이 룸) 자신이 시드의 *원재료*(예: `Date.now()`,
 *     `state.tick`)를 얻는 것은 ADR-0008 위반이 아니다(`handleFire`의
 *     rate-limit이 이미 `Date.now()`를 쓴다, 이 파일 상단 GameRoom 코멘트
 *     참고) — 위반은 오직 **난수 생성 자체**(`applySpread` 내부의 편차
 *     계산)를 `Math.random()`으로 하는 경우다. 여기서는 이미 `applySpread`가
 *     주입된 `SeededRng`만 쓰므로 이 축은 이미 안전하다.
 *
 *   두 필드 다 **오늘은 존재하지 않는다**(Red 전제) — 서버가 저 이름의
 *   필드를 갖지 않으므로 테스트가 이 값을 설정해도 **아무 효과가 없다**
 *   (임의 프로퍼티를 얹는 것 자체는 JS에서 에러가 아니다 — 조용히 무시될
 *   뿐이다). 그래서 이 파일의 Red는 "필드가 없다"는 예외가 아니라 아래
 *   (B)/(C) 단언의 **값 불일치**로 드러난다(타임아웃이 아니라 즉시 실패로
 *   드러나도록 관측 지점을 설계했다 — 아래 "공허함 회피" 참고).
 *
 * **관측 지점 선택 근거**: `handleFire`를 감사한 결과 서버는 명중 결과(부위·
 * 탄착점)를 별도 네트워크 메시지로 브로드캐스트하지 않는다 — 유일하게 외부에서
 * 관측 가능한 신호는 **피격자의 `hp`(state 필드, GA-05/12/13/14 선례)**뿐이다.
 * 그래서 "탄착점이 같다/다르다"는 hp 감소량(바디 25 vs 미스 0 — 이 테스트는
 * 헤드 50 갈래는 쓰지 않는다, 아래 참고)으로 관측한다.
 *
 * **기하 고정(이동 없음)**: A(사수)·B(피격자) 둘 다 'move'를 전혀 보내지
 * 않는다 — 스폰 지점(`initializePlayer`가 join 즉시 채우는 `moveStates`)에
 * 고정된 채로 전부 처리한다. `rq-12`처럼 실측 이동 후 거리를 쓰지 않은
 * 이유: 이 파일은 기하 자체가 아니라 시드 배선을 검증하는 것이라, 기하를
 * 최대한 단순·고정해 오프라인 오라클(아래) 계산이 실측과 어긋날 여지를
 * 없앴다.
 *
 * **오프라인 오라클(공허함 회피의 핵심)**: 이 테스트가 보낼 "원 조준
 * 방향"(스프레드 적용 전, 클라이언트가 실제로 보낼 값)은 A→B 바디 중심을
 * 정확히 겨냥한 단위 벡터다. 그 방향에 특정 시드로 스프레드를 얹으면 실제로
 * 명중/이탈 어느 쪽이 나올지는, **이미 결정론이 고정된 순수 함수
 * (`applySpread`+`raycastHitbox`+`eyeOrigin`, 전부 `src/shared` 기존
 * 구현)를 이 테스트 파일 안에서 그대로 호출**해 미리 계산한다(방금 관측한
 * A·B의 실제 좌표를 그대로 넣으므로 좌표를 하드코딩하지 않는다). 이 계산은
 * 진짜 무작위성이 전혀 없는 순수 산술이라 실행마다 항상 같은 답을 낸다
 * (플레이키 아님) — `findSeedWithBucket`이 이 오라클로 "반드시 바디에
 * 명중하는 시드"와 "반드시 빗나가는 시드"를 탐색해 고른다. 콘 반경(테스트
 * 전용 파라미터, `SPREAD_CONE_MULTIPLIER`)은 사전에 Node 스크래치
 * 스크립트로 실제 스폰 좌표(인접 스폰 지점 간 거리 ≈9.27m)에 대해 배율
 * 2~5 전부 시드 1~10 안에서 두 버킷을 즉시 찾아냄을 확인했다(보고서 참고,
 * 저장소에 커밋된 스크립트는 아니다) — `SEARCH_LIMIT`(5000)은 넉넉한
 * 안전 여유이지 아슬아슬한 값이 아니다.
 *
 * **이 파일이 밸런싱 값을 정하지 않는다**: `coneRadiusRad`는 이 테스트가
 * `spreadTuningOverride`로 **주입하는 값**일 뿐, `DEFAULT_SPREAD`(출하
 * 기본값, 여전히 0)를 바꾸지 않는다 — 게임 감각을 정하는 결정이 아니라
 * 시드가 결과에 드러나게 하는 시험 조건이다.
 *
 * **공허함 회피 — 세 단언의 역할**:
 *   (A) 재현성(양성, GA-17의 본문): 강제 시드 `seedHit`로 **두 번** 실제
 *       왕복 사격 → 둘 다 바디 명중·동일 데미지(25)여야 한다. **주의**:
 *       이 단언 하나만으로는 공허하다 — 만약 서버가 스프레드를 전혀 적용하지
 *       않는다면(오늘의 실제 상태) 원 조준이 바디 중심을 정확히 겨누므로
 *       이 두 발도 우연히 "똑같이 명중"해 버려 이 단언은 **오늘도 통과한다**
 *       (거짓 양성 위험 — 팀리드가 경고한 "공허함 함정"). 그래서 아래 (B)가
 *       반드시 필요하다.
 *   (B) 음성 대조군(GA-17이 실제로 Red가 되는 지점): 오프라인 오라클이
 *       "반드시 빗나감"으로 분류한 다른 시드 `seedMiss`로 **같은 조준·같은
 *       콘 반경**에서 쏘면 hp가 그대로여야 한다. 서버가 스프레드를 적용하지
 *       않는 오늘 상태에서는 이 시드도 원 조준 그대로 바디에 명중해 버려
 *       hp가 줄어든다 — 즉 이 단언이 **오늘 실패한다**(진짜 Red).
 *   (C) 구조 확인(양성, "부록"): (B)와 같은 `seedMiss`를 유지한 채 콘
 *       반경만 0으로 되돌리면(`spreadTuningOverride = { coneRadiusRad: 0 }`)
 *       다시 바디에 명중해야 한다 — `coneRadiusRad===0`이면 편차가 없다는
 *       계약(단위 테스트가 이미 고정)을 서버 배선에서도 재확인해, "콘 반경
 *       오버라이드 자체가 스프레드를 실제로 켜고 끈다"를 보여준다(우연한
 *       seed 궁합이 아니라).
 *
 * **결정론 메모**: 실 WebSocket(localhost, 임의 포트)에 의존한다(ADR-0008
 * 허용 예외, `rq-12`와 동일). 모든 대기에 `withTimeout()` 상한을 건다.
 * hp 변화 관측은 `onStateChange` 이벤트 기반 폴링(고정 슬립 아님)이고,
 * "변화 없음"(B) 확인만 예외적으로 고정 슬립 뒤 값을 읽는다(그 자체가
 * 확인 대상이라 이벤트 기반 대기가 부적합 — `rq-12`의 "무관한 방향" 테스트와
 * 동일한 필요성).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000

/** 연속 사격 사이 여유(ADR-0005 rate-limit 150ms + 네트워크 왕복 여유를
 * 모두 흡수) — "빗나감" 확인의 정착 대기로도 재사용한다. */
const SHOT_GAP_MS = 400

/** GA-06/GA-08/`rq-12`와 동일한 근거로 기하학적으로 항상 빗나가는 방향
 * (수직 위) — B가 자기 자신의 최초 입장 스폰 보호를 즉시 해제하는 용도로만
 * 쓴다(RQ-16 "사격하면 즉시 해제"). */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

/** 콘 반경 = (바디 반지름의 각반경) × 이 배율 — 테스트 전용 파라미터(밸런싱
 * 값 아님). 스크래치 검증(파일 상단 "오프라인 오라클" 참고)으로 2~5 배율
 * 전부 시드 한 자릿수 안에서 명중·이탈 버킷이 갈리는 것을 확인했다. */
const SPREAD_CONE_MULTIPLIER = 3
/** `findSeedWithBucket` 탐색 상한 — 순수 결정론 계산이라 느리지 않다
 * (수천 회도 밀리초 미만). 실제로는 한 자릿수 안에서 찾힘(위 스크래치
 * 검증) — 이 값은 넉넉한 안전 여유다. */
const SEARCH_LIMIT = 5_000

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

/** hp가 `previousHp`에서 실제로 바뀔 때까지 관측한다(어느 값으로 바뀌는지는
 * 호출자가 그 뒤 `expect`로 정확히 단언한다) — "다음 값"을 미리 단정하지
 * 않으므로, 구현이 예상과 다른 값을 내도 이 대기 자체는 그 값을 빠르게
 * 반환하고 실패는 뒤이은 `expect`가 즉시·명확한 값 불일치로 드러낸다(같은
 * predicate에 정확한 목표값을 박아 두면 오답일 때 타임아웃까지 기다려야
 * 하는 문제를 피한다). */
function waitForHpChange(room: Room, sessionId: string, previousHp: number, label: string): Promise<PlayerFields> {
  return withTimeout(
    new Promise<PlayerFields>((resolve) => {
      const tryResolve = (): void => {
        const current = readPlayer(room, sessionId)
        if (current && current.hp !== previousHp) resolve(current)
      }
      tryResolve()
      room.onStateChange(() => tryResolve())
    }),
    HP_TIMEOUT_MS,
    label,
  )
}

function bodyCenterM(): number {
  return (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
}

/** A(사수, 발 좌표)에서 B(피격자, 발 좌표)의 바디 중심을 정확히 겨냥하는
 * 단위 벡터와, 그 조준의 실제 3D 거리(콘 반경 스케일 산정에 쓴다) —
 * `rq-12-server-hitscan.test.ts`의 `aimAt`과 동일한 산식(거리도 함께
 * 반환하는 점만 다르다). */
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
 * `raycastHitbox`)를 그대로 호출해 "이 시드가 실제로 명중을 내는지"를
 * 미리 계산한다. 진짜 무작위성이 없으므로 몇 번을 다시 실행해도 항상 같은
 * 분류를 낸다(플레이키 아님). */
function classifySpreadSeed(origin: Vec3, aim: Vec3, targetFoot: Vec3, coneRadiusRad: number, seed: number): SpreadBucket {
  const deviated = applySpread(aim, createRng(seed), coneRadiusRad)
  const result = raycastHitbox({ origin, direction: deviated }, { position: targetFoot }, DEFAULT_HITBOX)
  if (!result.hit) return 'miss'
  return result.region === 'head' ? 'head' : 'body'
}

/** [1, searchLimit] 범위에서 `wanted` 버킷('body' 또는 'miss'만 — 'head'는
 * 이 파일이 쓰지 않는 갈래라 건너뛴다)에 해당하는 첫 시드를 찾는다. 방금
 * 관측한 A·B의 실제 좌표로 계산하므로 스폰 좌표를 하드코딩하지 않는다. */
function findSeedWithBucket(
  origin: Vec3,
  aim: Vec3,
  targetFoot: Vec3,
  coneRadiusRad: number,
  wanted: Extract<SpreadBucket, 'body' | 'miss'>,
  searchLimit: number,
): number {
  for (let seed = 1; seed <= searchLimit; seed += 1) {
    if (classifySpreadSeed(origin, aim, targetFoot, coneRadiusRad, seed) === wanted) return seed
  }
  throw new Error(
    `RQ-90 테스트 셋업 실패 — coneRadiusRad=${coneRadiusRad}에서 '${wanted}' 결과를 내는 시드를 1..${searchLimit} 범위에서 찾지 못했다(콘 반경 배율 조정 필요 — 실제 스폰 기하가 스크래치 검증 때와 달라졌을 수 있다).`,
  )
}

/** RQ-90 화이트박스 접근 대상 계약 — 파일 상단 "테스트 시드 주입 인터페이스"
 * 절 참고. 둘 다 아직 존재하지 않는 신규 필드다(Red 전제, 그린필드 계약) —
 * `GameRoom`이 `applySpread`를 전혀 호출하지 않는 오늘 상태에서 이 필드들도
 * 당연히 없다. */
interface SpreadTestSeam {
  spreadTuningOverride?: { coneRadiusRad: number }
  forcedSpreadSeed?: number
}

/** `matchMaker.getLocalRoomById`(`rq-18-fall-damage.test.ts`가 확립한 기법)로
 * 테스트 프로세스 안에서 실행 중인 실제 `GameRoom` 인스턴스를 얻는다. 룸을
 * 찾지 못하면(경로 오류) 이후 관측이 아니라 여기서 즉시 실패해 원인을
 * 분명히 한다. */
function getServerRoom(room: Room): SpreadTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as SpreadTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-90 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

describe('RQ-90/GA-17: 서버가 발급한 시드로 탄퍼짐을 적용하며, 같은 시드는 같은 탄착 결과를 재현한다', () => {
  let server: RunningServer

  beforeAll(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    await stopServer(server)
  })

  it(
    'RQ-90/GA-17: 강제된 동일 시드 2회는 동일 판정(바디 명중·동일 데미지)을 재현하고, 다른 시드는 다른 판정(빗나감)을 내며, 콘 반경을 0으로 되돌리면 다시 정조준 명중으로 돌아온다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수 — 이동하지 않는다(스폰 지점 고정)
      const roomB = await joinGame(newClient(server)) // 피격자 — 이동하지 않는다(스폰 지점 고정)

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      // RQ-16: B 자신의 최초 입장 스폰 보호를 즉시 해제(`rq-12`와 동일 패턴)
      // — 해제하지 않으면 아래 사격이 전부 무효화되어 스프레드 여부와
      // 무관하게 hp가 그대로일 것이다(공허함의 또 다른 경로).
      roomB.send('fire', UP_MISS_AIM)
      await sleep(SHOT_GAP_MS)

      const origin = eyeOrigin({ x: baselineA.x, y: baselineA.y, z: baselineA.z }, DEFAULT_HITBOX.eyeHeightM)
      const targetFoot: Vec3 = { x: baselineB.x, y: baselineB.y, z: baselineB.z }
      const { aim, distance } = aimAtBodyWithDistance(baselineA, baselineB)

      const coneRadiusRad = Math.atan(DEFAULT_HITBOX.bodyRadiusM / distance) * SPREAD_CONE_MULTIPLIER
      const seedHit = findSeedWithBucket(origin, aim, targetFoot, coneRadiusRad, 'body', SEARCH_LIMIT)
      const seedMiss = findSeedWithBucket(origin, aim, targetFoot, coneRadiusRad, 'miss', SEARCH_LIMIT)

      const seam = getServerRoom(roomA)
      seam.spreadTuningOverride = { coneRadiusRad }
      seam.forcedSpreadSeed = seedHit

      // --- (A) 재현성 1/2 — 강제 시드 `seedHit`로 첫 발.
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      const afterFirst = await waitForHpChange(roomB, roomB.sessionId, baselineB.hp, 'RQ-90 강제 시드 1발째 hp 변화 대기')
      expect(afterFirst.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY) // 100 -> 75, 오프라인 오라클의 'body' 예측과 일치

      await sleep(SHOT_GAP_MS)

      // --- (A) 재현성 2/2 — 같은 강제 시드로 동일 조준을 재현. 두 번째
      // 실제 왕복도 동일하게 바디 판정·동일 데미지가 나와야 "같은 시드 ->
      // 같은 탄착점"이 증명된다. (단, 이 단언 하나만으로는 공허하다 — 아래
      // (B)가 반드시 필요한 이유는 파일 상단 docblock 참고.)
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      const afterSecond = await waitForHpChange(roomB, roomB.sessionId, afterFirst.hp, 'RQ-90 강제 시드 2발째(재현) hp 변화 대기')
      expect(afterSecond.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * 2) // 75 -> 50, 1발째와 동일한 감소폭

      await sleep(SHOT_GAP_MS)

      // --- (B) 음성 대조군 — 오프라인 오라클이 '반드시 빗나감'으로 분류한
      // 다른 시드 `seedMiss`는, 같은 조준·같은 콘 반경에서도 다른 결과
      // (명중 실패)를 내야 한다. 이게 없으면 (A)의 "재현"이 시드와 무관하게
      // 항상 같은 결과를 내는 배선 결함(예: 스프레드 미적용 — 오늘의 실제
      // 상태)과 구별되지 않는다. **이 단언이 오늘 Red다**: 서버가 아직
      // 스프레드를 적용하지 않으므로 이 시드도 원 조준 그대로 바디에
      // 명중해 hp가 줄어든다.
      seam.forcedSpreadSeed = seedMiss
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      await sleep(SHOT_GAP_MS)
      const afterDifferentSeed = readPlayer(roomB, roomB.sessionId)
      expect(afterDifferentSeed?.hp).toBe(afterSecond.hp) // 변화 없음 — 실제로 빗나갔다(다른 시드 -> 다른 결과)

      await sleep(SHOT_GAP_MS)

      // --- (C) 구조 확인(양성, 부록) — 같은(빗나가는) `seedMiss`를 유지한
      // 채 콘 반경만 0(출하 기본값)으로 되돌리면, `applySpread`의 계약
      // (coneRadiusRad===0 -> 편차 없음, `tests/unit/sim-combat.test.ts`가
      // 이미 고정)에 따라 다시 정조준 명중이어야 한다 — 콘 반경 오버라이드
      // 자체가 실제로 스프레드를 켜고 끈다는 것을 보여준다(우연한 seed
      // 궁합이 아니라).
      seam.spreadTuningOverride = { coneRadiusRad: 0 }
      roomA.send('fire', { dirX: aim.x, dirY: aim.y, dirZ: aim.z })
      const afterRadiusZero = await waitForHpChange(roomB, roomB.sessionId, afterSecond.hp, 'RQ-90 콘 반경 0 복귀 후 hp 변화 대기')
      expect(afterRadiusZero.hp).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY * 3) // 50 -> 25, 다시 명중

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )
})
