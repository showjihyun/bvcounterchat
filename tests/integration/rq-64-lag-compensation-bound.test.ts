import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client, Room } from 'colyseus.js'
import { matchMaker } from 'colyseus'
import { buildServer } from '@server/index'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { NET, PLAYER, WEAPON } from '@shared/constants'
import { POSITION_HISTORY_CAPACITY, REWIND_CAP_TICKS, type PositionSnapshot } from '@shared/sim/rewind'

/**
 * RQ-64 랙 보상(Lag Compensation) — 서버 권위(RQ-61) 통합 테스트 (ADR-0005
 * "랙보상 확정" 절, ADR-0008: Colyseus 룸 경계, ADR-0011: 서버 판정 로직
 * Red-first 영역).
 *
 * 매핑된 골든 케이스: **GA-16** (`harness/evals/golden/track-a-product.jsonl`,
 * `verify` 필드가 이 파일 경로를 정확히 지정한다).
 * - given: 플레이어 A의 RTT가 300ms로 보고됨(200ms 상한 초과).
 * - when: A가 사격해 서버가 랙 보상을 위해 대상 플레이어의 위치를 과거로
 *   되감아 판정.
 * - then: 되감기는 200ms(30Hz 기준 6틱) 상한에서 절단되어 판정되며 300ms
 *   전체를 되감지 않는다. RTT 150ms 이내인 플레이어는 되감기가 그대로
 *   적용되어 정상 플레이가 보장된다.
 *
 * **레벨 분리(ADR-0008/ADR-0011)**: "RTT(ms) → 되감기 틱"의 정밀 산술 경계
 * (상한 200ms/6틱 정확 일치·초과 시 절단)와 "링버퍼에서 목표 틱을 찾는"
 * 순수 로직은 `tests/unit/sim-rewind.test.ts`(A계층, 결정론 — 틱·ms 정수만
 * 주입)가 이미 고정했다. 이 파일(B계층)은 그 산술이 실 `GameRoom`의 `fire`
 * 처리 파이프라인에 실제로 배선돼 있는지 — 즉 "사격 판정이 실제로 되감긴
 * 위치를 쓰는가"만 블랙박스(+화이트박스 상태 주입)로 확인한다.
 *
 * ---
 *
 * ## 설계 포크(정본은 `tests/unit/sim-rewind.test.ts` 상단 docblock)
 *
 * ADR-0005가 허용하는 두 되감기 양 출처("RTT" 또는 "마지막으로 확인한 서버
 * 틱") 중 **RTT(ms)**를 택했다 — RQ-64 원문의 직역이자, "확인한 틱" 방식이
 * 요구하는 별도 ack 프로토콜(클라가 서버 브로드캐스트 틱을 추적)을 신설하지
 * 않아도 된다. `fire` payload에 선택적 `rttMs: number` 필드가 추가된다
 * (ADR-0005 §결과가 유예해 둔 "타임스탬프/시퀀스" 자리를 이 필드가 채운다).
 * 상세 근거·`GameRoom` 배선 가정 4가지는 `sim-rewind.test.ts` 상단 "가정"
 * 절 참고 — 이 파일은 그 가정이 실제로 지켜지는지만 검증한다.
 *
 * ## "절단됐다"를 관측 가능하게 만드는 방법(이 라운드의 설계 난제)
 *
 * 실 시간(wall-clock)으로 "정확히 6틱 전 vs 9틱 전" 위치를 만들어내려 하면
 * 실측(`rq-18-fall-damage.test.ts` REV3~5, `sim-afk.test.ts`/
 * `rq-43-afk-kick.test.ts` A/B 분리 근거)이 이미 보여준 것과 같은 종류의
 * 비결정론에 빠진다 — 30Hz 틱(≈33ms) 경계를 실 네트워크·이벤트 루프
 * 스케줄링으로 정확히 맞히는 것은 신뢰할 수 없다. 그래서 이 파일은 위치
 * **자체**를 실제 이동이 아니라 화이트박스로 링버퍼(`positionHistory`)에
 * 직접 주입한다(`rq-18-fall-damage.test.ts`·`rq-43-afk-kick.test.ts`가 이미
 * 확립한 "테스트 프로세스 안에서 실행 중인 `GameRoom`에 `matchMaker
 * .getLocalRoomById`로 직접 접근" 기법의 연장) — 링버퍼의 각 틱 스냅샷을
 * 테스트가 원하는 좌표로 정확히 고정하므로, 실 네트워크 타이밍과 무관하게
 * 결정론적으로 "N틱 전 위치"를 재현할 수 있다.
 *
 * **이중 안전장치로 타이밍 오차(백색 상자 주입과 실제 `fire` 처리 사이의
 * 아주 짧은 지연)에 견고하게 만든다**:
 * 1. **틱 번호 여유** — "명중해야 할" 스냅샷은 항상 주입한 스냅샷 중
 *    가장 최근(가장 큰 tick) 것으로 둔다. `sampleRewoundPosition`은
 *    "목표 틱 이하 중 가장 가까운 것"을 반환하므로(내림/floor), 실제
 *    처리 시점이 주입 시점보다 몇 틱 늦어져도(주입 직후 동기적으로 바로
 *    `fire`를 보내므로 실제로는 대개 0틱) 목표 틱이 계속 증가할 뿐 이
 *    "가장 최근" 스냅샷보다 작아지는 일이 없다 — 즉 정답(캡 적용) 시나리오는
 *    지연에 **완전히 견고**하다.
 * 2. **기하학적 이중 방어** — "빗나가야 할" 스냅샷은 사수 **뒤쪽**(조준
 *    방향의 반대편)에 둔다. `raycastHitbox`의 "가정 B"(레이는 전방(t≥0)만
 *    판정)에 따라 사수 뒤쪽의 점은 어떤 거리에 있든 기하학적으로 명중이
 *    불가능하다 — 틱 번호가 정확히 어느 시점에 걸리는지와 무관하게, 오직
 *    "그 스냅샷이 선택됐는가"만으로 빗나감이 보장된다. 두 안전장치가 함께
 *    작동하므로, 실제 처리 지연이 몇 틱(수십ms) 있어도 이 파일의 판정은
 *    바뀌지 않는다(자세한 수치 근거는 각 `it()` 주석 참고).
 *
 * ## 대기 술어 원칙(팀리드 지시 — 근거를 이 파일에 남긴다)
 *
 * - **단조·안정 신호만 기다린다**: HP 감소(`hp < baseline`)·서버 틱 전진
 *   (`tick > sinceTick`)·`positionHistory` 키 소멸은 전부 한번 참이 되면
 *   계속 참인 단조 신호다(중간 상태를 관측하려 하지 않는다 — 틱 캐치업이
 *   중간 상태를 통째로 건너뛸 수 있다는 것은 `rq-18` REV3가 이미 실증했다).
 * - **구독 시점에 술어가 거짓임이 시간 하한으로 보장된다**: 모든 대기는
 *   `fire`/`leave` 전송 **직후** 시작하고, 그 직전에 읽은 baseline(hp·tick)
 *   과 비교하는 조건이라 구독 시작 순간에는 아직 거짓이다(경합 없음).
 * - **화이트박스로 서버를 동기 조작했으면 검증도 서버를 직접 읽는다**
 *   (`seam.state.players.get(id).hp`, `seam.state.tick`) — 클라이언트 패치
 *   (기본 20Hz)를 기다리는 간접 경로를 쓰지 않는다. `handleFire`는 메시지
 *   수신과 동기로 HP를 갱신하므로, 서버 프로세스 안의 살아있는 상태를 직접
 *   폴링하면 패치 배치 지연과 무관하게 결과를 확인할 수 있다.
 * - **자기 시야로 자기 소속·자기 HP를 읽지 않는다** — 모든 관측은 서버
 *   화이트박스 또는 사수(제3자) 세션의 시야로 한다.
 * - **케이스마다 서버를 새로 띄운다**(`beforeEach`/`afterEach`) — 이전
 *   케이스의 화이트박스 주입·이동 상태가 다음 케이스에 새지 않는다.
 *
 * ## 양성 대조군(공허화 방지)
 *
 * "명중" 단언은 되감기가 전혀 없어도(항상 현재 위치 사용) 통과할 수 있는
 * 취약한 단언이다 — 이 파일의 모든 "명중" 케이스는 대상의 **현재** 위치(및
 * 스폰 지점)가 조준한 지점과 겹치지 않도록 좌표를 설계해, "빗나가야 할"
 * 스냅샷(사수 뒤쪽 또는 상한을 넘겨 절단됐어야 할 더 오래된 스냅샷)이
 * 실제로 선택되면 반드시 빗나가게 만든다(각 `it()`의 미끼 스냅샷 참고).
 *
 * ## 스코프 밖
 *
 * 탄퍼짐(RQ-90/94 별도 라운드)·헤드샷 볼륨 정밀화(RQ-13 기구현)·클라 HUD
 * 표시·안티치트(§11 비요구사항)·"RTT를 어떻게 측정하는가"(클라이언트 구현,
 * 이 RQ는 서버가 보고값을 신뢰하지 않고 방어적으로 절단하는 것만 다룬다).
 */

