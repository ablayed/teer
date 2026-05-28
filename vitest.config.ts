import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/rls/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      thresholds: { lines: 80, statements: 80 },
    },
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
});
