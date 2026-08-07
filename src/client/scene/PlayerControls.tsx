import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { StoreApi } from 'zustand/vanilla'
import type { GameStoreState } from '@client/store/gameStore'
import type { GameConnection } from '@client/net/connection'
import type { UiStoreState } from '@client/store/uiStore'
import { attachPointerLock } from '@client/input/pointerLock'
import { createMouseLookController, type MouseLookController } from '@client/input/mouseLook'
import { createMovementInputTracker } from '@client/input/movementInput'
import { createLocalFireCooldown } from '@client/input/fireControl'
import { rotateLocalMoveDirection, yawPitchToDirection } from '@client/input/aimMath'
import { applyLookToCamera } from '@client/input/cameraLook'
import { createChatGatedActions } from '@client/input/chatInputGate'
import { crosshairGapPx } from '@client/hud/crosshairSpread'
import { resolveNameplateTarget, type NameplateCandidate } from '@client/hud/nameplateTarget'
import { PRODUCTION_WALLS } from '@shared/sim/walls'
import * as THREE from 'three'
import type { InterpolationPosition } from '@client/net/interpolation'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { NET } from '@shared/constants'

interface PlayerControlsProps {
  store: StoreApi<GameStoreState>
  connection: GameConnection
  uiStore: StoreApi<UiStoreState>
}

/**
 * 22b — 마우스 룩(포인터 락 연계)·1인칭 카메라·조준 발사·yaw 회전 이동
 * 전송을 한 컴포넌트에 모은다. 캔버스(`gl.domElement`)가 필요한 배선
 * (포인터 락·마우스 룩·발사 mousedown)과 매 프레임 카메라 갱신(`useFrame`)이
 * 모두 같은 DOM 엘리먼트·같은 `mouseLook` 컨트롤러를 공유해야 하므로
 * 분리하지 않는다 — 나누면 `GameScene`의 캔버스 마운트와 이 컴포넌트의
 * 마운트 순서가 R3F 렌더 사이클에 묶이지 않아 경합(race)이 생긴다.
 *
 * 렌더 계층 면제 대상(`harness/workflow/fe.md`) — 이 파일 자체는 테스트
 * 없음, tsc·lint·빌드·수동 확인이 게이트다. 순수 산술(회전·조준 벡터·
 * 쿨다운 판정)과 카메라 회전 적용은 `@client/input/{aimMath,fireControl,
 * cameraLook}`로 분리해 그쪽에서 단위 테스트한다(ADR-0011 test-after).
 *
 * **이 파일이 함수를 호출하지 않게 되는 변경(호출부 삭제·인라인 우회)은
 * 테스트가 잡지 못한다** — 렌더 계층을 마운트해야만 검출되고 그것은
 * ADR-0008 §6(렌더링 테스트 면제)을 뒤집는 일이라 하지 않는다. 대신
 * 리뷰 정독과 브라우저 스모크가 지정 게이트다(전부 첫 화면에서 즉시
 * 보이는 고장이다 — 시점이 안 돌아감·상하좌우 뒤엉킴·조준과 무관하게
 * 걸음). 구멍이 아니라 사람 담당이라는 뜻이다.
 *
 * 이동 회전: `movementInput.ts`가 반환하는 로컬(캐릭터 기준) 방향을 이
 * 컴포넌트가 yaw로 회전해 월드축 방향으로 바꾼 뒤 `connection
 * .sendMoveInput`에 전달한다. `sendMoveInput` → `ClientPredictor
 * .applyInput`(`prediction.ts`)은 받은 `MoveInput`을 그대로 예측에
 * 반영할 뿐이라 이 변경으로 `prediction.ts`·`connection.ts`는 손대지
 * 않아도 된다 — 예측도 회전된 입력을 그대로 받으므로 서버 판정(RQ-20,
 * `stepMovement`)과 같은 좌표계로 정합한다.
 *
 * 카메라 높이와 서버 레이 원점의 정합: 서버는 `@shared/sim/combat`의
 * `eyeOrigin(발 위치, eyeHeightM)`으로 hitscan 레이 원점을 만든다(RQ-15/16
 * 라운드에서 도입한 단일 진실 공급원). 이 컴포넌트는 **같은 상수**를 쓰되
 * 그 함수를 호출하지는 않는다 — `eyeOrigin`은 새 객체를 반환하는데 여기는
 * `useFrame`(60fps)이라 프레임당 할당이 되어 `harness/workflow/fe.md`의
 * 프레임 예산 규칙을 깬다. 즉 공유되는 것은 **값**이고, `발 + eyeHeightM`
 * 이라는 한 줄 산술만 두 곳에 있다. 무할당 변형(`copyPositionInto` 선례의
 * out-파라미터)을 `@shared`에 추가할지는 다음 FE 라운드 판단이며 원장에
 * 이월돼 있다 — 그 전까지 이 파일과 `eyeOrigin`의 정의가 갈라지면 조준선과
 * 서버 판정이 어긋난다는 점을 유지보수자가 알고 있어야 한다.
 *
 * 카메라 높이 값 자체: `@shared/config/combat-tuning`의 `DEFAULT_HITBOX
 * .eyeHeightM`을 그대로 재사용한다(값 복제 금지, ADR-0010) — 서버
 * `GameRoom.handleFire`의 레이 원점이 같은 상수를 쓰므로 1인칭 시점과
 * 서버 판정 레이 원점이 시각적으로 정합한다. 현재 값 1.7m는 현실적인 평균
 * 눈높이다 — RQ-15/16 라운드에서 스폰 로테이션이 들어와 겹쳐 스폰이
 * 사라지면서 잠정값 1.9m에서 복원했다(22a 후속 이월 ①, 경위는
 * `combat-tuning.ts` 주석).
 *
 * RQ-40 입력 차단(리뷰 M4): 게임 레이어로 나가는 두 출구(이동 전송·발사
 * 전송)는 `@client/input/chatInputGate`의 `createChatGatedActions`가 만든
 * **단일 choke point**(`gatedActions`)를 통해서만 나간다 — 이동 전송
 * 루프·발사 핸들러가 각자 게이트를 호출하지 않는다(fe.md "개별 핸들러마다
 * 분산 체크하지 않는다"를 문자 그대로: 체크 자체가 한 곳에만 있다).
 * `uiStore`는 `ChatPanel.tsx`(HUD)가 입력창 포커스/블러에서 쓴다 — 이
 * 컴포넌트는 그 최신값을 콜백으로 읽기만 한다.
 */
