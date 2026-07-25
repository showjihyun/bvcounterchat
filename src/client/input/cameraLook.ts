import type { Object3D } from 'three'

/**
 * yaw/pitch를 **카메라에 적용하는 단 하나의 지점**(22b, 리뷰 major 2 →
 * 델타 재평가 지적 반영).
 *
 * 왜 함수로 뽑았는가: 이 두 줄이 `PlayerControls.tsx`(렌더 계층, `fe.md`상
 * 테스트 면제) 안에 인라인으로 있으면 "조준 벡터(`yawPitchToDirection`)와
 * 실제 카메라 방향이 같다"는 계약을 **어떤 테스트도 붙잡지 못한다** — 회귀
 * 가드 테스트가 같은 두 줄을 복제해 자기 사본만 검사하게 되고, 정작 배선을
 * 바꾸면(회전 순서 삭제·인자 뒤바꿈) 테스트는 전부 초록으로 남는다(평가
 * 세션이 변이 6종으로 실증). 배선과 테스트가 **같은 함수**를 호출해야
 * 그 변경이 테스트에 도달한다.
 *
 * 좌표계 계약은 `@client/input/aimMath` 상단 코멘트가 정본이다 — Euler
 * 순서 'YXZ'(먼저 yaw(Y축), 그다음 pitch(X축))로 적용해야
 * `yawPitchToDirection(yaw, pitch)`가 카메라 정면과 일치한다. 순서나 인자를
 * 바꾸면 화면 중앙과 서버 판정 레이(RQ-12)가 갈라진다.
 *
 * `Object3D`를 받는다(카메라도 `Object3D`다) — three의 카메라 타입 전체가
 * 아니라 회전만 쓰므로 최소 계약이다. 새 객체를 만들지 않아
 * `useFrame`에서 매 프레임 호출해도 프레임 예산(`fe.md`)에 영향이 없다.
 */
export function applyLookToCamera(camera: Object3D, yaw: number, pitch: number): void {
  camera.rotation.order = 'YXZ'
  camera.rotation.set(pitch, yaw, 0)
}
