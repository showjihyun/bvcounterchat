import { useCallback, useEffect, useState } from 'react'
import { createGameStore } from '@client/store/gameStore'
import { connectToGame } from '@client/net/connection'
import type { GameConnection } from '@client/net/connection'
import { GameScene } from '@client/scene/GameScene'
import { JoinScreen } from '@client/hud/JoinScreen'
import { createMovementInputTracker } from '@client/input/movementInput'
import { NET } from '@shared/constants'

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
 * netcode(`connectToGame`)·scene(`GameScene`)에 그대로 전달한다. 보간
 * (RQ-63)·사격·HUD(RQ-50~55)는 이 PR의 스코프 밖이다.
 *
 * RQ-62: 접속 성공 후 이동 입력 캡처+전송 루프를 시작한다. 서버 틱
 * 레이트(`NET.TICK_MS`, 30Hz)에 맞춘 독립 인터벌로 돈다 — R3F 렌더
 * 프레임(`useFrame`)이 아니다. `fe.md`의 "렌더 루프 내 할당 금지" 규칙은
 * `useFrame`(및 그 안에서 호출되는 코드) 대상이고, 이 루프는 그 밖의
 * 네트워크 전송 주기라 해당하지 않는다 — `useFrame`에 넣으면 매 프레임
 * `MoveInput`/예측 상태 객체 할당이 렌더 루프 예산을 갉아먹는다.
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

  useEffect(() => {
    if (!connection) return undefined

    const tracker = createMovementInputTracker()
    const intervalId = window.setInterval(() => {
      connection.sendMoveInput(tracker.getMoveInput())
    }, NET.TICK_MS)

    return () => {
      window.clearInterval(intervalId)
      tracker.dispose()
    }
  }, [connection])

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
