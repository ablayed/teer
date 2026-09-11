import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  from: vi.fn(),
  provision: vi.fn(),
  synchronize: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/actions/safe-action', () => ({
  requireRole: vi.fn(() => {
    const builder = {
      metadata: () => builder,
      inputSchema: () => builder,
      action: (handler: unknown) => handler,
    };
    return builder;
  }),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-sentinel',
  },
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({ from: harness.from })),
}));

vi.mock('@/lib/ingestion/resolve-shop-context', () => ({
  resolveShopContext: vi.fn(),
}));

vi.mock('@/lib/woocommerce/subscriptions', () => ({
  provisionWooCommerceSubscriptions: (...args: unknown[]) => harness.provision(...args),
}));

vi.mock('@/lib/woocommerce/sync', () => ({
  synchronizeWooCommerceOrders: (...args: unknown[]) => harness.synchronize(...args),
}));

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args),
}));

const merchantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const shopId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function resolved(value: unknown) {
  return Promise.resolve({ data: value, error: null });
}

function chain(result: Promise<unknown>) {
  const builder = {
    eq: () => builder,
    in: () => result,
    order: () => result,
    maybeSingle: () => result,
  };
  return builder;
}

function adminForList() {
  harness.from.mockImplementation((table: string) => {
    if (table === 'shop') {
      return {
        select: () =>
          chain(
            resolved([
              {
                id: shopId,
                display_name: 'Boutique test',
                shop_domain: 'https://store.example.test',
              },
            ]),
          ),
      };
    }
    if (table === 'store_connection') {
      return {
        select: () =>
          chain(
            resolved([
              {
                id: connectionId,
                shop_id: shopId,
                external_identifier: 'https://store.example.test',
                status: 'provisioning',
              },
            ]),
          ),
      };
    }
    if (table === 'store_connection_webhook_subscription') {
      return {
        select: () =>
          chain(
            resolved([
              { store_connection_id: connectionId, topic: 'order.created', status: 'active' },
              { store_connection_id: connectionId, topic: 'order.updated', status: 'active' },
            ]),
          ),
      };
    }
    if (table === 'store_connection_sync_state') {
      return {
        select: () =>
          chain(
            resolved([
              {
                store_connection_id: connectionId,
                status: 'failed',
                last_error_code: 'sync_total_changed',
                last_page_observed: 2,
                updated_at: '2026-09-11T10:00:00.000Z',
              },
            ]),
          ),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  });
}

function actionContext() {
  return {
    ctx: {
      member: { id: 'member-sentinel', merchantAccountId: merchantId, role: 'owner' },
    },
  };
}

describe('actions état et reprise WooCommerce', () => {
  beforeEach(() => {
    harness.from.mockReset();
    harness.provision.mockReset().mockResolvedValue({ ok: true });
    harness.synchronize.mockReset().mockResolvedValue({ ok: true });
    harness.revalidatePath.mockReset();
  });

  it('liste uniquement des métadonnées de connexion et ses deux abonnements requis', async () => {
    adminForList();
    const { listWooCommerceConnectionsAction } = await import('@/lib/actions/woocommerce');
    const result = await (
      listWooCommerceConnectionsAction as unknown as (input: unknown) => Promise<unknown>
    )({ ...actionContext(), parsedInput: {} });

    expect(result).toEqual({
      ok: true,
      shops: [
        {
          id: shopId,
          displayName: 'Boutique test',
          domain: 'https://store.example.test',
        },
      ],
      connections: [
        {
          id: connectionId,
          shopId,
          shopName: 'Boutique test',
          shopDomain: 'https://store.example.test',
          externalIdentifier: 'https://store.example.test',
          status: 'provisioning',
          subscriptions: { 'order.created': 'active', 'order.updated': 'active' },
          syncStatus: 'failed',
          syncLastErrorCode: 'sync_total_changed',
          syncLastPageObserved: 2,
          syncUpdatedAt: '2026-09-11T10:00:00.000Z',
        },
      ],
    });
  });

  it('refuse une reprise d’une connexion needs_reauth sans appeler le provisionnement', async () => {
    harness.from.mockImplementation((table: string) => {
      if (table !== 'store_connection') throw new Error(`unexpected table: ${table}`);
      return {
        select: () => chain(resolved({ id: connectionId, status: 'needs_reauth' })),
      };
    });
    const { completeWooCommerceConnectionAction } = await import('@/lib/actions/woocommerce');
    const result = await (
      completeWooCommerceConnectionAction as unknown as (input: unknown) => Promise<unknown>
    )({ ...actionContext(), parsedInput: { connectionId } });

    expect(result).toEqual({ ok: false, errorCode: 'credentials_invalid' });
    expect(harness.provision).not.toHaveBeenCalled();
    expect(harness.synchronize).not.toHaveBeenCalled();
  });

  it('provisionne avant de lancer la synchronisation, puis invalide les vues', async () => {
    harness.from.mockImplementation((table: string) => {
      if (table !== 'store_connection') throw new Error(`unexpected table: ${table}`);
      return {
        select: () => chain(resolved({ id: connectionId, status: 'provisioning' })),
      };
    });
    const { completeWooCommerceConnectionAction } = await import('@/lib/actions/woocommerce');
    const result = await (
      completeWooCommerceConnectionAction as unknown as (input: unknown) => Promise<unknown>
    )({ ...actionContext(), parsedInput: { connectionId } });

    expect(result).toEqual({ ok: true });
    expect(harness.provision).toHaveBeenCalledWith(connectionId);
    expect(harness.synchronize).toHaveBeenCalledWith(connectionId);
    expect(harness.provision.mock.invocationCallOrder[0]).toBeLessThan(
      harness.synchronize.mock.invocationCallOrder[0],
    );
    expect(harness.revalidatePath).toHaveBeenNthCalledWith(1, '/parametres');
    expect(harness.revalidatePath).toHaveBeenNthCalledWith(2, '/commandes');
  });
});
