import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  shops: [] as Array<Record<string, unknown>>,
  connections: [] as Array<Record<string, unknown>>,
}));

const PUBLIC_APP = {
  label: 'teer-public' as const,
  clientId: 'public_client_sentinel',
  clientSecret: 'public_secret_sentinel',
};

vi.mock('@/lib/shopify/apps', () => ({
  getDefaultShopifyAppOrNull: vi.fn(() => null),
  getShopifyAppByClientId: vi.fn((clientId: string | null) =>
    clientId === PUBLIC_APP.clientId ? PUBLIC_APP : null,
  ),
}));

vi.mock('@/lib/shopify/state', () => ({
  verifyState: vi.fn(() => ({
    nonce: 'synthetic-nonce',
    merchantAccountId: 'merchant-sentinel',
    shopDomain: 'public-shop.myshopify.com',
    clientId: PUBLIC_APP.clientId,
  })),
}));

vi.mock('@/lib/shopify/oauth', () => ({
  validateShopDomain: vi.fn(() => true),
  verifyOAuthHmac: vi.fn(() => true),
  exchangeCodeForToken: vi.fn(async () => ({
    accessToken: 'access-token-sentinel',
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

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({
    from(table: string) {
      if (table === 'shop') {
        return {
          upsert(payload: Record<string, unknown>) {
            harness.shops.push(payload);
            return {
              select: () => ({
                single: async () => ({ data: { id: 'shop-sentinel' }, error: null }),
              }),
            };
          },
        };
      }

      if (table === 'store_connection') {
        return {
          upsert: async (payload: Record<string, unknown>) => {
            harness.connections.push(payload);
            return { error: null };
          },
        };
      }

      return { insert: async () => ({ error: null }) };
    },
  })),
}));

describe('callback OAuth — identité Teer Public', () => {
  beforeEach(() => {
    harness.shops.length = 0;
    harness.connections.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
  });

  it('persiste l’identité sélectionnée par le state, jamais celle par défaut', async () => {
    const { GET } = await import('@/app/api/shopify/callback/route');
    const request = new NextRequest(
      'http://localhost:3000/api/shopify/callback?code=code-sentinel&state=synthetic-nonce&shop=public-shop.myshopify.com',
      { headers: { cookie: 'shopify_oauth_state=state-sentinel' } },
    );

    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(harness.shops[0]).toMatchObject({ shopify_client_id: PUBLIC_APP.clientId });
    expect(harness.connections[0]).toMatchObject({ platform_app_id: PUBLIC_APP.clientId });
  });
});