const ROOM_NAME = 'game'
const LISTEN_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 5_000
const JOIN_TIMEOUT_MS = 5_000
const LEAVE_TIMEOUT_MS = 5_000
const HP_TIMEOUT_MS = 5_000
const TICK_ADVANCE_TIMEOUT_MS = 5_000
const HISTORY_CLEANUP_TIMEOUT_MS = 5_000
/** 서버 화이트박스 상태 폴링 간격 — `rq-18-fall-damage.test.ts`
 * `TAKEOFF_POLL_INTERVAL_MS`와 동일 근거(단일 틱이 아니라 훨씬 넓은 창을
 * 노리므로 15ms 간격이면 충분히 여러 번 샘플링한다). */
const SERVER_POLL_INTERVAL_MS = 15

/** 자기 사격(스폰 보호 해제, RQ-16)이 서버에 반영될 시간 — 기존
 * RQ-12/15/16/18 파일들과 동일한 값·동일한 근거. */
const SELF_FIRE_SETTLE_MS = 300
/** 실 이동 시나리오(회귀·누적 확인)의 이동 시간·정착 여유 — `rq-12`의
 * `TRAVEL_MS`/`SETTLE_MS`와 동일한 값·근거. */
const TRAVEL_MS = 900
const SETTLE_MS = 200
/** 위치 이력 누적 확인용 — 20 tick(≈667ms)보다 훨씬 길게 이동시켜 버퍼가
 * 확실히 트림 경계(`POSITION_HISTORY_CAPACITY`)를 넘어서게 한다. */
