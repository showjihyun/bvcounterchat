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
  },
})
