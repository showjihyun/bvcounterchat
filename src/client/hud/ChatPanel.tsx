import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import type { GameConnection } from '@client/net/connection'
import type { GameStoreState } from '@client/store/gameStore'
import type { UiStoreState } from '@client/store/uiStore'

interface ChatPanelProps {
  store: StoreApi<GameStoreState>
  connection: GameConnection
  uiStore: StoreApi<UiStoreState>
}

/**
 * RQ-40(Global Chat) + RQ-41(관전자 참여) + RQ-95(금칙어 필터, 서버가 이미
 * 적용한 값을 그대로 표시) 최소 채팅 패널 — HUD 레이어(캔버스 밖 DOM,
 * `harness/workflow/fe.md`). RQ-52 자리(좌하단)의 기능 최소 구현이다 —
 * 시각 디자인은 `docs/design/DESIGN.md` §3.3이 정한다(2026-08-05 확정) — 현재는
 * 그 토큰만 적용한 상태이고 RQ-52 정식 레이아웃 구현은 다음 라운드다
 * (22b 임시 크로스헤어 선례와 동일한 절제).
 *
 * **읽기(리뷰 M1, `_workspace/review/feat-RQ-40-chat.md`)**: 이 컴포넌트는
 * `room.onMessage`를 더 이상 직접 구독하지 않는다 — `store.chatLog`
 * (netcode 레이어 `connection.ts`가 'chat'·'chat-history' 양쪽을 반영)를
 * `useStore()`로 구독만 한다(fe.md: HUD는 이 구독 방식이 허용 예외).
 * 이전 직접 구독 방식은 레이어 규칙 위반이었을 뿐 아니라, HUD가 React
 * effect 스케줄링을 거쳐야 등록되는 타이밍 탓에 접속 직후 도착하는
 * 일회성 `chat-history`를 놓칠 위험이 있었다(M1 근거 — 재발 방지를 위해
 * 구독은 `connection.ts` 한 곳에만 둔다). 로그 상한(50, `UI.CHAT_HISTORY`)도
 * `gameStore`가 일괄 적용한다(M3) — 이 컴포넌트는 신경 쓰지 않는다.
 *
 * **쓰기(전송)**: `connection.room.send('chat', { text })`는 이 컴포넌트가
 * 직접 호출한다 — fe.md의 단방향 규칙은 **서버 → 클라 데이터 흐름**
 * (netcode → game state → scene/HUD)에 대한 것이라, 사용자 입력을 서버로
 * 내보내는 것(scene의 `PlayerControls`가 `connection.sendMoveInput`을
 * 직접 부르는 것과 동일한 패턴)은 이 규칙의 대상이 아니다.
 *
 * **입력 차단 배선(RQ-40, fe.md 입력 처리 규칙)**: 이 입력창이 포커스를
 * 얻으면(`onFocus`) `uiStore.setChatFocused(true)`로 게임 입력을 차단하고,
 * 포커스를 잃으면(`onBlur`) 해제한다. 실제 게이트 적용(게임 레이어 출구
 * 단일 choke point)은 `@client/input/chatInputGate`의 `createChatGatedActions`
 * (`PlayerControls.tsx`가 사용, 리뷰 M4)의 책임이다 — 이 컴포넌트는 포커스
 * 신호를 UI 상태에 쓰기만 한다.
 *
 * **포커스 수명주기(리뷰 M2)**: 언마운트(접속 종료로 `GameScene`이 통째로
 * 사라지는 경우 포함)에서 `blur` 이벤트가 발생한다는 보장이 없다(DOM에서
 * 포커스된 엘리먼트가 제거되면 브라우저는 포커스를 body로 옮기되 `blur`
 * 이벤트를 발생시키지 않는다) — `uiStore`는 `App`이 접속 사이클을 넘어
 * 계속 소유하므로, 이 cleanup이 없으면 재접속한 사용자가 `chatFocused
 * === true`로 시작해 이동·사격이 영구 차단될 수 있었다. 언마운트 시
 * 명시적으로 해제한다.
 */
