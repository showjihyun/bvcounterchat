import type { Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import Fastify from 'fastify'
import { Server as ColyseusServer } from 'colyseus'
import { WebSocketTransport } from '@colyseus/ws-transport'
import { CAPACITY, NET } from '@shared/constants'
import { GameRoom } from './rooms/GameRoom'

/**
 * ChatStrike 서버 진입점 (ADR-0002: Fastify + Colyseus).
 *
 * RQ-04(상설 세션) 범위: Colyseus `Server`를 Fastify의 내부 HTTP 서버
 * (`app.server`)에 부착하고 단일 `'game'` 룸을 등록한다 — 두 프레임워크가
 * 한 프로세스·한 포트에 공존한다(ADR-0002). `WebSocketTransport`에 기존
 * 서버 인스턴스를 넘기면 Colyseus는 자신의 매치메이킹 라우트(`/matchmake/*`)와
 * WebSocket 업그레이드만 가로채고, 나머지 요청은 그대로 Fastify로 넘어간다
 * (`@colyseus/core` `Server.attachMatchMakingRoutes`가 기존 request 리스너를
 * 보존한다). 포트를 여는 책임은 여전히 `app.listen()`에 있다 — `buildServer()`는
 * 조립만 하고 listen하지 않는다.
 *
 * 게임 상태·틱 루프는 이후 RQ(RQ-10~)에서 TDD로 붙인다.
 */

const PORT = Number(process.env['PORT'] ?? 2567)
const HOST = process.env['HOST'] ?? '0.0.0.0'

export interface BuildOptions {
  /** 테스트는 false로 끈다 — 로그가 테스트 출력을 덮으면 실패를 놓친다. */
  logger?: boolean
}

export function buildServer(options: BuildOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true })

  // ADR-0009: 배포 후 스모크와 컨테이너 헬스체크가 이 엔드포인트를 쓴다.
  app.get('/health', () => ({
    status: 'ok',
    tickHz: NET.TICK_HZ,
    capacity: { players: CAPACITY.PLAYERS, spectators: CAPACITY.SPECTATORS },
  }))

  const gameServer = new ColyseusServer({
    transport: new WebSocketTransport({ server: app.server }),
    // Colyseus의 기본 동작(`gracefullyShutdown: true`)은 생성자 안에서
    // `process.on('uncaughtException', ...)` + `SIGINT`/`SIGTERM`/`SIGUSR2`
    // 리스너를 프로세스에 등록하고, 그 콜백은 exit=true로 자기 자신을
    // gracefullyShutdown한 뒤 `process.exit()`를 호출한다
    // (`node_modules/@colyseus/core/build/utils/Utils.js:55-61`,
    // `Server.js`의 `if (gracefullyShutdown) registerGracefulShutdown(...)`).
    // 이 리스너는 `app.close()`로도 해제되지 않는다 — 실측: buildServer()를
    // 5번 부르면 `uncaughtException` 리스너가 5개 누적된다. 통합 테스트
    // (GA-26~29)처럼 한 프로세스 안에서 buildServer()를 여러 번 부르면,
    // 서로 무관한 인스턴스에서 발생한 예외 하나가 **모든** 인스턴스의 핸들러를
    // 동시에 깨워 각각 process.exit()를 부른다 — evaluator가 실측한 콜드스타트
    // 워커 크래시("Worker exited unexpectedly")를 낼 수 있는 구조적 위험이다
    // (완전한 단일 원인이라는 증거는 아니다 — 이 옵션을 끈 뒤에도 낮은 빈도로
    // 남는 크래시가 있다, `_workspace/RQ-04/02_coder_green.md` "flaky 워커
    // 크래시 근본 원인 조사" 참고). 우리는 app.close() -> preClose 훅에서
    // 이미 명시적으로 gracefullyShutdown(false)를 호출해 종료를 직접
    // 통제하므로, Colyseus가 프로세스 전역에 별도로 등록하는 이 자동 종료
    // 경로는 필요 없고, 위 위험을 없애므로 끈다.
    gracefullyShutdown: false,
  })
  // RQ-04: 이름은 'game' 하나뿐 — 서버 전역에 상설 세션은 이 룸이 유일하다.
  gameServer.define('game', GameRoom)

  // RQ-04 종료 드레인 — app.close()가 반환되는 시점에 이 인스턴스가 열었던
  // TCP 연결(WS 업그레이드 포함)이 전부 실제로 닫혀 있어야 한다. 그래야
  // 재시작 시뮬레이션(GA-28, buildServer() 재호출)에서 다음 인스턴스가
  // 깨끗한 상태로 뜨고, 이벤트 루프에 정리 작업이 남지 않아 (테스트) 프로세스
  // 종료와 겹치지 않는다.
  //
  // gracefullyShutdown()만으로는 부족한 이유: `Room.disconnect()`가 부르는
  // `_forciblyCloseClient`는 `_onLeave(...).then(() => client.leave(code))`
  // 형태로 실제 소켓 close(`client.leave` → `ref.close()`,
  // `node_modules/@colyseus/ws-transport/build/WebSocketClient.js:81-83`)를
  // await하지 않는 fire-and-forget이다(`node_modules/@colyseus/core/build/
  // Room.js:779-783`). 즉 `gameServer.gracefullyShutdown()`이 반환된 뒤에도
  // ws 클로징 핸드셰이크가 아직 진행 중일 수 있다. 그 상태에서 Fastify
  // 자신의 onClose 훅이 `server.close()` 직전에 기본으로 `closeAllConnections()`를
  // 불러(Node ≥18.2 + `forceCloseConnections` 기본값 'idle',
  // `node_modules/fastify/lib/server.js:127-139`) 아직 닫히는 중이던 소켓을
  // 또 건드리면, 진행 중이던 close 작업과 겹쳐 타이밍에 따라 결과가 갈린다.
  //
  // preClose는 Fastify의 onClose(=server.close())보다 먼저 실행이 보장되는
  // 유일한 훅이라(Fastify 공식 문서가 "열린 WebSocket을 server.close() 전에
  // 명시적으로 끊어야 한다"는 용도로 명시) 여기서 처리한다. Colyseus/ws
  // 내부 구현(protected 필드 등)에 기대지 않도록, 이 서버 인스턴스의 raw
  // HTTP 서버에서 발생하는 모든 연결을 우리가 직접 추적한다 — WS 업그레이드도
  // upgrade 이전에 먼저 http.Server의 'connection' 이벤트를 거치므로 전부
  // 잡힌다.
  const openSockets = new Set<Socket>()
  app.server.on('connection', (socket: Socket) => {
    openSockets.add(socket)
    socket.once('close', () => openSockets.delete(socket))
  })

  // 그레이스풀 close(client.leave() → ws 클로징 핸드셰이크)의 완료를
  // "기다리기"보다 **직접 끊는 것**을 택했다 — 대기는 네트워크 왕복(로컬
  // 루프백이라도 이벤트 루프 스케줄링에 좌우된다)에 시간을 맡기는 것이라
  // 콜드스타트처럼 이벤트 루프가 밀리는 상황에서 얼마나 걸릴지 예측할 수
  // 없다. `socket.destroy()`는 로컬 종료라 네트워크 왕복이 없고, 그 뒤의
  // 'close' 이벤트도 다음 tick 안에 결정적으로 발생한다 — app.close()가
  // 반환되는 시점을 예측 가능한 상한 안에 못박기 위한 선택이다.
  function destroyAllOpenSockets(): Promise<void> {
    const pending = Array.from(openSockets).filter((socket) => !socket.destroyed)
    if (pending.length === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let remaining = pending.length
      for (const socket of pending) {
        socket.once('close', () => {
          remaining -= 1
          if (remaining === 0) resolve()
        })
        socket.destroy()
      }
    })
  }

  // app.close()에 Colyseus 쪽 정리를 묶는다 — 통합 테스트(GA-28)가
  // buildServer()를 반복 호출해 "재시작"을 흉내내므로, 이전 인스턴스의
  // 룸·소켓이 남으면 다음 인스턴스가 깨끗하게 뜨지 못한다. exit=false로
  // 호출해 테스트 프로세스가 종료되지 않게 한다. gracefullyShutdown()이
  // 룸·매치메이커 상태(타이머·리스너 등)를 먼저 정리하고, 그 뒤 남아있는
  // TCP 연결은 자연 종료를 기다리지 않고 바로 끊는다 — app.close()가
  // 반환되는 시점에 살아있는 연결이 0임을 결정적으로 보장한다.
  app.addHook('preClose', async () => {
    await gameServer.gracefullyShutdown(false)
    await destroyAllOpenSockets()
  })

  return app
}

// 테스트에서 임포트할 때는 리스닝하지 않는다 (ADR-0008: 통합 테스트가
// 서버를 프로세스 안에서 직접 기동한다). 직접 실행일 때만 포트를 연다.
const entry = process.argv[1]
const isDirectRun = entry !== undefined && import.meta.url === pathToFileURL(entry).href

if (isDirectRun) {
  const app = buildServer()
  app.listen({ port: PORT, host: HOST }).catch((err: unknown) => {
    app.log.error(err)
    process.exit(1)
  })
}
