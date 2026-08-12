import type { Client } from 'colyseus'
import { Room } from 'colyseus'
import { GameState, Player, Spectator } from '@shared/schema/GameState'
import { CAPACITY, NET, PLAYER, UI, WEAPON, WORLD } from '@shared/constants'
import { createClock } from '@shared/sim/clock'
import { createScheduler } from '@shared/sim/scheduler'
import { createTickDriver } from '@shared/sim/tickDriver'
import { stepMovement, type MoveInput, type MoveState, type WallAABB } from '@shared/sim/movement'
import { PRODUCTION_WALLS } from '@shared/sim/walls'
import { PRODUCTION_GEOMETRY } from '@shared/sim/geometry'
import {
  applySpread,
  canFire,
  DEGENERATE_RADIAL_EPS,
  damageForRegion,
  effectiveSpreadConeRadius,
  eyeOrigin,
  findClosestHit,
  findClosestWallHit,
  hitboxForMode,
  type ClosestHit,
  type HitCandidate,
  type Ray,
  type Vec3,
} from '@shared/sim/combat'
import { createRng } from '@shared/sim/rng'
import { SPAWN_POINTS, isWithinSafeZone, nextSpawnIndex, type SpawnPoint } from '@shared/sim/spawn'
import {
  RESPAWN_TICKS,
  SPAWN_PROTECTION_TICKS,
  applyDamageWithProtection,
  canAct,
  isRespawnDue,
  isSpawnProtected,
} from '@shared/sim/lifecycle'
import { fallDamageForHeight } from '@shared/sim/fallDamage'
import { RELOAD_TICKS, canFireAmmo, consumeRound, isReloadComplete, isReloading, shouldStartReload } from '@shared/sim/ammo'
import { AFK_TICKS, isAfkDue } from '@shared/sim/afk'
import {
  appendPositionSnapshot,
  POSITION_HISTORY_CAPACITY,
  rewindTicksFor,
  sampleRewoundPosition,
  type PositionSnapshot,
} from '@shared/sim/rewind'
import { CROUCH_HITBOX, DEFAULT_HITBOX, DEFAULT_SPREAD, type SpreadTuning } from '@shared/config/combat-tuning'
import { sanitizeNickname } from '@shared/identity/nickname'
import { filterProfanity } from '@shared/chat/profanityFilter'
import { isValidStatsUuid } from '@shared/stats/uuid'
import { addPlaytimeMs, openStatsDb, recordDeath, recordKill, type StatsDb } from '@server/persistence/statsDb'

/** RQ-02: 닉네임 미제공 시 서버가 부여하는 기본 닉네임. 스펙이 침묵하는
 * 지점이라 임의로 정한다 — 어떤 값이든 자동 접미사 로직으로 고유화된다. */
const DEFAULT_NICKNAME = 'player'

/** 'move' 메시지를 아직 한 번도 보내지 않은 플레이어(방금 접속)에 쓰는
 * 입력 — 무입력·평지 대기 상태. */
const IDLE_MOVE_INPUT: MoveInput = { dirX: 0, dirZ: 0, mode: 'run', jump: false }

/** `point`(RQ-31 `@shared/sim/spawn`이 고른 스폰 지점)에서 시작하는 이동
 * 상태 — 정지·접지 상태로 스폰한다(RQ-15/16). */
function spawnMoveState(point: SpawnPoint): MoveState {
  return { x: point.x, y: point.y, z: point.z, vx: 0, vy: 0, vz: 0, grounded: true }
}

/**
 * `move` 메시지 payload에서 이동 입력 필드(`dirX`·`dirZ`·`mode`·`jump`)만
 * 뽑아 타입을 강제한다. 클라이언트가 같은 payload에 임의 좌표(x·y·z 등
 * 여분 필드)를 실어 보내도 여기서 아예 읽지 않으므로 서버 상태에 닿을
 * 경로가 없다 (RQ-61 서버 권위, RQ-20/GA-33). 타입이 어긋난 필드는 조용히
 * 안전한 기본값으로 대체한다 — 크래시·틱 정지보다 안전하다.
 */
function sanitizeMoveInput(payload: unknown): MoveInput {
  const raw = payload as { dirX?: unknown; dirZ?: unknown; mode?: unknown; jump?: unknown } | null | undefined
  return {
    dirX: typeof raw?.dirX === 'number' ? raw.dirX : 0,
    dirZ: typeof raw?.dirZ === 'number' ? raw.dirZ : 0,
    mode: raw?.mode === 'walk' || raw?.mode === 'crouch' || raw?.mode === 'run' ? raw.mode : 'run',
    jump: raw?.jump === true,
  }
}

/**
 * `move` payload에서 선택적 시퀀스 번호(RQ-62, ADR-0003 입력 커맨드 버퍼)를
 * 뽑는다. 유효한(유한한) 숫자가 아니면(레거시 호출 — 기존
 * `rq-20-movement-authority.test.ts`·`20b-client-connect.test.ts`가 이미
 * seq 없이 `move`를 호출한다) `undefined`를 반환해 호출자가
 * `lastProcessedInputSeq`를 갱신하지 않도록 한다(하위 호환, 회귀 금지).
 */
function parseInputSeq(payload: unknown): number | undefined {
  const raw = payload as { seq?: unknown } | null | undefined
  return typeof raw?.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : undefined
}

interface FireInput {
  dirX: number
  dirY: number
  dirZ: number
  /** RQ-64: 사수가 보고한 RTT(ms) — 되감기 산술(`rewindTicksFor`)의
   * 유일한 입력. 정규화 후 항상 유한한 숫자다(방어는 `rewindTicksFor`가
   * 맡는다 — 이 필드 자체는 "숫자였는가"만 보장한다). */
  rttMs: number
}

/** RQ-70/71/ADR-0016 결정 1 — `broadcast('hit', ...)` payload. 클라이언트
 * 쪽 동일 shape는 `@client/effects/hitFeedback`의 `HitEvent`다 — 서버는
 * `@client`를 import하지 않으므로(레이어 경계, `ChatMessage`가 이미 세운
 * 선례 — 아래 참고) 이 파일이 자신의 사본을 둔다. */
interface HitEvent {
  point: Vec3
  normal: Vec3
  target: 'wall' | 'player'
}

/**
 * RQ-40 채팅 브로드캐스트·이력 항목 공통 shape(test-writer 계약 §3.3,
 * `_workspace/RQ-40/01_test-writer_red.md`) — `broadcast('chat', ...)`와
 * `client.send('chat-history', ...)` 양쪽이 같은 원소 타입을 쓴다.
 */
interface ChatMessage {
  nickname: string
  text: string
}

/**
 * `chat` 메시지 payload에서 본문 텍스트만 뽑는다. 문자열이 아니면(조작된
 * 페이로드) 빈 문자열로 대체한다 — `sanitizeMoveInput`/`sanitizeFireInput`과
 * 동일한 방어적 파싱 패턴(RQ-61: 크래시·틱 정지보다 안전한 기본값).
 */
function sanitizeChatText(payload: unknown): string {
  const raw = payload as { text?: unknown } | null | undefined
  return typeof raw?.text === 'string' ? raw.text : ''
}

/**
 * `fire` 메시지 payload에서 조준 방향(`dirX`·`dirY`·`dirZ`)과 RQ-64
 * `rttMs`만 뽑는다. 클라이언트가 같은 payload에 명중·데미지·헤드샷·대상
 * 주장 필드(RQ-12 GA-06 — 악의적 클라이언트가 실어 보낼 수 있는 필드)를
 * 실어도 여기서 아예 읽지 않으므로 서버 상태에 닿을 경로가 없다(RQ-61) —
 * `sanitizeMoveInput`과 동일한 패턴.
 *
 * **`rttMs`(RQ-64)**: `typeof === 'number'` 방어로만 뽑는다(레거시
 * 클라이언트·필드 부재·문자열 등 숫자가 아닌 값은 전부 0으로 대체 —
 * `rewindTicksFor(0) === 0`이라 되감기가 적용되지 않는다, 회귀 방지). 값의
 * 상한 절단(200ms/6틱)·NaN 방어는 여기서 하지 않는다 — 그건
 * `rewindTicksFor`(`@shared/sim/rewind`)의 책임이다(관심사 분리, `canFire`가
 * "허용 여부"만 판정하고 발사 자체는 호출자가 하는 것과 동일한 패턴).
 */
function sanitizeFireInput(payload: unknown): FireInput {
  const raw = payload as { dirX?: unknown; dirY?: unknown; dirZ?: unknown; rttMs?: unknown } | null | undefined
  return {
    dirX: typeof raw?.dirX === 'number' ? raw.dirX : 0,
    dirY: typeof raw?.dirY === 'number' ? raw.dirY : 0,
    dirZ: typeof raw?.dirZ === 'number' ? raw.dirZ : 0,
    rttMs: typeof raw?.rttMs === 'number' ? raw.rttMs : 0,
  }
}

/**
 * 'game' 룸 — RQ-04 상설 세션 + RQ-02 닉네임 식별 + RQ-03 정원 + RQ-60
 * 30Hz 고정 틱.
 *
 * 서버 전역에 이 룸은 단 하나만 존재해야 한다(GA-29). 동시 `joinOrCreate`
 * 경쟁으로 룸이 중복 생성되지 않도록 하는 것은 Colyseus 매치메이커가
 * 이미 보장한다 — `concurrentJoinOrCreateRoomLock`
 * (`node_modules/@colyseus/core/build/MatchMaker.js`)이 룸 이름당 생성을
 * 직렬화한다.
 *
 * `maxClients`는 건드리지 않는다(기본값 Infinity로 유지). RQ-03의 정원
 * 초과 거부를 Colyseus 네이티브 `maxClients`(룸 잠금)로 구현하지 않은
 * 이유(2026-07-21, `node_modules/@colyseus/core/build/MatchMaker.js`·
 * `Room.js` 실측): `maxClients`에 도달하면 룸이 `locked=true`가 되고,
 * `joinOrCreate()`의 `findOneRoomAvailable()`(`locked: false` 쿼리)이
 * 그 룸을 더 이상 찾지 못한다. 그러면 `concurrentJoinOrCreateRoomLock`
 * 콜백이 "캐시된 roomId로 찾은 룸이 locked면 재조회 → 그래도 없으면
 * `createRoom()`" 경로를 타 **두 번째 'game' 룸을 새로 만들어 버린다**
 * (`MatchMaker.js` 143~166행). 클라이언트는 `join()`이 아니라
 * `joinOrCreate()`를 쓰므로(GA-29가 요구하는 단일 룸 전제), `maxClients`로
 * 잠그는 방식은 21번째 접속을 거부하는 대신 GA-29(서버 전역 단일 룸)를
 * 깨는 회귀가 된다. 대신 `onJoin()`에서 이 룸 자신의 `players`·
 * `spectators` 컬렉션 크기로 직접 정원을 판정하고, 거부 시 `throw`한다 —
 * `maxClients`를 Infinity로 둬 룸이 절대 lock되지 않게 함으로써 위 경로를
 * 원천 차단한다. `onJoin`의 throw는 Colyseus가 그대로 재던지고
 * (`Room.js` `_onJoin`), 클라이언트 SDK(`colyseus.js` `Client
 * .consumeSeatReservation`)가 이를 `targetRoom.onError` → `ServerError`
 * (Error 서브클래스, 메시지 보존)로 변환해 `joinOrCreate()` 프라미스를
 * reject한다 — GA-21이 요구하는 관측(Error + 비어있지 않은 message)과
 * 정확히 일치한다.
 *
 * 게임 상태 중 HP·킬 등은 여기서 다루지 않는다 — RQ-14 이후 붙는다.
 * RQ-04는 세션 생명주기, RQ-02는 닉네임 식별, RQ-03은 정원, RQ-60은
 * 시뮬레이션 틱 구동, RQ-20은 이동(위치)이 이 룸의 범위다.
 */
export class GameRoom extends Room<GameState> {
  // RQ-04: 마지막 참여자가 나가 0명이 돼도 룸을 폐기하지 않는다 —
  // 라운드·매치 종료 없는 상설 세션. Colyseus 기본값(true)은 빈 방을
  // 자동 dispose하므로 반드시 꺼야 한다(GA-26).
  override autoDispose = false

