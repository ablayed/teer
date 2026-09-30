import { createHmac } from 'node:crypto';
import { encryptToken } from '@/lib/shopify/crypto';
import { signShopifyNonEmbeddedInstallIntent } from '@/lib/shopify/non-embedded-install-intent';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const app = {
    label: 'teer-public',
    clientId: 'public-client',
    clientSecret: 'public-secret',
    distribution: 'public',
    scopes: 'read_orders',
  };
  const redirect = vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  });
  const cookie = { value: '' };
  const user = { value: { id: 'user-1' } as { id: string } | null };
  const merchantAccount = { value: { id: 'merchant-1' } as { id: string } | null };
  const shell = vi.fn(() => null);
  const authorize = vi.fn();
  const shopRow = { value: null as Record<string, unknown> | null, error: null as Error | null };
  const queryFilters: Array<[string, string]> = [];
  const credentialChecks: unknown[][] = [];
  const query = {
    eq: vi.fn((key: string, value: string) => {
      queryFilters.push([key, value]);
      return query;
    }),
    maybeSingle: vi.fn(async () => {
      const matches = queryFilters.every(([key, value]) => shopRow.value?.[key] === value);
      return { data: matches ? shopRow.value : null, error: shopRow.error };
    }),
  };
  const select = vi.fn(() => {
    queryFilters.length = 0;
    return query;
  });
  const from = vi.fn(() => ({ select }));
  return {
    app,
    authorize,
    cookie,
    credentialChecks,
    from,
    merchantAccount,
    query,
    queryFilters,
    redirect,
    select,
    shell,
    shopRow,
    user,
  };
});

vi.mock('next/navigation', () => ({ redirect: harness.redirect }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-nonce': 'nonce-test' }),
}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  },
  publicEnv: { NEXT_PUBLIC_SUPPORT_EMAIL: null },
}));
vi.mock('@/lib/actions/merchant', () => ({
  getMerchantAccount: vi.fn(async () => harness.merchantAccount.value),
}));
vi.mock('@/lib/shopify/non-embedded-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopify/non-embedded-credentials')>();
  return {
    ...actual,
    hasUsableCredentialsForApp: (...args: Parameters<typeof actual.hasUsableCredentialsForApp>) => {
      harness.credentialChecks.push(args);
      return actual.hasUsableCredentialsForApp(...args);
    },
  };
});
vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByLabel: (label: string) => (label === 'teer-public' ? harness.app : null),
  getShopifyAppByClientId: (clientId: string) =>
    clientId === harness.app.clientId ? harness.app : null,
  getDefaultShopifyAppOrNull: () => harness.app,
}));
vi.mock('@/lib/shopify/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopify/oauth')>();
  return {
    ...actual,
    buildAuthorizeUrl: (...args: Parameters<typeof actual.buildAuthorizeUrl>) => {
      harness.authorize(...args);
      return actual.buildAuthorizeUrl(...args);
    },
  };
});
vi.mock('@/lib/shopify/state', () => ({
  generateNonce: () => 'oauth-nonce',
  signState: () => 'oauth-state',
}));
vi.mock('@/app/shopify/embedded/embedded-app-shell', () => ({ EmbeddedAppShell: harness.shell }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: harness.user.value } }) },
    from: harness.from,
  }),
}));

const key = Buffer.from('non-embedded-resume-test-key')
  .toString('hex')
  .padEnd(64, '0')
  .slice(0, 64);
const shop = 'test-shop.myshopify.com';

async function openInstallEntry() {
  const { GET } = await import('@/app/shopify/install-entry/route');
  return GET(
    new NextRequest('http://localhost:3000/shopify/install-entry', {
      headers: { cookie: `shopify_non_embedded_install_intent=${harness.cookie.value}` },
    }),
  );
}

function locationPath(response: Response): string {
  const location = response.headers.get('location');
  if (!location) return '';
  const url = new URL(location);
  return `${url.pathname}${url.search}`;
}

