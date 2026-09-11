import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  candidate: {
    id: 'sub-1',
    store_connection_id: 'connection-1',
    topic: 'order.created',
    secret_encrypted: 'encrypted-secret',
    status: 'active',
    delivery_token_hash: 'hash',
  },
  connectionResult: {
    ok: true,
    connection: {
      externalIdentifier: 'https://store.example.test/',
      context: {
        storeConnectionId: 'connection-1',
        merchantAccountId: 'merchant-1',
        shopId: 'shop-1',
        platform: 'woocommerce',
        platformAppId: null,
      },
    },
  },
  candidatePresent: true,
  persist: vi.fn(
    async (..._args: unknown[]) =>
      ({ ok: true, orderId: 'order-1' }) as {
        ok: boolean;
        orderId?: string;
        errorCode?: string;
      },
  ),
  writeEvent: vi.fn(async (..._args: unknown[]) => ({ ok: true, duplicate: false })),
  decrypt: vi.fn((_value: string) => 'hmac-secret'),
  select: vi.fn((..._args: unknown[]) => undefined),
  resolve: vi.fn(async (..._args: unknown[]) => harness.connectionResult),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    CONNECTOR_CREDENTIALS_ENCRYPTION_KEY: '01'.repeat(32),
    NEXT_PUBLIC_APP_URL: 'https://app.example.test',
  },
}));

vi.mock('@/lib/connector-credentials/crypto', () => ({
  decryptConnectorCredential: (value: string) => harness.decrypt(value),
}));

vi.mock('@/lib/woocommerce/ingestion', () => ({
  persistWooCommerceCanonicalOrder: (...args: unknown[]) => harness.persist(...args),
}));

vi.mock('@/lib/ingestion/dual-write', () => ({
  writeIngestionEvent: (...args: unknown[]) => harness.writeEvent(...args),
}));

vi.mock('@/lib/ingestion/resolve-connection', () => ({
  resolveWooCommerceConnectionById: (...args: unknown[]) => harness.resolve(...args),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({
    from: (table: string) => {
      if (table !== 'store_connection_webhook_subscription') throw new Error('unexpected table');
      return {
        select: (columns: string) => {
          harness.select(columns);
          return {
            eq: (_column: string, _value: string) => ({
              maybeSingle: async () => ({
                data: harness.candidatePresent ? harness.candidate : null,
                error: null,
              }),
            }),
          };
        },
      };
    },
  })),
}));

const payload = {
  id: 42,
  number: '42',
  status: 'processing',
  date_created_gmt: '2026-09-01T10:00:00',
  date_modified_gmt: '2026-09-01T10:05:00',
  total: '1250.00',
  currency: 'XOF',
  customer_id: 7,
  billing: { first_name: 'Awa', last_name: 'Ndiaye', phone: '770000000' },
  shipping: { address_1: 'Rue 1', city: 'Dakar' },
  line_items: [{ name: 'Produit', sku: 'SKU-1', quantity: 1, total: '1250.00' }],
};

function requestFor(body: string, overrides: Record<string, string> = {}) {
  const signature = createHmac('sha256', 'hmac-secret').update(Buffer.from(body)).digest('base64');
  return new Request('https://app.example.test/api/woocommerce/webhooks/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wc-webhook-signature': signature,
      'x-wc-webhook-source': 'https://STORE.EXAMPLE.TEST/',
      'x-wc-webhook-topic': 'order.created',
      'x-wc-webhook-delivery-id': 'delivery-1',
      ...overrides,
    },
    body,
  });
}

const context = { params: Promise.resolve({ token: 'A'.repeat(43) }) };