  /**
   * 플레이어별 이동 시뮬레이션 상태(RQ-20) — sessionId로 키잉. `Player`
   * 스키마(x·y·z)는 이 상태의 매 틱 스냅샷일 뿐, 시뮬레이션의 정본은 여기
   * `MoveState`다. `MoveState`는 `vx`·`vz`(수평 관성 포함)까지 전부 값으로
   * 노출하는 완전한 스냅샷이라(`@shared/sim/movement` REV 2026-07-24)
   * 이 맵은 순수한 저장소일 뿐이다 — 매 틱 반환값을 그대로 넘기면 되고,
   * 참조 동일성에 기대지 않는다(직렬화·복제해 넘겨도 결과가 같다).
   */
  private readonly moveStates = new Map<string, MoveState>()
  /** 플레이어별 가장 최근 'move' 입력 — 다음 입력이 올 때까지 유지하며
   * 매 틱 시뮬레이션에 반영한다(실시간 FPS 이동 입력의 표준 모델).
   *
   * **원장 22f 수정**: 연속값(`dirX`·`dirZ`·`mode`)은 여전히 "마지막
   * 값"으로 덮어쓰지만, 엣지 트리거인 `jump`만은 예외다 — `'move'`
   * 핸들러가 새 입력을 이 맵에 반영할 때 직전에 남아 있던 `jump`와
   * OR(합집합)하고, `stepPlayerMovement`가 매 틱 이 값을 읽은 뒤 그것이
   * 참이면(공중 상태라 물리가 실제로 참조하지 않는 틱이어도) 무조건
   * `false`로 되돌린다(`stepPlayerMovement`의 리셋 지점 주석 참고 —
   * "실제 소비 여부"가 아니라 "읽은 값이 참이었는가"만 본다). 33ms 틱
   * 경계 안에 `jump:true`→`jump:false`가 연속 도착해도(짧은 키다운~키업)
   * 틱 루프가 그 사이 어느 한 시점의 값만 읽어 점프를 통째로 놓치던
   * 결함의 수정이다(`tests/integration/22f-jump-input-loss.test.ts`). */
  private readonly pendingInputs = new Map<string, MoveInput>()
  /** 플레이어별 가장 최근 수신 입력 시퀀스 번호(RQ-62, ADR-0003) —
   * `pendingInputs`와 동일한 "최근 수신값을 다음 갱신까지 유지" 모델이다
   * (리뷰 blocker 수정, `_workspace/review/feat-RQ-62-client-prediction.md`).
   * 'move' 메시지 수신 시점에는 여기만 갱신하고, `player.lastProcessedInputSeq`
   * 에 실제로 반영하는 것은 `stepPlayerMovement`가 위치·속도를 쓴 직후로
   * 미룬다 — 그래야 브로드캐스트되는 스냅샷에서 seq가 그 스냅샷의 위치보다
   * 앞서지 않는다(Colyseus 패치 주기(기본 20Hz)와 틱(30Hz)의 위상이 어긋나면
   * 메시지 수신 즉시 기록 방식에서 "seq는 갱신됐지만 위치는 아직 그
   * 입력을 반영하지 못한" 불일치 스냅샷이 나갈 수 있었다). */
  private readonly pendingSeqs = new Map<string, number>()
  /** 사수(세션)별 마지막 발사 시각(ms) — ADR-0005 rate-limit(150ms)을 사수
   * 독립으로 추적한다(가정 D, RQ-17이 이 독립성에 의존). */
  private readonly lastFireAtMs = new Map<string, number>()
  /** RQ-15: 사망 처리된 틱(세션별) — 살아있는 플레이어는 이 맵에 없다.
   * `isRespawnDue`의 기준점이다. */
  private readonly diedAtTick = new Map<string, number>()
  /** RQ-16: 최초 입장·리스폰 공통 — 해당 세션이 마지막으로 스폰된 틱.
   * `isSpawnProtected`의 기준점이다. */
  private readonly spawnedAtTick = new Map<string, number>()
  /** RQ-16: 마지막 스폰 이후 사격(명중 여부 무관)을 한 번이라도 했는지 —
   * true면 경과와 무관하게 보호가 즉시 해제된다. */
  private readonly firedSinceSpawn = new Map<string, boolean>()
  /** RQ-10: 사수(세션)별 탄창 잔여 발수 — `diedAtTick`·`spawnedAtTick`과
   * 동일하게 GameRoom 서버 전유 상태로 관리한다(`Player` 스키마에는 추가
   * 필드를 두지 않는다 — RQ-53 클라 탄약 HUD가 다음 라운드의 명시적 범위,
   * `tests/unit/sim-ammo.test.ts` 가정 1). 키가 없으면(참여 직후) 가득 찬
   * 것으로 간주한다(onJoin이 채운다). */
  private readonly magazines = new Map<string, number>()
  /** RQ-11: 사수(세션)별 재장전을 시작한 틱 — 키가 없으면 재장전 중이
   * 아니다(`canFireAmmo`의 `reloadStartedAtTick: number | undefined`와
   * 동일한 "부재=undefined" 규약, `diedAtTick`과 같은 패턴). */
  private readonly reloadStartedAtTick = new Map<string, number>()
  /** RQ-18: 세션별 "현재 연속 공중 구간에서 도달한 최고 y" — 러닝 최댓값.
   * 키 부재 = 현재 공중 구간을 추적 중이 아님(접지 상태이거나 아직 이
   * 구간의 첫 airborne 틱을 겪지 않음). 착지 전이(`trackFallDamage`)에서
   * 소비된 뒤 삭제된다 — `diedAtTick` 등과 동일하게 GameRoom 전유 부기
   * 상태이며 `Player` 스키마에는 노출하지 않는다(`_workspace/RQ-18/
   * 01_test-writer_red.md` §1.3·§4). **이름을 바꾸지 않는다** — 통합
   * 테스트(`tests/integration/rq-18-fall-damage.test.ts`의
   * `FallDamageTestSeam` 인터페이스)가 `matchMaker.getLocalRoomById`로 이
   * 정확한 필드명을 화이트박스 주입 대상으로 참조한다. 그 결합은
   * `as unknown as` 캐스팅이라 **`tsc`가 대조하지 않는다** — 리네임은 타입
   * 오류가 아니라 실행 시 단언 실패로만 드러난다(리뷰 minor 2). */
  private readonly fallPeakY = new Map<string, number>()
  /** RQ-43: 세션별 "마지막 **활동** 처리 틱" — `isAfkDue`의 기준점이다.
   * `fire`/`chat`/`reload`는 **명시적 조작**이므로 수신 즉시 갱신하지만,
   * `move`는 **조건부**다 — 클라이언트(`PlayerControls`)가 키 입력과 무관하게
   * 30Hz로 유휴 payload를 계속 보내기 때문에, 수신 자체를 활동으로 치면
   * **RQ-43이 제품에서 영원히 발화하지 않는다**(리뷰 blocker로 실증됨).
   * 실제 조작(`dirX`/`dirZ` ≠ 0 또는 `jump`)이 담긴 payload만 갱신한다.
   * 관전자는 대상이 아니므로(RQ-43 원문 "플레이어가") 플레이어로 있는
   * 동안만 값을 갖는다 — `initializePlayer`가 채우고, `onLeave`가 지운다.
   * **이름을 바꾸지 않는다** — 통합 테스트(`rq-43-afk-kick.test.ts`의
   * `AfkTestSeam`)가 `matchMaker.getLocalRoomById`로 이 정확한 필드명을
   * 화이트박스 주입 대상으로 참조한다(`fallPeakY`와 동일한 결합 방식 —
   * `as unknown as` 캐스팅이라 `tsc`가 대조하지 않는다). */
  private readonly lastInputAtTick = new Map<string, number>()
  /** RQ-64: 세션별 위치 이력 링버퍼(최근 `POSITION_HISTORY_CAPACITY`(7)개
   * 스냅샷) — 랙 보상 되감기(`sampleRewoundPosition`)의 조회 대상이다.
   * `stepPlayerMovement`가 살아있는(canAct) 플레이어의 `moveStates`를 갱신
   * 하는 바로 그 자리에서 그 틱의 발 위치를 적립한다(`_workspace/RQ-64/
   * 01_test-writer_red.md` §8 가정 3). 사망한 플레이어는 `moveStates`와
   * 동일하게 위치가 고정되므로 이력도 추가하지 않는다. **리스폰 시
   * `respawnPlayer`가 이 맵의 해당 세션 항목을 삭제한다**(평가 F2 수정 —
   * 그 함수 docblock 참고, 삭제하지 않으면 이전 생의 이력이 남아 되감기가
   * 시신 지점을 반환한다). `appendPositionSnapshot`
   * 은 매 호출마다 새 배열을 반환하는 순수 함수 계약이다(`@shared/sim/rewind`
   * 주석 참고 — 정원 10 × 상한 7 = 최대 70 엘리먼트 복사라 틱 예산에 부담이
   * 없다). **이름을 바꾸지 않는다** — 통합 테스트(`rq-64-lag-compensation
   * -bound.test.ts`의 `RewindTestSeam`)가 `matchMaker.getLocalRoomById`로
   * 이 정확한 필드명을 화이트박스 주입 대상으로 참조한다(`fallPeakY`·
   * `lastInputAtTick`과 동일한 결합 방식 — `as unknown as` 캐스팅이라 `tsc`가
   * 대조하지 않는다). */
  private readonly positionHistory = new Map<string, PositionSnapshot[]>()
  /** RQ-31: 룸 전역 스폰 로테이션 커서 — 세션이 아니라 룸 하나가 갖는다
   * (`nextSpawnIndex`의 "직전 사용 지점 회피"가 전역 순서 기준이라는
   * 설계 결정, `_workspace/RQ-15-16/01_test-writer_red.md` §2.1). */
  private spawnCursor: number | undefined
  /** RQ-90: 탄퍼짐 콘 반경 오버라이드(테스트 전용, 화이트박스) — 값이 있으면
   * 이 룸 인스턴스의 사격 판정에서 `DEFAULT_SPREAD`(출하 기본값 — v1.9부터
   * 0.5°, `@shared/config/combat-tuning` 정본) 대신 이 값을 쓴다. **minor 1
   * REV(리뷰 지적)**: 이 코멘트가 한동안 "반경 0"이라고 적고 있었는데
   * v1.8/v1.9(원장 25a-10)가 그 값을 0.5°로 바꾼 뒤에도 정정되지 않았다 —
   * `GameRoom.ts` 안의 다른 자리(`handleFire` 코멘트)는 이미 정정됐으나
   * 이 필드 코멘트만 남아 있었다. 이 필드에 값을 대입하는 프로덕션 코드
   * 경로는 없다 —
   * 오직 통합 테스트만 화이트박스로 값을 쓴다. **이름을 바꾸지 않는다** —
   * 통합 테스트(`rq-90-spread-seed-determinism.test.ts`의 `SpreadTestSeam`)가
   * `matchMaker.getLocalRoomById`로 이 정확한 필드명을 화이트박스 주입
   * 대상으로 참조한다(`fallPeakY`·`lastInputAtTick`·`positionHistory`와
   * 동일한 결합 방식 — `as unknown as` 캐스팅이라 `tsc`가 대조하지 않는다). */
  private spreadTuningOverride: SpreadTuning | undefined
  /** RQ-90: 강제 탄퍼짐 시드(테스트 전용, 화이트박스) — 값이 있으면 다음
   * 'fire'부터(발신자 무관, 테스트가 다시 바꾸기 전까지 계속 유지 —
   * **자동 소비되지 않는다**) 그 값 그대로 `createRng`에 넘겨 `applySpread`
   * 편차 계산에 쓴다. 없으면 서버 자신이 `issueSpreadSeed()`로 시드를
   * 조달한다(아래 `handleFire`·`issueSpreadSeed` 참고). **이름을 바꾸지
   * 않는다** — 위 필드와 동일한 근거(`SpreadTestSeam.forcedSpreadSeed`). */
  private forcedSpreadSeed: number | undefined
  /** RQ-90: `forcedSpreadSeed`가 없을 때 서버가 스스로 발급하는 탄퍼짐 시드의
   * 재료 — 이 룸이 처리한 사격 발수(세션 무관, 룸 전역)만큼 전진하는 순수
   * 카운터. `issueSpreadSeed()`가 `state.tick`·`spreadSalt`와 섞어 매 사격을
   * 서로 다른 시드로 만드는 데 쓴다. */
  private spreadSeedCounter = 0
  /** RQ-90 v1.9(22v/22w) — 이 룸 인스턴스만 아는 탄퍼짐 시드 salt. 클래스
   * 필드 초기화 시점(=생성자, `handleCreateRoom`이 `new handler.klass()`를
   * 호출하는 순간 — `onCreate`보다 먼저다)에 정확히 1회 발급하고 그 뒤로는
   * 바꾸지 않는다. **`onCreate(options)` 경유로 받지 않는다** — Colyseus의
   * 옵션 병합(`merge({}, clientOptions, handler.options)`,
   * `node_modules/@colyseus/core/build/MatchMaker.js` 실측)은 서버
   * `defaultOptions`(`src/server/index.ts`의 `define()` 3번째 인자)에
   * **실제로 있는 키만** 클라 값을 이긴다 — 이 필드를 옵션으로 받으면
   * `defaultOptions`에 넣지 않는 한 클라이언트가 `joinOrCreate('game',
   * { ... })`로 값을 직접 지정할 수 있다(리뷰 blocker 1 준비 중 발견,
   * `src/server/index.ts:108-125` 코멘트 참고). 그래서 **스키마 필드도
   * 아니고**(`GameState`에 없다 — 클라에 동기화되지 않는다, 여기 두면
   * `state.tick`처럼 관측 가능해져 salt의 의미가 없어진다) 옵션도 아닌,
   * 클래스 자체의 private 필드로만 존재한다 — `spreadTuningOverride`·
   * `forcedSpreadSeed`와 동일한 결합 방식이지만, 저 둘과 달리 이 필드는
   * 프로덕션 코드 경로(이 초기화식)가 실제로 값을 쓰는 유일한 지점이다.
   *
   * `issueSpreadSeed()`가 `createRng(spreadSalt)`를 기반으로 `fork(tick)`·
   * `fork(counter)`를 거쳐 최종 시드를 만든다 — `Math.random()` 자체는
   * 여기(룸 생성, 시뮬레이션 루프 밖의 1회성 이벤트)에서만 호출된다.
   * ADR-0008이 금지하는 것은 "시뮬레이션 코드"(매 틱·매 사격마다 실행)의
   * 직접 호출이다(기존 `handleFire`의 rate-limit이 `Date.now()`를 쓰는
   * 것과 같은 근거) — 여기는 그 경로가 아니다. **결정론이 필요한 것은
   * "같은 salt·같은 tick·같은 counter가 같은 시드를 내는가"이지 "salt
   * 자체가 어떻게 나오는가"가 아니다** — salt가 일단 발급되면 그 뒤
   * `issueSpreadSeed()`는 순수하게 그 값·`tick`·`counter`만의 함수라
   * 결정론적이다(재현이 필요한 시나리오는 여전히 `forcedSpreadSeed`로 이
   * 경로 자체를 우회한다). 클라가 아는 값(`tick`)만으로는 이 salt를 유도할
   * 수 없다 — 다만 32비트 정수라 관측된 편차로부터의 오프라인 전수 탐색
   * 자체를 원천 차단하지는 않는다(원장 26az 이월 — "예측 불가"라고
   * 단정하지 않는다, team-lead 지시). */
  private readonly spreadSalt: number = Math.floor(Math.random() * 0x100000000) >>> 0
  /** RQ-90 v1.9(22w) — `spreadSalt` 자리에서 대체할 강제 salt(테스트 전용,
   * 화이트박스) — 값이 있으면 `issueSpreadSeed()`가 `createRng(spreadSalt)`
   * 대신 `createRng(forcedRoomSalt)`를 기반으로 쓰되, **`fork(tick)`·
   * `fork(counter)`는 그대로 거친다** — "룸의 salt *소스*만 결정론적인
   * 것으로 교체"한다는 이름 그대로다. `forcedSpreadSeed`(발급된 최종
   * 시드 자체를 강제, fork 배선을 완전히 우회)와는 역할이 분명히 갈린다
   * — 이 필드는 salt→시드 fork 배선 자체가 실제로 도는지도 함께 시험할
   * 수 있다. **REV(리뷰 지적, 22z1 인접)**: 최초 구현은 이 값을 fork 없이
   * 그대로 반환해 사실상 `forcedSpreadSeed`와 기능이 겹쳤다("salt"라는
   * 이름과 실제 동작이 어긋남) — 지금 형태로 교정했다. 이 필드에 값을
   * 대입하는 프로덕션 코드 경로는 없다 — 오직 통합 테스트만 화이트박스로
   * 값을 쓴다(`spreadTuningOverride`와 동일한 권한·근거). **이름을 바꾸지
   * 않는다** — `SeedSaltTestSeam.forcedRoomSalt`가 이 정확한 필드명을
   * 화이트박스 주입 대상으로 참조한다(team-lead 확정 사항). */
  private forcedRoomSalt: number | undefined
  /** RQ-12 v1.7: hitscan 차폐 질의용 벽 목록 오버라이드(테스트 전용,
   * 화이트박스) — **설정돼 있으면**(`[]`도 유효한 설정값이다, "벽 없음"과
   * "오버라이드 없음"은 구분된다) `handleFire`가 `findClosestHit`의 4번째
   * 인자로 `PRODUCTION_WALLS`(`@shared/sim/walls`) 대신 이 값을 쓴다.
   * `undefined`(기본값)면 기존처럼 `PRODUCTION_WALLS`를 그대로 쓴다. 이
   * 필드에 값을 대입하는 프로덕션 코드 경로는 없다 — 오직 통합 테스트만
   * 화이트박스로 값을 쓴다(`spreadTuningOverride`와 동일한 권한·근거,
   * 위 코멘트). **범위 한정** — `stepPlayerMovement`가 `stepMovement`에
   * 넘기는 이동 충돌용 벽 목록(RQ-30)은 이 오버라이드와 무관하게 계속
   * 무조건 `PRODUCTION_WALLS`만 쓴다. **이름을 바꾸지 않는다** — 통합
   * 테스트(`rq-12-wall-occlusion.test.ts`의 `WallOcclusionTestSeam`)가
   * `matchMaker.getLocalRoomById`로 이 정확한 필드명을 화이트박스 주입
   * 대상으로 참조한다(`spreadTuningOverride`·`forcedSpreadSeed`와 동일한
   * 결합 방식 — `as unknown as` 캐스팅이라 `tsc`가 대조하지 않는다). */
  private wallsOverride: readonly WallAABB[] | undefined
  /** RQ-40: 최근 채팅 이력 — 오래된 것이 배열 앞쪽(도착 순서 그대로), 최대
   * `UI.CHAT_HISTORY`(50)개만 유지한다(초과분은 앞에서 폐기). 저장되는
   * 텍스트는 이미 `filterProfanity`를 거친 값이다(RQ-95) — 브로드캐스트
   * 시점에만 필터링하고 이력을 원문으로 저장하면 재접속자에게 원문이
   * 새어나가는 우회로가 생긴다(`_workspace/RQ-40/01_test-writer_red.md`
   * "금칙어 필터와의 상호작용" 경고). 관전자를 포함해 룸에 연결된 모든
   * 클라이언트가 발신·수신 양쪽에 참여한다(RQ-41).
   */
  private readonly chatHistory: ChatMessage[] = []
  /** RQ-81: SQLite 통계 핸들 — `onCreate`에서 열고 `onDispose`에서 닫는다.
   * 정의역 확정 순서(Colyseus 룸 생명주기: `onCreate`가 항상 다른 모든
   * 콜백보다 먼저 정확히 한 번 실행된다)에 기대어 `!`(정의 단언)를 쓴다
   * (`allocateSpawnPoint`의 `SPAWN_POINTS[...]!`와 동일한 관례). 닫지
   * 않으면 재시작 시나리오(같은 프로세스 안에서 `buildServer()`를 다시
   * 부르는 통합 테스트)에서 두 번째 인스턴스가 같은 파일을 열 때 Windows
   * 파일 잠금 관례상 충돌할 수 있다(`_workspace/RQ-81/01_test-writer_red.md`
   * §5.3 리스크 기록). */
  private statsDb!: StatsDb
  /** RQ-81: 세션별 통계 키(익명 UUID) — `onJoin`이 `isValidStatsUuid`를
   * 통과한 값만 저장한다(§4 설계 포크 3, ADR-0006 "소유권 검증 아님, 형식
   * 검사"). 통과하지 못한(미제공·형식 오류) 세션은 이 맵에 항목이 없고,
   * `registerDeath`/`onLeave`의 통계 기록 지점이 `.get()`이 `undefined`를
   * 반환하면 조용히 건너뛴다 — "이번 판은 통계 추적에서 아예 빠진다"는
   * 안전한 기본값이다(공유 폴백 키로 대체하지 않는다 — 그러면 서로 무관한
   * 형식 오류 세션들이 한 키로 수렴해 오염된다). `onLeave`가 정리한다.
   */
  private readonly playerUuids = new Map<string, string>()
  /** RQ-81: 플레이어가 된 시점(`initializePlayer` — 최초 입장·AFK 승격
   * 공통)의 `Date.now()` — 퇴장 시 경과를 `addPlaytimeMs`로 한 번에
   * 적재한다(팀리드 위임 "쓰기 시점" 결정, `_workspace/RQ-81/
   * 01_test-writer_red.md` §3). **관전 중 시간은 세지 않는다**(coder
   * 재량 — 킬·데스·헤드샷 세 지표가 전부 플레이어 전유 개념이라 플레이타임도
   * 같은 축에 맞췄다, §7 "관전자의 플레이타임 집계 여부"). `kickAfkPlayer`는
   * 이 맵을 건드리지 않는다 — `lastInputAtTick`과 동일하게 실제 소켓 close로
   * 도달하는 `onLeave`가 나중에 정리한다(이미 검증된 정리 패턴 재사용). */
  private readonly joinedAtMs = new Map<string, number>()