const HISTORY_ACCUMULATE_MOVE_MS = 2_000

/** 사수 기준 전방/후방 10m — 히트박스 반지름(0.3m)·헤드 반지름(0.12m)에
 * 비해 충분히 크고, 스폰 지점 배치 반지름(≈22m, `spawn.ts`)보다는 작아
 * 월드 밖으로 나가지 않는다. */
const AIM_DISTANCE_M = 10

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

/** GA-06/GA-08/RQ-16 파일들과 동일한 근거로 기하학적으로 항상 빗나가는
 * 방향(수직 위) — 자기 자신을 쏘면 스폰 보호(RQ-16)가 즉시 해제된다. */
const UP_MISS_AIM = { dirX: 0, dirY: 1, dirZ: 0 }

async function clearSpawnProtection(room: Room): Promise<void> {
  room.send('fire', UP_MISS_AIM)
  await sleep(SELF_FIRE_SETTLE_MS)
}

interface Foot {
  x: number
  y: number
  z: number
}

interface PlayerFields extends Foot {
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

/** 실 이동(레거시 회귀 케이스 전용) — `dir`로 `TRAVEL_MS`만큼 실제 이동시킨
 * 뒤 정지시키고, 실제로 도달한 최종 위치를 읽는다(가정한 거리에 결합하지
 * 않는다) — `rq-12-server-hitscan.test.ts`의 `travelAndSettle`과 동일한
 * 근거·구조(사수·대상 어느 쪽에도 적용 가능하도록 방향을 인자로 뺐다). */
async function travelAndSettle(mover: Room, dir: { dirX: number; dirZ: number }): Promise<PlayerFields> {
  mover.send('move', { dirX: dir.dirX, dirZ: dir.dirZ, mode: 'run', jump: false })
  await sleep(TRAVEL_MS)
  mover.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
  await sleep(SETTLE_MS)
  const settled = readPlayer(mover, mover.sessionId)
  if (!settled) throw new Error('travelAndSettle: 이동 후 위치 관측 실패')
  return settled
}

/** 화이트박스 접근 대상 계약 — `tests/unit/sim-rewind.test.ts` 상단
 * "가정(coder에게)" 절 참고. `positionHistory`는 아직 존재하지 않는 신규
 * private map이다(Red 전제). `moveStates`는 RQ-20 때부터 있던 기존
 * private map을 읽기 전용으로 노출할 뿐이다(`rq-18-fall-damage.test.ts`
 * `FallDamageTestSeam`과 동일한 결합 방식). `state`는 `Room.state`(public)
 * 그대로다. */
interface RewindTestSeam {
  state: {
    tick: number
    players: { get: (sessionId: string) => { hp?: number } | undefined }
  }
  moveStates: Map<string, Foot>
  positionHistory: Map<string, PositionSnapshot[]>
}

/** `matchMaker.getLocalRoomById`(`rq-18-fall-damage.test.ts`·
 * `rq-43-afk-kick.test.ts`가 이미 확립한 기법)로 테스트 프로세스 안에서
 * 실행 중인 실제 `GameRoom` 인스턴스를 얻는다. */
function getServerRoom(room: Room): RewindTestSeam {
  const serverRoom = matchMaker.getLocalRoomById(room.roomId) as unknown as RewindTestSeam | undefined
  if (!serverRoom) {
    throw new Error(`RQ-64 화이트박스 접근 실패 — matchMaker.getLocalRoomById('${room.roomId}')가 룸을 찾지 못했다`)
  }
  return serverRoom
}

/** 서버 권위 HP를 직접 폴링한다(화이트박스로 조작했으므로 검증도 화이트박스로
 * — 파일 상단 "대기 술어 원칙" 참고). 클라이언트 패치(20Hz)를
 * 기다리지 않으므로 `handleFire`의 동기 처리 이후 지연 없이 확인된다. */
function waitForServerHp(
  seam: RewindTestSeam,
  sessionId: string,
  predicate: (hp: number) => boolean,
  label: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tryResolve = (): boolean => {
      const hp = seam.state.players.get(sessionId)?.hp
      if (typeof hp === 'number' && predicate(hp)) {
        resolve(hp)
        return true
      }
      return false
    }
    if (tryResolve()) return
    const interval = setInterval(() => {
      if (tryResolve()) {
        clearInterval(interval)
        clearTimeout(timeout)
      }
    }, SERVER_POLL_INTERVAL_MS)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`[timeout ${timeoutMs}ms] ${label}`))
    }, timeoutMs)
  })
}

/** "크래시하지 않았다"를 "서버가 이후에도 계속 틱을 전진시킨다"는 안정
 * 신호로 확인한다 — 예외가 `onMessage` 핸들러나 틱 루프를 죽이면 이후
 * `state.tick`이 더 이상 갱신되지 않는다. */
