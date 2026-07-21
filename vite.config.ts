import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { alias } from './vite.alias'

// 클라이언트 번들 (ADR-0001: React + R3F + Three.js, WebGL2 고정).
// 산출물은 dist/client — ADR-0009의 단일 이미지가 이 디렉토리를 정적 서빙한다.
export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // RQ-01: 내장 GPU 30fps가 하한. 번들이 커지면 첫 로드가 늦어지므로
    // 경고 임계를 낮게 잡아 증가를 조기에 인지한다 (three.js가 크므로 여유는 둔다).
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    // 개발 중 클라이언트 → Colyseus 서버(2567) 연결.
    // 프로덕션에서는 Nginx가 같은 오리진으로 프록시한다 (ADR-0009).
    proxy: {
      '/matchmake': 'http://localhost:2567',
    },
  },
})
