// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C4 — callback OAuth historique : la réconciliation des
// abonnements suit la connexion, après la libération du bail des jetons, et son échec ne défait
// jamais le rattachement.
//
// Couche : unitaire, sur le route handler, avec la base en mémoire des suites du callback
// (tests/unit/helpers/fake-shopify-lease-db.ts). La réconciliation elle-même est remplacée par un
// espion : elle est prouvée contre PostgreSQL dans tests/rls/shopify-webhooks-1b-reconcile.
import { fakeLeaseDb } from '@/tests/unit/helpers/fake-shopify-lease-db';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT = 'tenant-sentinel';
const SHOP_DOMAIN = 'wps1b-callback-fixture.myshopify.com';

// App custom à jeton non expirant : le régime de KOBA.
const APP = {
  label: 'teer-koba' as const,
  distribution: 'custom' as const,
  clientId: 'synthetic-test-client-id',
  clientSecret: 'synthetic-test-client-secret',
};

const harness = vi.hoisted(() => ({
  reconcileResult: true,
  returnTo: undefined as string | undefined,
  reconcileCalls: [] as Array<{
    input: Record<string, unknown>;
    tokenLeaseReleased: boolean;
    connectionWritten: boolean;
  }>,
}));

vi.mock('@/lib/shopify/post-connect-effects', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/shopify/post-connect-effects')>();
  const { fakeLeaseDb: db } = await import('@/tests/unit/helpers/fake-shopify-lease-db');
  return {
    ...original,
    reconcileWebhooksAfterConnect: async (_admin: unknown, input: Record<string, unknown>) => {
      harness.reconcileCalls.push({
        input,
        tokenLeaseReleased: db.state.releases.length > 0,
        connectionWritten: db.state.connections.length > 0,
      });
      return harness.reconcileResult;
    },
  };
});

vi.mock('@/lib/shopify/apps', () => ({
  getDefaultShopifyAppOrNull: vi.fn(() => APP),
  getShopifyAppByClientId: vi.fn((clientId: string | null) =>
    clientId === APP.clientId ? APP : null,
  ),
}));

vi.mock('@/lib/shopify/state', () => ({
  verifyState: vi.fn(() => ({
    nonce: 'synthetic-nonce',
    merchantAccountId: TENANT,
    shopDomain: SHOP_DOMAIN,
    clientId: APP.clientId,
    returnTo: harness.returnTo,
  })),
}));

vi.mock('@/lib/shopify/oauth', () => ({
  validateShopDomain: vi.fn(() => true),
  verifyOAuthHmac: vi.fn(() => true),
  exchangeCodeForToken: vi.fn(async () => ({
    accessToken: 'synthetic-test-access',
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: 'read_customers,read_orders,read_products',
  })),
}));

vi.mock('@/lib/shopify/crypto', () => ({
  encryptToken: vi.fn((value: string) => `encrypted-${value}`),
}));

vi.mock('@/lib/shopify/products-sync', () => ({
  syncProductsForShop: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock('@/lib/supabase/protected-client', async () => {
  const { fakeLeaseDb: db } = await import('@/tests/unit/helpers/fake-shopify-lease-db');
  return { createProtectedSupabaseClient: vi.fn(() => db.client()) };
});

function buildRequest() {
  return new NextRequest(
    `http://localhost:3000/api/shopify/callback?code=code-sentinel&state=synthetic-nonce&shop=${SHOP_DOMAIN}`,
    { headers: { cookie: 'shopify_oauth_state=state-sentinel' } },
  );
}

async function runCallback() {
  const { GET } = await import('@/app/api/shopify/callback/route');
  const response = await GET(buildRequest());
  const location = response.headers.get('location') as string;
  return new URL(location);
}

beforeEach(() => {
  fakeLeaseDb.reset();
  harness.reconcileResult = true;
  harness.returnTo = undefined;
  harness.reconcileCalls = [];
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
});

describe('callback historique — réconciliation des abonnements (E1)', () => {
  it('est appelée une fois, pour la boutique persistée, APRÈS store_connection et la libération du bail', async () => {
    const target = await runCallback();

    expect(harness.reconcileCalls).toHaveLength(1);
    const call = harness.reconcileCalls[0];
    expect(call.input).toEqual({
      shopId: fakeLeaseDb.state.shops[0].id,
      app: { clientId: APP.clientId, clientSecret: APP.clientSecret },
    });
    expect(call.connectionWritten).toBe(true);
    expect(call.tokenLeaseReleased).toBe(true);
    // Arrivée historique inchangée quand tout a abouti.
    expect(`${target.pathname}${target.search}`).toBe('/boutiques?connected=1');
  });

  it('un échec ne défait jamais le rattachement : boutique et connexion écrites, sync=pending', async () => {
    harness.reconcileResult = false;

    const target = await runCallback();

    expect(target.searchParams.get('error')).toBeNull();
    expect(`${target.pathname}${target.search}`).toBe('/boutiques?connected=1&sync=pending');
    expect(fakeLeaseDb.state.shops).toHaveLength(1);
    expect(fakeLeaseDb.state.shops[0]).toMatchObject({
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT,
    });
    expect(fakeLeaseDb.state.connections).toHaveLength(1);
  });

  it('ajoute sync=pending à un returnTo sans requête comme à un returnTo qui en porte une', async () => {
    harness.reconcileResult = false;

    harness.returnTo = '/parametres?tab=shops&connected=1';
    let target = await runCallback();
    expect(`${target.pathname}${target.search}`).toBe(
      '/parametres?tab=shops&connected=1&sync=pending',
    );

    fakeLeaseDb.reset();
    harness.returnTo = '/boutiques';
    target = await runCallback();
    expect(`${target.pathname}${target.search}`).toBe('/boutiques?sync=pending');
  });

  it('non-régression KOBA : jeton non expirant persisté tel quel, aucune demande de jeton expirant', async () => {
    await runCallback();

    const { exchangeCodeForToken } = await import('@/lib/shopify/oauth');
    expect(vi.mocked(exchangeCodeForToken).mock.calls.at(-1)?.[0]).toMatchObject({
      distribution: 'custom',
    });
    const persist = fakeLeaseDb.state.rpcCalls.find(
      (call) => call.name === 'persist_shopify_credentials_fenced',
    );
    expect(persist?.args.p_refresh_token_encrypted).toBeNull();
    expect(persist?.args.p_access_token_expires_at).toBeNull();
  });
});
