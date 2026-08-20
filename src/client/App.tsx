import { useCallback, useEffect, useState } from 'react'
import { createGameStore } from '@client/store/gameStore'
import { createUiStore } from '@client/store/uiStore'
import { connectToGame } from '@client/net/connection'
import { resolveGameEndpoint } from '@client/net/endpoint'
import type { GameConnection } from '@client/net/connection'
import { getOrCreateStatsUuid, readUuidStorage } from '@client/identity/statsUuid'
import { GameScene } from '@client/scene/GameScene'
import { JoinScreen } from '@client/hud/JoinScreen'
import { Crosshair } from '@client/hud/Crosshair'
import { LockHint } from '@client/hud/LockHint'
import { Nameplate } from '@client/hud/Nameplate'
import { ChatPanel } from '@client/hud/ChatPanel'
import { HitMarker } from '@client/hud/HitMarker'
import { HitDirectionIndicator } from '@client/hud/HitDirectionIndicator'

/**
 * 클라이언트 → Colyseus 접속 엔드포인트.
 *
 * **운영**은 페이지와 같은 오리진을 쓴다 — Nginx가 HTTP/WS를 같은 오리진으로
 * 프록시한다(ADR-0009). **개발**은 게임 서버(2567)에 직결한다 — 룸 WebSocket
 * 경로(`/<processId>/<roomId>`)가 Vite의 `/matchmake` 프록시 항목에 매칭되지
 * 않아 접속이 무한 대기하기 때문이다(원장 24e-1).
 *
 * 결정 규칙 자체는 `@client/net/endpoint`가 갖는다(순수 함수, 단위 테스트) —
 * 여기서 인라인으로 조립하던 것이 그 결함의 자리였다. */
const ENDPOINT = resolveGameEndpoint(window.location, import.meta.env.DEV)

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
 *
 * RQ-81: 접속 시 익명 통계 UUID(`localStorage`, ADR-0006 결정 4)를 함께
 * 보낸다. `getOrCreateStatsUuid(readUuidStorage())`를 지연 초기화
 * (`useState` 초기화 함수)로 한 번만 호출한다 — 매 렌더마다 `localStorage`를
 * 다시 읽지 않고, 이 셸 컴포넌트(브라우저 전용, `App.tsx`는 통합 테스트가
 * 직접 임포트하지 않는다)가 그 값을 소유해 `connectToGame`(netcode 레이어,
 * Node 환경에서도 직접 실행되는 모듈)에 값으로 넘긴다.
 *
 * 원장 26k(리뷰 blocker): 여기서 `window.localStorage`를 직접 참조하면 안
 * 된다 — opaque origin(샌드박스 iframe)·사이트 데이터 차단 환경에서는
 * `localStorage` **속성 접근 자체**가 던지고, 인자는 호출자(이 컴포넌트)
 * 쪽에서 평가되므로 `getOrCreateStatsUuid` 내부 try/catch로는 그 예외를
 * 잡을 수 없다(1차 수정에서 놓친 지점). `readUuidStorage()`가 그 속성
 * 접근 자체를 감싸 안전한 폴백을 반환한다 — 조건 구분은 `statsUuid.ts`의
 * `readUuidStorage`/`getOrCreateStatsUuid` 코멘트 참고.
 */
export function App() {
  const [store] = useState(() => createGameStore())
  const [uiStore] = useState(() => createUiStore())
  const [statsUuid] = useState(() => getOrCreateStatsUuid(readUuidStorage()))
  const [connection, setConnection] = useState<GameConnection | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleJoin = useCallback(
    (nickname: string) => {
      setConnecting(true)
      setError(null)
      connectToGame(ENDPOINT, nickname, store, statsUuid)
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
    [store, statsUuid],
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
            {/* RQ-54 정식 크로스헤어(원장 24e) — DESIGN.md §3.1 십자 4선.
                간격은 `--crosshair-gap-live`(= 기본 간격 × 콘 배율)로 들어오고
                그 값은 `@client/hud/crosshairSpread`가 계산한다. 22b의 임시 점을
                대체한다. `aria-hidden` — 조준점은 스크린리더에 의미가 없다. */}
            <Crosshair uiStore={uiStore} />
            {/* RQ-57 히트마커(원장 24cv) — 크로스헤어 위에 겹치는 일시적
                표시. HitMarker.tsx 참고. */}
            <HitMarker uiStore={uiStore} />
            {/* RQ-58 피격 방향(원장 24cv) — 화면 가장자리 그라데이션.
                HitDirectionIndicator.tsx 참고. */}
            <HitDirectionIndicator uiStore={uiStore} />
            {/* RQ-56 이름표(원장 24ab) — 조준 시에만 뜬다. Nameplate.tsx 참고. */}
            <Nameplate uiStore={uiStore} />
            <LockHint uiStore={uiStore} />
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
