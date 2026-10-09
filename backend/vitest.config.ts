import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      include: ['src/accounting/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      // BACKEND.md §14: accounting və domain üçün 100% əhatə hədəfi (budaq əhatəsi müdafiə
      // xarakterli `?? default` budaqlarına görə bir qədər aşağıdır)
      thresholds: {
        'src/accounting/**/*.ts': { lines: 100, statements: 100, functions: 100, branches: 90 },
      },
    },
  },
});