  override onCreate(options?: { statsDbPath?: string }): void {
    // RQ-81: `statsDbPath`는 `src/server/index.ts`의 `gameServer.define()`
    // 3번째 인자(룸 생성 옵션)로 항상 채워져 들어온다 — 폴백은 그 경로를
    // 우회하는 직접 인스턴스화(현재 테스트 스위트에는 없다)에 대비한
    // 방어일 뿐이다. **`':memory:'`를 쓴다**(평가 minor 7) — 상대경로
    // 파일명(예전엔 `'stats.db'`)으로 두면 도달 시 cwd(저장소 루트 또는
    // 컨테이너 `/app`)에 조용히 파일을 만든다. `buildServer()` 자신의
    // 기본값을 `:memory:`로 정한 것(위 `BuildOptions.statsDbPath` 코멘트)과
    // 같은 이유 — 도달 불가능한 방어선이라도 오염 위험이 있는 값을 두지
    // 않는다.
    this.statsDb = openStatsDb(options?.statsDbPath ?? ':memory:')
    this.state = new GameState()
    this.registerMessageHandlers()
    this.startTickLoop()
  }

  /** RQ-81: 룸이 폐기될 때(정상 종료 드레인이든 프로세스 재시작 시나리오든)
   * SQLite 핸들을 닫는다 — 위 `statsDb` 필드 코멘트의 리스크 기록 참고.
   * Colyseus가 `_dispose()`에서 정의돼 있으면 이 메서드를 부른다. */
  override onDispose(): void {
    this.statsDb.close()
  }

  /**
   * RQ-20 이동 입력(GA-33 서버 권위 포함) + RQ-62 입력 시퀀스. 'move'
   * payload에서 방향·상태 필드만 뽑는다(`sanitizeMoveInput`) — 페이로드에
   * 좌표(x·y·z)가 실려 와도 이 핸들러가 아예 읽지 않으므로 상태에 반영될
   * 경로가 없다(RQ-61).
   *
   * 선택적 `seq`(ADR-0003)가 유효하면 `pendingSeqs`에만 기록한다 — **여기서
   * `player.lastProcessedInputSeq`를 직접 쓰지 않는다**(리뷰 blocker 수정).
   * 실제 반영은 `stepPlayerMovement`가 이 입력을 시뮬레이션에 적용해 위치를
   * 쓴 직후로 미룬다. 없거나 숫자가 아니면(레거시 호출) `pendingSeqs`도
   * 건드리지 않는다(하위 호환 — 기존 `lastProcessedInputSeq` 값 유지).
   */
  private registerMessageHandlers(): void {
    this.onMessage('move', (client, payload: unknown) => {
      const input = sanitizeMoveInput(payload)

      // RQ-43 리뷰 blocker 수정(`_workspace/review/feat-RQ-43-afk-kick.md`)
      // — 실 `PlayerControls.tsx`(클라, 30Hz)는 조작이 전혀 없어도 매 틱
      // 유휴 payload(`{dirX:0,dirZ:0,mode:'run',jump:false}`)를 계속
      // 보낸다. 이걸 무조건 "입력"으로 인정하면(이전 구현) `isAfkDue`가
      // 실 클라이언트를 켜 둔 어떤 세션에서도 참이 될 수 없어 RQ-43이
      // 제품에서 전혀 발화하지 않는다(리뷰 실증, GA-13 given이 도달
      // 불가능한 상태였다). 그래서 실제 조작 성분이 있을 때만 AFK
      // 타이머를 리셋한다 — `fire`/`chat`/`reload`는 사용자 행위가 있어야
      // 발생하는 명시적 조작이라 이 구분이 필요 없다(현행 무조건 리셋
      // 유지).
      //
      // **정규화 후(sanitizeMoveInput 결과) 값으로 판정한다** — 정규화
      // 전 원본 payload로 판정하면 변조된 클라이언트가 숫자가 아닌 값
      // (예: `dirX: "x"`)을 실어 보내 `!== 0` 비교를 항상 참으로 만들어
      // 판정을 우회할 수 있다. `sanitizeMoveInput`이 숫자가 아닌 값을
      // 전부 0으로 접으므로(RQ-61 방어적 파싱, 위 `sanitizeMoveInput`
      // 참고) 이 우회가 막힌다. `Number.isFinite` 가드는 그중에서도
      // `NaN`(타입은 `'number'`라 `sanitizeMoveInput`을 그대로 통과하지만
      // 어떤 값과 비교해도 `!==`가 참이 되는 값)을 활동으로 오인하는
      // 잔여 우회를 추가로 닫는다.
      //
      // `mode`(walk/crouch)는 활동으로 치지 않는다(팀리드 판단 — 미결
      // 스펙 질의 대상, 잔여 판단 ①로 남겨둠): walk/crouch는 누른 상태가
      // 유지되는 값이라 가만히 있어도 계속 전송되므로, 이를 활동으로
      // 인정하면 그 키만 눌러 고정한 세션이 영원히 AFK 판정을 피한다.
      const isMoveActivity =
        (Number.isFinite(input.dirX) && input.dirX !== 0) || (Number.isFinite(input.dirZ) && input.dirZ !== 0) || input.jump
      if (isMoveActivity) {
        this.touchAfkTimer(client.sessionId)
      }

      // AFK 판정과 무관하게 pendingInputs는 항상 갱신한다 — RQ-62 예측·
      // 이동 시뮬레이션은 유휴 입력(정지 상태)도 다음 틱에 반영해야 한다.
      //
      // 원장 22f 수정: dirX·dirZ·mode(연속값)는 지금까지와 동일하게
      // "마지막 값"으로 덮어쓰지만, `jump`만은 예외로 직전에 남아 있던
      // 값과 OR(합집합)한다. `jump`는 엣지 트리거다(`MoveInput.jump` 타입
      // 코멘트, `@shared/sim/movement`) — 서버 틱(33ms, RQ-60) 사이에
      // `jump:true` 다음 `jump:false`가 도착해도(짧은 키다운~키업), 그
      // 사이 어느 한 시점의 스냅샷만 읽는 틱 루프가 `jump:true`를 놓치지
      // 않으려면 "그 구간에 한 번이라도 true였는가"로 판정해야 한다.
      // 연속값까지 같은 방식으로 합치면(예: 방향을 합집합·평균) 이동
      // 감각이 왜곡되므로 확장하지 않는다(이 결함의 회귀 테스트,
      // `tests/integration/22f-jump-input-loss.test.ts`의 "계약 고정"
      // 케이스가 이를 못박는다). 이렇게 세운 `jump`는 `stepPlayerMovement`가
      // 실제로 소비한 직후 다시 false로 되돌린다 — 그러지 않으면 착지 후
      // 같은 값이 남아 무한 재점프하는 회귀가 생긴다(같은 파일의 "회귀
      // 가드" 케이스).
      const previousJump = this.pendingInputs.get(client.sessionId)?.jump ?? false
      this.pendingInputs.set(client.sessionId, { ...input, jump: input.jump || previousJump })

      const seq = parseInputSeq(payload)
      if (seq !== undefined) {
        this.pendingSeqs.set(client.sessionId, seq)
      }
    })

    this.onMessage('fire', (client, payload: unknown) => {
      this.touchAfkTimer(client.sessionId)
      this.handleFire(client.sessionId, sanitizeFireInput(payload))
    })

    this.onMessage('chat', (client, payload: unknown) => {
      this.touchAfkTimer(client.sessionId)
      this.handleChat(client.sessionId, sanitizeChatText(payload))
    })

    this.onMessage('reload', (client) => {
      this.touchAfkTimer(client.sessionId)
      this.handleReload(client.sessionId)
    })

    // RQ-64 랙 보상(평가 F3 대응, `_workspace/RQ-64/06_evaluator_delta.md`)
    // — 전용 RTT 측정 ping/pong. `client.send`는 이 콜백 안에서 동기
    // 호출되므로 다음 시뮬레이션 틱이나 다음 상태 패치를 기다리지 않는다
    // (`handleChat`과 동일한 위상 — 수신 즉시 처리). **왜 필요한가**: 이전
    // 시도(F1)는 기존 `move`↔`seq`↔`lastProcessedInputSeq` 왕복을 RTT
    // 표본으로 재사용했으나, 그 확인은 서버 틱(최대 `NET.TICK_MS`)과
    // Colyseus 상태 패치 배치(기본 20Hz, 최대 50ms)를 반드시 거쳐야 도착해
    // 표본에 구조적 지연이 섞였다(평가 실측 +62ms 편향 — "RTT 150ms 이내
    // 정상 플레이 보장"을 실제로 깼다). **왜 브로드캐스트가 아니라
    // `client.send`인가**: 요청한 클라이언트 자신에게만 필요한 응답이라
    // 다른 클라이언트의 대역폭을 쓸 이유가 없다. 게임 상태(`state`)에
    // 닿지 않으므로 관전자·플레이어 구분 없이 응답한다(AFK 판정
    // `touchAfkTimer`도 호출하지 않는다 — 클라이언트가 자동으로 보내는
    // 타이머 기반 하트비트라 RQ-43 "유휴 move 하트비트는 활동이 아니다"와
    // 동일한 이유로 사용자 조작으로 치지 않는다). payload를 검증·해석하지
    // 않고 그대로 반사한다 — 왕복 식별(`seq`)은 클라이언트
    // (`@client/net/rttEstimator`)의 관심사이지 서버가 해석할 대상이 아니다.
    this.onMessage('ping', (client, payload: unknown) => {
      client.send('pong', payload)
    })
  }

  /**
   * RQ-43: 발신자가 현재 **플레이어**일 때만 `lastInputAtTick`을 현재
   * 틱으로 갱신한다(관전자는 RQ-43 원문이 "플레이어가"로 한정하므로
   * 대상이 아니다). 호출부는 `fire`/`chat`/`reload` 3종은 무조건, `move`는
   * 조건부(위 `'move'` 핸들러의 `isMoveActivity` 참고 — 리뷰 blocker 수정)
   * 로 부른다.
   *
   * **coder 판단(스펙·골든 미규정 — `_workspace/RQ-43/01_test-writer_red.md`
   * §2 "결정하지 않고 coder 자유로 남긴 것")**: `fire`/`chat`/`reload`는
   * 게임 로직상 최종 수락 여부(예: 시신의 fire, rate-limit에 막힌 fire,
   * 재장전 중 재요청)와 무관하게 항상 갱신한다 — 각 핸들러 진입 시
   * `sanitize*`·`canAct`·rate-limit·탄약 게이트를 타기 **전에** 이 호출을
   * 둔 이유다. RQ-43 원문 "5분간 입력이 없으면"의 "입력"은 서버가 게임
   * 로직상 그 입력을 수락했는지가 아니라 그 세션이 여전히 무언가를 보내고
   * 있다는 활동 신호로 해석했다 — 그렇지 않으면(수락된 입력만 리셋) 예컨대
   * 탄창이 빈 채로 조준만 계속하는 플레이어, 또는 죽어서 `fire`가 전부
   * 무시되는 플레이어가 실제로는 계속 조작 중인데도 AFK로 킥될 수 있다.
   * 이 논증은 어디까지나 **수락되지 않은 사용자 조작**을 살리기 위한
   * 것이지, **조작이 전혀 없는 하트비트**(실 클라이언트가 30Hz로 보내는
   * 유휴 `move`)까지 입력으로 인정하는 근거는 아니다 — 그래서 `move`만
   * 별도로 조건부다(리뷰 blocker, `_workspace/review/feat-RQ-43-afk-kick.md`).
   */
  private touchAfkTimer(sessionId: string): void {
    if (!this.state.players.has(sessionId)) return
    this.lastInputAtTick.set(sessionId, this.state.tick)
  }

  /**
   * RQ-11: 명시적 재장전 요청(`sim-ammo.test.ts` 가정 4) — payload는 쓰지
   * 않는다(빈 객체 `{}`). 탄창이 가득 차 있어도 허용한다(GA-04 given의
   * "요청함" 갈래는 잔여탄과 무관하다). `shooterPlayer`가 없으면(관전자·
   * 이미 나간 세션) 조용히 무시한다 — `handleFire`의 "존재하지 않으면
   * 무시" 원칙과 동일.
   *
   * **리뷰 major 1**: `handleFire`(L267)와 동일하게 `canAct` 가드를 둔다 —
   * 시신도 `state.players`에 남아 있어(사망은 hp=0일 뿐 삭제가 아니다)
   * 가드가 없으면 시신이 재장전을 걸 수 있고, `respawnPlayer`가
   * `reloadStartedAtTick`을 지우지 않아 그 잠금이 리스폰을 넘어 살아남는다
   * (방금 부활한 멀쩡한 플레이어가 최대 ≈2초 사격 불가). 리스폰 시 그
   * 필드를 지울지는 별개의 게임 감각 결정이라 이번엔 바꾸지 않았다 — 이
   * 가드만으로 결함 경로가 닫힌다(자동 재장전은 `handleFire`가 `canAct`를
   * 통과한 뒤에만 트리거되므로 시신이 심을 수 없다).
   * **리뷰 major 2**: 이미 재장전 중이면 요청을 무시한다 — 매 수신마다
   * 기준 tick을 덮어쓰면 관측되는 재장전 시간이 RQ-11의 "2초"를 넘을 수
   * 있다(`'reload'`에는 rate-limit이 없어 키 오토리피트로도 도달 가능).
   */
  private handleReload(sessionId: string): void {
    const player = this.state.players.get(sessionId)
    if (!player) return
    if (!canAct(player.hp)) return // RQ-15: 시신은 재장전할 수 없다(handleFire와 동일)
    if (isReloading(this.reloadStartedAtTick.get(sessionId), this.state.tick, RELOAD_TICKS)) return

    // RQ-11 "요청하면" 갈래는 잔여탄과 무관하다(`shouldStartReload(_, true)`는
    // 항상 참, `src/shared/sim/ammo.ts:64-66`) — 위 재장전-중 가드를
    // 통과했다면 무조건 새 재장전을 시작한다(리뷰 minor 2: 죽은 조건문
    // 제거).
    this.reloadStartedAtTick.set(sessionId, this.state.tick)
  }

