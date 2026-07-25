import type { Client } from 'colyseus'
import { Room } from 'colyseus'
import { GameState, Player, Spectator } from '@shared/schema/GameState'
import { CAPACITY, NET, PLAYER, UI, WEAPON } from '@shared/constants'
import { createClock } from '@shared/sim/clock'
import { createScheduler } from '@shared/sim/scheduler'
import { createTickDriver } from '@shared/sim/tickDriver'
import { stepMovement, type MoveInput, type MoveState } from '@shared/sim/movement'
import {
  canFire,
  damageForRegion,
  eyeOrigin,
  findClosestHit,
  type HitCandidate,
  type Ray,
} from '@shared/sim/combat'
import { SPAWN_POINTS, nextSpawnIndex, type SpawnPoint } from '@shared/sim/spawn'
import {
  RESPAWN_TICKS,
  SPAWN_PROTECTION_TICKS,
  applyDamageWithProtection,
  canAct,
  isRespawnDue,
  isSpawnProtected,
} from '@shared/sim/lifecycle'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { sanitizeNickname } from '@shared/identity/nickname'
import { filterProfanity } from '@shared/chat/profanityFilter'

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
 * `fire` 메시지 payload에서 조준 방향(`dirX`·`dirY`·`dirZ`)만 뽑는다.
 * 클라이언트가 같은 payload에 명중·데미지·헤드샷·대상 주장 필드(RQ-12
 * GA-06 — 악의적 클라이언트가 실어 보낼 수 있는 필드)를 실어도 여기서
 * 아예 읽지 않으므로 서버 상태에 닿을 경로가 없다(RQ-61) —
 * `sanitizeMoveInput`과 동일한 패턴.
 */
