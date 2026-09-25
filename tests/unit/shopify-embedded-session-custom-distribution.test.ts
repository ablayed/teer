// SHOPIFY-EXPIRING-TOKENS-01 — preuve 2, côté ROUTE `embedded/session` : une app `custom`
// n'envoie jamais `expiring` sur l'échange par ID token.
//
// `lib/shopify/oauth.ts` n'est PAS simulé : la route l'appelle réellement, et c'est le corps
// émis vers le endpoint de jeton Shopify (mock de `fetch`) qui est l'assertion — jamais
// l'argument passé à la fonction d'échange. Une valeur `public` codée en dur dans la route, ou un
// `expiring=1` forcé, fait rougir ce test. Le chemin protégé est celui de KOBA (GETGET SN).
import { fakeLeaseDb } from '@/tests/unit/helpers/fake-shopify-lease-db';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CUSTOM_APP = {
  label: 'teer-koba' as const,
  distribution: 'custom' as const,
  clientId: 'koba_client_sentinel',
  clientSecret: 'koba_secret_sentinel',
  scopes: 'read_customers,read_orders,read_products',
};

const SHOP_DOMAIN = 'custom-shop.myshopify.com';

vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByClientId: vi.fn((clientId: string | null) =>
    clientId === CUSTOM_APP.clientId ? CUSTOM_APP : null,
  ),
}));

vi.mock('@/lib/shopify/session-token', () => ({
  extractShopifySessionAudience: vi.fn(() => CUSTOM_APP.clientId),
  verifyShopifySessionToken: vi.fn(() => ({
    ok: true,
    shopDomain: SHOP_DOMAIN,
    claims: {
      aud: CUSTOM_APP.clientId,
      dest: `https://${SHOP_DOMAIN}`,
      exp: 9999999999,
      iat: 1,
      iss: `https://${SHOP_DOMAIN}/admin`,
      nbf: 1,
      sub: 'user-sentinel',
    },
  })),
}));

vi.mock('@/lib/shopify/crypto', () => ({
  encryptToken: vi.fn((value: string) => `encrypted-${value}`),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@/lib/supabase/protected-client', async () => {
  const { fakeLeaseDb: db } = await import('@/tests/unit/helpers/fake-shopify-lease-db');
  return { createProtectedSupabaseClient: vi.fn(() => db.client()) };
});

const originalFetch = globalThis.fetch;

describe('GET /api/shopify/embedded/session — app custom : expiring jamais émis (preuve 2, route)', () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const tokenUrls: string[] = [];

  beforeEach(() => {
    fakeLeaseDb.reset();
    sentBodies.length = 0;
    tokenUrls.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
    process.env.SHOPIFY_API_SECRET = 'intent-secret-sentinel';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      tokenUrls.push(String(input));
      sentBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ access_token: 'custom-offline-access', scope: 'read_orders' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rattachement en attente d’une app custom : le corps émis vers le endpoint de jeton ne porte pas `expiring`', async () => {
    fakeLeaseDb.state.shops.push({
      id: 'shop-custom',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: 'tenant-sentinel',
      shopify_client_id: CUSTOM_APP.clientId,
      status: 'active',
      access_token_encrypted: null,
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(
      new NextRequest('http://localhost:3000/api/shopify/embedded/session', {
        headers: { authorization: 'Bearer synthetic-session-token' },
      }),
    );
    const body = await response.json();

    // La route est bien allée jusqu'au réseau, par le vrai `oauth.ts`.
    expect(body.status).toBe('ready');
    expect(tokenUrls).toEqual([`https://${SHOP_DOMAIN}/admin/oauth/access_token`]);
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toMatchObject({
      client_id: CUSTOM_APP.clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    });
    // L'ASSERTION : aucun `expiring` dans le corps réellement émis.
    expect(sentBodies[0]).not.toHaveProperty('expiring');
  });
});