  /**
   * RQ-12(서버 hitscan) + RQ-13(헤드샷 배율) + RQ-14(HP·사망·킬) + RQ-15
   * (사망자 갭·리스폰 스케줄) + RQ-16(스폰 보호) + RQ-17(팀 없음 — 사수
   * 자신을 제외한 전원이 대상) + RQ-64(랙 보상) + ADR-0005(rate-limit).
   *
   * **사망자 갭(RQ-15 item D)**: `canAct(shooterPlayer.hp)`가 false면(시신)
   * 요청을 완전히 무시한다 — rate-limit 갱신도, `firedSinceSpawn` 갱신도
   * 하지 않는다(`_workspace/RQ-15-16/01_test-writer_red.md` §2.2 가정).
   * **즉시 판정(가정 D)**: 다음 시뮬레이션 틱을 기다리지 않고 수신 즉시
   * 판정한다 — RQ-12 원문 "hitscan(즉시 판정 레이캐스트)"의 직역.
   * **레이 원점**: `eyeOrigin(...)`(`@shared/sim/combat`, RQ-15~16 라운드
   * REV §12) — 사수의 현재 추적 위치(`moveStates`, RQ-20)에 눈높이를 더한
   * 지점을 인라인 산술이 아니라 이 공유 함수로 계산해, 클라이언트 1인칭
   * 카메라 높이 계산과 값이 어긋나지 않게 한다. **사수 자신의 레이 원점은
   * 되감기지 않는다**(RQ-64 원문 — "대상 플레이어의 위치"만 되감는다, 사수
   * 자신은 대상이 아니다).
   * **RQ-92 v2.2 자세(mode)**: 눈높이·히트박스는 더 이상 `DEFAULT_HITBOX`
   * 고정이 아니다 — `hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, mode)`로
   * **사수 자신의** `pendingInputs.mode`가 자신의 레이 원점(눈높이)에,
   * **각 피격 후보 자신의** `pendingInputs.mode`가 그 후보의 히트박스에
   * 개별 반영된다(자세 판정은 서버가 관측하는 값으로만 — RQ-61). 전환은
   * 같은 판정 안에서 즉시 반영된다(`hitboxForMode`가 순수 함수라 보간·진행도
   * 상태 자체가 없다, GA-67). `findClosestHit`의 `hitbox` 인자가 후보
   * 전체에 균일하게 적용되므로, 서로 다른 자세가 섞인 후보 집합은 자세별로
   * 묶어(`standingCandidates`·`crouchCandidates`) `findClosestHit`을 그룹당
   * 한 번씩 호출한 뒤 **거리로** 더 가까운 쪽을 취한다 — `findClosestHit`의
   * "가장 가까운 것 하나" 계약은 그룹 안에서만 성립하므로, 그룹 간 최단
   * 거리 비교는 이 함수가 직접 한다(아래 `closest` 산출부).
   * **되감기 대상 포즈(RQ-64)**: 각 대상의 포즈는 `moveStates`(현재 위치)가
   * 아니라 `sampleRewoundPosition(positionHistory.get(id) ?? [], state.tick,
   * rewindTicksFor(input.rttMs))`로 구한다(없으면 `moveStates`로 폴백 —
   * 버퍼가 비어 있는 경우만 발생, `sampleRewoundPosition` 계약). 되감기
   * 틱 수는 서버가 `rewindTicksFor`로 상한(`REWIND_CAP_TICKS`=6, 200ms)에서
   * 클램프하므로, 사수가 임의로 먼 과거를 요구해도(RQ-61 방어) 상한을 넘지
   * 않는다.
   * **`firedSinceSpawn`(RQ-16)**: canAct·rate-limit을 통과해 사격을 실제로
   * 처리할 때마다(명중 여부와 무관하게) 사수 자신의 값을 true로 갱신한다.
   * **스폰 보호(RQ-16)**: 피해를 적용하기 직전 피해자가 보호 중이면
   * `applyDamageWithProtection`으로 피해를 무효화한다.
   * **사망 처리(RQ-15)**: `died`면 킬을 기록하고 `diedAtTick`을 남겨
   * `stepPlayerMovement`가 90틱 후 리스폰시킬 수 있게 한다.
   * **rate-limit 시각 조달**: `Date.now()` — `src/server`는 `src/shared`와
   * 달리 ADR-0008 lint 대상이 아니다(순수 판정 자체는 `canFire`로 위임해
   * 결정론을 지킨다).
   */
  private handleFire(shooterId: string, input: FireInput): void {
    const shooterPlayer = this.state.players.get(shooterId)
    if (!shooterPlayer) return // 관전자는 players에 없다 — 사격 불가
    if (!canAct(shooterPlayer.hp)) return // RQ-15: 시신은 사격할 수 없다

    const now = Date.now()
    const lastFireAt = this.lastFireAtMs.get(shooterId)
    if (!canFire(lastFireAt, now, WEAPON.FIRE_INTERVAL_MS)) return
    // 리뷰 minor 1: 이 갱신은 ammo 게이트(아래)보다 먼저 실행되므로, 그
    // 게이트에 막혀 실제로 발사되지 않은 요청도 rate-limit 예산을
    // 소모한다 — 의도된 동작이다(발사 *요청* 자체를 rate-limit 대상으로
    // 본다, 연타 억제). 반대로 두고 싶으면(ammo 게이트 통과 시에만 갱신)
    // 이 줄을 게이트 아래로 옮기면 된다 — 밸런싱 판단이라 이번엔 바꾸지
    // 않았다.
    this.lastFireAtMs.set(shooterId, now)

    // RQ-10/RQ-11(`sim-ammo.test.ts` 가정 2): canAct·rate-limit을 통과한
    // 뒤 탄창이 비었거나 재장전 중이면 요청을 완전히 무시한다(레이도 쏘지
    // 않는다) — `sanitizeMoveInput`의 "조용히 무시" 원칙과 동일. **순서
    // 고정**: rate-limit(ADR-0005, 위)이 항상 ammo 게이트(아래)보다 먼저
    // 실행된다 — 두 메커니즘은 독립이며 이 순서를 바꾸면 안 된다(계약
    // 가정 2 그대로). `_workspace/RQ-10-11/02_coder_green.md` §4가 이
    // 순서 자체가 통합 테스트 레이스의 배경이었음을 기록한다(구현이 아닌
    // 테스트의 지연 배치 결함으로 판명 — 이 순서를 되돌리는 것으로 "고치지"
    // 않았다).
    const magazine = this.magazines.get(shooterId) ?? WEAPON.MAGAZINE
    const reloadStartedAt = this.reloadStartedAtTick.get(shooterId)
    if (!canFireAmmo(magazine, reloadStartedAt, this.state.tick, RELOAD_TICKS)) return

    const shooterState = this.moveStates.get(shooterId)
    if (!shooterState) return

    // RQ-31: Safe Zone(스폰 지점 반경 4m, v1.5) 내부에서는 사격이 불가능하다(무기
    // 비활성화 — 세이프존을 엄폐물 삼은 스폰 캠핑 방지). 사수 자신의 현재
    // 위치(`moveStates`, RQ-61 서버 권위 — 클라 payload가 아니다)로 판정한다.
    // rate-limit·탄약 게이트(위)를 이미 통과했더라도 여기서 걸리면 요청을
    // 완전히 무시한다 — **탄약 소모(아래 `consumeRound`)와 `firedSinceSpawn`
    // 갱신 이전**에 게이트를 둔 이유는, "발사 자체가 일어나지 않았다"(RQ-31
    // 원문)를 관측 가능한 부작용 전체(HP·탄약 둘 다)로 성립시키기 위해서다
    // (GA-19). `WORLD.SAFE_ZONE_ALLOWS_FIRING`을 상수로 참조해(리터럴 `false`
    // 복제 금지, ADR-0010) 나중에 이 값이 뒤집혀도 게이트 자체는 그대로
    // 재사용된다.
    if (!WORLD.SAFE_ZONE_ALLOWS_FIRING && isWithinSafeZone(shooterState)) return

    // RQ-16: 사격 행위 자체(명중 여부 무관)로 사수 자신의 스폰 보호를
    // 즉시 해제한다.
    this.firedSinceSpawn.set(shooterId, true)

    // RQ-10/RQ-11(가정 3): 위 게이트를 모두 통과해 사격이 실제로 처리되므로
    // (명중 여부 무관, `firedSinceSpawn`과 동일 정신) 1발을 소모한다. 소모
    // 결과 탄창이 0이 되면(`shouldStartReload(newMagazine, false)`) 그
    // 시점의 tick으로 자동 재장전을 시작한다.
    const newMagazine = consumeRound(magazine)
    this.magazines.set(shooterId, newMagazine)
    if (shouldStartReload(newMagazine, false)) {
      this.reloadStartedAtTick.set(shooterId, this.state.tick)
    }

    // RQ-90: 클라이언트가 보낸 조준 방향(input.dirX/Y/Z)을 가공 없이 레이로
    // 쓰지 않는다 — 서버가 발급(또는 테스트가 강제)한 시드로 콘 편차를
    // 얹은 뒤에 판정한다(RQ-61: 시드·콘 반경 모두 클라이언트 payload에서
    // 읽지 않는다 — `sanitizeFireInput`이 애초에 그런 필드를 받지 않는다).
    // `spreadTuningOverride`가 없으면 `DEFAULT_SPREAD`(출하 기본값, 아래
    // `effectiveSpreadConeRadius`)를 쓴다 — v1.8부터 기본 콘 반경이 0.5°로
    // 확정돼(원장 25a-10) 더 이상 정조준 항등 함수가 아니다(과거 이 코멘트가
    // 서술하던 "반경 0" 전제는 v1.8로 끝났다 — `applySpread` 자체의
    // `coneRadiusRad===0` 항등 계약은 그대로다, `applySpread` docblock).
    //
    // 리뷰 blocker 수정(`_workspace/review/feat-RQ-90-spread-seed-
    // determinism.md`): `applySpread`의 계약(`combat.ts:255-264`)은
    // `direction`이 **이미 정규화된 단위 벡터**임을 전제한다 — 이 전제는
    // 지금까지 `raycastHitbox`(`combat.ts:161-166`) 자신이 자기 안에서
    // 지켜 왔다(첫 소비자가 그 함수였으므로). `applySpread`를 그 앞에
    // 끼워 넣으면서 정규화 이전 값이 먼저 소비되게 됐다 — 여기서
    // `raycastHitbox`와 **동일한 임계(1e-12)**로 먼저 가드를 세워 계약을
    // 성립시킨다(정규화를 `applySpread` 내부로 옮기지 않는다 — 그건
    // `combat.ts` 계약 자체를 바꾸는 일이라 이번 라운드 범위 밖이다).
    // 이 가드는 rate-limit·탄약 소모(위) **뒤**에 있다 — 조준이 퇴화해도
    // 그 두 게이트는 이미 정상적으로 소모됐고(요청 자체는 유효했다),
    // 판정만 무효화(빗나감과 동일한 결과)한다. `dirMagnitude === 0`
    // (또는 비유한)인 입력은 이전에도 `raycastHitbox`가 결국 빗나감으로
    // 처리했으므로 관측 가능한 동작은 바뀌지 않는다.
    //
    // 리뷰 N7: 임계를 `1e-12` 리터럴로 복제하지 않고 `combat.ts`가 export한
    // `DEGENERATE_RADIAL_EPS`를 그대로 재사용한다(ADR-0010 값 복제 금지) —
    // `applySpread`가 `raycastHitbox`보다 먼저 이 값을 소비하므로, 두 곳의
    // 퇴화 임계가 갈리면 "정규화는 통과했는데 raycastHitbox는 거부"(또는 그
    // 반대)가 생겨 두 층위의 판정이 어긋난다. 값은 같으므로 순수 재사용이고
    // 동작은 바뀌지 않는다.
    const rawAim = { x: input.dirX, y: input.dirY, z: input.dirZ }
    const dirMagnitude = Math.sqrt(rawAim.x ** 2 + rawAim.y ** 2 + rawAim.z ** 2)
    if (!Number.isFinite(dirMagnitude) || dirMagnitude < DEGENERATE_RADIAL_EPS) return
    const aimDirection = { x: rawAim.x / dirMagnitude, y: rawAim.y / dirMagnitude, z: rawAim.z / dirMagnitude }

    // RQ-90 v1.9: 정확도 저하 3단계 — 판정 근거는 사격 시점의 `dirX`·
    // `dirZ`·`mode`(가장 최근 'move' 메시지, `pendingInputs`)와 `grounded`
    // (현재 `moveStates`, 위에서 이미 읽은 `shooterState`) 넷뿐이다(시점
    // 회전·클라 자기신고는 배제 — `effectiveSpreadConeRadius` 시그니처
    // 자체가 그 제한을 타입으로 잠근다). `pendingInputs`에 아직 값이
    // 없으면(방금 접속) `IDLE_MOVE_INPUT`(dirX:0, dirZ:0, mode:'run')으로
    // 폴백 — 다른 모든 `pendingInputs` 소비 지점과 동일한 관례. 이 폴백은
    // `dirX=dirZ=0`이라 v1.9의 "정지" 판정에 정확히 해당한다(v1.8에서는
    // `mode:'run'`만 보고 "이동"으로 오분류됐던 바로 그 자리).
    const spreadTuning = this.spreadTuningOverride ?? DEFAULT_SPREAD
    const spreadSeed = this.forcedSpreadSeed ?? this.issueSpreadSeed()
    const shooterInput = this.pendingInputs.get(shooterId) ?? IDLE_MOVE_INPUT
    const effectiveConeRadius = effectiveSpreadConeRadius(
      spreadTuning,
      shooterInput.dirX,
      shooterInput.dirZ,
      shooterInput.mode,
      shooterState.grounded,
    )
    const spreadDirection = applySpread(aimDirection, createRng(spreadSeed), effectiveConeRadius)

    // RQ-92 v2.2: 사수 자신의 눈높이도 자신의 `mode`(위에서 이미 읽은
    // `shooterInput`)로 결정한다 — 앉았으면(`'crouch'`) 레이 원점이 발+1.222m,
    // 그 외(run·walk)는 발+1.700m다(GA-64).
    const shooterHitbox = hitboxForMode(DEFAULT_HITBOX, CROUCH_HITBOX, shooterInput.mode)
    const ray: Ray = {
      origin: eyeOrigin({ x: shooterState.x, y: shooterState.y, z: shooterState.z }, shooterHitbox.eyeHeightM),
      direction: spreadDirection,
    }

    // RQ-64: 사수가 보고한 RTT를 되감기 틱 수로 환산(+상한 클램프)한다 —
    // 대상 전원에게 동일하게 적용되는 값이라 순회 밖에서 한 번만 계산한다.
    const rewindTicks = rewindTicksFor(input.rttMs)

    // RQ-92 v2.2: 후보를 **자신의** `pendingInputs.mode`로 자세별 두
    // 그룹(선 자세·앉은 자세)으로 나눈다 — `findClosestHit`의 `hitbox`
    // 인자가 후보 전체에 균일하게 적용되므로, 서로 다른 자세가 섞인 후보
    // 집합을 한 번의 호출로 정확히 판정할 수 없다(아래 `closest` 산출부에서
    // 그룹별 결과를 거리로 다시 비교한다).
    const standingCandidates: HitCandidate[] = []
    const crouchCandidates: HitCandidate[] = []
    this.state.players.forEach((player, sessionId) => {
      if (sessionId === shooterId) return // RQ-17: 팀 없음 — 사수 자신만 제외, 그 외 전원이 대상
      // 리뷰 minor 3 — 시신 통과(사용자 결정, 스펙·골든 미규정 영역):
      // 시신이 뒤에 있는 산 사람에게 갈 총알을 흡수하는 "최대 3초(리스폰
      // 전까지) 총알 방패"가 비직관적이라는 리뷰 지적에, 시신은 hitscan
      // 대상에서 아예 제외하기로 결정했다. 위 §"사망자 갭"의
      // `canAct(shooterPlayer.hp)` 가드(사수 쪽)와는 별개다 — 이건
      // **피격 대상 쪽** 필터다: 시신은 쏠 수도 없고(사수 가드), 맞을
      // 수도 없다(이 가드). 밸런싱 단계에서 뒤집힐 수 있는 게임 감각
      // 결정이며, 뒤집는다면 이 한 줄만 지우면 된다.
      if (!canAct(player.hp)) return
      // RQ-64: 대상 포즈는 되감긴 위치를 우선 쓴다 — 버퍼가 비어 있으면만
      // (접속 직후 등, `sampleRewoundPosition([]) === undefined`)
      // `moveStates`(현재 위치)로 폴백한다.
      const rewound = sampleRewoundPosition(this.positionHistory.get(sessionId) ?? [], this.state.tick, rewindTicks)
      const targetState = rewound ?? this.moveStates.get(sessionId)
      if (!targetState) return
      const candidate: HitCandidate = { id: sessionId, pose: { position: { x: targetState.x, y: targetState.y, z: targetState.z } } }
      // RQ-92 v2.2: 이 후보 **자신의** 가장 최근 'move' 입력(`mode`)으로
      // 자세를 판정한다(RQ-61 — 사수가 보고한 값이 아니다). 아직 값이
      // 없으면(방금 접속) `IDLE_MOVE_INPUT`(mode:'run')으로 폴백 — 다른 모든
      // `pendingInputs` 소비 지점과 동일한 관례.
      const candidateMode = (this.pendingInputs.get(sessionId) ?? IDLE_MOVE_INPUT).mode
      if (candidateMode === 'crouch') {
        crouchCandidates.push(candidate)
      } else {
        standingCandidates.push(candidate)
      }
    })

    // RQ-12 v1.7: hitscan 차폐 질의는 `wallsOverride`가 설정돼 있으면(`[]`
    // 포함) 그 값을, 아니면(`undefined`, 기본값) 실제 맵 벽(`PRODUCTION_WALLS`)
    // 을 쓴다 — 이동 충돌(`stepPlayerMovement`, RQ-30)은 이 오버라이드와
    // 무관하게 항상 `PRODUCTION_WALLS`만 쓴다(위 필드 코멘트, 범위 한정).
    const occlusionWalls = this.wallsOverride ?? PRODUCTION_WALLS
    const standingHit = findClosestHit(ray, standingCandidates, DEFAULT_HITBOX, occlusionWalls)
    const crouchHit = findClosestHit(ray, crouchCandidates, CROUCH_HITBOX, occlusionWalls)
    // RQ-92 v2.2: `findClosestHit`의 "관통 없음 — 가장 가까운 것 하나만"
    // 계약(가정 F)은 **그룹 안에서만** 성립한다 — 두 그룹을 합친 전체에서
    // 가장 가까운 하나를 얻으려면 이 함수가 직접 거리로 비교해야 한다.
    let closest: ClosestHit | undefined
    if (standingHit && crouchHit) {
      closest = (standingHit.result.distance as number) <= (crouchHit.result.distance as number) ? standingHit : crouchHit
    } else {
      closest = standingHit ?? crouchHit
    }
    if (!closest || !closest.result.region) {
      // RQ-70/ADR-0016 결정 1 후속 1 — 플레이어를 맞히지 못했다. 벽 명중은
      // **여기서만** 계산한다: 기존 occlusion 판정(위 findClosestHit 호출,
      // `isOccludedByWall`의 엄격 부등호 — "같은 거리는 차폐 아님")상
      // `closest`가 존재한다는 것은 그보다 **엄격히** 가까운 벽이 없다는
      // 뜻이므로(동률 경계는 스코프 밖 — `sim-combat-wall-hit.test.ts`
      // "스코프 밖" 절과 동일 근거), `closest`가 없을 때만 벽 계산이
      // 필요하다 — 있을 때 매번 다시 계산하지 않는다(틱 예산, RQ-60).
      // `occlusionWalls`(위에서 이미 확정한 값)를 그대로 재사용해 벽 좌표를
      // 복제하지 않는다.
      const wallHit = findClosestWallHit(ray, occlusionWalls)
      if (wallHit) {
        const event: HitEvent = { point: wallHit.point, normal: wallHit.normal, target: 'wall' }
        this.broadcast('hit', event)
      }
      return
    }

    const victim = this.state.players.get(closest.id)
    if (!victim) return

    // RQ-71/ADR-0016 결정 1 — 플레이어 명중. `raycastHitbox`(findClosestHit
    // 내부)가 이미 계산한 point·normal을 그대로 옮긴다(재계산 없음 — GA-98
    // "이벤트 값 그대로" 원칙의 발신측 대응). 스폰 보호로 피해가
    // 무효화되더라도 레이 자체는 실제로 명중했으므로 이벤트는 그대로 보낸다
    // (아래 보호 판정과 무관 — "맞았다"는 관측과 "피해가 들어갔다"는 서로
    // 다른 사실이다).
    const hitEvent: HitEvent = {
      point: closest.result.point as Vec3,
      normal: closest.result.normal as Vec3,
      target: 'player',
    }
    this.broadcast('hit', hitEvent)

    const victimSpawnedAt = this.spawnedAtTick.get(closest.id)
    const victimFired = this.firedSinceSpawn.get(closest.id) ?? false
    const isSpawnTimeProtected =
      victimSpawnedAt !== undefined &&
      isSpawnProtected(victimSpawnedAt, this.state.tick, SPAWN_PROTECTION_TICKS, victimFired)
    // RQ-31: 위치 기반 보호(Safe Zone) — RQ-16(시간 기반, 위)과 OR로
    // 합성한다. 둘은 서로 다른 축의 독립된 무효화 조건이다 — RQ-16은 스폰
    // 직후 한동안(시간), RQ-31은 스폰 지점 반경 안에 있는 동안(위치) 무효화
    // 한다. 어느 한쪽만 참이어도 피해는 전액 무효화된다(피해가 "이중으로"
    // 줄어드는 개념이 아니라 애초에 적용되지 않는 것이므로 OR가 자연스러운
    // 합성이다). 피격자의 위치는 **되감기 이전** 현재 위치(`moveStates`)로
    // 판정한다 — RQ-64 되감기는 "레이가 실제로 맞았는가"를 보정하는
    // 지연 보상일 뿐, Safe Zone 소속(RQ-31 원문 "반경을 벗어나면 즉시
    // 해제")까지 과거 시점으로 되돌릴 근거가 없다. `moveStates`가 없으면
    // (이 지점에 도달했다는 것은 위 candidates 구성에서 targetState가
    // 존재했다는 뜻이라 이론상 발생하지 않는다) 스키마 좌표로 폴백한다.
    // `trackFallDamage`(아래, RQ-18)도 동일한 OR 합성을 쓴다 — 피해원이
    // hitscan이든 낙하든 RQ-16·RQ-31 보호는 대칭이어야 한다(사용자 결정
    // 2026-07-28, 그쪽 docblock 참고).
    const victimCurrentState = this.moveStates.get(closest.id)
    const isSafeZoneProtected = isWithinSafeZone(victimCurrentState ?? { x: victim.x, z: victim.z })
    const isProtected = isSpawnTimeProtected || isSafeZoneProtected

    const outcome = applyDamageWithProtection(victim.hp, damageForRegion(closest.result.region), isProtected)
    victim.hp = outcome.hp
    if (outcome.died) {
      // RQ-81: 헤드샷 통계는 킬의 부분집합(§5.1 설계 결정 1) — 이 판정에
      // 쓴 것과 동일한 `region` 값을 그대로 넘겨 두 판정이 어긋나지 않게 한다.
      this.registerDeath(closest.id, this.state.tick, shooterId, closest.result.region === 'head')
    }
  }

