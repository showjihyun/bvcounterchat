import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { PITCH_LIMIT_RAD, yawPitchToDirection } from '@client/input/aimMath'

/**
 * 22b — **조준 벡터 ↔ 실제 카메라 방향 회귀 가드** (리뷰 major 2 대응).
 *
 * `PlayerControls.tsx`는 카메라를 두 줄로 조작한다:
 *   camera.rotation.order = 'YXZ'      // :55
 *   camera.rotation.set(pitch, yaw, 0) // :106
 * 그리고 발사는 `yawPitchToDirection(yaw, pitch)`를 서버로 보낸다(:76).
 * 이 셋이 일치해야 "화면 중앙에 보이는 것 = 서버가 판정하는 것"(RQ-12 +
 * RQ-54)이 성립한다. 그런데 렌더 계층(`PlayerControls.tsx`)은 `fe.md`상
 * 테스트 면제라, 이 일치는 지금까지 **주석으로만** 유지됐다 — 누가
 * `rotation.order` 줄을 지우거나 `set(yaw, pitch, 0)`로 인자 순서를 바꿔도
 * 기존 테스트는 전부 초록이고 typecheck·lint도 통과한다.
 *
 * 이 파일은 그 두 줄을 **그대로 재현해** three.js가 계산한 실제 정면 벡터와
 * 순수 함수의 출력을 대조한다. 배선이 바뀌면 이 테스트도 함께 고쳐야 하고,
 * 그 순간 사람이 정합을 다시 판단하게 된다 — 그것이 이 가드의 목적이다.
 *
 * three.js `PerspectiveCamera`의 회전·행렬 계산은 WebGL 컨텍스트 없이
 * 헤드리스로 돈다(ADR-0008 §6의 "렌더링 결과는 테스트하지 않는다"에
 * 저촉되지 않는다 — 픽셀이 아니라 순수 수학만 본다).
 */

/** `PlayerControls.tsx:55`·`:106`이 하는 일을 그대로 재현한다. */
function cameraForwardAt(yaw: number, pitch: number): THREE.Vector3 {
  const camera = new THREE.PerspectiveCamera()
  camera.rotation.order = 'YXZ'
  camera.rotation.set(pitch, yaw, 0)
  camera.updateMatrixWorld(true)
  const forward = new THREE.Vector3()
  camera.getWorldDirection(forward)
  return forward
}

describe('22b 조준-카메라 결합 — 발사 방향은 화면 정면과 같다', () => {
  it('yaw·pitch 격자 전역에서 yawPitchToDirection이 카메라 정면과 일치한다', () => {
    for (let yawStep = -8; yawStep <= 8; yawStep += 1) {
      for (let pitchStep = -4; pitchStep <= 4; pitchStep += 1) {
        const yaw = (yawStep / 8) * Math.PI
        const pitch = (pitchStep / 4) * PITCH_LIMIT_RAD
        const forward = cameraForwardAt(yaw, pitch)
        const aim = yawPitchToDirection(yaw, pitch)
        expect(aim.dirX).toBeCloseTo(forward.x, 10)
        expect(aim.dirY).toBeCloseTo(forward.y, 10)
        expect(aim.dirZ).toBeCloseTo(forward.z, 10)
      }
    }
  })

  it('회전 순서(YXZ)에 실제로 의존한다 — 순서가 바뀌면 갈라진다 (가드가 살아 있음을 증명)', () => {
    // 이 테스트가 "무엇이든 통과시키는" 동어반복이 아님을 보인다: 같은
    // 각도라도 Euler 순서가 다르면 정면 벡터가 달라지고, 그때는 위 단언이
    // 깨져야 한다. yaw·pitch가 둘 다 0이 아닌 조합에서만 차이가 난다.
    const yaw = 0.7
    const pitch = 0.4
    const wrongOrder = new THREE.PerspectiveCamera()
    wrongOrder.rotation.order = 'XYZ' // PlayerControls가 쓰는 순서가 아니다
    wrongOrder.rotation.set(pitch, yaw, 0)
    wrongOrder.updateMatrixWorld(true)
    const wrongForward = new THREE.Vector3()
    wrongOrder.getWorldDirection(wrongForward)

    const aim = yawPitchToDirection(yaw, pitch)
    const deviation = Math.hypot(aim.dirX - wrongForward.x, aim.dirY - wrongForward.y, aim.dirZ - wrongForward.z)
    expect(deviation).toBeGreaterThan(0.01)
  })

  it('인자 순서를 뒤집으면(set(yaw, pitch, 0)) 갈라진다 — 흔한 실수를 실제로 잡는다', () => {
    const yaw = 0.7
    const pitch = 0.4
    const swapped = new THREE.PerspectiveCamera()
    swapped.rotation.order = 'YXZ'
    swapped.rotation.set(yaw, pitch, 0) // 인자 순서 실수 재현
    swapped.updateMatrixWorld(true)
    const swappedForward = new THREE.Vector3()
    swapped.getWorldDirection(swappedForward)

    const aim = yawPitchToDirection(yaw, pitch)
    const deviation = Math.hypot(
      aim.dirX - swappedForward.x,
      aim.dirY - swappedForward.y,
      aim.dirZ - swappedForward.z,
    )
    expect(deviation).toBeGreaterThan(0.01)
  })
})
