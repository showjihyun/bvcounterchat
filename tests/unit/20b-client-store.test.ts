import { describe, expect, it } from 'vitest'
import { createGameStore } from '@client/store/gameStore'
import { UI } from '@shared/constants'

/**
 * 20b(클라이언트 기본 1차 — 접속·씬·상태 표시) — game state 레이어
 * (`src/client/store/`, `harness/workflow/fe.md` "game state" 레이어) 단위
 * 테스트.
 *
 * 매핑된 골든 케이스: 없음. `harness/progress.md` 20b가 명시하듯 "골든 신설
 * 없음(20a 선례 — RQ-02/03 클라 경로는 GA-01/02 서버 경계가 커버)" — 여기서
 * 검증하는 건 서버가 이미 확정한 값을 클라이언트 캐시가 그대로 반영하는지
 * 뿐이라, 그 확정 로직 자체(닉네임 접미사·정원 판정)는 RQ-02/RQ-03의 기존
 * 서버 경계 테스트가 이미 커버한다.
 *
 * 근거: RQ-61("위치·HP·킬 등 모든 게임 상태의 진실 공급원은 서버이며,
 * 클라이언트가 보고한 상태는 그대로 반영하지 않아야 한다") + fe.md game
 * state 레이어 규칙("진실 공급원은 서버 — 이 store는 캐시일 뿐, 클라이언트가
 * 새 진실을 만들지 않는다").
 *
 * **가정(coder에게 — 이 모듈은 아직 없다. 테스트가 정의하는 계약)**:
 * `src/client/store/gameStore.ts`가 아래 공개 API를 노출한다고 가정한다.
 * DOM·브라우저 API에 의존하지 않아야 이 파일이 node 환경(vitest environment:
 * 'node')에서 임포트 시점에 크래시하지 않는다 — Zustand vanilla
 * (`zustand/vanilla`의 `createStore`)를 쓰면 성립한다(이미 `src/server`
 * 쪽에서 관례로 확인된 패턴은 아니지만, `zustand/vanilla`는 이 저장소의
 * node_modules에 실재하고 DOM 의존이 없다 — 사전 확인함).
 *
 *   export function createGameStore(): StoreApi<GameStoreState>
 *
 *   interface GameStoreState {
 *     selfSessionId: string | null       // 접속 전 null (RQ-61: 서버가
 *                                         // 세션을 확정하기 전엔 자기 식별이
 *                                         // 없다)
 *     tick: number                       // 초기값 0
 *     players: Map<string, { nickname: string; x: number; y: number; z: number }>
 *     spectators: Map<string, { nickname: string }>
 *     setSelfSessionId(sessionId: string): void
 *     applyServerState(state: {
 *       players: { forEach(cb: (value, key: string) => void): void }
 *       spectators: { forEach(cb: (value, key: string) => void): void }
 *       tick: number
 *     }): void
 *   }
 *
 * `applyServerState`의 입력 타입은 표준 `Map.forEach(cb: (value, key, map) =>
 * void)` 시그니처만 요구하는 구조적 타입이다 — 실제 Colyseus
 * `MapSchema<V>`(`@colyseus/schema`)가 `Map<K,V>` 인터페이스를 구현하므로
 * (`node_modules/@colyseus/schema/lib/types/MapSchema.d.ts` 실측:
 * `implements Map<K, V>`) 순정 `Map`으로도 실제 `MapSchema`로도 이 계약을
 * 만족한다. 그래서 이 단위 테스트는 colyseus.js/schema를 임포트하지 않고
 * 순정 `Map`만으로 서버 스냅샷을 흉내낸다 — net 모듈·실 서버 없이 store의
 * 매핑 로직만 격리해서 검증한다(단위 레벨, ADR-0008 §1).
 *
 * `applyServerState`는 스냅샷 **전체 교체**를 계약으로 한다 — 이전 호출에서
 * 있었지만 이번 스냅샷에 없는 sessionId는 결과에서 빠진다(퇴장 반영이
 * 별도 remove 액션 없이 이 하나의 액션으로 처리된다는 뜻). 이건 "필드
 * 이름"이나 "내부 함수 구조"가 아니라 **관찰 가능한 계약**이므로 테스트
 * 대상으로 삼는다.
 *
 * **테스트하지 않는 것(스코프 밖, 과잉 결합 금지)**: 반환되는 player/spectator
 * 객체가 `nickname`·`x`·`y`·`z`(또는 `nickname`) 외의 필드를 더 갖는지는
 * 단언하지 않는다(예: sessionId를 값 안에도 중복 보관하든 안 하든 무관 —
 * `toEqual` 대신 개별 필드 접근으로 단언한다). Zustand store 내부 구현(불변
 * 교체 vs 참조 재사용)도 규정하지 않는다 — `getState()`로 관측되는 값만
 * 확인한다.
 */

