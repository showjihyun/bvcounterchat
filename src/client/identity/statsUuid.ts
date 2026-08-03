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
 * 원칙을 따른다)**: 순수부(`resolveStatsUuid`)는 브라우저 API를 직접
 * 호출하지 않는다 — 생성기를 인자로 받는다. 이 파일에서 실제 브라우저
 * Web Crypto API를 참조하는 지점은 `defaultGenerateUuid`(아래) 하나뿐이고,
 * `getOrCreateStatsUuid`는 그것을 기본 인자로만 받는다.
 *
 * **형식 검증 재사용(ADR-0010 값·로직 복제 금지)**: 저장된 값의 형식
 * 유효성은 서버와 동일한 `@shared/stats/uuid`의 `isValidStatsUuid`로
 * 판정한다 — 클라이언트가 독자적인 정규식을 새로 정의하지 않는다. 손상된
 * (또는 애초에 없는) 저장값은 새로 생성한다.
 *
 * **secure-context 폴백(평가 major 4)**: `Crypto.randomUUID()`는 Web
 * Crypto 명세상 **secure context(HTTPS 또는 `localhost`)에서만** 제공된다.
 * RQ-80/ADR-0009는 사내망 **HTTP**(TLS 불요) 배포를 확정했으므로
 * `http://<사내망호스트>:8080` 접속은 secure context가 아니고,
 * `crypto.randomUUID`가 `undefined`가 되어 그대로 호출하면 `App.tsx`의
 * `useState` 초기화 함수 안에서 TypeError가 나 앱 전체가 렌더되지 않는다
 * (통계만 빠지는 게 아니다). `Crypto.getRandomValues()`는 secure context
 * 제약이 **없다**(같은 명세, insecure context에서도 제공) — 그래서
 * `randomUUID`가 없으면 `getRandomValues`로 v4 UUID를 직접 조립한다(RFC
 * 4122 §4.4 절차: 무작위 16바이트에 버전 니블(0100)·변형 니블(10xx)만
 * 덮어쓴다). `isValidStatsUuid`가 요구하는 형식(§`@shared/stats/uuid`)을
 * 그대로 만족한다.
 */

/** `localStorage`(그리고 그 서브셋을 만족하는 테스트 더블)가 구현해야 하는
 * 최소 계약 — 브라우저 `Storage` 인터페이스는 이 두 메서드를 포함해
 * 구조적으로 호환된다. */
export interface UuidStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** `readUuidStorage`가 저장소 자체를 얻지 못했을 때(아래) 대신 건네는
 * 스텁 — `getItem`은 항상 `null`(저장값 없음과 동일 취급), `setItem`은
 * no-op(저장 시도를 조용히 버린다). 원인은 `readUuidStorage`가 이미
 * `console.warn`으로 남긴 뒤이므로 여기서 다시 남기지 않는다. */
