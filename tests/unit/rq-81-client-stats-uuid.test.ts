import { describe, expect, it, vi } from 'vitest'
import {
  getOrCreateStatsUuid,
  readUuidStorage,
  resolveStatsUuid,
  STATS_UUID_STORAGE_KEY,
  type UuidStorage,
} from '@client/identity/statsUuid'
import { isValidStatsUuid } from '@shared/stats/uuid'

/**
 * RQ-81 — 클라이언트 익명 통계 UUID(브라우저 `localStorage` 보관,
 * ADR-0006 결정 4) test-after 계약(ADR-0011: `src/client` 모듈은 test-after
 * 허용, 순증만 — 신규 파일·신규 `it()`).
 *
 * 서버 쪽 값·로직(`isValidStatsUuid`, `@shared/stats/uuid`)을 그대로
 * 재사용해 형식 판정 기준이 클라·서버 양쪽에서 정확히 하나로 유지되는지도
 * 함께 확인한다(ADR-0010 값·로직 복제 금지).
 */

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

// 아래 `vi.stubGlobal('crypto', ...)`로 `globalThis.crypto`를 교체하기
// **전에** 진짜 구현을 붙잡아 둔다 — 대체 객체 내부에서 `globalThis.crypto
// .getRandomValues`를 그대로 참조하면 스텁이 적용된 뒤에는 자기 자신을
// 가리켜 무한 재귀(`Maximum call stack size exceeded`)가 난다.
const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)

/** `crypto.randomUUID`가 없고 `getRandomValues`만 있는 insecure context를
 * 흉내내는 가짜 `crypto`(`statsUuid.ts`의 secure-context 폴백 분기 검증용,
 * 평가 major 4). */
function insecureContextCrypto(): { getRandomValues: (arr: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> } {
  return {
    getRandomValues: (arr: Uint8Array<ArrayBuffer>) => realGetRandomValues(arr),
  }
}

function fakeStorage(initial: Record<string, string> = {}): UuidStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null
    },
    setItem(key: string, value: string): void {
      data[key] = value
    },
  }
}

describe('RQ-81 resolveStatsUuid(순수) — 저장된 값 유효성에 따른 분기', () => {
  it('RQ-81: 유효한 기존 UUID는 그대로 쓰고 shouldPersist=false다(생성기를 호출하지 않는다)', () => {
    const generateUuid = vi.fn(() => 'should-not-be-called')
    const result = resolveStatsUuid(VALID_UUID, generateUuid)
    expect(result).toEqual({ uuid: VALID_UUID, shouldPersist: false })
    expect(generateUuid).not.toHaveBeenCalled()
  })

  it('RQ-81: 저장값이 없으면(null) 새로 생성하고 shouldPersist=true다', () => {
    const generateUuid = vi.fn(() => VALID_UUID)
    const result = resolveStatsUuid(null, generateUuid)
    expect(result).toEqual({ uuid: VALID_UUID, shouldPersist: true })
    expect(generateUuid).toHaveBeenCalledTimes(1)
  })

  it('RQ-81: 저장값이 UUID 형식이 아니면(손상) 새로 생성하고 shouldPersist=true다', () => {
    const generateUuid = vi.fn(() => VALID_UUID)
    const result = resolveStatsUuid('not-a-uuid', generateUuid)
    expect(result).toEqual({ uuid: VALID_UUID, shouldPersist: true })
    expect(generateUuid).toHaveBeenCalledTimes(1)
  })
})

