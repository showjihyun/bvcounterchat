import { describe, expect, it } from 'vitest'
import { msToTicks } from '@shared/sim/clock'
import { NET } from '@shared/constants'
import {
  appendPositionSnapshot,
  POSITION_HISTORY_CAPACITY,
  REWIND_CAP_TICKS,
  rewindTicksFor,
  sampleRewoundPosition,
  type PositionSnapshot,
} from '@shared/sim/rewind'

/**
 * RQ-64 랙 보상(Lag Compensation) — 순수 판정 로직 단위 테스트 (ADR-0005
 * "랙보상 확정" 절, ADR-0008: 순수 함수·결정론·`src/shared` 환경 중립.
 * ADR-0011: `src/shared` 전체가 Red-first 영역).
 *
 * **골든 매핑**: 이 파일 자체는 GA-16(`harness/evals/golden/
 * track-a-product.jsonl`)에 직접 매핑되지 않는다 — GA-16의 `verify`는
 * `tests/integration/rq-64-lag-compensation-bound.test.ts`를 지정한다. 이
 * 파일은 `sim-afk.test.ts`(RQ-43)·`sim-lifecycle.test.ts`(RQ-15/16)가 이미
 * 채택한 A/B 레벨 분리와 동일한 위상이다: "200ms(6틱) 상한 경계에서 정확히
 * 무엇이 바뀌는가"라는 **정밀 경계**는 여기(A계층, 틱·ms 정수만 주입하는
 * 순수 함수 호출)가 전담하고, 통합 테스트(B계층,
 * `rq-64-lag-compensation-bound.test.ts`)는 "상한을 한참 넘김 vs 상한
 * 이내"라는 **여유 있는 두 극단**과 "실제 hitscan에 배선됐는가"만 확인한다
 * (근거는 그 파일 상단 docblock 참고 — 정밀 경계를 실 Colyseus 30Hz 루프+
 * 실 WebSocket 타이밍으로 붙잡으려 하면 `rq-18-fall-damage.test.ts` REV3~5가
 * 이미 실측으로 폐기한 것과 같은 종류의 비결정론에 빠진다).
 *
 * **결정론(ADR-0008 핵심)**: 실시간 타이머·`Date.now()`에 의존하지 않는다 —
 * 틱·ms 정수만 인자로 받는 순수 함수다.
 *
 * ---
 *
 * ## 설계 포크(team-lead 지시 — 착수 시 결정하고 근거를 남긴다)
 *
 * ADR-0005는 되감기 양의 출처로 "사수의 RTT" **또는** "사수가 마지막으로
 * 확인한 서버 틱" 둘 다 허용한다. 이 라운드는 **RTT(ms)**를 택한다 — RQ-64
 * 원문 "사수의 **RTT**만큼... 되감아 판정해야 한다"의 직역이고, "마지막으로
 * 확인한 서버 틱" 방식은 클라이언트가 서버 브로드캐스트 틱을 추적·ack하는
 * 별도 프로토콜(각 패치에 틱 태그 → 클라가 최댓값 기억 → 다음 fire에 실어
 * 보고)이 추가로 필요해 이번 라운드 범위(RTT 조달 경로 신설)보다 한 겹
 * 더 크다. RTT 쪽은 클라이언트가 이미 갖고 있거나 쉽게 측정 가능한 값
 * (WebSocket RTT, ping/pong)을 그대로 실어 보내는 것으로 충분하다(클라이언트
 * 측 RTT 측정 구현 자체는 이 RQ의 스코프 밖 — 서버는 `fire` payload의
 * `rttMs` 필드를 신뢰하지 않고 방어적으로 절단할 뿐이다).
 *
 * **되감기 산술은 틱 단위로 한다**(`msToTicks` 선례, `RESPAWN_TICKS`·
 * `AFK_TICKS`와 동일한 "설정값을 틱 상수로 미리 환산해 export" 패턴) —
 * `handleFire`가 `Date.now()` 직접 비교로 되감기 대상을 고르지 않는다
 * (ADR-0008).
 *
 * ```ts
 * // src/shared/sim/rewind.ts (신규)
 * import { msToTicks } from './clock'
 * import { NET } from '@shared/constants'
 *
 * // NET.REWIND_CAP_MS(200ms)를 틱으로 환산한 편의 상수 — RESPAWN_TICKS·
 * // AFK_TICKS와 동일한 패턴. 200 / (1000/30) = 정확히 6.0 → ceil해도 6
 * // (나머지 없음, 아래 실측값 테스트가 고정한다).
 * export const REWIND_CAP_TICKS: number // = msToTicks(NET.REWIND_CAP_MS), 현재 6
 *
 * // RQ-64: 사수가 보고한 RTT(ms)를 되감기 틱 수로 환산한다.
 * // - 유한하지 않거나(NaN·Infinity 판정은 아래에서 별도) 0 이하(rttMs<=0,
 * //   NaN 포함 — NaN과의 모든 비교는 항상 false이므로 `<= 0`도 false지만
 * //   `!Number.isFinite(NaN)`이 true라 이 가드에서 함께 걸린다)이면 0(되감기
 * //   없음 — 미보고·레거시 클라이언트와 동일하게 취급).
 * // - Infinity(및 REWIND_CAP_TICKS를 초과하는 모든 유한값)는
 * //   REWIND_CAP_TICKS로 절단한다 — RQ-61 방어: 사수가 보고하는 값은
 * //   클라이언트 공급값이므로 서버가 상한에서 절단해야 임의로 먼 과거를
 * //   요구하는 변조 클라이언트를 막는다.
 * // - 상한 이내(경계 포함, msToTicks(rttMs) <= REWIND_CAP_TICKS)면 절단 없이
 * //   그대로(단, ms→틱 환산은 거친다) 반환한다 — RQ-64 "RTT 150ms 이내에서
 * //   정상 플레이를 보장한다"의 직역(150ms는 200ms 상한보다 작으므로 이
 * //   경로에서 항상 무절단으로 통과한다 — 별도 특례 분기가 필요 없다).
 * export function rewindTicksFor(rttMs: number): number
 *
 * // 되감기 링버퍼의 스냅샷 1건 — 서버가 매 틱 플레이어별 발 위치(RQ-20
 * // moveStates)를 이 형태로 적립한다.
 * export interface PositionSnapshot {
 *   tick: number
 *   x: number
 *   y: number
 *   z: number
 * }
 *
 * // REWIND_CAP_TICKS(6틱 전)까지의 되감기 요청을 항상 만족하려면 "현재 틱"
 * // 스냅샷까지 포함해 최소 7개(0~6틱 전)를 보관해야 한다.
 * export const POSITION_HISTORY_CAPACITY: number // = REWIND_CAP_TICKS + 1, 현재 7
 *
 * // 링버퍼에 새 스냅샷을 추가하고 `capacity`를 초과하면 가장 오래된(tick이
 * // 가장 작은) 것부터 버린다. `history`가 이미 tick 오름차순(오래된 것이
 * // 배열 앞쪽)이라고 가정하지 않는다 — 매 틱 끝에 push하는 정상적인 호출
 * // 패턴이면 자연히 오름차순이 되지만, 이 함수 자체는 순서를 가정하지 않고
 * // 그저 "가장 최근 `capacity`개"만 남긴다(길이 기준 트림 — `slice`).
 * export function appendPositionSnapshot(
 *   history: readonly PositionSnapshot[],
 *   snapshot: PositionSnapshot,
 *   capacity: number,
 * ): PositionSnapshot[]
 *
 * // `history`(순서 무관 — 임의 순서의 스냅샷 배열)에서
 * // `currentTick - rewindTicks`(목표 틱) **이하**인 스냅샷 중 tick이 가장
 * // 큰(목표 틱에 가장 가까운)것을 반환한다 — 정확히 그 틱의 스냅샷이 없어도
 * // (링버퍼는 매 틱 하나씩만 담으므로 보통 정확히 있지만, 방어적으로)
 * // "그 이전 중 가장 최근"으로 내림(floor)한다. 목표 틱 이하인 스냅샷이
 * // 하나도 없으면(목표 시각이 버퍼가 보관한 것보다 더 과거 — 접속 직후 등
 * // 버퍼가 아직 `POSITION_HISTORY_CAPACITY`만큼 차지 않은 경우) 버퍼 전체
 * // 에서 가장 오래된(tick이 가장 작은) 스냅샷으로 절단한다(크래시·undefined
 * // 없이 항상 "가장 가까운 유효값"을 반환). `history`가 비어 있으면
 * // undefined(호출자가 폴백을 결정한다 — 예: 현재 `moveStates`).
 * export function sampleRewoundPosition(
 *   history: readonly PositionSnapshot[],
 *   currentTick: number,
 *   rewindTicks: number,
 * ): PositionSnapshot | undefined
 * ```
 *
 * **가정(coder에게 — `GameRoom` 배선, `rq-64-lag-compensation-bound.test.ts`가
 * 통합 레벨에서 실제로 요구하는 것. 상세 근거는 그 파일 상단 docblock 참고)**:
 * 1. `fire` payload에 선택적 `rttMs: number` 필드가 추가된다(ADR-0005 §결과
 *    "타임스탬프/시퀀스 필드"가 가리키던 것 — 이 필드가 그 자리를 채운다).
 *    `sanitizeFireInput`이 `typeof raw?.rttMs === 'number' ? raw.rttMs : 0`
 *    패턴(`sanitizeMoveInput`과 동일한 방어적 파싱)으로 뽑는다 — 숫자가
 *    아니거나(문자열 등) 필드 자체가 없으면(레거시 클라이언트) 0으로
 *    대체하고, `rewindTicksFor(0) === 0`이라 되감기가 적용되지 않는다
 *    (회귀 방지 — 기존 hitscan 동작과 동일).
 * 2. `GameRoom`은 세션별 위치 이력을 신규 private map
 *    `positionHistory: Map<string, PositionSnapshot[]>`으로 추적한다.
 *    `stepPlayerMovement`에서 살아있는(canAct) 플레이어의 `moveStates`를
 *    갱신하는 바로 그 자리에서, 그 틱의 발 위치를
 *    `appendPositionSnapshot(..., POSITION_HISTORY_CAPACITY)`로 적립한다.
 *    사망한(canAct===false) 플레이어는 `moveStates`처럼 위치가 고정되므로
 *    이력도 추가하지 않는다(기존 "위치 고정" 정신과 동일).
 * 3. `handleFire`가 히트 후보(사수 자신을 제외한 대상)를 모을 때, 각 대상의
 *    포즈를 `moveStates`(현재 위치)가 아니라
 *    `sampleRewoundPosition(positionHistory.get(id) ?? [], state.tick,
 *    rewindTicksFor(input.rttMs))`(없으면 `moveStates`로 폴백)로 구한다.
 *    **사수 자신의 레이 원점은 되감지 않는다** — 여전히
 *    `moveStates.get(shooterId)`(현재 위치)를 그대로 쓴다(RQ-64는 "대상
 *    플레이어의 위치를... 되감아 판정"이라고만 하며, 사수 자신의 위치는
 *    되감기 대상이 아니다).
 * 4. `onLeave`에서 `positionHistory.delete(client.sessionId)`로 정리한다
 *    (다른 모든 세션 전유 부기 상태와 동일한 정리 패턴 — `moveStates`·
 *    `fallPeakY`·`lastInputAtTick` 등).
 */

