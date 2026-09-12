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
  updateAttempts: [] as Array<Record<string, unknown>>,
  // Modélise un commit concurrent survenu juste avant notre `UPDATE`, et un `UPDATE` qui
  // n'apparie aucune ligne sans que la relecture puisse l'expliquer.
  beforeSyncUpdate: null as null | (() => void),
  forceUpdateMiss: false,
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

type SyncRow = Record<string, unknown>;

type UpdatePredicate = {
  id?: string;
  status?: string;
  statuses?: string[];
  attempt?: number;
  updatedBefore?: string;
};

/**
 * Modélise un VRAI prédicat d'`UPDATE` PostgREST et rend un NOMBRE DE LIGNES AFFECTÉES.
 *
 * L'ancien faux aiguillait sur la forme de la charge (`'attempt' in payload`) et sa branche non
 * conditionnelle rendait, depuis son unique `.eq()`, la promesse finale : il ne pouvait exprimer
 * ni un second `.eq()`, ni un `.lt()`, donc aucun fencing. Ici chaque `.eq()`/`.in()`/`.lt()`
 * ajoute une condition, et une condition non satisfaite rend zéro ligne — jamais une erreur.
 */
class FakeUpdateBuilder {
  private readonly predicate: UpdatePredicate = {};
  private applied = false;

  constructor(private readonly payload: SyncRow) {}

  eq(column: string, value: unknown): this {
    if (column === 'id') this.predicate.id = String(value);
    else if (column === 'status') this.predicate.status = String(value);
    else if (column === 'attempt') this.predicate.attempt = Number(value);
    else throw new Error(`colonne eq non modélisée : ${column}`);
    return this;
  }

  in(column: string, values: string[]): this {
    if (column !== 'status') throw new Error(`colonne in non modélisée : ${column}`);
    this.predicate.statuses = values;
    return this;
  }

  lt(column: string, value: string): this {
    if (column !== 'updated_at') throw new Error(`colonne lt non modélisée : ${column}`);
    this.predicate.updatedBefore = value;
    return this;
  }

  select(): this {
    return this;
  }

  /** Nombre de lignes affectées, exactement comme le rendrait l'instruction SQL. */
  private apply(): number {
    if (this.applied) throw new Error('prédicat appliqué deux fois');
    this.applied = true;
    const hook = harness.beforeSyncUpdate;
    if (hook) {
      harness.beforeSyncUpdate = null;
      hook();
    }
    harness.updateAttempts.push({ ...this.predicate });
    const row = harness.syncState;
    if (!row || harness.forceUpdateMiss) return 0;
    const { id, status, statuses, attempt, updatedBefore } = this.predicate;
    if (id !== undefined && String(row.id) !== id) return 0;
    if (status !== undefined && String(row.status) !== status) return 0;
    if (statuses && !statuses.includes(String(row.status))) return 0;
    if (attempt !== undefined && Number(row.attempt) !== attempt) return 0;
    if (updatedBefore !== undefined && !(String(row.updated_at) < updatedBefore)) return 0;
    harness.syncState = { ...row, ...this.payload };
    return 1;
  }

