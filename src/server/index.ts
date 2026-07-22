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
  })
  // RQ-04: 이름은 'game' 하나뿐 — 서버 전역에 상설 세션은 이 룸이 유일하다.
  gameServer.define('game', GameRoom)

  // app.close()에 Colyseus 쪽 정리를 묶는다 — 통합 테스트(GA-28)가
  // buildServer()를 반복 호출해 "재시작"을 흉내내므로, 이전 인스턴스의
  // 룸·소켓이 남으면 다음 인스턴스가 깨끗하게 뜨지 못한다. exit=false로
  // 호출해 테스트 프로세스가 종료되지 않게 한다.
  //
  // onClose가 아니라 preClose에 건다: Fastify 자체의 onClose 훅(내부에서
  // `server.close()`를 호출)이 열려 있는 WebSocket 업그레이드 연결을 절대
  // 스스로 끊지 않으므로, onClose에 걸면 등록 순서와 무관하게 그 내부 훅과
  // 교착한다 — server.close()가 콜백을 못 받아 영원히 끝나지 않는다. preClose는
  // server.close()보다 먼저 실행이 보장되는 유일한 훅이라 여기서 Colyseus
  // 소켓을 먼저 정리해야 한다 (Fastify 공식 문서가 명시한 용도).
  app.addHook('preClose', async () => {
    await gameServer.gracefullyShutdown(false)
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
