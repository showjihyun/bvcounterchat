import { describe, expect, it } from 'vitest'
import { createFootstepPlaybackScheduler } from '@client/audio/footstepPlayback'

/**
 * RQ-72 발소리 구현 2/2-b(오디오 소비 배선) — 재생 스케줄러 순수 함수 계약
 * (원장 24bv "반드시 잠글 것 3" — "가청 판정이 실제로 걸리는가... 판정
 * 함수는 이미 있다(`isFootstepAudible`), 소비 경로가 그것을 부르는지를
 * 잠가라"). `src/client/audio/footstepPlayback.ts`는 아직 저장소에 0줄이다.
 *
 * ## 이 계층이 메우는 간극
 *
 * `@shared/sim/footsteps`의 `isFootstepAudible`(가청 판정)과
 * `@client/net/interpolation`의 `getFootstepCount`(원격 누적 총합, **소진
 * (drain)이 아니라 단조 누적** — `interpolation.ts` docblock)는 이미 있지만,
 * 그 둘을 이어 "이번 폴링에서 몇 번 재생해야 하는가"를 계산하는 소비 계층이
 * 없었다(`getFootstepCount`의 소비자 0명, 원장 24bv). 이 모듈이 그 간극을
 * 메운다 — **순수 함수**로 둬 재생 배선(`AudioContext`)과 분리한다
 * (**ADR-0014 결정 5**의 면제는 **재생 배선 층**에만 적용되고, 이 결정 로직
 * 자체는 면제 대상이 아니다 — 사용자 결정, 원장 24bv. ⚠️ 초안이 「ADR-0008
 * §6」을 근거로 들었으나 §6은 **렌더링(R3F)만** 면제하고 오디오를 면제한 적이
 * 없다 — 그 공백을 메운 절이 결정 5다).
 *
 * ## API 계약(test-writer 지정 — coder가 아래대로 구현하면 이 파일이
 * Green이 된다)
 *
 * ```ts
 * // src/client/audio/footstepPlayback.ts
 * export interface FootstepPlaybackScheduler {
 *   /**
 *    * sessionId 하나의 이번 폴링 결과를 처리한다.
 *    * - totalFootstepCount: 그 세션의 누적 발소리 총 횟수(원격은
 *    *   `interpolator.getFootstepCount(sessionId)`, 자기는 동일한 형태로
 *    *   유지되는 누적값 — 둘 다 호출자가 넘긴다, 이 모듈은 그 출처를
 *    *   모른다).
 *    * - isSelf: true면 horizontalDistanceM은 완전히 무시되고 항상 가청
 *    *   취급된다(GA-81, `isFootstepAudible`과 동일 계약).
 *    * - horizontalDistanceM: 청취자로부터의 수평 거리(m). isSelf가 true면
 *    *   무의미한 값(NaN 포함)을 넘겨도 안전해야 한다.
 *    *
 *    * 반환값: 이번 호출에서 재생해야 할 횟수(0 이상 정수).
 *    * /
 *   poll(sessionId: string, totalFootstepCount: number, isSelf: boolean, horizontalDistanceM: number): number
 * }
 *
 * export function createFootstepPlaybackScheduler(audibleRangeM: number): FootstepPlaybackScheduler
 * ```
 *
 * ## 설계 결정(test-writer 재량 — 스펙·team-lead 지시가 직접 규정하지 않은
 * 부분)
 *
 * 1. **세션별 첫 `poll` 호출은 항상 무음(0)이다** — 비교할 "직전 관측값"이
 *    없으므로 이번 호출의 `totalFootstepCount`를 그대로 기준값(baseline)
 *    으로 삼고 델타 0을 반환한다. `RemoteEntityInterpolator`의 "첫
 *    addSnapshot은 무음"(원장 24br) 패턴과 동일한 근거 — 리스너가 게임
 *    도중 접속(재접속 포함)했을 때 그 세션이 그동안 쌓아 온 발소리 총합을
 *    한꺼번에 재생하는 "따라잡기 폭발"을 막는다. self·remote 모두 동일하게
 *    적용한다(호출자가 항상 0에서 시작한다고 가정하지 않는다 — 방어적).
 * 2. **기준값(baseline)은 가청 여부와 무관하게 매 호출마다 갱신된다** —
 *    가청 범위 밖에서 쌓인 발소리는 나중에 범위 안으로 들어와도 "몰아서"
 *    재생되지 않는다(정보 누출 없음, ADR-0014 결정 1의 정신 — 범위 밖에
 *    있던 동안 일어난 일을 뒤늦게 알려주지 않는다). 즉 델타는 항상 "이번
 *    호출과 직전 호출 사이"만 보고, 가청 판정은 그 델타를 "재생할지"만
 *    결정한다.
 * 3. **델타는 음수가 되지 않는다** — `totalFootstepCount`가 직전 관측값보다
 *    작게 들어와도(정상 경로에서는 발생하지 않는 단조 증가 위반이지만
 *    방어적으로) `Math.max(0, current - previous)`로 클램프한다(RQ-61
 *    "서버·소스가 이상해도 클라는 방어적으로 처리한다"는 이 저장소의
 *    반복된 관례 — `stepFootstepAccumulator`의 `horizontalDeltaM` 방어와
 *    동일한 정신). 기준값 자체는 그래도 최신값으로 갱신한다.
 * 4. **세션마다 독립적으로 추적한다**(`Map` 내부 상태) — 한 세션의 폴링이
 *    다른 세션의 기준값에 영향을 주지 않는다.
 * 5. **가청 판정은 `@shared/sim/footsteps`의 `isFootstepAudible`을 그대로
 *    재사용한다**(ADR-0010 — 로직 복제 금지). 이 파일은 블랙박스로만
 *    검증한다: 경계(거리 == 가청 거리)가 포함되는지(GA-80), self가 거리와
 *    무관하게 항상 재생되는지(GA-81) — 둘 다 `isFootstepAudible`의 실제
 *    계약과 정확히 일치해야 통과한다.
 *
 * ## 스코프 밖
 *
 * - `AudioContext`로 실제 소리를 내는 것, `getFootstepCount`를 실제로
 *   폴링하는 배선(어느 프레임에서 몇 Hz로 부르는지) — ADR-0014 결정 5 면제,
 *   배선 계층의 몫.
 * - `isFootstepAudible` 자체의 판정 로직 정확성 — 이미
 *   `tests/unit/sim-footsteps.test.ts`(GA-80·81)가 검증했다. 이 파일은 그
 *   함수가 **이 소비 계층에서 실제로 호출되는지**(threading)만 본다.
 *
 * ## 스펙 질문 — 없음
 *
 * 위 5개 설계 결정은 스펙·ADR이 직접 규정하지 않는 소비 계층 내부 정책이라
 * test-writer 재량으로 남긴다(전부 근거를 위에 명시했다).
 */

