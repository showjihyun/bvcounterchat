import { Client } from 'colyseus.js'
import type { Room } from 'colyseus.js'
import type { StoreApi } from 'zustand/vanilla'
import type { ChatMessage, GameStoreState } from '@client/store/gameStore'
import type { MoveInput, MoveState } from '@shared/sim/movement'
import { createClientPredictor, type AuthoritativeMoveState, type ClientPredictor } from '@client/net/prediction'
import {
  createRemoteEntityInterpolator,
  type InterpolationPosition,
  type RemoteEntityInterpolator,
} from '@client/net/interpolation'
import { createRttEstimator, type RttEstimator } from '@client/net/rttEstimator'
import { NET } from '@shared/constants'
import { ticksToMs } from '@shared/sim/clock'
import type { HitEvent } from '@client/effects/hitFeedback'

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
 * RQ-64 랙 보상 — RTT 추정 EMA 평활 계수(평가 F1 대응,
 * `_workspace/RQ-64/03_evaluator_report.md`). `@client/net/rttEstimator`의
 * `smoothingAlpha`는 필수 인자라(모듈 코멘트 "임의의 튜닝 상수를 모듈
 * 내부에 감추지 않는다") 이 배선 계층이 실제 값을 정한다 — Jacobson/Karels류
 * RTT 추정에서 흔히 쓰이는 자릿수(1/8~1/4)의 중간값을 택했다. 급격한
 * 표본 하나에 과민 반응하지 않으면서도(값이 작을수록 느리게 반응) 실제
 * RTT 변화(혼잡·이동)를 몇 표본 안에 따라잡는다(값이 클수록 빠르게 반응).
 * 정밀 튜닝은 밸런싱 판단이라 이 계약이 규정하지 않는다(`combat-tuning.ts`
 * "값 발명 금지"와 같은 정신 — 여기서는 코드 상수로 두되 근거를 남긴다).
 */
const RTT_SMOOTHING_ALPHA = 0.2

/** RQ-64 랙 보상 — 전용 RTT 측정 ping payload(seq 왕복 전용, `move`의
 * 시퀀스와는 별개 카운터 — `@client/net/rttEstimator`의 `seq`는 "전송 단위를
 * 식별하는 아무 정수"면 되고 `move` 시퀀스와 같은 값일 필요가 없다). */
interface PingPayload {
  seq: number
}

/** RQ-78/ADR-0014 결정 6 — 서버 `broadcast('gunshot', ...)` payload를
 * 클라이언트에서 관측하기 위한 로컬 타입. `GameRoom.ts`의 서버 사본과
 * 같은 shape다(`HitEvent`가 이미 세운 "서버·클라 각자 자신의 사본을
 * 둔다" 선례와 동일한 레이어 경계, 서버는 `@client`를 import하지 않는다).
 * `position`은 사수가 발사 시점에 서 있던 좌표 그대로다(재계산 없음). */
export interface GunshotEvent {
  shooterId: string
  position: { x: number; y: number; z: number }
}

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

/** 서버 상태를 아직 못 읽었을 때만 쓰는 **최후 폴백**이다.
 *
 * RQ-15/16 이전에는 서버도 원점에서 스폰했으므로 이 값이 서버와 일치했다.
 * 지금은 서버가 스폰 로테이션(`@shared/sim/spawn`, 최대 반경 22m)에서
 * 시작하므로 **원점은 더 이상 서버와 같지 않다** — 그래서 아래
 * `connectToGame`이 접속 직후 권위 상태를 먼저 읽어 그것으로 예측을
 * 시드하고, 이 함수는 그마저 없을 때(스키마가 아직 안 채워진 순간)만
 * 쓰인다. 시드가 어긋나면 첫 스냅샷 도착(패치 ~20Hz) 전에 보낸 입력이
 * 원점 기준으로 예측돼 카메라가 스폰 지점까지 한 번 튄다(리뷰 major 3). */
function initialPredictionState(): MoveState {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true }
}

