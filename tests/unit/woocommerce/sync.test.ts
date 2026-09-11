import { WooCommerceClientError } from '@/lib/woocommerce/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = new Date('2026-09-11T12:34:56.789Z');

const harness = vi.hoisted(() => ({
  connection: {
    context: {
      storeConnectionId: 'connection-1',
      merchantAccountId: 'merchant-1',
      shopId: 'shop-1',
      platform: 'woocommerce',
      platformAppId: null,
    },
    externalIdentifier: 'https://store.example.test/',
    status: 'active',
  },
  credential: {
    scheme: 'basic_consumer',
    consumer_key_encrypted: 'enc-key',
    consumer_secret_encrypted: 'enc-secret',
  },
  syncState: null as Record<string, unknown> | null,
  nextStateId: 0,
  pages: new Map<number, { data: unknown[]; headers: Record<string, string> }>(),
  pageCalls: [] as string[],
  persistCalls: [] as Array<Record<string, unknown>>,
  persistedById: new Map<string, string>(),
  failPage: null as number | null,
  readJsonWithHeaders: vi.fn(
    async (_path: string): Promise<{ data: unknown[]; headers: Record<string, string> }> => ({
      data: [],
      headers: {},
    }),
  ),
  persist: vi.fn(async (..._args: unknown[]) => ({ ok: true, orderId: 'order-1' })),
  resolve: vi.fn(async (..._args: unknown[]) => ({ ok: true, connection: harness.connection })),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    CONNECTOR_CREDENTIALS_ENCRYPTION_KEY: '01'.repeat(32),
  },
}));

vi.mock('@/lib/connector-credentials/crypto', () => ({
  decryptConnectorCredential: vi.fn((_value: string) => 'secret'),
}));

