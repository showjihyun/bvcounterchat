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

export class GameState extends Schema {
  /** sessionId로 키잉된 접속 플레이어 목록. */
  @type({ map: Player }) players = new MapSchema<Player>()
}
