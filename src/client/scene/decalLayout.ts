import * as THREE from 'three'
import type { Vec3 } from '@shared/sim/combat'
import type { HitFeedbackState } from '@client/effects/hitFeedback'
import { EFFECTS } from '@shared/constants'

/**
 * RQ-70(탄흔)·RQ-71(피격 효과) 2/2 — **렌더 배선의 판정 가능한 절반**
 * (ADR-0016 결정 4 "렌더 배선"은 단위 테스트 면제이지만, 그 면제는
 * `useFrame`이 이 함수들을 실제로 부르는가에만 걸린다). 법선 정렬 산술
 * (`decalOrientation`/`decalPosition`)과 컬렉션→인스턴스 카운트 환산
 * (`syncDecalInstances`)은 픽셀이 아니라 값으로 단언 가능하다 —
 * `tests/unit/rq-70-71-decal-layout.test.ts`(GA-112·GA-113)가 그 값을 고정한다.
 *
 * `THREE.InstancedMesh` 타입을 직접 요구하지 않는다 — `DecalInstanceSink`가
 * 그 최소 구조적 인터페이스만 요구한다. 렌더러 없이 헤드리스로 "몇 개가
 * 실제로 그려지는가"를 단언할 수 있게 하는 것이 이 설계의 요점(`22b-aim-
 * camera-binding.test.ts`와 동일한 정신 — 픽셀이 아니라 순수 수학만 본다).
 *
 * 렌더 배선(`HitDecals.tsx`)은 이 모듈의 함수를 `useFrame` 안에서 호출만
 * 한다 — `InstancedMesh` 생성·마운트·색/크기 토큰은 그쪽 책임이다.
 */

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

function vecLength(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z)
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = vecLength(v)
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

/**
 * 평면의 기본 법선 +Z(0,0,1)를 `normal` 방향(정규화 후)으로 보내는 최단
 * 회전. three.js `Quaternion.setFromUnitVectors(vFrom, vTo)`와 동일한
 * 산술을 `vFrom=(0,0,1)`로 고정해 특수화한 것 — 결과는 그 함수와
 * 수학적으로 동일하지만, `THREE.Vector3`/`THREE.Quaternion` 객체를
 * 할당하지 않고 순수 숫자 연산만으로 낸다. `syncDecalInstances`가 인스턴스
 * (탄흔·피격 효과)마다 이 함수를 부르므로(ADR-0001) THREE 객체를 만들지
 * 않는 편이 프레임 예산에 유리하다.
 *
 * `normal`이 정확히 -Z인 특이점(`(0,0,1)`과 `n`의 외적이 0벡터가 되어
 * 회전축을 못 구하는 지점)에서는 three.js의 폴백 분기와 동일하게 임의의
 * 수직축(여기서는 Y축)으로 180도 회전한 유한한 값을 낸다 — NaN/Infinity가
 * 나오지 않는다.
 */
export function decalOrientation(normal: Vec3): Quat {
  const n = normalizeVec3(normal)
  // (0,0,1)·n = n.z
  const r = n.z + 1
  let x: number
  let y: number
  let z: number
  let w: number
  if (r < Number.EPSILON) {
    // 특이점 — cross((0,0,1), n) ≈ 0벡터라 축을 외적으로 구할 수 없다.
    // three.js `setFromUnitVectors`의 폴백과 동일한 값: |vFrom.x|(0) <=
    // |vFrom.z|(1)이므로 (0, -vFrom.z, vFrom.y, 0) = (0, -1, 0, 0) —
    // Y축 기준 180도 회전(어떤 수직축이든 180도 회전이면 충분하다).
    x = 0
    y = -1
    z = 0
    w = 0
  } else {
    // cross((0,0,1), n) = (0*n.z - 1*n.y, 1*n.x - 0*n.z, 0*n.y - 0*n.x) = (-n.y, n.x, 0)
    x = -n.y
    y = n.x
    z = 0
    w = r
  }
  const len = Math.hypot(x, y, z, w)
  return { x: x / len, y: y / len, z: z / len, w: w / len }
}

/**
 * `point`에서 정규화된 `normal` 방향으로만 `offsetM`만큼 이동한 위치.
 * 접선(법선에 수직인) 방향 성분은 0이다 — 데칼이 표면에서 살짝 떠서
 * z-fighting을 피하되 옆으로는 밀리지 않는다.
 */
export function decalPosition(point: Vec3, normal: Vec3, offsetM: number): Vec3 {
  const n = normalizeVec3(normal)
  return {
    x: point.x + n.x * offsetM,
    y: point.y + n.y * offsetM,
    z: point.z + n.z * offsetM,
  }
}

