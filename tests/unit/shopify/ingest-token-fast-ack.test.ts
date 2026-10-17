import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<unknown>>,
  receipt: { eventId: 'event-1', duplicate: false, error: null } as {
    eventId: string | null;
    duplicate: boolean;
    error: unknown;
    payload?: unknown;
    status?: string;
    nextAttemptAt?: string | null;
  },
  records: [] as Array<Record<string, unknown>>,
  processed: [] as Array<Record<string, unknown>>,
  claims: [] as Array<Record<string, unknown>>,
  sweeps: 0,
  sweepAfterProcessed: [] as number[],
  claimed: [
    {
      event_id: 'event-1',
      topic: 'orders/updated',
      shop_id: 'shop-1',
      shop_domain: 'shop-a.myshopify.com',
      payload: { id: 42 },
    },
  ] as Array<Record<string, unknown>>,
}));

vi.mock('next/server', () => ({
  after: vi.fn((callback: () => Promise<unknown>) => {
    harness.afterCallbacks.push(callback);
  }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/shopify/webhook-opportunistic-sweep', () => ({
  sweepPendingShopifyWebhooks: vi.fn(async () => {
    harness.sweeps += 1;
    harness.sweepAfterProcessed.push(harness.processed.length);
  }),
}));
vi.mock('@/lib/ingestion/resolve-connection', () => ({
  resolveConnectionByToken: vi.fn(async () => ({
    ok: true,
    connection: {
      externalIdentifier: 'shop-a.myshopify.com',
      shopId: 'shop-1',
      merchantAccountId: 'merchant-1',
      status: 'active',
    },
  })),
  tokenConnectionMatchesApp: vi.fn(() => true),
  finalizeResolvedConnection: vi.fn(() => ({ ok: true })),
}));
vi.mock('@/lib/shopify/adapter', () => ({
  identifyValidatingApps: vi.fn(
    (_body: string, _hmac: string, apps: Array<{ clientId: string }>) => [apps[0]],
  ),
}));
vi.mock('@/lib/shopify/apps', () => ({
  getRegisteredShopifyApps: vi.fn(() => [{ clientId: 'app-1', clientSecret: 'test-secret' }]),
}));
vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({
    rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      harness.claims.push(args);
      return { data: harness.claimed, error: null };
    }),
  })),
}));
vi.mock('@/lib/shopify/webhook-core', () => ({
  recordWebhookReceipt: vi.fn(async (args: Record<string, unknown>) => {
    harness.records.push(args);
    return harness.receipt;
  }),
  resolveShopForTopic: vi.fn(async () => ({ id: 'shop-1' })),
  runResolvedWebhookEvent: vi.fn(async (args: Record<string, unknown>) => {
    harness.processed.push(args);
  }),
  toJson: vi.fn((value: unknown) => value),
}));

function request() {
  return new Request('http://localhost/api/shopify/ingest/token', {
    method: 'POST',
    body: JSON.stringify({ id: 42 }),
    headers: {
      'x-shopify-hmac-sha256': 'valid-test-hmac',
      'x-shopify-topic': 'orders/updated',
      'x-shopify-webhook-id': 'webhook-1',
      'x-shopify-shop-domain': 'shop-a.myshopify.com',
      'x-shopify-triggered-at': '2026-10-17T10:00:00.000Z',
    },
  });
}

describe('POST /api/shopify/ingest/[token] — accusé après persistance', () => {
  beforeEach(() => {
    harness.afterCallbacks = [];
    harness.records = [];
    harness.processed = [];
    harness.claims = [];
    harness.sweeps = 0;
    harness.sweepAfterProcessed = [];
    harness.claimed = [
      {
        event_id: 'event-1',
        topic: 'orders/updated',
        shop_id: 'shop-1',
        shop_domain: 'shop-a.myshopify.com',
        payload: { id: 42 },
      },
    ];
    harness.receipt = { eventId: 'event-1', duplicate: false, error: null };
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-test-key';
  });

  it('persiste puis renvoie 200 sans attendre le traitement métier', async () => {
    const { POST } = await import('@/app/api/shopify/ingest/[token]/route');
    const response = await POST(request(), { params: Promise.resolve({ token: 'opaque-token' }) });

    expect(harness.records).toHaveLength(1);
    expect(response.status).toBe(200);
    expect(harness.afterCallbacks).toHaveLength(1);
    expect(harness.processed).toHaveLength(0);

    await harness.afterCallbacks[0]();
    expect(harness.processed).toHaveLength(1);
    expect(harness.processed[0]).toMatchObject({ eventId: 'event-1', topic: 'orders/updated' });
  });

  it('balaye les événements en attente après le traitement de la livraison, jamais avant l’accusé', async () => {
    const { POST } = await import('@/app/api/shopify/ingest/[token]/route');
    await POST(request(), { params: Promise.resolve({ token: 'opaque-token' }) });
    expect(harness.sweeps).toBe(0);

    await harness.afterCallbacks[0]();
    expect(harness.sweeps).toBe(1);
    expect(harness.sweepAfterProcessed).toEqual([1]);
  });

  it('réclame atomiquement un doublon dû avant son retraitement différé', async () => {
    harness.receipt = {
      eventId: 'event-1',
      duplicate: true,
      error: null,
      status: 'retryable',
      nextAttemptAt: '2000-01-01T00:00:00.000Z',
    };
    const { POST } = await import('@/app/api/shopify/ingest/[token]/route');
    const response = await POST(request(), { params: Promise.resolve({ token: 'opaque-token' }) });

    expect(response.status).toBe(200);
    expect(harness.afterCallbacks).toHaveLength(1);
    expect(harness.processed).toHaveLength(0);
    await harness.afterCallbacks[0]();
    expect(harness.claims).toHaveLength(1);
    expect(harness.claims[0]).toMatchObject({ p_event_id: 'event-1', p_limit: 1 });
    expect(harness.processed).toHaveLength(1);
  });

  it('ne retraite pas un doublon dû si une autre exécution l’a déjà réclamé', async () => {
    harness.receipt = {
      eventId: 'event-1',
      duplicate: true,
      error: null,
      status: 'retryable',
      nextAttemptAt: '2000-01-01T00:00:00.000Z',
    };
    harness.claimed = [];
    const { POST } = await import('@/app/api/shopify/ingest/[token]/route');
    const response = await POST(request(), { params: Promise.resolve({ token: 'opaque-token' }) });

    expect(response.status).toBe(200);
    await harness.afterCallbacks[0]();
    expect(harness.processed).toHaveLength(0);
  });

  it('ne renvoie pas 200 si la persistance durable échoue', async () => {
    harness.receipt = { eventId: null, duplicate: false, error: new Error('storage failed') };
    const { POST } = await import('@/app/api/shopify/ingest/[token]/route');
    const response = await POST(request(), { params: Promise.resolve({ token: 'opaque-token' }) });

    expect(response.status).toBe(503);
    expect(harness.afterCallbacks).toHaveLength(0);
  });
});
