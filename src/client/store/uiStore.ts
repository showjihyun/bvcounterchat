import { createStore } from 'zustand/vanilla'
import type { StoreApi } from 'zustand/vanilla'
import { CROSSHAIR } from '@client/config/design-tokens'

/**
 * 순수 클라이언트 UI 상태(`harness/workflow/fe.md` "포커스 상태를 game
 * state(또는 별도 UI 상태)에 두고" — 이 store가 그 "별도 UI 상태"다).
 * `gameStore`(서버 스냅샷 캐시, RQ-61)와 의도적으로 분리한다 — 채팅 입력
 * 포커스는 서버가 확정하는 값이 아니라 이 브라우저 탭 안에서만 의미 있는
 * 순수 UI 신호라, "서버가 진실"이라는 gameStore의 계약과 섞이면 안 된다.
 *
 * RQ-40 입력 차단: `ChatPanel`(HUD)이 입력창 포커스/블러에서 이 값을
 * 갱신하고, `PlayerControls`(scene, 배선 계층)가 이동·발사 핸들러 최상단
 * 에서 `@client/input/chatInputGate`에 이 값을 넘겨 게이트한다.
 */
export interface UiStoreState {
  chatFocused: boolean
  setChatFocused(focused: boolean): void
  /** RQ-54 크로스헤어 간격(px) — `@client/hud/crosshairSpread`가 계산한 값(원장 24e).
   * HUD는 캔버스 밖 DOM이라 이 값이 바뀌면 React가 리렌더한다. */
  crosshairGapPx: number
  /** RQ-56 이름표(원장 24ab) — 조준선이 향한 대상이 없으면 `null`.
   * 화면 좌표(px)는 `PlayerControls`가 3D 앵커를 투영해 채운다. */
  nameplate: { nickname: string; xPx: number; yPx: number } | null
  /** ⚠️ **값이 실제로 달라질 때만 `set`한다**(ADR-0001 프레임 예산). 호출부는
   * 30Hz 입력 루프라 매초 30번 불리는데, 그대로 `set`하면 tier가 그대로여도
   * 리렌더가 30fps로 돈다. tier는 3단계뿐이라 실제 변화는 드물다. */
  setCrosshairGapPx(gapPx: number): void
  /** 값이 실질적으로 같으면 `set`하지 않는다 — 30Hz 루프가 매 틱 부른다. */
  setNameplate(next: { nickname: string; xPx: number; yPx: number } | null): void
  /** 포인터 락 상태(원장 24e-2). 락이 없으면 시점이 안 돌고 커서가 창을
   * 벗어난다 — 사용자가 "클릭해야 한다"를 알 방법이 화면에 있어야 한다. */
  pointerLocked: boolean
  setPointerLocked(locked: boolean): void
}

export function createUiStore(): StoreApi<UiStoreState> {
  return createStore<UiStoreState>((set, get) => ({
    chatFocused: false,
    crosshairGapPx: CROSSHAIR.gapPx,
    nameplate: null,
    pointerLocked: false,

    setChatFocused(focused) {
      set({ chatFocused: focused })
    },

    setNameplate(next) {
      const current = get().nameplate
      if (current === null && next === null) return
      // 픽셀 좌표는 매 틱 미세하게 흔들리므로 **정수 픽셀**로 비교한다 —
      // 그러지 않으면 조준을 멈춰도 리렌더가 30Hz로 계속 돈다.
      if (
        current !== null &&
        next !== null &&
        current.nickname === next.nickname &&
        Math.round(current.xPx) === Math.round(next.xPx) &&
        Math.round(current.yPx) === Math.round(next.yPx)
      ) {
        return
      }
      set({ nameplate: next })
    },
    setCrosshairGapPx(gapPx) {
      if (get().crosshairGapPx === gapPx) return
      set({ crosshairGapPx: gapPx })
    },

    setPointerLocked(locked) {
      if (get().pointerLocked === locked) return
      set({ pointerLocked: locked })
    },
  }))
}
