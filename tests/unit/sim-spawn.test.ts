import { describe, expect, it } from 'vitest'
import { SPAWN_POINTS, isWithinSafeZone, nextSpawnIndex, type SpawnPoint } from '@shared/sim/spawn'
import { WORLD } from '@shared/constants'

/**
 * RQ-31(스폰 지점 **선택 규칙**만 이번 라운드 범위) — 순수 로직 단위 테스트
 * (ADR-0008: 순수 함수, 결정론, `src/shared` 환경 중립. ADR-0011: `src/shared`
 * 전체는 Red-first 영역).
 *
 * **이번 라운드의 스코프(team-lead 지시, RQ-15/16 원장)**: RQ-31 전체가 아니라
 * "14~16개 지점 배치 + 직전 사용 지점을 회피하는 순환 로테이션"이라는 **선택
 * 규칙**만 지금 구현한다. Safe Zone(반경 5m 피해 무효·사격 불가, GA-11·GA-19)과
 * 실제 맵 좌표는 범위 밖 — 좌표는 60×60 WORLD 위에 절차적으로 배치한 **잠정값**
 * 이며 맵 단계(8)가 교체한다. 이 파일은 좌표의 정확한 값을 검증하지 않고
 * (값 발명 금지 — ADR-0005 §결과와 동일 원칙), **관측 가능한 구조적 계약**만
 * 고정한다: 개수·평지(y=0)·월드 경계 안·서로 다른 좌표.
 *
 * **매핑**: RQ-15(리스폰, GA-09)가 사망한 플레이어를 재배치할 지점을 고르는 데
 * 이 모듈을 쓴다. GA-20(RQ-31 전체 라운드, `tests/integration/
 * rq-31-spawn-rotation.test.ts`)은 이 파일이 검증하는 순수 로직의 통합 시나리오
 * 버전이며 이번 라운드의 산출물이 아니다 — 그 골든 케이스의 `verify` 경로가
 * 가리키는 파일이 따로 있으므로 이 파일에서 GA-20을 흉내 내지 않는다. 대신
 * `tests/integration/rq-15-respawn-timer.test.ts`가 "리스폰 위치가
 * `SPAWN_POINTS` 중 하나다"라는 약한 통합 확인만 겸한다.
 *
 * **그린필드 계약(test-writer 지정, `sim-combat.test.ts`/`sim-tick-driver.test.ts`
 * 선례와 동일한 권한)**: `src/shared/sim/spawn.ts`는 원장에 없는 신규 모듈이다.
 * 아래 계약대로 `coder`가 구현하면 이 파일이 Green이 된다.
 *
 * ```ts
 * // src/shared/sim/spawn.ts (신규)
 * export interface SpawnPoint { x: number; y: number; z: number }
 *
 * // RQ-31: 14~16개, 60×60 WORLD 위에 절차적으로 배치한 잠정 좌표(전부 y=0 —
 * // Rapier 없는 평지 가정, @shared/sim/movement와 동일 전제). 값 자체는 이
 * // 파일이 검증하지 않는다 — coder가 자유롭게 정한다(구조적 계약만 고정).
 * export const SPAWN_POINTS: readonly SpawnPoint[]
 *
 * // 직전에 사용된 인덱스를 회피하는 순환 로테이션(RQ-31 "순환 로테이션",
 * // ADR-0008 결정론 — Math.random() 사용 금지). previousIndex가 없으면(서버
 * // 기동 직후 등 로테이션 이력이 없는 최초 호출) 0을 반환한다. 그 외에는
 * // (previousIndex + 1) % total — 단순 라운드로빈. total이 previousIndex보다
 * // 커야 하는 등의 유효성 검사는 요구하지 않는다(호출자가 항상 SPAWN_POINTS.length를
 * // 넘긴다는 전제).
 * export function nextSpawnIndex(previousIndex: number | undefined, total: number): number
 * ```
 *
 * **가정(coder에게 — GameRoom 배선)**: 이 모듈 자신은 "현재 로테이션 커서가
 * 무엇인지" 기억하지 않는 순수 함수다 — `GameRoom`이 세션과 무관한 **룸 전역**
 * 커서 하나를 들고(`lastFireAtMs`류 Map이 아니라 단일 변수) 최초 입장(onJoin)과
 * 리스폰(RQ-15) 양쪽에서 이 함수를 호출해 커서를 갱신한다고 가정한다 — 그래야
 * 서로 다른 두 플레이어가 동시에 접속해도 같은 지점에 겹쳐 스폰하지 않는다
 * (`rq-15-respawn-timer.test.ts`의 "두 플레이어가 서로 다른 스폰 지점에 위치"
 * 확인이 이 가정에 의존한다).
 */

