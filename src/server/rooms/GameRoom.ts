import type { Client } from 'colyseus'
import { Room } from 'colyseus'
import { GameState, Player, Spectator } from '@shared/schema/GameState'
import { CAPACITY } from '@shared/constants'

/** RQ-02: 닉네임 미제공 시 서버가 부여하는 기본 닉네임. 스펙이 침묵하는
 * 지점이라 임의로 정한다 — 어떤 값이든 자동 접미사 로직으로 고유화된다. */
const DEFAULT_NICKNAME = 'player'

/**
 * 'game' 룸 — RQ-04 상설 세션 + RQ-02 닉네임 식별 + RQ-03 정원.
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
 * 게임 상태(위치·HP·킬 등)는 여기서 다루지 않는다 — RQ-10 이후 붙는다.
 * RQ-04는 세션 생명주기, RQ-02는 닉네임 식별, RQ-03은 정원만이 이 룸의
 * 범위다.
 */
export class GameRoom extends Room<GameState> {
  // RQ-04: 마지막 참여자가 나가 0명이 돼도 룸을 폐기하지 않는다 —
  // 라운드·매치 종료 없는 상설 세션. Colyseus 기본값(true)은 빈 방을
  // 자동 dispose하므로 반드시 꺼야 한다(GA-26).
  override autoDispose = false

  override onCreate(): void {
    this.state = new GameState()
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
