import { Room } from 'colyseus'

/**
 * 'game' 룸 — RQ-04 상설 세션.
 *
 * 서버 전역에 이 룸은 단 하나만 존재해야 한다(GA-29). 동시 `joinOrCreate`
 * 경쟁으로 룸이 중복 생성되지 않도록 하는 것은 Colyseus 매치메이커가
 * 이미 보장한다 — `concurrentJoinOrCreateRoomLock`
 * (`node_modules/@colyseus/core/build/MatchMaker.js`)이 룸 이름당 생성을
 * 직렬화한다. `maxClients`도 건드리지 않는다(기본값 Infinity) — 정원
 * 제한(RQ-03)은 이 RQ의 범위 밖이다.
 *
 * 게임 상태(위치·HP·킬 등)는 여기서 다루지 않는다 — RQ-10 이후 붙는다.
 * RQ-04는 세션 생명주기만이 범위다.
 */
export class GameRoom extends Room {
  // RQ-04: 마지막 참여자가 나가 0명이 돼도 룸을 폐기하지 않는다 —
  // 라운드·매치 종료 없는 상설 세션. Colyseus 기본값(true)은 빈 방을
  // 자동 dispose하므로 반드시 꺼야 한다(GA-26).
  override autoDispose = false
}
