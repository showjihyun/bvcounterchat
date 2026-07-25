/**
 * 마우스 룩(yaw/pitch) 순수 산술 — 조준 방향 벡터·이동 입력 회전·pitch
 * 클램프·yaw 누적 (22b, RQ-12 클라 측, ADR-0011 test-after — coder가
 * 구현+테스트를 함께 작성한다). DOM·three.js·네트워크에 의존하지 않는다
 * — 좌표계만 호출자와 맞으면 된다. `tests/unit/22b-aim-math.test.ts`가
 * 단위 테스트를 담당한다(렌더 계층 면제 대상이 아니다 — 순수 함수라
 * `harness/workflow/fe.md`의 면제 범위 밖).
 *
 * **좌표계 관례**(three.js 기본축과 `@client/input/cameraLook`의
 * `applyLookToCamera`가 카메라에 적용하는 방식(Euler order='YXZ',
 * `set(pitch, yaw, 0)`)과 반드시 같아야 조준 방향과 화면에 보이는 방향이
 * 일치한다 — 그 일치는 `tests/unit/22b-aim-camera-binding.test.ts`가
 * 두 쪽을 같은 함수로 묶어 강제한다):
 * yaw=0·pitch=0일 때 정면은 -Z(three.js 카메라 기본 정면). yaw는 +Y축
 * 기준 회전이며, 마우스를 오른쪽으로 움직이면(`movementX`>0) yaw가
 * **감소**한다 — `accumulateLook` 참고. pitch는 위를 보면 증가(+),
 * 아래를 보면 감소(-). 이 파일의 모든 각도는 라디안이다.
 */

export interface LookAngles {
  yaw: number
  pitch: number
}

export interface AimDirection {
  dirX: number
  dirY: number
  dirZ: number
}

export interface LocalMoveDirection {
  dirX: number
  dirZ: number
}

/**
 * 짐벌 뒤집힘 방지 한계(라디안, ≈89°) — 정확히 ±90°(π/2)에 닿으면 카메라가
 * 완전한 수직을 보게 되어 그 순간 yaw축(좌우 회전 기준)이 정의를 잃는다
 * (`camera.rotation.set(pitch, yaw, 0)`의 순간 자세가 특이점에 놓인다).
 * π/2보다 1° 작은 값에서 멈춰 이 특이점에 닿지 않는다.
 */
export const PITCH_LIMIT_RAD = (89 * Math.PI) / 180

/**
 * pitch를 [-PITCH_LIMIT_RAD, +PITCH_LIMIT_RAD]로 클램프한다. 유한하지
 * 않은 값(NaN·Infinity)은 0(수평)으로 취급한다 —
 * `@shared/sim/movement`의 `clampDirection`(RQ-61 방어적 입력 처리)과
 * 동일한 관례를 따른다.
 */
export function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 0
  return Math.max(-PITCH_LIMIT_RAD, Math.min(PITCH_LIMIT_RAD, pitch))
}

const TWO_PI = Math.PI * 2

/**
 * yaw를 (-π, π] 범위로 정규화한다. sin/cos 자체는 각도 범위 제약이 없지만
 * (주기 함수라 결과는 어떤 yaw 값에도 올바르다), 마우스를 한 방향으로
 * 계속 돌리면 yaw가 무한히 누적될 수 있어 `accumulateLook`이 매 호출 이
 * 함수로 되접는다 — 부동소수점 정밀도 저하를 방지하는 위생 조치다. 유한
 * 하지 않은 값은 0으로 취급한다.
 */
export function normalizeYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0
  let result = yaw % TWO_PI
  if (result > Math.PI) result -= TWO_PI
  else if (result <= -Math.PI) result += TWO_PI
  return result
}