function waitForServerTickAdvance(seam: RewindTestSeam, sinceTick: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tryResolve = (): boolean => {
      if (seam.state.tick > sinceTick) {
        resolve()
        return true
      }
      return false
    }
    if (tryResolve()) return
    const interval = setInterval(() => {
      if (tryResolve()) {
        clearInterval(interval)
        clearTimeout(timeout)
      }
    }, SERVER_POLL_INTERVAL_MS)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`[timeout ${timeoutMs}ms] RQ-64: 화이트박스 사격 처리 후 서버 틱 전진(크래시하지 않았음) 확인 대기`))
    }, timeoutMs)
  })
}

/** `onLeave`가 세션 전유 부기 맵을 정리하는 관례(22k 회귀 가드 선례)의
 * 연장 — `positionHistory`에서 해당 세션 키가 사라질 때까지 서버 상태를
 * 직접 폴링한다. */
function waitForHistoryCleanup(seam: RewindTestSeam, sessionId: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tryResolve = (): boolean => {
      if (!seam.positionHistory.has(sessionId)) {
        resolve()
        return true
      }
      return false
    }
    if (tryResolve()) return
    const interval = setInterval(() => {
      if (tryResolve()) {
        clearInterval(interval)
        clearTimeout(timeout)
      }
    }, SERVER_POLL_INTERVAL_MS)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`[timeout ${timeoutMs}ms] RQ-64: onLeave 이후 positionHistory 정리 확인 대기`))
    }, timeoutMs)
  })
}

function bodyCenterM(): number {
  return (DEFAULT_HITBOX.bodyBottomM + DEFAULT_HITBOX.bodyTopM) / 2
}

/** `rq-12-server-hitscan.test.ts`의 `aimAt`과 동일 — 사수(발 위치)에서
 * 대상(발 위치)의 바디 중심을 정확히 조준하는 방향 벡터(정규화). */
function aimAt(shooter: Foot, target: Foot, verticalCenterM: number): { dirX: number; dirY: number; dirZ: number } {
  const dx = target.x - shooter.x
  const dz = target.z - shooter.z
  const dy = verticalCenterM - DEFAULT_HITBOX.eyeHeightM
  const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz)
  return { dirX: dx / magnitude, dirY: dy / magnitude, dirZ: dz / magnitude }
}

/**
 * `direction`과 **정확히 수직**인 오프셋 벡터(크기 `magnitudeM`)를 만든다 —
 * `@shared/sim/combat`의 `applySpread`가 콘 기저를 만들 때 쓰는 것과 동일한
 * "가장 덜 정렬된 축을 helper로 골라 외적" 기법(`Math.abs(d.x) < 0.9`
 * 분기 — 임의의 단위 벡터 d와 결코 평행하지 않는 helper를 보장한다).
 *
 * **왜 "단순히 z축으로 오프셋"이 아니라 이 함수인가**: 원점을 임의의
 * 고정 벡터 Δ로 평행이동하면 레이 전체가 Δ만큼 평행이동하고, 명중 지점도
 * 정확히 Δ만큼 밀린다 — 그런데 그 밀림 중 **레이 방향과 나란한 성분은
 * 소거되고 수직 성분만 실제 "빗나간 거리"로 남는다**(레이 위의 다른
 * 파라미터 t에서 다시 가까워질 수 있기 때문). Δ가 우연히 조준 방향에 거의
 * 나란하면(수직 성분이 작으면) 물리적으로 큰 오프셋을 줘도 실제 빗나가는
 * 거리는 작아질 수 있다 — 이 함수는 Δ를 애초에 방향과 **정확히 수직**으로
 * 골라 그 감쇠를 원천적으로 없앤다(수직 성분 = Δ 전체, 100% 반영).
 */
