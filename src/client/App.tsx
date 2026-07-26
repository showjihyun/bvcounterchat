import { useCallback, useEffect, useState } from 'react'
import { createGameStore } from '@client/store/gameStore'
import { createUiStore } from '@client/store/uiStore'
import { connectToGame } from '@client/net/connection'
import type { GameConnection } from '@client/net/connection'
import { GameScene } from '@client/scene/GameScene'
import { JoinScreen } from '@client/hud/JoinScreen'
import { ChatPanel } from '@client/hud/ChatPanel'

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
 * RQ-62: 이동 입력 캡처+전송 루프(30Hz)는 **22b에서 `PlayerControls`로
 * 옮겼다** — 전송 직전 로컬 WASD를 yaw로 회전해야 하고(마우스 룩), yaw를
 * 소유한 `mouseLook` 컨트롤러가 캔버스와 같은 유효범위에 있어야 하기
 * 때문이다. 여기에 루프를 남겨두면 회전 미적용 입력이 같은 주기로 함께
 * 전송돼 서버의 latest-wins 이동이 두 입력 사이에서 요동친다.
 *
 * RQ-63 부기(20b 후속 + RQ-62 minor ① 병합 이월): 아래 이펙트가
 * `connection.onDisconnect`를 구독해 침묵 disconnect(네트워크 단절 등)
 * 발생 시 `connection` state를 `null`로 되돌린다 — 그러면 `GameScene`이
 * 언마운트되며 `PlayerControls`의 cleanup이 전송 인터벌·입력 리스너를
 * 정리한다(끊긴 연결에 계속 `sendMoveInput`을 호출하는 것을 막는다).
 */
export function App() {
  const [store] = useState(() => createGameStore())
  const [uiStore] = useState(() => createUiStore())
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

    const unsubscribeDisconnect = connection.onDisconnect(() => {
      setConnection(null)
    })

    return () => {
      unsubscribeDisconnect()
    }
  }, [connection])

  return (
    <div className="app">
      {connection ? (
        <>
          <GameScene store={store} connection={connection} uiStore={uiStore} />
          {/* HUD 레이어 — 캔버스 밖 DOM. RQ-51/53~55는 이후 단계에서 붙인다. */}
          <div className="hud" aria-live="polite">
            {/* 22b 임시 크로스헤어(RQ-54 자리표시) — 조준점이 없으면 어디를
                쏘는지 알 수 없어 사격 자체를 확인할 수 없다. 정식 디자인·
                탄퍼짐 시각화는 DESIGN.md 확정 이후(fe.md HUD 체크리스트). */}
            <span className="hud__crosshair" aria-hidden="true" />
            <span className="hud__placeholder">ChatStrike — 접속됨</span>
            {/* RQ-40/41/95 최소 채팅 패널(RQ-52 자리) — ChatPanel.tsx 참고. */}
            <ChatPanel store={store} connection={connection} uiStore={uiStore} />
          </div>
        </>
      ) : (
        <JoinScreen connecting={connecting} error={error} onJoin={handleJoin} />
      )}
    </div>
  )
}
