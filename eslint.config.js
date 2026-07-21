import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/server/**/*.ts', 'tests/**/*.ts', '*.config.ts', 'vite.alias.ts'],
    languageOptions: { globals: globals.node },
  },

  // ADR-0010: src/shared는 런타임 환경 중립이어야 한다. 브라우저 전용
  // (window·document)도 Node 전용(process·fs)도 쓰면 안 된다 — 양쪽에서
  // 같은 코드가 돌아야 클라이언트 예측(RQ-62)이 성립하기 때문이다.
  // ADR-0008 결정론: 시뮬레이션 코드는 Math.random()·Date.now()를 직접
  // 호출하지 않는다. 난수는 시드 주입, 시간은 틱에서 받는다.
  {
    files: ['src/shared/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/shared는 환경 중립이어야 한다 (ADR-0010).' },
        { name: 'document', message: 'src/shared는 환경 중립이어야 한다 (ADR-0010).' },
        { name: 'process', message: 'src/shared는 환경 중립이어야 한다 (ADR-0010).' },
      ],
      // no-restricted-globals는 전역 **참조**만 본다. 임포트 형태
      // (`import fs from 'node:fs'`)는 통과하므로 아래 규칙이 함께 필요하다.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'src/shared는 환경 중립이어야 한다 (ADR-0010).' },
          ],
          paths: ['fs', 'path', 'os', 'crypto', 'process', 'child_process', 'net'].map(
            (name) => ({ name, message: 'src/shared는 환경 중립이어야 한다 (ADR-0010).' }),
          ),
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: '시뮬레이션은 결정론적이어야 한다 — 시드를 주입하라 (ADR-0008).',
        },
        {
          object: 'Date',
          property: 'now',
          message: '시뮬레이션은 결정론적이어야 한다 — 시간은 틱에서 받아라 (ADR-0008).',
        },
        {
          // ADR-0008이 Date.now()와 나란히 금지한 API.
          object: 'performance',
          property: 'now',
          message: '시뮬레이션은 결정론적이어야 한다 — 시간은 틱에서 받아라 (ADR-0008).',
        },
      ],
    },
  },
)