function perpendicularOffset(direction: { dirX: number; dirY: number; dirZ: number }, magnitudeM: number): Foot {
  const d = { x: direction.dirX, y: direction.dirY, z: direction.dirZ }
  const helper = Math.abs(d.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const cx = helper.y * d.z - helper.z * d.y
  const cy = helper.z * d.x - helper.x * d.z
  const cz = helper.x * d.y - helper.y * d.x
  const len = Math.sqrt(cx * cx + cy * cy + cz * cz)
  return { x: (cx / len) * magnitudeM, y: (cy / len) * magnitudeM, z: (cz / len) * magnitudeM }
}

describe('RQ-64/GA-16: RTT 300ms(상한 초과) — 되감기는 6틱(200ms)에서 절단되고 300ms 전체를 되감지 않는다', () => {
  let server: RunningServer

  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  it(
    'GA-16: 대상이 6틱 전 위치엔 있었고(조준 지점) 9틱 전(300ms 자연값)·그보다 과거엔 없었다(사수 뒤쪽 미끼) — RTT 300ms 사격은 명중한다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수
      const roomB = await joinGame(newClient(server)) // 대상 — 위치는 화이트박스로 직접 제어

      await clearSpawnProtection(roomB) // RQ-16 — 보호 중이면 피해가 무효화돼 이 테스트가 성립하지 않는다

      const seam = getServerRoom(roomA)
      const shooterFoot = seam.moveStates.get(roomA.sessionId)
      if (!shooterFoot) throw new Error('RQ-64: 사수의 moveStates 스냅샷을 찾지 못했다')

      const baselineHp = seam.state.players.get(roomB.sessionId)?.hp
      expect(baselineHp).toBe(PLAYER.MAX_HP)

      // 명중해야 할 지점(사수 전방 10m, 정확히 상한과 일치하는 6틱 전) —
      // "이중 안전장치 1"(가장 최근 스냅샷) 대상.
      const hitFoot: Foot = { x: shooterFoot.x + AIM_DISTANCE_M, y: shooterFoot.y, z: shooterFoot.z }
      // 빗나가야 할 지점(사수 후방 10m, 9틱 전을 포함해 그보다 더 과거) —
      // "이중 안전장치 2"(레이 후방 배제, `raycastHitbox` 가정 B)의 대상.
      const missFoot: Foot = { x: shooterFoot.x - AIM_DISTANCE_M, y: shooterFoot.y, z: shooterFoot.z }

      const currentTick = seam.state.tick
      seam.positionHistory.set(roomB.sessionId, [
        { tick: currentTick - REWIND_CAP_TICKS, x: hitFoot.x, y: hitFoot.y, z: hitFoot.z },
        // REWIND_CAP_TICKS(6) + 14 = 20틱 전 — 300ms의 자연값(9틱)을 포함해
        // 그보다 한참 과거까지 전부 이 미끼로 절단되도록 넉넉한 여유를 둔다.
        { tick: currentTick - (REWIND_CAP_TICKS + 14), x: missFoot.x, y: missFoot.y, z: missFoot.z },
      ])

      const aim = aimAt(shooterFoot, hitFoot, bodyCenterM())
      roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ, rttMs: 300 })

      const afterShot = await waitForServerHp(
        seam,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'RQ-64/GA-16: RTT 300ms 사격 후 B의 HP 감소(명중) 대기',
        HP_TIMEOUT_MS,
      )
      expect(afterShot).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    20_000,
  )

  it(
    '보강(더 큰 마진) — RTT 1000ms(자연값 30틱, 상한의 5배)도 동일하게 6틱에서 절단된다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      await clearSpawnProtection(roomB)

      const seam = getServerRoom(roomA)
      const shooterFoot = seam.moveStates.get(roomA.sessionId)
      if (!shooterFoot) throw new Error('RQ-64: 사수의 moveStates 스냅샷을 찾지 못했다')

      const hitFoot: Foot = { x: shooterFoot.x + AIM_DISTANCE_M, y: shooterFoot.y, z: shooterFoot.z }
      const missFoot: Foot = { x: shooterFoot.x - AIM_DISTANCE_M, y: shooterFoot.y, z: shooterFoot.z }

      const currentTick = seam.state.tick
      seam.positionHistory.set(roomB.sessionId, [
        { tick: currentTick - REWIND_CAP_TICKS, x: hitFoot.x, y: hitFoot.y, z: hitFoot.z },
        // 30틱(1000ms 자연값)보다도 훨씬 과거 — 버퍼에 그 틱의 스냅샷이
        // 아예 없으므로 "가장 오래된 것으로 절단"(sim-rewind 계약) 경로를
        // 타도, 그 절단 결과가 바로 이 미끼(사수 뒤쪽)다.
        { tick: currentTick - (REWIND_CAP_TICKS + 14), x: missFoot.x, y: missFoot.y, z: missFoot.z },
      ])

      const baselineHp = seam.state.players.get(roomB.sessionId)?.hp
      expect(baselineHp).toBe(PLAYER.MAX_HP)

      const aim = aimAt(shooterFoot, hitFoot, bodyCenterM())
      roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ, rttMs: 1000 })

      const afterShot = await waitForServerHp(
        seam,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'RQ-64(보강): RTT 1000ms 사격 후 B의 HP 감소(명중) 대기',
        HP_TIMEOUT_MS,
      )
      expect(afterShot).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    20_000,
  )
})

describe('RQ-64: RTT 100ms(150ms 예산 이내) — 절단 없이 자연값(3틱)만큼만 되감고, 상한(6틱)을 임의로 쓰지 않는다', () => {
  let server: RunningServer

  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  it(
    'RTT 100ms(msToTicks(100)=3틱 정확)로 조준한 3틱 전 위치는 명중하고, "항상 상한(6틱)을 쓰는" 버그가 있었다면 명중했을 미끼(6틱 전)는 빗나간다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      await clearSpawnProtection(roomB)

      const seam = getServerRoom(roomA)
      const shooterFoot = seam.moveStates.get(roomA.sessionId)
      if (!shooterFoot) throw new Error('RQ-64: 사수의 moveStates 스냅샷을 찾지 못했다')

      const baselineHp = seam.state.players.get(roomB.sessionId)?.hp
      expect(baselineHp).toBe(PLAYER.MAX_HP)

      const hitFoot: Foot = { x: shooterFoot.x + AIM_DISTANCE_M, y: shooterFoot.y, z: shooterFoot.z }
      // "항상 상한(REWIND_CAP_TICKS=6)을 쓰는" 회귀를 잡는 미끼 — 사수
      // 뒤쪽이라 어떤 시점 오차에도 기하학적으로 명중 불가능(가정 B).
      const missFoot: Foot = { x: shooterFoot.x - AIM_DISTANCE_M, y: shooterFoot.y, z: shooterFoot.z }

      const currentTick = seam.state.tick
      seam.positionHistory.set(roomB.sessionId, [
        { tick: currentTick - 3, x: hitFoot.x, y: hitFoot.y, z: hitFoot.z }, // RTT 100ms의 정확한 자연값
        { tick: currentTick - REWIND_CAP_TICKS, x: missFoot.x, y: missFoot.y, z: missFoot.z },
      ])

      const aim = aimAt(shooterFoot, hitFoot, bodyCenterM())
      roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ, rttMs: 100 })

      const afterShot = await waitForServerHp(
        seam,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'RQ-64: RTT 100ms 사격 후 B의 HP 감소(명중) 대기',
        HP_TIMEOUT_MS,
      )
      expect(afterShot).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    20_000,
  )
})

