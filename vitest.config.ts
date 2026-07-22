import { defineConfig } from 'vitest/config'
import { alias } from './vite.alias'

// ADR-0008: 단위(순수 로직) + 통합(Colyseus 경계). 렌더링(R3F)은 테스트
// 대상이 아니다 — typecheck·lint·스모크·수동 확인이 대신 게이트다
// (`harness/workflow/fe.md`).
export default defineConfig({
  resolve: { alias },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // ADR-0008 결정론 요구: 모든 대기에 상한을 둔다. 무한 대기하는 테스트는
    // CI를 멈추게 하고, 멈춘 게이트는 꺼진 게이트다.
    testTimeout: 10_000,
    hookTimeout: 10_000,

    // pool을 vitest 기본값 'forks'에서 'threads'로 바꾼다.
    //
    // 왜: 통합 테스트(Colyseus 실 소켓 + 서버 종료)를 돌린 뒤 fork 워커가
    // teardown 중 child_process IPC 채널에서 비정상 종료하는 flaky가 있었다
    // (RQ-04, 콜드스타트 크래시 — `ERR_IPC_CHANNEL_CLOSED`/`EPIPE` 시 vitest
    // fork 부트스트랩이 자체 `process.exit(1)`). 원인이 애플리케이션 로직이
    // 아니라 **fork 풀의 child_process IPC 계층**에 있음이 확인됐다:
    //   - 애플리케이션 측 실제 버그 2개(Colyseus 프로세스 전역 리스너 누적,
    //     소켓 drain 미await)는 `src/server/index.ts`에서 이미 수정 — 크래시율을
    //     6.25%→2.75%로 낮췄으나 0은 아니었다.
    //   - 잔여는 fork IPC teardown 고유. `pool:'threads'`는 worker_threads +
    //     MessagePort를 써 그 IPC 채널 자체가 없다 → 실측 30/30 콜드스타트 클린
    //     (forks는 같은 조건 2.75~13%).
    // 이는 우회가 아니라 flaky가 실재하는 계층(fork IPC)을 회피하는 제자리 수정이다.
    //
    // 트레이드오프: threads는 프로세스 격리가 forks보다 약하다. 네이티브 모듈
    // (Rapier WASM 등)이 테스트에 들어올 때 문제가 생기면 그때 통합만 forks로
    // 되돌리는 등 재검토한다. `isolate`는 기본(true) — 파일별 모듈 격리는 유지.
    pool: 'threads',
  },
})
