import type { Client } from 'colyseus'
import { Room } from 'colyseus'
import { GameState, Player, Spectator } from '@shared/schema/GameState'
import { CAPACITY, NET } from '@shared/constants'
import { createClock } from '@shared/sim/clock'
import { createScheduler } from '@shared/sim/scheduler'
import { createTickDriver } from '@shared/sim/tickDriver'
import { stepMovement, type MoveInput, type MoveState } from '@shared/sim/movement'

/** RQ-02: 닉네임 미제공 시 서버가 부여하는 기본 닉네임. 스펙이 침묵하는
 * 지점이라 임의로 정한다 — 어떤 값이든 자동 접미사 로직으로 고유화된다. */
const DEFAULT_NICKNAME = 'player'

/** 'move' 메시지를 아직 한 번도 보내지 않은 플레이어(방금 접속)에 쓰는
 * 입력 — 무입력·평지 대기 상태. */
const IDLE_MOVE_INPUT: MoveInput = { dirX: 0, dirZ: 0, mode: 'run', jump: false }

/** RQ-31(스폰 지점 순환 로테이션)은 이 RQ의 스코프 밖 — 아직 구현되지
 * 않았으므로 임시로 원점에서 시작한다. */
function spawnMoveState(): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true }
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

  override onCreate(): void {
    this.state = new GameState()
    this.registerMessageHandlers()
    this.startTickLoop()
  }

  /**
   * RQ-20 이동 입력(GA-33 서버 권위 포함). 'move' payload에서 방향·상태
   * 필드만 뽑는다(`sanitizeMoveInput`) — 페이로드에 좌표(x·y·z)가 실려
   * 와도 이 핸들러가 아예 읽지 않으므로 상태에 반영될 경로가 없다(RQ-61).
   */
  private registerMessageHandlers(): void {
    this.onMessage('move', (client, payload: unknown) => {
      this.pendingInputs.set(client.sessionId, sanitizeMoveInput(payload))
    })
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
    const driver = createTickDriver(clock, scheduler)

    this.setSimulationInterval((deltaMs: number) => {
      const advancedTicks = driver.advanceByElapsed(deltaMs)
      for (let i = 0; i < advancedTicks; i += 1) {
        this.stepPlayerMovement()
      }
      this.state.tick = clock.tick
    }, NET.TICK_MS)
  }

  /** 접속 중인 모든 플레이어를 정확히 1틱 전진시키고 스키마 위치를
   * 갱신한다(RQ-20). 관전자는 RQ-41에 따라 월드에 존재하지 않으므로
   * 대상이 아니다. 인원이 정원(`CAPACITY.PLAYERS`=10)으로 상한돼 있어
   * 이 순회는 틱 예산(RQ-60, 33ms)에 부담을 주지 않는다. */
  private stepPlayerMovement(): void {
    this.state.players.forEach((player, sessionId) => {
      const previous = this.moveStates.get(sessionId)
      if (!previous) return // onJoin이 채워두므로 정상 경로에서는 발생하지 않는다.

      const input = this.pendingInputs.get(sessionId) ?? IDLE_MOVE_INPUT
      const next = stepMovement(previous, input)
      this.moveStates.set(sessionId, next)
      player.x = next.x
      player.y = next.y
      player.z = next.z
    })
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
   */
  override onJoin(client: Client, options?: { nickname?: unknown }): void {
    const requested =
      typeof options?.nickname === 'string' && options.nickname.length > 0
        ? options.nickname
        : DEFAULT_NICKNAME
    const nickname = this.uniqueNickname(requested)

    if (this.state.players.size < CAPACITY.PLAYERS) {
      const player = new Player()
      player.nickname = nickname
      this.state.players.set(client.sessionId, player)
      // RQ-20: 스폰 지점 로테이션(RQ-31)은 스코프 밖 — 원점에서 시작한다.
      this.moveStates.set(client.sessionId, spawnMoveState())
      return
    }

    if (this.state.spectators.size < CAPACITY.SPECTATORS) {
      const spectator = new Spectator()
      spectator.nickname = nickname
      this.state.spectators.set(client.sessionId, spectator)
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
