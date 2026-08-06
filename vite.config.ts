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
    // ⚠️ **개발 클라이언트는 이 프록시를 쓰지 않는다**(원장 24e-1) —
    // `@client/net/endpoint`가 개발 모드에서 게임 서버(2567)로 직접 붙는다.
    //
    // 왜: Colyseus는 매치메이킹 뒤 룸 WebSocket을 `/<processId>/<roomId>`로
    // 여는데(colyseus.js `buildEndpoint` 실측) 그 경로는 아래 `/matchmake`
    // 항목에 **매칭되지 않는다**. 그래서 Vite가 SPA fallback으로 index.html을
    // 돌려주고 WS 업그레이드가 성립하지 않아 `joinOrCreate`가 무한 대기했다.
    // `ws: true`는 **해당 경로 항목**의 업그레이드만 허용할 뿐이라 이 고장을
    // 고치지 못한다 — 이전 주석이 이 증상을 정확히 서술해 놓고도 그렇게
    // 고쳐져 있었다.
    //
    // 이 항목을 남겨 두는 이유: 매치메이킹만 같은 오리진으로 확인하고 싶을 때
    // (예: 프록시 경로 회귀 점검) 쓸 수 있고, 프로덕션 Nginx 구성(ADR-0009)이
    // 같은 오리진을 전제한다는 사실을 코드에 남긴다.
    proxy: {
      '/matchmake': { target: 'http://localhost:2567', ws: true },
    },
  },
})
