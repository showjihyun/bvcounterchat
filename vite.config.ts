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
    // 임계는 **현재 실측값 바로 위**로 잡는다 — 첫 빌드부터 초과하는 임계는
    // 항상 켜져 있는 경보라서 아무도 안 본다. 지금 목적은 절대 크기 억제가
    // 아니라 '여기서 더 늘었다'는 신호다.
    // 리베이스라인(20b, 리뷰 minor): colyseus.js·zustand 실사용 코드가
    // 클라 번들에 실리며 1,073kB → 1,200.63kB로 자랐다(정당한 성장). 임계를
    // 그대로 두면 경고가 매 빌드 상시 발생해 신호 가치가 죽으므로, 성장을
    // 유발한 이 PR이 임계도 새 실측값(1,200.63kB) 바로 위로 갱신한다.
    // three.js가 대부분을 차지하며, 코드 스플리팅은 로드맵 9단계(최적화).
    chunkSizeWarningLimit: 1250,
  },
  server: {
    port: 5173,
    // 개발 중 클라이언트 → Colyseus 서버(2567) 연결.
    // 프로덕션에서는 Nginx가 같은 오리진으로 프록시한다 (ADR-0009).
    // ws: true — 매치메이킹 HTTP 요청뿐 아니라 Colyseus의 WebSocket
    // 업그레이드도 이 프록시를 타야 한다(PR #1 리뷰 이월 ②). 없으면
    // 매치메이킹은 되지만 룸 접속 WS 핸드셰이크가 프록시를 통과하지 못한다.
    proxy: {
      '/matchmake': { target: 'http://localhost:2567', ws: true },
    },
  },
})
