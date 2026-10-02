import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SHOPIFY_CLAIM_TICKET_COOKIE,
  shopifyClaimTicketCookieOptions,
} from '@/lib/shopify/claim-ticket';
import { expect, test } from '@playwright/test';

// SHOPIFY-OAUTH-FIRST-01 / T38 — protections CSRF du POST de rattachement (/shopify/claim).
//
// (a) et (c) exigent un vrai serveur et un vrai navigateur ; (b) et (d) sont prouvés en unitaire
// (tests/unit/shopify-oauth-first-claim-action.test.ts) et contre la base réelle
// (tests/rls/shopify-oauth-first-01.rls.test.ts).
//
// (a) Next compare `Origin` à l'hôte AVANT de résoudre l'action : un `Origin` intersite explicite
//     est rejeté quel que soit l'identifiant d'action. Contrôle positif : la même requête depuis
//     la même origine passe ce contrôle et n'échoue qu'à la résolution de l'action (inconnue).
//     [Fait] une requête SANS `Origin` est admise par Next (avertissement seulement) : ce test ne
//     prétend pas le contraire, et l'action ne repose pas sur ce contrôle.
// (c) Le cookie de ticket est posé avec les options EXACTES du code (`shopifyClaimTicketCookieOptions`)
//     par un harnais éphémère ; un formulaire POST envoyé depuis un AUTRE site ne le transporte
//     pas. Contrôle positif : le même POST depuis le même site le transporte. `localhost` et
//     `127.0.0.1` sont deux sites distincts pour le navigateur.

test.describe('T38 (a) — Origin intersite rejeté avant toute action', () => {
  const unknownAction = '0'.repeat(42);

  test('Origin intersite explicite → rejet ; même origine → contrôle franchi', async ({
    request,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
    const post = (requestOrigin: string) =>
      request.post('/shopify/claim', {
        headers: {
          'Next-Action': unknownAction,
          Origin: requestOrigin,
          'Content-Type': 'text/plain;charset=UTF-8',
          Accept: 'text/x-component',
        },
        data: '[{}]',
        maxRedirects: 0,
      });

    const crossSite = await post('https://evil.example');
    const sameOrigin = await post(origin);

    // Même requête, seule l'origine change : les deux réponses doivent différer, et la
    // requête intersite ne doit jamais atteindre la résolution de l'action.
    expect(crossSite.status()).toBe(500);
    expect(crossSite.headers()['x-nextjs-action-not-found']).toBeUndefined();
    expect(sameOrigin.status()).toBe(404);
    expect(sameOrigin.headers()['x-nextjs-action-not-found']).toBe('1');
  });
});

type Reception = { site: string; cookie: string | undefined };
type SiteResponse = { status: number; headers: Record<string, string>; body: string };

async function startSite(
  handler: (
    url: URL,
    cookie: string | undefined,
    receptions: Reception[],
  ) => {
    status: number;
    headers: Record<string, string>;
    body: string;
  },
  receptions: Reception[],
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://harness.invalid');
    const result = handler(url, request.headers.cookie, receptions);
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function serializeTicketCookie(value: string): string {
  const options = shopifyClaimTicketCookieOptions(600);
  return [
    `${SHOPIFY_CLAIM_TICKET_COOKIE}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    options.httpOnly ? 'HttpOnly' : null,
    options.secure ? 'Secure' : null,
    options.sameSite ? `SameSite=${options.sameSite}` : null,
  ]
    .filter(Boolean)
    .join('; ');
}

function autoSubmitPage(action: string): string {
  return `<!doctype html><form id="f" method="POST" action="${action}"></form><script>document.getElementById('f').submit()</script>`;
}

test.describe('T38 (c) — cookie de ticket SameSite=Lax absent d’un POST intersite', () => {
  // Sémantique SameSite mesurée sous Chromium ; les projets WebKit ne sont pas couverts ici.
  test.skip(({ browserName }) => browserName !== 'chromium', 'mesure Chromium uniquement');

  const servers: Server[] = [];
  test.afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  test('POST depuis un autre site : cookie absent ; depuis le même site : cookie présent', async ({
    page,
  }) => {
    const receptions: Reception[] = [];
    // Site A (127.0.0.1) : pose le cookie comme l'application, reçoit le POST de rattachement.
    const siteA = await startSite((url, cookie, log): SiteResponse => {
      if (url.pathname === '/set') {
        return {
          status: 200,
          headers: {
            'Set-Cookie': serializeTicketCookie('ticket-harness'),
            'Content-Type': 'text/html',
          },
          body: '<p>set</p>',
        };
      }
      if (url.pathname === '/same-site') {
        return {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
          body: autoSubmitPage('/shopify/claim'),
        };
      }
      if (url.pathname === '/shopify/claim') {
        log.push({ site: 'A', cookie });
        return {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
          body: '<p id="received">reçu</p>',
        };
      }
      return { status: 404, headers: {}, body: '' };
    }, receptions);
    servers.push(siteA.server);
    const originA = `http://127.0.0.1:${siteA.port}`;

    // Site B (localhost) : un autre site, qui soumet un formulaire vers le site A.
    const siteB = await startSite(
      (): SiteResponse => ({
        status: 200,
        headers: { 'Content-Type': 'text/html' },
        body: autoSubmitPage(`${originA}/shopify/claim`),
      }),
      receptions,
    );
    servers.push(siteB.server);

    await page.goto(`${originA}/set`);
    // Le cookie est limité à /shopify/claim : on le lit à ce chemin.
    const cookies = await page.context().cookies(`${originA}/shopify/claim`);
    expect(cookies.find((cookie) => cookie.name === SHOPIFY_CLAIM_TICKET_COOKIE)?.sameSite).toBe(
      'Lax',
    );

    await page.goto(`http://localhost:${siteB.port}/`);
    await expect(page.locator('#received')).toBeVisible();
    await page.goto(`${originA}/same-site`);
    await expect(page.locator('#received')).toBeVisible();

    expect(receptions).toHaveLength(2);
    expect(receptions[0].cookie ?? '').not.toContain(SHOPIFY_CLAIM_TICKET_COOKIE);
    expect(receptions[1].cookie ?? '').toContain(`${SHOPIFY_CLAIM_TICKET_COOKIE}=ticket-harness`);
  });
});