describe('RQ-31(선택 규칙) — SPAWN_POINTS 구성', () => {
  it('SPAWN_POINTS는 14~16개다(RQ-31 "14~16개를 배치")', () => {
    expect(SPAWN_POINTS.length).toBeGreaterThanOrEqual(14)
    expect(SPAWN_POINTS.length).toBeLessThanOrEqual(16)
  })

  it('모든 스폰 지점은 평지(y=0)다 — Rapier 없는 평지 시뮬레이션 전제(@shared/sim/movement)와 일치', () => {
    for (const point of SPAWN_POINTS) {
      expect(point.y).toBe(0)
    }
  })

  it('모든 스폰 지점은 WORLD 경계(±SIZE_M/2) 안에 있다(RQ-30 60×60m)', () => {
    const halfExtent = WORLD.SIZE_M / 2
    for (const point of SPAWN_POINTS) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(halfExtent)
      expect(Math.abs(point.z)).toBeLessThanOrEqual(halfExtent)
    }
  })

  it('모든 스폰 지점은 서로 다른 좌표다(겹침 없음 — eyeHeight 복원 전제, item E)', () => {
    const seen = new Set<string>()
    for (const point of SPAWN_POINTS) {
      const key = `${point.x},${point.y},${point.z}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })
})

describe('nextSpawnIndex — 직전 사용 지점을 회피하는 순환 로테이션(RQ-31)', () => {
  it('이전 인덱스가 없으면(로테이션 이력 없음 — 서버 기동 직후) 0을 반환한다', () => {
    expect(nextSpawnIndex(undefined, 15)).toBe(0)
  })

  it('순환은 직전 인덱스 + 1이다(단순 라운드로빈)', () => {
    expect(nextSpawnIndex(0, 15)).toBe(1)
    expect(nextSpawnIndex(5, 15)).toBe(6)
    expect(nextSpawnIndex(13, 15)).toBe(14)
  })

  it('마지막 인덱스에서는 0으로 순환한다(wrap-around)', () => {
    expect(nextSpawnIndex(14, 15)).toBe(0)
  })

  it('반환값은 항상 직전 인덱스와 다르다(total>1 전제 — GA-20 취지: 직전 사용 지점 회피)', () => {
    for (let previous = 0; previous < 15; previous += 1) {
      expect(nextSpawnIndex(previous, 15)).not.toBe(previous)
    }
  })

  it('SPAWN_POINTS.length를 total로 넘겨도 항상 유효한 인덱스(배열 범위 안)를 반환한다', () => {
    let index: number | undefined = undefined
    for (let i = 0; i < SPAWN_POINTS.length * 2; i += 1) {
      index = nextSpawnIndex(index, SPAWN_POINTS.length)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(SPAWN_POINTS.length)
      expect(SPAWN_POINTS[index]).toBeDefined()
    }
  })
})

// 타입이 실제로 export되는지(구조 분해 시 타입 에러 없이 쓰이는지)는 아래 헬퍼가
// 컴파일된다는 사실 자체로 확인된다 — 별도 런타임 단언은 필요 없다.
function assertSpawnPointShape(point: SpawnPoint): void {
  expect(typeof point.x).toBe('number')
  expect(typeof point.y).toBe('number')
  expect(typeof point.z).toBe('number')
}

describe('SpawnPoint 타입 형태', () => {
  it('SPAWN_POINTS의 각 원소는 {x,y,z} 숫자 필드를 갖는다', () => {
    for (const point of SPAWN_POINTS) {
      assertSpawnPointShape(point)
    }
  })
})

/**
 * `isWithinSafeZone` — RQ-31 Safe Zone 소속 판정(리뷰 major 3 대응,
 * `_workspace/RQ-31/06_coder_fall-damage.md` §단위 테스트). 구현이 이미
 * `handleFire`/`trackFallDamage`에 배선된 뒤 추가하는 test-after이지만
 * (ADR-0011의 취지는 그물이 실재하는지이지 순서 자체가 아니라는 팀리드
 * 지시), 아래 각 케이스는 §산출물 문서에 기록한 변이(구현을 일시적으로
 * 되돌려 이 테스트가 실제로 실패하는지) 확인을 거쳤다 — 통과만 하고 아무
 * 것도 못 잡는 죽은 단언이 아니다.
 *
 * docblock이 스스로 규정하는 3가지 판단 갈림을 각각 고정한다:
 * 1. 경계(정확히 반경, 5.000m)는 `<=`(포함)다.
 * 2. 수평(XZ)만 본다 — y는 무시한다.
 * 3. 주입 인자(`spawnPoints?`·`radiusM?`)가 실제로 기본값을 대체한다.
 *
 * 원점에 스폰 지점 하나만 둔 합성 배열로 경계 산술을 실제 SPAWN_POINTS의
 * 각·반지름 기하에서 분리한다(그 기하는 `describe('RQ-31(선택 규칙)...')`가
 * 이미 따로 고정한다).
 */
describe('isWithinSafeZone — Safe Zone 소속 판정(RQ-31, GA-11·GA-19의 기반)', () => {
  const ORIGIN_SPAWN: SpawnPoint = { x: 0, y: 0, z: 0 }
  const RADIUS_M = 5

  it('반경보다 짧은 거리(반경-0.5m)는 안(true)이다', () => {
    expect(isWithinSafeZone({ x: RADIUS_M - 0.5, z: 0 }, [ORIGIN_SPAWN], RADIUS_M)).toBe(true)
  })

  it('정확히 반경(경계 자체, 5.000m)은 안(true)이다 — "<=" 판정. 원문 "반경을 벗어나면 해제"는 반경보다 커진 순간만 규정하고, 반경과 정확히 같은 지점의 소속은 규정하지 않는다', () => {
    expect(isWithinSafeZone({ x: RADIUS_M, z: 0 }, [ORIGIN_SPAWN], RADIUS_M)).toBe(true)
  })

  it('반경보다 긴 거리(반경+0.5m)는 밖(false)이다', () => {
    expect(isWithinSafeZone({ x: RADIUS_M + 0.5, z: 0 }, [ORIGIN_SPAWN], RADIUS_M)).toBe(false)
  })

  it('y는 무시한다(수평 XZ 거리만) — 같은 x·z에서 y만 크게 달라도 판정이 바뀌지 않는다', () => {
    const groundLevel: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
    const highAltitude: { x: number; y: number; z: number } = { x: 0, y: 100, z: 0 }
    expect(isWithinSafeZone(groundLevel, [ORIGIN_SPAWN], RADIUS_M)).toBe(true)
    expect(isWithinSafeZone(highAltitude, [ORIGIN_SPAWN], RADIUS_M)).toBe(true)
  })

  it('스폰 지점이 여럿이면 "하나라도" 반경 안이면 참이다 — 배열 전체를 순회한다(첫 원소만 보지 않는다)', () => {
    const far: SpawnPoint = { x: 1000, y: 0, z: 1000 }
    const near: SpawnPoint = { x: 0, y: 0, z: 0 }
    expect(isWithinSafeZone({ x: 0, z: 0 }, [far, near], RADIUS_M)).toBe(true)
  })

  it('주입한 spawnPoints를 실제로 쓴다 — 기본 SPAWN_POINTS 기준 밖인 지점도, 그 지점 자신을 유일한 스폰 지점으로 주입하면 안이다', () => {
    const farFromAllDefaults: SpawnPoint = { x: 1000, y: 0, z: 1000 }
    expect(isWithinSafeZone(farFromAllDefaults)).toBe(false)
    expect(isWithinSafeZone(farFromAllDefaults, [farFromAllDefaults], RADIUS_M)).toBe(true)
  })

  it('주입한 radiusM을 실제로 쓴다 — 기본 WORLD.SAFE_ZONE_RADIUS_M이 아니라 인자를 따른다', () => {
    const position = { x: 1, z: 0 }
    expect(isWithinSafeZone(position, [ORIGIN_SPAWN], 0.5)).toBe(false) // 반경을 0.5m로 좁히면 밖
    expect(isWithinSafeZone(position, [ORIGIN_SPAWN], 2)).toBe(true) // 반경 2m면 안
  })

  it('인자를 생략하면 기본값(SPAWN_POINTS 전체·WORLD.SAFE_ZONE_RADIUS_M)을 쓴다 — 자기 자신의 스폰 지점(거리 0)은 안이다', () => {
    const knownPoint = SPAWN_POINTS[0]
    if (!knownPoint) throw new Error('테스트 전제 위반 — SPAWN_POINTS가 비어 있다')
    expect(isWithinSafeZone({ x: knownPoint.x, z: knownPoint.z })).toBe(true)
  })
})
