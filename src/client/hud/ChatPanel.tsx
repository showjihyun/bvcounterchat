import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { StoreApi } from 'zustand/vanilla'
import type { GameConnection } from '@client/net/connection'
import type { UiStoreState } from '@client/store/uiStore'

interface ChatMessage {
  nickname: string
  text: string
}

interface ChatPanelProps {
  connection: GameConnection
  uiStore: StoreApi<UiStoreState>
}

/**
 * RQ-40(Global Chat) + RQ-41(관전자 참여) + RQ-95(금칙어 필터, 서버가 이미
 * 적용한 값을 그대로 표시) 최소 채팅 패널 — HUD 레이어(캔버스 밖 DOM,
 * `harness/workflow/fe.md`). RQ-52 자리(좌하단)의 기능 최소 구현이다 —
 * 시각 디자인은 `docs/design/DESIGN.md`(🟡 아직 없음) 확정 이후로 유예한다
 * (22b 임시 크로스헤어 선례와 동일한 절제).
 *
 * **채널(`_workspace/RQ-40/01_test-writer_red.md` §3.3 계약)**: 전송은
 * `room.send('chat', { text })`, 실시간 수신은 `room.onMessage('chat', ...)`
 * (서버가 필터링·닉네임 확정 후 전송자 포함 전원에게 브로드캐스트한 값을
 * 그대로 렌더링 — RQ-61: 클라이언트가 닉네임·필터링을 다시 계산하지
 * 않는다), 이력 복원은 `room.onMessage('chat-history', ...)`(접속 직후
 * 1회, 전체 배열로 로그를 교체).
 *
 * **입력 차단 배선(RQ-40, fe.md 입력 처리 규칙)**: 이 입력창이 포커스를
 * 얻으면(`onFocus`) `uiStore.setChatFocused(true)`로 게임 입력을 차단하고,
 * 포커스를 잃으면(`onBlur`) 해제한다. 실제 게이트 적용(이동·사격 핸들러
 * 최상단에서 `@client/input/chatInputGate` 호출)은 `PlayerControls.tsx`
 * 책임이다 — 이 컴포넌트는 포커스 신호를 UI 상태에 쓰기만 한다(개별
 * 핸들러 분산 체크 금지 규칙과 동일한 정신으로, 신호 발행처와 소비처를
 * 분리한다).
 */
export function ChatPanel({ connection, uiStore }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const { room } = connection

    const unbindChat = room.onMessage<ChatMessage>('chat', (message) => {
      setMessages((prev) => [...prev, message])
    })
    // 이력 복원(가정 2) — 접속 직후 서버가 단일 대상 전송으로 1회 보낸다.
    // 전체 배열로 로그를 교체한다(누적이 아니다 — 이 시점 이전엔 로그가
    // 비어 있으므로 교체와 누적이 동치이지만, 계약대로 교체를 명시한다).
    const unbindHistory = room.onMessage<ChatMessage[]>('chat-history', (history) => {
      setMessages(history)
    })

    return () => {
      unbindChat()
      unbindHistory()
    }
  }, [connection])

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages])

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = draft.trim()
    if (text.length === 0) return
    connection.room.send('chat', { text })
    setDraft('')
  }

  return (
    <div className="hud__chat">
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
          className="hud__chat-input"
          type="text"
          value={draft}
          placeholder="채팅..."
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => uiStore.getState().setChatFocused(true)}
          onBlur={() => uiStore.getState().setChatFocused(false)}
        />
      </form>
    </div>
  )
}