  /**
   * RQ-90 v1.9(22v/22w) — `forcedSpreadSeed`(테스트 전용)가 설정돼 있지
   * 않을 때 서버가 스스로 조달하는 탄퍼짐 시드. `spreadSalt`(이 룸만 아는
   * 값, 위 필드 코멘트)를 기반(`createRng`)으로 `state.tick`(RQ-60 결정론적
   * 시뮬레이션 시계)과 `spreadSeedCounter`(이 룸이 처리한 사격 발수, 사격
   * 마다 1씩 전진)를 각각 `fork()`로 섞어 최종 시드를 뽑는다.
   *
   * **REV(리뷰 blocker 1, 원장 22v)**: 이전 구현(`((tick<<16)^counter)>>>0`)
   * 은 `tick`·`counter` 둘 다 사실상 클라이언트가 재현 가능한 값이었다 —
   * `state.tick`은 `@type('number')`로 전 클라이언트에 동기화되고,
   * `spreadSeedCounter`는 룸당 0부터 1씩 증가하는 예측 가능한 값이다.
   * `createRng`·`applySpread`는 `src/shared`라 클라 번들에 그대로 들어가므로
   * (ADR-0010 단일 패키지), 공격자가 서버와 비트 단위로 같은 함수를 쥔 채
   * 이 두 값만 맞추면 편차를 사전 계산해 조준으로 상쇄할 수 있었다 — 탄퍼짐
   * 기능이 도입되고도 사실상 무력화된 채 출하되는 상태였다. `spreadSalt`는
   * 클라가 알 수 없으므로(위 필드 코멘트) 이 문제를 막는다 — **클라가 아는
   * 값(`tick`)만으로는 이 시드를 만들 수 없다**는 것이 이 수정이 성립시키는
   * 성질이다("예측 불가"라고 단정하지 않는다 — salt 자체가 32비트라 관측된
   * 편차로부터의 오프라인 전수 탐색까지 막지는 못한다, 원장 26az 이월).
   *
   * `tick<<16` 별칭(30Hz에서 tick이 32768을 넘으면 부호 비트를 넘고 65536틱
   * 마다 상위 비트가 순환하던 문제)도 이 REV로 함께 사라졌다 — `fork()`는
   * 비트 시프트가 아니라 해시(`mixSeed`, `rng.ts`)로 섞으므로 그런 별칭이
   * 없다.
   *
   * 시드 재료(`spreadSalt`·`state.tick`·`spreadSeedCounter`) 자체는
   * `Math.random()`이 아니라 서버 상태(+룸 생성 시 1회 발급된 salt)에서
   * 나오므로 매 사격마다 `Math.random()`을 부르는 것이 아니다 — ADR-0008이
   * 금지하는 것은 편차 계산 자체(`applySpread` 내부)를 `Math.random()`으로
   * 하는 경우인데, 여기서는 이 시드로 만든 `createRng`의 `SeededRng`만
   * 거친다. 한 틱에 여러 발(다른 사수·재발사)이 겹쳐도 `spreadSeedCounter`가
   * 매번 전진하므로 시드가 겹치지 않는다(같은 (tick, counter) 조합이 두 번
   * 나오지 않는다는 것의 단언 고정은 이 라운드 범위 밖 — test-writer 이월).
   */
  private issueSpreadSeed(): number {
    const counter = this.spreadSeedCounter
    this.spreadSeedCounter = (this.spreadSeedCounter + 1) >>> 0
    // `forcedRoomSalt`(테스트 전용, 위 필드 코멘트)가 있으면 `spreadSalt`
    // **자리에서** 대체한다 — `tick`·`counter`와는 여전히 fork로 섞인다.
    // REV(리뷰 지적): 이전 구현은 이 값을 fork 없이 그대로 반환해 사실상
    // `forcedSpreadSeed`(시드 자체 강제)와 기능이 겹쳤고, salt→시드 구간
    // (fork 배선)이 이 경로에서 시험되지 않았다 — "salt"라는 이름과 실제
    // 동작이 어긋났다. 지금은 진짜 salt 대체라 이름이 사실이 되고,
    // `forcedSpreadSeed`(시드 고정)와 역할이 분명히 갈린다(salt 고정 vs
    // 시드 고정).
    const salt = this.forcedRoomSalt ?? this.spreadSalt
    // 2차 리뷰 minor 4 — `fork(this.state.tick)`은 tick이 2^32 이상이면
    // `RangeError`를 던진다(`rng.ts`의 `assertValidSeed`, 17e-1① 신설
    // 경로). 30Hz 기준 약 4.5년 연속 가동해야 도달한다 — 의도된 동작이며,
    // 그 전에 서버가 재시작된다는 전제다(이전 `>>> 0` 공식은 조용히
    // 랩어라운드했으나 이 델타가 처음으로 이 예외 경로를 만들었다).
    return createRng(salt).fork(this.state.tick).fork(counter).nextU32()
  }

  /**
   * 사망 처리 중앙화(원장 22e, RQ-15/16 후속 ① 해소) — 피해원과 무관하게
   * 사망 시 `diedAtTick`을 한 곳에서 갱신한다. 이전에는 `handleFire`
   * 한 곳에서만 `diedAtTick.set`을 호출해, 낙하 등 다른 피해원으로 죽으면
   * `stepPlayerMovement`의 `isRespawnDue` 판정 대상이 되지 못하고 영구
   * 시신이 되는 결함이 있었다(GA-46이 이 회귀를 고정).
   *
   * `killerId`가 있으면(hitscan) 그 가해자의 킬 카운트를 올린다 — 낙하 등
   * 환경 피해(`killerId` 없음)는 가해자가 없으므로 킬을 기록하지 않는다
   * (`_workspace/RQ-18/01_test-writer_red.md` §3, 스코프 크리프 방지).
   *
   * **RQ-81 통계**: 피해원과 무관하게(hitscan이든 낙하든) 피해자의 uuid가
   * 있으면 항상 `recordDeath`를 부른다 — "데스"는 가해자 유무와 무관한
   * 개념이다(이 함수가 "피해원과 무관하게 diedAtTick을 한 곳에서 갱신"하는
   * 것과 같은 정신). 가해자가 있고 그 uuid도 있으면 `recordKill`을 함께
   * 부른다 — `isHeadshot`은 `handleFire`가 `closest.result.region ===
   * 'head'`를 그대로 넘긴다(§5.1 "헤드샷은 킬의 부분집합").
   *
   * `fallPeakY`도 함께 정리한다 — 사인과 무관하게 사망은 "현재 공중 구간
   * 추적"을 끝내야 한다. 그렇지 않으면(예: 공중에서 피격사) 리스폰 후
   * 다음 낙하가 죽기 전 남은 최고점을 잘못 이어받아 과다 피해로 이어질 수
   * 있다. 낙하 자체로 죽는 경로(`trackFallDamage`)는 착지 처리 마지막에
   * 다시 한번 무조건 삭제하므로 이 삭제와 중복돼도 안전하다(멱등).
   */
  private registerDeath(victimId: string, currentTick: number, killerId?: string, isHeadshot?: boolean): void {
    const victimUuid = this.playerUuids.get(victimId)
    if (victimUuid !== undefined) {
      recordDeath(this.statsDb, victimUuid)
    }
    if (killerId !== undefined) {
      const killer = this.state.players.get(killerId)
      if (killer) killer.kills += 1
      const killerUuid = this.playerUuids.get(killerId)
      if (killerUuid !== undefined) {
        recordKill(this.statsDb, killerUuid, isHeadshot ?? false)
      }
    }
    this.diedAtTick.set(victimId, currentTick)
    this.fallPeakY.delete(victimId)
  }

  /**
   * RQ-18(낙하 데미지) — `stepPlayerMovement`가 `next = stepMovement(previous,
   * input)`을 계산한 직후 호출한다(그린필드 계약,
   * `_workspace/RQ-18/01_test-writer_red.md` §1.3).
   *
   * 1. `next.grounded === false`(공중)면 러닝 최댓값으로 `fallPeakY`를
   *    갱신하고 끝낸다 — 아직 착지 전이가 아니다.
   * 2. `previous.grounded === false && next.grounded === true`(착지
   *    전이)면 그 구간의 최고점으로 데미지를 산정해 적용한다. 스폰 보호
   *    게이트는 `handleFire`가 피격자에게 쓰는 것과 동일한 지점
   *    (`spawnedAtTick`/`firedSinceSpawn`)을 재사용한다 — RQ-16이 명시한
   *    "그 플레이어가 받는 **모든 피해**"에 낙하가 포함되므로 스펙 침묵이
   *    아니라 문면 이행이다. **RQ-31(Safe Zone)도 동일한 이유로 여기
   *    합류한다(사용자 결정, 2026-07-28)** — RQ-31 원문 "Safe Zone 내부의
   *    플레이어가 받는 피해를 무효화해야 한다" 역시 피해원을 hitscan으로
   *    한정하지 않는다. RQ-16과 여기서 갈리면(하나는 낙하 포함, 하나는
   *    제외) "스폰 3.000초까지는 세이프존 안에서 낙하 무피해, 3.001초부터는
   *    같은 자리에서 피해가 든다"는 자기모순이 생긴다 — 어떤 스펙 문장도
   *    그 비대칭을 규정하지 않는다. 위치는 `handleFire`의 피격자 판정과
   *    동일 기준(착지 시점의 현재 `moveStates`, 즉 이 함수의 `next`)으로
   *    판정한다(원장 25h). 이 게이트가 처음 배선됐을 때는 `rq-18-fall-damage
   *    .test.ts`/`rq-92-fall-damage-curve.test.ts`가 스폰 지점 반경 안에서
   *    착지하는 옛 시나리오 그대로라 일시적으로 깨졌었다 — 골든이 이
   *    합류를 금지해서가 아니라 그 두 파일이 (다른 20개 통합 테스트와
   *    마찬가지로) 아직 Safe Zone 밖으로 옮겨지지 **않았던** 시점의 상태였다.
   *    그 뒤 `dfd63e7`이 두 파일에 방사 탈출(escapeSafeZone)을 적용해
   *    낙하 시나리오를 Safe Zone 밖에서 벌어지도록 옮겼고, 지금은 둘 다
   *    Green이다(`rq-18-fall-damage.test.ts`·
   *    `rq-92-fall-damage-curve.test.ts` 전부 통과). **건수는 적지 않는다** —
   *    주석에 박은 수치는 다음 커밋에서 낡는다(이 저장소에서 두 번째
   *    재발. 실제로 `9ff5321`이 곧바로 rq-18에 `it()`을 더해 7→8이 됐다).
   *    사망 시 가해자가 없으므로 `registerDeath`를 `killerId` 없이 호출한다(킬
   *    카운트 미증가, `diedAtTick`만 갱신). 처리 후에는 항상(생존이든
   *    사망이든) `fallPeakY`를 삭제해 다음 공중 구간을 위해 초기화한다.
   * 3. 그 외(계속 접지 상태)는 아무 것도 하지 않는다.
   */
  private trackFallDamage(sessionId: string, player: Player, previous: MoveState, next: MoveState, currentTick: number): void {
    if (!next.grounded) {
      this.fallPeakY.set(sessionId, Math.max(this.fallPeakY.get(sessionId) ?? next.y, next.y))
      return
    }

    if (previous.grounded) return // 착지 전이가 아니다 — 계속 접지 상태였다

    // `fallDamageForHeight`의 계약은 절대 y가 아니라 **낙차**다. RQ-22
    // (원장 25a-4)로 박스가 들어오면서 착지 y가 0이 아닌 경우가 **실제로
    // 생겼다** — `groundedOutcome`은 이제 지지 높이를 `max(0, 발밑 박스
    // 상단)`으로 계산한다. 따라서 이 뺄셈이 **낙차의 유일한 정의**다 —
    // 빼지 않으면 높은 지대에 서 있다가 조금만 뛰어도 데미지가 들어가는
    // 형태로 조용히 뒤집힌다
    // (리뷰 minor 1). 키 부재는 `next.y`로 폴백해 낙차 0이 되게 한다.
    const peak = this.fallPeakY.get(sessionId) ?? next.y
    const damage = fallDamageForHeight(peak - next.y)
    if (damage > 0) {
      const spawnedAt = this.spawnedAtTick.get(sessionId)
      const fired = this.firedSinceSpawn.get(sessionId) ?? false
      const isSpawnTimeProtected = spawnedAt !== undefined && isSpawnProtected(spawnedAt, currentTick, SPAWN_PROTECTION_TICKS, fired)
      // RQ-31: `handleFire`의 피격자 보호와 동일한 OR 합성(그쪽 주석·위
      // docblock 참고, 사용자 결정 2026-07-28) — 착지 위치(`next`, 이 틱에서
      // 막 확정된 실제 위치)로 Safe Zone 소속을 판정한다.
      const isSafeZoneProtected = isWithinSafeZone(next)
      const isProtected = isSpawnTimeProtected || isSafeZoneProtected

      const outcome = applyDamageWithProtection(player.hp, damage, isProtected)
      player.hp = outcome.hp
      if (outcome.died) {
        this.registerDeath(sessionId, currentTick) // 환경 피해 — 가해자 없음, 킬 미기록
      }
    }
    this.fallPeakY.delete(sessionId)
  }

  /**
   * RQ-40(Global Chat) + RQ-95(금칙어 필터) + RQ-41(관전자 참여) —
   * ADR-0002 "같은 Colyseus 룸의 메시지 채널" 설계(`_workspace/RQ-40/
   * 01_test-writer_red.md` §3.3).
   *
   * **순서 보장(GA-12)**: 이 핸들러가 동기적으로 이력 갱신 →
   * 브로드캐스트를 마친다 — 별도 큐·비동기 처리를 두지 않으므로, Colyseus의
   * 단일 룸·단일 이벤트 루프 전제(ADR-0002) 위에서 메시지 도착 순서가 곧
   * 브로드캐스트 순서다.
   * **필터(RQ-95)**: 브로드캐스트하기 **전에** `filterProfanity`를 적용한다
   * — 원문이 네트워크를 타지 않는다. 필터링된 값을 이력에도 저장해(아래
   * `chatHistory.push`) 실시간 경로와 이력 복원 경로 양쪽에서 같은 필터
   * 적용 지점 하나를 공유한다(원문 유출 우회로 차단).
   * **전원 브로드캐스트(RQ-41)**: `this.broadcast()`는 `players`/
   * `spectators` 컬렉션과 무관하게 이 룸에 연결된 모든 클라이언트에
   * 전송한다 — 관전자도 발신·수신 양쪽에 참여하고, 전송자 자신도 포함된다
   * (자기 메시지도 서버 확정 형태로 동일 채널에서 렌더링하기 위함).
   * **상한(50, `UI.CHAT_HISTORY`)**: 초과분은 배열 앞(가장 오래된 것)부터
   * 폐기한다.
   */
  private handleChat(senderId: string, text: string): void {
    const nickname = this.resolveNickname(senderId)
    if (nickname === undefined) return // onLeave와 경합해 이미 나간 세션 — 방어적 가드

    const message: ChatMessage = { nickname, text: filterProfanity(text) }
    this.chatHistory.push(message)
    if (this.chatHistory.length > UI.CHAT_HISTORY) {
      this.chatHistory.shift()
    }

    this.broadcast('chat', message)
  }

