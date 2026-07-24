/**
 * 스펙으로 확정된 게임 상수 (ADR-0010: 클라이언트·서버 공유).
 *
 * 여기 있는 값은 전부 `harness/specs/requirements.md`가 확정한 것이며,
 * 근거는 2026-07-21 Deep Interview(`harness/specs/interview/answers.md`)다.
 * **임의로 바꾸지 않는다** — 값을 바꾸려면 스펙 개정이 먼저고, 스펙 변경은
 * 코드 변경과 같은 PR이어야 한다 (CLAUDE.md).
 *
 * 클라이언트 예측(RQ-62)이 서버와 어긋나지 않으려면 양쪽이 이 파일 하나를
 * 봐야 한다. 어느 한쪽에 값을 복제하는 순간 예측은 구조적으로 빗나간다.
 *
 * 아직 확정되지 않은 튜닝값(탄퍼짐 콘 반경, 박스 정확 치수, 아틀라스 셀
 * 해상도 등 — req가 수치를 정하지 않은 세부)은 여기 두지 않는다.
 * RQ-90 본문대로 설정 파일에서 주입한다.
 */

/** 네트워크 (RQ-60, RQ-64) */
export const NET = {
  /** 서버 고정 틱 레이트 (RQ-60) */
  TICK_HZ: 30,
  /** 틱 1회의 시간 예산(ms). 이걸 넘으면 시뮬레이션이 밀린다. */
  TICK_MS: 1000 / 30,
  /** 랙 보상 되감기 상한(ms) — 초과 RTT는 이 값에서 절단 (RQ-64) */
  REWIND_CAP_MS: 200,
  /** 정상 플레이를 보장하는 RTT 상한(ms) (RQ-64) */
  RTT_BUDGET_MS: 150,
} as const

/** 정원 (RQ-03) */
export const CAPACITY = {
  /** 최대 플레이어 수 */
  PLAYERS: 10,
  /** 최대 관전자 수 — 초과 접속은 거부한다 (RQ-03) */
  SPECTATORS: 10,
} as const

/** 무기 — Pistol 1종 (RQ-10, RQ-11, RQ-13, RQ-90) */
export const WEAPON = {
  /** 바디 히트 데미지 (RQ-90) — HP 100 기준 4타 킬 */
  DAMAGE_BODY: 25,
  /** 헤드샷 배율 (RQ-13) — 헤드 데미지 50, 2타 킬 */
  HEADSHOT_MULTIPLIER: 2,
  /** 분당 발사 수 (RQ-90) */
  RPM: 400,
  /** 사격 간격(ms) — RPM에서 유도 */
  FIRE_INTERVAL_MS: 60_000 / 400,
  /** 탄창 용량 (RQ-10). 예비 탄약은 무한. */
  MAGAZINE: 10,
  /** 재장전 시간(ms) (RQ-11) */
  RELOAD_MS: 2000,
  /** 사거리 감쇠 없음 — 전 사거리 고정 데미지 (RQ-90) */
  FALLOFF: false,
} as const

/** 플레이어 상태 (RQ-14, RQ-15, RQ-16, RQ-43) */
export const PLAYER = {
  /** 시작 HP (RQ-14) */
  MAX_HP: 100,
  /** 사망 후 리스폰 대기(ms) (RQ-15) */
  RESPAWN_MS: 3000,
  /** 스폰 보호 시간(ms) — 사격하면 즉시 해제 (RQ-16) */
  SPAWN_PROTECTION_MS: 3000,
  /** AFK 자동 퇴장 임계(ms) (RQ-43) */
  AFK_TIMEOUT_MS: 5 * 60 * 1000,
} as const

/** 이동 (RQ-20, RQ-22, RQ-92) */
export const MOVEMENT = {
  /** 기본 이동 속도(m/s) (RQ-92) */
  SPEED: 6,
  /** 앉기 속도 배율 (RQ-92) */
  CROUCH_MULTIPLIER: 0.5,
  /** 천천히 걷기 속도 배율 (RQ-92) */
  WALK_MULTIPLIER: 0.7,
  /** 점프 높이(m) (RQ-92) — 박스 점프(RQ-22)의 물리적 전제 */
  JUMP_HEIGHT: 1.0,
  /**
   * 공중 가속 허용 여부 (RQ-92).
   * false = 에어 스트레이프·버니합 없음. 공중에서는 점프 시점의 수평
   * 관성만 유지된다. 이 값이 false이기 때문에 클라이언트 예측(RQ-62)이
   * 결정론적으로 정확해진다 — 바꾸려면 ADR-0003/0004 재검토가 먼저다.
   */
  AIR_CONTROL: false,
} as const

/** 낙하 데미지 (RQ-18, RQ-92) */
export const FALL_DAMAGE = {
  /** 이 높이(m) 이하는 무피해 */
  SAFE_HEIGHT_M: 3,
  /** 임계 초과분 1m당 데미지 */
  DAMAGE_PER_METER: 10,
  /** 즉사 임계 없음 (RQ-92) */
  INSTANT_DEATH_HEIGHT_M: null,
} as const

/** 맵·월드 (RQ-30, RQ-31, RQ-32) */
export const WORLD = {
  /** 플레이 면적 한 변(m) — 60×60m 소형 (RQ-30) */
  SIZE_M: 60,
  /** Safe Zone 반경(m). 이탈 즉시 보호 해제 (RQ-31) */
  SAFE_ZONE_RADIUS_M: 5,
  /** Safe Zone 내부 사격 불가 (RQ-31) */
  SAFE_ZONE_ALLOWS_FIRING: false,
} as const

/** 닉네임 (RQ-02 v1.2) */
export const IDENTITY = {
  /** 새니타이즈 후 최대 길이 — 유니코드 코드포인트 기준(서로게이트 쌍은
   * 1자로 센다). 중복 회피 접미사는 이 제한 적용 후에 붙으므로 최종 길이가
   * 이 값을 넘을 수 있다 (RQ-02 v1.2). */
  NICKNAME_MAX_CODEPOINTS: 16,
} as const

/** 채팅·HUD (RQ-40, RQ-55) */
export const UI = {
  /** 채팅 히스토리 보관 개수 (RQ-40) */
  CHAT_HISTORY: 50,
  /** 킬 피드 노출 시간(ms) (RQ-55) */
  KILLFEED_TTL_MS: 5000,
  /** 킬 피드 동시 표시 최대 줄 수 (RQ-55) */
  KILLFEED_MAX_ROWS: 5,
} as const
