import { createStore } from 'zustand/vanilla'
import type { StoreApi } from 'zustand/vanilla'

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
}

export function createUiStore(): StoreApi<UiStoreState> {
  return createStore<UiStoreState>((set) => ({
    chatFocused: false,

    setChatFocused(focused) {
      set({ chatFocused: focused })
    },
  }))
}
