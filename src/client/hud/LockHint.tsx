import { useEffect, useState } from 'react'
import type { StoreApi } from 'zustand/vanilla'
import type { UiStoreState } from '@client/store/uiStore'

/**
 * 포인터 락 안내(원장 24e-2) — 22b가 넣은 개발용 표시(`ChatStrike — 접속됨`)를
 * **상태 인식형으로 교체**한 것이다. 새 HUD 요소를 만든 것이 아니다(RQ-50~55에
 * 이런 요소는 없다 — 스펙에 없는 기능을 추가하지 않는다, CLAUDE.md 금지 1항).
 *
 * **왜 필요한가**: 포인터 락이 걸리지 않으면 ① 커서가 브라우저 창을 벗어나고
 * ② `mouseLook`이 mousemove를 전부 무시해 **시점이 아예 안 돈다**. 그런데
 * "화면을 클릭해야 락이 걸린다"는 것을 알려 주는 것이 화면에 **하나도 없었다** —
 * 사용자가 실제로 그 증상을 보고했고 원인을 알 수 없었다.
 *
 * ⚠️ **시각 디자인은 `DESIGN.md`가 정하지 않았다** — 이 요소는 스펙에 없는
 * 개발 보조라 §3 요소별 스펙에 자리가 없다. 토큰만 쓰고(리터럴 금지, 원장 24a)
 * 정식 디자인은 RQ-50~55 라운드가 이 자리를 어떻게 할지 정할 때 함께 본다.
 *
 * 렌더 계층 면제 대상(ADR-0008 §6).
 */
export function LockHint({ uiStore }: { uiStore: StoreApi<UiStoreState> }) {
  const [locked, setLocked] = useState(() => uiStore.getState().pointerLocked)

  useEffect(() => {
    setLocked(uiStore.getState().pointerLocked)
    return uiStore.subscribe((state) => {
      setLocked(state.pointerLocked)
    })
  }, [uiStore])

  // 락이 걸린 상태(정상 플레이 중)에는 아무것도 띄우지 않는다 — 조준을 가린다.
  if (locked) return null

  return (
    <span className="hud__placeholder">
      화면을 클릭하면 시점 조작이 시작된다 — 이동 WASD · 사격 좌클릭 · 해제 ESC
    </span>
  )
}