export function PlayerControls({ store, connection, uiStore }: PlayerControlsProps) {
  const { camera, gl } = useThree()
  const mouseLookRef = useRef<MouseLookController | null>(null)

  useEffect(() => {
    const canvas = gl.domElement
    // 원장 24e-2 — 락 실패를 조용히 넘기지 않는다. 시점이 안 도는 증상의
    // 원인이 여기라는 것을 사용자·개발자 양쪽이 알 수 있어야 한다.
    const detachPointerLock = attachPointerLock(canvas)
    function onLockChange(): void {
      uiStore.getState().setPointerLocked(document.pointerLockElement === canvas)
    }
    document.addEventListener('pointerlockchange', onLockChange)
    onLockChange()
    const mouseLook = createMouseLookController(canvas)
    mouseLookRef.current = mouseLook

    // RQ-56 재사용 버퍼 — 매 틱 새로 만들지 않는다(프레임 예산 규율).
    const projectionScratch = new THREE.Vector3()
    const anchorScratch: InterpolationPosition = { x: 0, y: 0, z: 0 }
    const movementTracker = createMovementInputTracker()
    const fireCooldown = createLocalFireCooldown()
    // RQ-40 M4 — 게임 레이어 출구 단일 choke point(모듈 코멘트 참고).
    const gatedActions = createChatGatedActions(() => uiStore.getState().chatFocused, connection)

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
      // RQ-40 M4: 채팅 게이트는 `gatedActions.fire` 안에서 처리한다.
      // RQ-64(평가 F1 대응): 사수의 현재 RTT 추정치를 함께 실어 보낸다 —
      // 서버(`GameRoom.handleFire`)가 이 값으로 대상 위치를 되감는다.
      gatedActions.fire(yawPitchToDirection(yaw, pitch), connection.getRttMs())
    }
    canvas.addEventListener('mousedown', handleFireDown)

    // RQ-62 이동 입력 전송 루프와 동일한 주기(NET.TICK_MS, 30Hz) —
    // `App.tsx`에 있던 루프를 여기로 옮겼다(yaw 회전에 `mouseLook`이
    // 필요해 같은 유효범위 안에 있어야 한다).
    const movementIntervalId = window.setInterval(() => {
      const local = movementTracker.getMoveInput()
      const { yaw } = mouseLook.getAngles()
      const world = rotateLocalMoveDirection(local, yaw)
      // RQ-40 M4: 채팅 게이트는 `gatedActions.sendMoveInput` 안에서 처리한다.
      const sent = gatedActions.sendMoveInput({ ...local, dirX: world.dirX, dirZ: world.dirZ })

      // RQ-54 크로스헤어 확산(원장 24e) — **여기서 계산하는 이유**: 이 루프는
      // 30Hz이고 `useFrame`(60fps 렌더 루프)이 아니다. 렌더 루프에서 돌리면
      // 프레임마다 store를 건드려 ADR-0001 프레임 예산과 부딪힌다.
      // ⚠️ **게이트가 실제로 내보낸 값(`sent`)을 쓴다** — 회전 전 원시 입력
      // (`local`)이 아니다(PR #61 리뷰 blocker). tier 판정은 "수평 입력이
      // 있는가"만 보므로 yaw 회전 자체는 무관하지만(서버도 회전된 벡터의 0
      // 여부로 같은 판정을 한다, RQ-90 v1.9), **채팅 포커스 중에는 원시 입력과
      // 전송 값이 갈라진다**: `movementInput`은 `window`에 리스너를 걸고 포커스를
      // 보지 않으므로 채팅창에 "wasd"를 치면 `local`이 이동 tier가 되는데 서버가
      // 받는 값은 0이다. 그때 원시 입력으로 그리면 화면만 콘 ×2를 표시한다.
      // `setCrosshairGapPx`가 값이 바뀔 때만 `set`한다.
      const predicted = store.getState().selfPredictedState
      uiStore.getState().setCrosshairGapPx(crosshairGapPx(sent, predicted?.grounded ?? true))

      // RQ-56 이름표(원장 24ab) — 조준선이 향한 대상을 찾아 화면 좌표로 옮긴다.
      // 여기서 하는 이유는 크로스헤어와 같다: 30Hz 루프이지 `useFrame`이 아니다.
      // 판정 자체는 `@client/hud/nameplateTarget`이 서버 hitscan과 **같은 함수**로
      // 수행한다 — "쏠 수 있으면 보인다"(RQ-56)가 구조적으로 성립해야 한다.
      const state = store.getState()
      const selfId = state.selfSessionId
      const selfFoot = predicted ?? (selfId ? state.players.get(selfId) : undefined)
      if (!selfFoot || !selfId) {
        uiStore.getState().setNameplate(null)
        return
      }
      // 자기 자신을 후보에서 뺀다 — 넣으면 자기 이름이 뜬다.
      // 시신 제외는 `resolveNameplateTarget`이 서버와 같은 술어(`canAct`)로 한다.
      const candidates: Map<string, NameplateCandidate> = new Map()
      state.players.forEach((player, id) => {
        if (id !== selfId) candidates.set(id, player)
      })
      const { yaw: aimYaw, pitch: aimPitch } = mouseLook.getAngles()
      // `AimDirection`(dirX/dirY/dirZ) → `Vec3`(x/y/z). 서버도 같은 자리에서
      // 같은 변환을 한다(`GameRoom.ts:726` — `{ x: input.dirX, ... }`).
      // 조준 벡터 자체는 `yawPitchToDirection` 하나가 만들고 양쪽이 그것을 쓴다.
      const aim = yawPitchToDirection(aimYaw, aimPitch)
      const target = resolveNameplateTarget(
        { x: selfFoot.x, y: selfFoot.y, z: selfFoot.z },
        { x: aim.dirX, y: aim.dirY, z: aim.dirZ },
        candidates,
        PRODUCTION_WALLS,
        // 앵커는 **몸이 그려지는 자리**(보간)여야 한다 — 최신 스냅샷을 쓰면
        // 보간 지연만큼(6m/s × 66.67ms = 0.40m) 이름이 몸 옆에 뜬다
        // (PR #66 리뷰 blocker 2). `PlayerMeshes`와 같은 보간기·같은 렌더 시각.
        (id) =>
          connection.interpolator.copyPositionInto(id, connection.now(), anchorScratch)
            ? anchorScratch
            : undefined,
      )
      if (!target) {
        uiStore.getState().setNameplate(null)
        return
      }
      // 3D 앵커 → 화면 좌표. `project`는 벡터를 제자리에서 바꾸므로 재사용
      // 벡터 하나만 둔다(프레임 예산 규칙 — 이 루프는 30Hz지만 같은 규율을 쓴다).
      projectionScratch.set(target.anchor.x, target.anchor.y, target.anchor.z).project(camera)
      // NDC z가 1을 넘는 조건은 **카메라 뒤**와 **far plane 바깥**을 둘 다 잡는다.
      // 조준선이 향했으면 앞에 있지만 근평면 경계에서 투영이 뒤집히는 경우를 막는다.
      // ⚠️ far 바깥은 현재 도달 불가다 — `far`(WORLD.SIZE_M × 2 = 120m)가 맵
      // 대각(84.9m)보다 커서, RQ-56의 "거리 제한을 두지 않는다"와 양립한다.
      // `far`를 줄이면 그 전제가 깨져 먼 대상의 이름표가 조용히 사라진다.
      if (projectionScratch.z > 1) {
        uiStore.getState().setNameplate(null)
        return
      }
      const canvasRect = gl.domElement.getBoundingClientRect()
      uiStore.getState().setNameplate({
        nickname: target.nickname,
        xPx: ((projectionScratch.x + 1) / 2) * canvasRect.width,
        yPx: ((1 - projectionScratch.y) / 2) * canvasRect.height,
      })
    }, NET.TICK_MS)

    return () => {
      detachPointerLock()
      document.removeEventListener('pointerlockchange', onLockChange)
      uiStore.getState().setPointerLocked(false)
      uiStore.getState().setNameplate(null)
      mouseLook.dispose()
      mouseLookRef.current = null
      movementTracker.dispose()
      canvas.removeEventListener('mousedown', handleFireDown)
      window.clearInterval(movementIntervalId)
    }
  }, [gl, connection, uiStore, store])

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
