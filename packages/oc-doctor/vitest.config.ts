import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@openclaw/oc-path': resolve(HERE, '../oc-path/src/index.ts'),
      '@openclaw/oc-lint': resolve(HERE, '../oc-lint/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
    },
  },
});
