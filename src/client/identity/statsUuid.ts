import { isValidStatsUuid } from '@shared/stats/uuid'

/**
 * RQ-81 — 브라우저에 보관하는 익명 통계 UUID(ADR-0006 결정 4). 서버는 이
 * 값을 검증 없이 그대로 통계 키로 신뢰한다 — 이 모듈의 책임은 "매 접속마다
 * 같은 값을 안정적으로 제시하는 것"뿐이다(신원 증명이 아니다).
 *
 * **레이어 분리(`harness/workflow/fe.md` 정신)**: 순수 판정(`resolveStatsUuid`)
 * 과 저장소 부작용(`getOrCreateStatsUuid`)을 분리했다 — `@client/input/fireControl`
 * 이 판정(`canFire`)과 상태 갱신을 나눈 것과 동일한 원칙. `resolveStatsUuid`는
 * DOM·`localStorage`에 의존하지 않아 jsdom 없이도(현재 `environment: 'node'`,
 * `vitest.config.ts`) 단위 테스트가 가능하다.
 *
 * **결정론(ADR-0008 정신 — `src/client`는 lint 강제 대상은 아니지만 같은
 * 원칙을 따른다)**: 순수부(`resolveStatsUuid`)는 `crypto.randomUUID()`를
 * 직접 호출하지 않는다 — 생성기를 인자로 받는다. 이 파일에서 실제 브라우저
 * Web Crypto API를 참조하는 지점은 `getOrCreateStatsUuid`의 기본 인자
 * 하나뿐이다.
 *
 * **형식 검증 재사용(ADR-0010 값·로직 복제 금지)**: 저장된 값의 형식
 * 유효성은 서버와 동일한 `@shared/stats/uuid`의 `isValidStatsUuid`로
 * 판정한다 — 클라이언트가 독자적인 정규식을 새로 정의하지 않는다. 손상된
 * (또는 애초에 없는) 저장값은 새로 생성한다.
 */

/** `localStorage`(그리고 그 서브셋을 만족하는 테스트 더블)가 구현해야 하는
 * 최소 계약 — 브라우저 `Storage` 인터페이스는 이 두 메서드를 포함해
 * 구조적으로 호환된다. */
export interface UuidStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const STATS_UUID_STORAGE_KEY = 'chatstrike.statsUuid'

/** 저장소에서 읽은 원값이 유효한 UUID 형식이면 그대로 쓰고, 아니면(최초
 * 방문·저장값 손상) `generateUuid()`로 새로 만든다. `shouldPersist`는
 * 호출자가 실제로 저장소에 쓸지 결정하는 신호일 뿐, 이 함수 자신은 어떤
 * 저장소에도 접근하지 않는다(순수). */
export function resolveStatsUuid(
  existing: string | null,
  generateUuid: () => string,
): { uuid: string; shouldPersist: boolean } {
  if (isValidStatsUuid(existing)) {
    return { uuid: existing, shouldPersist: false }
  }
  return { uuid: generateUuid(), shouldPersist: true }
}

/**
 * 배선 계층(`App.tsx`) 진입점 — `storage`에서 기존 UUID를 읽고, 없거나
 * 손상됐으면 새로 만들어 저장한 뒤 반환한다. 이후 `connectToGame`이 이
 * 값을 `joinOrCreate` 옵션에 실어 보낸다.
 */
export function getOrCreateStatsUuid(storage: UuidStorage, generateUuid: () => string = () => crypto.randomUUID()): string {
  const existing = storage.getItem(STATS_UUID_STORAGE_KEY)
  const { uuid, shouldPersist } = resolveStatsUuid(existing, generateUuid)
  if (shouldPersist) {
    storage.setItem(STATS_UUID_STORAGE_KEY, uuid)
  }
  return uuid
}