  /** 발신자의 확정 닉네임을 `players`·`spectators` 어느 쪽에 있든 찾는다
   * (RQ-41: 채팅 발신 주체가 둘 중 하나로 고정되지 않는다). */
  private resolveNickname(sessionId: string): string | undefined {
    return this.state.players.get(sessionId)?.nickname ?? this.state.spectators.get(sessionId)?.nickname
  }

  /**
   * RQ-60: 30Hz 고정 틱. 결정론 하네스(`src/shared/sim/{clock,scheduler,
   * tickDriver}`, 원장 17e 계약 + 이번 RQ의 `tickDriver`)는 그대로 두고,
   * 실 경과 시간 측정·구동만 이 룸(서버 경계)의 책임이다(ADR-0008: 실시간
   * API 직접 호출 금지 lint는 `src/shared`에만 적용된다).
   *
   * 구동 API로 Colyseus 0.16.5의 `Room.setSimulationInterval(cb, delay)`를
   * 택했다(2026-07-22, `node_modules/@colyseus/core/build/Room.js` 실측) —
   * `this.clock`(`@colyseus/timer` `ClockTimer`)이 매 호출마다 `tick()`으로
   * 실 경과 시간을 재 `deltaTime`(Date.now 기반)에 담고, 그 값을 콜백 인자로
   * 넘긴다. 즉 우리가 직접 `Date.now()`를 부르지 않고도 실측 경과 ms를 받을
   * 수 있다 — Colyseus 자신의 시간 측정 코드는 `@colyseus/core` 내부
   * (`src/server` 경계 밖의 서드파티)이므로 ADR-0008 lint 대상이 아니다.
   * `setInterval` 직접 사용 대신 이 API를 쓰는 이유는 room dispose 시 정리를
   * Colyseus가 이미 보장하기 때문이다(아래 참고).
   *
   * dispose 정리: `Room._dispose()`(`Room.js`)가 `_simulationInterval`을
   * 자동으로 `clearInterval`한다 — RQ-04 종료 드레인(`app.close()` →
   * `gameServer.gracefullyShutdown()` → 룸 disconnect → `_dispose()`)이
   * 이미 거치는 경로이므로 별도 `onDispose` 정리를 추가할 필요가 없다(직접
   * 만든 실 타이머가 없다 — `clock`·`scheduler`·`tickDriver`는 순수 객체).
   *
   * RQ-20: `driver.advanceByElapsed(deltaMs)`가 반환하는 값은 이번 실
   * 콜백에서 실제로 전진한 틱 수다(catch-up으로 여러 틱일 수도, clamp
   * 초과로 0일 수도 있다 — RQ-60). 이동은 그 틱 수만큼 정확히 반복
   * 호출한다 — `stepMovement`(`@shared/sim/movement`)가 벌크 전진을
   * 허용하지 않는 정확히-1틱 계약이기 때문이다(위 scheduler.advanceTo와
   * 같은 불변식).
   */
  private startTickLoop(): void {
    const clock = createClock()
    const scheduler = createScheduler(clock)
    const driver = createTickDriver(clock, scheduler, {
      // RQ-60 v1.1(원장 20a-2, PR #10 리뷰 major-2): 누적 밀림이 1초치를
      // 넘는 비정상 정지(GC 장기 정지·OS 서스펜드)에서는 tickDriver가 밀림
      // 전량을 버리고 이 훅을 부른다 — "경고를 남긴다" 규범을 이행하는
      // 유일한 지점이 여기다(호출 안 하면 조용히 시간이 유실된다).
      // `console.warn`은 관례상 stdout이 아니라 stderr로 나간다. 그래도
      // 관측 가능한 이유는 ADR-0009(도커 배포)가 규정하는 로그 수집 경로
      // 때문이 아니라(ADR-0009는 로그 수집 스트림을 규정하지 않는다 —
      // docker-compose·Nginx·Redis만 다룬다) 도커 로그 드라이버 자체가
      // 컨테이너 표준 스트림(stdout·stderr 양쪽)을 수집하는 일반 동작
      // 때문이다 — 운영자는 `docker logs`로 이 경고를 그대로 볼 수 있다.
      // 콘솔 경고 + droppedTicks 포함이라는 로깅 정책 자체의 출처는
      // ADR이 아니라 harness/progress.md 20a-2 착수 기록(오케스트레이터
      // 결정, 사용자 위임 하)이다. droppedTicks를 그대로 실어 운영자가
      // 유실 규모를 알 수 있게 한다.
      onOverflow: (droppedTicks: number) => {
        console.warn(
          `[GameRoom] RQ-60 v1.1: 비정상 정지로 밀린 틱 ${droppedTicks}개를 유실했습니다(경고 후 현재 시간으로 재정렬).`,
        )
      },
    })

    this.setSimulationInterval((deltaMs: number) => {
      const advancedTicks = driver.advanceByElapsed(deltaMs)
      // RQ-15/16: `advanceByElapsed`는 자신의 내부 루프에서 이미 `clock`을
      // 최종 목표 틱까지 전진시켜 놓고 반환한다 — 그래서 이 시점의
      // `clock.tick`은 "이번 콜백에서 도달한 마지막 틱"이다. 각 반복이
      // 자신이 실제로 대응하는 틱 번호(리스폰·보호 판정의 `currentTick`)를
      // 받도록 역산한다(스케줄러의 `advanceTo` 불변식과 동일한 정신 —
      // 콜백이 보는 시각이 자신의 마감 틱과 같아야 한다, `scheduler.ts`
      // 코멘트 참고).
      const startTick = clock.tick - advancedTicks + 1
      for (let i = 0; i < advancedTicks; i += 1) {
        this.stepPlayerMovement(startTick + i)
      }
      this.state.tick = clock.tick
    }, NET.TICK_MS)
  }

  /** 접속 중인 모든 플레이어를 정확히 1틱 전진시키고 스키마 위치를
   * 갱신한다(RQ-20). 관전자는 RQ-41에 따라 월드에 존재하지 않으므로
   * 대상이 아니다. 인원이 정원(`CAPACITY.PLAYERS`=10)으로 상한돼 있어
   * 이 순회는 틱 예산(RQ-60, 33ms)에 부담을 주지 않는다.
   *
   * **RQ-15 사망자 갭 + 리스폰**: `canAct(player.hp)`가 false(시신)면 이동을
   * 전혀 적용하지 않는다(위치 고정 — 팀리드 지시 D) — 대신 `diedAtTick`
   * 기준으로 `isRespawnDue`를 확인해, due면 `respawnPlayer`로 재배치한다.
   * `currentTick`은 `startTickLoop`가 역산해 넘긴, 이 반복이 대응하는
   * 정확한 틱 번호다. */
  private stepPlayerMovement(currentTick: number): void {
    // RQ-43: AFK 판정된 세션을 아래 forEach 도중 즉시 처리하지 않는다 —
    // `kickAfkPlayer`가 승격으로 `state.players`에 새 항목을 추가할 수
    // 있는데, 순회 중인 `MapSchema`(`$items` = 네이티브 Map)를 같은 순회
    // 안에서 변형하면 반복 결과가 불명확해진다. 그래서 이 순회는 대상만
    // 모으고, 실제 퇴장·승격은 순회가 끝난 뒤 일괄 처리한다.
    const afkSessionIds: string[] = []

    this.state.players.forEach((player, sessionId) => {
      const previous = this.moveStates.get(sessionId)
      if (!previous) return // onJoin이 채워두므로 정상 경로에서는 발생하지 않는다.

      // RQ-43: 생존·사망 여부와 무관하게 입력 무활동만 본다 — `canAct`
      // 가드(사망자 갭)와는 별개 판정이다. `lastInputAtTick`이 없으면(관전
      // 상태에서만 있던 세션은 애초에 여기 들어오지 않는다) 대상이 아니다.
      const lastInput = this.lastInputAtTick.get(sessionId)
      if (lastInput !== undefined && isAfkDue(lastInput, currentTick, AFK_TICKS)) {
        afkSessionIds.push(sessionId)
      }

      // RQ-11(가정 5): 재장전 완료 판정을 틱 루프에서 매 틱 사전 판정한다
      // (계약은 트리거 시점을 규정하지 않으나, 팀리드 지시대로 틱 루프에서
      // 판정 — 이동·리스폰과 동일한 타이밍에 상태를 정착시킨다). 완료되면
      // 탄창을 `WEAPON.MAGAZINE`으로 리필하고 재장전 상태를 지운다.
      const reloadStartedAt = this.reloadStartedAtTick.get(sessionId)
      if (reloadStartedAt !== undefined && isReloadComplete(reloadStartedAt, currentTick, RELOAD_TICKS)) {
        this.magazines.set(sessionId, WEAPON.MAGAZINE)
        this.reloadStartedAtTick.delete(sessionId)
      }

      if (!canAct(player.hp)) {
        const diedAt = this.diedAtTick.get(sessionId)
        if (diedAt !== undefined && isRespawnDue(diedAt, currentTick, RESPAWN_TICKS)) {
          this.respawnPlayer(sessionId, player, currentTick)
        }
        return
      }

      const input = this.pendingInputs.get(sessionId) ?? IDLE_MOVE_INPUT
      // 원장 22f 수정: 위 'move' 핸들러의 OR 병합과 짝을 이루는 리셋 지점 —
      // `input.jump`가 참이면 무조건 `pendingInputs`를 `jump:false`로
      // 되돌린다. 되돌리지 않으면 다음 새 'move' 메시지가 도착할 때까지
      // `jump:true`가 `pendingInputs`에 계속 남고, `stepGrounded`
      // (`@shared/sim/movement`)는 접지 상태에서 매 틱 `input.jump`를 그대로
      // 봐 재이륙시키므로 착지하는 즉시 다시 뛰어오르는 무한 버니합 회귀가
      // 된다.
      //
      // **이 리셋은 `previous.grounded`(아래 `stepMovement` 분기)와 무관하게
      // 무조건 실행된다 — "이번 틱에 실제로 물리가 소비했는가"가 아니라
      // "이번 틱에 읽은 `input.jump`가 참이었는가"만 본다.** 공중 상태의
      // `stepAirborne`(`@shared/sim/movement`)은 `input` 인자 자체를 받지
      // 않으므로(공중 가속 미허용, RQ-92) 공중 틱에는 `jump`를 아예 읽지
      // 않는데도 이 리셋은 그대로 실행된다.
      //
      // **이 리셋은 선택이 아니라 필수다.** 위 'move' 핸들러의 OR 병합만
      // 넣고 리셋을 빼면 `jump:true`가 **영구 래치**돼 한 번의 입력이 무한
      // 버니합이 된다(`22f-jump-input-loss.test.ts`의 "재발화 금지" 케이스가
      // 정확히 그 회귀를 잡는다 — 리셋만 제거하면 그 케이스가 단독으로
      // `AssertionError`로 죽는 것을 독립 평가가 변이로 실증했다).
      //
      // ⚠️ 실 클라이언트의 전송 양상은 **두 번 틀리게 적혔다가 정정됐다**.
      // `movementInput.ts`의 `getMoveInput()`이 `jumpPending`을 첫 호출에
      // 소비하는 것은 맞지만, 같은 파일 `onKeyDown`에 **`event.repeat` 가드가
      // 없어**(`src` 전체 grep 0건) 키 홀드 중 반복 발생하는 `keydown`이
      // `jumpPending`을 계속 재무장한다. 즉 **"키를 누르고 있으면 1회만
      // 보낸다"는 거짓**이고, 30Hz 루프가 그 재무장을 거듭 싣는다.
      // 자동 반복 자체는 브라우저 실측 전이다(원장 22f-3에 수동 스모크 등재).
      // 리셋이 필수라는 결론은 세 판본 모두에서 같다 — 근거만 정정됐다.
      //
      // 공중 틱에 리셋이 도는 것도 무해하다 — 공중 물리가 참조하지 않는
      // 값을 지우는 것이라 그 틱의 궤적에 영향이 없고, 다음 점프는 새
      // 키다운이 만든 새 `jump:true`가 만든다.
      //
      // ⚠️ 최초 주석은 "홀드하면 클라가 매 틱 재전송하므로 안전하다"고
      // 적었으나 **사실이 아니었다**(독립 평가 F-A). 동작은 옳았고 근거만
      // 틀렸다 — 그 서술을 믿고 리셋을 빼는 사람이 나올 수 있어 정정한다.
      if (input.jump) {
        this.pendingInputs.set(sessionId, { ...input, jump: false })
      }
      // 원장 25a-5(RQ-21 동시 회수): 세 번째 인자로 벽·박스·사다리
      // 정본을 단일 값(`PRODUCTION_GEOMETRY`)으로 주입한다 — 배치 근거는
      // `@shared/sim/walls`·`@shared/sim/boxes`·`@shared/sim/ladders`
      // docblock 참고.
      //
      // ⚠️ **이 주입을 빠뜨려도 타입 에러가 나지 않는다** — `stepMovement`의
      // 세 번째 인자에 `EMPTY_GEOMETRY` 기본값이 있어 `stepMovement(previous,
      // input)`은 그대로 컴파일된다(PR #52 리뷰 major 1, 격리 tsconfig 실측).
      // 타입이 막는 것은 **필드를 일부만 채운 객체**(`{walls, boxes}` →
      // TS2345)와 **옛 위치 인자 나열**(TS2554)뿐이다. 통째 생략과 잘못된
      // 조립(`{...PRODUCTION_GEOMETRY, ladders: []}`)은 **통합 테스트가
      // 잡는다** — **통째 생략**은 `rq-21`·`rq-22`·`rq-30` 배선 테스트
      // **3건이 동시에** 죽고, **잘못된 조립**은 빠진 종류의 것 **1건만**
      // 죽는다(벽·박스는 그대로 주입되므로). 정확한 대조표는
      // `@shared/sim/geometry` docblock에 있다.
      const next = stepMovement(previous, input, PRODUCTION_GEOMETRY)
      this.moveStates.set(sessionId, next)
      player.x = next.x
      player.y = next.y
      player.z = next.z
      // RQ-22(질문2 회신): 공개 스키마에도 접지 여부를 그대로 싣는다 —
      // `grounded === (y === 0)` 파생이 박스 위 착지에서 틀리기 때문에
      // 클라이언트(`connection.ts`)가 파생 대신 이 필드를 직접 읽는다.
      player.grounded = next.grounded
      // RQ-92 v2.4(원장 24az) — 공개 스키마에도 자세를 그대로 싣는다.
      // `grounded`와 같은 관례(서버가 매 틱 권위 값을 실음)이지만, 물리
      // 시뮬레이션 결과(`next.grounded`)가 아니라 **입력 자체**를 그대로
      // 반영한다는 점만 다르다 — `input`은 이미 이 지점에서 조달된 값
      // (`this.pendingInputs.get(sessionId) ?? IDLE_MOVE_INPUT`, 위)이라
      // 새로 읽을 것이 없다.
      player.mode = input.mode

      // RQ-64: 살아있는(canAct) 플레이어만 이력을 적립한다 — 시신은
      // `moveStates`처럼 위치가 고정되므로(위 `if (!canAct(...))` 분기가
      // 이미 return 했다) 이 지점에 도달한 세션은 전부 canAct다.
      // `appendPositionSnapshot`은 새 배열을 반환하는 순수 함수라(위
      // `positionHistory` 필드 코멘트 참고) 매번 재할당한다.
      this.positionHistory.set(
        sessionId,
        appendPositionSnapshot(
          this.positionHistory.get(sessionId) ?? [],
          { tick: currentTick, x: next.x, y: next.y, z: next.z },
          POSITION_HISTORY_CAPACITY,
        ),
      )
      // RQ-62(21a-2): 클라이언트 예측 재조정이 공중 상태를 이어받으려면
      // 속도가 와이어에 실려야 한다. `grounded`는 21a-2 당시 "`grounded ===
      // (y === 0)`이라 파생 가능"을 근거로 제외했으나, **RQ-22(원장 25a-4)가
      // 그 전제를 깨서** 이제 아래에서 함께 싣는다 — 박스 위 착지는 y가 0이
      // 아니면서 접지다.
      player.vx = next.vx
      player.vy = next.vy
      player.vz = next.vz

      // RQ-62 리뷰 blocker 수정: seq는 위치·속도를 쓴 바로 이 자리에서만
      // 기록한다 — 이번 틱에 실제로 적용한 입력(`input`)에 대응하는
      // 시퀀스 번호가 정확히 이 스냅샷과 함께 나가야 한다(ADR-0003 "상태를
      // 갱신한 뒤 처리된 마지막 시퀀스 번호를 담아 반환"). `pendingSeqs`는
      // `pendingInputs`와 동일하게 다음 메시지가 올 때까지 값을 유지하므로,
      // 새 입력이 없는 유휴 플레이어는 매 틱 같은 값을 재기록할 뿐
      // 리셋되지 않는다.
      const pendingSeq = this.pendingSeqs.get(sessionId)
      if (pendingSeq !== undefined) {
        player.lastProcessedInputSeq = pendingSeq
      }

      // RQ-18: 공중 구간 최고점 추적 + 착지 시 낙하 데미지 적용(사망 시
      // `registerDeath`로 리스폰까지 예약된다 — 22e 후속 ① 해소).
      this.trackFallDamage(sessionId, player, previous, next, currentTick)
    })

    // RQ-43: 순회 종료 후 일괄 처리(위 주석 참고) — 정원 10 상한이라
    // 매 틱 배열 하나를 새로 만들어도 틱 예산(RQ-60, 33ms)에 부담을
    // 주지 않는다.
    for (const sessionId of afkSessionIds) {
      this.kickAfkPlayer(sessionId)
    }
  }

