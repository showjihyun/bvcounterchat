/**
 * RQ-81 — 클라이언트가 제시하는 통계 키(익명 UUID)의 **형식(구문)** 검증.
 * 계약·근거는 `tests/unit/rq-81-uuid-validation.test.ts` 상단
 * docblock(test-writer 지정)이 정본이다.
 *
 * **ADR-0006과의 경계**: ADR-0006은 서버가 UUID의 **소유권**(누구 것인가)을
 * 검증하지 않고 그대로 신뢰한다고 명시한다 — 이 함수는 그것을 어기지 않는다.
 * 여기서 거르는 것은 payload가 **UUID 형식조차 아닌 경우**(타입 오류·빈
 * 문자열·구조 불일치)뿐이다 — `sanitizeMoveInput`/`sanitizeNickname`/
 * `sanitizeFireInput`과 동일한 RQ-61 방어적 파싱 패턴. 이게 없으면 서로
 * 무관한 여러 세션의 형식 오류 값이 하나의 "정규화된 기본값"으로 수렴해
 * 서로의 통계를 오염시킨다.
 *
 * **형식**: RFC4122 표준 8-4-4-4-12 16진수-하이픈 형태
 * (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`), 대소문자 무관, 버전 니블은
 * 강제하지 않는다(스펙이 UUID 버전을 규정하지 않는다). 앞뒤 공백은 트림하지
 * 않고 거부한다 — 저장 키이지 표시 텍스트가 아니므로 엄격하게 다룬다.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidStatsUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}
