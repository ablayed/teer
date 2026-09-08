// APP-03 / Lot 2 — Teer Public n'a aucun chemin par /api/shopify/install (OAuth `code` legacy) ;
// les 4 apps historiques restent fonctionnelles sur cette même route (contrôle positif requis).
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const APPS = {
  'teer-dev': { label: 'teer-dev' as const, clientId: 'dev_client', clientSecret: 'dev_secret' },
  'teer-pilote': {
    label: 'teer-pilote' as const,
    clientId: 'pilote_client',
    clientSecret: 'pilote_secret',
  },
  'teer-marchand': {
    label: 'teer-marchand' as const,
    clientId: 'marchand_client',
    clientSecret: 'marchand_secret',
  },
  'teer-koba': {
    label: 'teer-koba' as const,
    clientId: 'koba_client',
    clientSecret: 'koba_secret',
  },
  'teer-public': {
    label: 'teer-public' as const,
    clientId: 'public_client',
    clientSecret: 'public_secret',
  },
};

vi.mock('@/lib/actions/merchant', () => ({
  getMerchantAccount: vi.fn(async () => ({ id: 'merchant-sentinel' })),
}));

vi.mock('@/lib/shopify/apps', () => ({
  getDefaultShopifyAppOrNull: vi.fn(() => APPS['teer-dev']),
  getShopifyAppByClientId: vi.fn(
    (clientId: string | null) =>
      Object.values(APPS).find((app) => app.clientId === clientId) ?? null,
  ),
}));

vi.mock('@/lib/shopify/oauth', () => ({
  validateShopDomain: vi.fn(() => true),
  buildAuthorizeUrl: vi.fn(() => 'https://acme-shop.myshopify.com/admin/oauth/authorize?mock=1'),
}));

vi.mock('@/lib/shopify/state', () => ({
  generateNonce: vi.fn(() => 'nonce-sentinel'),
  signState: vi.fn(() => 'signed-state-sentinel'),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-sentinel' } } }) },
  })),
}));

const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

function buildRequest(clientId?: string) {
  const url = new URL('http://localhost:3000/api/shopify/install');
  url.searchParams.set('shop', 'acme-shop.myshopify.com');
  if (clientId) url.searchParams.set('client_id', clientId);
  return new NextRequest(url);
}

describe('GET /api/shopify/install — Teer Public refusé, apps historiques inchangées', () => {
  beforeEach(() => {
    captureException.mockClear();
    captureMessage.mockClear();
  });

  it('refuse Teer Public avec un code interne stable, sans repli vers une autre app', async () => {
    const { GET } = await import('@/app/api/shopify/install/route');
    const response = await GET(buildRequest(APPS['teer-public'].clientId));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'teer_public_not_supported' });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect((captureException.mock.calls[0][0] as { code: string }).code).toBe(
      'SHOPIFY_PUBLIC_LEGACY_ROUTE_REFUSED',
    );
  });

  it.each(['teer-dev', 'teer-pilote', 'teer-marchand', 'teer-koba'] as const)(
    'accepte toujours %s sur la route legacy',
    async (label) => {
      const { GET } = await import('@/app/api/shopify/install/route');
      const response = await GET(
        buildRequest(label === 'teer-dev' ? undefined : APPS[label].clientId),
      );

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('acme-shop.myshopify.com');
      expect(captureException).not.toHaveBeenCalled();
    },
  );
});
