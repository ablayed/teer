import { fakeLeaseDb } from '@/tests/unit/helpers/fake-shopify-lease-db';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC_APP = {
  label: 'teer-public' as const,
  distribution: 'public' as const,
  clientId: 'public_client_sentinel',
  clientSecret: 'public_secret_sentinel',
};

const exchangeCodeForToken = vi.fn(async (_input: Record<string, unknown>) => ({
  accessToken: 'access-token-sentinel',
  refreshToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  scope: 'read_customers,read_orders,read_products',
}));

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
  exchangeCodeForToken,
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

vi.mock('@/lib/supabase/protected-client', async () => {
  const { fakeLeaseDb: db } = await import('@/tests/unit/helpers/fake-shopify-lease-db');
  return { createProtectedSupabaseClient: vi.fn(() => db.client()) };
});

describe('callback OAuth — identité Teer Public', () => {
  beforeEach(() => {
    fakeLeaseDb.reset();
    exchangeCodeForToken.mockClear();
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
    expect(fakeLeaseDb.state.shops[0]).toMatchObject({ shopify_client_id: PUBLIC_APP.clientId });
    expect(fakeLeaseDb.state.connections[0]).toMatchObject({
      platform_app_id: PUBLIC_APP.clientId,
    });
    // Preuve 1, côté route : une app publique déclare `public` à l'échange de code.
    expect(exchangeCodeForToken).toHaveBeenCalledWith(
      expect.objectContaining({ distribution: 'public' }),
    );
  });
});
