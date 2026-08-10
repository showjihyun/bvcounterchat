import { isFootstepAudible } from '@shared/sim/footsteps'

/**
 * RQ-72 2/2-b — 발소리 재생 스케줄러(원장 24bv "반드시 잠글 것 3"). 순수
 * 함수 — `AudioContext`를 참조하지 않는다(ADR-0014 결정 5 면제는 재생 배선
 * 에만 적용되고, 이 결정 로직 자체는 면제 대상이 아니다).
 *
 * `@shared/sim/footsteps`의 `isFootstepAudible`(가청 판정)과
 * `@client/net/interpolation`의 `getFootstepCount`(원격 누적 총합)를 이어
 * "이번 폴링에서 몇 번 재생해야 하는가"를 계산하는 소비 계층이다.
 *
 * 계약 전문·설계 결정 5건의 근거는 `tests/unit/rq-72-footstep-playback.test.ts`
 * 상단 docblock(test-writer 지정)이 정본이다 — 이 함수는 그 계약을 그대로
 * 구현한다:
 * 1. 세션별 첫 `poll`은 항상 무음(기준값 확립) — 따라잡기 폭발 방지.
 * 2. 기준값은 가청 여부와 무관하게 매 호출마다 갱신 — 정보 누출 없음.
 * 3. 델타는 `Math.max(0, current - previous)`로 방어적 클램프.
 * 4. 세션마다 독립 추적(`Map`).
 * 5. 가청 판정은 `isFootstepAudible`을 그대로 재사용한다(ADR-0010 —
 *    로직 복제 금지).
 */
export interface FootstepPlaybackScheduler {
  /**
   * sessionId 하나의 이번 폴링 결과를 처리한다.
   * @param sessionId 세션 식별자(원격은 `Room.sessionId`, 자기는 자신의
   *   `sessionId`) — 세션마다 독립된 기준값을 추적한다.
   * @param totalFootstepCount 그 세션의 누적 발소리 총 횟수(원격은
   *   `interpolator.getFootstepCount(sessionId)`, 자기는 동일한 형태로
   *   유지되는 누적값) — 호출자가 넘긴다, 이 모듈은 출처를 모른다.
   * @param isSelf true면 `horizontalDistanceM`은 완전히 무시되고 항상
   *   가청 취급된다(GA-81, `isFootstepAudible`과 동일 계약).
   * @param horizontalDistanceM 청취자로부터의 수평 거리(m). `isSelf`가
   *   true면 무의미한 값(NaN 포함)을 넘겨도 안전하다.
   * @returns 이번 호출에서 재생해야 할 횟수(0 이상 정수).
   */
  poll(sessionId: string, totalFootstepCount: number, isSelf: boolean, horizontalDistanceM: number): number
}

interface SessionFootstepState {
  /** 직전 `poll` 호출에서 관측한 `totalFootstepCount` — 다음 호출의
   * 델타 계산 기준값. */
  previousTotal: number
}

export function createFootstepPlaybackScheduler(audibleRangeM: number): FootstepPlaybackScheduler {
  const sessions = new Map<string, SessionFootstepState>()

  return {
    poll(sessionId, totalFootstepCount, isSelf, horizontalDistanceM) {
      const existing = sessions.get(sessionId)

      if (!existing) {
        // 결정 1 — 이 세션의 첫 관측. 비교할 직전 값이 없으므로 이번
        // 값을 기준값으로만 삼고 무음을 반환한다.
        sessions.set(sessionId, { previousTotal: totalFootstepCount })
        return 0
      }

      // 결정 3 — 방어적 클램프(단조 증가 위반을 방어).
      const delta = Math.max(0, totalFootstepCount - existing.previousTotal)
      // 결정 2 — 기준값은 가청 여부와 무관하게 항상 갱신한다(정보 누출 없음).
      existing.previousTotal = totalFootstepCount

      if (!isFootstepAudible(horizontalDistanceM, isSelf, audibleRangeM)) return 0
      return delta
    },
  }
}
