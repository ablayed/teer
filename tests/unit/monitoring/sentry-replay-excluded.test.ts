import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  getReplay,
  replayCanvasIntegration,
  replayIntegration,
} from '@/lib/monitoring/sentry-replay-excluded.js';
import { describe, expect, it } from 'vitest';

// Session Replay hors du bundle client (V1 bis-a). `@sentry/browser` ré-exporte `replayIntegration` depuis
// `@sentry-internal/replay` et le build n'élaguait pas ce paquet : ≈ 30 kB gz étaient téléchargés sans
// qu'aucune intégration Replay soit configurée. Un alias webpack le remplace, côté client, par un module qui
// échoue bruyamment si on l'utilise.

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('module de remplacement de Replay', () => {
  it('replayIntegration échoue bruyamment au lieu de ne rien faire', () => {
    expect(() => replayIntegration()).toThrow(/Session Replay est exclu/);
  });

  it('getReplay ne rend rien', () => {
    expect(getReplay()).toBeUndefined();
  });

  it('replayCanvasIntegration échoue bruyamment', () => {
    expect(() => replayCanvasIntegration()).toThrow(/Session Replay est exclu/);
  });
});

describe('configuration du build', () => {
  const config = read('next.config.mjs');

  it('l’alias n’existe que pour le client', () => {
    expect(config).toMatch(/if \(!isServer\)/);
    expect(config).toContain("config.resolve.alias['@sentry-internal/replay']");
    expect(config).toContain("config.resolve.alias['@sentry/replay']");
    expect(config).toContain("config.resolve.alias['@sentry/replay-canvas']");
    expect(config).toContain('lib/monitoring/sentry-replay-excluded.js');
  });

  it('les options documentées de bundleSizeOptimizations sont posées', () => {
    for (const option of [
      'excludeDebugStatements: true',
      'excludeReplayIframe: true',
      'excludeReplayShadowDom: true',
      'excludeReplayWorker: true',
    ]) {
      expect(config).toContain(option);
    }
  });

  it('aucune intégration Replay n’est configurée côté client', () => {
    // Activer Replay exige de retirer l'alias ET cette garde : un changement conscient, jamais un effet de bord.
    const client = read('sentry.client.config.ts');
    expect(client).not.toMatch(
      /replayIntegration|replaysSessionSampleRate|replaysOnErrorSampleRate/,
    );
  });
});

describe('garde de montée de version du SDK', () => {
  it('@sentry/browser n’importe des modules Replay que des exports remplacés', () => {
    const requireFrom = createRequire(join(root, 'package.json'));
    const sentryNextjs = requireFrom.resolve('@sentry/nextjs/package.json');
    const browserIndex = createRequire(sentryNextjs).resolve('@sentry/browser/package.json');
    const browserPackage = JSON.parse(readFileSync(browserIndex, 'utf8')) as { module: string };
    const barrel = readFileSync(join(browserIndex, '..', browserPackage.module), 'utf8');
    const replayModules = new Map([
      ['@sentry-internal/replay', new Set(['getReplay', 'replayIntegration'])],
      ['@sentry/replay', new Set(['getReplay', 'replayIntegration'])],
      ['@sentry/replay-canvas', new Set(['replayCanvasIntegration'])],
    ]);
    const replayImports = [...barrel.matchAll(/export\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)].filter(
      (match) => replayModules.has(match[2]),
    );
    expect(replayImports.length).toBeGreaterThan(0);

    for (const match of replayImports) {
      const provided = replayModules.get(match[2]);
      const imported = match[1]
        .split(',')
        .map((name) => name.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
      expect(imported.filter((name) => !provided?.has(name))).toEqual([]);
    }
  });
});
