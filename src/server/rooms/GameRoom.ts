import type { Client } from 'colyseus'
import { Room } from 'colyseus'
import { GameState, Player } from '@shared/schema/GameState'

/** RQ-02: 닉네임 미제공 시 서버가 부여하는 기본 닉네임. 스펙이 침묵하는
 * 지점이라 임의로 정한다 — 어떤 값이든 자동 접미사 로직으로 고유화된다. */
const DEFAULT_NICKNAME = 'player'

/**
 * 'game' 룸 — RQ-04 상설 세션 + RQ-02 닉네임 식별.
 *
 * 서버 전역에 이 룸은 단 하나만 존재해야 한다(GA-29). 동시 `joinOrCreate`
 * 경쟁으로 룸이 중복 생성되지 않도록 하는 것은 Colyseus 매치메이커가
 * 이미 보장한다 — `concurrentJoinOrCreateRoomLock`
 * (`node_modules/@colyseus/core/build/MatchMaker.js`)이 룸 이름당 생성을
 * 직렬화한다. `maxClients`도 건드리지 않는다(기본값 Infinity) — 정원
 * 제한(RQ-03)은 이 RQ의 범위 밖이다.
 *
 * 게임 상태(위치·HP·킬 등)는 여기서 다루지 않는다 — RQ-10 이후 붙는다.
 * RQ-04는 세션 생명주기, RQ-02는 닉네임 식별만이 이 룸의 범위다.
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
   * RQ-02: 서버가 최종 닉네임을 확정한다 — 클라이언트가 보낸 값을 중복
   * 검사 없이 그대로 쓰지 않는다(RQ-61 서버 권위). 이미 사용 중이면 자동
   * 접미사를 붙여 고유화한다.
   */
  override onJoin(client: Client, options?: { nickname?: unknown }): void {
    const requested =
      typeof options?.nickname === 'string' && options.nickname.length > 0
        ? options.nickname
        : DEFAULT_NICKNAME

    const player = new Player()
    player.nickname = this.uniqueNickname(requested)
    this.state.players.set(client.sessionId, player)
  }

  override onLeave(client: Client): void {
    // 사용 중 닉네임 목록이 현재 접속자 기준으로 정리돼야 다음 입장자의
    // 중복 판정이 정확하다.
    this.state.players.delete(client.sessionId)
  }

  /**
   * `requested`가 이미 사용 중이면 결정론적 접미사(`-2`, `-3`, ...)를 붙여
   * 고유화한다(ADR-0008: 난수·시각 의존 금지 — 카운터로 대체). 접미사
   * 형식 자체는 스펙·ADR-0006이 규정하지 않는다.
   */
  private uniqueNickname(requested: string): string {
    const taken = new Set<string>()
    this.state.players.forEach((player) => taken.add(player.nickname))

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