/**
 * yaw/pitch → 정규화된 조준 방향 벡터(발사 페이로드용 — `GameRoom
 * .handleFire`가 그대로 레이 방향에 쓴다, `FireInput` 계약과 동일한 필드명).
 *
 * Euler(order='YXZ')로 카메라 정면 (0,0,-1)을 yaw(Y축) 다음 pitch(X축)
 * 순서로 회전한 결과를 구면좌표 대입식으로 직접 유도했다 — 벡터·행렬
 * 연산 없이 삼각함수 4회로 계산한다(발사 시점에만 호출되므로 프레임
 * 예산과는 무관하지만, 어차피 가장 단순한 형태다).
 *
 * 도출: forward = Ry(yaw) · Rx(pitch) · (0,0,-1)
 *   Rx(pitch)·(0,0,-1) = (0, sin(pitch), -cos(pitch))
 *   Ry(yaw)·(0, sin(pitch), -cos(pitch))
 *     = (-sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch))
 *
 * sin²+cos²=1 항등식으로 결과는 항상(부동소수점 오차 제외) 단위 벡터다
 * — 별도 정규화 스텝이 필요 없다.
 */
export function yawPitchToDirection(yaw: number, pitch: number): AimDirection {
  const cosPitch = Math.cos(pitch)
  return {
    dirX: -Math.sin(yaw) * cosPitch,
    dirY: Math.sin(pitch),
    dirZ: -Math.cos(yaw) * cosPitch,
  }
}

/**
 * 로컬(캐릭터 기준: dirZ=전진, dirX=오른쪽 — `movementInput.ts`의 WASD
 * 산출 그대로) 방향 입력을 yaw만큼 회전해 월드축 방향으로 변환한다.
 * 이동은 pitch를 무시한다 — 위아래를 봐도 이동 평면은 수평이다(RQ-20
 * 평지 이동 전제).
 *
 * `yawPitchToDirection(yaw, 0)`이 주는 전진 벡터(forward, xz 평면
 * 투영)와, 그것을 +Y축 기준 -90° 돌린 오른쪽 벡터(right)의 선형결합이다:
 *   forward(yaw) = (-sin(yaw), -cos(yaw))
 *   right(yaw)   = (cos(yaw), -sin(yaw))
 *   world = local.dirZ · forward + local.dirX · right
 *
 * 회전(직교 변환)은 크기를 보존한다 — 대각 입력(예: W+D, 크기 √2)은
 * 회전 후에도 크기 √2를 유지한다. 정규화·클램프는 이 함수의 책임이
 * 아니다 — `@shared/sim/movement`의 `stepMovement`(`clampDirection`)가
 * 서버·클라이언트 예측(RQ-62) 양쪽에서 이미 클램프한다. 여기서 다시
 * 클램프하면 이중 클램프로 계약이 갈라진다(ADR-0010 값 복제 금지와 같은
 * 정신 — 로직도 한 곳에서만).
 */
export function rotateLocalMoveDirection(local: LocalMoveDirection, yaw: number): LocalMoveDirection {
  const sinYaw = Math.sin(yaw)
  const cosYaw = Math.cos(yaw)
  return {
    dirX: local.dirZ * -sinYaw + local.dirX * cosYaw,
    dirZ: local.dirZ * -cosYaw + local.dirX * -sinYaw,
  }
}

/**
 * 마우스 이동량(px)을 yaw/pitch 누적에 반영한다. DOM 이벤트 리스닝 자체는
 * 호출자(`@client/input/mouseLook`) 책임 — 이 함수는 순수하다(같은
 * 입력이면 항상 같은 출력).
 *
 * 부호 관례(위 파일 코멘트 좌표계 참고, three.js 커뮤니티 표준 FPS 룩
 * 구현과 동일): `movementX` 양수(마우스 오른쪽 이동)면 yaw가 **감소**해
 * 시야가 오른쪽으로 돈다. `movementY` 양수(마우스 아래 이동 — 브라우저
 * 좌표는 아래로 갈수록 증가)면 pitch가 감소해 시야가 아래로 향한다(마우스
 * 위로 올리면 위를 본다 — Y축 반전 없음이 기본값).
 */
export function accumulateLook(
  current: LookAngles,
  movementX: number,
  movementY: number,
  sensitivityRadPerPx: number,
): LookAngles {
  return {
    yaw: normalizeYaw(current.yaw - movementX * sensitivityRadPerPx),
    pitch: clampPitch(current.pitch - movementY * sensitivityRadPerPx),
  }
}