describe('RQ-64 랙 보상 — rewindTicksFor(rttMs)', () => {
  it('REWIND_CAP_TICKS는 NET.REWIND_CAP_MS(200ms)를 틱으로 환산한 값(6)이다', () => {
    expect(REWIND_CAP_TICKS).toBe(6)
    expect(REWIND_CAP_TICKS).toBe(msToTicks(NET.REWIND_CAP_MS))
  })

  it('rttMs가 없거나(0) 되감기를 요구하지 않으면 0틱이다', () => {
    expect(rewindTicksFor(0)).toBe(0)
  })

  it('rttMs가 음수면(변조·오류) 0틱으로 방어한다', () => {
    expect(rewindTicksFor(-1)).toBe(0)
    expect(rewindTicksFor(-500)).toBe(0)
    expect(rewindTicksFor(-Infinity)).toBe(0)
  })

  it('rttMs가 NaN이면(타입은 number를 통과하지만 우회 가능한 값, 22l 전례) 0틱으로 방어한다', () => {
    expect(rewindTicksFor(Number.NaN)).toBe(0)
  })

  it('rttMs가 +Infinity면 상한(REWIND_CAP_TICKS)에서 절단한다', () => {
    expect(rewindTicksFor(Number.POSITIVE_INFINITY)).toBe(REWIND_CAP_TICKS)
  })

  it('RTT 100ms(150ms 예산 이내)는 절단 없이 msToTicks(100)=3틱 그대로 적용된다', () => {
    expect(msToTicks(100)).toBe(3) // 리터럴로도 재확인(100*30/1000=3.0, ceil 영향 없음)
    expect(rewindTicksFor(100)).toBe(3)
  })

  it('RTT 150ms(RQ-64 "정상 플레이 보장" 경계)는 절단 없이 msToTicks(150)=5틱 그대로 적용된다', () => {
    expect(msToTicks(150)).toBe(5) // 150*30/1000=4.5 → ceil=5
    expect(rewindTicksFor(150)).toBe(5)
    expect(rewindTicksFor(150)).toBeLessThan(REWIND_CAP_TICKS) // 상한 미도달 — 절단되지 않았음을 재확인
  })

  it('RTT 200ms(상한과 정확히 일치, 경계 포함)는 절단 없이 6틱이다', () => {
    expect(msToTicks(200)).toBe(6) // 200*30/1000=6.0, ceil 영향 없음 — 자연값 자체가 상한과 일치
    expect(rewindTicksFor(200)).toBe(6)
    expect(rewindTicksFor(200)).toBe(REWIND_CAP_TICKS)
  })

  it('RTT 201ms(상한을 막 초과)는 자연값 7틱이 아니라 6틱으로 절단된다', () => {
    expect(msToTicks(201)).toBe(7) // 201*30/1000=6.03 → ceil=7 (절단 없으면 이 값이 나와야 한다)
    expect(rewindTicksFor(201)).toBe(REWIND_CAP_TICKS) // 그러나 실제로는 6으로 절단
  })

  it('GA-16: RTT 300ms(상한 200ms/6틱 초과)는 자연값 9틱이 아니라 6틱으로 절단된다 — 300ms 전체를 되감지 않는다', () => {
    expect(msToTicks(300)).toBe(9) // 절단이 없다면 9틱(300ms)을 그대로 되감아야 한다
    expect(rewindTicksFor(300)).toBe(6)
    expect(rewindTicksFor(300)).toBe(REWIND_CAP_TICKS)
    expect(rewindTicksFor(300)).not.toBe(msToTicks(300)) // 명시적으로 "자연값과 다르다"를 재확인
  })

  it('RTT 1000ms(극단적으로 큰 값)도 동일하게 6틱으로 절단된다', () => {
    expect(msToTicks(1000)).toBe(30)
    expect(rewindTicksFor(1000)).toBe(REWIND_CAP_TICKS)
  })
})

