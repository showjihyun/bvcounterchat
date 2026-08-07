import { describe, expect, it } from 'vitest'
import { SPAWN_POINTS } from '@shared/sim/spawn'
import { PRODUCTION_WALLS } from '@shared/sim/walls'
import { PRODUCTION_BOXES } from '@shared/sim/boxes'
import { PRODUCTION_PLATFORMS } from '@shared/sim/platforms'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import type { WallAABB, BoxAABB } from '@shared/sim/movement'

/**
 * 원장 24af 명제 3(실측 대상) — 몸 반경 이동 판정: 모든 스폰(RQ-31)이
 * 모든 차단 지오메트리(벽·박스·플랫폼, RQ-30/RQ-32/RQ-33)에서
 * `DEFAULT_HITBOX.bodyRadiusM` 이상 떨어져 있는가.
 *
 * **왜 이 파일이 필요한가(원장 24af 지시 — "⚠️ 이것을 실측하라")**: 반경이
 * 도입되면 스폰 직후 정지 상태에서도 절단이 걸릴 수 있다 — 사전 검산(읽기
 * 전용, 원점 거리 기준)은 벽(여유 5.24m)·플랫폼(4.64m)은 안전하나
 * **`BOX_ALPHA_5` 모서리가 이상화된 원 반경(스폰 링 22 vs 모서리
 * 22.489…)으로는 겹친다**고 경고했다. 그러나 실제 스폰은 연속된 원이
 * 아니라 15개 **이산** 좌표(정수 반올림, `@shared/sim/spawn`
 * `buildSpawnPoints` 참고)라 원점 거리만으로는 실제 최소 간극을 알 수
 * 없다 — 이 파일이 15개 좌표 × 전체 차단 지오메트리 전수 조합의 **실제
 * 최근접 거리**(점-AABB 최단거리, 열린/닫힌 구간 구분 없이 가장 보수적인
 * 유클리드 거리)를 계산해 확인한다.
 *
 * **이 파일이 `stepMovement`를 호출하지 않는 이유**: 이 명제는
 * `clampAgainstWalls`의 판정 **로직**이 아니라, 스폰 좌표·지오메트리
 * 좌표라는 **데이터** 자체가 반경 도입과 양립하는지를 묻는다 — 순수
 * 기하 계산으로 답이 결정되고, 이동 판정 함수의 구현(반경을 도입했는지
 * 여부)과 무관하다. 그래서 이 테스트는 movement.ts에 반경이 아직
 * 없더라도(오늘 기준) 결과가 달라지지 않는다 — **Red가 아니라 사전
 * 측정**이다(아래 결과를 보고서에 그대로 옮긴다, 억지로 실패시키지
 * 않는다는 지시를 따른다).
 *
 * **좌표(ADR-0010 — 리터럴 금지)**: `SPAWN_POINTS`·`PRODUCTION_WALLS`·
 * `PRODUCTION_BOXES`·`PRODUCTION_PLATFORMS` 정본을 그대로 읽는다. 사다리
 * (`PRODUCTION_LADDERS`)는 제외한다 — 사다리는 `clampAgainstWalls`에 전혀
 * 주입되지 않는 볼륨(진입 지점)이라 반경 기반 "차단"의 대상이 아니다
 * (`@shared/sim/movement`의 `stepMovement` docblock, `findLadderAt`이
 * 별도 경로로 처리).
 *
 * **결정론(ADR-0008)**: 순수 산술, `Math.random()`·`Date.now()` 없음 —
 * 정적 배열의 전수 조합만 순회한다.
 */

const BODY_RADIUS_M = DEFAULT_HITBOX.bodyRadiusM

/** 점 `(x,z)`에서 축 정렬 상자(벽·박스·플랫폼 공통 형태)까지의 최단
 * 유클리드 거리 — 점이 상자 내부에 있으면 0(닫힌 구간 기준, 열린/닫힌
 * 구분이 결과를 좌우할 만큼 근접한 경우가 없어 가장 단순한 형태를
 * 쓴다). */
function closestDistanceToAABB(point: { x: number; z: number }, box: WallAABB | BoxAABB): number {
  const clampedX = Math.max(box.minX, Math.min(point.x, box.maxX))
  const clampedZ = Math.max(box.minZ, Math.min(point.z, box.maxZ))
  return Math.hypot(point.x - clampedX, point.z - clampedZ)
}

interface LabeledGeometry {
  label: string
  box: WallAABB | BoxAABB
}

const BLOCKING_GEOMETRY: LabeledGeometry[] = [
  ...PRODUCTION_WALLS.map((box, i): LabeledGeometry => ({ label: `WALL#${i}`, box })),
  ...PRODUCTION_BOXES.map((box, i): LabeledGeometry => ({ label: `BOX#${i}`, box })),
  ...PRODUCTION_PLATFORMS.map((box, i): LabeledGeometry => ({ label: `PLATFORM#${i}`, box })),
]

describe('24af 명제 3(실측) — 모든 스폰이 모든 차단 지오메트리(벽·박스·플랫폼)에서 bodyRadiusM 이상 떨어져 있다', () => {
  // 공허 통과 방지 — 두 목록 다 비어있지 않아야 아래 전수 순회가 의미를 갖는다.
  it('전제 확인 — SPAWN_POINTS·차단 지오메트리 목록이 비어있지 않다', () => {
    expect(SPAWN_POINTS.length).toBeGreaterThan(0)
    expect(BLOCKING_GEOMETRY.length).toBeGreaterThan(0)
  })

  it.each(SPAWN_POINTS.map((point, index) => ({ ...point, index })))(
    '24af/RQ-31: 스폰#$index($x,$z)는 모든 벽·박스·플랫폼에서 bodyRadiusM(0.3m) 이상 떨어져 있다',
    (spawn) => {
      for (const geo of BLOCKING_GEOMETRY) {
        const distance = closestDistanceToAABB(spawn, geo.box)
        expect(distance, `스폰#${spawn.index}(${spawn.x},${spawn.z}) vs ${geo.label}`).toBeGreaterThanOrEqual(BODY_RADIUS_M)
      }
    },
  )

  it('실측 요약(보고서용) — 전수 조합 중 전역 최소 간극과 그 지점을 기록한다', () => {
    let minDistance = Infinity
    let minAt = ''
    for (const point of SPAWN_POINTS) {
      for (const geo of BLOCKING_GEOMETRY) {
        const distance = closestDistanceToAABB(point, geo.box)
        if (distance < minDistance) {
          minDistance = distance
          minAt = `(${point.x},${point.z}) vs ${geo.label}`
        }
      }
    }
    // eslint-disable-next-line no-console -- 실측 결과를 Red 보고서에 그대로 옮기기 위한 의도적 출력.
    console.log(`[24af 명제3 실측] 전역 최소 간극 = ${minDistance}m @ ${minAt} (bodyRadiusM=${BODY_RADIUS_M}m)`)
    expect(minDistance).toBeGreaterThanOrEqual(BODY_RADIUS_M)
  })
})