const AUDIBLE_RANGE_M = 15

describe('RQ-72 2/2-b: FootstepPlaybackScheduler — 첫 poll은 항상 무음(기준값 확립)', () => {
  it('원격 세션의 첫 poll은 totalFootstepCount가 0보다 커도 0을 반환한다', () => {
    const scheduler = createFootstepPlaybackScheduler(AUDIBLE_RANGE_M)
    expect(scheduler.poll('remote-1', 5, false, 3)).toBe(0)
  })

  it('자기 세션의 첫 poll도 동일하게 0을 반환한다(방어적 — 호출자가 항상 0에서 시작한다고 가정하지 않는다)', () => {
    const scheduler = createFootstepPlaybackScheduler(AUDIBLE_RANGE_M)
    expect(scheduler.poll('self', 5, true, 0)).toBe(0)
  })
})

describe('RQ-72 2/2-b: FootstepPlaybackScheduler — 원격, 가청 범위 안', () => {
  it('두 번째 poll부터는 델타(신규 발소리 수)만큼 반환한다', () => {
    const scheduler = createFootstepPlaybackScheduler(AUDIBLE_RANGE_M)
    scheduler.poll('remote-1', 5, false, 3) // 기준값 5 확립, 0 반환
    expect(scheduler.poll('remote-1', 8, false, 3)).toBe(3)
  })

  it('경계 — 거리가 정확히 가청 거리와 같으면 재생된다(GA-80, 이내 포함)', () => {
    const scheduler = createFootstepPlaybackScheduler(AUDIBLE_RANGE_M)
    scheduler.poll('remote-2', 2, false, AUDIBLE_RANGE_M)
    expect(scheduler.poll('remote-2', 4, false, AUDIBLE_RANGE_M)).toBe(2)
  })
})

