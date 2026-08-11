import { encryptToken } from '@/lib/shopify/crypto';
import { exchangeCodeForToken, refreshAccessToken } from '@/lib/shopify/oauth';
import { type ShopTokenRow, getValidShopAccessToken } from '@/lib/shopify/token';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

describe('Shopify offline expiring tokens', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = encryptionKey;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'SHOPIFY_TOKEN_ENCRYPTION_KEY');
  });

  it('parses an expiring access/refresh pair without exposing it in the result metadata', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        access_token: 'synthetic-access-token',
        expires_in: 3600,
        refresh_token: 'synthetic-refresh-token',
        refresh_token_expires_in: 7_776_000,
        scope: 'read_orders,read_customers,read_products',
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await exchangeCodeForToken({
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      code: 'synthetic-code',
      shop: 'synthetic-shop.myshopify.com',
    });

    expect(result.accessToken).toBe('synthetic-access-token');
    expect(result.refreshToken).toBe('synthetic-refresh-token');
    expect(result.accessTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(result.refreshTokenExpiresAt?.getTime()).toBeGreaterThan(
      result.accessTokenExpiresAt?.getTime() ?? 0,
    );
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });

  it('uses the refresh grant and accepts a rotated refresh token', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        access_token: 'synthetic-rotated-access',
        expires_in: 3600,
        refresh_token: 'synthetic-rotated-refresh',
        refresh_token_expires_in: 7_776_000,
        scope: 'read_orders',
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await refreshAccessToken({
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      refreshToken: 'synthetic-refresh',
      shop: 'synthetic-shop.myshopify.com',
    });

    expect(result.refreshToken).toBe('synthetic-rotated-refresh');
    const request = (fetchMock.mock.calls[0] as unknown[] | undefined)?.[1] as
      | RequestInit
      | undefined;
    expect(JSON.parse(String(request?.body))).toMatchObject({
      client_id: 'synthetic-client',
      grant_type: 'refresh_token',
      refresh_token: 'synthetic-refresh',
    });
  });

  it('serializes concurrent refreshes per shop and uses an optimistic old-token match', async () => {
    const refreshMock = vi
      .spyOn(await import('@/lib/shopify/oauth'), 'refreshAccessToken')
      .mockResolvedValue({
        accessToken: 'synthetic-new-access',
        scope: 'read_orders',
        refreshToken: 'synthetic-new-refresh',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 7_776_000_000),
      });
    const updateQuery = {
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'shop-1' }, error: null }),
      select: vi.fn().mockReturnThis(),
    };
    const admin = {
      from: vi.fn(() => ({ update: vi.fn(() => updateQuery) })),
    } as never;
    const shop: ShopTokenRow = {
      access_token_encrypted: encryptToken('synthetic-old-access'),
      access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
      id: 'shop-1',
      refresh_token_encrypted: encryptToken('synthetic-old-refresh'),
      refresh_token_expires_at: new Date(Date.now() + 7_000_000).toISOString(),
      shop_domain: 'synthetic-shop.myshopify.com',
    };

    const results = await Promise.all([
      getValidShopAccessToken(admin, shop, 'synthetic-client', 'synthetic-secret'),
      getValidShopAccessToken(admin, shop, 'synthetic-client', 'synthetic-secret'),
    ]);

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { ok: true, accessToken: 'synthetic-new-access' },
      { ok: true, accessToken: 'synthetic-new-access' },
    ]);
    expect(updateQuery.eq).toHaveBeenCalledWith(
      'access_token_encrypted',
      shop.access_token_encrypted,
    );
  });
});