describe('RQ-64: RTT 0/미보고 — 되감기 없이 현재 위치로 판정한다(회귀 방지, 실 이동)', () => {
  let server: RunningServer

  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  it(
    'rttMs 필드가 아예 없는 레거시 fire 페이로드 — 실제로 이동해 정착한 현재 위치를 그대로 조준하면 명중한다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수
      const roomB = await joinGame(newClient(server)) // +X로 이동, 피격자

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      await clearSpawnProtection(roomB)
      const settledB = await travelAndSettle(roomB, { dirX: 1, dirZ: 0 })
      expect(settledB.x).toBeGreaterThan(baselineB.x) // 실제로 이동했다는 전제 확인

      const aim = aimAt(baselineA, settledB, bodyCenterM())
      // rttMs 필드를 아예 싣지 않는다 — 이 RQ 이전의 fire payload와 동일한 shape.
      roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ })

      const seam = getServerRoom(roomA)
      const afterShot = await waitForServerHp(
        seam,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'RQ-64: rttMs 미보고 사격 후 B의 HP 감소(명중, 현재 위치 판정) 대기',
        HP_TIMEOUT_MS,
      )
      expect(afterShot).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )

  it(
    'rttMs: 0을 명시적으로 보내도 동일하게 현재 위치로 판정한다',
    async () => {
      const roomA = await joinGame(newClient(server))
      const roomB = await joinGame(newClient(server))

      const baselineA = await waitForDefinedPlayer(roomA, roomA.sessionId)
      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      expect(baselineB.hp).toBe(PLAYER.MAX_HP)

      await clearSpawnProtection(roomB)
      const settledB = await travelAndSettle(roomB, { dirX: 1, dirZ: 0 })
      expect(settledB.x).toBeGreaterThan(baselineB.x)

      const aim = aimAt(baselineA, settledB, bodyCenterM())
      roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ, rttMs: 0 })

      const seam = getServerRoom(roomA)
      const afterShot = await waitForServerHp(
        seam,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'RQ-64: rttMs=0 사격 후 B의 HP 감소(명중, 현재 위치 판정) 대기',
        HP_TIMEOUT_MS,
      )
      expect(afterShot).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )
})

describe('RQ-64: 변조된 rttMs(문자열·음수)가 되감기를 우회하지 못한다(RQ-61 방어, 22l 전례)', () => {
  let server: RunningServer

  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  /**
   * 두 케이스가 공유하는 셋업. **주의(구현 가정에 결합하지 않기 위한
   * 설계)**: rewindTicks=0(정상 케이스)일 때 `handleFire`가 `positionHistory`
   * 의 "현재 틱" 항목을 조회하는지, 아니면 `moveStates`로 직접 폴백하는지는
   * 이 파일이 규정하지 않는다(둘 다 유효한 구현 선택) — 그래서 "명중"
   * 미끼를 임의 좌표가 아니라 **B의 실제(moveStates) 현재 위치**로 두고,
   * `positionHistory`의 "현재 틱" 항목도 그 값과 일치시킨다(둘 중 어느
   * 경로를 타도 같은 값). 6틱 전(REWIND_CAP_TICKS) 미끼(사수 뒤쪽)만
   * "되감기가 어떤 값으로든 잘못 적용됐을 때" 선택될 가짜 값이다.
   */
  async function setupDecoyHistory(server: RunningServer): Promise<{
    roomA: Room
    roomB: Room
    seam: RewindTestSeam
    shooterFoot: Foot
    bFoot: Foot
  }> {
    const roomA = await joinGame(newClient(server))
    const roomB = await joinGame(newClient(server))

    await clearSpawnProtection(roomB)

    const seam = getServerRoom(roomA)
    const shooterFoot = seam.moveStates.get(roomA.sessionId)
    const bFoot = seam.moveStates.get(roomB.sessionId)
    if (!shooterFoot || !bFoot) throw new Error('RQ-64: moveStates 스냅샷을 찾지 못했다')

    const missFoot: Foot = { x: shooterFoot.x - AIM_DISTANCE_M, y: shooterFoot.y, z: shooterFoot.z }

    const currentTick = seam.state.tick
    seam.positionHistory.set(roomB.sessionId, [
      { tick: currentTick, x: bFoot.x, y: bFoot.y, z: bFoot.z }, // 되감기 없음(0틱)일 때 쓰일 값 — B의 실제 현재 위치와 동일
      { tick: currentTick - REWIND_CAP_TICKS, x: missFoot.x, y: missFoot.y, z: missFoot.z }, // 되감기가 적용되면(어떤 값으로든) 쓰일 값
    ])

    return { roomA, roomB, seam, shooterFoot, bFoot }
  }

  it(
    'rttMs가 문자열("300")이면 숫자로 취급되지 않아(sanitizeFireInput typeof 방어) 되감기가 적용되지 않고 현재 위치로 명중한다',
    async () => {
      const { roomA, roomB, seam, shooterFoot, bFoot } = await setupDecoyHistory(server)
      const baselineHp = seam.state.players.get(roomB.sessionId)?.hp
      expect(baselineHp).toBe(PLAYER.MAX_HP)

      const aim = aimAt(shooterFoot, bFoot, bodyCenterM())
      roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ, rttMs: '300' })

      const afterShot = await waitForServerHp(
        seam,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'RQ-64: rttMs 문자열 사격 후 B의 HP 감소(명중, 되감기 미적용) 대기',
        HP_TIMEOUT_MS,
      )
      expect(afterShot).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    20_000,
  )

  it(
    'rttMs가 음수(-500)면 0으로 방어돼 되감기가 적용되지 않고 현재 위치로 명중한다',
    async () => {
      const { roomA, roomB, seam, shooterFoot, bFoot } = await setupDecoyHistory(server)
      const baselineHp = seam.state.players.get(roomB.sessionId)?.hp
      expect(baselineHp).toBe(PLAYER.MAX_HP)

      const aim = aimAt(shooterFoot, bFoot, bodyCenterM())
      roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ, rttMs: -500 })

      const afterShot = await waitForServerHp(
        seam,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'RQ-64: rttMs 음수 사격 후 B의 HP 감소(명중, 되감기 미적용) 대기',
        HP_TIMEOUT_MS,
      )
      expect(afterShot).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    20_000,
  )
})

