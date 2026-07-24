import { Client } from 'colyseus.js'
import type { Room } from 'colyseus.js'
import type { StoreApi } from 'zustand/vanilla'
import type { GameStoreState } from '@client/store/gameStore'

/** 서버 전역에 상설 세션은 이 룸 하나뿐이다(RQ-04 GA-29, `GameRoom` 참고). */
const ROOM_NAME = 'game'

export interface GameConnection {
  sessionId: string
  /**
   * colyseus.js Room 원본 그대로 노출한다. 이 PR은 "입력 전송"(키보드 →
   * 네트워크 메시지 체계)을 만들지 않지만, RQ-40(채팅)·RQ-42(스프레이) 등
   * 후속 PR이 결국 이 채널로 메시지를 보낸다 — net 모듈이 감추면 그 PR들이
   * room 접근 경로를 다시 만들어야 한다.
   */
  room: Room
  disconnect(): Promise<void>
}

/**
 * netcode 레이어 진입점(`harness/workflow/fe.md`: netcode → game state).
 * 서버에 접속해 스냅샷 구독을 store까지 배선한다.
 *
 * RQ-61: 자기 식별(`setSelfSessionId`)은 네트워크 상태 동기화가 아니라
 * 접속 성공 자체에서 나오는 로컬 정보라 스냅샷 도착을 기다리지 않고
 * 반환 전에 동기적으로 반영한다. 이후 `room.onStateChange` 구독이 매
 * 패치마다 서버 스냅샷을 store에 그대로 반영한다 — 이 함수는 서버가 보낸
 * 값을 캐시할 뿐 새 진실을 만들지 않는다.
 */
export async function connectToGame(
  endpoint: string,
  nickname: string,
  store: StoreApi<GameStoreState>,
): Promise<GameConnection> {
  const client = new Client(endpoint)
  const room = await client.joinOrCreate(ROOM_NAME, { nickname })

  store.getState().setSelfSessionId(room.sessionId)

  room.onStateChange(() => {
    store.getState().applyServerState(room.state)
  })

  return {
    sessionId: room.sessionId,
    room,
    async disconnect() {
      await room.leave(true)
    },
  }
}
