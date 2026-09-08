// APP-03 / Lot 2 — cœur métier du rattachement embarqué : deux gardes (bascule d'app, propriété
// par tenant), écriture pending (jamais store_connection ici), jamais un write sur intent invalide.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC_APP = {
  label: 'teer-public' as const,
  clientId: 'public_client_sentinel',
  clientSecret: 'public_secret_sentinel',
};

type ShopRow = {
  id: string;
  shop_domain: string;
  merchant_account_id: string;
  shopify_client_id: string | null;
  [key: string]: unknown;
};

const harness = vi.hoisted(() => ({
  shops: [] as ShopRow[],
  membership: null as { id: string } | null,
  nextId: 0,
  shopInsertCalls: [] as Array<Record<string, unknown>>,
  shopUpdateCalls: [] as Array<{
    payload: Record<string, unknown>;
    filters: Array<[string, unknown]>;
  }>,
}));

vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByClientId: vi.fn((clientId: string | null) =>
    clientId === PUBLIC_APP.clientId ? PUBLIC_APP : null,
  ),
}));

const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({
    from(table: string) {
      if (table !== 'shop') throw new Error(`unexpected admin table ${table}`);
      return {
        select: () => ({
          eq: (_col: string, domain: string) => ({
            maybeSingle: async () => ({
              data: harness.shops.find((s) => s.shop_domain === domain) ?? null,
              error: null,
            }),
          }),
        }),
        insert: (payload: Record<string, unknown>) => {
          harness.shopInsertCalls.push(payload);
          harness.shops.push({
            ...(payload as ShopRow),
            id: `shop-${++harness.nextId}`,
          });
          return Promise.resolve({ error: null });
        },
        update: (payload: Record<string, unknown>) => {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            // biome-ignore lint/suspicious/noThenProperty: thenable délibéré (PostgrestFilterBuilder réel, awaitable sans .select())
            then(resolve: (result: { error: null }) => void) {
              harness.shopUpdateCalls.push({ payload, filters });
              const row = harness.shops.find((s) =>
                filters.every(([column, value]) => s[column] === value),
              );
              if (row) Object.assign(row, payload);
              resolve({ error: null });
            },
          };
          return builder;
        },
      };
    },
  })),
}));

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table !== 'merchant_member') throw new Error(`unexpected ctx table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: harness.membership, error: null }),
            }),
          }),
        }),
      };
    },
    // biome-ignore lint/suspicious/noExplicitAny: fake client, shape not exercised beyond `from`.
  } as any;
}

const VALID_HOST = Buffer.from('admin.shopify.com/store/acme-shop', 'utf8').toString('base64url');

describe('performShopifyEmbeddedLink', () => {
  beforeEach(async () => {
    harness.shops = [];
    harness.membership = { id: 'membership-sentinel' };
    harness.nextId = 0;
    harness.shopInsertCalls = [];
    harness.shopUpdateCalls = [];
    captureException.mockClear();
    captureMessage.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
    process.env.SHOPIFY_API_SECRET = 'intent-secret-sentinel';
  });

  async function signIntent(
    overrides: Partial<{ shopDomain: string; clientId: string; host: string; exp: number }> = {},
  ) {
    const { signEmbeddedLinkIntent } = await import('@/lib/shopify/embedded-link-intent');
    return signEmbeddedLinkIntent({
      shopDomain: 'acme-shop.myshopify.com',
      clientId: PUBLIC_APP.clientId,
      host: VALID_HOST,
      exp: Date.now() + 60_000,
      ...overrides,
    });
  }

  it("refuse sans écriture quand l'intent est invalide", async () => {
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent: 'not-a-valid-token', merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'intent_invalid' });
    expect(harness.shopInsertCalls).toHaveLength(0);
  });

  it("refuse sans écriture quand l'utilisateur n'est pas membre du tenant demandé", async () => {
    harness.membership = null;
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'not_a_member' });
    expect(harness.shopInsertCalls).toHaveLength(0);
  });

  it('insère une ligne shop pending (access_token_encrypted NULL) quand aucune boutique n’existe, et n’écrit jamais store_connection', async () => {
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({
      ok: true,
      redirectUrl: `https://admin.shopify.com/store/acme-shop/apps/${PUBLIC_APP.clientId}`,
    });
    expect(harness.shopInsertCalls).toHaveLength(1);
    expect(harness.shopInsertCalls[0]).toMatchObject({
      merchant_account_id: 'tenant-a',
      shop_domain: 'acme-shop.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'active',
      access_token_encrypted: null,
    });
  });

  it('refuse en fermé, zéro écriture, quand la boutique appartient déjà à une autre app (même tenant)', async () => {
    harness.shops.push({
      id: 'shop-koba',
      shop_domain: 'acme-shop.myshopify.com',
      merchant_account_id: 'tenant-a',
      shopify_client_id: 'koba_client_sentinel',
    });
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'app_switch_refused' });
    expect(harness.shopInsertCalls).toHaveLength(0);
    expect(harness.shopUpdateCalls).toHaveLength(0);
    expect(harness.shops[0].shopify_client_id).toBe('koba_client_sentinel');
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SHOPIFY_APP_SWITCH_REFUSED' }),
      expect.anything(),
    );
  });

  it('refuse en fermé, zéro écriture, quand la boutique appartient à un autre tenant (garde de propriété réutilisée)', async () => {
    harness.shops.push({
      id: 'shop-victim',
      shop_domain: 'acme-shop.myshopify.com',
      merchant_account_id: 'tenant-victim',
      shopify_client_id: PUBLIC_APP.clientId,
    });
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'ownership_refused' });
    expect(harness.shopUpdateCalls).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_embedded_link_ownership_guard_refused',
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'ownership_mismatch' }) }),
    );
  });

  it('met à jour (reconnexion) sans jamais inclure merchant_account_id dans le payload d’update', async () => {
    harness.shops.push({
      id: 'shop-existing',
      shop_domain: 'acme-shop.myshopify.com',
      merchant_account_id: 'tenant-a',
      shopify_client_id: PUBLIC_APP.clientId,
    });
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result.ok).toBe(true);
    expect(harness.shopInsertCalls).toHaveLength(0);
    expect(harness.shopUpdateCalls).toHaveLength(1);
    expect(harness.shopUpdateCalls[0].payload).not.toHaveProperty('merchant_account_id');
    expect(harness.shopUpdateCalls[0].filters).toContainEqual(['id', 'shop-existing']);
    expect(harness.shopUpdateCalls[0].filters).toContainEqual(['merchant_account_id', 'tenant-a']);
  });
});
