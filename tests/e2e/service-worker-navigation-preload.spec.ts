import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

// FIX-SW-NAVIGATION-PRELOAD-01 — le service worker ne doit jamais doubler une navigation.
//
// Harnais éphémère : un serveur HTTP propre au test sert `public/sw.js` TEL QUEL (lu sur disque,
// jamais recopié) et compte chaque requête reçue. L'« endpoint de test » n'existe que dans ce
// processus, le temps d'un test : aucune route applicative, aucun compteur permanent, aucune
// instrumentation du callback de production. Le Next de Playwright n'est pas utilisé ici.
//
// Pourquoi un serveur dédié plutôt que l'application : le doublement se mesure côté SERVEUR
// (combien de fois la valeur à usage unique arrive), jamais par `page.on('request')`, que le
// service worker rend aveugle (CLAUDE.md, gotcha « service worker »).

const REAL_SW = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

// Motif fautif documenté, reproduit à l'identique de la structure d'avant correctif : Navigation
// Preload activé, navigations `/api/**` rendues au navigateur sans `respondWith`. Témoin positif
// permanent : s'il cesse de doubler, le harnais est devenu aveugle et les preuves « une seule
// réception » ne valent plus rien.
const FAULTY_PATTERN_SW = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => (await event.preloadResponse) || fetch(event.request))());
  }
});
`;

const SHELL_ASSETS = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
const STATIC_CHUNK = '/_next/static/harness-chunk.js';
const COUNTER = '/api/harness/counter';
// SHOPIFY-OAUTH-FIRST-01 / D7 — la chaîne mesurée est celle du parcours OAuth d'abord :
// entrée `application_url` (page interceptée par le service worker) → route d'entrée (`/api/**`,
// rendue au navigateur) → [Shopify, court-circuité] → callback (`/api/**`) → confirmation du
// rattachement. Chaque saut est une redirection 302, et chaque étape porte (en production) une
// valeur à usage unique : requête signée, state et nonce, code d'autorisation, ticket.
const ENTRY_PAGE = '/shopify/embedded/teer-public';
const CLAIM_SURFACE = '/shopify/claim';
const REDIRECTS: Record<string, string> = {
  [ENTRY_PAGE]: '/api/shopify/entry/teer-public?shop=harness.myshopify.com&hmac=harness',
  '/api/shopify/entry/teer-public': '/api/shopify/callback?code=harness-code&state=harness-state',
  '/api/shopify/callback': CLAIM_SURFACE,
};

type Reception = { pathname: string; preload: boolean };

type Harness = {
  base: string;
  receptions: Reception[];
  count(pathname: string): number;
  setServiceWorker(source: string): void;
  stop(): Promise<void>;
};

async function startHarness(initialServiceWorker: string): Promise<Harness> {
  const receptions: Reception[] = [];
  let serviceWorker = initialServiceWorker;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://harness.invalid');

    if (url.pathname === '/sw.js') {
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(serviceWorker);
      return;
    }

    if (SHELL_ASSETS.includes(url.pathname) || url.pathname === STATIC_CHUNK) {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(`/* ${url.pathname} */`);
      return;
    }

    receptions.push({
      pathname: url.pathname,
      preload: request.headers['service-worker-navigation-preload'] !== undefined,
    });

    const location = REDIRECTS[url.pathname];
    if (location) {
      response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><title>${url.pathname}</title><p id="page">${url.pathname}</p><script src="${STATIC_CHUNK}"></script>`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    receptions,
    count: (pathname) => receptions.filter((reception) => reception.pathname === pathname).length,
    setServiceWorker: (source) => {
      serviceWorker = source;
    },
    // Panne réseau réelle : plus aucun socket n'écoute, `fetch` échoue au niveau TCP.
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function registerAndWaitForControl(page: Page, base: string) {
  await page.goto(`${base}/`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        }),
      );
    }
  });
}

async function updateAndWaitForNewController(page: Page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('aucune inscription de service worker');
    const controllerChanged = new Promise<void>((resolve) =>
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
        once: true,
      }),
    );
    await registration.update();
    await controllerChanged;
    // `controllerchange` part dès que le nouveau worker devient actif, AVANT la fin de son
    // `activate` : l'état « activated » est le seul signal que `disable()` a été exécuté.
    const controller = navigator.serviceWorker.controller;
    if (!controller) throw new Error('aucun service worker ne contrôle la page');
    if (controller.state !== 'activated') {
      await new Promise<void>((resolve) =>
        controller.addEventListener('statechange', function onStateChange() {
          if (controller.state === 'activated') {
            controller.removeEventListener('statechange', onStateChange);
            resolve();
          }
        }),
      );
    }
  });
}

async function navigationPreloadEnabled(page: Page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('aucune inscription de service worker');
    return (await registration.navigationPreload.getState()).enabled;
  });
}

// Laisse à une éventuelle doublure le temps d'arriver avant d'affirmer qu'elle n'existe pas.
async function settle(page: Page) {
  await page.waitForTimeout(750);
}

