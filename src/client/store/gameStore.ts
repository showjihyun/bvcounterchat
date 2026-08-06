import { createStore } from 'zustand/vanilla'
import type { StoreApi } from 'zustand/vanilla'
import type { MoveState } from '@shared/sim/movement'
import { UI } from '@shared/constants'

/**
 * game state 레이어(`harness/workflow/fe.md`) — 서버 스냅샷의 클라이언트
 * 캐시. RQ-61: 진실 공급원은 서버다. 이 store는 서버가 보낸 값을 그대로
 * 반영할 뿐 새 진실을 만들지 않는다 — 예측(RQ-62)·보간(RQ-63)은 여기 없다.
 *
 * `zustand/vanilla`(DOM 비의존)를 쓴다 — netcode 레이어(`src/client/net/`)가
 * React 트리 밖에서도 이 store를 갱신할 수 있어야 하고, node 환경(단위
 * 테스트)에서도 임포트만으로 크래시하지 않아야 하기 때문이다.
 */

export interface ClientPlayer {
  nickname: string
  x: number
  y: number
  z: number
  /** 서버 확정 HP(RQ-14). **표시 판정에만 쓴다** — 클라가 이 값으로 무엇을
   * 확정하지 않는다(RQ-61). RQ-56 이름표가 시신을 거르려면 필요하다:
   * 서버 `handleFire`가 `canAct(player.hp)`로 시신을 사격 후보에서 빼므로,
   * 클라가 그 필터를 못 하면 **시신 이름이 뜨는데 총알은 뒤의 산 사람을
   * 맞히는** 상태가 된다(PR #66 리뷰 blocker 1). 스키마가 이미 동기화한다. */
  hp: number
}

export interface ClientSpectator {
  nickname: string
}

/** RQ-40 채팅 브로드캐스트·이력 항목 shape — 서버(`GameRoom.ts`의
 * `ChatMessage`)와 동일 필드. */
export interface ChatMessage {
  nickname: string
  text: string
}

/**
 * 서버 스냅샷 컬렉션의 최소 구조적 타입 — 표준 `Map.forEach` 시그니처만
 * 요구한다. 순정 `Map`(단위 테스트)과 Colyseus `MapSchema<V>`(실 접속,
 * `implements Map<K, V>`) 양쪽 모두 이 타입을 만족한다.
 */
/** 서버 스냅샷에서 **읽는 필드만** — `ClientPlayer`를 재사용하지 않는다.
 * 둘은 우연히 모양이 같을 뿐 다른 것이다(하나는 와이어 스키마의 부분집합,
 * 하나는 클라 뷰 모델). 재사용하면 클라 뷰에 필드를 더할 때 **서버 값 타입까지
 * 함께 좁아져** 무관한 테스트 픽스처가 깨진다 — RQ-56이 `hp`를 들이면서
 * 실제로 그렇게 됐다(원장 24ab). */
export interface ServerPlayerSnapshot {
  nickname: string
  x: number
  y: number
  z: number
  hp: number
}

export interface ServerStateSnapshot {
  players: { forEach(cb: (value: ServerPlayerSnapshot, key: string) => void): void }
  spectators: { forEach(cb: (value: ClientSpectator, key: string) => void): void }
  tick: number
}

export interface GameStoreState {
  /** 접속 전 null — 서버가 접속을 확정하기 전엔 자기 식별이 없다(RQ-61). */
  selfSessionId: string | null
  tick: number
  players: Map<string, ClientPlayer>
  spectators: Map<string, ClientSpectator>
  /** 자기 자신의 예측 이동 상태(RQ-62 GA-34/35, ADR-0003). netcode 레이어
   * (`src/client/net/connection.ts`)가 로컬 예측·재조정 결과를 반영한다.
   * 첫 예측·재조정 전에는 null — scene 레이어(`PlayerMeshes`)는 null이면
   * 서버 스냅샷(`players`)으로 폴백해 렌더링한다. */
  selfPredictedState: MoveState | null
  /**
   * RQ-40 채팅 로그(리뷰 M1·M3, `_workspace/review/feat-RQ-40-chat.md`) —
   * netcode 레이어(`src/client/net/connection.ts`)가 서버 브로드캐스트·
   * 이력 복원을 반영하는 **유일한** 곳. HUD(`ChatPanel.tsx`)는 이 값을
   * `useStore()`로 구독만 한다(fe.md 레이어 단방향 규칙 — netcode → game
   * state → HUD). RQ-61: 클라이언트가 스스로 메시지를 추가하지 않는다
   * (자기 메시지도 서버 브로드캐스트로만 들어온다). 최근
   * `UI.CHAT_HISTORY`(50)개로 상한 — 서버(`GameRoom.ts`)와 같은 상수를
   * 재사용한다(ADR-0010 값 복제 금지, M3). 상설 세션(RQ-04)에서 무제한
   * 누적을 막는다.
   */
  chatLog: ChatMessage[]
  setSelfSessionId(sessionId: string): void
  setSelfPredictedState(state: MoveState): void
  applyServerState(state: ServerStateSnapshot): void
  /** 실시간 'chat' 브로드캐스트 1건을 로그 끝에 추가한다(상한 적용). */
  addChatMessage(message: ChatMessage): void
  /** 'chat-history' 이력 복원(접속·재접속 시 1회) — 로그 전체를 교체한다
   * (상한 적용, 서버가 이미 50개 이하로 보내지만 방어적으로 다시 자른다). */
  setChatLog(messages: ChatMessage[]): void
}

export function createGameStore(): StoreApi<GameStoreState> {
  return createStore<GameStoreState>((set) => ({
    selfSessionId: null,
    tick: 0,
    players: new Map(),
    spectators: new Map(),
    selfPredictedState: null,
    chatLog: [],

    setSelfSessionId(sessionId) {
      set({ selfSessionId: sessionId })
    },

    setSelfPredictedState(state) {
      set({ selfPredictedState: state })
    },

    addChatMessage(message) {
      set((state) => ({ chatLog: [...state.chatLog, message].slice(-UI.CHAT_HISTORY) }))
    },

    setChatLog(messages) {
      set({ chatLog: messages.slice(-UI.CHAT_HISTORY) })
    },

    // 스냅샷 전체 교체 계약 — 이전 호출엔 있었지만 이번 스냅샷에 없는
    // sessionId는 자연히 빠진다(퇴장 반영, 별도 remove 액션 불필요).
    // 같은 sessionId도 매번 새 값으로 완전히 교체한다(누적·보간 없음).
    applyServerState(state) {
      const players = new Map<string, ClientPlayer>()
      state.players.forEach((value, sessionId) => {
        players.set(sessionId, { nickname: value.nickname, x: value.x, y: value.y, z: value.z, hp: value.hp })
      })

      const spectators = new Map<string, ClientSpectator>()
      state.spectators.forEach((value, sessionId) => {
        spectators.set(sessionId, { nickname: value.nickname })
      })

      set({ players, spectators, tick: state.tick })
    },
  }))
}
