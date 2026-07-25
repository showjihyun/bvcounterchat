/**
 * RQ-95 기본 금칙어 필터 — 순수 변환. `src/shared/identity/nickname.ts`와
 * 동일한 "도메인 폴더 + 단일 파일" 구성(ADR-0011 test-writer 계약,
 * `_workspace/RQ-40/01_test-writer_red.md` §3.1). 실시간 API·난수 미사용,
 * `src/shared` 환경 중립(ADR-0010) — `window`·`document`·`process`·`fs`
 * 어디에도 의존하지 않는다.
 *
 * RQ-95 전문: "시스템은 채팅에 기본 금칙어 필터를 적용해야 한다. 도배
 * 레이트리밋과 사용자 차단 기능은 v1 범위 밖이다." 목록 자체는 스펙이
 * 정확한 값을 정하지 않은 튜닝 슬롯이다 — 필터링 방식(치환 또는 차단,
 * GA-24)에도 결합하지 않는다: 이 구현은 "치환"(각 글자를 `*`로 마스킹)을
 * 택했지만, 계약이 요구하는 건 "원본 금칙어가 원문 그대로 남지 않는다"는
 * 것뿐이다.
 */

/** 기본 금칙어 목록 — 대소문자 무관 매칭(`filterProfanity`). 스펙이 규모·
 * 다국어 여부를 정하지 않아(test-writer 관찰, §7) 한국어·영어 최소
 * 세트로 시작한다. 값을 바꾸려면 여기 한 곳만 고치면 된다(진실 공급원
 * 1개, ADR-0010 정신의 연장). */
export const DEFAULT_PROFANITY_WORDS: readonly string[] = [
  '시발',
  '씨발',
  '병신',
  '개새끼',
  'fuck',
  'shit',
  'bitch',
  'asshole',
]

/** 정규식 특수문자를 이스케이프한다 — 목록에 특수문자가 없더라도(현재
 * 목록은 없다) 향후 목록 확장 시 안전을 보장하는 방어적 처리. */
function escapeForRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `DEFAULT_PROFANITY_WORDS`에 담긴 각 단어를 대소문자 무관하게 찾아 같은
 * 길이의 `*` 문자열로 치환한다. 원본에 없는 단어는 전혀 건드리지 않는다
 * (양성 대조군 — 과잉 필터링 방지). 반환값은 원본 금칙어를 원문 그대로
 * 포함하지 않는다는 것만 보장한다 — 어떤 문자로 마스킹하는지는 계약 밖.
 */
export function filterProfanity(text: string): string {
  let result = text
  for (const word of DEFAULT_PROFANITY_WORDS) {
    if (word.length === 0) continue
    const pattern = new RegExp(escapeForRegExp(word), 'giu')
    result = result.replace(pattern, '*'.repeat(word.length))
  }
  return result
}
