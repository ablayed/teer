// APP-03 / Lot 2 — confrontation d'identité d'app avant tout `ready` sur la session embarquée
// (GET /api/shopify/embedded/session). Avant ce lot, cette route n'avait aucun test dédié.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC_APP = {
  label: 'teer-public' as const,
  clientId: 'public_client_sentinel',
  clientSecret: 'public_secret_sentinel',
};

const harness = vi.hoisted(() => ({
  shop: null as Record<string, unknown> | null,
  shopUpdateCalls: [] as Array<Record<string, unknown>>,
  connectionInsertCalls: [] as Array<Record<string, unknown>>,
  tokenExchangeShouldFail: false,
}));

vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByClientId: vi.fn((clientId: string | null) =>
    clientId === PUBLIC_APP.clientId ? PUBLIC_APP : null,
  ),
}));

vi.mock('@/lib/shopify/session-token', () => ({
  extractShopifySessionAudience: vi.fn(() => PUBLIC_APP.clientId),
  verifyShopifySessionToken: vi.fn(() => ({
    ok: true,
    shopDomain: 'shared-domain.myshopify.com',
    claims: {
      aud: PUBLIC_APP.clientId,
      dest: 'https://shared-domain.myshopify.com',
      exp: 9999999999,
      iat: 1,
      iss: 'https://shared-domain.myshopify.com/admin',
      nbf: 1,
      sub: 'user-sentinel',
    },
  })),
}));

vi.mock('@/lib/shopify/oauth', () => ({
  exchangeIdTokenForOfflineToken: vi.fn(async () => {
    if (harness.tokenExchangeShouldFail) {
      throw new Error('shopify_token_exchange_failed_sentinel');
    }
    return {
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token',
      scope: 'read_customers,read_orders,read_products',
      accessTokenExpiresAt: new Date('2026-01-01T01:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-04-01T00:00:00.000Z'),
    };
  }),
}));

vi.mock('@/lib/shopify/crypto', () => ({
  encryptToken: vi.fn((value: string) => `encrypted-${value}`),
}));

const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({
    from(table: string) {
      if (table === 'shop') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: harness.shop, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            harness.shopUpdateCalls.push(payload);
            return {
              eq: () => ({
                select: () => ({
                  single: async () => {
                    if (!harness.shop) return { data: null, error: { message: 'no shop' } };
                    Object.assign(harness.shop, payload);
                    return {
                      data: {
                        shop_domain: harness.shop.shop_domain,
                        installed_at: harness.shop.installed_at,
                        updated_at: harness.shop.updated_at,
                        last_reconciled_at: harness.shop.last_reconciled_at,
                      },
                      error: null,
                    };
                  },
                }),
              }),
            };
          },
        };
      }

      if (table === 'store_connection') {
        return {
          insert: (payload: Record<string, unknown>) => {
            harness.connectionInsertCalls.push(payload);
            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`unexpected table ${table}`);
    },
  })),
}));

function buildRequest() {
  return new NextRequest('http://localhost:3000/api/shopify/embedded/session', {
    headers: { authorization: 'Bearer synthetic-session-token' },
  });
}

