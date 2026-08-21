/**
 * RQ-72·RQ-78/ADR-0014 튜닝값 — 발소리·발사음 파형·감쇠의 구현 세부.
 * 스펙이 수치를 정하지 않은 구현 세부라 코드가 아닌 이 설정 파일의 값으로
 * 잠정 확정한다(`combat-tuning.ts`와 같은 형태 — 값 발명이 아니라
 * **위임된 튜닝 슬롯**).
 *
 * ⚠️ **`constants.ts`에 두지 않는 이유**(PR #76 리뷰 major): 그 파일은
 * docblock으로 「여기 있는 값은 **전부** `requirements.md`가 확정한 것」이고
 * 「아직 확정되지 않은 튜닝값은 **여기 두지 않는다**」고 스스로 못박는다.
 * 재량값이 섞이면 `gate_spec_mirror.py`의 설계 전제(「`constants.ts`가 스펙
 * 값의 정본」)가 흐려진다 — 그 게이트가 문서 인용을 정본과 대조하는데,
 * 정본 자체에 스펙 근거가 없는 값이 있으면 무엇을 대조하는지가 모호해진다.
 *
 * ADR-0014 결정 4가 확정한 값(가청 거리 15m · 보폭 2.0m)은 `constants.ts`의
 * `AUDIO`에 그대로 있다 — 그쪽은 스펙 확정값이다.
 */
export const AUDIO_TUNING = {
  /**
   * 발소리 파형 1회 지속 시간(ms).
   *
   * ADR-0014 결정 4가 확정한 값이 **아니다**. 정확한 감쇠 곡선 모양·지속
   * 시간은 스펙이 규정하지 않는 구현 세부라 test-writer가 coder 재량으로
   * 남겼고(`tests/unit/rq-72-footstep-synth.test.ts` 상단 docblock), 짧은
   * 타격음(수십~백여 ms대) 감각을 노린 coder 선택값이다.
   *
   * ⚠️ 이 값이 「맞는지」는 **사람이 들어야** 안다 — 어떤 테스트도 그것을
   * 검증하지 않는다(테스트는 `sampleRateHz`에 대한 **비례**만 단언하므로
   * 이 값이 바뀌어도 깨지지 않는다).
   */
  FOOTSTEP_DURATION_MS: 90,
  /**
   * 발사음(RQ-78) 파형 1회 지속 시간(ms). RQ-78 원문·ADR-0014 결정 6이
   * "합성 음색은 이 문면이 정하지 않는다"고 명시적으로 위임한 값이다
   * (`tests/unit/rq-78-gunshot-synth.test.ts` 상단 docblock 계약 —
   * `sampleRateHz`에 대한 **비례**만 단언, 이 값이 바뀌어도 테스트는
   * 깨지지 않는다). 발소리(90ms)보다 조금 길게 잡아 "탁" 소리 뒤에 짧은
   * 꼬리(잔향)가 남는 크랙(crack) 인상을 노렸다 — `synthesizeGunshotBurst`가
   * `footstepSynth.ts`와 동일한 지수 감쇠 엔벨로프를 재사용하므로, 이
   * 값만 늘리면 꼬리가 자연히 길어진다.
   *
   * ⚠️ 이 값이 「맞는지」는 **사람이 들어야** 안다 — 위 `FOOTSTEP_DURATION_MS`와
   * 동일한 이유로 어떤 테스트도 절대값을 검증하지 않는다.
   */
  GUNSHOT_DURATION_MS: 150,
  /**
   * 발사음(RQ-78) 볼륨 감쇠 기준 거리(m) — `@shared/sim/gunshotAudio`의
   * `gunshotVolume(distanceM, isSelf, tuning)`에 주입하는 프로덕션 값.
   *
   * ⚠️ **`AUDIO.AUDIBLE_RANGE_M`(발소리 15m)에서 유도하지 않는 독립
   * 상수다**(RQ-78 원문 "볼륨 감쇠의 기준 거리는 AUDIO.AUDIBLE_RANGE_M에서
   * 유도하지 않는 독립 상수" — `tests/unit/sim-gunshot-audio.test.ts` 상단
   * docblock, ADR-0014 결정 4가 가청 거리를 `WORLD.SIZE_M`에서 유도하지
   * 않은 것과 같은 이유: 다른 상수가 바뀌어도 조용히 따라 움직이면 안
   * 된다). 발소리의 이진 컷오프 거리(15m)보다 조금 넓게 잡아, 컷오프
   * 없이 맵 전체(`WORLD.SIZE_M`=60m)에서 "어딘가에서 총성이 들린다"는
   * 감각은 유지하면서도 15m 안쪽에서는 뚜렷하게 크게 들리도록 했다
   * (`gunshotVolume`의 역거리 감쇠식에서 이 거리가 볼륨 0.5 지점이다).
   *
   * ⚠️ 이 값이 「맞는지」는 **사람이 들어야** 안다 — `gunshotVolume`의
   * 단위 테스트는 이 값을 몰라도 성립하는 성질(단조성·컷오프 없음)만
   * 검증한다(`sim-gunshot-audio.test.ts` `TUNING.referenceDistanceM = 20`은
   * 테스트 전용 임의값이지 이 프로덕션 값이 아니다).
   */
  GUNSHOT_VOLUME_REFERENCE_DISTANCE_M: 20,
} as const