export function ChatPanel({ store, connection, uiStore }: ChatPanelProps) {
  const messages = useStore(store, (state) => state.chatLog)
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages])

  useEffect(() => {
    return () => {
      uiStore.getState().setChatFocused(false)
    }
  }, [uiStore])

  // 원장 24m — 포인터 락 상태를 읽어 로그의 조작 가능 여부를 정한다(24h 해소).
  // 락 중에는 커서가 없어 스크롤할 수 없고, 락을 걸려는 클릭은 캔버스로 가야
  // 한다(24f가 고친 결함). 락이 풀린 동안에만 로그가 포인터를 받는다.
  const [pointerLocked, setPointerLocked] = useState(() => uiStore.getState().pointerLocked)
  useEffect(() => {
    setPointerLocked(uiStore.getState().pointerLocked)
    return uiStore.subscribe((state) => {
      setPointerLocked(state.pointerLocked)
    })
  }, [uiStore])

  // 원장 24m — Enter로 입력창에 진입한다. 지금까지는 **클릭만이** 진입 경로였고,
  // 그 클릭이 캔버스에 닿으면 포인터 락이 걸려 버려 채팅을 열기가 까다로웠다.
  //
  // ⚠️ **진입 시 포인터 락을 푼다.** 락이 걸린 채로는 타자를 치는 동안에도
  // mousemove가 시점을 계속 돌린다(`mouseLook`은 락만 보고 채팅 포커스를 보지
  // 않는다). CS가 채팅을 열 때 마우스를 놓는 것과 같은 처리다.
  //
  // 전송은 이 핸들러가 아니라 `form`의 submit(= 입력창에서 Enter)이 맡는다 —
  // 이미 포커스가 있으면 이 리스너는 아무것도 하지 않고 그 기본 경로에 맡긴다.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Enter') return
      if (uiStore.getState().chatFocused) return
      // 브라우저 기본 동작(버튼 재활성 등)과 게임 입력 양쪽에서 이 Enter를 뺀다.
      event.preventDefault()
      if (document.pointerLockElement) document.exitPointerLock()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [uiStore])

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = draft.trim()
    if (text.length === 0) {
      // 원장 24f — 빈 채로 Enter를 치면 **빠져나올 수 없었다**. 보낼 말이
      // 없어 입력을 그만두는 것도 정상 조작인데, 포커스가 남아 이동·사격이
      // 계속 차단되고(RQ-40 게이트) 탈출 경로는 캔버스 클릭뿐이었다.
      inputRef.current?.blur()
      return
    }
    connection.room.send('chat', { text })
    setDraft('')
    // 리뷰 minor m5 — 전송 후에도 포커스가 남으면 이동·사격 게이트가 계속
    // 걸린다(캔버스를 다시 클릭해야 풀림). blur()로 즉시 해제한다 — 이
    // `blur` 이벤트가 `onBlur`의 `setChatFocused(false)`를 자연히 호출한다.
    inputRef.current?.blur()
  }

  return (
    // `--interactive`는 락이 풀린 동안에만 붙는다(위 주석 참고).
    <div className={pointerLocked ? 'hud__chat' : 'hud__chat hud__chat--interactive'}>
      <div className="hud__chat-log" ref={logRef} role="log" aria-live="polite">
        {messages.map((message, index) => (
          // key=index: append-only 로그(재정렬·중간 삭제 없음)라 안전하다.
          <p className="hud__chat-message" key={index}>
            <span className="hud__chat-nickname">{message.nickname}</span>
            {': '}
            {message.text}
          </p>
        ))}
      </div>
      <form className="hud__chat-form" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          className="hud__chat-input"
          type="text"
          value={draft}
          placeholder="채팅..."
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          // ESC로 채팅에서 빠져나온다(원장 24f) — FPS의 표준 관례이고,
          // 스펙 확장이 아니라 RQ-40 게이트에 갇히는 상태를 여는 것이다.
          onKeyDown={(event) => {
            if (event.key === 'Escape') inputRef.current?.blur()
          }}
          onFocus={() => uiStore.getState().setChatFocused(true)}
          onBlur={() => uiStore.getState().setChatFocused(false)}
        />
      </form>
    </div>
  )
}
