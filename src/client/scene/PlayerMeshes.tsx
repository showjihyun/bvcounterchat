import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { StoreApi } from 'zustand/vanilla'
import type { GameStoreState } from '@client/store/gameStore'
import type { GameConnection } from '@client/net/connection'
import type { InterpolationPosition } from '@client/net/interpolation'
import type { MoveInput } from '@shared/sim/movement'
import { CROUCH_HITBOX, DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import { SCENE } from '@client/config/design-tokens'
import { GAIT_TUNING } from '@client/config/player-model-tuning'
import {
  applyGaitSwingInto,
  computePlayerModelLayout,
  isRemoteMeshVisible,
  type PlayerModelLayout,
} from '@client/scene/playerModelLayout'
import { resolveRemoteGaitPhase01 } from '@client/scene/gaitPhase'

/**
 * 플레이어를 **6파츠 절차적 지오메트리**(머리·몸통·팔2·다리2)로 표시한다
 * (RQ-73, ADR-0015). RQ-61: 자기 자신은 예측(RQ-62), 다른 플레이어는
 * 보간(RQ-63) 위치로 렌더한다 — 서버 스냅샷은 두 경로 모두의 원천이지만
 * 표시 자체는 그대로가 아니다.
 *
 * **이 파일은 "렌더 배선" 층이다(ADR-0015 결정 5, 단위 테스트 면제 —
 * 대신 스크린샷)** — 파츠 좌표·크기·걸음 위상의 **계산**은 전부
 * `@client/scene/playerModelLayout`·`@client/scene/gaitPhase`(순수 함수,
 * `tests/unit/rq-73-player-model.test.ts`가 값으로 단언)가 담당하고, 이
 * 파일은 그 결과로 `THREE.Mesh`를 만들거나 `.position`/`.scale`을 갱신하기만
 * 한다.
 *
 * `harness/workflow/fe.md` 규칙 — R3F 컴포넌트 안에서 `useStore()` 구독
 * 금지(store가 30Hz 갱신돼 매 프레임 React 리렌더가 걸린다). 대신 두
 * 경로로 나눈다:
 * - 참가·퇴장(파츠 6개 그룹 생성·제거)은 `store.subscribe`(transient)로
 *   처리한다. React 리렌더 경로를 타지 않고, 실제로 인원이 바뀔 때만
 *   그룹을 만들거나 지운다.
 * - 위치·자세·걸음 스윙 갱신은 `useFrame` 안에서 `getState()`로 직접 읽어
 *   기존 객체의 `.position`/`.scale`만 `.set()`/대입으로 갱신한다 — 새
 *   객체를 만들지 않는다(프레임 예산, ADR-0001).
 *
 * **지오메트리·머티리얼은 모듈 스코프에서 한 번만 만들어 전 플레이어·전
 * 파츠가 공유한다** — 10명 × 6파츠라도 실제 GPU 버퍼는 4개 지오메트리
 * (머리·몸통·팔·다리, 좌우는 같은 지오메트리를 미러 위치에 둘 뿐이다) ×
 * 2개 머티리얼(자기·타인)뿐이다. 이전 구현(단일 `BoxGeometry`)이 플레이어별로
 * 지오메트리·머티리얼을 새로 만들고 퇴장 시 `dispose()`하던 것과 달리, 이
 * 공유 자원은 **절대 dispose하지 않는다**(앱 생애주기 내내 존재).
 */

// RQ-73/ADR-0015 결정 5 — 배치는 순수 함수(`computePlayerModelLayout`)가
// 값으로 정한다. 가능한 자세는 선(run/walk 공통)·앉음(crouch) 둘뿐이므로
// (`hitboxForMode` 선례) 이 두 상수가 전부다 — **모듈 로드 시 한 번만**
// 계산해 캐싱한다. `useFrame` 안에서 매 프레임 다시 부르면 프레임마다 새
// 객체 그래프를 할당해 프레임 예산(ADR-0001)을 어긴다.
const STANDING_LAYOUT: PlayerModelLayout = computePlayerModelLayout(DEFAULT_HITBOX)
const CROUCH_LAYOUT: PlayerModelLayout = computePlayerModelLayout(CROUCH_HITBOX)

// 평가 F2 대응 — `applyGaitSwingInto`(순수 함수, `playerModelLayout.ts`)의
// `out` 인자로 재사용하는 스크래치 버퍼 하나. `copyPositionInto`의
// `interpolatedRef`와 동일한 정신(할당 없는 프레임 루프) — 한 프레임 안에서
// 파츠별로 즉시 읽어 `.position.set()`하고 다음 플레이어로 넘어가므로
// 플레이어 전체가 이 버퍼 하나를 순차적으로 공유해도 안전하다(동시 사용
// 없음). 초기값은 아무 유효한 배치면 되므로 `STANDING_LAYOUT`을 그대로
// 얕은 재사용하지 않고 별도로 계산한다(같은 참조를 두 용도로 쓰면 나중에
// `STANDING_LAYOUT`을 실수로 변형할 위험이 생긴다).
const GAIT_SWING_SCRATCH: PlayerModelLayout = computePlayerModelLayout(DEFAULT_HITBOX)

function layoutForMode(mode: MoveInput['mode'] | undefined): PlayerModelLayout {
  return mode === 'crouch' ? CROUCH_LAYOUT : STANDING_LAYOUT
}

// 몸통·팔·다리의 수평(X·Z) 치수는 두 자세에서 완전히 같다(`bodyRadiusM`
// 불변, `player-model-tuning.ts` 참고) — 지오메트리 자체는 선 자세 치수로
// 한 번만 만들고, 앉은 자세는 `scale.y`로만 눌러 표현한다(이전 단일 박스
// 구현이 `BOX_HEIGHT`를 `scale.y`로 눌렀던 것과 동일한 기법).
const HEAD_GEOMETRY = new THREE.SphereGeometry(STANDING_LAYOUT.head.radius, 12, 8)
const TORSO_GEOMETRY = new THREE.BoxGeometry(
  STANDING_LAYOUT.torso.halfExtents.x * 2,
  STANDING_LAYOUT.torso.halfExtents.y * 2,
  STANDING_LAYOUT.torso.halfExtents.z * 2,
)
// 좌·우 팔(그리고 다리)은 같은 지오메트리를 공유한다 — 둘은 X 위치(부호)만
// 다를 뿐 형태가 완전히 대칭이다(ADR-0015 결정 3).
const ARM_GEOMETRY = new THREE.BoxGeometry(
  STANDING_LAYOUT.armLeft.halfExtents.x * 2,
  STANDING_LAYOUT.armLeft.halfExtents.y * 2,
  STANDING_LAYOUT.armLeft.halfExtents.z * 2,
)
const LEG_GEOMETRY = new THREE.BoxGeometry(
  STANDING_LAYOUT.legLeft.halfExtents.x * 2,
  STANDING_LAYOUT.legLeft.halfExtents.y * 2,
  STANDING_LAYOUT.legLeft.halfExtents.z * 2,
)

// 원장 24c — 색 정본은 `SCENE`이다.
const SELF_MATERIAL = new THREE.MeshStandardMaterial({ color: SCENE.self })
const OTHER_MATERIAL = new THREE.MeshStandardMaterial({ color: SCENE.other })

interface PlayerModelInstance {
  /** 플레이어의 **발** 위치에 놓이는 부모 그룹 — 6파츠 전부 이 그룹의
   * 자식으로, 로컬 좌표가 곧 `playerModelLayout.ts`가 계산한 발-기준
   * 높이다. */
  group: THREE.Group
  head: THREE.Mesh
  torso: THREE.Mesh
  armLeft: THREE.Mesh
  armRight: THREE.Mesh
  legLeft: THREE.Mesh
  legRight: THREE.Mesh
}

function createPlayerModelInstance(isSelf: boolean): PlayerModelInstance {
  const material = isSelf ? SELF_MATERIAL : OTHER_MATERIAL
  const group = new THREE.Group()

  const head = new THREE.Mesh(HEAD_GEOMETRY, material)
  const torso = new THREE.Mesh(TORSO_GEOMETRY, material)
  const armLeft = new THREE.Mesh(ARM_GEOMETRY, material)
  const armRight = new THREE.Mesh(ARM_GEOMETRY, material)
  const legLeft = new THREE.Mesh(LEG_GEOMETRY, material)
  const legRight = new THREE.Mesh(LEG_GEOMETRY, material)
  group.add(head, torso, armLeft, armRight, legLeft, legRight)

  return { group, head, torso, armLeft, armRight, legLeft, legRight }
}

/**
 * `instance`의 6파츠를 `layout`(자세별 정적 배치)과 `gaitPhase`(0~1, 걸음
 * 위상)에 맞춰 갱신한다. **할당 없음** — 전부 기존 `Vector3`의 `.set()`
 * 또는 숫자 대입이다(useFrame 안전).
 *
 * 스윙(팔·다리의 로컬 Z 평행이동) 산술은 이 함수가 직접 하지 않는다 —
 * `applyGaitSwingInto`(순수 함수, `playerModelLayout.ts`, 평가 F2 대응)를
 * `GAIT_SWING_SCRATCH`에 써넣게 하고 그 결과를 읽기만 한다. 진폭 상수를
 * 이 파일에 다시 적으면(ADR-0010 값 복제) 테스트가 단언하는 함수와 실제
 * 렌더가 서로 다른 수치를 쓰게 될 수 있다.
 */
function updatePlayerModelPose(instance: PlayerModelInstance, layout: PlayerModelLayout, gaitPhase: number): void {
  applyGaitSwingInto(layout, gaitPhase, GAIT_SWING_SCRATCH)
  const swayed = GAIT_SWING_SCRATCH

  instance.head.position.set(swayed.head.center.x, swayed.head.center.y, swayed.head.center.z)

  instance.torso.position.set(swayed.torso.center.x, swayed.torso.center.y, swayed.torso.center.z)
  const torsoScaleY = layout.torso.halfExtents.y / STANDING_LAYOUT.torso.halfExtents.y
  instance.torso.scale.y = torsoScaleY

  // 팔의 half-height는 몸통과 같은 값으로 유도했으므로(playerModelLayout.ts
  // — armLeft/armRight의 halfExtents.y가 torsoHalfHeightM 그대로) 스케일도
  // 몸통과 같다. 다리는 별도 높이 구간(엉덩이 아래)이라 따로 계산한다.
  instance.armLeft.scale.y = torsoScaleY
  instance.armRight.scale.y = torsoScaleY
  instance.armLeft.position.set(swayed.armLeft.center.x, swayed.armLeft.center.y, swayed.armLeft.center.z)
  instance.armRight.position.set(swayed.armRight.center.x, swayed.armRight.center.y, swayed.armRight.center.z)

  const legScaleY = layout.legLeft.halfExtents.y / STANDING_LAYOUT.legLeft.halfExtents.y
  instance.legLeft.scale.y = legScaleY
  instance.legRight.scale.y = legScaleY
  instance.legLeft.position.set(swayed.legLeft.center.x, swayed.legLeft.center.y, swayed.legLeft.center.z)
  instance.legRight.position.set(swayed.legRight.center.x, swayed.legRight.center.y, swayed.legRight.center.z)
}

interface PlayerMeshesProps {
  store: StoreApi<GameStoreState>
  connection: GameConnection
}

export function PlayerMeshes({ store, connection }: PlayerMeshesProps) {
  const groupRef = useRef<THREE.Group>(null)
  const instancesRef = useRef(new Map<string, PlayerModelInstance>())
  // RQ-63: copyPositionInto의 out 인자로 재사용한다 — useFrame 안에서 매
  // 프레임·매 세션마다 새 객체를 만들지 않기 위한 스크래치 버퍼 하나.
  const interpolatedRef = useRef<InterpolationPosition>({ x: 0, y: 0, z: 0 })

  useEffect(() => {
    const current = groupRef.current
    if (!current) return undefined
    // 명시적 타입 애노테이션 — TS는 nested 함수 클로저 안에서 참조할 때
    // `const`의 좁혀진(non-null) 타입을 유지하지 않고 선언 타입으로 되돌린다.
    // 이 한 줄로 아래 `syncMeshes`·cleanup 클로저 안에서도 non-null로
    // 취급되게 한다.
    const group: THREE.Group = current

    const instances = instancesRef.current

    function syncMeshes(state: GameStoreState): void {
      for (const [sessionId, instance] of instances) {
        if (!state.players.has(sessionId)) {
          group.remove(instance.group)
          instances.delete(sessionId)
        }
      }

      state.players.forEach((_player, sessionId) => {
        if (instances.has(sessionId)) return
        const isSelf = sessionId === state.selfSessionId
        const instance = createPlayerModelInstance(isSelf)
        // 초기 정지 포즈(스윙 없음, 선 자세) — 원격이면 다음 useFrame이
        // 실제 자세·걸음 위상으로 즉시 덮어쓴다.
        updatePlayerModelPose(instance, STANDING_LAYOUT, 0)
        group.add(instance.group)
        instances.set(sessionId, instance)
      })

      // 22b: 1인칭 카메라가 자기 모델 **내부**에 있어 아래를 보면 자기
      // 모델이 시야를 가린다 — 자기 것만 숨긴다(RQ-73 "자기 자신은
      // 1인칭이므로 렌더하지 않는다", GA-95). 여기서 매번 갱신하는 이유:
      // `selfSessionId`가 첫 스냅샷보다 늦게 정해지는 경우에도 자기 모델이
      // 계속 보이지 않도록(그룹 생성 시점 한 번만 판단하면 그 순간의 값에
      // 고정된다). 이 함수는 store 변경 시에만 돌고 렌더 루프가 아니다.
      // `isRemoteMeshVisible`(순수 함수, `tests/unit/rq-73-player-model
      // .test.ts` GA-95)이 판정을 값으로 고정한다 — 여기는 그 값을
      // `.visible`에 대입만 한다.
      for (const [sessionId, instance] of instances) {
        instance.group.visible = isRemoteMeshVisible(sessionId, state.selfSessionId)
      }
    }

    syncMeshes(store.getState())
    const unsubscribe = store.subscribe(syncMeshes)

    return () => {
      unsubscribe()
      // 지오메트리·머티리얼은 모듈 스코프 공유 자원이라 dispose하지 않는다
      // (위 파일 docblock) — 씬 그래프에서 그룹만 떼어내면 충분하다.
      for (const instance of instances.values()) {
        group.remove(instance.group)
      }
      instances.clear()
    }
  }, [store])

  useFrame(() => {
    const state = store.getState()
    const renderTime = connection.now()
    const interpolated = interpolatedRef.current
    // for...of — Map.forEach의 화살표 콜백은 매 프레임 클로저를 새로 할당한다
    // (리뷰 minor). for...of는 화살표 클로저의 명시적 프레임당 할당을
    // 제거한다(프레임 예산 규칙 — 순회 자체가 할당 0이라는 뜻은 아니다).
    for (const [sessionId, instance] of instancesRef.current) {
      // RQ-62: 자기 자신은 예측 위치로 렌더한다(GA-34/35) — 하지만 자기
      // 모델은 항상 숨겨져 있으므로(위) 위치만 갱신하고 자세(스윙)는
      // 갱신하지 않는다 — `selfPredictedState`에 자세(`mode`) 필드가 없다
      // (`@shared/sim/movement`의 `MoveState`, 22b REV 참고).
      if (sessionId === state.selfSessionId && state.selfPredictedState) {
        const predicted = state.selfPredictedState
        instance.group.position.set(predicted.x, predicted.y, predicted.z)
        continue
      }
      // RQ-63: 다른 플레이어는 지연 버퍼를 반영한 보간 위치로 렌더한다
      // (GA-37/38, ADR-0003) — 아직 스냅샷을 한 번도 받지 못했으면(막
      // 참가해 다음 패치를 기다리는 중) 서버 스냅샷으로 폴백한다.
      // 자세(`getMode`, RQ-92 v2.4)와 걸음 누적 거리(`getGaitDistance`,
      // RQ-73/ADR-0015 결정 4)는 위치와 별도로 조회한다 — 둘 다 렌더
      // 시각과 무관한 계단/누적 값이다(위치처럼 보간하지 않는다).
      if (connection.interpolator.copyPositionInto(sessionId, renderTime, interpolated)) {
        const mode = connection.interpolator.getMode(sessionId, renderTime) ?? 'run'
        const gaitPhase = resolveRemoteGaitPhase01(connection.interpolator, sessionId, GAIT_TUNING.CYCLE_DISTANCE_M)
        instance.group.position.set(interpolated.x, interpolated.y, interpolated.z)
        updatePlayerModelPose(instance, layoutForMode(mode), gaitPhase)
        continue
      }
      const player = state.players.get(sessionId)
      if (!player) continue
      instance.group.position.set(player.x, player.y, player.z)
      updatePlayerModelPose(instance, layoutForMode(player.mode), 0)
    }
  })

  return <group ref={groupRef} />
}