const NO_STORAGE: UuidStorage = {
  getItem(): string | null {
    return null
  },
  setItem(): void {
    // no-op
  },
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

/** `Crypto.randomUUID()`가 없는(insecure context) 환경을 위한 폴백 —
 * `Crypto.getRandomValues()`(secure context 무관, 항상 제공)로 RFC 4122
 * v4 UUID를 직접 조립한다. 위 모듈 코멘트 "secure-context 폴백" 참고. */
function randomUuidV4FromGetRandomValues(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // 버전 니블 → 0100(v4)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // 변형 니블 → 10xx(RFC 4122)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** `getOrCreateStatsUuid`의 기본 생성기 — `randomUUID`가 있으면(secure
 * context) 그대로 쓰고, 없으면(HTTP 사내망 배포, RQ-80) 위 폴백을 쓴다. */
function defaultGenerateUuid(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return randomUuidV4FromGetRandomValues()
}

/**
 * 원장 26k(리뷰 blocker) — 저장소 접근 실패는 **두 지점**에서 날 수 있고,
 * 서로 다른 위치를 감싸야 한다(첫 라운드는 후자를 놓쳤다: 인자는 호출자
 * 쪽에서 이미 평가되므로 `getOrCreateStatsUuid` 내부 try/catch로는 원리적으로
 * 잡을 수 없는 지점이 있었다):
 *
 * 1. **속성 접근**(`window.localStorage` 자체를 읽는 지점, 이 함수가 감싼다)
 *    — 문서 origin이 opaque인 경우(예: `sandbox` 속성에 `allow-same-origin`이
 *    없는 iframe)나 브라우저가 사이트 데이터를 차단한 경우, HTML 명세상
 *    `localStorage` **getter가** 던진다(Chrome: "Failed to read the
 *    'localStorage' property from 'Window'"). `getItem`/`setItem`을
 *    호출하기도 전에 이미 던지므로, 아래 `getOrCreateStatsUuid`의
 *    try/catch는 이 예외를 볼 수조차 없다 — `App.tsx`가 `window.localStorage`를
 *    직접 참조하지 않고 반드시 이 함수를 거쳐야 하는 이유다.
 * 2. **메서드 호출**(`getItem`/`setItem` 그 자체, `getOrCreateStatsUuid`가
 *    감싼다, 아래) — 속성 접근은 성공했지만 호출이 던지는 경우다: 쿼터
 *    초과(`QuotaExceededError`, `setItem`), 구형 프라이빗 모드 계열(일부
 *    구현은 `localStorage` 객체는 내주면서 메서드 호출에서 던진다).
 *
 * 두 계층 모두 필요하다 — 하나만 감싸면 나머지 조건에서 여전히 앱 전체가
 * 백지가 된다(`src/client` 전체에 ErrorBoundary가 없다, 원장 26k 실측).
 */
export function readUuidStorage(win: { localStorage: UuidStorage } = window): UuidStorage {
  try {
    return win.localStorage
  } catch (err) {
    // 관측 가능성 정정(리뷰 minor, in-PR(b)): "조용히 삼키지 않는다"는
    // 규범은 GameRoom의 RQ-60 `onOverflow` 경고와 같지만, 관측 경로는
    // 다르다 — 서버 로그는 운영자가 `docker logs`로 보지만, 이
    // `console.warn`은 사용자 브라우저 devtools에만 남아 실제로는 아무도
    // 보지 않는다. 그래도 남기는 이유는 진단 가능성 자체를 0으로 만들지
    // 않기 위해서다(디버깅 세션에서라도 열어보면 보인다).
    console.warn('[statsUuid] localStorage 속성 접근 실패 — 저장 없이 진행합니다.', err)
    return NO_STORAGE
  }
}

/**
 * 배선 계층(`App.tsx`) 진입점 — `storage`에서 기존 UUID를 읽고, 없거나
 * 손상됐으면 새로 만들어 저장한 뒤 반환한다. 이후 `connectToGame`이 이
 * 값을 `joinOrCreate` 옵션에 실어 보낸다.
 *
 * **원장 26k — 메서드 호출 가드**: `getItem`/`setItem` 호출 자체가 던질 수
 * 있는 조건(쿼터 초과, 구형 프라이빗 모드 계열 — 위 `readUuidStorage`
 * 코멘트 조건 2)을 감싼다. **속성 접근**(조건 1, opaque origin·사이트
 * 데이터 차단)은 이 함수의 try/catch로 잡을 수 없다 — 그 지점은 위
 * `readUuidStorage`가 감싼다(`App.tsx`가 `readUuidStorage()`의 반환값을
 * 이 함수의 `storage` 인자로 넘긴다).
 *
 * `App.tsx`가 이 함수를 `useState(() => ...)` **렌더 초기화 함수 안**에서
 * 호출하므로, 여기서 던지면 예외가 렌더 밖으로 전파돼 앱 전체가 백지가
 * 된다(`src/client` 전체에 ErrorBoundary가 없다, 원장 26k 실측) — 통계만
 * 빠지는 게 아니다.
 *
 * - `getItem` 실패 → 저장값이 없는 것과 동일하게 취급(`existing = null`).
 *   `resolveStatsUuid`가 새 UUID를 생성한다.
 * - `setItem` 실패 → 저장을 포기하고 **생성한 UUID를 그대로 반환**한다.
 *   그 세션은 통계가 다음 접속으로 이어지지 않지만(매번 새 UUID), 게임
 *   자체는 정상 동작한다 — 서버(`GameRoom.onJoin`)는 `isValidStatsUuid`를
 *   통과하는 값만 받아들이고 형식 유효성 외에는 아무것도 요구하지 않으며
 *   (신원 증명이 아니다, 위 모듈 코멘트), `onLeave`도 uuid가 있을 때만
 *   통계를 기록하므로 저장 실패 자체가 접속·플레이를 막지 않는다.
 * - 두 catch 모두 `console.warn`으로 원인을 남긴다 — 관측 가능성에 대한
 *   정정은 위 `readUuidStorage` 코멘트 참고(서버 로그와 달리 클라 경고는
 *   사용자 devtools에만 남는다). 통계 유실은 조용히 진행 가능한 실패이지
 *   재시도·복구 대상이 아니므로 그 이상의 처리(재시도, 사용자 알림)는
 *   하지 않는다.
 */
export function getOrCreateStatsUuid(storage: UuidStorage, generateUuid: () => string = defaultGenerateUuid): string {
  let existing: string | null = null
  try {
    existing = storage.getItem(STATS_UUID_STORAGE_KEY)
  } catch (err) {
    console.warn('[statsUuid] localStorage.getItem 실패 — 새 UUID를 생성합니다(통계는 이번 세션에서 이어지지 않습니다).', err)
  }

  const { uuid, shouldPersist } = resolveStatsUuid(existing, generateUuid)

  if (shouldPersist) {
    try {
      storage.setItem(STATS_UUID_STORAGE_KEY, uuid)
    } catch (err) {
      console.warn('[statsUuid] localStorage.setItem 실패 — 저장 없이 이번 세션의 UUID만 사용합니다.', err)
    }
  }

  return uuid
}
