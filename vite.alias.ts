import { fileURLToPath } from 'node:url'

/**
 * 경로 별칭의 단일 정의 (ADR-0010).
 *
 * vite.config.ts / vite.server.config.ts / vitest.config.ts가 전부 이걸
 * 임포트한다. 각자 선언하면 언젠가 어긋나고, 그때 증상은 "타입은 통과하는데
 * 번들만 깨짐" 또는 "테스트만 통과하고 실행이 깨짐"이라 원인을 찾기 어렵다.
 *
 * tsconfig.json의 `paths`와는 여전히 이중 선언이다 — 도구 체계가 달라
 * 물리적으로 공유할 수 없다. 별칭을 추가·변경하면 **양쪽 모두** 고쳐야 한다.
 */
const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export const alias = {
  '@shared': resolve('./src/shared'),
  '@client': resolve('./src/client'),
  '@server': resolve('./src/server'),
}
