import { Canvas } from '@react-three/fiber'
import type { StoreApi } from 'zustand/vanilla'
import { WORLD } from '@shared/constants'
import type { GameStoreState } from '@client/store/gameStore'
import type { GameConnection } from '@client/net/connection'
import { PlayerMeshes } from '@client/scene/PlayerMeshes'
import { attachPointerLock } from '@client/input/pointerLock'

interface GameSceneProps {
  store: StoreApi<GameStoreState>
  connection: GameConnection
}

/**
 * 3D 씬(ADR-0001 WebGL2, `harness/workflow/fe.md` scene 레이어). 접속 후
 * 표시된다 — 로드맵 1단계 `App.tsx`의 정적 데모 박스를 대체해, 서버
 * 스냅샷의 실제 플레이어를 그린다(RQ-61: 자기 자신은 예측(RQ-62), 다른
 * 플레이어는 보간(RQ-63) 표현).
 */
export function GameScene({ store, connection }: GameSceneProps) {
  return (
    <Canvas
      // ADR-0001: WebGL2 고정. WebGPU는 쓰지 않는다.
      gl={{ powerPreference: 'high-performance', antialias: false }}
      camera={{ fov: 75, position: [0, 1.7, 5], near: 0.1, far: WORLD.SIZE_M * 2 }}
      // RQ-62(fe.md 입력 처리): 캔버스 클릭 시 포인터 락 요청. ESC/포커스
      // 이탈 해제는 브라우저 표준 동작(attachPointerLock 주석 참고).
      onCreated={(canvasState) => {
        attachPointerLock(canvasState.gl.domElement)
      }}
    >
      <color attach="background" args={['#c2b49a']} />
      <hemisphereLight intensity={1.2} groundColor="#8a7a5c" />
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[WORLD.SIZE_M, WORLD.SIZE_M]} />
        <meshStandardMaterial color="#8a7a5c" />
      </mesh>
      <gridHelper args={[WORLD.SIZE_M, WORLD.SIZE_M]} />
      <PlayerMeshes store={store} connection={connection} />
    </Canvas>
  )
}