interface FakeServerPlayer {
  nickname: string
  x: number
  y: number
  z: number
}
interface FakeServerSpectator {
  nickname: string
}

function playersMap(entries: Record<string, FakeServerPlayer>): Map<string, FakeServerPlayer> {
  return new Map(Object.entries(entries))
}
function spectatorsMap(entries: Record<string, FakeServerSpectator>): Map<string, FakeServerSpectator> {
  return new Map(Object.entries(entries))
}

describe('20b game state 레이어 — applyServerState 스냅샷 반영 (RQ-61 캐시 계약)', () => {
  it('20b: 초기 상태는 접속 전 캐시가 비어 있음을 나타낸다', () => {
    const store = createGameStore()
    const state = store.getState()

    expect(state.selfSessionId).toBeNull()
    expect(state.tick).toBe(0)
    expect(state.players.size).toBe(0)
    expect(state.spectators.size).toBe(0)
  })

  it('20b/RQ-61: applyServerState가 players 스냅샷과 tick을 store에 그대로 반영한다', () => {
    const store = createGameStore()

    store.getState().applyServerState({
      players: playersMap({ 'sess-1': { nickname: 'alpha', x: 1, y: 0, z: 2 } }),
      spectators: spectatorsMap({}),
      tick: 7,
    })

    const entry = store.getState().players.get('sess-1')
    expect(entry?.nickname).toBe('alpha')
    expect(entry?.x).toBe(1)
    expect(entry?.y).toBe(0)
    expect(entry?.z).toBe(2)
    expect(store.getState().tick).toBe(7)
  })

  it('20b/RQ-41: applyServerState가 spectators 스냅샷도 players와 별도로 반영한다', () => {
    const store = createGameStore()

    store.getState().applyServerState({
      players: playersMap({}),
      spectators: spectatorsMap({ 'sess-9': { nickname: 'watcher' } }),
      tick: 1,
    })

    expect(store.getState().spectators.get('sess-9')?.nickname).toBe('watcher')
    expect(store.getState().spectators.size).toBe(1)
    expect(store.getState().players.size).toBe(0)
  })

  it('20b: 이전 스냅샷에 있던 sessionId가 다음 스냅샷에 없으면 store에서 제거된다(퇴장 반영)', () => {
    const store = createGameStore()

    store.getState().applyServerState({
      players: playersMap({
        'sess-1': { nickname: 'alpha', x: 0, y: 0, z: 0 },
        'sess-2': { nickname: 'bravo', x: 0, y: 0, z: 0 },
      }),
      spectators: spectatorsMap({}),
      tick: 1,
    })
    expect(store.getState().players.size).toBe(2)

    // sess-2가 빠진 다음 스냅샷 — 서버에서 퇴장한 상황을 흉내낸다.
    store.getState().applyServerState({
      players: playersMap({ 'sess-1': { nickname: 'alpha', x: 0, y: 0, z: 0 } }),
      spectators: spectatorsMap({}),
      tick: 2,
    })

    expect(store.getState().players.size).toBe(1)
    expect(store.getState().players.has('sess-2')).toBe(false)
    expect(store.getState().players.has('sess-1')).toBe(true)
  })

  it('20b/RQ-61: applyServerState는 같은 sessionId의 위치를 최신 서버 값으로 완전히 교체한다(누적·보간 없음)', () => {
    const store = createGameStore()

    store.getState().applyServerState({
      players: playersMap({ 'sess-1': { nickname: 'alpha', x: 10, y: 0, z: 10 } }),
      spectators: spectatorsMap({}),
      tick: 1,
    })
    store.getState().applyServerState({
      players: playersMap({ 'sess-1': { nickname: 'alpha', x: 0, y: 0, z: 0 } }),
      spectators: spectatorsMap({}),
      tick: 2,
    })

    const entry = store.getState().players.get('sess-1')
    expect(entry?.x).toBe(0)
    expect(entry?.z).toBe(0)
  })

  it('20b/RQ-61: setSelfSessionId는 자기 식별을 별도 채널로 기록하며 이후 applyServerState 호출에 영향받지 않는다', () => {
    const store = createGameStore()

    store.getState().setSelfSessionId('sess-1')
    expect(store.getState().selfSessionId).toBe('sess-1')

    // 무관한 스냅샷(다른 sessionId만 담김)이 와도 자기 식별 값은 그대로다.
    store.getState().applyServerState({
      players: playersMap({ 'sess-2': { nickname: 'bravo', x: 0, y: 0, z: 0 } }),
      spectators: spectatorsMap({}),
      tick: 3,
    })
    expect(store.getState().selfSessionId).toBe('sess-1')
  })
})

