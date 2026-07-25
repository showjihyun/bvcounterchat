import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { PITCH_LIMIT_RAD, yawPitchToDirection } from '@client/input/aimMath'
import { applyLookToCamera } from '@client/input/cameraLook'

/**
 * 22b — **조준 벡터 ↔ 실제 카메라 방향 회귀 가드** (리뷰 major 2 대응,
 * 델타 재평가 지적 반영).
 *
 * 지키는 계약: 발사 페이로드로 보내는 `yawPitchToDirection(yaw, pitch)`가
 * 화면 정면과 **같은 벡터**여야 한다. 이것이 깨지면 크로스헤어가 가리키는
 * 곳과 서버가 판정하는 곳(RQ-12 hitscan)이 갈라지는데, 렌더 계층은
 * `harness/workflow/fe.md`상 테스트 면제라 아무 게이트에도 걸리지 않는다.
 *
 * **왜 `applyLookToCamera`를 임포트하는가**: 초판은 `PlayerControls.tsx`의
 * 카메라 조작 두 줄을 이 파일에 *복제*해 검사했는데, 평가 세션이 변이
 * 6종(회전 순서 삭제·인자 뒤바꿈 등)을 심어 **전부 생존**함을 실증했다 —
 * 테스트가 자기 사본만 보고 있어 실제 배선이 바뀌어도 초록이었다. 지금은
 * 배선(`PlayerControls`)과 이 테스트가 **같은 함수**를 호출하므로, 그
 * 함수가 바뀌면 이 테스트에 도달한다.
 *
 * three.js `PerspectiveCamera`의 회전·행렬 계산은 WebGL 컨텍스트 없이
 * 헤드리스로 돈다(ADR-0008 §6의 "렌더링 결과는 테스트하지 않는다"에
 * 저촉되지 않는다 — 픽셀이 아니라 순수 수학만 본다).
 */

function forwardAfterApply(yaw: number, pitch: number): THREE.Vector3 {
  const camera = new THREE.PerspectiveCamera()
  applyLookToCamera(camera, yaw, pitch) // 배선이 쓰는 바로 그 함수
  camera.updateMatrixWorld(true)
  const forward = new THREE.Vector3()
  camera.getWorldDirection(forward)
  return forward
}

function deviationFrom(forward: THREE.Vector3, yaw: number, pitch: number): number {
  const aim = yawPitchToDirection(yaw, pitch)
  return Math.hypot(aim.dirX - forward.x, aim.dirY - forward.y, aim.dirZ - forward.z)
}

describe('22b 조준-카메라 결합 — 발사 방향은 화면 정면과 같다', () => {
  it('yaw·pitch 격자 전역에서 applyLookToCamera 결과가 yawPitchToDirection과 일치한다', () => {
    for (let yawStep = -8; yawStep <= 8; yawStep += 1) {
      for (let pitchStep = -4; pitchStep <= 4; pitchStep += 1) {
        const yaw = (yawStep / 8) * Math.PI
        const pitch = (pitchStep / 4) * PITCH_LIMIT_RAD
        const forward = forwardAfterApply(yaw, pitch)
        const aim = yawPitchToDirection(yaw, pitch)
        expect(aim.dirX).toBeCloseTo(forward.x, 10)
        expect(aim.dirY).toBeCloseTo(forward.y, 10)
        expect(aim.dirZ).toBeCloseTo(forward.z, 10)
      }
    }
  })

  it('회전 순서에 실제로 의존한다 — YXZ가 아니면 갈라진다 (단언에 이빨이 있음을 증명)', () => {
    // 이 테스트가 "무엇이든 통과시키는" 동어반복이 아님을 보인다: 같은
    // 각도라도 Euler 순서가 다르면 정면 벡터가 달라진다. 즉 위 단언은
    // `applyLookToCamera`가 순서를 잘못 두면 실패한다.
    const yaw = 0.7
    const pitch = 0.4
    const wrongOrder = new THREE.PerspectiveCamera()
    wrongOrder.rotation.order = 'XYZ'
    wrongOrder.rotation.set(pitch, yaw, 0)
    wrongOrder.updateMatrixWorld(true)
    const wrongForward = new THREE.Vector3()
    wrongOrder.getWorldDirection(wrongForward)

    expect(deviationFrom(wrongForward, yaw, pitch)).toBeGreaterThan(0.01)
  })

  it('인자 순서를 뒤집으면 갈라진다 — 흔한 실수가 위 단언에 실제로 걸린다', () => {
    const yaw = 0.7
    const pitch = 0.4
    const swapped = new THREE.PerspectiveCamera()
    swapped.rotation.order = 'YXZ'
    swapped.rotation.set(yaw, pitch, 0) // set(pitch, yaw, 0)이어야 한다
    swapped.updateMatrixWorld(true)
    const swappedForward = new THREE.Vector3()
    swapped.getWorldDirection(swappedForward)

    expect(deviationFrom(swappedForward, yaw, pitch)).toBeGreaterThan(0.01)
  })

  it('회전 순서를 매번 고정한다 — 이전에 다른 순서로 오염된 카메라도 교정한다', () => {
    // `applyLookToCamera`가 order를 함께 설정하지 않고 위치만 바꾸면(예:
    // 초기화 이펙트로 한 번만 설정하는 구조로 되돌아가면) R3F·three 기본값
    // 변경이나 외부 코드의 order 변경이 조용히 조준을 틀어놓는다.
    const camera = new THREE.PerspectiveCamera()
    camera.rotation.order = 'ZXY' // 외부에서 오염된 상태를 가정
    applyLookToCamera(camera, 0.7, 0.4)
    camera.updateMatrixWorld(true)
    const forward = new THREE.Vector3()
    camera.getWorldDirection(forward)

    expect(deviationFrom(forward, 0.7, 0.4)).toBeLessThan(1e-10)
  })
})
