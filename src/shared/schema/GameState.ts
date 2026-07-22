import { MapSchema, Schema, type } from '@colyseus/schema'

/**
 * 'game' 룸의 상태 스키마 (ADR-0002: Colyseus, ADR-0010: `src/shared`에
 * 두는 이유 — 클라이언트가 이 정의로 상태를 역직렬화한다).
 *
 * RQ-02(닉네임 식별) 범위만 담는다. `Player`에는 `nickname` 외의 필드를
 * 앞서 넣지 않는다 — 위치·HP·킬 등은 각자의 RQ(RQ-12~18 등)가 붙을 때
 * 추가한다.
 */
export class Player extends Schema {
  /** 서버가 확정한 최종 닉네임 (RQ-02) — 충돌 시 자동 접미사가 붙는다. */
  @type('string') nickname = ''
}

/**
 * RQ-03(정원 초과)으로 입장한 관전자. `Player`와 별도 클래스로 두는 이유:
 * 플레이어는 곧 위치·HP(RQ-12~18)가 붙지만, 관전자는 RQ-41에 따라 월드에
 * 물리적으로 존재하지 않아 그 필드들이 애초에 무의미하다 — 필드 집합이
 * 갈릴 것을 알면서 한 클래스로 합치면 나중에 쪼개야 한다. 지금은 닉네임
 * (RQ-41 채팅 참여용) 외의 필드가 없다 — 자유 카메라·추적 대상·승격
 * 대기열(RQ-91)은 이 RQ의 스코프 밖이라 아직 넣지 않는다.
 */
export class Spectator extends Schema {
  /** 서버가 확정한 최종 닉네임 (RQ-02 로직을 플레이어·관전자 공통 적용). */
  @type('string') nickname = ''
}

export class GameState extends Schema {
  /** sessionId로 키잉된 접속 플레이어 목록. */
  @type({ map: Player }) players = new MapSchema<Player>()
  /** sessionId로 키잉된 관전자 목록 (RQ-03: 플레이어 정원 초과 시 입장). */
  @type({ map: Spectator }) spectators = new MapSchema<Spectator>()
}
