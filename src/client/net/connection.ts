import { Client } from 'colyseus.js'
import type { Room } from 'colyseus.js'
import type { StoreApi } from 'zustand/vanilla'
import type { GameStoreState } from '@client/store/gameStore'
import type { MoveInput, MoveState } from '@shared/sim/movement'
import { createClientPredictor, type AuthoritativeMoveState, type ClientPredictor } from '@client/net/prediction'
import {
  createRemoteEntityInterpolator,
  type InterpolationPosition,
  type RemoteEntityInterpolator,
} from '@client/net/interpolation'
import { NET } from '@shared/constants'

/** 서버 전역에 상설 세션은 이 룸 하나뿐이다(RQ-04 GA-29, `GameRoom` 참고). */
const ROOM_NAME = 'game'

/**
 * 원격 엔티티 보간 지연(ms, RQ-63). ADR-0003이 제시한 범위("한 스냅샷
 * 간격 이상, 약 33~66ms")의 상한 쪽 — 2 스냅샷 간격을 택한다. v1 전송
 * 레이트가 틱 레이트와 동일(30Hz, ADR-0003 "스냅샷 레이트 vs 틱 레이트")
 * 하더라도 실제 네트워크 지터(패치 도착 간격의 불규칙성, GA-38)를 흡수할
 * 여유를 한 스냅샷치 더 확보한다 — 하한(한 스냅샷 간격)만 쓰면 지터가
 * 조금만 커져도 "보간할 다음 스냅샷이 아직 없는" 고정 경계에 자주
 * 빠진다. `interpolation.ts`의 `delayMs`는 필수 인자라 임의의 기본값을
 * 모듈 내부에 두지 않는다(§2.5) — 이 값이 그 필수 인자에 배선 계층이
 * 주입하는 프로덕션 판단이다.
 */
const INTERPOLATION_DELAY_MS = NET.TICK_MS * 2

/**
 * 실제 시각(ms) 실측 — 이 모듈이 유일하게 성능 시계를 읽는 지점이다
 * (ADR-0008 정신: 순수 보간·예측 로직은 값 주입만 받고, 실시간 API 호출은
 * 배선 계층 한 곳에 모은다, team-lead 지시). 스냅샷 수신 시각 스탬프
 * (`RemoteSnapshot.receivedAt`)와 렌더 조회 시각(`GameConnection.now`)이
 * 이 함수 하나만 공유하므로 두 시각이 서로 다른 축으로 갈라지지 않는다.
 */
function now(): number {
  return performance.now()
}

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

/**
 * `room.state.players`를 순회하며 자기 자신을 제외한 원격 플레이어의 위치를
 * 콜백에 넘긴다(RQ-63 보간 배선). `readSelfAuthoritativeState`와 동일하게
 * 구조적 타입으로 최소한만 요구한다 — 순정 객체(단위 테스트)와 Colyseus
 * `MapSchema`(실 접속) 양쪽 모두 만족한다.
 */
function forEachRemotePlayer(
  room: Room,
  selfSessionId: string,
  cb: (sessionId: string, position: InterpolationPosition) => void,
): void {
  const state = room.state as {
    players?: {
      forEach?: (cb2: (value: { x?: unknown; y?: unknown; z?: unknown }, key: string) => void) => void
    }
  } | null
  state?.players?.forEach?.((value, sessionId) => {
    if (sessionId === selfSessionId) return
    if (typeof value?.x === 'number' && typeof value?.y === 'number' && typeof value?.z === 'number') {
      cb(sessionId, { x: value.x, y: value.y, z: value.z })
    }
  })
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
   * 다른 플레이어 보간 매니저(RQ-63). 렌더 레이어(`PlayerMeshes.tsx`)가
   * `useFrame` 안에서 `copyPositionInto`로 소비한다(할당 없이 읽는 진입점 —
   * `getPosition`은 단위 테스트 계약 전용, 매 호출 새 객체를 반환한다).
   */
  interpolator: RemoteEntityInterpolator
  /**
   * 현재 렌더 시각(ms) 조회 — `interpolator.getPosition`/`copyPositionInto`의
   * `renderTime` 인자용. 실제 시각 실측(`performance.now()`)은 이 모듈의
   * `now()` 하나로 모은다(ADR-0008, 위 상단 주석) — 호출자(scene 레이어)가
   * 직접 `performance.now()`를 부르지 않아도 되게 한다.
   */
  now(): number
  /**
   * 로컬 입력을 즉시 예측에 반영하고(RQ-62 GA-34) 시퀀스 번호를 실어
   * 서버로 전송한다(ADR-0003 입력 커맨드 버퍼). 몇 Hz로 호출할지는
   * 호출자(`src/client/input/` 캡처 루프)가 정한다 — 이 함수 자체는
   * 빈도를 규정하지 않는다.
   */
  sendMoveInput(input: MoveInput): void
  /**
   * 침묵 disconnect(사용자가 `disconnect()`를 호출하지 않은 연결 종료 —
   * 네트워크 단절 등 `room.onLeave`가 발생하는 모든 경우, 명시적
   * `disconnect()`가 유발하는 consented leave도 포함) 발생 시 `callback`을
   * 호출한다. 반환값은 구독 해제 함수(`store.subscribe` 관례와 동일) — 호출
   * 측(`App.tsx`)이 자신의 이펙트 cleanup에서 해제한다. 20d 부기(20b
   * 후속 + RQ-62 minor ①의 병합 이월) — `App.tsx`가 이를 구독해
   * `connection` state를 `null`로 되돌리면 기존 `useEffect` cleanup이 이동
   * 입력 전송 인터벌을 자연히 정리한다.
   */
  onDisconnect(callback: () => void): () => void
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
  const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(
    room.sessionId,
    INTERPOLATION_DELAY_MS,
  )

  // 이름 붙인 핸들러로 보관 — `disconnect()`가 `room.onStateChange.remove(...)`
  // 로 해제할 수 있어야 한다(20b 리뷰 minor 3: 이전엔 익명 함수라 구독을
  // 보관하지 못했다).
  function handleStateChange(): void {
    store.getState().applyServerState(room.state)

    const authoritative = readSelfAuthoritativeState(room)
    if (authoritative) {
      const reconciled = predictor.reconcile(authoritative)
      store.getState().setSelfPredictedState(reconciled)
    }

    // RQ-63: 이번 패치에 실린 원격 플레이어 위치를 전부 이 스냅샷 하나의
    // 수신 시각으로 보간 버퍼에 먹인다 — 패치 안의 모든 플레이어가 같은
    // 순간의 상태이므로 시각을 한 번만 실측해 공유한다.
    const receivedAt = now()
    forEachRemotePlayer(room, room.sessionId, (sessionId, position) => {
      interpolator.addSnapshot(sessionId, { ...position, receivedAt })
    })
  }

  room.onStateChange(handleStateChange)

  return {
    sessionId: room.sessionId,
    room,
    interpolator,
    now,
    sendMoveInput(input: MoveInput): void {
      const { seq, predicted } = predictor.applyInput(input)
      store.getState().setSelfPredictedState(predicted)
      room.send('move', { ...input, seq })
    },
    onDisconnect(callback: () => void): () => void {
      const handleLeave = (): void => callback()
      room.onLeave(handleLeave)
      return () => room.onLeave.remove(handleLeave)
    },
    async disconnect() {
      room.onStateChange.remove(handleStateChange)
      await room.leave(true)
    },
  }
}