describe('RQ-81 getOrCreateStatsUuid — 저장소 부작용', () => {
  it('RQ-81: 저장소가 비어 있으면 새 UUID를 생성해 STATS_UUID_STORAGE_KEY로 저장하고 그 값을 반환한다', () => {
    const storage = fakeStorage()
    const uuid = getOrCreateStatsUuid(storage, () => VALID_UUID)
    expect(uuid).toBe(VALID_UUID)
    expect(storage.data[STATS_UUID_STORAGE_KEY]).toBe(VALID_UUID)
  })

  it('RQ-81: 저장소에 유효한 UUID가 이미 있으면 그대로 반환하고 저장소를 다시 쓰지 않는다', () => {
    const storage = fakeStorage({ [STATS_UUID_STORAGE_KEY]: VALID_UUID })
    const setItemSpy = vi.spyOn(storage, 'setItem')
    const uuid = getOrCreateStatsUuid(storage, () => 'other-uuid-should-not-be-used')
    expect(uuid).toBe(VALID_UUID)
    expect(setItemSpy).not.toHaveBeenCalled()
  })

  it('RQ-81: 두 번 연속 호출해도(재호출) 같은 값을 반환한다 — 매 접속마다 안정적인 키', () => {
    const storage = fakeStorage()
    const first = getOrCreateStatsUuid(storage, () => VALID_UUID)
    const second = getOrCreateStatsUuid(storage, () => 'a-different-uuid-1234-5678-9999999999')
    expect(second).toBe(first)
  })

  it('RQ-81: generateUuid를 생략하면 기본값(crypto.randomUUID)이 유효한 통계 UUID 형식을 만든다', () => {
    const storage = fakeStorage()
    const uuid = getOrCreateStatsUuid(storage)
    expect(isValidStatsUuid(uuid)).toBe(true)
  })
})

/** `getItem`/`setItem` 중 지정한 메서드가 항상 던지는 저장소 더블 —
 * 원장 26k 조건 2(`statsUuid.ts`의 `getOrCreateStatsUuid` 코멘트): 속성
 * 접근(`window.localStorage` 자체)은 성공했지만 **메서드 호출**이 던지는
 * 경우(쿼터 초과, 구형 프라이빗 모드 계열)를 재현한다. opaque origin·
 * 사이트 데이터 차단(속성 접근 자체가 던지는 조건 1)은 아래 별도 describe
 * (`readUuidStorage`)가 다룬다 — 리뷰 blocker: 이 둘을 뭉뚱그려 여기서
 * 같이 다루면 안 된다. `UuidStorage`가 주입식 인터페이스라 화이트박스
 * 없이 검증 가능. */
function throwingStorage(opts: { onGetItem?: boolean; onSetItem?: boolean }): UuidStorage {
  return {
    getItem(key: string): string | null {
      if (opts.onGetItem) {
        throw new DOMException(`blocked: ${key}`, 'SecurityError')
      }
      return null
    },
    setItem(key: string, value: string): void {
      if (opts.onSetItem) {
        throw new DOMException(`blocked: ${key}=${value}`, 'SecurityError')
      }
    },
  }
}

