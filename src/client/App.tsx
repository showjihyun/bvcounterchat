import { Canvas } from '@react-three/fiber'
import { WORLD } from '@shared/constants'

/**
 * 애플리케이션 셸 (ADR-0001, `harness/workflow/fe.md`).
 *
 * 레이어 규칙: R3F 캔버스는 3D만 그리고, HUD(RQ-50~55)는 캔버스 **밖의
 * 일반 DOM**으로 만든다. 텍스트 렌더링·접근성·리렌더 비용 때문이다.
 * 이 파일이 그 경계를 고정한다.
 *
 * 로드맵 1단계 범위: 렌더 파이프라인이 실제로 도는지 확인하는 최소 장면.
 * 실제 맵(RQ-30)·HUD(RQ-50~55)·넷코드(RQ-60~64)는 이후 단계에서 붙인다.
 */
export function App() {
  return (
    <div className="app">
      <Canvas
        // ADR-0001: WebGL2 고정. WebGPU는 쓰지 않는다.
        gl={{ powerPreference: 'high-performance', antialias: false }}
        camera={{ fov: 75, position: [0, 1.7, 5], near: 0.1, far: WORLD.SIZE_M * 2 }}
      >
        <color attach="background" args={['#c2b49a']} />
        <hemisphereLight intensity={1.2} groundColor="#8a7a5c" />
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#a8886a" />
        </mesh>
        <gridHelper args={[WORLD.SIZE_M, WORLD.SIZE_M]} />
      </Canvas>

      {/* HUD 레이어 — 캔버스 밖 DOM. 현재는 자리표시만 있다. */}
      <div className="hud" aria-live="polite">
        <span className="hud__placeholder">ChatStrike — 초기화됨</span>
      </div>
    </div>
  )
}
