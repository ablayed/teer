// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C4 — points d'appel de la réconciliation des abonnements : le
// MODE déclaré par chaque appelant, et le fait qu'un échec ne se transforme jamais en échec du
// geste qui le porte.
//
// Couche : unitaire. La réconciliation est remplacée par un espion ; elle est prouvée contre
// PostgreSQL dans tests/rls/shopify-webhooks-1b-reconcile.rls.test.ts. L'action serveur est
// appelée telle qu'elle est exportée (chaîne `requireRole` réelle).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  member: { id: 'member-1', merchant_account_id: 'account-1', role: 'owner' } as {
    id: string;
    merchant_account_id: string;
    role: string;
  } | null,
  shop: {
    id: 'shop-1',
    shop_domain: 'wps1b-callpoints.myshopify.com',
    shopify_client_id: 'synthetic-test-client-id',
  } as Record<string, unknown> | null,
  shopFilters: [] as Array<[string, unknown]>,
  reconcileResult: { ok: true } as { ok: true } | { ok: false; reason: string },
  reconcileThrows: false,
  reconcileCalls: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  baseUrl: 'https://synthetic-test-webhooks.example.test' as string | null,
  sentry: [] as Array<{ message: string; tags?: Record<string, string> }>,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: (message: string, context?: { tags?: Record<string, string> }) =>
    harness.sentry.push({ message, tags: context?.tags }),
}));
vi.mock('@/lib/security/authz-audit', () => ({ reportAuthorizationFailure: vi.fn() }));
vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'x' },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppForShop: () => ({
    clientId: 'synthetic-test-client-id',
    clientSecret: 'synthetic-test-client-secret',
  }),
}));
vi.mock('@/lib/shopify/webhook-base-url', () => ({
  readWebhookPublicBaseUrl: () => harness.baseUrl,
}));
vi.mock('@/lib/shopify/webhook-subscription-reconcile', () => ({
  reconcileShopifyWebhookSubscriptions: async (_admin: unknown, input: Record<string, unknown>) => {
    harness.order.push('webhooks');
    harness.reconcileCalls.push(input);
    if (harness.reconcileThrows) throw new Error('boom');
    return harness.reconcileResult;
  },
}));
vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          harness.shopFilters.push([column, value]);
          return chain;
        },
        maybeSingle: async () => ({ data: harness.shop, error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: harness.user } }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: harness.member, error: null }),
      };
      return chain;
    },
  }),
}));

beforeEach(() => {
  harness.user = { id: 'user-1' };
  harness.member = { id: 'member-1', merchant_account_id: 'account-1', role: 'owner' };
  harness.shop = {
    id: 'shop-1',
    shop_domain: 'wps1b-callpoints.myshopify.com',
    shopify_client_id: 'synthetic-test-client-id',
  };
  harness.shopFilters = [];
  harness.reconcileResult = { ok: true };
  harness.reconcileThrows = false;
  harness.reconcileCalls = [];
  harness.order = [];
  harness.baseUrl = 'https://synthetic-test-webhooks.example.test';
  harness.sentry = [];
});

describe('finalisation — reconcileWebhooksAfterConnect', () => {
  const input = {
    shopId: 'shop-1',
    app: { clientId: 'synthetic-test-client-id', clientSecret: 'synthetic-test-client-secret' },
  };

  it('déclare le mode installation et transmet l’origine publique lue à l’appel', async () => {
    const { reconcileWebhooksAfterConnect } = await import('@/lib/shopify/post-connect-effects');

    expect(await reconcileWebhooksAfterConnect({} as never, input)).toBe(true);

    expect(harness.reconcileCalls).toEqual([
      { ...input, mode: 'installation', webhookBaseUrl: harness.baseUrl },
    ]);
    expect(harness.sentry).toEqual([]);
  });

  it('un échec est observé par une sentinelle expurgée et rend false, sans lever', async () => {
    const { reconcileWebhooksAfterConnect } = await import('@/lib/shopify/post-connect-effects');
    harness.reconcileResult = { ok: false, reason: 'base_url_unavailable' };

    expect(await reconcileWebhooksAfterConnect({} as never, input)).toBe(false);

    expect(harness.sentry).toEqual([
      {
        message: 'shopify_post_connect_effect_failed',
        tags: {
          module: 'shopify.post-connect',
          effect: 'webhook_subscriptions',
          reason: 'base_url_unavailable',
        },
      },
    ]);
  });

  it('une exception est absorbée : false, jamais une erreur propagée', async () => {
    const { reconcileWebhooksAfterConnect } = await import('@/lib/shopify/post-connect-effects');
    harness.reconcileThrows = true;

    expect(await reconcileWebhooksAfterConnect({} as never, input)).toBe(false);
    expect(harness.sentry[0]?.tags?.reason).toBe('exception');
  });
});

describe('relance manuelle — reconcileShopWebhookSubscriptions', () => {
  it('déclare le mode réparation, pour la boutique active du locataire de la session', async () => {
    const { reconcileShopWebhookSubscriptions } = await import('@/lib/shopify/shop-sync');

    const result = await reconcileShopWebhookSubscriptions({
      merchantAccountId: 'account-1',
      shopId: 'shop-1',
    });

    expect(result).toEqual({ ok: true });
    expect(harness.reconcileCalls).toEqual([
      {
        shopId: 'shop-1',
        app: {
          clientId: 'synthetic-test-client-id',
          clientSecret: 'synthetic-test-client-secret',
        },
        mode: 'repair',
        webhookBaseUrl: harness.baseUrl,
      },
    ]);
    expect(harness.shopFilters).toEqual(
      expect.arrayContaining([
        ['merchant_account_id', 'account-1'],
        ['status', 'active'],
        ['id', 'shop-1'],
      ]),
    );
  });

  it('boutique introuvable pour ce locataire : aucune réconciliation', async () => {
    const { reconcileShopWebhookSubscriptions } = await import('@/lib/shopify/shop-sync');
    harness.shop = null;

    expect(
      await reconcileShopWebhookSubscriptions({ merchantAccountId: 'account-1', shopId: 'x' }),
    ).toEqual({ ok: false, reason: 'no_shop' });
    expect(harness.reconcileCalls).toEqual([]);
  });
});