/**
 * `room.state`에서 자기 플레이어의 권위 이동 상태를 읽는다(RQ-62 재조정
 * 배선). `Player` 스키마는 vx·vy·vz·grounded·lastProcessedInputSeq 5필드를
 * 노출한다(RQ-22, `@shared/schema/GameState` 참고) — `grounded`는 서버가
 * 매 틱 권위 값을 직접 싣는 필드라 여기서 그대로 읽는다. 최초 확정
 * (21a-2)은 `grounded === (y === 0)`으로 파생했으나, RQ-22 박스 점프가 그
 * 전제를 깼다(박스 위 착지는 `grounded === true`인데 `y !== 0`) — 그래서
 * 파생을 걷어내고 스키마 필드를 직접 읽는다(`vx`·`vz`·
 * `lastProcessedInputSeq`와 동일한 "스키마에 존재 → 그대로 읽는다" 처리,
 * `rq-62-prediction.test.ts` §103-112 "스코프 밖" 절 참고).
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
            grounded?: unknown
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
    typeof player?.grounded === 'boolean' &&
    typeof player?.lastProcessedInputSeq === 'number'
  ) {
    return {
      x: player.x,
      y: player.y,
      z: player.z,
      vx: player.vx,
      vy: player.vy,
      vz: player.vz,
      grounded: player.grounded,
      lastProcessedInputSeq: player.lastProcessedInputSeq,
    }
  }
  return undefined
}

/** RQ-72(원장 24bs) — 원격 발소리 누적의 두 입력. `readMode`(아래)와 같은
 * 가드 정신이다(필드가 아직 없는 과도기를 안전하게 다룬다). ⚠️ **싣지 않으면
 * 조용히 그럴듯하게 틀린다**: `grounded`가 빠지면 `RemoteSnapshot`의 기본값
 * `true`로 폴백돼 **공중 변위가 누적되고**(GA-85 위반), `hp`가 빠지면 항상
 * `MAX_HP`라 `0 → MAX_HP` 전이가 영원히 안 일어나 **리스폰 리셋이 무동작**
 * 이다(순간이동이 발소리로 샌다). 크래시가 아니라 그럴듯한 오동작이라
 * 배선 누락이 눈에 안 띈다 — PR #75 리뷰 major.
 *
 * ⚠️ **`false`·`0`이 살아남아야 한다.** 호출부의 조건부 스프레드가
 * `!== undefined`로 판정하는 이유다 — `...(hp ? { hp } : {})`로 썼다면
 * `hp: 0`이 실리지 않아 **리스폰 리셋 전체가 무동작**이 된다(= 이 코드가
 * 닫으려는 결함의 재발). 델타 재평가가 그 변이(MD4)를 확인했다.
 *
 * ⚠️ **이 두 함수는 어떤 테스트도 덮지 않는다.** 스프레드를 지우고 원복해도
 * 828+169건이 전부 통과한다(델타 재평가 MD2·MD3 실측). `fe.md`가 배선을
 * 면제하고 선례(`readMode`)도 그렇지만, `mode` 오류는 화면에 보이고 이 둘은
 * **소리만 조용히 어긋난다** — 통합 층에서 잠그는 것이 원장 **24bv**의 몫이다. */
function readGrounded(value: { grounded?: unknown }): boolean | undefined {
  return typeof value.grounded === 'boolean' ? value.grounded : undefined
}

function readHp(value: { hp?: unknown }): number | undefined {
  return typeof value.hp === 'number' && Number.isFinite(value.hp) ? value.hp : undefined
}

/** `value.mode`가 알려진 3종 리터럴 중 하나면 그대로, 아니면(필드
 * 부재·패치 미도착·조작된 값) `undefined`를 반환한다 — `sanitizeMoveInput`
 * (`GameRoom.ts`)의 서버 쪽 방어적 파싱과 동일한 정신, 여기는 신뢰하는
 * 서버 스키마 값을 읽을 뿐이지만 필드가 아직 없는 과도기(구 서버·첫 패치
 * 전)를 안전하게 다루기 위해 같은 가드를 쓴다. */
function readMode(value: { mode?: unknown }): MoveInput['mode'] | undefined {
  return value.mode === 'run' || value.mode === 'walk' || value.mode === 'crouch' ? value.mode : undefined
}

/**
 * `room.state.players`를 순회하며 자기 자신을 제외한 원격 플레이어의 위치·
 * 자세를 콜백에 넘긴다(RQ-63 보간 배선, RQ-92 v2.4 자세 배선).
 * `readSelfAuthoritativeState`와 동일하게 구조적 타입으로 최소한만
 * 요구한다 — 순정 객체(단위 테스트)와 Colyseus `MapSchema`(실 접속) 양쪽
 * 모두 만족한다.
 */
