import { Client } from 'colyseus.js'
import type { Room } from 'colyseus.js'
import type { StoreApi } from 'zustand/vanilla'
import type { GameStoreState } from '@client/store/gameStore'
import type { MoveInput, MoveState } from '@shared/sim/movement'
import { createClientPredictor, type AuthoritativeMoveState, type ClientPredictor } from '@client/net/prediction'

/** 서버 전역에 상설 세션은 이 룸 하나뿐이다(RQ-04 GA-29, `GameRoom` 참고). */
const ROOM_NAME = 'game'

/** RQ-31(스폰 지점 로테이션)은 스코프 밖 — 서버(`GameRoom.spawnMoveState`)와
 * 동일하게 원점·접지 상태에서 예측을 시작한다. 이 초기값의 정확도는
 * 중요하지 않다 — 첫 서버 스냅샷 도착 시 곧바로 재조정되고(버퍼가
 * 비어 있어 서버 값을 그대로 채택), 이 값은 그 전까지의 짧은 과도
 * 상태일 뿐이다. */
function initialPredictionState(): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true }
}

/**
 * `room.state`에서 자기 플레이어의 권위 이동 상태를 읽는다(RQ-62 재조정
 * 배선). `Player` 스키마는 vx·vy·vz·lastProcessedInputSeq 4필드만 노출한다
 * (21a-2 확정) — `grounded`는 와이어에 없다. `@shared/sim/movement`의 현재
 * 구현에서는 `grounded === (y === 0)`이 항상 성립하므로(`rq-62-prediction
 * .test.ts` 참고 절) 이렇게 파생한다 — movement.ts 내부 구현에 대한
 * 암묵적 의존이며, movement.ts가 바뀌면 재확인이 필요하다.
 *
 * 필드가 아직 없거나(패치 도착 전) 자신이 관전자(RQ-41, players 맵 밖)라
 * 위치가 없으면 undefined — 호출자는 이 경우 재조정을 건너뛴다.
 */
function readSelfAuthoritativeState(room: Room): AuthoritativeMoveState | undefined {
  const state = room.state as {
    players?: {
      get?: (key: string) =>
        | {
            x?: unknown
            y?: unknown
            z?: unknown
            vx?: unknown
            vy?: unknown
            vz?: unknown
            lastProcessedInputSeq?: unknown
          }
        | undefined
    }
  } | null
  const player = state?.players?.get?.(room.sessionId)
  if (
    typeof player?.x === 'number' &&
    typeof player?.y === 'number' &&
    typeof player?.z === 'number' &&
    typeof player?.vx === 'number' &&
    typeof player?.vy === 'number' &&
    typeof player?.vz === 'number' &&
    typeof player?.lastProcessedInputSeq === 'number'
  ) {
    return {
      x: player.x,
      y: player.y,
      z: player.z,
      vx: player.vx,
      vy: player.vy,
      vz: player.vz,
      grounded: player.y === 0,
      lastProcessedInputSeq: player.lastProcessedInputSeq,
    }
  }
  return undefined
}

export interface GameConnection {
  sessionId: string
  /**
   * colyseus.js Room 원본 그대로 노출한다. 이 PR은 "입력 전송"(키보드 →
   * 네트워크 메시지 체계)을 만들지 않지만, RQ-40(채팅)·RQ-42(스프레이) 등
   * 후속 PR이 결국 이 채널로 메시지를 보낸다 — net 모듈이 감추면 그 PR들이
   * room 접근 경로를 다시 만들어야 한다.
   */
  room: Room
  /**
   * 로컬 입력을 즉시 예측에 반영하고(RQ-62 GA-34) 시퀀스 번호를 실어
   * 서버로 전송한다(ADR-0003 입력 커맨드 버퍼). 몇 Hz로 호출할지는
   * 호출자(`src/client/input/` 캡처 루프)가 정한다 — 이 함수 자체는
   * 빈도를 규정하지 않는다.
   */
  sendMoveInput(input: MoveInput): void
  disconnect(): Promise<void>
}

/**
 * netcode 레이어 진입점(`harness/workflow/fe.md`: netcode → game state).
 * 서버에 접속해 스냅샷 구독을 store까지 배선하고, 로컬 입력 예측+재조정
 * (RQ-62, ADR-0003)을 함께 배선한다.
 *
 * RQ-61: 자기 식별(`setSelfSessionId`)은 네트워크 상태 동기화가 아니라
 * 접속 성공 자체에서 나오는 로컬 정보라 스냅샷 도착을 기다리지 않고
 * 반환 전에 동기적으로 반영한다. 이후 `room.onStateChange` 구독이 매
 * 패치마다 서버 스냅샷을 store에 그대로 반영하고(RQ-61 캐시), 이어서
 * 자기 자신의 예측을 서버 값으로 재조정한다(RQ-62 GA-35) — 이 함수는
 * 서버가 보낸 값을 캐시·재조정할 뿐 새 진실을 만들지 않는다.
 */
export async function connectToGame(
  endpoint: string,
  nickname: string,
  store: StoreApi<GameStoreState>,
): Promise<GameConnection> {
  const client = new Client(endpoint)
  const room = await client.joinOrCreate(ROOM_NAME, { nickname })

  store.getState().setSelfSessionId(room.sessionId)

  const predictor: ClientPredictor = createClientPredictor(initialPredictionState())

  room.onStateChange(() => {
    store.getState().applyServerState(room.state)

    const authoritative = readSelfAuthoritativeState(room)
    if (authoritative) {
      const reconciled = predictor.reconcile(authoritative)
      store.getState().setSelfPredictedState(reconciled)
    }
  })

  return {
    sessionId: room.sessionId,
    room,
    sendMoveInput(input: MoveInput): void {
      const { seq, predicted } = predictor.applyInput(input)
      store.getState().setSelfPredictedState(predicted)
      room.send('move', { ...input, seq })
    },
    async disconnect() {
      await room.leave(true)
    },
  }
}
