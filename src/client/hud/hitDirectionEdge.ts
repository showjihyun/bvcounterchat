import { rotateLocalMoveDirection, yawPitchToDirection } from '@client/input/aimMath'
import type { Vec3 } from '@shared/sim/combat'

/**
 * RQ-58 피격 방향(원장 24cv) — 이벤트의 표면 법선과 **피격자 자신의** 카메라
 * yaw만으로 화면 가장자리 하나를 고른다.
 *
 * **판단을 순수 모듈로 분리한다**(`harness/workflow/fe.md` — 렌더는
 * ADR-0008 §6으로 면제되지만 "어느 가장자리인가"는 산술이고 그것은
 * 테스트할 수 있다. `@client/hud/crosshairSpread`·`@client/hud
 * /nameplateTarget`이 선례다).
 *
 * ⚠️ **좌표 재구성 금지(ADR-0016 결정 1)** — 이 함수의 입력에 "사수 위치"가
 * 아예 없다는 것 자체가 그 금지의 구조적 보장이다. 받는 것은 `normal`
 * (서버가 보낸 값을 그대로, 재계산 없음)과 `cameraYaw`(피격자 **자신의**
 * 로컬 입력 — 네트워크로 오지 않는다, `mouseLook.getAngles().yaw`) 둘뿐이다.
 * 사수가 이동 중이어도 이 두 값은 이동과 무관하다 — RQ-58 golden(GA-123)이
 * "명중 순간의 사수 좌표와 이벤트 도착 시점의 사수 좌표가 다르다"는 조건을
 * 굳이 두는 이유가 이 무관함을 실증하기 위해서다.
 *
 * **`normal`이 대략 "피격자→사수" 방향인 이유**: `@shared/sim/combat`의
 * `raycastHitbox`가 `normal`을 "명중점(대상 중심 기준 로컬 좌표)"에서
 * 유도한다 — 바디는 원통 측면의 방사 방향, 헤드는 구체 중심에서 명중점
 * 방향. 레이는 사수 쪽에서 들어와 대상의 **사수를 향한 면**을 먼저
 * 통과하므로, 그 표면의 바깥쪽 법선은 근사적으로 사수 쪽을 가리킨다. 이
 * 함수는 그 근사를 그대로 받아 쓴다 — 더 정밀하게 다듬지 않는다(RQ-58
 * "정밀 각도를 주지 않는다"와 같은 근거, 완화가 아니라 출처의 성질이다).
 *
 * **카메라 좌표계**: `@client/input/aimMath`의 관례를 그대로 따른다 — 새
 * 삼각함수를 다시 적지 않고 그 파일의 `yawPitchToDirection`(카메라 정면)과
 * `rotateLocalMoveDirection`(로컬 오른쪽 `(1,0)`을 yaw로 회전한 값 = 카메라
 * 오른쪽 벡터, `movementInput.ts`가 이미 세운 `right(yaw) = (cos(yaw),
 * -sin(yaw))`와 동일한 산술)을 재사용한다.
 *
 * **가장자리 선택**: `normal`을 정면·오른쪽 두 축에 투영해(수평만 —
 * `y` 성분은 쓰지 않는다, 화면 가장자리 표시가 위아래 성분까지 정밀하게
 * 구분할 근거가 없다) 절댓값이 더 큰 축을 고르고 부호로 가장자리를
 * 정한다 — "정밀 각도"가 아니라 **네 구획 중 하나**이므로 8방위 화살표
 * (기각됨, RQ-58)와 다르다. "정면에서 맞음 → 화면 위쪽 가장자리",
 * "후방에서 맞음 → 아래쪽 가장자리"로 매핑했다 — 스펙 근거는 없는 coder
 * 선택값(좌우는 RQ-58 golden GA-123이 직접 요구하는 축이라 자명하지만,
 * 전후→상하 매핑 자체는 스펙이 정하지 않은 렌더 선택이다).
 */
export type HitDirectionEdge = 'top' | 'right' | 'bottom' | 'left'

export function deriveHitDirectionEdge(normal: Vec3, cameraYaw: number): HitDirectionEdge {
  const forward = yawPitchToDirection(cameraYaw, 0)
  const right = rotateLocalMoveDirection({ dirX: 1, dirZ: 0 }, cameraYaw)

  const forwardComponent = normal.x * forward.dirX + normal.z * forward.dirZ
  const rightComponent = normal.x * right.dirX + normal.z * right.dirZ

  if (Math.abs(rightComponent) >= Math.abs(forwardComponent)) {
    return rightComponent > 0 ? 'right' : 'left'
  }
  return forwardComponent > 0 ? 'top' : 'bottom'
}