describe('réception webhook WooCommerce', () => {
  beforeEach(() => {
    harness.candidatePresent = true;
    harness.candidate.status = 'active';
    harness.candidate.delivery_token_hash = createHash('sha256')
      .update('A'.repeat(43), 'utf8')
      .digest('hex');
    harness.connectionResult = {
      ok: true,
      connection: {
        externalIdentifier: 'https://store.example.test/',
        context: {
          storeConnectionId: 'connection-1',
          merchantAccountId: 'merchant-1',
          shopId: 'shop-1',
          platform: 'woocommerce',
          platformAppId: null,
        },
      },
    };
    harness.persist.mockReset().mockResolvedValue({ ok: true, orderId: 'order-1' });
    harness.writeEvent.mockReset().mockResolvedValue({ ok: true, duplicate: false });
    harness.decrypt.mockClear();
    harness.select.mockClear();
    harness.resolve.mockClear();
  });

  it('vérifie le corps brut, normalise la source avec son slash et appelle la RPC', async () => {
    const { POST } = await import('@/app/api/woocommerce/webhooks/[token]/route');
    const body = JSON.stringify(payload);
    const request = requestFor(body);
    const response = await POST(request, context);

    expect(response.status).toBe(200);
    expect(harness.persist).toHaveBeenCalledOnce();
    expect(harness.persist.mock.calls[0]?.[0]).toMatchObject({
      topic: 'order.created',
      deliveryId: 'delivery-1',
      context: harness.connectionResult.connection.context,
    });
    expect(harness.select).toHaveBeenCalledWith(
      'id, store_connection_id, topic, secret_encrypted, status, delivery_token_hash',
    );
  });

  it.each([
    ['signature invalide', { 'x-wc-webhook-signature': 'invalid' }],
    [
      'corps modifié',
      {
        'x-wc-webhook-signature': createHmac('sha256', 'hmac-secret')
          .update('other')
          .digest('base64'),
      },
    ],
    ['source divergente', { 'x-wc-webhook-source': 'https://other.example.test/' }],
    ['topic divergent', { 'x-wc-webhook-topic': 'order.updated' }],
  ])('%s : refuse sans écriture', async (_label, overrides) => {
    const { POST } = await import('@/app/api/woocommerce/webhooks/[token]/route');
    const response = await POST(requestFor(JSON.stringify(payload), overrides), context);

    expect(response.status).toBe(401);
    expect(harness.persist).not.toHaveBeenCalled();
    expect(harness.writeEvent).not.toHaveBeenCalled();
  });

  it('refuse un token inconnu ou un abonnement inactif sans écrire', async () => {
    const { POST } = await import('@/app/api/woocommerce/webhooks/[token]/route');
    harness.candidatePresent = false;
    expect((await POST(requestFor(JSON.stringify(payload)), context)).status).toBe(401);
    expect(harness.persist).not.toHaveBeenCalled();
    expect(harness.writeEvent).not.toHaveBeenCalled();

    harness.candidatePresent = true;
    harness.candidate.status = 'disabled';
    expect((await POST(requestFor(JSON.stringify(payload)), context)).status).toBe(401);
    expect(harness.persist).not.toHaveBeenCalled();
    expect(harness.writeEvent).not.toHaveBeenCalled();
  });

  it('refuse un corps qui dépasse la limite avant la sélection de l’abonnement', async () => {
    const { POST } = await import('@/app/api/woocommerce/webhooks/[token]/route');
    const oversizedBody = `{"padding":"${'x'.repeat(1_048_563)}"}`;
    expect(Buffer.byteLength(oversizedBody, 'utf8')).toBeGreaterThan(1_048_576);

    expect((await POST(requestFor(oversizedBody), context)).status).toBe(401);
    expect(harness.select).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
    expect(harness.writeEvent).not.toHaveBeenCalled();
  });

  it('interrompt une lecture multipartite sans Content-Length dès le dépassement', async () => {
    const { POST } = await import('@/app/api/woocommerce/webhooks/[token]/route');
    let cancelled = false;
    const chunks: [Uint8Array, Uint8Array, Uint8Array] = [
      new TextEncoder().encode('{"padding":"'),
      new TextEncoder().encode('x'.repeat(1_048_563)),
      new TextEncoder().encode('"}'),
    ];
    let chunkIndex = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[chunkIndex++];
        if (chunk) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://app.example.test/api/woocommerce/webhooks/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // Node fetch requires this opt-in for a streaming request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    expect((await POST(request, context)).status).toBe(401);
    expect(cancelled).toBe(true);
    expect(harness.select).not.toHaveBeenCalled();
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it('refuse une connexion inactive et un corps invalide après authentification', async () => {
    const { POST } = await import('@/app/api/woocommerce/webhooks/[token]/route');
    harness.connectionResult = { ok: false, reason: 'connection_inactive' } as never;
    expect((await POST(requestFor(JSON.stringify(payload)), context)).status).toBe(401);
    expect(harness.persist).not.toHaveBeenCalled();
    expect(harness.writeEvent).not.toHaveBeenCalled();

    harness.connectionResult = {
      ok: true,
      connection: {
        externalIdentifier: 'https://store.example.test/',
        context: {
          storeConnectionId: 'connection-1',
          merchantAccountId: 'merchant-1',
          shopId: 'shop-1',
          platform: 'woocommerce',
          platformAppId: null,
        },
      },
    };
    const invalidBody = '{not-json';
    expect((await POST(requestFor(invalidBody), context)).status).toBe(200);
    expect(harness.writeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'terminal',
        lastErrorCode: 'woocommerce_order_payload_invalid',
      }),
    );
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it('répond retryable si la persistance métier échoue et journalise sans payload', async () => {
    const { POST } = await import('@/app/api/woocommerce/webhooks/[token]/route');
    harness.persist.mockResolvedValue({ ok: false, errorCode: 'order_persist_failed' });

    expect((await POST(requestFor(JSON.stringify(payload)), context)).status).toBe(503);
    expect(harness.writeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'retryable',
        lastErrorCode: 'woocommerce_order_persist_failed',
        resourceExternalId: null,
      }),
    );
  });

  it('transmet les delivery_id distincts sans en faire le contexte de tenant', async () => {
    const { POST } = await import('@/app/api/woocommerce/webhooks/[token]/route');
    const body = JSON.stringify(payload);
    await POST(requestFor(body, { 'x-wc-webhook-delivery-id': 'delivery-a' }), context);
    await POST(requestFor(body, { 'x-wc-webhook-delivery-id': 'delivery-b' }), context);

    expect(harness.persist).toHaveBeenCalledTimes(2);
    expect(
      harness.persist.mock.calls.map((call) => (call[0] as { deliveryId: string }).deliveryId),
    ).toEqual(['delivery-a', 'delivery-b']);
    expect(JSON.stringify(harness.persist.mock.calls)).not.toContain('merchant_account_id');
  });
});