test.describe('FIX-SW-NAVIGATION-PRELOAD-01 — service worker et navigations', () => {
  // Navigation Preload et interception de navigation mesurés sous Chromium, navigateur de
  // l'observation du 2026-09-27 ; les projets WebKit ne sont pas couverts par ce harnais.
  test.skip(({ browserName }) => browserName !== 'chromium', 'mesure Chromium uniquement');

  let harness: Harness;

  test.afterEach(async () => {
    await harness?.stop().catch(() => undefined);
  });

  test('preuve 2 (témoin) : le motif fautif double la navigation et la chaîne OAuth', async ({
    page,
  }) => {
    harness = await startHarness(FAULTY_PATTERN_SW);
    await registerAndWaitForControl(page, harness.base);
    expect(await navigationPreloadEnabled(page)).toBe(true);

    await page.goto(`${harness.base}${COUNTER}`);
    await expect.poll(() => harness.count(COUNTER)).toBe(2);
    expect(harness.receptions.filter((r) => r.pathname === COUNTER && r.preload)).toHaveLength(1);

    await page.goto(`${harness.base}${ENTRY_PAGE}`);
    await expect(page).toHaveURL(/\/shopify\/claim$/);
    await expect.poll(() => harness.count('/api/shopify/callback')).toBe(2);
  });

  test('preuves 1 et 3 : une seule réception par navigation, sans Navigation Preload', async ({
    page,
  }) => {
    harness = await startHarness(REAL_SW);
    await registerAndWaitForControl(page, harness.base);
    expect(await navigationPreloadEnabled(page)).toBe(false);

    // Route exclue de l'interception (`/api/**`) : c'est là que la doublure touchait le callback.
    await page.goto(`${harness.base}${COUNTER}`);
    // Route interceptée par le service worker.
    await page.goto(`${harness.base}/tableau`);
    await expect(page.locator('#page')).toHaveText('/tableau');
    await settle(page);

    expect(harness.count(COUNTER)).toBe(1);
    expect(harness.count('/tableau')).toBe(1);
    expect(harness.receptions.filter((r) => r.preload)).toEqual([]);
  });

  test('preuve 1 (mise à jour) : une inscription où le preload était actif le perd', async ({
    page,
  }) => {
    // Cas réel des navigateurs marchands : l'état « preload activé » vit sur l'INSCRIPTION et
    // survit au remplacement du script. Retirer `enable()` ne suffit pas, `disable()` est exigé.
    harness = await startHarness(FAULTY_PATTERN_SW);
    await registerAndWaitForControl(page, harness.base);
    expect(await navigationPreloadEnabled(page)).toBe(true);

    harness.setServiceWorker(REAL_SW);
    await updateAndWaitForNewController(page);
    expect(await navigationPreloadEnabled(page)).toBe(false);

    const before = harness.receptions.length;
    await page.goto(`${harness.base}${COUNTER}`);
    await settle(page);

    expect(harness.count(COUNTER)).toBe(1);
    expect(harness.receptions.slice(before).filter((r) => r.preload)).toEqual([]);
  });

  test('preuves 4 et 5 : la chaîne entrée → callback → /shopify/claim, une fois chacune', async ({
    page,
  }) => {
    harness = await startHarness(REAL_SW);
    await registerAndWaitForControl(page, harness.base);

    const response = await page.goto(`${harness.base}${ENTRY_PAGE}`);
    await expect(page).toHaveURL(/\/shopify\/claim$/);
    await settle(page);

    expect(response?.status()).toBe(200);
    await expect(page.locator('#page')).toHaveText(CLAIM_SURFACE);
    for (const pathname of [
      ENTRY_PAGE,
      '/api/shopify/entry/teer-public',
      '/api/shopify/callback',
      CLAIM_SURFACE,
    ]) {
      expect(harness.count(pathname), pathname).toBe(1);
    }
    expect(harness.receptions.filter((r) => r.preload)).toEqual([]);
  });

  test('preuves 5 et 6 : en panne réseau réelle, les replis hors ligne restent conformes', async ({
    page,
  }) => {
    harness = await startHarness(REAL_SW);
    await registerAndWaitForControl(page, harness.base);

    // Page contrôlée : son chunk `/_next/static/` passe par le cache « cache first ».
    await page.goto(`${harness.base}/parametres`);
    await expect(page.locator('#page')).toHaveText('/parametres');

    await harness.stop();

    const offline = await page.evaluate(
      async ({ chunk, shell }) => {
        const read = async (path: string) => {
          const response = await fetch(path);
          return { status: response.status, body: await response.text() };
        };
        return {
          chunk: await read(chunk),
          shell: await read(shell),
          other: await read('/ressource-non-cachee'),
        };
      },
      { chunk: STATIC_CHUNK, shell: SHELL_ASSETS[0] },
    );
    expect(offline.chunk).toEqual({ status: 200, body: `/* ${STATIC_CHUNK} */` });
    expect(offline.shell).toEqual({ status: 200, body: `/* ${SHELL_ASSETS[0]} */` });
    expect(offline.other).toEqual({ status: 503, body: 'Ressource réseau indisponible.' });

    const navigation = await page.goto(`${harness.base}/tableau`);
    expect(navigation?.status()).toBe(503);
    await expect(page.locator('body')).toHaveText('Navigation indisponible hors ligne.');
  });
});
