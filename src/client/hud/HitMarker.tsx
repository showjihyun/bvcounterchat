import { useEffect, useState } from 'react'
import type { StoreApi } from 'zustand/vanilla'
import type { UiStoreState } from '@client/store/uiStore'

/**
 * RQ-57 히트마커(원장 24cv) — 자신이 쏜 총알이 다른 플레이어에 명중하면
 * 크로스헤어(RQ-54) 위에 겹치는 일시적 표시. 벽 명중·남이 남을 맞힌
 * 명중에는 뜨지 않는다(GA-122·요구 "자신의 명중에만") — 그 가름은
 * `@client/effects/hitFeedback`의 `applyHitReaction`이 이미 끝냈다. 이
 * 컴포넌트는 `uiStore.hitMarkerVisible`(신호 유무)만 본다.
 *
 * ⚠️ **확인음은 이 라운드에 없다** — RQ-57 문면의 "확인음" 절반은 오디오
 * 라운드(3/4)가 받는다(원장 24cv "이 라운드는 RQ-57을 절반만 한다").
 *
 * **렌더 계층 면제 대상**(ADR-0008 §6, `harness/workflow/fe.md`). 판단은
 * 전부 순수 층에 있다 — 관계 판정(`classifyHitRelation`)·자격 판정
 * (`applyHitReaction`)·TTL(`advanceHitFeedback`). 여기서는 그 결과를
 * 그리기만 한다 — `Crosshair.tsx`·`Nameplate.tsx`와 같은 구조(구독 →
 * `useState`).
 *
 * ⚠️ **크로스헤어를 옮기지 않는다** — `index.css`의 "화면 중앙 = 서버 판정
 * 레이"가 크로스헤어 정중앙의 근거다(RQ-54). 이 마커는 크로스헤어와 같은
 * 중심점 위에 **겹칠** 뿐이다.
 */
export function HitMarker({ uiStore }: { uiStore: StoreApi<UiStoreState> }) {
  const [visible, setVisible] = useState(() => uiStore.getState().hitMarkerVisible)

  useEffect(() => {
    // 구독 시점과 첫 렌더 사이에 값이 바뀌었을 수 있다 — 한 번 맞추고 시작한다.
    setVisible(uiStore.getState().hitMarkerVisible)
    return uiStore.subscribe((state) => {
      setVisible(state.hitMarkerVisible)
    })
  }, [uiStore])

  if (!visible) return null

  return (
    <div className="hud__hit-marker" aria-hidden="true">
      <span className="hud__hit-marker-line hud__hit-marker-line--nwse" />
      <span className="hud__hit-marker-line hud__hit-marker-line--nesw" />
    </div>
  )
}
