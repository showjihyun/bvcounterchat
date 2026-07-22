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

    // pool은 vitest 기본값 'forks'를 쓴다 (명시 안 함 = forks).
    //
    // 시도 이력(반복하지 말 것): RQ-04 통합 테스트(Colyseus 실 소켓 + 서버
    // 종료)에 콜드스타트 워커 크래시 flaky가 있어 pool 계층 수정을 시도했으나:
    //   - `pool:'threads'`는 단독 크래시율을 못 낮췄고(~1.5%, 270회 실측)
    //     오히려 crash가 게이트 전체로 전파돼 `check.sh`가 불안정해졌다(악화).
    //     forks는 크래시가 파일별 프로세스에 갇혀 게이트가 안정(0/33)이다.
    //   - `maxWorkers:1`은 오히려 악화(13%). 크래시는 다중 워커 churn이 아니다.
    // 결론: forks 유지가 최선. 잔여 단독-파일 flaky의 exit-127 근본 원인은
    // vitest/Node teardown 계층 black-box로 미규명(2개 세션이 규명 실패).
    // 애플리케이션 측 실제 버그 2개는 `src/server/index.ts`에서 수정됨.
  },
})