describe('RQ-72 2/2-b: FootstepPlaybackScheduler — 원격, 가청 범위 밖(정보 누출 없음)', () => {
  it('경계 초과 — 가청 거리를 넘으면 델타가 있어도 0을 반환한다', () => {
    const scheduler = createFootstepPlaybackScheduler(AUDIBLE_RANGE_M)
    scheduler.poll('remote-3', 5, false, AUDIBLE_RANGE_M + 0.01)
    expect(scheduler.poll('remote-3', 8, false, AUDIBLE_RANGE_M + 0.01)).toBe(0)
  })

  it('범위 밖에서 쌓인 발소리는 나중에 범위 안으로 들어와도 몰아서 재생되지 않는다(기준값은 가청 여부와 무관하게 매번 갱신된다)', () => {
    const scheduler = createFootstepPlaybackScheduler(AUDIBLE_RANGE_M)
    scheduler.poll('remote-4', 5, false, 20) // 기준값 5, 무음(첫 poll)
    // 범위 밖에서 3회 발생했지만(5 -> 8) 여전히 범위 밖 — 0을 반환하되
    // 기준값은 8로 갱신돼야 한다.
    expect(scheduler.poll('remote-4', 8, false, 20)).toBe(0)
    // 이제 범위 안으로 들어왔지만 totalFootstepCount는 그대로(8) — 새로
    // 발생한 것이 없으므로 "몰아서" 재생되면 안 된다(누출 없음의 핵심 단언).
    expect(scheduler.poll('remote-4', 8, false, 3)).toBe(0)
    // 범위 안에서 진짜 새로 1회 발생한 것만 재생된다.
    expect(scheduler.poll('remote-4', 9, false, 3)).toBe(1)
  })
})

describe('RQ-72 2/2-b: FootstepPlaybackScheduler — 자기 발소리(GA-81, 거리 무관 항상 재생)', () => {
  it('거리가 얼마나 크든(NaN 포함) 자기 발소리는 델타만큼 항상 재생된다', () => {
    const scheduler = createFootstepPlaybackScheduler(AUDIBLE_RANGE_M)
    scheduler.poll('self', 0, true, 999) // 기준값 0, 무음(첫 poll)
    expect(scheduler.poll('self', 3, true, 999)).toBe(3)
    expect(scheduler.poll('self', 5, true, Number.NaN)).toBe(2)
  })
})

describe('RQ-72 2/2-b: FootstepPlaybackScheduler — 세션 독립성', () => {
  it('서로 다른 sessionId의 기준값은 서로 간섭하지 않는다', () => {
    const scheduler = createFootstepPlaybackScheduler(AUDIBLE_RANGE_M)
    scheduler.poll('remote-A', 0, false, 3)
    scheduler.poll('remote-B', 0, false, 3)
    expect(scheduler.poll('remote-A', 4, false, 3)).toBe(4)
    expect(scheduler.poll('remote-B', 1, false, 3)).toBe(1)
  })
})

describe('RQ-72 2/2-b: FootstepPlaybackScheduler — 방어적 클램프', () => {
  it('totalFootstepCount가 직전 관측값보다 작게 들어와도 음수를 반환하지 않는다(0으로 클램프)', () => {
    const scheduler = createFootstepPlaybackScheduler(AUDIBLE_RANGE_M)
    scheduler.poll('remote-5', 5, false, 3) // 기준값 5
    expect(scheduler.poll('remote-5', 3, false, 3)).toBe(0) // 감소 — 클램프
    // 기준값은 갱신되므로 그 다음 정상 증가분은 정확히 반영된다.
    expect(scheduler.poll('remote-5', 4, false, 3)).toBe(1)
  })
})
