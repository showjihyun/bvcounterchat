import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { StoreApi } from 'zustand/vanilla'
import type { GameStoreState } from '@client/store/gameStore'
import type { GameConnection } from '@client/net/connection'
import type { InterpolationPosition } from '@client/net/interpolation'

const BOX_WIDTH = 0.8
const BOX_HEIGHT = 1.8
const SELF_COLOR = '#5b8dd6'
const OTHER_COLOR = '#c65b5b'

interface PlayerMeshesProps {
  store: StoreApi<GameStoreState>
  connection: GameConnection
}

/**
 * 플레이어 박스 표시(RQ-61: 자기 자신은 예측(RQ-62), 다른 플레이어는
 * 보간(RQ-63) 위치로 렌더한다 — 서버 스냅샷은 두 경로 모두의 원천이지만
 * 표시 자체는 그대로가 아니다).
 *
 * `harness/workflow/fe.md` 규칙 — R3F 컴포넌트 안에서 `useStore()` 구독
 * 금지(store가 30Hz 갱신돼 매 프레임 React 리렌더가 걸린다). 대신 두
 * 경로로 나눈다:
 * - 참가·퇴장(mesh 생성·제거)은 `store.subscribe`(transient)로 처리한다.
 *   React 리렌더 경로를 타지 않고, 실제로 인원이 바뀔 때만 mesh를
 *   만들거나 지운다 — 매 프레임 일어나는 일이 아니다.
 * - 위치 갱신은 `useFrame` 안에서 `getState()`로 직접 읽어 기존 mesh의
 *   `.position`만 `.set()`으로 갱신한다 — 새 객체를 만들지 않는다(프레임
 *   예산 규칙, `harness/workflow/fe.md`). 다른 플레이어 위치는
 *   `connection.interpolator.copyPositionInto`로 얻는다 — `getPosition`
 *   (단위 테스트 계약)과 달리 재사용 버퍼에 덮어써 프레임당 할당이 없다.
 */
export function PlayerMeshes({ store, connection }: PlayerMeshesProps) {
  const groupRef = useRef<THREE.Group>(null)
  const meshesRef = useRef(new Map<string, THREE.Mesh>())
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
    const renderTime = connection.now()
    const interpolated = interpolatedRef.current
    // for...of — Map.forEach의 화살표 콜백은 매 프레임 클로저를 새로 할당한다
    // (리뷰 minor). for...of는 화살표 클로저의 명시적 프레임당 할당을
    // 제거한다(프레임 예산 규칙 — 순회 자체가 할당 0이라는 뜻은 아니다).
    for (const [sessionId, mesh] of meshesRef.current) {
      // RQ-62: 자기 자신은 예측 위치로 렌더한다(GA-34/35, 서버 왕복 지연
      // 없이 즉시 반응) — 서버 스냅샷 그대로 표시하면 지연이 그대로
      // 체감된다. 예측이 아직 없으면(접속 직후) 서버 스냅샷으로 폴백한다.
      if (sessionId === state.selfSessionId && state.selfPredictedState) {
        const predicted = state.selfPredictedState
        mesh.position.set(predicted.x, predicted.y + BOX_HEIGHT / 2, predicted.z)
        continue
      }
      // RQ-63: 다른 플레이어는 지연 버퍼를 반영한 보간 위치로 렌더한다
      // (GA-37/38, ADR-0003) — 아직 스냅샷을 한 번도 받지 못했으면(막
      // 참가해 다음 패치를 기다리는 중) 서버 스냅샷으로 폴백한다.
      if (connection.interpolator.copyPositionInto(sessionId, renderTime, interpolated)) {
        mesh.position.set(interpolated.x, interpolated.y + BOX_HEIGHT / 2, interpolated.z)
        continue
      }
      const player = state.players.get(sessionId)
      if (!player) continue
      mesh.position.set(player.x, player.y + BOX_HEIGHT / 2, player.z)
    }
  })

  return <group ref={groupRef} />
}
