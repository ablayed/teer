import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  publicConfigured: true,
}));

const PUBLIC_APP = {
  label: 'teer-public' as const,
  clientId: 'public_client_sentinel',
  clientSecret: 'public_secret_sentinel',
};
const DEV_APP = {
  label: 'teer-dev' as const,
  clientId: 'dev_client_sentinel',
  clientSecret: 'dev_secret_sentinel',
};

vi.mock('@/lib/shopify/apps', () => ({
  getDefaultShopifyAppOrNull: vi.fn(() => DEV_APP),
  getShopifyAppByLabel: vi.fn((label: string) =>
    label === 'teer-public' && state.publicConfigured ? PUBLIC_APP : null,
  ),
  isKnownShopifyAppLabel: vi.fn((label: string) => label === 'teer-public'),
}));

vi.mock('@/lib/shopify/oauth', () => ({
  validateShopDomain: vi.fn(() => true),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
    },
  })),
}));

describe('GET /api/shopify/embedded/install — contexte d’app', () => {
  beforeEach(() => {
    state.user = null;
    state.publicConfigured = true;
  });

  it('conserve le label Teer Public pendant le passage par connexion', async () => {
    const { GET } = await import('@/app/api/shopify/embedded/install/route');
    const request = new NextRequest(
      'http://localhost:3000/api/shopify/embedded/install?shop=public-shop.myshopify.com&host=synthetic-host&app_label=teer-public',
    );

    const response = await GET(request);
    const loginUrl = new URL(response.headers.get('location') ?? '');
    const redirectTo = loginUrl.searchParams.get('redirectTo');

    expect(loginUrl.pathname).toBe('/connexion');
    expect(redirectTo).toContain('app_label=teer-public');
    expect(redirectTo).toContain('shop=public-shop.myshopify.com');
    expect(redirectTo).toContain('host=synthetic-host');
  });

  it('transmet uniquement l’app sélectionnée à install après authentification', async () => {
    state.user = { id: 'user-sentinel' };
    const { GET } = await import('@/app/api/shopify/embedded/install/route');
    const request = new NextRequest(
      'http://localhost:3000/api/shopify/embedded/install?shop=public-shop.myshopify.com&host=synthetic-host&app_label=teer-public',
    );

    const response = await GET(request);
    const installUrl = new URL(response.headers.get('location') ?? '');

    expect(installUrl.pathname).toBe('/api/shopify/install');
    expect(installUrl.searchParams.get('client_id')).toBe(PUBLIC_APP.clientId);
    expect(installUrl.searchParams.get('return_to')).toContain('/shopify/embedded/teer-public');
    expect(installUrl.searchParams.get('client_id')).not.toBe(DEV_APP.clientId);
  });

  it('refuse l’app sélectionnée quand ses credentials manquent, sans repli', async () => {
    state.publicConfigured = false;
    const { GET } = await import('@/app/api/shopify/embedded/install/route');
    const request = new NextRequest(
      'http://localhost:3000/api/shopify/embedded/install?shop=public-shop.myshopify.com&app_label=teer-public',
    );

    const response = await GET(request);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'missing_shopify_app' });
  });
});
