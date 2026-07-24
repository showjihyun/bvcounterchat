import { useCallback, useState } from 'react'
import { createGameStore } from '@client/store/gameStore'
import { connectToGame } from '@client/net/connection'
import type { GameConnection } from '@client/net/connection'
import { GameScene } from '@client/scene/GameScene'
import { JoinScreen } from '@client/hud/JoinScreen'

/**
 * 클라이언트 → Colyseus 접속 엔드포인트. 같은 오리진의 ws(s) 주소를
 * 쓴다 — 프로덕션은 Nginx가 HTTP/WS를 같은 오리진으로 프록시하고
 * (ADR-0009), 개발 중에는 `vite.config.ts`의 `/matchmake` 프록시가
 * 5173 → 2567로 넘긴다.
 */
const ENDPOINT = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`

/**
 * 애플리케이션 셸 (ADR-0001, `harness/workflow/fe.md`).
 *
 * 레이어 규칙: R3F 캔버스는 3D만 그리고, HUD(RQ-50~55)는 캔버스 **밖의
 * 일반 DOM**으로 만든다. 텍스트 렌더링·접근성·리렌더 비용 때문이다.
 * 이 파일이 그 경계를 고정한다.
 *
 * 20b 범위: 닉네임 입장 화면 → `connectToGame` → 접속 성공 시 3D 씬 표시.
 * store는 이 컴포넌트가 소유하고(RQ-61: 서버가 진실, store는 캐시일 뿐)
 * netcode(`connectToGame`)·scene(`GameScene`)에 그대로 전달한다. 예측
 * (RQ-62)·보간(RQ-63)·입력 전송·HUD(RQ-50~55)는 이 PR의 스코프 밖이다.
 */
export function App() {
  const [store] = useState(() => createGameStore())
  const [connection, setConnection] = useState<GameConnection | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleJoin = useCallback(
    (nickname: string) => {
      setConnecting(true)
      setError(null)
      connectToGame(ENDPOINT, nickname, store)
        .then((conn) => {
          setConnection(conn)
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          setConnecting(false)
        })
    },
    [store],
  )

  return (
    <div className="app">
      {connection ? (
        <>
          <GameScene store={store} />
          {/* HUD 레이어 — 캔버스 밖 DOM. RQ-50~55는 이후 단계에서 붙인다. */}
          <div className="hud" aria-live="polite">
            <span className="hud__placeholder">ChatStrike — 접속됨</span>
          </div>
        </>
      ) : (
        <JoinScreen connecting={connecting} error={error} onJoin={handleJoin} />
      )}
    </div>
  )
}
