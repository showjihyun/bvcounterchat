import { describe, expect, it } from 'vitest'
import { AFK_TICKS, isAfkDue } from '@shared/sim/afk'
import { msToTicks } from '@shared/sim/clock'
import { PLAYER } from '@shared/constants'

/**
 * RQ-43 AFK 자동 퇴장 — 순수 판정 로직 단위 테스트 (ADR-0008 §1이 "AFK
 * 타이머(RQ-43)"를 순수 함수/상태 전이 로직의 단위 테스트 예시로 직접
 * 명시한다. ADR-0011: `src/shared` 전체가 Red-first 영역).
 *
 * **골든 매핑**: 이 파일 자체는 GA-13(`harness/evals/golden/
 * track-a-product.jsonl`)에 직접 매핑되지 않는다 — GA-13의 `verify`는
 * `tests/integration/rq-43-afk-kick.test.ts`를 지정한다. 이 파일은
 * `sim-lifecycle.test.ts`(RQ-15/16)가 이미 채택한 A/B 레벨 분리와 동일한
 * 위상이다: "경과 틱이 정확히 임계에 도달하는 순간 무엇이 바뀌는가"라는
 * **경계 전이**는 실 Colyseus 30Hz 루프(통합 레벨)로는 정밀하게 붙잡을 수
 * 없다(1틱=33.33ms 안에 정확히 착지해야 하는데 실 타이머·네트워크 지터가
 * 이를 보장하지 못한다 — `rq-18-fall-damage.test.ts` REV3 "1차 시도(폐기)"
 * 절이 폴링으로 이 정밀도를 노리다 실측으로 폐기한 선례가 이미 있다).
 * 그래서 이 경계 판정은 여기(A계층, 틱 정수만 주입하는 순수 함수 호출)가
 * 전담하고, 통합 테스트(B계층, `rq-43-afk-kick.test.ts`)는 "임계를 한참
 * 넘긴 값 vs 아직 여유가 있는 값"이라는 **여유 있는 두 극단**만 확인한다
 * (레벨 분리 근거는 그 파일 상단 docblock 참고).
 *
 * **결정론(ADR-0008 핵심)**: 실시간 타이머·`Date.now()`에 의존하지 않는다 —
 * 틱(정수)만 인자로 받는 순수 함수다.
 *
 * **그린필드 계약(test-writer 지정, `sim-lifecycle.test.ts`의 `isRespawnDue`
 * 선례와 동일한 권한·동일한 경계 스타일 — "N분간 입력이 없으면"의 직역,
 * 경계 포함(`>=`), `isRespawnDue(diedAtTick, currentTick, respawnTicks)`와
 * 동일한 인자 순서·재사용성 원칙)**:
 *
 * ```ts
 * // src/shared/sim/afk.ts (신규)
 * import { msToTicks } from './clock'
 * import { PLAYER } from '@shared/constants'
 *
 * // PLAYER.AFK_TIMEOUT_MS(5분=300000ms)를 틱으로 환산한 편의 상수 —
 * // lifecycle.ts의 RESPAWN_TICKS/SPAWN_PROTECTION_TICKS와 동일한 "설정값
 * // 상수 export" 패턴. 300000ms / (1000/30)ms = 정확히 9000틱(나머지 없음
 * // — msToTicks의 ceil이 이 값에는 영향을 주지 않는다. 아래 실측값 테스트가
 * // 이를 고정한다).
 * export const AFK_TICKS: number // = msToTicks(PLAYER.AFK_TIMEOUT_MS), 현재 9000
 *
 * // RQ-43: lastInputAtTick(해당 세션이 서버로부터 move/fire/chat/reload
 * // 메시지 중 하나를 마지막으로 수신 처리한 틱)부터 currentTick까지 경과가
 * // afkTicks 이상이면 AFK 퇴장 대상이다(경계 포함 — isRespawnDue와 동일한
 * // 부호 규칙). afkTicks를 인자로 받는 이유도 동일(canFire·isRespawnDue와
 * // 같은 "임계값을 상수에 감추지 않는" 순수 함수 재사용성 원칙).
 * export function isAfkDue(lastInputAtTick: number, currentTick: number, afkTicks: number): boolean
 * ```
 *
 * **가정(coder에게 — `GameRoom` 배선, `rq-43-afk-kick.test.ts`가 통합
 * 레벨에서 실제로 요구하는 것. 상세 근거는 그 파일 상단 docblock 참고)**:
 * 1. 세션별 "마지막 입력 처리 틱"을 신규 private map(예: `lastInputAtTick:
 *    Map<string, number>`)으로 추적하고, 플레이어로 입장할 때(`onJoin`)
 *    현재 틱으로 초기화한다(`spawnedAtTick`과 동일한 초기화 시점 — 다만
 *    이 파일의 단언들은 화이트박스로 항상 이 맵을 직접 덮어쓰므로 초기화
 *    시점 자체에 결합하지 않는다).
 * 2. `'move'`·`'fire'`·`'chat'`·`'reload'` 4종 메시지 핸들러는 수신할
 *    때마다(payload 내용·게임 로직상 최종 수락 여부와 무관하게 — RQ-43
 *    "입력이 없으면"은 메시지 수신 자체를 가리킨다) 발신자가 **현재
 *    플레이어**라면 그 세션의 값을 현재 틱으로 갱신한다. 관전자는 RQ-43
 *    원문이 "플레이어가"로 한정하므로 대상이 아니다.
 * 3. 매 틱마다 각 플레이어에 대해 `isAfkDue(...)`가 참이면: (a) 대기 중인
 *    관전자가 있으면 그중 한 명을 플레이어로 전환한다(`state.spectators`
 *    에서 제거, `state.players`에 추가 — `onJoin` 최초 입장과 동일한 필드
 *    초기화) (b) 해당 세션의 접속을 서버가 종료한다(예: `client.leave()`)
 *    — 기존 `onLeave`가 이미 수행하는 세션별 부기 상태 정리를 그대로
 *    재사용한다.
 */