  /** RQ-31: 룸 전역 순환 커서를 한 칸 전진시키고 그 스폰 지점을 반환한다
   * (최초 입장·리스폰 공통 진입점). */
  private allocateSpawnPoint(): SpawnPoint {
    this.spawnCursor = nextSpawnIndex(this.spawnCursor, SPAWN_POINTS.length)
    return SPAWN_POINTS[this.spawnCursor]!
  }

  /**
   * RQ-15(리스폰) + RQ-16(스폰 보호 재시작): HP를 `PLAYER.MAX_HP`로,
   * 위치를 다음 스폰 지점으로 되돌리고, 그 스폰 지점 기준으로 스폰 보호
   * 타이머를 다시 시작한다(`spawnedAtTick`=currentTick,
   * `firedSinceSpawn`=false) — 최초 입장(`onJoin`)과 동일한 초기화다.
   *
   * **리뷰 minor 4 수정**: `moveStates`는 `spawnMoveState`로 속도 0을
   * 담지만, 와이어로 나가는 `Player` 스키마의 `vx`/`vy`/`vz`는 별도
   * 필드라 여기서 명시적으로 0을 쓰지 않으면 다음
   * `stepPlayerMovement`가 갱신할 때까지 **사망 시점 속도**를 그대로
   * 유지한다 — 그 사이 나가는 패치가 "스폰 지점 + 낙하 중 속도"라는
   * 모순 스냅샷이 되어 RQ-62 클라 예측 재조정이 1틱 어긋난다.
   *
   * **리뷰 minor 11 수정**: 사망 직전에 보낸 `move` 입력이
   * `pendingInputs`에 남아 있으면, 리스폰 직후 다음 틱에 그 입력이
   * 그대로 적용돼 스폰 좌표를 벗어나며 이동해 버린다(GA-09의 "리스폰
   * 위치가 `SPAWN_POINTS` 멤버십과 정확히 일치"라는 관측이 타이밍에
   * 따라 깨질 수 있고, 부활 직후 죽기 전 입력으로 움직이는 것은 게임
   * 감각으로도 부자연스럽다) — 리스폰 시 `pendingInputs`를 지워 다음
   * 입력이 도착할 때까지 정지 상태를 유지한다. `pendingSeqs`는 지우지
   * 않는다 — RQ-62(ADR-0003)의 `lastProcessedInputSeq`는 클라 예측
   * 버퍼가 "서버가 어디까지 반영했는지" 추적하는 식별자로, 리스폰으로
   * 시퀀스 자체가 무효화되지 않는다(클라는 여전히 그 seq까지의 입력을
   * 보낸 것이 맞다 — 다음 `move` 메시지가 오면 자연히 갱신된다). 여기서
   * 지우면 스키마 `lastProcessedInputSeq` 값과 어긋나 클라 예측 버퍼
   * 정리(trim) 로직에 불필요한 혼란을 준다.
   *
   * **리뷰 minor 5 — 암묵 의존**: 이 함수가 `reloadStartedAtTick`을 지우지
   * 않는 안전성("살아있을 때 시작한 재장전이 죽고 나서도 리스폰을 넘어가지
   * 않는다")은 `RELOAD_TICKS`(`WEAPON.RELOAD_MS`=2000ms) <
   * `RESPAWN_TICKS`(`PLAYER.RESPAWN_MS`=3000ms)라는 관계에 암묵적으로
   * 의존한다 — major 1의 `canAct` 가드(`handleReload`)는 *시신이* 새
   * 재장전을 거는 것만 막을 뿐, 사망 자체는 이미 진행 중이던 재장전을
   * 취소하지 않는다. 사망 틱에 막 시작한 재장전이라도 현재 값으로는
   * 리스폰(3초=90틱) 전에 항상 완료된다(2초=60틱 < 90틱). **이 부등식이
   * 뒤집히면**(예: 재장전을 4초로 튜닝) 죽기 직전 건 정상 재장전 잠금이
   * 리스폰을 넘어 살아남아, 방금 부활한 멀쩡한 플레이어가 다시 사격 불가
   * 에 빠질 수 있다 — **그때는 이 함수가 `reloadStartedAtTick`도 지워야
   * 한다.** 지금은 그 값을 보존하는 편이 "재장전 중 사망해도 리스폰하면
   * 남은 재장전이 계속 진행돼 그대로 완료된다"는 게임 감각과 일치하고
   * 스펙이 이 경로에 침묵하므로 바꾸지 않는다.
   *
   * **평가 F2 수정(2026-07-27, `_workspace/RQ-64/03_evaluator_report.md`
   * F2)**: `positionHistory`(RQ-64 되감기 링버퍼)를 정리한다.
   * `stepPlayerMovement`는 사망 중(`canAct===false`) 조기 반환해 이력을
   * 갱신하지 않으므로, 정리하지 않으면 사망 시점(이전 생) 스냅샷이 리스폰
   * 후에도 몇 틱(최대 `REWIND_CAP_TICKS`≈200ms)간 되감기 후보로 남아
   * 시신 지점이 유령 명중하거나(반대로 실제 리스폰 위치를 정확히 겨눈
   * 사격이 빗나가거나) 한다 — 평가가 실측(14.07 m 오차)으로 확인한 blocker.
   *
   * **삭제 vs 시딩(현재 위치로 새 스냅샷을 즉시 채우는 방식) 중 삭제를
   * 택한 근거**: 삭제 후 버퍼가 비면 `sampleRewoundPosition([])`이
   * `undefined`를 반환해 `handleFire`가 `moveStates`(리스폰 지점, 이
   * 함수가 몇 줄 위에서 이미 갱신했다)로 폴백한다 — 이는 **접속 직후
   * (onJoin) 신규 플레이어와 정확히 같은 경로**다: `initializePlayer`도
   * `positionHistory`를 시딩하지 않고 첫 스냅샷은 다음
   * `stepPlayerMovement` 틱이 자연히 채운다. 리스폰은 "같은 세션의 새
   * 생(生)"이라는 점에서 신규 입장과 동일한 위상이므로(이 함수가
   * `diedAtTick`·`spawnedAtTick`·`firedSinceSpawn`·`pendingInputs`를
   * `initializePlayer`와 동일하게 초기화하는 것과 같은 원칙), 시딩이라는
   * 별도 경로를 새로 만들기보다 이미 검증된(onJoin 경로) 폴백을 그대로
   * 재사용하는 편이 일관적이다. 시딩은 이 폴백과 최종 결과가 동일하면서도
   * (되감기 요청이 오면 어차피 그 시딩값 하나만 있는 버퍼에서 그 값이
   * 선택된다) 코드 경로만 하나 더 늘린다 — 이득 없이 표면적만 넓어진다.
   *
   * **`onLeave`의 `positionHistory.delete`와의 의미 차이**: `onLeave`는
   * "세션 자체가 끝난다"는 정리(누수 방지 — 다시는 이 sessionId로 이
   * 세션이 돌아오지 않는다)이고, 여기는 "같은 세션이 새 생으로 이어진다"는
   * 정리(이전 생의 흔적을 다음 생으로 넘기지 않는다)다 — 트리거하는
   * 사건은 다르지만 "이 시점 이전의 위치 이력은 더 이상 유효한 판정
   * 근거가 아니다"라는 의미는 같다.
   */
  private respawnPlayer(sessionId: string, player: Player, currentTick: number): void {
    const point = this.allocateSpawnPoint()
    this.moveStates.set(sessionId, spawnMoveState(point))
    player.x = point.x
    player.y = point.y
    player.z = point.z
    player.vx = 0
    player.vy = 0
    player.vz = 0
    // RQ-22: `spawnMoveState`가 항상 `grounded: true`로 시작하므로 공개
    // 스키마도 맞춰 리셋한다 — 그러지 않으면 공중에서 죽은(grounded:false)
    // 플레이어가 부활 직후에도 이전 생의 값을 들고 있는다(vx/vy/vz와
    // 동일한 이유의 리셋).
    player.grounded = true
    player.hp = PLAYER.MAX_HP
    this.diedAtTick.delete(sessionId)
    this.positionHistory.delete(sessionId) // RQ-64 평가 F2 — 이전 생의 위치 이력을 이어받지 않는다(위 문서 참고)
    this.spawnedAtTick.set(sessionId, currentTick)
    this.firedSinceSpawn.set(sessionId, false)
    this.pendingInputs.delete(sessionId)
  }

  /**
   * RQ-02(닉네임) + RQ-03(정원). 서버가 최종 닉네임을 확정한다 —
   * 클라이언트가 보낸 값을 중복 검사 없이 그대로 쓰지 않는다(RQ-61 서버
   * 권위). 이미 사용 중이면 자동 접미사를 붙여 고유화한다.
   *
   * 정원 판정 순서: `players`가 `CAPACITY.PLAYERS` 미만이면 플레이어로
   * 입장시킨다. 차 있으면 `spectators`가 `CAPACITY.SPECTATORS` 미만인지
   * 보고 미만이면 관전자로 입장시킨다(RQ-41). 둘 다 차 있으면 접속을
   * 거부한다(`throw`) — 클래스 상단 문서에 근거를 남겼다.
   *
   * RQ-02 v1.2: `uniqueNickname()`(중복 접미사 부착)보다 먼저
   * `sanitizeNickname()`(제어문자 제거 → 트림 → 코드포인트 16자 절단)을
   * 적용한다 — 접미사는 길이 제한 적용 **후**에 붙어야 재절단으로 무력화되지
   * 않는다(스펙 순서). 새니타이즈 결과가 빈 문자열이면(또는 애초에 문자열이
   * 아니면) 닉네임 미제공과 동일하게 `DEFAULT_NICKNAME`으로 대체한다.
   *
   * RQ-31/RQ-16: 최초 입장도 리스폰과 동일하게 룸 전역 순환 커서
   * (`allocateSpawnPoint`)에서 스폰 지점을 받고, 그 지점 기준으로 스폰
   * 보호 타이머를 시작한다(item C — GA-10 "최초 입장도 보호" 보강 테스트가
   * 이 초기화에 의존한다).
   *
   * RQ-40: 정원 판정과 무관하게(플레이어든 관전자든) 입장이 확정된
   * 클라이언트에게 단일 대상 전송(`client.send`, 브로드캐스트 아님)으로
   * 보관 중인 채팅 이력을 즉시 보낸다 — "재접속"도 새 연결로 다시
   * `joinOrCreate`하는 것이라 이 한 지점이 최초 입장·재접속 양쪽을 자동으로
   * 충족한다(test-writer 계약 §3.3 "가정 3"). 복사본(`[...this.chatHistory]`)을
   * 보내 이후 서버 쪽 배열 변경이 이미 보낸 값에 영향을 주지 않게 한다.
   *
   * **RQ-81**: `options.uuid`가 `isValidStatsUuid`를 통과하면 접속이 실제로
   * 확정되는(플레이어 또는 관전자로 자리를 얻는) 두 분기 각각에서
   * `playerUuids`에 저장한다 — 관전자로 입장했다가 나중에 승격
   * (`promoteWaitingSpectator`)되면 그 시점에 이미 알고 있는 uuid로 킬·
   * 데스·헤드샷을 기록해야 하기 때문이다. 정원 초과로 접속 자체가
   * 거부되는(아래 `throw`) 경로에는 저장하지 않는다 — 다시는 쓰이지 않을
   * sessionId가 이 맵에 영구히 남는 누수를 막는다. 통과하지 못하면(미제공·
   * 타입 오류·형식 오류) 이 세션은 이번 판 통계 추적에서 아예 빠진다(접속
   * 자체는 그대로 진행 — RQ-61 "크래시보다 안전한 기본값",
   * `_workspace/RQ-81/01_test-writer_red.md` §4).
   */
  override onJoin(client: Client, options?: { nickname?: unknown; uuid?: unknown }): void {
    const rawNickname = typeof options?.nickname === 'string' ? options.nickname : ''
    const sanitized = sanitizeNickname(rawNickname)
    const requested = sanitized.length > 0 ? sanitized : DEFAULT_NICKNAME
    const nickname = this.uniqueNickname(requested)
    const rawUuid = options?.uuid

    if (this.state.players.size < CAPACITY.PLAYERS) {
      if (isValidStatsUuid(rawUuid)) {
        this.playerUuids.set(client.sessionId, rawUuid)
      }
      this.initializePlayer(client.sessionId, nickname)
      client.send('chat-history', [...this.chatHistory])
      return
    }

    if (this.state.spectators.size < CAPACITY.SPECTATORS) {
      if (isValidStatsUuid(rawUuid)) {
        this.playerUuids.set(client.sessionId, rawUuid)
      }
      const spectator = new Spectator()
      spectator.nickname = nickname
      this.state.spectators.set(client.sessionId, spectator)
      client.send('chat-history', [...this.chatHistory])
      return
    }

    throw new Error(
      `정원 초과 — 플레이어 ${CAPACITY.PLAYERS}명·관전자 ${CAPACITY.SPECTATORS}명(합계 ${
        CAPACITY.PLAYERS + CAPACITY.SPECTATORS
      }명)이 이미 접속 중입니다.`,
    )
  }

  /**
   * RQ-41 개정(2026-07-27, 사유 무관 슬롯 승격): 정상 퇴장이든 비정상 연결
   * 끊김이든 Colyseus는 이유를 구분하지 않고 이 메서드를 부른다 — 그래서
   * 이 메서드 하나가 "플레이어 슬롯이 비면 사유와 무관하게 승격한다"는
   * 개정 문면을 그대로 충족하는 유일한 지점이다(승격 호출 지점 일원화 —
   * `kickAfkPlayer`와 이 메서드 둘 다 `promoteWaitingSpectator()` 하나만
   * 거친다).
   *
   * **AFK 경로와의 이중 승격 방지**: `kickAfkPlayer`는 킥을 **결정한
   * 시점**에 이미 `state.players`에서 지우고 그 자리에서 즉시 승격한다
   * (아래 `kickAfkPlayer` 참고, 평가 F1 수정 — 소켓 close까지 기다리면
   * 그 사이 같은 세션이 매 틱 재킥·재승격돼 정원을 초과했다). 그렇게
   * 이미 처리된 세션에 대해 나중에 실제 소켓 close로 도달하는 이 `onLeave`
   * 실행에서는 아래 `players.delete()`가 이미 없는 키를 지우려다 `false`를
   * 반환한다 — `wasPlayer`가 false가 되어 이 메서드가 다시 승격을 호출하지
   * 않는다(멱등 가드, `kickAfkPlayer`가 F1에서 고친 것과 같은 형태의
   * 이중 승격을 이 경로에서도 구조적으로 막는다).
   */
  override onLeave(client: Client): void {
    // 사용 중 닉네임 목록이 현재 접속자 기준으로 정리돼야 다음 입장자의
    // 중복 판정이 정확하다. 소속 컬렉션이 players/spectators 둘 중 어느
    // 쪽인지 미리 알 필요 없이, players에 없으면 spectators를 시도한다.
    // 반환값(`wasPlayer`)은 메서드 맨 끝의 승격 호출 게이트로도 쓴다 —
    // 방금 지운 세션이 실제로 플레이어 슬롯을 점유하던 세션이었을 때만
    // 슬롯이 빈 것이고, 관전자가 나간 경우는 애초에 승격할 슬롯이 없다.
    const wasPlayer = this.state.players.delete(client.sessionId)
    if (!wasPlayer) {
      this.state.spectators.delete(client.sessionId)
    }
    // RQ-20: 재접속 시 이전 세션의 이동 상태를 이어받지 않도록 정리한다
    // (다음 onJoin이 spawnMoveState()로 새로 시작한다).
    this.moveStates.delete(client.sessionId)
    this.pendingInputs.delete(client.sessionId)
    this.pendingSeqs.delete(client.sessionId)
    this.lastFireAtMs.delete(client.sessionId)
    // RQ-15/16: 재접속 시 이전 세션의 사망·스폰 보호 이력을 이어받지 않는다
    // (다음 onJoin이 spawnedAtTick/firedSinceSpawn을 새로 초기화한다).
    this.diedAtTick.delete(client.sessionId)
    this.spawnedAtTick.delete(client.sessionId)
    this.firedSinceSpawn.delete(client.sessionId)
    // RQ-10/RQ-11: 재접속 시 이전 세션의 탄창·재장전 상태를 이어받지 않는다
    // (다음 onJoin이 magazines를 새로 초기화한다).
    this.magazines.delete(client.sessionId)
    this.reloadStartedAtTick.delete(client.sessionId)
    // RQ-18: 이탈 시점에 공중 구간을 추적 중이었을 수 있다 — 재접속 시
    // 이전 세션의 낙하 진행 상태를 이어받지 않는다(다른 모든 세션 전유
    // 부기 상태와 동일한 정리 패턴).
    this.fallPeakY.delete(client.sessionId)
    // RQ-43: 재접속 시 이전 세션의 AFK 타이머를 이어받지 않는다(다음
    // onJoin이 initializePlayer로 새로 초기화한다) — 다른 모든 세션 전유
    // 부기 상태와 동일한 정리 패턴. 관전자였던 세션은 애초에 이 맵에
    // 항목이 없으므로 delete는 멱등하게 no-op이다.
    this.lastInputAtTick.delete(client.sessionId)
    // RQ-64: 재접속 시 이전 세션의 위치 이력을 이어받지 않는다(다음
    // onJoin/stepPlayerMovement가 새로 적립한다) — 다른 모든 세션 전유
    // 부기 상태와 동일한 정리 패턴(누수 방지).
    this.positionHistory.delete(client.sessionId)

    // RQ-81: 플레이타임을 퇴장 시점에 한 번에 적재한다(팀리드 위임 "쓰기
    // 시점" 결정, 위 `joinedAtMs` 필드 코멘트 참고). `wasPlayer`가 아니라
    // `joinedAtMs`에 값이 있는지로 게이트한다 — `kickAfkPlayer`가 이미
    // `state.players`에서 지운(AFK 킥) 세션은 이 시점에 `wasPlayer`가
    // false이지만, 그 세션이 실제로 플레이어로 보낸 시간은 여전히 적재돼야
    // 한다(`kickAfkPlayer`는 `joinedAtMs`를 건드리지 않는다 — 위 필드
    // 코멘트). uuid가 없으면(미제공·형식 오류 세션) 통계를 기록하지 않는다
    // (다른 세 지표와 동일 원칙, tamper-defense 계약).
    const joinedAt = this.joinedAtMs.get(client.sessionId)
    const statsUuid = this.playerUuids.get(client.sessionId)
    if (joinedAt !== undefined && statsUuid !== undefined) {
      addPlaytimeMs(this.statsDb, statsUuid, Date.now() - joinedAt)
    }
    this.joinedAtMs.delete(client.sessionId)
    // RQ-81: 재접속 시 이전 세션의 통계 키를 이어받지 않는다(다음 onJoin이
    // 새로 채운다) — 다른 모든 세션 전유 부기 상태와 동일한 정리 패턴.
    this.playerUuids.delete(client.sessionId)

    // RQ-41 개정: 방금 비운 슬롯이 players였을 때만 대기 관전자를 승격한다
    // (FIFO, `promoteWaitingSpectator` 참고). AFK 경로와의 이중 승격 방지
    // 근거는 위 메서드 docblock 참고.
    if (wasPlayer) {
      this.promoteWaitingSpectator()
    }
  }