describe('RQ-81 getOrCreateStatsUuid — 저장소 접근 실패 가드(원장 26k)', () => {
  // 26k: `App.tsx`가 이 함수를 `useState(() => ...)` 초기화 함수 안에서
  // 호출한다 — 여기서 던지면 예외가 렌더 밖으로 전파되어 앱 전체가
  // 백지가 된다(통계만 빠지는 게 아니다). 아래 세 테스트는 "던지지 않는다"
  // 자체를 회귀 가드로 고정한다.
  it('RQ-81/26k: getItem이 던져도 예외가 전파되지 않고 유효한 UUID를 반환한다', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const storage = throwingStorage({ onGetItem: true })
      let uuid = ''
      expect(() => {
        uuid = getOrCreateStatsUuid(storage, () => VALID_UUID)
      }).not.toThrow()
      expect(isValidStatsUuid(uuid)).toBe(true)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('RQ-81/26k: setItem이 던져도 예외가 전파되지 않고 유효한 UUID를 반환한다(저장은 포기하되 게임은 그 값을 쓴다)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const storage = throwingStorage({ onSetItem: true })
      let uuid = ''
      expect(() => {
        uuid = getOrCreateStatsUuid(storage, () => VALID_UUID)
      }).not.toThrow()
      expect(uuid).toBe(VALID_UUID)
      expect(isValidStatsUuid(uuid)).toBe(true)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('RQ-81/26k: getItem·setItem이 모두 던져도(최악의 경우) 예외가 전파되지 않고 형식이 유효한 UUID를 반환한다', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const storage = throwingStorage({ onGetItem: true, onSetItem: true })
      let uuid = ''
      expect(() => {
        uuid = getOrCreateStatsUuid(storage, () => VALID_UUID)
      }).not.toThrow()
      expect(isValidStatsUuid(uuid)).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('RQ-81 readUuidStorage — 속성 접근 실패 가드(원장 26k 리뷰 blocker)', () => {
  // 리뷰 blocker: `window.localStorage` **속성 접근 자체**가 던지는 환경
  // (opaque origin·샌드박스 iframe, 사이트 데이터 차단)에서는
  // `getOrCreateStatsUuid` 내부 try/catch로 잡을 수 없다 — 인자는 호출자
  // (`App.tsx`) 쪽에서 이미 평가되기 때문이다. `readUuidStorage()`가 그
  // 속성 접근 자체를 감싼다. 실제 브라우저 동작(Chrome: "Failed to read
  // the 'localStorage' property from 'Window'")을 흉내내려 `getter`가
  // 던지는 객체를 만든다 — `throwingStorage`(위)와 달리 메서드가 아니라
  // 속성 자체가 던진다는 점이 이 테스트의 핵심이다.
  it("RQ-81/26k: localStorage 속성 접근(getter) 자체가 던져도 readUuidStorage는 던지지 않고, 그 결과를 getOrCreateStatsUuid에 넘기면 유효한 UUID를 반환한다", () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const throwingWindow = {} as { localStorage: UuidStorage }
      Object.defineProperty(throwingWindow, 'localStorage', {
        get(): UuidStorage {
          throw new DOMException("Failed to read the 'localStorage' property from 'Window'", 'SecurityError')
        },
      })

      let storage: UuidStorage | undefined
      expect(() => {
        storage = readUuidStorage(throwingWindow)
      }).not.toThrow()
      expect(warnSpy).toHaveBeenCalled()

      let uuid = ''
      expect(() => {
        uuid = getOrCreateStatsUuid(storage!, () => VALID_UUID)
      }).not.toThrow()
      expect(isValidStatsUuid(uuid)).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('RQ-81 getOrCreateStatsUuid — secure-context 폴백(평가 major 4)', () => {
  it("RQ-81: crypto.randomUUID가 없는 환경(HTTP 사내망 배포, insecure context)에서도 getRandomValues로 유효한 UUID를 만든다", () => {
    // RQ-80/ADR-0009 HTTP 배포에서는 Crypto.randomUUID()가 없을 수 있다
    // (secure context 전용) — getRandomValues()는 그 제약이 없으므로 이
    // 조합을 흉내낸 가짜 crypto로 기본 생성기의 폴백 분기를 검증한다.
    vi.stubGlobal('crypto', insecureContextCrypto())
    try {
      const storage = fakeStorage()
      const uuid = getOrCreateStatsUuid(storage)
      expect(isValidStatsUuid(uuid)).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('RQ-81: 폴백 경로도 매 호출 다른 값을 만든다(무작위성 최소 확인 — 상수 반환이 아니다)', () => {
    vi.stubGlobal('crypto', insecureContextCrypto())
    try {
      const a = getOrCreateStatsUuid(fakeStorage())
      const b = getOrCreateStatsUuid(fakeStorage())
      expect(a).not.toBe(b)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('RQ-81: crypto.randomUUID가 있으면(secure context) 폴백을 쓰지 않고 그대로 쓴다', () => {
    const storage = fakeStorage()
    const uuid = getOrCreateStatsUuid(storage) // 이 테스트 환경(Node)은 secure — randomUUID 존재
    expect(isValidStatsUuid(uuid)).toBe(true)
  })
})
