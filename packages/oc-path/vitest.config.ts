import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
      thresholds: {
        perFile: true,
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
