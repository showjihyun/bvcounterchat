import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '@server/index'
import { CAPACITY, NET } from '@shared/constants'

/**
 * 서버 골격 통합 테스트 (ADR-0008: 통합은 서버 경계에서).
 *
 * 실 포트를 열지 않고 `inject()`로 프로세스 안에서 요청한다 — 실 네트워크
 * 스택에 의존하면 CI가 flaky해지고, flaky한 게이트는 곧 무시된다.
 *
 * 로드맵 1단계 범위: 서버가 조립되고 응답한다는 것까지. 룸·틱·상태 동기화의
 * 통합 테스트는 2단계(서버)·3단계(네트워킹)에서 GA 골든 케이스와 함께 붙인다.
 */
describe('서버 골격 (RQ-01)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = buildServer({ logger: false })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('/health가 200으로 응답한다', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
  })

  it('/health가 공유 상수를 그대로 노출한다 — 클라·서버 값 일치의 첫 확인점', () => {
    // 서버가 자기만의 복제값을 들고 있으면 여기서 어긋난다 (ADR-0010).
    return app
      .inject({ method: 'GET', url: '/health' })
      .then((res) => {
        expect(res.json()).toMatchObject({
          tickHz: NET.TICK_HZ,
          capacity: { players: CAPACITY.PLAYERS, spectators: CAPACITY.SPECTATORS },
        })
      })
  })

  it('모듈을 임포트해도 포트를 열지 않는다', () => {
    // 임포트 시점에 listen하면 테스트가 포트를 점유해 병렬 실행이 깨진다.
    // buildServer()가 순수 조립 함수인지 확인한다.
    expect(app.server.listening).toBe(false)
  })
})
