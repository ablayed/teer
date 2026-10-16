import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getReplay, replayIntegration } from '@/lib/monitoring/sentry-replay-excluded.js';
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
});

describe('configuration du build', () => {
  const config = read('next.config.mjs');

  it('l’alias n’existe que pour le client', () => {
    expect(config).toMatch(/if \(!isServer\)/);
    expect(config).toContain("config.resolve.alias['@sentry-internal/replay']");
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
  it('@sentry/browser n’importe de @sentry-internal/replay que ce que le module de remplacement exporte', () => {
    const requireFrom = createRequire(join(root, 'package.json'));
    const sentryNextjs = requireFrom.resolve('@sentry/nextjs/package.json');
    const browserIndex = createRequire(sentryNextjs).resolve('@sentry/browser/package.json');
    const barrel = readFileSync(join(browserIndex, '..', 'build/npm/esm/index.js'), 'utf8');
    const imported = [
      ...barrel.matchAll(/export\s*\{([^}]+)\}\s*from\s*'@sentry-internal\/replay'/g),
    ]
      .flatMap((match) => match[1].split(','))
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();
    expect(imported.length).toBeGreaterThan(0);
    const provided = ['getReplay', 'replayIntegration'];
    expect(imported.filter((name) => !provided.includes(name))).toEqual([]);
  });
});
