import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFANITY_WORDS, filterProfanity } from '@shared/chat/profanityFilter'

/**
 * RQ-95 금칙어 필터 — 순수 함수 단위 테스트 (ADR-0008: 데미지/닉네임과 같은
 * 순수 로직은 단위 레벨).
 *
 * 매핑된 골든 케이스: GA-24 (`harness/evals/golden/track-a-product.jsonl`,
 * verify: `tests/integration/rq-95-profanity-filter.test.ts`). 이 파일은
 * GA-24 자체의 `verify` 대상이 아니다 — 그 파일은 서버 왕복(통합) 레벨에서
 * 같은 불변식을 검증한다. 이 파일은 그 서버 경로가 호출할 **순수 함수 자체**를
 * `src/shared`(ADR-0011 Red-first 필수 영역)에 계약으로 선행시킨다
 * (`sanitizeNickname`/`tests/unit/rq-02-nickname-sanitize.test.ts`와 동일한
 * "순수 변환 함수 + 별도 단위 테스트" 패턴).
 *
 * RQ-95 전문: "시스템은 채팅에 **기본 금칙어 필터**를 적용해야 한다. 도배
 * 레이트리밋과 사용자 차단 기능은 v1 범위 밖이다."
 * GA-24: "given: 기본 금칙어 목록에 포함된 단어를 담은 채팅 메시지 / when:
 * 플레이어가 해당 메시지를 전송 / then: 서버가 금칙어를 필터링(치환 또는
 * 차단)해 전달한다 — 원문 그대로 다른 사용자에게 노출되지 않는다."
 *
 * **가정(coder에게 — 이 모듈은 아직 없다, test-writer가 계약을 정한다)**:
 * `src/shared/chat/profanityFilter.ts`가 아래 두 심볼을 노출한다고 가정한다.
 *
 *   export const DEFAULT_PROFANITY_WORDS: readonly string[]
 *   export function filterProfanity(text: string): string
 *
 * 파일 분리는 `sanitizeNickname`(`src/shared/identity/nickname.ts`)과 동일한
 * "도메인 폴더 + 단일 파일" 구성을 따른다. 금칙어 목록 자체는 스펙이 정확한
 * 값을 정하지 않은 튜닝 슬롯이라(RQ-95가 "기본 금칙어 필터"라고만 하고
 * 목록을 나열하지 않는다) `DEFAULT_HITBOX`/`DEFAULT_SPREAD`
 * (`src/shared/config/combat-tuning.ts`)와 같은 성격이지만, 필터 로직과
 * 분리할 이유가 약해(목록 자체가 필터 함수의 유일한 소비자) 같은 파일에
 * 공존시켰다 — coder가 `src/shared/config/`로 쪼개기로 하면 이 파일의
 * import 한 줄만 조정하면 된다.
 *
 * **단어 값을 이 테스트가 발명하지 않는 이유(ADR-0010 값 복제 금지 정신의
 * 확장)**: 실제 욕설·비속어 문자열을 테스트 코드에 하드코딩하면 (1) 정확히
 * 어떤 단어가 최종 목록에 포함될지 test-writer가 추측해야 하고 — 추측이
 * 틀리면 이 테스트는 아무것도 검증하지 못한 채 통과하는 공허한 테스트가
 * 된다(team-lead 경고 — 공허화 주의) — (2) 소스에 실제 비속어 문자열이
 * 남는다. 대신 `DEFAULT_PROFANITY_WORDS` 자체를 진실 공급원으로 삼아 그
 * 목록의 실제 원소를 입력에 심어 필터링되는지 확인한다.
 *
 * **필터링 단위(치환 또는 차단, GA-24 then)**: 이 테스트는 "치환"과 "차단"
 * 중 어느 쪽을 선택했는지에 결합하지 않는다 — 반환된 문자열에 원본 금칙어가
 * **그대로(원문 그대로)** 남아있지 않다는 것만 단언한다. 메시지 전체를 다른
 * 문자열로 치환하든, 그 단어만 마스킹하든 이 불변식은 동일하게 성립한다.
 */
describe('RQ-95 금칙어 필터 — 순수 함수(filterProfanity)', () => {
  it('설계 전제: DEFAULT_PROFANITY_WORDS는 최소 1개 이상의 금칙어를 포함한다', () => {
    expect(Array.isArray(DEFAULT_PROFANITY_WORDS)).toBe(true)
    expect(DEFAULT_PROFANITY_WORDS.length).toBeGreaterThan(0)
  })

  it('GA-24: 목록에 포함된 모든 금칙어가 메시지에 담겨 있으면 원문 그대로 남지 않는다', () => {
    for (const word of DEFAULT_PROFANITY_WORDS) {
      const input = `hello ${word} there`
      const result = filterProfanity(input)
      expect(result).not.toContain(word)
    }
  })

  it('양성 대조군 — 금칙어가 전혀 없는 메시지는 원문 그대로 반환된다(과잉 필터링 방지)', () => {
    const clean = 'hello world, nice shot!'
    expect(filterProfanity(clean)).toBe(clean)
  })
})