describe('RQ-64 랙 보상 — sampleRewoundPosition(history, currentTick, rewindTicks)', () => {
  it('요청한 틱(currentTick-rewindTicks)에 정확히 일치하는 스냅샷을 반환한다', () => {
    const history: PositionSnapshot[] = [
      { tick: 94, x: 1, y: 0, z: 1 },
      { tick: 95, x: 2, y: 0, z: 2 },
      { tick: 96, x: 3, y: 0, z: 3 },
      { tick: 100, x: 9, y: 0, z: 9 },
    ]
    expect(sampleRewoundPosition(history, 100, 4)).toEqual({ tick: 96, x: 3, y: 0, z: 3 })
  })

  it('rewindTicks=0이면 currentTick 자신의 스냅샷을 반환한다(되감기 없음 = 현재 위치)', () => {
    const history: PositionSnapshot[] = [
      { tick: 99, x: 1, y: 0, z: 1 },
      { tick: 100, x: 2, y: 0, z: 2 },
    ]
    expect(sampleRewoundPosition(history, 100, 0)).toEqual({ tick: 100, x: 2, y: 0, z: 2 })
  })

  it('정확히 일치하는 틱이 없으면 그 이전 중 가장 최근 스냅샷으로 내림(floor)한다', () => {
    // 목표 틱(100-3=97)에 해당하는 스냅샷이 없다(94→96에서 100으로 건너뜀) —
    // 97 이하 중 가장 큰 96을 반환해야 한다.
    const history: PositionSnapshot[] = [
      { tick: 94, x: 1, y: 0, z: 1 },
      { tick: 96, x: 2, y: 0, z: 2 },
      { tick: 100, x: 9, y: 0, z: 9 },
    ]
    expect(sampleRewoundPosition(history, 100, 3)).toEqual({ tick: 96, x: 2, y: 0, z: 2 })
  })

  it('목표 틱이 버퍼가 보관한 가장 오래된 스냅샷보다 더 과거면(접속 직후 등 버퍼 미충전) 가장 오래된 것으로 절단한다', () => {
    // 버퍼가 3개(98~100)뿐인데 6틱 전(94)을 요구 — 크래시·undefined 없이
    // 가장 오래된(98)으로 절단해야 한다.
    const history: PositionSnapshot[] = [
      { tick: 98, x: 5, y: 0, z: 5 },
      { tick: 99, x: 6, y: 0, z: 6 },
      { tick: 100, x: 7, y: 0, z: 7 },
    ]
    expect(sampleRewoundPosition(history, 100, 6)).toEqual({ tick: 98, x: 5, y: 0, z: 5 })
  })

  it('버퍼가 비어 있으면 undefined를 반환한다(크래시하지 않는다) — 호출자가 폴백을 결정한다', () => {
    expect(sampleRewoundPosition([], 100, 6)).toBeUndefined()
  })

  it('history가 tick 오름차순이 아니어도(순서 무관) 동일하게 동작한다', () => {
    const shuffled: PositionSnapshot[] = [
      { tick: 100, x: 9, y: 0, z: 9 },
      { tick: 94, x: 1, y: 0, z: 1 },
      { tick: 96, x: 3, y: 0, z: 3 },
      { tick: 98, x: 5, y: 0, z: 5 },
    ]
    expect(sampleRewoundPosition(shuffled, 100, 4)).toEqual({ tick: 96, x: 3, y: 0, z: 3 })
  })
})