describe('GET /api/shopify/embedded/session — confrontation d’identité d’app', () => {
  beforeEach(() => {
    harness.shop = null;
    harness.shopUpdateCalls = [];
    harness.connectionInsertCalls = [];
    harness.tokenExchangeShouldFail = false;
    captureException.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
    process.env.SHOPIFY_API_SECRET = 'intent-secret-sentinel';
  });

  it('renvoie ready quand shopify_client_id correspond exactement à l’app ayant vérifié le token', async () => {
    harness.shop = {
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'active',
      access_token_encrypted: 'encrypted-token-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.shop.domain).toBe('shared-domain.myshopify.com');
    expect(captureException).not.toHaveBeenCalled();
  });

  it('renvoie uninstalled quand le statut est uninstalled, app inchangée', async () => {
    harness.shop = {
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'uninstalled',
      access_token_encrypted: 'encrypted-token-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body.status).toBe('uninstalled');
    expect(body.nextAction).toBe('reinstall');
  });

  it('renvoie not_configured quand aucune ligne shop n’existe pour ce domaine', async () => {
    harness.shop = null;

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body.status).toBe('not_configured');
    expect(body.shop.domain).toBe('shared-domain.myshopify.com');
  });

  it('refuse en fermé quand la boutique appartient à une autre app (ex. KOBA) — jamais ready, aucune identité historique dans la réponse', async () => {
    harness.shop = {
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: 'koba_client_sentinel',
      status: 'active',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'app_identity_mismatch' });
    expect(body.status).not.toBe('ready');
    expect(body.status).not.toBe('not_configured');
    expect(JSON.stringify(body)).not.toContain('koba_client_sentinel');
    expect(JSON.stringify(body)).not.toContain(PUBLIC_APP.clientId);
    expect(JSON.stringify(body)).not.toContain('shared-domain.myshopify.com');
  });

  it('refuse en fermé quand shopify_client_id est NULL (boutique legacy) — jamais de repli implicite vers une app par défaut', async () => {
    harness.shop = {
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: null,
      status: 'active',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body).toEqual({ status: 'app_identity_mismatch' });
  });

  it('capture une exception interne avec un code stable, jamais déduit du texte du message', async () => {
    harness.shop = {
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: 'koba_client_sentinel',
      status: 'active',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    await GET(buildRequest());

    expect(captureException).toHaveBeenCalledTimes(1);
    const [capturedError, capturedOptions] = captureException.mock.calls[0];
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as { code: string }).code).toBe('SHOPIFY_APP_IDENTITY_MISMATCH');
    expect(capturedOptions).toMatchObject({
      tags: expect.objectContaining({ reason: 'app_identity_mismatch' }),
    });
  });

  it('renvoie une loginUrl signée quand la boutique est not_configured ET host valide', async () => {
    harness.shop = null;
    const validHost = Buffer.from('admin.shopify.com/store/shared-domain', 'utf8').toString(
      'base64url',
    );

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const request = new NextRequest(
      `http://localhost:3000/api/shopify/embedded/session?host=${validHost}`,
      { headers: { authorization: 'Bearer synthetic-session-token' } },
    );
    const response = await GET(request);
    const body = await response.json();

    expect(body.status).toBe('not_configured');
    expect(typeof body.loginUrl).toBe('string');
    expect(body.loginUrl).toContain('/connexion?redirectTo=');
    const redirectTo = decodeURIComponent(body.loginUrl.split('redirectTo=')[1]);
    expect(redirectTo).toContain('/shopify/embedded-link?intent=');
  });

  it('n’expose aucune loginUrl quand host est absent ou invalide (fermé, jamais de destination devinée)', async () => {
    harness.shop = null;

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body.status).toBe('not_configured');
    expect(body).not.toHaveProperty('loginUrl');
  });

  it('complète le rattachement en attente : token exchange + persistance + store_connection, jamais un second aller-retour', async () => {
    harness.shop = {
      id: 'shop-pending',
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'active',
      access_token_encrypted: null,
      merchant_account_id: 'tenant-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body.status).toBe('ready');
    expect(harness.shopUpdateCalls).toHaveLength(1);
    expect(harness.shopUpdateCalls[0]).toMatchObject({
      access_token_encrypted: 'encrypted-fresh-access-token',
      refresh_token_encrypted: 'encrypted-fresh-refresh-token',
    });
    expect(harness.connectionInsertCalls).toHaveLength(1);
    expect(harness.connectionInsertCalls[0]).toMatchObject({
      shop_id: 'shop-pending',
      platform: 'shopify',
      external_identifier: 'shared-domain.myshopify.com',
      platform_app_id: PUBLIC_APP.clientId,
      merchant_account_id: 'tenant-sentinel',
      status: 'active',
    });
  });

  it('renvoie link_retry sans écriture partielle quand le token exchange échoue', async () => {
    harness.shop = {
      id: 'shop-pending',
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'active',
      access_token_encrypted: null,
      merchant_account_id: 'tenant-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };
    harness.tokenExchangeShouldFail = true;

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body).toEqual({
      status: 'link_retry',
      shop: { domain: 'shared-domain.myshopify.com' },
    });
    expect(harness.shopUpdateCalls).toHaveLength(0);
    expect(harness.connectionInsertCalls).toHaveLength(0);
  });
});
