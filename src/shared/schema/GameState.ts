import { MapSchema, Schema, type } from '@colyseus/schema'

/**
 * 'game' 룸의 상태 스키마 (ADR-0002: Colyseus, ADR-0010: `src/shared`에
 * 두는 이유 — 클라이언트가 이 정의로 상태를 역직렬화한다).
 *
 * RQ-02(닉네임 식별) + RQ-20(위치) 범위만 담는다. `Player`에는 `nickname`·
 * 위치(x·y·z) 외의 필드를 앞서 넣지 않는다 — HP·킬 등은 각자의
 * RQ(RQ-14~18 등)가 붙을 때 추가한다.
 */
export class Player extends Schema {
  /** 서버가 확정한 최종 닉네임 (RQ-02) — 충돌 시 자동 접미사가 붙는다. */
  @type('string') nickname = ''
  /** 서버가 `stepMovement`(`@shared/sim/movement`, RQ-20)로 매 틱 갱신하는
   * 위치. 클라이언트가 'move' 메시지에 실어 보낸 좌표는 절대 여기 그대로
   * 반영되지 않는다 — 입력(방향·상태)만 신뢰해 서버가 시뮬레이션한 결과만
   * 쓴다 (RQ-61 서버 권위). */
  @type('number') x = 0
  @type('number') y = 0
  @type('number') z = 0
  /** 서버가 `stepMovement`로 계산한 수평·수직 속도(m/s, RQ-62 21a-2 확정).
   * 클라이언트 예측(`src/client/net/prediction.ts`)의 재조정 기준값에
   * 필요하다 — `MoveState`(x·y·z·vx·vy·vz·grounded 7필드)를 재사용하려면
   * 와이어에도 속도가 실려야 한다. `grounded`는 여기 추가하지 않는다 —
   * `@shared/sim/movement`의 현재 구현에서는 `grounded === (y === 0)`이
   * 항상 성립해 배선 코드가 파생시킬 수 있다(잠재적 암묵 의존 —
   * `tests/unit/rq-62-prediction.test.ts` §참고 절 확인). */
  @type('number') vx = 0
  @type('number') vy = 0
  @type('number') vz = 0
  /** 서버가 처리를 반영한 마지막 입력 시퀀스 번호(RQ-62, ADR-0003 입력
   * 커맨드 버퍼). 클라이언트가 'move' 메시지에 `seq`를 싣지 않으면(레거시
   * 호출) 갱신되지 않는다 — 기본값 0이 유지된다. */
  @type('number') lastProcessedInputSeq = 0
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
  /** 서버 30Hz 고정 틱 카운터 (RQ-60). 매 틱 서버가 갱신해 브로드캐스트한다
   * — 클라이언트는 이 값으로 서버 시뮬레이션이 진행 중임을 관측한다. */
  @type('number') tick = 0
}
