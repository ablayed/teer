// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C4 — `syncShopAction` relance la réconciliation des abonnements
// (E4), avant les commandes, sans que son échec fasse échouer la synchronisation.
//
// Couche : unitaire. L'action est appelée telle qu'elle est exportée (chaîne `requireRole`
// réelle) ; la session et les deux opérations de lib/shopify/shop-sync sont remplacées.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SHOP_ID = '11111111-1111-4111-8111-111111111111';

const harness = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  member: { id: 'member-1', merchant_account_id: 'account-1', role: 'manager' } as {
    id: string;
    merchant_account_id: string;
    role: string;
  } | null,
  webhooks: { ok: true } as { ok: true } | { ok: false; reason: string },
  webhooksThrow: false,
  orders: { ok: true, shopId: 'shop-1', syncedCount: 3 } as Record<string, unknown>,
  calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/security/authz-audit', () => ({ reportAuthorizationFailure: vi.fn() }));
vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'x' },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/protected-client', () => ({ createProtectedSupabaseClient: () => ({}) }));
vi.mock('@/lib/shopify/app-release-write', () => ({ performShopifyAppRelease: vi.fn() }));
vi.mock('@/lib/shopify/shop-sync', () => ({
  reconcileShopWebhookSubscriptions: async (input: Record<string, unknown>) => {
    harness.calls.push({ name: 'webhooks', input });
    if (harness.webhooksThrow) throw new Error('boom');
    return harness.webhooks;
  },
  syncShopOrders: async (input: Record<string, unknown>) => {
    harness.calls.push({ name: 'orders', input });
    return harness.orders;
  },
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

async function callAction() {
  const { syncShopAction } = await import('@/lib/actions/shops');
  return syncShopAction({ shopId: SHOP_ID });
}

beforeEach(() => {
  harness.user = { id: 'user-1' };
  harness.member = { id: 'member-1', merchant_account_id: 'account-1', role: 'manager' };
  harness.webhooks = { ok: true };
  harness.webhooksThrow = false;
  harness.orders = { ok: true, shopId: 'shop-1', syncedCount: 3 };
  harness.calls = [];
});

describe('syncShopAction — relance des abonnements webhook', () => {
  it('réconcilie les abonnements AVANT les commandes, pour le locataire de la session', async () => {
    const result = await callAction();

    expect(harness.calls.map((call) => call.name)).toEqual(['webhooks', 'orders']);
    expect(harness.calls[0].input).toEqual({ merchantAccountId: 'account-1', shopId: SHOP_ID });
    expect(result?.data).toEqual({ ok: true, syncedCount: 3, webhookSubscriptions: 'ok' });
  });

  it('abonnements en échec : la synchronisation aboutit, l’échec est rendu à l’appelant', async () => {
    harness.webhooks = { ok: false, reason: 'subscription_create_failed' };

    const result = await callAction();

    expect(harness.calls.map((call) => call.name)).toEqual(['webhooks', 'orders']);
    expect(result?.data).toEqual({ ok: true, syncedCount: 3, webhookSubscriptions: 'pending' });
  });

  it('exception de la réconciliation : absorbée, les commandes sont quand même synchronisées', async () => {
    harness.webhooksThrow = true;

    const result = await callAction();

    expect(harness.calls.map((call) => call.name)).toEqual(['webhooks', 'orders']);
    expect(result?.data).toMatchObject({ ok: true, webhookSubscriptions: 'pending' });
  });

  it('rôle agent : refus, aucune des deux opérations n’est appelée', async () => {
    harness.member = { id: 'member-1', merchant_account_id: 'account-1', role: 'agent' };

    const result = await callAction();

    expect(result?.serverError).toBeDefined();
    expect(harness.calls).toEqual([]);
  });
});
