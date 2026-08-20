/**
 * RQ-70·71/ADR-0016 결정 3 튜닝값 — 피격 효과(Blood Effect)의 지속 시간.
 * 스펙은 "일시적"만 규정하고 정확한 값은 정하지 않은 구현 세부라 코드가
 * 아닌 이 설정 파일의 값으로 잠정 확정한다(`audio-tuning.ts`·
 * `combat-tuning.ts`와 같은 형태 — 값 발명이 아니라 위임된 튜닝 슬롯).
 *
 * ⚠️ `constants.ts`에 두지 않는 이유(`audio-tuning.ts` 선례 그대로): 그
 * 파일은 "여기 있는 값은 전부 requirements.md가 확정한 것"이라고 스스로
 * 못박는다 — 재량값이 섞이면 `gate_spec_mirror.py`의 전제(「constants.ts가
 * 스펙 값의 정본」)가 흐려진다. 탄흔 상한(64, RQ-70 확정값)은
 * `constants.ts`의 `EFFECTS`에 그대로 있다 — 그쪽은 스펙 확정값이다.
 */
export const EFFECTS_TUNING = {
  /**
   * 피격 효과(Blood Effect) 1건의 지속 시간(ms) — `applyHitEvent`의
   * `hitEffectDurationMs` 인자로 주입한다(`@client/effects/hitFeedback`,
   * GA-99). RQ-71 "일시적이며 짧은 시간 뒤 스스로 사라진다"의 감각을 노린
   * coder 선택값 — 순간의 신호(피)가 다음 총격전 전에는 사라지되 눈에
   * 띌 만큼은 남는 짧은 창.
   *
   * ⚠️ 이 값이 "맞는지"는 사람이 봐야 안다 — 어떤 테스트도 정확한 값을
   * 검증하지 않는다(`rq-70-71-hit-feedback.test.ts`는 호출자가 직접 넘긴
   * 리터럴로만 컬렉터 동작을 확인하므로 이 값이 바뀌어도 깨지지 않는다).
   */
  HIT_EFFECT_DURATION_MS: 400,
  /**
   * RQ-57 히트마커(원장 24cv) 1건의 지속 시간(ms) — `applyHitReaction`의
   * `hitMarkerDurationMs` 인자로 주입한다(`@client/effects/hitFeedback`).
   * RQ-57 문면 "지속 시간·크기·음색은 이 문면이 정하지 않는다 — 튜닝
   * 설정값" 위임을 그대로 받는다. 크로스헤어 위에 짧게 겹쳤다 사라지는
   * "확인" 감각을 노린 coder 선택값 — 눈에 띄되 다음 판단(다음 표적 조준)을
   * 가리지 않을 만큼 짧다.
   */
  HIT_MARKER_DURATION_MS: 250,
  /**
   * RQ-58 피격 방향(원장 24cv) 1건의 지속 시간(ms) — `applyHitReaction`의
   * `hitDirectionDurationMs` 인자로 주입한다. 방향을 읽고 반응할 시간을
   * 주되 시야를 오래 가리지 않도록 `HIT_EFFECT_DURATION_MS`보다 조금 더
   * 길게 잡았다 — 피격자가 반응(회피·반격)하려면 사수보다 더 많은 인지
   * 시간이 필요하다는 감각의 coder 선택값.
   */
  HIT_DIRECTION_DURATION_MS: 600,
} as const
