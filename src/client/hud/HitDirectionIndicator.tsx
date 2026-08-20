import { useEffect, useState } from 'react'
import type { StoreApi } from 'zustand/vanilla'
import type { UiStoreState } from '@client/store/uiStore'

/**
 * RQ-58 피격 방향(원장 24cv) — 자신이 총알에 맞으면 화면 가장자리에
 * 방향성 그라데이션을 표시한다(맞은 쪽 가장자리가 물든다). 정밀 각도·
 * 좌표·화살표는 그리지 않는다(사용자 결정 — 8방위 화살표 기각).
 *
 * 방향(`uiStore.hitDirectionEdge`)은 `@client/hud/hitDirectionEdge`가
 * 이벤트의 표면 법선과 **자신의** 카메라 yaw만으로 유도한 값이다 — 사수
 * 좌표를 재구성하지 않는다(ADR-0016 결정 1). 이 컴포넌트는 그 결과(가장자리
 * 하나)를 그리기만 한다.
 *
 * **렌더 계층 면제 대상**(ADR-0008 §6). `Crosshair.tsx`·`Nameplate.tsx`·
 * `HitMarker.tsx`와 같은 구조(구독 → `useState`).
 */
export function HitDirectionIndicator({ uiStore }: { uiStore: StoreApi<UiStoreState> }) {
  const [edge, setEdge] = useState(() => uiStore.getState().hitDirectionEdge)

  useEffect(() => {
    setEdge(uiStore.getState().hitDirectionEdge)
    return uiStore.subscribe((state) => {
      setEdge(state.hitDirectionEdge)
    })
  }, [uiStore])

  if (!edge) return null

  return <div className={`hud__hit-direction hud__hit-direction--${edge}`} aria-hidden="true" />
}
