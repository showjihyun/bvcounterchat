import { describe, expect, it, vi } from 'vitest'
import { getOrCreateStatsUuid, resolveStatsUuid, STATS_UUID_STORAGE_KEY, type UuidStorage } from '@client/identity/statsUuid'
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
