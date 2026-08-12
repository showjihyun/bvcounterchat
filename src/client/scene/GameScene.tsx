import { Canvas } from '@react-three/fiber'
import type { StoreApi } from 'zustand/vanilla'
import { WORLD } from '@shared/constants'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import type { GameStoreState } from '@client/store/gameStore'
import type { GameConnection } from '@client/net/connection'
import type { UiStoreState } from '@client/store/uiStore'
import { PlayerMeshes } from '@client/scene/PlayerMeshes'
import { PlayerControls } from '@client/scene/PlayerControls'
import { MapMeshes } from '@client/scene/MapMeshes'
import { HitDecals } from '@client/scene/HitDecals'
import { SCENE } from '@client/config/design-tokens'

interface GameSceneProps {
  store: StoreApi<GameStoreState>
  connection: GameConnection
  uiStore: StoreApi<UiStoreState>
}

/**
 * 3D 씬(ADR-0001 WebGL2, `harness/workflow/fe.md` scene 레이어). 접속 후
 * 표시된다 — 로드맵 1단계 `App.tsx`의 정적 데모 박스를 대체해, 서버
 * 스냅샷의 실제 플레이어를 그린다(RQ-61: 자기 자신은 1인칭 카메라(RQ-62
 * 예측 위치, 22b), 다른 플레이어는 보간(RQ-63) 표현).
 *
 * 22b: 포인터 락·마우스 룩·1인칭 카메라·발사 배선은 `PlayerControls`
 * (렌더 계층, `useThree()`로 캔버스에 접근 — `Canvas`의 `onCreated` 콜백
 * 대신 이 방식을 쓰는 이유는 `PlayerControls.tsx` 상단 코멘트 참고)가
 * 전담한다. 초기 `camera` 위치는 `PlayerControls`의 첫 프레임이 즉시
 * 덮어쓰므로(1인칭 위치로) 의미 있는 값은 아니다 — 접속 첫 프레임까지의
 * 짧은 과도 상태일 뿐이다.
 */
export function GameScene({ store, connection, uiStore }: GameSceneProps) {
  return (
    <Canvas
      // ADR-0001: WebGL2 고정. WebGPU는 쓰지 않는다.
      gl={{ powerPreference: 'high-performance', antialias: false }}
      // 초기 카메라 높이는 눈높이 상수를 그대로 쓴다(리뷰 minor 1 — 이전엔
      // 리터럴 1.7이었고 `eyeHeightM`이 1.7로 복원되며 우연히 일치했다).
      // **예측 또는 서버 스냅샷이 처음 도착한 프레임부터** `PlayerControls`가
      // 덮어쓴다 — 그 전까지는 이 값이 그대로 보인다(PR #68 리뷰 D5 — 이전
      // 주석은 "첫 프레임에 덮어쓴다"고 조건 없이 단정했다). ⚠️ 그 창에서는
      // 자세가 반영되지 않지만 **결함이 아니다**: `x·z`도 플레이어 위치가
      // 아닌 자리표시자라 눈높이 0.478m 차이는 이미 수십 m일 수 있는 수평
      // 오차 안의 잡음이고, 같은 창에서 이름표는 `selfFoot`이 없어 꺼진다
      // (`PlayerControls.tsx` `setNameplate(null)`). 서버는 이 값을 보지
      // 않는다(RQ-61). 리터럴을 남기면 상수가 바뀔 때 조용히 어긋난다(ADR-0010).
      camera={{ fov: 75, position: [0, DEFAULT_HITBOX.eyeHeightM, 5], near: 0.1, far: WORLD.SIZE_M * 2 }}
    >
      {/* 원장 24c — 씬 색 5곳이 리터럴이었다. 정본은 `SCENE`이고 여기는 참조만
          한다(ADR-0010). 값은 바뀌지 않았다 — 이관이지 재도색이 아니다. */}
      <color attach="background" args={[SCENE.sky]} />
      <hemisphereLight intensity={1.2} groundColor={SCENE.groundLight} />
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[WORLD.SIZE_M, WORLD.SIZE_M]} />
        <meshStandardMaterial color={SCENE.ground} />
      </mesh>
      {/* 그리드를 바닥보다 1cm 띄운다(원장 24f) — 둘 다 y=0이면 **동일 평면**이라
          z-fighting으로 격자가 깜빡이거나 통째로 사라진다. 격자는 이 맵에서
          거리감을 주는 유일한 바닥 무늬라 사라지면 이동이 보이지 않는다. */}
      <gridHelper args={[WORLD.SIZE_M, WORLD.SIZE_M]} position={[0, 0.01, 0]} />
      {/* RQ-30 벽 · RQ-32 박스·사다리(원장 24f). 판정 전용이던 지오메트리가
          처음으로 화면에 나온다 — MapMeshes.tsx 상단 주석 참고. */}
      <MapMeshes />
      {/* RQ-70·71 2/2(렌더) — 탄흔·피격 효과 InstancedMesh 배선(ADR-0016
          결정 4, HitDecals.tsx 상단 주석 참고). */}
      <HitDecals store={store} />
      <PlayerMeshes store={store} connection={connection} />
      <PlayerControls store={store} connection={connection} uiStore={uiStore} />
    </Canvas>
  )
}
