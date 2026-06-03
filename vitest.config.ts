import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx', 'tests/rls/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      thresholds: { lines: 80, statements: 80 },
    },
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
});
