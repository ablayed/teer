import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PostHog hors du chemin initial (V1) : jamais chargé avant la fin du chargement de la page et un
// temps mort, jamais sans clé, jamais deux fois, et jamais par un import statique.

const ROOT = resolve(import.meta.dirname, '../../..');

const sdk = vi.hoisted(() => ({ init: vi.fn(), loads: vi.fn() }));
vi.mock('@/lib/security/telemetry-sanitize', () => ({ sanitizePostHogEvent: vi.fn() }));

type Listener = () => void;

function fakeBrowser({ readyState, idle }: { readyState: string; idle: boolean }) {
  const loadListeners: Listener[] = [];
  const idleCallbacks: Listener[] = [];
  const timeouts: Listener[] = [];
  const win: Record<string, unknown> = {
    addEventListener: (_event: string, listener: Listener) => loadListeners.push(listener),
    setTimeout: (callback: Listener) => timeouts.push(callback),
  };
  if (idle) win.requestIdleCallback = (callback: Listener) => idleCallbacks.push(callback);
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', { readyState });
  return { idleCallbacks, loadListeners, timeouts };
}

// Un import() dynamique se résout après plusieurs tours : on attend un vrai tour de boucle.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

describe('PostHog chargé après la page, pendant un temps mort', () => {
  beforeEach(() => {
    vi.resetModules();
    // Le SDK est simulé APRÈS la remise à zéro des modules : sa fabrique ne s'exécute qu'à son chargement réel.
    vi.doMock('posthog-js', () => {
      sdk.loads();
      return { default: { init: sdk.init } };
    });
    sdk.init.mockReset();
    sdk.loads.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sans clé : rien n’est planifié, le SDK n’est jamais chargé', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const browser = fakeBrowser({ idle: true, readyState: 'complete' });
    const { initPostHog } = await import('@/lib/analytics/posthog');

    initPostHog();
    await flush();

    expect(browser.idleCallbacks).toHaveLength(0);
    expect(browser.loadListeners).toHaveLength(0);
    expect(sdk.loads).not.toHaveBeenCalled();
  });

  it('page encore en chargement : attend l’événement load, puis un temps mort', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test');
    const browser = fakeBrowser({ idle: true, readyState: 'loading' });
    const { initPostHog } = await import('@/lib/analytics/posthog');

    initPostHog();
    await flush();
    expect(sdk.loads).not.toHaveBeenCalled();
    expect(browser.loadListeners).toHaveLength(1);

    browser.loadListeners[0]?.();
    await flush();
    expect(sdk.loads).not.toHaveBeenCalled();
    expect(browser.idleCallbacks).toHaveLength(1);

    browser.idleCallbacks[0]?.();
    await flush();
    expect(sdk.loads).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it('page déjà chargée : un temps mort suffit, et le SDK reçoit la clé et l’hôte', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com');
    const browser = fakeBrowser({ idle: true, readyState: 'complete' });
    const { initPostHog } = await import('@/lib/analytics/posthog');

    initPostHog();
    await flush();
    expect(sdk.loads).not.toHaveBeenCalled();

    browser.idleCallbacks[0]?.();
    await flush();
    expect(sdk.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({ api_host: 'https://eu.i.posthog.com', capture_pageview: true }),
    );
  });

  it('sans requestIdleCallback : repli par minuterie', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test');
    const browser = fakeBrowser({ idle: false, readyState: 'complete' });
    const { initPostHog } = await import('@/lib/analytics/posthog');

    initPostHog();
    expect(browser.timeouts).toHaveLength(1);
    browser.timeouts[0]?.();
    await flush();
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it('appelé deux fois : une seule initialisation', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test');
    const browser = fakeBrowser({ idle: true, readyState: 'complete' });
    const { initPostHog } = await import('@/lib/analytics/posthog');

    initPostHog();
    initPostHog();
    expect(browser.idleCallbacks).toHaveLength(1);
    browser.idleCallbacks[0]?.();
    await flush();
    expect(sdk.init).toHaveBeenCalledTimes(1);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.next') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('aucun import statique de posthog-js', () => {
  it('seuls les imports de TYPE existent ; le SDK ne s’importe que par import()', () => {
    const offenders: string[] = [];
    for (const dir of ['app', 'components', 'lib', 'hooks', 'i18n']) {
      const full = join(ROOT, dir);
      try {
        statSync(full);
      } catch {
        continue;
      }
      for (const file of sourceFiles(full)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(
          /^\s*import\s+(?!type\b)[^;]*?from\s+['"]posthog-js[^'"]*['"]/gm,
        )) {
          offenders.push(`${file.replace(ROOT, '')} : ${match[0].trim()}`);
        }
        if (/^\s*import\s+['"]posthog-js/m.test(text)) offenders.push(file.replace(ROOT, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});
