import { describe, expect, it } from 'vitest'
import { isValidStatsUuid } from '@shared/stats/uuid'

/**
 * RQ-81 통계 절반(A계층 — 순수 UUID 형식 검증) — ADR-0011 §1 Red-first
 * 영역(`src/shared/` 전체).
 *
 * **팀리드 지시 "설계 포크 3"과 ADR-0006의 관계(오해 방지를 위해 명시)**:
 * ADR-0006 결정 4·"결과" 절은 "서버는 클라이언트가 제시하는 UUID를
 * **검증하지 않고** 그대로 신뢰한다"고 명시한다 — 이는 **신원(누구의
 * UUID인가)을 증명하라는 요구가 아니다**는 뜻이다(타인의 UUID를 사칭해
 * 그 통계 행에 기록을 얹는 것은 v1이 명시적으로 수용한 위험이며, 이
 * 파일은 그것을 막지 않는다 — 막으면 ADR-0006 위반이다). 이 파일이
 * 고정하는 것은 그와 **다른 층위**다: payload가 UUID **형식**조차 아닌
 * 경우(타입이 문자열이 아님·빈 문자열·구조가 안 맞음)를 걸러내는
 * 구문(syntax) 검사로, `sanitizeMoveInput`/`sanitizeNickname`/
 * `sanitizeFireInput`과 동일한 RQ-61 방어적 파싱 패턴이다. 이게 없으면
 * 서로 다른 여러 클라이언트가 각자 uuid 필드를 빠뜨리거나 깨뜨렸을 때
 * 전부 같은 "정규화된 기본값" 하나로 뭉쳐 **서로 무관한 실제 플레이어들의
 * 통계가 한 행에서 충돌·오염**된다(변조자가 특정 타인을 사칭하는 것과는
 * 다른 사고 — "형식 오류 전원이 같은 키로 수렴"하는 우연한 충돌이다).
 * 통합 테스트(`rq-81-uuid-tamper-defense.test.ts`)가 이 오염 부재를
 * 블랙박스로 확인하고, 이 파일은 그 앞단의 순수 판별 함수 자체를 고정한다.
 *
 * **가정(coder에게) — 신규 모듈 계약(그린필드, test-writer 지정)**:
 *
 * ```ts
 * // src/shared/stats/uuid.ts
 * export function isValidStatsUuid(value: unknown): value is string
 * ```
 *
 * **형식 결정(test-writer 재량, 근거)**: RFC4122 표준 8-4-4-4-12
 * 16진수-하이픈 형태(`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)를 대소문자
 * 구분 없이 받아들인다. 버전 니블(예: v4만 허용)은 강제하지 않는다 —
 * 스펙이 UUID 버전을 규정하지 않고, 브라우저 `crypto.randomUUID()`는
 * 항상 v4를 내지만 이 함수가 v4로 좁히면 향후 다른 생성 방식(예: 서버
 * 재발급 없이 폴리필로 생성된 UUID)이 이유 없이 거부될 수 있다. 앞뒤
 * 공백은 트림하지 않는다(엄격 — `sanitizeNickname`과 달리 UUID는 표시용
 * 텍스트가 아니라 저장 키이므로 애매한 관용보다 명확한 거부가 안전하다).
 */

describe('RQ-81 isValidStatsUuid — 유효한 형식', () => {
  it('RQ-81: 표준 소문자 UUID(하이픈 8-4-4-4-12)는 유효하다', () => {
    expect(isValidStatsUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
  })

  it('RQ-81: 대문자 UUID도 유효하다(대소문자 무관)', () => {
    expect(isValidStatsUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(true)
  })

  it('RQ-81: 혼합 대소문자 UUID도 유효하다', () => {
    expect(isValidStatsUuid('550e8400-E29b-41D4-a716-446655440000')).toBe(true)
  })
})

describe('RQ-81 isValidStatsUuid — 타입 방어(RQ-61 패턴)', () => {
  it('RQ-81: undefined는 무효다(uuid 필드 미제공)', () => {
    expect(isValidStatsUuid(undefined)).toBe(false)
  })

  it('RQ-81: null은 무효다', () => {
    expect(isValidStatsUuid(null)).toBe(false)
  })

  it('RQ-81: 숫자는 무효다', () => {
    expect(isValidStatsUuid(12345)).toBe(false)
  })

  it('RQ-81: 불리언은 무효다', () => {
    expect(isValidStatsUuid(true)).toBe(false)
  })

  it('RQ-81: 배열은 무효다(변조된 payload가 가장 흔히 시도하는 형태)', () => {
    expect(isValidStatsUuid(['550e8400-e29b-41d4-a716-446655440000'])).toBe(false)
  })

  it('RQ-81: 객체는 무효다(toString 위장 포함 — String() 강제 변환에 기대지 않는다)', () => {
    expect(isValidStatsUuid({ toString: () => '550e8400-e29b-41d4-a716-446655440000' })).toBe(false)
  })
})

describe('RQ-81 isValidStatsUuid — 형식 방어', () => {
  it('RQ-81: 빈 문자열은 무효다', () => {
    expect(isValidStatsUuid('')).toBe(false)
  })

  it('RQ-81: UUID 형태가 아닌 임의 문자열은 무효다', () => {
    expect(isValidStatsUuid('not-a-uuid')).toBe(false)
  })

  it('RQ-81: 하이픈이 빠진 32자 16진수는 무효다(형식이 다르다)', () => {
    expect(isValidStatsUuid('550e8400e29b41d4a716446655440000')).toBe(false)
  })

  it('RQ-81: 세그먼트 길이가 하나 짧은 문자열은 무효다', () => {
    expect(isValidStatsUuid('550e8400-e29b-41d4-a716-44665544000')).toBe(false)
  })

  it('RQ-81: 16진수가 아닌 문자가 섞이면 무효다', () => {
    expect(isValidStatsUuid('550e8400-e29b-41d4-a716-44665544zzzz')).toBe(false)
  })

  it('RQ-81: 앞뒤 공백이 섞인 유효 UUID는 무효다(트림하지 않는다 — 엄격)', () => {
    expect(isValidStatsUuid(' 550e8400-e29b-41d4-a716-446655440000 ')).toBe(false)
  })

  it('RQ-81: 극단적으로 긴 문자열은 무효다(DoS·저장소 팽창 방어)', () => {
    expect(isValidStatsUuid('550e8400-e29b-41d4-a716-446655440000' + 'a'.repeat(10_000))).toBe(false)
  })

  it('RQ-81: SQL 인젝션 시도 형태 문자열도 형식 검사만으로 거부된다(방어 심층화 — 실제 방어는 파라미터 바인딩이 담당하되, 이 게이트가 애초에 통과시키지 않는다)', () => {
    expect(isValidStatsUuid("550e8400-e29b-41d4-a716-446655440000'; DROP TABLE stats;--")).toBe(false)
  })
})
