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
  // Runtime JSX automatique, comme Next (React 19). Sans ça, esbuild applique la transforme
  // classique (`React.createElement`) et tout composant testé qui n'importe pas React
  // explicitement échoue au rendu en « React is not defined » — piège rencontré en testant
  // components/dashboard/RecentActivity.tsx, qui n'a aucune raison d'importer React.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
});
