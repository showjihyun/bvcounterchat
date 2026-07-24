import { createStore } from 'zustand/vanilla'
import type { StoreApi } from 'zustand/vanilla'
import type { MoveState } from '@shared/sim/movement'

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
}

export interface ClientSpectator {
  nickname: string
}

/**
 * 서버 스냅샷 컬렉션의 최소 구조적 타입 — 표준 `Map.forEach` 시그니처만
 * 요구한다. 순정 `Map`(단위 테스트)과 Colyseus `MapSchema<V>`(실 접속,
 * `implements Map<K, V>`) 양쪽 모두 이 타입을 만족한다.
 */
export interface ServerStateSnapshot {
  players: { forEach(cb: (value: ClientPlayer, key: string) => void): void }
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
  setSelfSessionId(sessionId: string): void
  setSelfPredictedState(state: MoveState): void
  applyServerState(state: ServerStateSnapshot): void
}

export function createGameStore(): StoreApi<GameStoreState> {
  return createStore<GameStoreState>((set) => ({
    selfSessionId: null,
    tick: 0,
    players: new Map(),
    spectators: new Map(),
    selfPredictedState: null,

    setSelfSessionId(sessionId) {
      set({ selfSessionId: sessionId })
    },

    setSelfPredictedState(state) {
      set({ selfPredictedState: state })
    },

    // 스냅샷 전체 교체 계약 — 이전 호출엔 있었지만 이번 스냅샷에 없는
    // sessionId는 자연히 빠진다(퇴장 반영, 별도 remove 액션 불필요).
    // 같은 sessionId도 매번 새 값으로 완전히 교체한다(누적·보간 없음).
    applyServerState(state) {
      const players = new Map<string, ClientPlayer>()
      state.players.forEach((value, sessionId) => {
        players.set(sessionId, { nickname: value.nickname, x: value.x, y: value.y, z: value.z })
      })

      const spectators = new Map<string, ClientSpectator>()
      state.spectators.forEach((value, sessionId) => {
        spectators.set(sessionId, { nickname: value.nickname })
      })

      set({ players, spectators, tick: state.tick })
    },
  }))
}
