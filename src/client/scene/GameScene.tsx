import { Canvas } from '@react-three/fiber'
import type { StoreApi } from 'zustand/vanilla'
import { WORLD } from '@shared/constants'
import { DEFAULT_HITBOX } from '@shared/config/combat-tuning'
import type { GameStoreState } from '@client/store/gameStore'
import type { GameConnection } from '@client/net/connection'
import { PlayerMeshes } from '@client/scene/PlayerMeshes'
import { PlayerControls } from '@client/scene/PlayerControls'

interface GameSceneProps {
  store: StoreApi<GameStoreState>
  connection: GameConnection
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
export function GameScene({ store, connection }: GameSceneProps) {
  return (
    <Canvas
      // ADR-0001: WebGL2 고정. WebGPU는 쓰지 않는다.
      gl={{ powerPreference: 'high-performance', antialias: false }}
      // 초기 카메라 높이는 눈높이 상수를 그대로 쓴다(리뷰 minor 1 — 이전엔
      // 리터럴 1.7이었고 `eyeHeightM`이 1.7로 복원되며 우연히 일치했다).
      // 첫 프레임에 `PlayerControls`가 예측 위치로 덮어쓰므로 과도값이지만,
      // 리터럴을 남기면 상수가 바뀔 때 조용히 어긋난다(ADR-0010).
      camera={{ fov: 75, position: [0, DEFAULT_HITBOX.eyeHeightM, 5], near: 0.1, far: WORLD.SIZE_M * 2 }}
    >
      <color attach="background" args={['#c2b49a']} />
      <hemisphereLight intensity={1.2} groundColor="#8a7a5c" />
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[WORLD.SIZE_M, WORLD.SIZE_M]} />
        <meshStandardMaterial color="#8a7a5c" />
      </mesh>
      <gridHelper args={[WORLD.SIZE_M, WORLD.SIZE_M]} />
      <PlayerMeshes store={store} connection={connection} />
      <PlayerControls store={store} connection={connection} />
    </Canvas>
  )
}
