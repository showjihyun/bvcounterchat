import { pathToFileURL } from 'node:url'
import Fastify from 'fastify'
import { CAPACITY, NET } from '@shared/constants'

/**
 * ChatStrike 서버 진입점 (ADR-0002: Fastify + Colyseus).
 *
 * 로드맵 1단계(프로젝트 초기화) 범위: 프로세스가 뜨고 헬스체크에 응답한다.
 * Colyseus 룸·상태 스키마·틱 루프는 2단계(서버)에서 TDD로 붙인다 —
 * `harness/workflow/tdd.md`.
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