/**
 * RQ-40/M3 — 채팅 로그 상한(evaluator 델타 재평가 3회차 FAIL 보강,
 * `_workspace/RQ-40/03_evaluator_report.md` §D5-2·§D6-(a)).
 *
 * 위 describe와 분리하는 이유: 위 블록은 20a/20b 선례(RQ-02/03 클라 경로)의
 * `applyServerState` 계약을 다루고, 이 블록은 리뷰 M1·M3로 추가된
 * `chatLog`/`addChatMessage`/`setChatLog` 계약을 다룬다 — 대상 API가 다르다.
 *
 * 그물이 없었던 실증: `gameStore.ts`의 `.slice(-UI.CHAT_HISTORY)` 두 곳을
 * 지워도(=M3 상한 제거) 이전에는 단위 스위트가 전부 통과했다. 아래 두
 * `it()`은 그 변이에서 `expected 55 to be 50`(등)으로 실패하는 것을
 * evaluator가 프로브로 직접 확인한 형태다.
 */
describe('20b/RQ-40 M3: 채팅 로그는 UI.CHAT_HISTORY로 상한한다(값 복제 금지 ADR-0010 — 서버와 같은 상수 재사용)', () => {
  it('RQ-40/M3: addChatMessage는 로그 끝에 추가하고 UI.CHAT_HISTORY를 넘는 순간부터 오래된 것부터 밀려난다', () => {
    const store = createGameStore()
    const total = UI.CHAT_HISTORY + 5

    for (let i = 0; i < total; i += 1) {
      store.getState().addChatMessage({ nickname: 'n', text: `m-${i}` })
    }

    const log = store.getState().chatLog
    expect(log.length).toBe(UI.CHAT_HISTORY)
    expect(log[0]?.text).toBe('m-5')
    expect(log[log.length - 1]?.text).toBe(`m-${total - 1}`)
    expect(log.some((m) => m.text === 'm-0')).toBe(false)
  })

  it('RQ-40/M3: setChatLog는 로그 전체를 교체하며(이전 값 유지 안 함), 상한을 넘는 입력이 오면 최근 것만 남긴다', () => {
    const store = createGameStore()
    store.getState().addChatMessage({ nickname: 'n', text: 'stale-before-replace' })

    const total = UI.CHAT_HISTORY + 3
    const incoming = Array.from({ length: total }, (_, i) => ({ nickname: 'n', text: `h-${i}` }))
    store.getState().setChatLog(incoming)

    const log = store.getState().chatLog
    expect(log.length).toBe(UI.CHAT_HISTORY)
    expect(log.map((m) => m.text)).toEqual(incoming.slice(3).map((m) => m.text))
    expect(log.some((m) => m.text === 'stale-before-replace')).toBe(false)
  })
})
