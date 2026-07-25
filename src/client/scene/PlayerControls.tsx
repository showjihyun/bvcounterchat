import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { StoreApi } from 'zustand/vanilla'
import type { GameStoreState } from '@client/store/gameStore'
import type { GameConnection } from '@client/net/connection'
import { attachPointerLock } from '@client/input/pointerLock'
import { createMouseLookController, type MouseLookController } from '@client/input/mouseLook'
import { createMovementInputTracker } from '@client/input/movementInput'
import { createLocalFireCooldown } from '@client/input/fireControl'
import { rotateLocalMoveDirection, yawPitchToDirection } from '@client/input/aimMath'
import { applyLookToCamera } from '@client/input/cameraLook'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { NET } from '@shared/constants'

interface PlayerControlsProps {
  store: StoreApi<GameStoreState>
  connection: GameConnection
}

/**
 * 22b — 마우스 룩(포인터 락 연계)·1인칭 카메라·조준 발사·yaw 회전 이동
 * 전송을 한 컴포넌트에 모은다. 캔버스(`gl.domElement`)가 필요한 배선
 * (포인터 락·마우스 룩·발사 클릭)과 매 프레임 카메라 갱신(`useFrame`)이
 * 모두 같은 DOM 엘리먼트·같은 `mouseLook` 컨트롤러를 공유해야 하므로
 * 분리하지 않는다 — 나누면 `GameScene`의 캔버스 마운트와 이 컴포넌트의
 * 마운트 순서가 R3F 렌더 사이클에 묶이지 않아 경합(race)이 생긴다.
 *
 * 렌더 계층 면제 대상(`harness/workflow/fe.md`) — 이 파일 자체는 테스트
 * 없음, tsc·lint·빌드·수동 확인이 게이트다. 순수 산술(회전·조준 벡터·
 * 쿨다운 판정)은 `@client/input/{aimMath,fireControl}`로 분리해 그쪽에서
 * 단위 테스트한다(ADR-0011 test-after).
 *
 * 이동 회전: `movementInput.ts`가 반환하는 로컬(캐릭터 기준) 방향을 이
 * 컴포넌트가 yaw로 회전해 월드축 방향으로 바꾼 뒤 `connection
 * .sendMoveInput`에 전달한다. `sendMoveInput` → `ClientPredictor
 * .applyInput`(`prediction.ts`)은 받은 `MoveInput`을 그대로 예측에
 * 반영할 뿐이라 이 변경으로 `prediction.ts`·`connection.ts`는 손대지
 * 않아도 된다 — 예측도 회전된 입력을 그대로 받으므로 서버 판정(RQ-20,
 * `stepMovement`)과 같은 좌표계로 정합한다.
 *
 * 카메라 높이: `@shared/config/combat-tuning`의 `DEFAULT_HITBOX
 * .eyeHeightM`을 그대로 재사용한다(값 복제 금지, ADR-0010) — 서버
 * `GameRoom.handleFire`의 레이 원점이 같은 상수를 쓰므로 1인칭 시점과
 * 서버 판정 레이 원점이 시각적으로 정합한다. 1.9m가 평균 키보다 높아
 * 보이는 이유는 `combat-tuning.ts`의 "복원 조건" 주석 참고(RQ-31 스폰
 * 로테이션 도입 전까지의 잠정값 — 겹쳐 스폰 회피).
 */