/** 실 `THREE.InstancedMesh`가 구조적으로 만족하는 최소 인터페이스. */
export interface DecalInstanceSink {
  setMatrixAt(index: number, matrix: THREE.Matrix4): void
  count: number
  instanceMatrix: { needsUpdate: boolean }
}

/**
 * 프레임 예산(ADR-0001) — `syncDecalInstances`가 매 프레임(`useFrame`)
 * 재사용할 스크래치 버퍼. 호출자가 `createDecalScratch()`로 한 번 만들어
 * 계속 넘긴다. `matrix`는 인스턴스마다 같은 참조로 `setMatrixAt`에
 * 넘어간다 — 인스턴스 개수만큼 `new THREE.Matrix4()`를 만들지 않는다.
 */
export interface DecalSyncScratch {
  matrix: THREE.Matrix4
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  /** 데칼은 스케일을 쓰지 않는다(항등 고정) — `Matrix4.compose()`가
   * 요구하는 필수 인자라 스크래치에 함께 둔다. */
  scale: THREE.Vector3
}

export function createDecalScratch(): DecalSyncScratch {
  return {
    matrix: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(1, 1, 1),
  }
}

export interface SyncDecalInstancesOptions {
  offsetM: number
  scratch: DecalSyncScratch
}

/**
 * `items`를 `sink`로 옮긴다 — 최대 `capacity`개(`Infinity`면 무제한).
 * `EFFECTS.BULLET_HOLE_CAP`(탄흔)과 "상한 없음"(피격 효과, `Infinity`)을
 * 같은 함수로 표현해 두 sink를 대칭적으로 다룬다. 인스턴스마다
 * `scratch.matrix`(단일 참조)를 다시 `.compose()`해 `setMatrixAt`에
 * 넘긴다 — 인스턴스 수만큼 `new THREE.Matrix4()`를 만들지 않는다.
 */
function writeInstances(
  items: readonly { point: Vec3; normal: Vec3 }[],
  sink: DecalInstanceSink,
  offsetM: number,
  scratch: DecalSyncScratch,
  capacity: number,
): void {
  const count = Math.min(items.length, capacity)
  for (let i = 0; i < count; i += 1) {
    const item = items[i]!
    const position = decalPosition(item.point, item.normal, offsetM)
    const orientation = decalOrientation(item.normal)
    scratch.position.set(position.x, position.y, position.z)
    scratch.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w)
    scratch.matrix.compose(scratch.position, scratch.quaternion, scratch.scale)
    sink.setMatrixAt(i, scratch.matrix)
  }
  sink.count = count
  // 컬렉션이 이전 프레임보다 줄어든 경우(만료로 피격 효과가 사라짐)에도
  // GPU 쪽 그리기 범위가 갱신돼야 한다 — 빈 호출(count=0)에서도 true.
  sink.instanceMatrix.needsUpdate = true
}

/**
 * `state.bulletHoles`/`state.hitEffects`를 각각 `sinks.bulletHoles`/
 * `sinks.hitEffects`로 옮긴다. 인스턴스 i의 위치는
 * `decalPosition(item.point, item.normal, options.offsetM)`, 회전은
 * `decalOrientation(item.normal)`로 유도한다.
 *
 * 탄흔은 `EFFECTS.BULLET_HOLE_CAP`(64)을 **방어적으로** 넘지 않는다 —
 * `applyHitEvent`(`@client/effects/hitFeedback`)가 이미 그 이하로 자르지만,
 * forged 상태가 들어와도 `setMatrixAt`이 GPU 버퍼 밖(고정 용량 64)을 쓰지
 * 않도록 이 층도 같은 상한을 스스로 지킨다.
 *
 * ⚠️ **피격 효과에는 이 함수 층에서 어떤 개수 상한도 두지 않는다**
 * (ADR-0016 결정 2 — 상한을 두면 RQ-71 위반). `sinks.hitEffects`(실
 * `InstancedMesh`)가 실제로 감당할 수 있는 최대 개수(GPU 버퍼 용량)는 이
 * 함수의 관심사가 아니다 — **용량과 제거 규칙은 다른 축이다**
 * (`harness/workflow/fe.md` "효과 처리"). 그 용량을 얼마로 잡고, 넘치지
 * 않게 방어할지는 호출자(`HitDecals.tsx`)의 책임이다.
 */
export function syncDecalInstances(
  state: Pick<HitFeedbackState, 'bulletHoles' | 'hitEffects'>,
  sinks: { bulletHoles: DecalInstanceSink; hitEffects: DecalInstanceSink },
  options: SyncDecalInstancesOptions,
): void {
  writeInstances(state.bulletHoles, sinks.bulletHoles, options.offsetM, options.scratch, EFFECTS.BULLET_HOLE_CAP)
  writeInstances(state.hitEffects, sinks.hitEffects, options.offsetM, options.scratch, Infinity)
}
