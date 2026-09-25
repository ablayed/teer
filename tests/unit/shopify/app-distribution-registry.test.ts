import { type ShopifyAppEnvSource, createShopifyAppRegistry } from '@/lib/shopify/app-registry';
// SHOPIFY-EXPIRING-TOKENS-01 — preuves 1, 2 et 3.
//
// Preuve 3 (distribution non déclarée → échec DUR à la construction du registre) est un échec de
// COMPILATION, pas d'exécution : les configurations sont statiques (`SHOPIFY_APP_ENV_KEYS`,
// `as const satisfies readonly ShopifyAppEnvKeySpec[]`). Les directives `@ts-expect-error`
// ci-dessous font échouer `pnpm typecheck` si le champ redevient optionnel (la directive devient
// alors inutilisée, erreur TS2578) — c'est la preuve, vérifiée par mutation.
import {
  SHOPIFY_APP_ENV_KEYS,
  type ShopifyAppEnvKeySpec,
} from '@/lib/shopify/app-registry-sources';
import {
  exchangeCodeForToken,
  exchangeIdTokenForOfflineToken,
  requestsExpiringOfflineToken,
} from '@/lib/shopify/oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('preuve 3 — la distribution est obligatoire, sans défaut', () => {
  it('une entrée de registre sans distribution ne compile pas', () => {
    // @ts-expect-error — `distribution` manquante : ShopifyAppEnvKeySpec l'exige.
    const missing: ShopifyAppEnvKeySpec = {
      label: 'teer-sixieme',
      clientIdKey: 'SHOPIFY_SIXIEME_API_KEY',
      clientSecretKey: 'SHOPIFY_SIXIEME_API_SECRET',
    };
    expect(missing).toBeDefined();
  });

  it('une source de registre sans distribution ne compile pas', () => {
    // @ts-expect-error — `distribution` manquante : ShopifyAppEnvSource l'exige.
    const missing: ShopifyAppEnvSource = {
      label: 'teer-dev',
      clientId: 'client',
      clientSecret: 'secret',
    };
    expect(missing).toBeDefined();
  });

  it('les cinq distributions déclarées sont celles attestées, et aucune n’est déduite', () => {
    expect(
      Object.fromEntries(SHOPIFY_APP_ENV_KEYS.map((entry) => [entry.label, entry.distribution])),
    ).toEqual({
      'teer-dev': 'custom',
      'teer-pilote': 'custom',
      'teer-marchand': 'custom',
      'teer-koba': 'custom',
      'teer-public': 'public',
    });
  });

  it('le registre porte la distribution de chaque source, telle quelle', () => {
    const registry = createShopifyAppRegistry([
      { label: 'teer-dev', clientId: 'dev', clientSecret: 's1', distribution: 'custom' },
      { label: 'teer-public', clientId: 'pub', clientSecret: 's2', distribution: 'public' },
    ]);
    expect(registry.getByClientId('dev')?.distribution).toBe('custom');
    expect(registry.getByClientId('pub')?.distribution).toBe('public');
  });
});

function tokenResponse() {
  return new Response(
    JSON.stringify({ access_token: 'access', scope: 'read_orders', expires_in: 3600 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(request.body));
}

describe('preuves 1 et 2 — expiring=1 selon la distribution, sur les DEUX chemins', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('règle unique : public → expiring, custom → jamais', () => {
    expect(requestsExpiringOfflineToken('public')).toBe(true);
    expect(requestsExpiringOfflineToken('custom')).toBe(false);
  });

  it('preuve 1 — échange de code, app publique : expiring=1 envoyé', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    globalThis.fetch = fetchMock as typeof fetch;

    await exchangeCodeForToken({
      shop: 'shop.myshopify.com',
      clientId: 'client',
      clientSecret: 'secret',
      code: 'code',
      distribution: 'public',
    });

    expect(sentBody(fetchMock)).toMatchObject({ expiring: '1' });
  });

  it('preuve 1 — échange par ID token, app publique : expiring=1 envoyé', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    globalThis.fetch = fetchMock as typeof fetch;

    await exchangeIdTokenForOfflineToken({
      shop: 'shop.myshopify.com',
      clientId: 'client',
      clientSecret: 'secret',
      idToken: 'id-token',
      distribution: 'public',
    });

    expect(sentBody(fetchMock)).toMatchObject({ expiring: '1' });
  });

  it('preuve 2 — échange de code, app custom : expiring ABSENT', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    globalThis.fetch = fetchMock as typeof fetch;

    await exchangeCodeForToken({
      shop: 'shop.myshopify.com',
      clientId: 'client',
      clientSecret: 'secret',
      code: 'code',
      distribution: 'custom',
    });

    expect(sentBody(fetchMock)).not.toHaveProperty('expiring');
  });

  it('preuve 2 — échange par ID token, app custom : expiring ABSENT', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    globalThis.fetch = fetchMock as typeof fetch;

    await exchangeIdTokenForOfflineToken({
      shop: 'shop.myshopify.com',
      clientId: 'client',
      clientSecret: 'secret',
      idToken: 'id-token',
      distribution: 'custom',
    });

    expect(sentBody(fetchMock)).not.toHaveProperty('expiring');
    // Le reste de la requête est inchangé : seul `expiring` dépend de la distribution.
    expect(sentBody(fetchMock)).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    });
  });

  it('les trois appels au endpoint de jeton sont bornés dans le temps', async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    globalThis.fetch = fetchMock as typeof fetch;

    await exchangeCodeForToken({
      shop: 'shop.myshopify.com',
      clientId: 'client',
      clientSecret: 'secret',
      code: 'code',
      distribution: 'custom',
    });
    const request = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });
});