describe('RQ-64: 되감기는 대상에게만 적용된다 — 사수 자신의 레이 원점은 되감기지 않는다', () => {
  let server: RunningServer

  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  it(
    '사수 A가 실제 이동으로 새 위치(P2)에 정착한 뒤, A 자신의 과거(화이트박스 주입, P1=P2를 조준 방향과 수직으로 10m 평행이동)는 무시하고 P2를 원점으로 B를 조준·명중시킨다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수 — 실제로 이동
      const roomB = await joinGame(newClient(server)) // 대상 — 스폰 위치 고정

      await clearSpawnProtection(roomB) // B가 맞아야 하므로 보호 해제 필요

      const baselineB = await waitForDefinedPlayer(roomB, roomB.sessionId)
      const bFoot: Foot = { x: baselineB.x, y: baselineB.y, z: baselineB.z }

      // A를 실제로 이동시켜 새 위치(P2)에 정착시킨다 — rq-12의 travelAndSettle과
      // 동일한 절차를 대상이 아니라 사수에게 적용한다.
      const settledA = await travelAndSettle(roomA, { dirX: 1, dirZ: 0 })

      const seam = getServerRoom(roomA)
      const baselineHp = seam.state.players.get(roomB.sessionId)?.hp
      expect(baselineHp).toBe(PLAYER.MAX_HP)

      // A의 실제(현재) 위치 P2에서 B를 정확히 조준하는 고정 방향 벡터.
      const aim = aimAt(settledA, bFoot, bodyCenterM())

      // A 자신의 가짜 과거 위치(P1) — P2를 **조준 방향과 정확히 수직**으로
      // 10m 평행이동한 지점(`perpendicularOffset`, 위 docblock의 기하학적
      // 근거 참고). 원점을 레이 방향과 수직인 Δ로 평행이동하면 레이 전체가
      // Δ만큼 평행이동하고, 그 수직 성분은 감쇠 없이 그대로 "빗나간 거리"가
      // 된다 — 원래 레이가 B를 정확히 지나가도록 조준했으므로, 평행이동된
      // 레이는 B가 아니라 "B+Δ"를 지나가며 B 자체와는 정확히 |Δ|=10m
      // (히트박스 반지름 0.3m보다 훨씬 큼) 떨어진다. 조준 방향·A·B의 실제
      // 상대 위치가 무엇이든 항상 성립하는 대수적 사실이라 실측 좌표(스폰
      // 지점 배치)에 의존하지 않는다 — 즉 이 P1이 원점으로 쓰이면(회귀)
      // 반드시 빗나간다.
      const offset = perpendicularOffset(aim, 10)
      const currentTick = seam.state.tick
      seam.positionHistory.set(roomA.sessionId, [
        { tick: currentTick - 3, x: settledA.x + offset.x, y: settledA.y + offset.y, z: settledA.z + offset.z },
      ])

      roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ, rttMs: 300 })

      const afterShot = await waitForServerHp(
        seam,
        roomB.sessionId,
        (hp) => hp < PLAYER.MAX_HP,
        'RQ-64: 사수 자신은 되감기지 않아야 명중하는 사격의 HP 감소 대기 — 타임아웃되면 사수가 잘못 되감겼다는 증거',
        HP_TIMEOUT_MS,
      )
      expect(afterShot).toBe(PLAYER.MAX_HP - WEAPON.DAMAGE_BODY)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomB)])
    },
    30_000,
  )
})

