import { useState } from 'react'
import type { FormEvent } from 'react'

interface JoinScreenProps {
  connecting: boolean
  error: string | null
  onJoin: (nickname: string) => void
}

/**
 * 닉네임 입장 화면(캔버스 밖 DOM, `harness/workflow/fe.md` HUD 레이어).
 * 시각 디자인은 `docs/design/DESIGN.md`(🟡 아직 없음) 확정 전까지 유예 —
 * 기능 최소(입력 + 버튼)만 구현한다.
 */
export function JoinScreen({ connecting, error, onJoin }: JoinScreenProps) {
  const [nickname, setNickname] = useState('')

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (connecting) return
    onJoin(nickname)
  }

  return (
    <div className="join-screen">
      <form className="join-screen__form" onSubmit={handleSubmit}>
        <h1 className="join-screen__title">ChatStrike</h1>
        <label htmlFor="nickname">닉네임</label>
        <input
          id="nickname"
          name="nickname"
          type="text"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          disabled={connecting}
          autoComplete="off"
          autoFocus
        />
        <button type="submit" disabled={connecting}>
          {connecting ? '접속 중...' : '입장'}
        </button>
        {error !== null && (
          <p className="join-screen__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  )
}