export function PlayerControls({ store, connection }: PlayerControlsProps) {
  const { camera, gl } = useThree()
  const mouseLookRef = useRef<MouseLookController | null>(null)

  useEffect(() => {
    const canvas = gl.domElement
    const detachPointerLock = attachPointerLock(canvas)
    const mouseLook = createMouseLookController(canvas)
    mouseLookRef.current = mouseLook

    const movementTracker = createMovementInputTracker()
    const fireCooldown = createLocalFireCooldown()

    function handleFireDown(event: MouseEvent): void {
      // 주 버튼(좌클릭)만 발사한다 — 우클릭·휠클릭은 조준경(스펙 없음)이나
      // 브라우저 기본 동작이라 발사로 해석하지 않는다.
      if (event.button !== 0) return
      // 락이 걸리기 전(입장 직후 첫 누름)에는 발사하지 않는다. 락 요청은
      // `attachPointerLock`이 'click'에서, 발사는 여기 'mousedown'에서
      // 처리하므로 이벤트 자체가 다르다 — 브라우저 순서가
      // mousedown → mouseup → click이라, 첫 누름 시점에는 락 요청이 아직
      // 일어나지도 않아 이 가드에서 확실히 걸린다.
      if (document.pointerLockElement !== canvas) return
      // 'click'이 아니라 'mousedown'을 쓴다(리뷰 minor 2) — click은
      // mousedown+mouseup 완결 시 발생해 **버튼을 떼는 순간** 발사된다.
      // 길게 누른 클릭이 그만큼 늦게 나가고, RQ-90의 400 RPM 리듬 실측에도
      // 잡음이 섞인다. 누르는 순간 나가는 것이 FPS의 기대 동작이다.
      //
      // 시각은 `connection.now()` 한 곳에서만 읽는다(리뷰 minor 1) —
      // `connection.ts`가 "성능 시계를 읽는 유일한 지점"으로 스스로를
      // 규정했고, 스냅샷 수신 시각·보간 렌더 시각과 같은 축을 쓰게 된다.
      if (!fireCooldown.tryFire(connection.now())) return
      const { yaw, pitch } = mouseLook.getAngles()
      connection.room.send('fire', yawPitchToDirection(yaw, pitch))
    }
    canvas.addEventListener('mousedown', handleFireDown)

    // RQ-62 이동 입력 전송 루프와 동일한 주기(NET.TICK_MS, 30Hz) —
    // `App.tsx`에 있던 루프를 여기로 옮겼다(yaw 회전에 `mouseLook`이
    // 필요해 같은 유효범위 안에 있어야 한다).
    const movementIntervalId = window.setInterval(() => {
      const local = movementTracker.getMoveInput()
      const { yaw } = mouseLook.getAngles()
      const world = rotateLocalMoveDirection(local, yaw)
      connection.sendMoveInput({ ...local, dirX: world.dirX, dirZ: world.dirZ })
    }, NET.TICK_MS)

    return () => {
      detachPointerLock()
      mouseLook.dispose()
      mouseLookRef.current = null
      movementTracker.dispose()
      canvas.removeEventListener('mousedown', handleFireDown)
      window.clearInterval(movementIntervalId)
    }
  }, [gl, connection])

  useFrame(() => {
    const mouseLook = mouseLookRef.current
    if (!mouseLook) return
    const { yaw, pitch } = mouseLook.getAngles()
    // 카메라 회전 적용은 `@client/input/cameraLook`이 유일한 지점이다 —
    // 회귀 가드 테스트(`tests/unit/22b-aim-camera-binding.test.ts`)가 **같은
    // 함수**를 호출해 조준 벡터와의 정합을 검사하므로, 여기서 인라인으로
    // 돌리면 그 가드가 배선을 놓친다(모듈 주석 참고).
    // Euler.set/Vector3.set은 기존 객체를 갱신할 뿐 새 객체를 만들지
    // 않는다(프레임 예산 규칙, `harness/workflow/fe.md`).
    applyLookToCamera(camera, yaw, pitch)

    const state = store.getState()
    const predicted = state.selfPredictedState
    if (predicted) {
      camera.position.set(predicted.x, predicted.y + DEFAULT_HITBOX.eyeHeightM, predicted.z)
      return
    }
    // 예측이 아직 없으면(접속 직후, 첫 입력 전송 전) 서버 스냅샷으로
    // 폴백한다 — `PlayerMeshes`의 동일 폴백 패턴과 같은 이유(RQ-61).
    const selfId = state.selfSessionId
    const fallback = selfId ? state.players.get(selfId) : undefined
    if (fallback) {
      camera.position.set(fallback.x, fallback.y + DEFAULT_HITBOX.eyeHeightM, fallback.z)
    }
  })

  return null
}