describe('RQ-64: 접속 직후(링버퍼 미충전) 되감기 요청도 크래시·hang 없이 처리된다', () => {
  let server: RunningServer

  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  it(
    '방금 접속한 C(위치 이력 < REWIND_CAP_TICKS)를 큰 RTT로 조준해도 서버가 계속 정상 동작한다(가장 오래된 스냅샷으로 절단)',
    async () => {
      const roomA = await joinGame(newClient(server)) // 사수
      const roomC = await joinGame(newClient(server)) // 방금 접속 — 위치 이력이 아직 짧다

      const seam = getServerRoom(roomA)

      // 전제 확인(공허화 방지) — 아직 REWIND_CAP_TICKS만큼 채워지지 않았다.
      const freshHistory = seam.positionHistory.get(roomC.sessionId) ?? []
      expect(freshHistory.length).toBeLessThan(REWIND_CAP_TICKS)

      const cFoot = seam.moveStates.get(roomC.sessionId)
      const shooterFoot = seam.moveStates.get(roomA.sessionId)
      if (!cFoot || !shooterFoot) throw new Error('RQ-64: moveStates 스냅샷을 찾지 못했다')

      const aim = aimAt(shooterFoot, cFoot, bodyCenterM())
      const tickBeforeFire = seam.state.tick
      // 버퍼가 짧아도 되감기 요청(rttMs=300, 자연값 9틱 요구)이 크래시하지
      // 않아야 한다 — C가 스폰 보호 중이라 HP 변화는 기대하지 않는다(이
      // 케이스의 목적은 "명중 여부"가 아니라 "죽지 않는다"이다).
      roomA.send('fire', { dirX: aim.dirX, dirY: aim.dirY, dirZ: aim.dirZ, rttMs: 300 })

      await waitForServerTickAdvance(seam, tickBeforeFire, TICK_ADVANCE_TIMEOUT_MS)

      await Promise.all([leaveRoom(roomA), leaveRoom(roomC)])
    },
    15_000,
  )
})

describe('RQ-64: 실제 이동으로 위치 이력이 누적되고, 접속 시간과 무관하게 무한정 커지지 않는다', () => {
  let server: RunningServer

  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  it(
    `${HISTORY_ACCUMULATE_MOVE_MS}ms(≈${Math.round(HISTORY_ACCUMULATE_MOVE_MS / NET.TICK_MS)}틱) 이동 후에도 위치 이력 길이는 POSITION_HISTORY_CAPACITY(${POSITION_HISTORY_CAPACITY})를 넘지 않는다`,
    async () => {
      const roomB = await joinGame(newClient(server))
      await waitForDefinedPlayer(roomB, roomB.sessionId)

      roomB.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
      await sleep(HISTORY_ACCUMULATE_MOVE_MS)
      roomB.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
      await sleep(SETTLE_MS)

      const seam = getServerRoom(roomB)
      const history = seam.positionHistory.get(roomB.sessionId)
      expect(history).toBeDefined()
      expect(history!.length).toBeGreaterThan(0)
      // 2초(≈60틱) 이동에도 링버퍼는 계약된 상한(7)을 넘지 않는다 — 접속
      // 시간에 비례해 무한정 커지지 않는다(ADR-0005 "링버퍼 크기 무한 확장
      // 문제" 방지 근거, sim-rewind.test.ts의 정확한 경계는 그 파일이 고정).
      expect(history!.length).toBeLessThanOrEqual(POSITION_HISTORY_CAPACITY)

      // 가장 최근 스냅샷은 현재 위치와 (부동소수점 오차 이내로) 일치해야
      // 한다 — 실제로 누적되고 있다는 것 자체를 확인한다(길이만으로는
      // "누적되지만 값이 갱신 안 되는" 결함을 못 잡는다).
      const current = seam.moveStates.get(roomB.sessionId)
      if (!current) throw new Error('RQ-64: B의 moveStates 스냅샷을 찾지 못했다')
      const newest = history!.reduce((a, b) => (b.tick > a.tick ? b : a))
      expect(Math.abs(newest.x - current.x)).toBeLessThan(0.01)
      expect(Math.abs(newest.z - current.z)).toBeLessThan(0.01)

      await leaveRoom(roomB)
    },
    15_000,
  )
})

describe('RQ-64: 세션 퇴장 시 위치 이력이 정리된다(누수 방지, onLeave 부기 정리 관례 — 22k 선례)', () => {
  let server: RunningServer

  beforeEach(async () => {
    server = await startServer()
  }, LISTEN_TIMEOUT_MS + 5_000)

  afterEach(async () => {
    await stopServer(server)
  })

  it(
    'B가 이동해 위치 이력을 채운 뒤 퇴장하면, positionHistory에서 B의 항목이 사라진다',
    async () => {
      const roomA = await joinGame(newClient(server)) // 방관자(bystander) — 서버 화이트박스는 A 세션으로 얻는다
      const roomB = await joinGame(newClient(server))
      await waitForDefinedPlayer(roomB, roomB.sessionId)

      roomB.send('move', { dirX: 1, dirZ: 0, mode: 'run', jump: false })
      await sleep(300)
      roomB.send('move', { dirX: 0, dirZ: 0, mode: 'run', jump: false })
      await sleep(100)

      const seam = getServerRoom(roomA)
      expect(seam.positionHistory.get(roomB.sessionId)?.length ?? 0).toBeGreaterThan(0) // 전제 확인

      await leaveRoom(roomB)
      await waitForHistoryCleanup(seam, roomB.sessionId, HISTORY_CLEANUP_TIMEOUT_MS)

      expect(seam.positionHistory.has(roomB.sessionId)).toBe(false)

      await leaveRoom(roomA)
    },
    15_000,
  )
})