  /** Seul terminal du faux : toutes les écritures fencées ciblent une clé primaire. */
  async maybeSingle(): Promise<{ data: SyncRow | null; error: null }> {
    return { data: this.apply() > 0 ? harness.syncState : null, error: null };
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
          insert: (payload: SyncRow) => ({
            select: () => ({
              single: async () => {
                if (harness.syncState) return { data: null, error: { code: '23505' } };
                harness.nextStateId += 1;
                harness.syncState = { ...payload, id: `state-${harness.nextStateId}` };
                return { data: harness.syncState, error: null };
              },
            }),
          }),
          update: (payload: SyncRow) => new FakeUpdateBuilder(payload),
        };
      }
      if (table === 'store_connection') {
        return {
          update: (payload: SyncRow) => ({
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
    harness.updateAttempts.length = 0;
    harness.beforeSyncUpdate = null;
    harness.forceUpdateMiss = false;
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

  // ---------------------------------------------------------------------------
  // D2 — bail et fencing. `now` est injecté (SyncDependencies.now), le bail vaut 150 s.
  // ---------------------------------------------------------------------------

  const LEASE_MS = 150 * 1000;

  function seedState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const state = {
      id: 'state-seed',
      store_connection_id: 'connection-1',
      merchant_account_id: 'merchant-1',
      shop_id: 'shop-1',
      window_start: '2026-06-13T12:34:56.000Z',
      window_end: '2026-09-11T12:34:56.000Z',
      last_page_observed: 0,
      attempt: 3,
      status: 'running',
      last_error_code: null,
      updated_at: NOW.toISOString(),
      completed_at: null,
      ...overrides,
    };
    harness.syncState = state;
    return state;
  }

  function ago(ms: number): string {
    return new Date(NOW.getTime() - ms).toISOString();
  }

  async function run() {
    const { synchronizeWooCommerceOrders } = await import('@/lib/woocommerce/sync');
    return synchronizeWooCommerceOrders('connection-1', {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
      now: () => NOW,
    });
  }

  it('refuse un running dont le bail court encore, sans tenter aucune ecriture', async () => {
    seedState({ updated_at: ago(LEASE_MS - 1_000), attempt: 3 });
    setPages([{ data: [order(1, '2026-09-01T10:00:00')], headers: headers(1, 1) }]);

    await expect(run()).resolves.toEqual({ ok: false, errorCode: 'sync_already_running' });
    expect(harness.updateAttempts).toEqual([]);
    expect(harness.syncState).toMatchObject({ status: 'running', attempt: 3 });
    expect(harness.pageCalls).toEqual([]);
  });

  it('reprend un running dont le bail a expire, en portant la generation lue au predicat', async () => {
    seedState({
      updated_at: ago(LEASE_MS + 1_000),
      attempt: 3,
      last_error_code: 'sync_remote_failed',
    });
    setPages([{ data: [order(1, '2026-09-01T10:00:00')], headers: headers(1, 1) }]);

    await expect(run()).resolves.toEqual({ ok: true, status: 'completed' });
    expect(harness.updateAttempts[0]).toEqual({
      id: 'state-seed',
      status: 'running',
      attempt: 3,
      updatedBefore: ago(LEASE_MS),
    });
    expect(harness.syncState).toMatchObject({ status: 'completed', attempt: 4 });
  });

  it('le nouveau worker cloture avec la generation reprise, jamais avec la precedente', async () => {
    seedState({ updated_at: ago(LEASE_MS + 1_000), attempt: 3 });
    setPages([{ data: [order(1, '2026-09-01T10:00:00')], headers: headers(1, 1) }]);

    await expect(run()).resolves.toEqual({ ok: true, status: 'completed' });
    expect(harness.updateAttempts.at(-1)).toEqual({
      id: 'state-seed',
      status: 'running',
      attempt: 4,
    });
    expect(harness.syncState).toMatchObject({
      status: 'completed',
      attempt: 4,
      last_page_observed: 1,
      last_error_code: null,
    });
  });

  it('refuse la cloture d un ancien worker apres reprise, sans modifier la ligne', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.readJsonWithHeaders.mockImplementation(async (path: string) => {
      harness.pageCalls.push(path);
      await blocked;
      // Aucune page : la boucle ne tourne pas et le worker va droit a sa cloture.
      return { data: [], headers: headers(0, 0) };
    });

    const running = run();
    await vi.waitFor(() => expect(harness.syncState).not.toBeNull());
    const claimed = harness.syncState as Record<string, unknown>;
    harness.syncState = {
      ...claimed,
      attempt: Number(claimed.attempt) + 1,
      updated_at: NOW.toISOString(),
    };
    const snapshot = { ...harness.syncState };
    release();

    await expect(running).resolves.toEqual({ ok: false, errorCode: 'sync_lease_lost' });
    expect(harness.syncState).toEqual(snapshot);
  });

  it('refuse un failed de l ancien worker apres le succes du nouveau', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.readJsonWithHeaders.mockImplementation(async (path: string) => {
      harness.pageCalls.push(path);
      await blocked;
      // En-tetes absents : l ancien worker voudrait consigner pagination_headers_invalid.
      return { data: [], headers: { 'content-type': 'application/json' } };
    });

    const running = run();
    await vi.waitFor(() => expect(harness.syncState).not.toBeNull());
    const claimed = harness.syncState as Record<string, unknown>;
    harness.syncState = {
      ...claimed,
      attempt: Number(claimed.attempt) + 1,
      status: 'completed',
      completed_at: NOW.toISOString(),
    };
    const snapshot = { ...harness.syncState };
    release();

    await expect(running).resolves.toEqual({ ok: false, errorCode: 'sync_lease_lost' });
    expect(harness.syncState).toEqual(snapshot);
    expect(harness.syncState).toMatchObject({ status: 'completed', last_error_code: null });
  });

  it('s arrete au renouvellement intermediaire, avant la commande suivante', async () => {
    const created = [
      '2026-09-01T10:00:00',
      '2026-09-01T11:00:00',
      '2026-09-02T10:00:00',
      '2026-09-02T11:00:00',
      '2026-09-03T10:00:00',
      '2026-09-03T11:00:00',
      '2026-09-04T10:00:00',
      '2026-09-04T11:00:00',
      '2026-09-05T10:00:00',
      '2026-09-05T11:00:00',
      '2026-09-06T10:00:00',
      '2026-09-06T11:00:00',
    ];
    seedState({ updated_at: ago(LEASE_MS + 1_000), attempt: 3 });
    setPages([
      { data: created.map((date, index) => order(index + 1, date)), headers: headers(12, 1) },
    ]);
    // Un concurrent reprend le bail des la premiere commande ; le renouvellement survient a la
    // dixieme et doit arreter le worker avant la onzieme.
    harness.persist.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { order: { externalOrderId: string } };
      harness.persistCalls.push(input as unknown as Record<string, unknown>);
      if (harness.persistCalls.length === 1) {
        const claimed = harness.syncState as Record<string, unknown>;
        harness.syncState = { ...claimed, attempt: Number(claimed.attempt) + 1 };
      }
      return { ok: true, orderId: `order-${input.order.externalOrderId}` };
    });

    await expect(run()).resolves.toEqual({ ok: false, errorCode: 'sync_lease_lost' });
    expect(harness.persistCalls).toHaveLength(10);
  });

  it.each([
    [
      'relecture terminee',
      () => {
        const row = harness.syncState as Record<string, unknown>;
        harness.syncState = { ...row, status: 'completed' };
      },
      { ok: true, status: 'already_completed' },
    ],
    [
      'relecture en cours et bail renouvele',
      () => {
        const row = harness.syncState as Record<string, unknown>;
        harness.syncState = { ...row, updated_at: NOW.toISOString() };
      },
      { ok: false, errorCode: 'sync_already_running' },
    ],
    [
      'generation differente',
      () => {
        const row = harness.syncState as Record<string, unknown>;
        harness.syncState = { ...row, status: 'failed', attempt: Number(row.attempt) + 1 };
      },
      { ok: false, errorCode: 'sync_lease_lost' },
    ],
  ])('zero ligne, %s', async (_label, concurrent, expected) => {
    seedState({ updated_at: ago(LEASE_MS + 1_000), attempt: 3 });
    setPages([{ data: [order(1, '2026-09-01T10:00:00')], headers: headers(1, 1) }]);
    harness.beforeSyncUpdate = concurrent;

    await expect(run()).resolves.toEqual(expected);
    expect(harness.pageCalls).toEqual([]);
  });

  it('zero ligne, conflit inexplique : echec ferme sur un code nomme', async () => {
    seedState({ updated_at: ago(LEASE_MS + 1_000), attempt: 3 });
    setPages([{ data: [order(1, '2026-09-01T10:00:00')], headers: headers(1, 1) }]);
    // La relecture montre un running encore ancien et la meme generation : rien n explique le
    // zero ligne. Ce cas n est atteignable qu en forcant l absence d appariement.
    harness.forceUpdateMiss = true;

    await expect(run()).resolves.toEqual({ ok: false, errorCode: 'sync_claim_conflict' });
    expect(harness.syncState).toMatchObject({ status: 'running', attempt: 3 });
    expect(harness.pageCalls).toEqual([]);
  });
});
