import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { StoreApi } from 'zustand/vanilla'
import type { GameStoreState } from '@client/store/gameStore'

const BOX_WIDTH = 0.8
const BOX_HEIGHT = 1.8
const SELF_COLOR = '#5b8dd6'
const OTHER_COLOR = '#c65b5b'

interface PlayerMeshesProps {
  store: StoreApi<GameStoreState>
}

/**
 * 플레이어 박스 표시(RQ-61: 서버 스냅샷 그대로, 예측·보간 없음 — RQ-62/63
 * 이후).
 *
 * `harness/workflow/fe.md` 규칙 — R3F 컴포넌트 안에서 `useStore()` 구독
 * 금지(store가 30Hz 갱신돼 매 프레임 React 리렌더가 걸린다). 대신 두
 * 경로로 나눈다:
 * - 참가·퇴장(mesh 생성·제거)은 `store.subscribe`(transient)로 처리한다.
 *   React 리렌더 경로를 타지 않고, 실제로 인원이 바뀔 때만 mesh를
 *   만들거나 지운다 — 매 프레임 일어나는 일이 아니다.
 * - 위치 갱신은 `useFrame` 안에서 `getState()`로 직접 읽어 기존 mesh의
 *   `.position`만 `.set()`으로 갱신한다 — 새 객체를 만들지 않는다(프레임
 *   예산 규칙, `harness/workflow/fe.md`).
 */
export function PlayerMeshes({ store }: PlayerMeshesProps) {
  const groupRef = useRef<THREE.Group>(null)
  const meshesRef = useRef(new Map<string, THREE.Mesh>())

  useEffect(() => {
    const current = groupRef.current
    if (!current) return undefined
    // 명시적 타입 애노테이션 — TS는 nested 함수 클로저 안에서 참조할 때
    // `const`의 좁혀진(non-null) 타입을 유지하지 않고 선언 타입으로 되돌린다.
    // 이 한 줄로 아래 `syncMeshes`·cleanup 클로저 안에서도 non-null로
    // 취급되게 한다.
    const group: THREE.Group = current

    const meshes = meshesRef.current

    function syncMeshes(state: GameStoreState): void {
      for (const [sessionId, mesh] of meshes) {
        if (!state.players.has(sessionId)) {
          group.remove(mesh)
          mesh.geometry.dispose()
          ;(mesh.material as THREE.Material).dispose()
          meshes.delete(sessionId)
        }
      }

      state.players.forEach((_player, sessionId) => {
        if (meshes.has(sessionId)) return
        const isSelf = sessionId === state.selfSessionId
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(BOX_WIDTH, BOX_HEIGHT, BOX_WIDTH),
          new THREE.MeshStandardMaterial({ color: isSelf ? SELF_COLOR : OTHER_COLOR }),
        )
        group.add(mesh)
        meshes.set(sessionId, mesh)
      })
    }

    syncMeshes(store.getState())
    const unsubscribe = store.subscribe(syncMeshes)

    return () => {
      unsubscribe()
      for (const mesh of meshes.values()) {
        group.remove(mesh)
        mesh.geometry.dispose()
        ;(mesh.material as THREE.Material).dispose()
      }
      meshes.clear()
    }
  }, [store])

  useFrame(() => {
    const state = store.getState()
    // for...of — Map.forEach의 화살표 콜백은 매 프레임 클로저를 새로 할당한다
    // (리뷰 minor). for...of는 할당 없이 순회한다(프레임 예산 규칙).
    for (const [sessionId, mesh] of meshesRef.current) {
      const player = state.players.get(sessionId)
      if (!player) continue
      mesh.position.set(player.x, player.y + BOX_HEIGHT / 2, player.z)
    }
  })

  return <group ref={groupRef} />
}