describe('/shopify/install-entry', () => {
  beforeEach(() => {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = key;
    harness.redirect.mockClear();
    harness.cookie.value = signShopifyNonEmbeddedInstallIntent(
      { appLabel: 'teer-public', shop },
      harness.app.clientSecret,
    );
    harness.user.value = { id: 'user-1' };
    harness.shopRow.value = null;
    harness.shopRow.error = null;
    harness.queryFilters.length = 0;
    harness.query.eq.mockClear();
    harness.query.maybeSingle.mockClear();
    harness.select.mockClear();
    harness.credentialChecks.length = 0;
    harness.authorize.mockClear();
    harness.shell.mockClear();
  });

  it('refuse de choisir un locataire avant que lâ€™utilisateur soit authentifiÃ©', async () => {
    harness.user.value = null;
    const response = await openInstallEntry();
    expect(locationPath(response)).toBe('/connexion?redirectTo=%2Fshopify%2Finstall-entry');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('envoie une boutique strictement installÃ©e vers ParamÃ¨tres sans nouvelle transition OAuth', async () => {
    harness.shopRow.value = {
      shopify_client_id: harness.app.clientId,
      status: 'active',
      store_kind: 'shopify',
      access_token_encrypted: encryptToken('existing-access-token'),
      access_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
      refresh_token_encrypted: null,
      refresh_token_expires_at: null,
      merchant_account_id: 'merchant-1',
      shop_domain: shop,
    };
    const response = await openInstallEntry();
    expect(locationPath(response)).toBe('/parametres?tab=shops&connected=1');
    expect(response.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970');
    expect(harness.queryFilters).toEqual([
      ['merchant_account_id', 'merchant-1'],
      ['shop_domain', shop],
      ['shopify_client_id', harness.app.clientId],
    ]);
    expect(harness.select).toHaveBeenCalledWith(
      'shopify_client_id, status, store_kind, access_token_encrypted, access_token_expires_at, refresh_token_encrypted, refresh_token_expires_at',
    );
  });

  it('normalise le domaine avant la lecture RLS et la reprise', async () => {
    const canonicalShop = 'test-shop.myshopify.com';
    harness.cookie.value = signShopifyNonEmbeddedInstallIntent(
      { appLabel: 'teer-public', shop: 'TEST-SHOP.myshopify.com' },
      harness.app.clientSecret,
    );
    harness.shopRow.value = {
      merchant_account_id: 'merchant-1',
      shop_domain: canonicalShop,
      shopify_client_id: harness.app.clientId,
      status: 'active',
      store_kind: 'shopify',
      access_token_encrypted: encryptToken('existing-access-token'),
      access_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
      refresh_token_encrypted: null,
      refresh_token_expires_at: null,
    };

    const response = await openInstallEntry();

    expect(locationPath(response)).toBe('/parametres?tab=shops&connected=1');
    expect(harness.queryFilters).toContainEqual(['shop_domain', canonicalShop]);
  });

  it.each([
    ['mauvaise app', { shopify_client_id: 'other-client' }],
    ['statut inactif', { status: 'uninstalled' }],
    ['credential absent', { access_token_encrypted: null }],
    ['credential illisible', { access_token_encrypted: 'not-encrypted' }],
  ])(
    'relance OAuth si la boutique ne satisfait pas la garde stricte (%s)',
    async (_label, override) => {
      harness.shopRow.value = {
        shopify_client_id: harness.app.clientId,
        status: 'active',
        store_kind: 'shopify',
        access_token_encrypted: encryptToken('existing-access-token'),
        access_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
        refresh_token_encrypted: null,
        refresh_token_expires_at: null,
        merchant_account_id: 'merchant-1',
        shop_domain: shop,
        ...override,
      };
      const response = await openInstallEntry();
      expect(locationPath(response)).toBe(
        '/api/shopify/install?shop=test-shop.myshopify.com&client_id=public-client&return_to=%2Fparametres%3Ftab%3Dshops%26connected%3D1',
      );
    },
  );

  it('ne lit ni n’utilise pas les credentials d’une boutique du même domaine appartenant à un autre locataire', async () => {
    harness.shopRow.value = {
      merchant_account_id: 'other-merchant',
      shop_domain: shop,
      shopify_client_id: harness.app.clientId,
      status: 'active',
      store_kind: 'shopify',
      access_token_encrypted: encryptToken('other-tenant-access-token'),
      access_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
      refresh_token_encrypted: null,
      refresh_token_expires_at: null,
    };

    const response = await openInstallEntry();

    expect(harness.queryFilters).toEqual([
      ['merchant_account_id', 'merchant-1'],
      ['shop_domain', shop],
      ['shopify_client_id', harness.app.clientId],
    ]);
    expect(harness.credentialChecks).toHaveLength(0);
    expect(locationPath(response)).not.toBe('/parametres?tab=shops&connected=1');
    expect(locationPath(response)).toContain('/api/shopify/install?');
    expect(response.headers.get('location')).not.toContain('other-tenant-access-token');
    expect(response.headers.get('location')).not.toContain('other-merchant');
    expect(harness.authorize).not.toHaveBeenCalled();
  });
});
