import { defineConfig } from 'vite'
import { alias } from './vite.alias'

/**
 * 서버 번들 (ADR-0002: Fastify + Colyseus).
 *
 * tsc로 컴파일하지 않고 Vite SSR 빌드를 쓰는 이유: `tsc`는 컴파일 후 임포트
 * 경로의 별칭(@shared/*)을 **다시 쓰지 않는다**. 그대로 두면 타입 검사와
 * 번들은 통과하지만 `node dist/server/index.js`가 런타임에
 * "Cannot find module '@shared/...'"로 죽는다. Vite는 빌드 타임에 별칭을
 * 해석하므로 이 함정이 생기지 않는다.
 */
export default defineConfig({
  resolve: { alias },
  // node_modules는 기본적으로 externalize되어 런타임 의존성으로 남는다.
  // 네이티브 바이너리(Rapier wasm 등)를 번들에 우겨넣으면 깨지므로
  // 이 기본 동작을 바꾸지 않는다.
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'dist/server',
    emptyOutDir: true,
    // RQ-81(평가 blocker 1): 런타임 이미지가 `node:22-alpine`(Dockerfile)로
    // 올라갔으므로 이 값도 함께 올린다 — `node:sqlite`(Node 22.5+ 내장)를
    // 최상위 정적 import로 쓰는 `src/server/persistence/statsDb.ts`가
    // 이 빌드 산출물에 그대로 실리기 때문에, target이 실제 런타임보다
    // 낮으면(node20) 배포 이미지가 지원하지 않는 문법으로 컴파일될 위험이
    // 생긴다. `.nvmrc`(22.23.1)·Dockerfile·package.json engines와 정합.
    target: 'node22',
    rollupOptions: {
      output: { entryFileNames: 'index.js' },
    },
  },
})