describe('RQ-43 AFK 자동 퇴장 — isAfkDue(lastInputAtTick, currentTick, afkTicks)', () => {
  it('경과 틱이 afkTicks 미만이면 아직 AFK 대상이 아니다', () => {
    expect(isAfkDue(0, 8999, 9000)).toBe(false)
  })

  it('경과 틱이 정확히 afkTicks이면 AFK 대상이다(경계 포함)', () => {
    expect(isAfkDue(0, 9000, 9000)).toBe(true)
  })

  it('경과 틱이 afkTicks를 초과해도 AFK 대상이다', () => {
    expect(isAfkDue(0, 50_000, 9000)).toBe(true)
  })

  it('lastInputAtTick이 0이 아닌 임의 시점이어도 상대 경과로 판정한다', () => {
    expect(isAfkDue(1000, 1000 + 8999, 9000)).toBe(false) // 경과 8999틱
    expect(isAfkDue(1000, 1000 + 9000, 9000)).toBe(true) // 경과 9000틱
  })

  it('경과가 정확히 0틱(입력 직후)이면 AFK 대상이 아니다', () => {
    expect(isAfkDue(5000, 5000, 9000)).toBe(false)
  })

  it('RQ-43 실측값(AFK_TICKS=9000, PLAYER.AFK_TIMEOUT_MS에서 유도)으로도 동일하게 성립한다', () => {
    expect(AFK_TICKS).toBe(9000)
    expect(AFK_TICKS).toBe(msToTicks(PLAYER.AFK_TIMEOUT_MS))
    expect(isAfkDue(0, AFK_TICKS - 1, AFK_TICKS)).toBe(false)
    expect(isAfkDue(0, AFK_TICKS, AFK_TICKS)).toBe(true)
  })
})
