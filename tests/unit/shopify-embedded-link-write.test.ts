// APP-03 / Lot 2 — cœur métier du rattachement embarqué : rôle marchand autoritatif, deux gardes
// (bascule d'app, propriété par tenant), écriture pending (jamais store_connection ici), jamais un
// write sur intent invalide.
//
// SEC-SHOP-CLAIM-01 (0155) : `authenticated` n'a plus aucun privilège INSERT/UPDATE sur `shop`.
// L'écriture passe par la RPC `link_shopify_embedded_shop`, appelée par le client service-role
// avec l'utilisateur de la session serveur, le locataire demandé, et le domaine et l'app de
// l'intention vérifiée. `ctx.supabase` ne sert plus qu'à lire l'appartenance : toute écriture sur
// `shop` par ce client est ici une erreur. Les gardes applicatives refusent AVANT l'appel ; les
// refus rendus par la RPC (course, rôle de boutique) sont relayés sous leur nom. Preuve réelle
// (Postgres, privilèges, RPC) : tests/rls/sec-shop-claim-01-domain-preemption.rls.test.ts et
// tests/rls/shopify-embedded-link-rls.rls.test.ts.
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
};

const harness = vi.hoisted(() => ({
  shops: [] as ShopRow[],
  membership: null as { id: string; role: string } | null,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResponse: null as { data: unknown; error: unknown } | null,
  storeConnectionWriteCount: 0,
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

// `admin` (service-role) : lecture globale de garde + RPC d'écriture. Aucun insert/update direct
// sur `shop`, ni écriture de `store_connection` (créée seulement après l'échange de jeton).
vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      harness.rpcCalls.push({ fn, args });
      if (harness.rpcResponse) return harness.rpcResponse;
      const exists = harness.shops.some((s) => s.shop_domain === args.p_shop_domain);
      return { data: exists ? 'updated' : 'inserted', error: null };
    },
    from(table: string) {
      if (table === 'store_connection') {
        return {
          insert: () => {
            harness.storeConnectionWriteCount += 1;
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table !== 'shop') throw new Error(`unexpected admin table ${table}`);
      return {
        select: () => ({
          eq: (_col: string, domain: string) => ({
            maybeSingle: async () => {
              const row = harness.shops.find((s) => s.shop_domain === domain) ?? null;
              return { data: row ? { ...row } : null, error: null };
            },
          }),
        }),
        insert: () => {
          throw new Error('admin.insert on shop must never be called — write goes through the RPC');
        },
        update: () => {
          throw new Error('admin.update on shop must never be called — write goes through the RPC');
        },
      };
    },
  })),
}));

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table === 'merchant_member') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: harness.membership, error: null }),
              }),
            }),
          }),
        };
      }

      throw new Error(`unexpected ctx table ${table} — ctx.supabase never writes shop since 0155`);
    },
    // biome-ignore lint/suspicious/noExplicitAny: fake client, shape not exercised beyond `from`.
  } as any;
}

const VALID_HOST = Buffer.from('admin.shopify.com/store/acme-shop', 'utf8').toString('base64url');

describe('performShopifyEmbeddedLink', () => {
  beforeEach(async () => {
    harness.shops = [];
    harness.membership = { id: 'membership-sentinel', role: 'owner' };
    harness.rpcCalls = [];
    harness.rpcResponse = null;
    harness.storeConnectionWriteCount = 0;
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
    expect(harness.rpcCalls).toHaveLength(0);
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
    expect(harness.rpcCalls).toHaveLength(0);
  });

  it("refuse sans écriture, code nommé distinct, quand l'utilisateur est membre mais 'agent' (rôle insuffisant)", async () => {
    harness.membership = { id: 'membership-sentinel', role: 'agent' };
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'insufficient_role' });
    expect(harness.rpcCalls).toHaveLength(0);
  });

  it("autorise un rôle 'manager', pas seulement 'owner'", async () => {
    harness.membership = { id: 'membership-sentinel', role: 'manager' };
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result.ok).toBe(true);
    expect(harness.rpcCalls).toHaveLength(1);
  });

  it('écrit la ligne pending par la RPC service-role, avec utilisateur de session, locataire demandé, domaine et app de l’intention — jamais store_connection', async () => {
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
    expect(harness.rpcCalls).toEqual([
      {
        fn: 'link_shopify_embedded_shop',
        args: {
          p_user_id: 'user-a',
          p_merchant_account_id: 'tenant-a',
          p_shop_domain: 'acme-shop.myshopify.com',
          p_client_id: PUBLIC_APP.clientId,
        },
      },
    ]);
    expect(harness.storeConnectionWriteCount).toBe(0);
  });

  it('refuse en fermé, sans appel RPC, quand la boutique appartient déjà à une autre app (même tenant)', async () => {
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
    expect(harness.rpcCalls).toHaveLength(0);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SHOPIFY_APP_SWITCH_REFUSED' }),
      expect.anything(),
    );
  });

  it('refuse en fermé, sans appel RPC, quand la boutique appartient à un autre tenant (garde de propriété réutilisée)', async () => {
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
    expect(harness.rpcCalls).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_embedded_link_ownership_guard_refused',
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'ownership_mismatch' }) }),
    );
  });

  it('reconnexion (même tenant, même app) et boutique libérée (client_id NULL) : RPC appelée, succès', async () => {
    harness.shops.push({
      id: 'shop-existing',
      shop_domain: 'acme-shop.myshopify.com',
      merchant_account_id: 'tenant-a',
      shopify_client_id: null,
    });
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result.ok).toBe(true);
    expect(harness.rpcCalls).toHaveLength(1);
    expect(harness.storeConnectionWriteCount).toBe(0);
  });

  it.each([
    'intent_invalid',
    'not_a_member',
    'insufficient_role',
    'app_switch_refused',
    'ownership_refused',
  ])(
    'refus nommé rendu par la RPC (course ou garde de boutique) : %s relayé tel quel, jamais un succès',
    async (refusal) => {
      harness.rpcResponse = { data: refusal, error: null };
      const intent = await signIntent();
      const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
      const result = await performShopifyEmbeddedLink(
        { intent, merchantAccountId: 'tenant-a' },
        { userId: 'user-a', supabase: fakeSupabase() },
      );

      expect(result).toEqual({ ok: false, errorCode: refusal });
    },
  );

  it.each([
    { label: 'réponse inconnue', response: { data: 'write_failed', error: null } },
    { label: 'réponse vide', response: { data: null, error: null } },
    { label: 'erreur PostgREST', response: { data: null, error: { code: '42501' } } },
  ])('échec fermé sur $label : write_failed + capture Sentry nommée', async ({ response }) => {
    harness.rpcResponse = response;
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'write_failed' });
    expect(captureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'shop_link_rpc_failed' }),
      }),
    );
  });
});