  /**
   * RQ-02/RQ-10/RQ-15/RQ-16/RQ-43 공통: 세션을 플레이어로 (신규) 초기화한다
   * — 최초 입장(`onJoin`)과 AFK 승격(`promoteWaitingSpectator`) 양쪽이
   * 정확히 동일한 필드 집합을 채워야 한다(팀리드 지시: "onJoin 최초 입장과
   * 동일한 필드 초기화"). 두 경로가 각자 이 초기화를 반복하면 한쪽에서만
   * 필드 하나가 누락되는 결함이 생기기 쉬워, 이 라운드에서 단일 지점으로
   * 추출했다(동작 변경 없음 — 기존 `onJoin` 로직을 그대로 옮긴 것에
   * `lastInputAtTick` 초기화만 추가).
   */
  private initializePlayer(sessionId: string, nickname: string): void {
    const player = new Player()
    player.nickname = nickname
    const point = this.allocateSpawnPoint()
    player.x = point.x
    player.y = point.y
    player.z = point.z
    this.state.players.set(sessionId, player)
    this.moveStates.set(sessionId, spawnMoveState(point))
    this.spawnedAtTick.set(sessionId, this.state.tick)
    this.firedSinceSpawn.set(sessionId, false)
    // RQ-10: 최초 입장·승격 모두 탄창 가득 참(`WEAPON.MAGAZINE`)에서 시작한다.
    this.magazines.set(sessionId, WEAPON.MAGAZINE)
    // RQ-41 개정 회수(원장 22i) — `respawnPlayer`(리뷰 minor 11)는 리스폰
    // 직전 남은 `pendingInputs`가 부활 직후 스폰 좌표를 벗어나 이동시키는
    // 것을 막으려 이미 이 맵을 지운다. 이 메서드(최초 입장 + 승격)는 그
    // 대칭을 갖추지 못했다 — `onMessage('move', ...)`가 발신자의
    // 플레이어 여부를 검사하지 않아(RQ-61 서버 권위와 무관하게 단순
    // 미검사), **관전 중에 보낸 move 입력**이 이 세션의 sessionId 아래
    // `pendingInputs`에 남을 수 있다. 승격 전에는 `stepPlayerMovement`가
    // 관전자를 순회하지 않아 잠들어 있다가, 승격 직후 첫 틱부터 그
    // 잔여 입력이 그대로 적용돼 "입력을 보내지 않았는데 움직인다"는
    // 결함으로 발화한다 — 여기서 지워 respawnPlayer와 동일하게 다음 실제
    // 입력이 도착할 때까지 정지 상태를 유지한다.
    //
    // **`pendingSeqs`는 지우지 않는다**(리뷰 blocker 수정 —
    // `_workspace/review/feat-RQ-41-slot-promotion.md`). 이전 버전의 이
    // 주석은 "관전 중 보낸 합성 seq"·"클라가 보내지 않은 seq"를 지우는
    // 근거로 들었으나 **둘 다 사실이 아니었다** — `pendingSeqs`는
    // `onMessage('move')`가 `parseInputSeq(payload)`로 실제 `move`
    // 페이로드에서 읽은 값만 기록한다(합성값이 아니다). 관전 중에도 실
    // 클라이언트(`PlayerControls`)는 관전 여부와 무관하게 계속 `move`를
    // 보내며 자신의 연결 단위 seq 카운터를 올린다 — 그 세션이 "보낸 적
    // 없는" seq가 아니라 **가장 최근에 실제로 보낸** seq다.
    //
    // `pendingInputs`(적용될 조작)와 `pendingSeqs`(클라와 공유하는 진행
    // 카운터)는 성격이 다르다. 전자를 지우는 것은 "잔여 조작을 적용하지
    // 않는다"는 뜻이지만, 후자를 지우면 승격 직후 첫 스냅샷의
    // `lastProcessedInputSeq`가 스키마 기본값 0으로 브로드캐스트된다 —
    // 그런데 클라의 예측 버퍼(`src/client/net/prediction.ts`)는 그동안
    // (관전 중 `reconcile`이 한 번도 호출되지 않아) seq가 계속 쌓여있다.
    // 서버가 0을 보내면 클라는 "0보다 큰 seq는 전부 미확인"으로 해석해
    // 관전 중 쌓인 입력 전량을 서버가 준 스폰 좌표 위에서 재생한다 —
    // ADR-0003("서버는 처리한 마지막 시퀀스 번호를 반환하고 클라는
    // 미확인 입력만 재생한다")이 정의한 재조정 계약을 승격 경로에서만
    // 되돌리는 회귀다. `respawnPlayer`(리뷰 minor 11, `:781-793`)가 이미 정확히
    // 같은 두 맵에 대해 내린 결론(`pendingInputs`는 지우고 `pendingSeqs`는
    // 보존한다)이 이 메서드에도 **그대로 적용된다** — 이 메서드로
    // 플레이어가 되는 세션은(최초 입장이든 승격이든) 항상 그 세션이 실제로
    // 보낸 최신 seq를 이어받아야, 승격 직후 첫 틱이 `lastProcessedInputSeq`
    // 를 정확히 확정해 클라 버퍼를 정상적으로 비운다(잔여 조작 차단과
    // 버퍼 정리를 동시에 얻는다 — `pendingInputs`만 지우고 `pendingSeqs`는
    // 남기면 첫 틱이 `IDLE_MOVE_INPUT`을 적용해 스폰 좌표에 머무르면서도
    // seq는 갱신되기 때문이다).
    this.pendingInputs.delete(sessionId)
    // RQ-43: 방금 플레이어가 된 세션의 AFK 타이머를 지금 시점으로 새로
    // 시작한다 — 그렇지 않으면 부재중이던 관전자 대기 시간이 그대로
    // 넘어와 승격 직후 곧바로 AFK 판정될 수 있다.
    this.lastInputAtTick.set(sessionId, this.state.tick)
    // RQ-81: 플레이타임 측정 시작점 — 관전 중 대기 시간은 세지 않는다(위
    // `joinedAtMs` 필드 코멘트의 설계 결정). `lastInputAtTick`과 동일하게
    // "방금 플레이어가 된 이 순간"을 기준으로 다시 시작한다(승격 시
    // 관전 대기 시간이 플레이타임에 섞이지 않는다).
    this.joinedAtMs.set(sessionId, Date.now())
  }

  /**
   * RQ-43: AFK 퇴장으로 빈 슬롯을 대기 중인 관전자에게 넘긴다. 관전자가
   * 없으면 아무 것도 하지 않는다(퇴장 자체는 이 메서드 밖에서 그대로
   * 진행된다 — 팀리드 지시: "관전자가 없어도 퇴장 자체는 일어나야 한다").
   *
   * **coder 판단(스펙·골든 미규정 — 승격 대상이 2명 이상일 때의 선택
   * 순서, `_workspace/RQ-43/01_test-writer_red.md` §2 "결정하지 않고
   * coder 자유로 남긴 것")**: 가장 먼저 접속한 관전자를 승격한다(FIFO).
   * `MapSchema`(`$items`가 내부적으로 네이티브 `Map`)의 `keys()`가 삽입
   * 순서를 보존한다는 것을 이용한 결정론적 선택이다(ADR-0008 —
   * `Math.random()` 등 난수 사용 금지). "먼저 기다린 사람 먼저"가
   * 직관적이고 공정하며 결정론적으로 테스트 가능해 택했다.
   */
  /**
   * **평가 F1 수정(2026-07-27, `_workspace/RQ-43/04_evaluator_report.md`
   * §7 "수정 방법" 2)**: 정원 방어선 — 호출자(`kickAfkPlayer`·`onLeave`)
   * 양쪽 다 `state.players`에서 **먼저** 슬롯을 지운(또는 이미 비어있음을
   * 확인한) 뒤에만 이 메서드를 부르므로, 정상 경로에서는 이 가드가 걸릴
   * 일이 없다(빈 슬롯이 이미 확보된 뒤에만 호출된다). **RQ-41 개정
   * (2026-07-27)으로 `onLeave`도 두 번째 호출자가 됐다** — 승격 호출
   * 지점을 이 메서드 하나로 일원화한 것(팀리드 지시)이 바로 이 방어선이
   * 애초에 대비하던 "향후 다른 호출 경로"다. 그래도 방어선 자체는
   * 유지한다 — 공짜에 가깝다(맵 크기 비교 1회).
   */
  /** 승격 대상 선택은 **FIFO**(먼저 기다린 사람 먼저) — `Math.random()`을
   * 쓰지 않는다(ADR-0008 결정론). `MapSchema.keys()`가 내부 `$items`(네이티브
   * `Map`)의 삽입 순서를 그대로 위임하는 것을 이용한다 — 다만 이건 문서화된
   * 계약이 아니라 **구현 세부**다(colyseus 3.0.76 실측). 원장 22h 참고. */
  private promoteWaitingSpectator(): void {
    if (this.state.players.size >= CAPACITY.PLAYERS) return

    const waitingId = this.state.spectators.keys().next().value
    if (waitingId === undefined) return

    const spectator = this.state.spectators.get(waitingId)
    if (!spectator) return // 방어적 가드 — 이론상 keys()가 준 키는 항상 존재한다

    this.state.spectators.delete(waitingId)
    this.initializePlayer(waitingId, spectator.nickname)
  }

  /**
   * RQ-43: AFK 판정된 세션을 처리한다 — (a) 대기 중인 관전자가 있으면 그
   * 슬롯으로 승격하고 (b) 해당 세션의 접속을 서버가 강제 종료한다.
   *
   * **평가 F1 수정(2026-07-27, `_workspace/RQ-43/04_evaluator_report.md`
   * §7, 재현 가드 `_workspace/RQ-43/05_test-writer_f1f2.md`)**: 원래
   * 구현은 `client.leave()`만 부르고 `state.players`에서의 실제 제거는
   * 소켓 close 핸드셰이크가 끝난 뒤의 비동기 `onLeave`에 전적으로
   * 맡겼다. close는 피어의 close 프레임 응답을 기다리는 실 네트워크
   * 왕복이라 1틱(33ms)보다 오래 걸리는 쪽이 오히려 흔하다(RTT가 있는
   * 모든 연결, 특히 AFK의 대표 원인인 무응답 연결에서는 최대 `ws`
   * `closeTimeout`까지) — 그동안 세션이 여전히 `state.players`에 남아
   * 있어 `stepPlayerMovement`가 매 틱 같은 세션을 다시 AFK로 재판정하고,
   * 그때마다 `promoteWaitingSpectator()`가 다시 실행돼 슬롯 1개에
   * 관전자가 여러 명 승격됐다(정원 초과, F1).
   *
   * 수정: `this.state.players.delete(sessionId)`의 **반환값을 멱등성
   * 가드로 쓴다** — 킥을 **결정한 이 시점**에 즉시 `state.players`에서
   * 제거한다(RQ-61 서버 권위: 서버가 이미 확정한 결과이므로 소켓이 실제로
   * 닫히기를 기다릴 이유가 없다). 이미 처리된 세션이면(동일 동기 구간
   * 안에서의 중복 호출이든, 다음 틱의 재판정이든) `delete`가 `false`를
   * 반환해 이 메서드가 즉시 아무 것도 하지 않는다 — 다음 틱 순회에도 이
   * 세션이 `state.players`에 아예 없으므로 재판정 자체가 구조적으로
   * 불가능해진다.
   *
   * 세션별 나머지 부기 상태(`lastInputAtTick` 포함)는 여기서 정리하지
   * 않는다 — `onLeave`가 나중에(소켓이 실제로 닫힐 때) 정리한다. `onLeave`
   * 맨 앞의 `if (!this.state.players.delete(...)) { this.state.spectators
   * .delete(...) }` 가드는 이미 지워진 키에 대한 재호출을 전제하는데,
   * `Map#delete`(및 이를 감싼 `MapSchema#delete`)는 존재하지 않는 키에
   * `false`를 반환할 뿐 부작용이 없다 — 표준 멱등 동작이다. 그 아래 나머지
   * 정리 라인들도 전부 같은 `Map#delete`라 마찬가지로 안전하다. 즉 이
   * 메서드가 `state.players`만 먼저 지우고 나가도, 나중에 실제로 도착하는
   * `onLeave` 실행이 나머지를 안전하게 마저 정리한다.
   *
   * 그 사이(킥 결정~실제 소켓 close) 그 세션에서 메시지가 도착해도
   * 위험하지 않다 — `handleFire`/`handleChat`/`touchAfkTimer` 등은 전부
   * `this.state.players.get`/`has(sessionId)`로 존재를 먼저 확인하는
   * 방어적 가드를 이미 갖추고 있어(`handleChat`의 "onLeave와 경합해 이미
   * 나간 세션" 주석과 동일한 패턴), 이 세션은 그냥 "이미 나간 세션"과
   * 동일하게 조용히 무시된다.
   *
   * `this.clients.getById`가 `undefined`를 반환하면(이미 다른 경로로
   * 끊긴 세션과 경합) 조용히 무시한다 — 위와 동일한 방어적 패턴.
   */
  private kickAfkPlayer(sessionId: string): void {
    if (!this.state.players.delete(sessionId)) return // 멱등 가드 — 이미 처리된 세션

    this.promoteWaitingSpectator()
    this.clients.getById(sessionId)?.leave()
  }

  /**
   * `requested`가 이미 사용 중이면 결정론적 접미사(`-2`, `-3`, ...)를 붙여
   * 고유화한다(ADR-0008: 난수·시각 의존 금지 — 카운터로 대체). 접미사
   * 형식 자체는 스펙·ADR-0006이 규정하지 않는다.
   *
   * 검사 범위는 `players`·`spectators` 합계다(RQ-03). RQ-02는 "이미 사용
   * 중인 닉네임"이라고만 하고 대상을 플레이어로 한정하지 않으며, 관전자도
   * RQ-41에 따라 채팅에 참여해 닉네임이 그대로 노출된다 — 관전자를 검사에서
   * 빼면 플레이어와 동명의 관전자가 공존해 채팅에서 둘을 구분할 수 없다.
   */
  private uniqueNickname(requested: string): string {
    const taken = new Set<string>()
    this.state.players.forEach((player) => taken.add(player.nickname))
    this.state.spectators.forEach((spectator) => taken.add(spectator.nickname))

    if (!taken.has(requested)) {
      return requested
    }

    let suffix = 2
    while (taken.has(`${requested}-${suffix}`)) {
      suffix += 1
    }
    return `${requested}-${suffix}`
  }
}