vi.mock('@/lib/woocommerce/client', () => ({
  WooCommerceClient: class WooCommerceClient {},
  WooCommerceClientError: class WooCommerceClientError extends Error {
    code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

vi.mock('@/lib/ingestion/resolve-connection', () => ({
  resolveWooCommerceConnectionById: (...args: unknown[]) => harness.resolve(...args),
}));

vi.mock('@/lib/woocommerce/ingestion', () => ({
  persistWooCommerceCanonicalOrder: (...args: unknown[]) => harness.persist(...args),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(),
}));

function order(id: number, created: string, modified = created): Record<string, unknown> {
  return {
    id,
    number: String(id),
    status: 'processing',
    date_created_gmt: created,
    date_modified_gmt: modified,
    total: '1250.00',
    currency: 'XOF',
    customer_id: 0,
    billing: {},
    shipping: {},
    line_items: [{ name: 'Produit', sku: 'SKU', quantity: 1, total: '1250.00' }],
  };
}

function headers(total: number, totalPages: number): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-wp-total': String(total),
    'x-wp-totalpages': String(totalPages),
  };
}

function setPages(pages: Array<{ data: unknown[]; headers: Record<string, string> }>): void {
  harness.pages.clear();
  for (const [index, page] of pages.entries()) harness.pages.set(index + 1, page);
  harness.readJsonWithHeaders.mockImplementation(async (path: string) => {
    harness.pageCalls.push(path);
    const page = Number(new URL(path, 'https://client.test').searchParams.get('page'));
    if (harness.failPage === page) throw new Error('interruption');
    const result = harness.pages.get(page);
    if (!result) throw new Error(`page ${page} absent`);
    return result;
  });
}

function fakeClient() {
  return { readJsonWithHeaders: harness.readJsonWithHeaders };
}

class FakeConditionalUpdateBuilder {
  id: string | null = null;
  statuses: string[] | null = null;

  constructor(private readonly payload: Record<string, unknown>) {}

  eq(_column: string, value: string) {
    this.id = value;
    return this;
  }

  in(_column: string, values: string[]) {
    this.statuses = values;
    return this;
  }

  select() {
    return this;
  }

  async maybeSingle() {
    if (
      !harness.syncState ||
      (this.id && harness.syncState.id !== this.id) ||
      (this.statuses && !this.statuses.includes(String(harness.syncState.status)))
    ) {
      return { data: null, error: null };
    }
    harness.syncState = { ...harness.syncState, ...this.payload };
    return { data: harness.syncState, error: null };
  }
}

function fakeAdmin() {
  return {
    from(table: string) {
      if (table === 'store_connection_credential') {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                maybeSingle: async () => ({ data: harness.credential, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'store_connection_sync_state') {
        return {
          select: () => ({
            eq: (_column: string, _value: string) => ({
              maybeSingle: async () => ({ data: harness.syncState, error: null }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                if (harness.syncState) return { data: null, error: { code: '23505' } };
                harness.nextStateId += 1;
                harness.syncState = { ...payload, id: `state-${harness.nextStateId}` };
                return { data: harness.syncState, error: null };
              },
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            if ('attempt' in payload) return new FakeConditionalUpdateBuilder(payload);
            return {
              eq: async (_column: string, value: string) => {
                if (harness.syncState?.id === value) {
                  harness.syncState = { ...harness.syncState, ...payload };
                }
                return { error: null };
              },
            };
          },
        };
      }
      if (table === 'store_connection') {
        return {
          update: (payload: Record<string, unknown>) => ({
            eq: () => ({
              eq: async () => {
                Object.assign(harness.connection, payload);
                return { error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe('synchronisation initiale WooCommerce', () => {
  beforeEach(() => {
    harness.syncState = null;
    harness.nextStateId = 0;
    harness.pages.clear();
    harness.pageCalls.length = 0;
    harness.persistCalls.length = 0;
    harness.persistedById.clear();
    harness.failPage = null;
    harness.connection.externalIdentifier = 'https://store.example.test/';
    harness.readJsonWithHeaders.mockReset();
    harness.persist.mockReset().mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as {
        order: { externalOrderId: string; data: { updatedAt: string | null } };
      };
      harness.persistCalls.push(input as unknown as Record<string, unknown>);
      const id = input.order.externalOrderId;
      const signal = input.order.data.updatedAt ?? '';
      const previous = harness.persistedById.get(id);
      if (!previous || signal > previous) harness.persistedById.set(id, signal);
      return { ok: true, orderId: `order-${id}` };
    });
    harness.resolve.mockClear();
  });

  it('crée une fenêtre fixe GMT et persiste les commandes dans le même moteur', async () => {
    setPages([
      {
        data: [order(1, '2026-09-01T10:00:00')],
        headers: headers(1, 1),
      },
    ]);
    const { synchronizeWooCommerceOrders } = await import('@/lib/woocommerce/sync');
    const result = await synchronizeWooCommerceOrders(
      harness.connection.context.storeConnectionId,
      {
        admin: fakeAdmin() as never,
        client: fakeClient() as never,
        now: () => NOW,
      },
    );

    expect(result).toEqual({ ok: true, status: 'completed' });
    expect(harness.syncState).toMatchObject({
      status: 'completed',
      window_start: '2026-06-13T12:34:56.000Z',
      window_end: '2026-09-11T12:34:56.000Z',
      last_page_observed: 1,
    });
    expect(harness.persistCalls).toHaveLength(1);
    expect(
      new URL(harness.pageCalls[0] ?? '', 'https://client.test').searchParams.get('page'),
    ).toBe('1');
  });

  it('reprend depuis page=1 sur la même fenêtre après interruption et garde la fraîcheur', async () => {
    setPages([
      { data: [order(1, '2026-07-01T10:00:00', '2026-07-01T10:00:00')], headers: headers(2, 2) },
      { data: [order(2, '2026-08-01T10:00:00')], headers: headers(2, 2) },
    ]);
    harness.failPage = 2;
    const { synchronizeWooCommerceOrders } = await import('@/lib/woocommerce/sync');
    const first = await synchronizeWooCommerceOrders(harness.connection.context.storeConnectionId, {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
      now: () => NOW,
    });
    expect(first).toEqual({ ok: false, errorCode: 'sync_remote_failed' });
    expect(harness.syncState).toMatchObject({ status: 'failed', last_page_observed: 1 });

    harness.failPage = null;
    setPages([
      { data: [order(1, '2026-07-01T10:00:00', '2026-09-11T12:00:00')], headers: headers(2, 2) },
      { data: [order(2, '2026-08-01T10:00:00')], headers: headers(2, 2) },
    ]);
    const second = await synchronizeWooCommerceOrders(
      harness.connection.context.storeConnectionId,
      {
        admin: fakeAdmin() as never,
        client: fakeClient() as never,
        now: () => NOW,
      },
    );

    expect(second).toEqual({ ok: true, status: 'completed' });
    expect(
      harness.pageCalls.map((path) =>
        new URL(path, 'https://client.test').searchParams.get('page'),
      ),
    ).toEqual(['1', '2', '1', '2']);
    expect(harness.syncState?.window_end).toBe('2026-09-11T12:34:56.000Z');
    expect(harness.persistedById.size).toBe(2);
    expect(harness.persistedById.get('1')).toBe('2026-09-11T12:00:00.000Z');
  });

  it('exclut une commande créée après window_end tout en exigeant les compteurs complets', async () => {
    setPages([
      {
        data: [order(1, '2026-09-01T10:00:00'), order(2, '2026-09-11T12:34:57')],
        headers: headers(2, 1),
      },
    ]);
    const { synchronizeWooCommerceOrders } = await import('@/lib/woocommerce/sync');
    const result = await synchronizeWooCommerceOrders(
      harness.connection.context.storeConnectionId,
      {
        admin: fakeAdmin() as never,
        client: fakeClient() as never,
        now: () => NOW,
      },
    );
    expect(result).toEqual({ ok: true, status: 'completed' });
    expect(harness.persistedById.has('1')).toBe(true);
    expect(harness.persistedById.has('2')).toBe(false);
  });

  it('refuse une variation de total et une réponse non monotone', async () => {
    setPages([
      { data: [order(1, '2026-07-01T10:00:00')], headers: headers(2, 2) },
      { data: [order(2, '2026-08-01T10:00:00')], headers: headers(3, 3) },
    ]);
    const { synchronizeWooCommerceOrders } = await import('@/lib/woocommerce/sync');
    const totalChanged = await synchronizeWooCommerceOrders(
      harness.connection.context.storeConnectionId,
      { admin: fakeAdmin() as never, client: fakeClient() as never, now: () => NOW },
    );
    expect(totalChanged).toEqual({ ok: false, errorCode: 'pagination_total_changed' });

    harness.syncState = null;
    harness.persistCalls.length = 0;
    setPages([
      {
        data: [order(2, '2026-08-01T10:00:00'), order(1, '2026-07-01T10:00:00')],
        headers: headers(2, 1),
      },
    ]);
    const nonMonotone = await synchronizeWooCommerceOrders(
      harness.connection.context.storeConnectionId,
      { admin: fakeAdmin() as never, client: fakeClient() as never, now: () => NOW },
    );
    expect(nonMonotone).toEqual({ ok: false, errorCode: 'pagination_not_monotone' });
    expect(harness.persistCalls).toHaveLength(0);
  });

  it('ne lance pas deux scans concurrents pour une même connexion', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    setPages([{ data: [order(1, '2026-09-01T10:00:00')], headers: headers(1, 1) }]);
    harness.readJsonWithHeaders.mockImplementation(async (path: string) => {
      harness.pageCalls.push(path);
      await blocked;
      return { data: [order(1, '2026-09-01T10:00:00')], headers: headers(1, 1) };
    });
    const { synchronizeWooCommerceOrders } = await import('@/lib/woocommerce/sync');
    const first = synchronizeWooCommerceOrders(harness.connection.context.storeConnectionId, {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
      now: () => NOW,
    });
    const second = await synchronizeWooCommerceOrders(
      harness.connection.context.storeConnectionId,
      {
        admin: fakeAdmin() as never,
        client: fakeClient() as never,
        now: () => NOW,
      },
    );
    expect(second).toEqual({ ok: false, errorCode: 'sync_already_running' });
    release();
    await expect(first).resolves.toEqual({ ok: true, status: 'completed' });
    expect(harness.pageCalls).toHaveLength(1);
  });

  it.each([
    ['panne 5xx', 'upstream_unavailable'],
    ['timeout', 'timeout'],
  ])('%s : conserve le statut de connexion', async (_label, code) => {
    harness.readJsonWithHeaders.mockRejectedValue(
      new WooCommerceClientError(code as 'upstream_unavailable' | 'timeout'),
    );
    const { synchronizeWooCommerceOrders } = await import('@/lib/woocommerce/sync');

    const result = await synchronizeWooCommerceOrders(
      harness.connection.context.storeConnectionId,
      { admin: fakeAdmin() as never, client: fakeClient() as never, now: () => NOW },
    );

    expect(result).toEqual({ ok: false, errorCode: 'sync_remote_failed' });
    expect(harness.connection.status).toBe('active');
    expect(harness.syncState).toMatchObject({
      status: 'failed',
      last_error_code: 'sync_remote_failed',
    });
  });
});