function sanitizeFireInput(payload: unknown): FireInput {
  const raw = payload as { dirX?: unknown; dirY?: unknown; dirZ?: unknown } | null | undefined
  return {
    dirX: typeof raw?.dirX === 'number' ? raw.dirX : 0,
    dirY: typeof raw?.dirY === 'number' ? raw.dirY : 0,
    dirZ: typeof raw?.dirZ === 'number' ? raw.dirZ : 0,
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
   * 매 틱 시뮬레이션에 반영한다(실시간 FPS 이동 입력의 표준 모델). */
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
  /** RQ-31: 룸 전역 스폰 로테이션 커서 — 세션이 아니라 룸 하나가 갖는다
   * (`nextSpawnIndex`의 "직전 사용 지점 회피"가 전역 순서 기준이라는
   * 설계 결정, `_workspace/RQ-15-16/01_test-writer_red.md` §2.1). */
  private spawnCursor: number | undefined
  /** RQ-40: 최근 채팅 이력 — 오래된 것이 배열 앞쪽(도착 순서 그대로), 최대
   * `UI.CHAT_HISTORY`(50)개만 유지한다(초과분은 앞에서 폐기). 저장되는
   * 텍스트는 이미 `filterProfanity`를 거친 값이다(RQ-95) — 브로드캐스트
   * 시점에만 필터링하고 이력을 원문으로 저장하면 재접속자에게 원문이
   * 새어나가는 우회로가 생긴다(`_workspace/RQ-40/01_test-writer_red.md`
   * "금칙어 필터와의 상호작용" 경고). 관전자를 포함해 룸에 연결된 모든
   * 클라이언트가 발신·수신 양쪽에 참여한다(RQ-41).
   */
  private readonly chatHistory: ChatMessage[] = []

  override onCreate(): void {
    this.state = new GameState()
    this.registerMessageHandlers()
    this.startTickLoop()
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
      this.pendingInputs.set(client.sessionId, sanitizeMoveInput(payload))

      const seq = parseInputSeq(payload)
      if (seq !== undefined) {
        this.pendingSeqs.set(client.sessionId, seq)
      }
    })

    this.onMessage('fire', (client, payload: unknown) => {
      this.handleFire(client.sessionId, sanitizeFireInput(payload))
    })

    this.onMessage('chat', (client, payload: unknown) => {
      this.handleChat(client.sessionId, sanitizeChatText(payload))
    })
  }

  /**
   * RQ-12(서버 hitscan) + RQ-13(헤드샷 배율) + RQ-14(HP·사망·킬) + RQ-15
   * (사망자 갭·리스폰 스케줄) + RQ-16(스폰 보호) + RQ-17(팀 없음 — 사수
   * 자신을 제외한 전원이 대상) + ADR-0005(rate-limit).
   *
   * **사망자 갭(RQ-15 item D)**: `canAct(shooterPlayer.hp)`가 false면(시신)
   * 요청을 완전히 무시한다 — rate-limit 갱신도, `firedSinceSpawn` 갱신도
   * 하지 않는다(`_workspace/RQ-15-16/01_test-writer_red.md` §2.2 가정).
   * **즉시 판정(가정 D)**: 다음 시뮬레이션 틱을 기다리지 않고 수신 즉시
   * 판정한다 — RQ-12 원문 "hitscan(즉시 판정 레이캐스트)"의 직역.
   * **레이 원점**: `eyeOrigin(...)`(`@shared/sim/combat`, RQ-15~16 라운드
   * REV §12) — 사수의 현재 추적 위치(`moveStates`, RQ-20)에
   * `DEFAULT_HITBOX.eyeHeightM`을 더한 지점을 인라인 산술이 아니라 이
   * 공유 함수로 계산해, 클라이언트 1인칭 카메라 높이 계산과 값이 어긋나지
   * 않게 한다.
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
    this.lastFireAtMs.set(shooterId, now)

    const shooterState = this.moveStates.get(shooterId)
    if (!shooterState) return

    // RQ-16: 사격 행위 자체(명중 여부 무관)로 사수 자신의 스폰 보호를
    // 즉시 해제한다.
    this.firedSinceSpawn.set(shooterId, true)

    const ray: Ray = {
      origin: eyeOrigin({ x: shooterState.x, y: shooterState.y, z: shooterState.z }, DEFAULT_HITBOX.eyeHeightM),
      direction: { x: input.dirX, y: input.dirY, z: input.dirZ },
    }

    const candidates: HitCandidate[] = []
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
      const targetState = this.moveStates.get(sessionId)
      if (!targetState) return
      candidates.push({ id: sessionId, pose: { position: { x: targetState.x, y: targetState.y, z: targetState.z } } })
    })

    const closest = findClosestHit(ray, candidates, DEFAULT_HITBOX)
    if (!closest || !closest.result.region) return

    const victim = this.state.players.get(closest.id)
    if (!victim) return

    const victimSpawnedAt = this.spawnedAtTick.get(closest.id)
    const victimFired = this.firedSinceSpawn.get(closest.id) ?? false
    const isProtected =
      victimSpawnedAt !== undefined &&
      isSpawnProtected(victimSpawnedAt, this.state.tick, SPAWN_PROTECTION_TICKS, victimFired)

    const outcome = applyDamageWithProtection(victim.hp, damageForRegion(closest.result.region), isProtected)
    victim.hp = outcome.hp
    if (outcome.died) {
      shooterPlayer.kills += 1
      this.diedAtTick.set(closest.id, this.state.tick)
    }
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
    this.state.players.forEach((player, sessionId) => {
      const previous = this.moveStates.get(sessionId)
      if (!previous) return // onJoin이 채워두므로 정상 경로에서는 발생하지 않는다.

      if (!canAct(player.hp)) {
        const diedAt = this.diedAtTick.get(sessionId)
        if (diedAt !== undefined && isRespawnDue(diedAt, currentTick, RESPAWN_TICKS)) {
          this.respawnPlayer(sessionId, player, currentTick)
        }
        return
      }

      const input = this.pendingInputs.get(sessionId) ?? IDLE_MOVE_INPUT
      const next = stepMovement(previous, input)
      this.moveStates.set(sessionId, next)
      player.x = next.x
      player.y = next.y
      player.z = next.z
      // RQ-62(21a-2): 클라이언트 예측 재조정이 공중 상태를 이어받으려면
      // 속도가 와이어에 실려야 한다(`grounded`는 4필드 확정에 없어 제외).
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
    })
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
    player.hp = PLAYER.MAX_HP
    this.diedAtTick.delete(sessionId)
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
   */
  override onJoin(client: Client, options?: { nickname?: unknown }): void {
    const rawNickname = typeof options?.nickname === 'string' ? options.nickname : ''
    const sanitized = sanitizeNickname(rawNickname)
    const requested = sanitized.length > 0 ? sanitized : DEFAULT_NICKNAME
    const nickname = this.uniqueNickname(requested)

    if (this.state.players.size < CAPACITY.PLAYERS) {
      const player = new Player()
      player.nickname = nickname
      const point = this.allocateSpawnPoint()
      player.x = point.x
      player.y = point.y
      player.z = point.z
      this.state.players.set(client.sessionId, player)
      this.moveStates.set(client.sessionId, spawnMoveState(point))
      this.spawnedAtTick.set(client.sessionId, this.state.tick)
      this.firedSinceSpawn.set(client.sessionId, false)
      client.send('chat-history', [...this.chatHistory])
      return
    }

    if (this.state.spectators.size < CAPACITY.SPECTATORS) {
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

  override onLeave(client: Client): void {
    // 사용 중 닉네임 목록이 현재 접속자 기준으로 정리돼야 다음 입장자의
    // 중복 판정이 정확하다. 소속 컬렉션이 players/spectators 둘 중 어느
    // 쪽인지 미리 알 필요 없이, players에 없으면 spectators를 시도한다.
    if (!this.state.players.delete(client.sessionId)) {
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
