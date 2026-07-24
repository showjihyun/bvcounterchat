/**
 * RQ-02 v1.2 닉네임 새니타이즈 — 권위 상태 저장·브로드캐스트 전에 적용하는
 * 순수 변환. 파이프라인 순서(스펙 고정): 유니코드 제어문자(Cc — 개행·탭
 * 포함) 제거 → 양끝 공백 트림 → 유니코드 코드포인트 기준 길이 절단
 * (서로게이트 쌍은 1자 — `.length`(UTF-16 code unit) 기준 절단은 서로게이트
 * 쌍을 쪼갤 수 있어 쓰지 않는다).
 *
 * 결과가 빈 문자열일 수 있다 — "새니타이즈 결과가 빈 문자열이면 닉네임
 * 미제공과 동일하게 처리한다(기본 닉네임 부여)"는 이 함수의 책임이 아니다.
 * 이 함수는 순수 변환만 하고 기본값을 모른다 — 호출자(`GameRoom`)가 빈
 * 문자열 여부를 보고 기본 닉네임으로 대체한다.
 */

import { IDENTITY } from '@shared/constants'

export function sanitizeNickname(input: string): string {
  const withoutControlChars = stripControlChars(input)
  const trimmed = withoutControlChars.trim()
  return truncateToCodepoints(trimmed, IDENTITY.NICKNAME_MAX_CODEPOINTS)
}

/** 유니코드 제어문자(Cc — Control 카테고리. NUL·TAB·LF·CR·DEL 등)를 전부
 * 제거한다. */
function stripControlChars(input: string): string {
  return input.replace(/\p{Cc}/gu, '')
}

/** 유니코드 코드포인트 기준으로 앞 n개만 남긴다(서로게이트 쌍을 쪼개지
 * 않는다) — `Array.from`은 문자열을 코드포인트 단위로 순회한다(JS 명세). */
function truncateToCodepoints(input: string, maxCodepoints: number): string {
  return Array.from(input).slice(0, maxCodepoints).join('')
}