describe('RQ-64 랙 보상 — appendPositionSnapshot(history, snapshot, capacity) 링버퍼 트림', () => {
  it('capacity 미만이면 그대로 추가한다', () => {
    const history: PositionSnapshot[] = [{ tick: 1, x: 0, y: 0, z: 0 }]
    const next = appendPositionSnapshot(history, { tick: 2, x: 1, y: 0, z: 0 }, 7)
    expect(next).toEqual([
      { tick: 1, x: 0, y: 0, z: 0 },
      { tick: 2, x: 1, y: 0, z: 0 },
    ])
  })

  it('capacity를 초과하면 가장 오래된 것부터 버려 길이를 capacity로 유지한다(무한정 증가하지 않는다)', () => {
    let history: PositionSnapshot[] = []
    for (let tick = 0; tick < 50; tick += 1) {
      history = appendPositionSnapshot(history, { tick, x: tick, y: 0, z: 0 }, 7)
      expect(history.length).toBeLessThanOrEqual(7)
    }
    // 50틱을 계속 추가해도 최근 7개(43~49)만 남아야 한다 — 링버퍼 크기가
    // 되감기 상한에 비례해 고정되고, 접속 시간이 길어져도 무한정 커지지
    // 않는다(ADR-0005 "링버퍼 크기 무한 확장 문제" 방지 근거).
    expect(history).toEqual([
      { tick: 43, x: 43, y: 0, z: 0 },
      { tick: 44, x: 44, y: 0, z: 0 },
      { tick: 45, x: 45, y: 0, z: 0 },
      { tick: 46, x: 46, y: 0, z: 0 },
      { tick: 47, x: 47, y: 0, z: 0 },
      { tick: 48, x: 48, y: 0, z: 0 },
      { tick: 49, x: 49, y: 0, z: 0 },
    ])
  })

  it('POSITION_HISTORY_CAPACITY는 REWIND_CAP_TICKS+1(현재 7)이다 — 0~6틱 전 조회를 모두 만족하려면 현재 스냅샷 포함 7개가 필요하다', () => {
    expect(POSITION_HISTORY_CAPACITY).toBe(7)
    expect(POSITION_HISTORY_CAPACITY).toBe(REWIND_CAP_TICKS + 1)
  })
})