function forEachRemotePlayer(
  room: Room,
  selfSessionId: string,
  cb: (
    sessionId: string,
    position: InterpolationPosition,
    mode: MoveInput['mode'] | undefined,
    grounded: boolean | undefined,
    hp: number | undefined,
  ) => void,
): void {
  const state = room.state as {
    players?: {
      forEach?: (cb2: (value: { x?: unknown; y?: unknown; z?: unknown; mode?: unknown; grounded?: unknown; hp?: unknown }, key: string) => void) => void
    }
  } | null
  state?.players?.forEach?.((value, sessionId) => {
    if (sessionId === selfSessionId) return
    if (typeof value?.x === 'number' && typeof value?.y === 'number' && typeof value?.z === 'number') {
      cb(sessionId, { x: value.x, y: value.y, z: value.z }, readMode(value), readGrounded(value), readHp(value))
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
   * RQ-64 랙 보상 — 사수의 현재 RTT 추정치(ms). 내부적으로 전용 `ping`/
   * `pong` 왕복(평가 F3 대응 — `_workspace/RQ-64/06_evaluator_delta.md`,
   * `@client/net/rttEstimator`)에서 계산한다. `GameRoom`이 틱·패치 지연
   * 없이 즉시 응답하므로 표본이 순수 네트워크 왕복에 가깝다(F1 시도의
   * `move`/`seq` 재사용은 틱·패치 배치 지연이 섞여 폐기됐다). 유효 표본이
   * 아직 없으면 0(되감기 미적용과 동일한 안전한 기본값) —
   * `@client/input/chatInputGate`의 `fire(direction, rttMs)`가 이 값을
   * 그대로 실어 `'fire'` payload에 병합한다.
   */
  getRttMs(): number
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
  /**
   * RQ-78/ADR-0014 결정 6 — 서버 'gunshot' 브로드캐스트 구독. HUD 상태를
   * 만들지 않는 순수 오디오 신호라 `store`를 거치지 않고 수신 즉시
   * 콜백을 호출한다(`onDisconnect`와 동일한 구독 패턴 — `room.onMessage`가
   * 이미 제공하는 구독 해제 함수를 그대로 넘긴다). 볼륨 판정(거리·자기
   * 여부)과 실제 재생은 호출자(`PlayerControls.tsx`, 재생 배선 층)의
   * 몫이다 — 이 함수는 payload를 그대로 전달할 뿐 가공하지 않는다.
   */
  onGunshot(callback: (event: GunshotEvent) => void): () => void
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
 *
 * RQ-40 채팅(리뷰 M1, `_workspace/review/feat-RQ-40-chat.md`): `'chat'`·
 * `'chat-history'` 구독도 이 함수(netcode 레이어)의 책임이다 — 이전엔
 * HUD(`ChatPanel.tsx`)가 `room.onMessage`를 직접 등록해 fe.md 레이어
 * 규칙(netcode → game state → HUD, 단방향)을 어겼고, 그 결과 실제
 * 유실 위험이 있었다: Colyseus는 클라이언트의 JOIN_ROOM ack(≈이
 * `joinOrCreate`가 resolve하는 시점) 이후에야 `onJoin`에서 보낸
 * `client.send('chat-history', ...)` 큐를 flush한다. HUD가 React
 * 커밋·passive effect 스케줄링을 거쳐야 구독을 등록하므로, 그 사이
 * 도착한 일회성 `chat-history`가 핸들러 없이 버려질 수 있었다(재전송
 * 경로 없음). 아래처럼 `joinOrCreate` resolve와 **같은 태스크**(중간에
 * 다른 `await` 없이)에서 즉시 구독하면 이 경합 창이 사라진다.
 *
 * RQ-81 (`uuid`, 선택 인자): 브라우저 `localStorage`에 보관하는 익명 통계
 * UUID(ADR-0006 결정 4) — 호출자(`App.tsx`)가 `@client/identity/statsUuid`
 * `getOrCreateStatsUuid`로 미리 읽고, 없으면 생성해 넘긴다. 이 함수(netcode
 * 레이어) 자신은 `localStorage`를 참조하지 않는다 — 이 파일은 통합 테스트
 * (Node 환경, `window` 없음)에서 직접 실행되므로(아래 `pingIntervalId` 관련
 * 주석과 동일한 이유) 브라우저 전용 스토리지 API를 여기서 직접 부르면 그
 * 자체로 테스트가 깨진다. 생략하면(레거시 호출·`20b-client-connect.test.ts`
 * 등 uuid 없이 부르는 기존 호출) `joinOrCreate` 옵션에 `uuid` 필드 자체를
 * 싣지 않는다 — 서버 `GameRoom.onJoin`은 그 경우 `isValidStatsUuid(undefined)
 * === false`로 판정해 이번 세션을 통계 추적에서만 제외할 뿐 접속 자체는
 * 그대로 진행된다(RQ-61 안전한 기본값, 기존 호출 회귀 없음).
 */
export async function connectToGame(
  endpoint: string,
  nickname: string,
  store: StoreApi<GameStoreState>,
  uuid?: string,
): Promise<GameConnection> {
  const client = new Client(endpoint)
  const room = await client.joinOrCreate(ROOM_NAME, uuid !== undefined ? { nickname, uuid } : { nickname })

  // RQ-40 M1 — join resolve 직후, 다른 await 없이 즉시 등록한다(위 함수
  // 코멘트 참고). 로그 상한(M3)은 `gameStore`의 `addChatMessage`/
  // `setChatLog`가 `UI.CHAT_HISTORY`로 일괄 적용한다 — 여기서는 그대로
  // 전달만 한다.
  const unbindChat = room.onMessage<ChatMessage>('chat', (message) => {
    store.getState().addChatMessage(message)
  })
  const unbindChatHistory = room.onMessage<ChatMessage[]>('chat-history', (history) => {
    store.getState().setChatLog(history)
  })

  // RQ-70/71/ADR-0016 결정 1 — 서버 명중 이벤트 구독. `nowMs`는
  // `performance.now()`(실시간)가 아니라 `room.state.tick`에서 유도한다
  // (`ticksToMs`) — 아래 `handleStateChange`가 `advanceHitFeedback`에 넘기는
  // 시각과 같은 축이어야 TTL 비교(GA-99)가 의미를 갖는다(둘이 서로 다른
  // 시계를 쓰면 만료 판정이 어긋난다).
  const unbindHit = room.onMessage<HitEvent>('hit', (event) => {
    store.getState().addHitEvent(event, ticksToMs(room.state.tick))
  })

  store.getState().setSelfSessionId(room.sessionId)

  // RQ-15/16: 서버가 스폰 로테이션 지점에서 시작하므로 권위 상태를 먼저
  // 읽어 예측을 시드한다 — 원점으로 시드하면 첫 패치 전까지의 입력이
  // 원점 기준으로 예측돼 시점이 스폰 지점까지 튄다(리뷰 major 3).
  // `joinOrCreate` 응답에 초기 상태가 실려 오므로 대개 여기서 읽힌다.
  const predictor: ClientPredictor = createClientPredictor(readSelfAuthoritativeState(room) ?? initialPredictionState())
  const interpolator: RemoteEntityInterpolator = createRemoteEntityInterpolator(
    room.sessionId,
    INTERPOLATION_DELAY_MS,
  )
  // RQ-64 랙 보상 — RTT 추정기. **표본 출처는 전용 ping/pong이다**(평가 F3
  // 수정 — `_workspace/RQ-64/06_evaluator_delta.md`). 이전(F1) 구현은 기존
  // `move`↔`seq`↔`lastProcessedInputSeq` 왕복을 재사용했으나, 그 확인은
  // 서버 틱(≤`NET.TICK_MS`)과 Colyseus 상태 패치 배치(기본 20Hz, ≤50ms)를
  // 거쳐야만 도착해 표본에 구조적 지연이 섞였다(실측 +62ms 편향 — RQ-64가
  // 요구하는 "RTT 150ms 이내 정상 플레이 보장"을 실제로 깼다). 아래
  // ping/pong은 `GameRoom`이 틱 루프 밖에서 즉시 응답하므로(`handleChat`과
  // 동일한 위상) 그 지연이 표본에 섞이지 않는다.
  const rttEstimator: RttEstimator = createRttEstimator(RTT_SMOOTHING_ALPHA)
  let nextPingSeq = 1
  // RQ-64: pong의 seq가 곧 recordSend가 기록한 그 ping의 seq다 — 도착
  // 시각(now())과 전송 시각의 차이가 RTT 표본이다(rttEstimator.ts 참고).
  // 이 핸들러도 이름을 붙여 보관한다 — disconnect()가 해제해야 하는
  // 구독이라 unbindChat/unbindChatHistory와 동일한 패턴을 따른다.
  const unbindPong = room.onMessage<PingPayload>('pong', (payload) => {
    if (typeof payload?.seq === 'number') {
      rttEstimator.onAck(payload.seq, now())
    }
  })
  function sendPing(): void {
    const seq = nextPingSeq
    nextPingSeq += 1
    rttEstimator.recordSend(seq, now())
    room.send('ping', { seq })
  }
  // `window.setInterval`이 아니라 전역 `setInterval`을 쓴다 — 이 모듈은
  // 통합 테스트(Node 환경, `window` 없음)에서 직접 실행되므로
  // `PlayerControls.tsx`(브라우저 전용, 렌더 계층 면제 대상)와 달리
  // `window` 참조가 있으면 그 자체로 테스트가 깨진다.
  const pingIntervalId = setInterval(sendPing, NET.RTT_PING_INTERVAL_MS)
  // 리뷰 major 1 수정(`_workspace/review/feat-RQ-64-lag-compensation.md`)
  // — 접속 직후 즉시 첫 표본을 만든다. 이전 버전은 첫 ping을 1주기
  // (`NET.RTT_PING_INTERVAL_MS`=1000ms) 뒤로 미뤘는데, RQ-64 EARS
  // 문면에는 웜업 예외가 없어 그 창 전체(모든 접속·재접속마다 반복)에서
  // 되감기가 전혀 적용되지 않는 실질 결함이었다 — 사내망(RTT≈1ms)에서도
  // 이 창의 판정 오차는 히트박스 반지름(0.3m)을 넘는다(리뷰 실측). 그
  // 지연의 근거로 들었던 "TLS 핸드셰이크 이상치 회피"는 이 배포에
  // 애초에 성립하지 않는다 — RQ-80·ADR-0009가 "HTTP/WS, TLS 불요"로
  // 확정했고, 이 시점에는 이미 이 함수 앞부분의
  // `await client.joinOrCreate(...)`(매치메이킹 요청 → 좌석 예약 → WS
  // 업그레이드 → JOIN_ROOM ack → 초기 상태 패치)가 끝나 있어 이 소켓의
  // 최소 3~4번째 왕복이지 콜드 왕복이 아니다.
  //
  // **동기 호출이 계약의 일부다**: `sendPing()`을 여기서 `await`나
  // `setTimeout`/`Promise.then` 등으로 감싸 미루지 않는다 — 이 호출과
  // 아래 `connectToGame`의 `return` 사이에 다른 비동기 대기가 없어야,
  // 그 사이 어떤 소켓 콜백(이 ping의 `pong` 응답 포함)도 끼어들 수
  // 없다는 것이 JS 실행 모델(마이크로태스크가 전부 비워진 뒤에만 다음
  // 매크로태스크로 넘어감) 자체의 보장이 된다. 통합 테스트
  // (`tests/integration/20b-client-connect.test.ts`, 해당 describe 상단
  // REV 절)의 공허화 방지 단언(`connectToGame` resolve 직후
  // `getRttMs()===0`)이 정확히 이 보장에 의존한다 — 이 호출을 비동기
  // 형태로 바꾸면 그 단언의 근거가 깨진다.
  //
  // 이후 주기 발화(`pingIntervalId`, 위)는 그대로 유지한다 — 즉시 1회 +
  // 이후 매 `NET.RTT_PING_INTERVAL_MS`.
  sendPing()

  /**
   * RQ-64 평가 O-2 수정(`_workspace/RQ-64/09_evaluator_delta2.md`) — ping
   * 타이머·`pong` 구독 정리를 공용 함수로 뽑아, 명시적 `disconnect()`
   * 경로와 침묵 disconnect(네트워크 단절·서버 강제 종료 — AFK 킥 포함,
   * 아래 `room.onLeave` 구독) 경로가 **모두 이 함수 하나만** 거치게
   * 한다 — 한쪽에만 정리를 두면(이전 버전의 결함) 다른 경로로 끊긴
   * 연결이 죽은 룸에 계속 ping을 쏘고(오류 없이 조용히), 재접속 시 이전
   * 세션의 타이머가 새 타이머와 함께 누적된다(서버 쪽 `onLeave` 부기
   * 정리 관례 — 22k·이 RQ 자신의 F2 — 의 클라이언트 대응물).
   *
   * **멱등(idempotent)**: `clearInterval`은 이미 정리된 id에 다시 호출해도
   * 안전한 no-op이고(표준 동작), `unbindPong`(nanoevents 기반 구독 해제 —
   * `createNanoEvents().on(...)`이 반환하는 함수)도 이미 제거된 핸들러를
   * 다시 제거하려 해도 배열에서 찾지 못해 조용히 no-op이다(`nanoevents.js`
   * `filter(i => cb !== i)` — 이미 없는 항목을 걸러내는 필터는 그대로
   * 반환한다). 그래서 이 함수는 몇 번을 호출해도(`disconnect()`를 두 번
   * 부르는 경우, 또는 `disconnect()` 호출 자체가 `room.leave(true)`를 거쳐
   * 아래 `room.onLeave` 구독도 함께 발화시키는 경우 포함) 안전하다.
   */
  function cleanupPingTimer(): void {
    clearInterval(pingIntervalId)
    unbindPong()
  }
  // `room.onLeave`는 정상 종료·침묵 disconnect 원인과 무관하게 항상
  // 발화한다(이 파일의 `onDisconnect`가 이미 같은 신호로 `App.tsx`의
  // 침묵 disconnect 처리를 배선한다) — `App.tsx`의 `onDisconnect` 콜백은
  // React 상태만 비울 뿐 이 net 모듈 내부 타이머는 모르므로, 여기서 직접
  // 구독해야 `disconnect()`를 거치지 않는 경로(네트워크 단절·AFK 강제
  // 퇴장 등)에서도 정리된다.
  room.onLeave(cleanupPingTimer)

  // 이름 붙인 핸들러로 보관 — `disconnect()`가 `room.onStateChange.remove(...)`
  // 로 해제할 수 있어야 한다(20b 리뷰 minor 3: 이전엔 익명 함수라 구독을
  // 보관하지 못했다).
  function handleStateChange(): void {
    store.getState().applyServerState(room.state)
    // RQ-71: 매 패치마다 서버 틱 기반 시각으로 피격 효과 TTL을 진행한다 —
    // 위 'hit' 핸들러가 같은 시각 축(ticksToMs(room.state.tick))으로
    // expiresAtMs를 확정했으므로 여기서도 같은 유도식을 쓴다.
    store.getState().advanceHitFeedback(ticksToMs(room.state.tick))

    const authoritative = readSelfAuthoritativeState(room)
    if (authoritative) {
      const reconciled = predictor.reconcile(authoritative)
      store.getState().setSelfPredictedState(reconciled)
    }

    // RQ-63: 이번 패치에 실린 원격 플레이어 위치를 전부 이 스냅샷 하나의
    // 수신 시각으로 보간 버퍼에 먹인다 — 패치 안의 모든 플레이어가 같은
    // 순간의 상태이므로 시각을 한 번만 실측해 공유한다.
    const receivedAt = now()
    forEachRemotePlayer(room, room.sessionId, (sessionId, position, mode, grounded, hp) => {
      // `exactOptionalPropertyTypes`(tsconfig) — `mode: undefined`를
      // 명시적으로 싣지 않는다(gameStore.ts `applyServerState`와 동일한
      // 근거). 필드 자체가 없으면 `RemoteSnapshot.mode` 계약대로 `'run'`
      // 폴백이 소비 시점(`computeMode`)에 적용된다. `grounded`·`hp`(RQ-72)도
      // 같은 형태 — ⚠️ 다만 그 둘은 **폴백이 조용히 그럴듯하다**(항상 접지·
      // 항상 만피)라서 싣지 않으면 공중 변위가 누적되고 리스폰 리셋이
      // 무동작이 된다. `readGrounded`/`readHp` docblock 참고(원장 24bs).
      interpolator.addSnapshot(sessionId, {
        ...position,
        receivedAt,
        ...(mode !== undefined ? { mode } : {}),
        ...(grounded !== undefined ? { grounded } : {}),
        ...(hp !== undefined ? { hp } : {}),
      })
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
    getRttMs(): number {
      return rttEstimator.getRttMs()
    },
    onDisconnect(callback: () => void): () => void {
      const handleLeave = (): void => callback()
      room.onLeave(handleLeave)
      return () => room.onLeave.remove(handleLeave)
    },
    onGunshot(callback: (event: GunshotEvent) => void): () => void {
      return room.onMessage<GunshotEvent>('gunshot', callback)
    },
    async disconnect() {
      room.onStateChange.remove(handleStateChange)
      unbindChat()
      unbindChatHistory()
      unbindHit()
      cleanupPingTimer() // RQ-64 평가 O-2: room.onLeave 구독과 공유하는 멱등 정리(위 정의 참고)
      await room.leave(true)
    },
  }
}
