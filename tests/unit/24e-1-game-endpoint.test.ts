import { describe, expect, it } from 'vitest'
import { resolveGameEndpoint } from '@client/net/endpoint'
import { NET } from '@shared/constants'

/**
 * 원장 24e-1 — 개발 모드에서 접속이 "접속 중"에서 무한 대기하던 결함의 회귀 가드.
 *
 * **원인**: Colyseus가 매치메이킹 뒤 룸 WebSocket을 `/<processId>/<roomId>`로 여는데
 * `vite.config.ts` 프록시는 `/matchmake`만 잡는다 → Vite가 SPA fallback으로
 * `index.html`을 돌려주고 WS 업그레이드가 성립하지 않는다.
 *
 * **이 테스트가 잡는 것과 못 잡는 것**: 여기서 고정하는 것은 **엔드포인트 결정
 * 규칙**뿐이다. 프록시 설정 자체(`vite.config.ts`)나 실제 WS 핸드셰이크는 단위
 * 테스트 대상이 아니다(ADR-0008 §6, `fe.md`) — 그쪽은 스모크·수동 확인이 게이트다.
 * 즉 **개발 엔드포인트가 다시 5173으로 되돌아가는 회귀**는 잡지만, 프록시를 고쳐
 * 같은 오리진으로 되돌리는 변경이 옳은지는 사람이 판단해야 한다.
 */
describe('24e-1: 게임 서버 엔드포인트 결정', () => {
  const DEV_LOCAL = { protocol: 'http:', hostname: 'localhost', host: 'localhost:5173' }

  it('개발 모드는 Vite 포트를 쓰지 않고 게임 서버 포트로 직접 붙는다', () => {
    const endpoint = resolveGameEndpoint(DEV_LOCAL, true)
    expect(endpoint).toBe(`ws://localhost:${NET.DEFAULT_SERVER_PORT}`)
    // 회귀의 정확한 형태 — 5173(페이지 오리진)으로 돌아가면 룸 WS가 프록시를
    // 통과하지 못해 joinOrCreate가 영원히 대기한다.
    expect(endpoint).not.toContain('5173')
  })

  it('운영 모드는 페이지와 같은 오리진을 쓴다 — Nginx가 프록시한다(ADR-0009)', () => {
    expect(resolveGameEndpoint({ protocol: 'https:', hostname: 'game.example.com', host: 'game.example.com' }, false))
      .toBe('wss://game.example.com')
  })

  it('운영에서 비표준 포트가 있으면 host를 그대로 쓴다 — hostname만 쓰면 포트가 사라진다', () => {
    expect(resolveGameEndpoint({ protocol: 'http:', hostname: 'internal', host: 'internal:8080' }, false))
      .toBe('ws://internal:8080')
  })

  it('https는 wss로, http는 ws로 — 두 모드 모두', () => {
    expect(resolveGameEndpoint({ ...DEV_LOCAL, protocol: 'https:' }, true)).toMatch(/^wss:\/\//)
    expect(resolveGameEndpoint(DEV_LOCAL, true)).toMatch(/^ws:\/\//)
    expect(resolveGameEndpoint({ protocol: 'https:', hostname: 'h', host: 'h' }, false)).toMatch(/^wss:\/\//)
    expect(resolveGameEndpoint({ protocol: 'http:', hostname: 'h', host: 'h' }, false)).toMatch(/^ws:\/\//)
  })

  it('개발 모드는 페이지 hostname을 유지한다 — 127.0.0.1로 열었으면 그쪽으로 붙는다', () => {
    // localhost로 고정하면 IPv6(::1) 해석 차이나 다른 인터페이스로 연 경우에
    // 조용히 다른 대상에 붙는다.
    expect(resolveGameEndpoint({ protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:5173' }, true))
      .toBe(`ws://127.0.0.1:${NET.DEFAULT_SERVER_PORT}`)
  })

  it('포트를 복제하지 않는다 — NET.DEFAULT_SERVER_PORT가 단일 출처다(ADR-0010)', () => {
    // 상수를 바꾸면 이 단언이 따라 움직인다. 리터럴 2567을 적으면 서버가 포트를
    // 바꿔도 클라만 옛 값을 붙든다.
    expect(resolveGameEndpoint(DEV_LOCAL, true)).toContain(String(NET.DEFAULT_SERVER_PORT))
  })
})
