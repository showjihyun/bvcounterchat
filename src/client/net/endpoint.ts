/**
 * 게임 서버 WebSocket 엔드포인트 결정(원장 24e-1).
 *
 * **왜 순수 함수인가**: `App.tsx`가 `window.location`을 읽어 인라인으로 조립하던
 * 문자열이었는데, 그 조립이 틀려도 **브라우저를 띄우기 전에는 아무도 모른다**.
 * 실제로 개발 모드에서 접속이 무한 대기하는 결함이 그렇게 살아남았다(아래).
 * 분리하면 규칙을 단위 테스트로 고정할 수 있다(ADR-0011 클라 모듈 test-after).
 *
 * ## 개발 모드가 게임 서버로 직접 붙는 이유
 *
 * Colyseus 클라이언트는 매치메이킹(HTTP `POST /matchmake/...`) **다음에** 룸
 * WebSocket을 **`/<processId>/<roomId>`** 로 연다
 * (`node_modules/colyseus.js/build/cjs/Client.js` `buildEndpoint` — 실측).
 *
 * `vite.config.ts`의 프록시는 **`/matchmake`만** 잡으므로 그 룸 경로는 프록시를
 * 타지 못하고, Vite 개발 서버가 SPA fallback으로 **`index.html`(200 text/html)**
 * 을 돌려준다 — WebSocket 업그레이드가 성립하지 않아 `joinOrCreate`가 **영원히
 * 대기**하고 화면은 "접속 중"에서 멈춘다.
 *
 * ⚠️ **`ws: true`로는 안 고쳐진다.** 그 옵션은 해당 **경로 항목**의 업그레이드를
 * 허용할 뿐이고, 룸 경로는 애초에 `/matchmake` 항목에 매칭되지 않는다.
 * `vite.config.ts`의 기존 주석이 정확히 이 증상("없으면 매치메이킹은 되지만 룸
 * 접속 WS 핸드셰이크가 프록시를 통과하지 못한다")을 적어 두고도 그렇게 고쳐져
 * 있었다 — **주석이 서술한 고장이 실제로 남아 있었다.**
 *
 * 룸 경로를 정규식으로 프록시하는 방법도 있으나 `processId`·`roomId`의 문자
 * 집합·길이에 결합된다. 개발에서는 **직접 붙는 편이 결합이 없고**, 서버가 이미
 * 교차 오리진을 허용한다(실측 — `Access-Control-Allow-Origin: http://localhost:5173`,
 * 프리플라이트 204).
 *
 * **운영은 바뀌지 않는다** — Nginx가 같은 오리진으로 프록시하므로(ADR-0009)
 * 페이지와 같은 host를 그대로 쓴다.
 */

import { NET } from '@shared/constants'

/** `window.location`에서 필요한 부분만. 테스트가 브라우저 없이 부를 수 있게
 * 좁힌 타입이다. */
export interface EndpointLocation {
  /** `'http:'` | `'https:'` */
  protocol: string
  /** 포트를 뺀 호스트명 */
  hostname: string
  /** 포트를 포함한 호스트 */
  host: string
}

/**
 * @param location 페이지의 위치
 * @param isDev Vite 개발 모드 여부(`import.meta.env.DEV`)
 * @returns `ws://`/`wss://` 엔드포인트
 */
export function resolveGameEndpoint(location: EndpointLocation, isDev: boolean): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  // 개발: Vite(5173)를 우회해 게임 서버로 직접. 프록시가 룸 WS 경로를 잡지 못한다.
  if (isDev) return `${scheme}://${location.hostname}:${NET.DEFAULT_SERVER_PORT}`
  // 운영: Nginx 같은 오리진(ADR-0009).
  return `${scheme}://${location.host}`
}
