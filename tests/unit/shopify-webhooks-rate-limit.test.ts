import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RateLimitResult = { ok: boolean };
type RouteHarness = {
  checkRateLimit: ReturnType<typeof vi.fn<(name: string, key: string) => Promise<RateLimitResult>>>;
  inserts: Array<{ payload: Record<string, unknown>; table: string }>;
  POST: (request: Request) => Promise<Response>;
};

function buildWebhookRequest(
  shopDomain: string,
  webhookId = `wh-${shopDomain}`,
  hmac = 'valid-signature',
): Request {
  const body = JSON.stringify({
    id: 123,
    myshopify_domain: shopDomain,
    shop_domain: shopDomain,
  });

  return new Request('http://localhost:3000/api/shopify/webhooks', {
    body,
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-shop-domain': shopDomain,
      'x-shopify-topic': 'orders/create',
      'x-shopify-triggered-at': '2026-06-21T10:00:00.000Z',
      'x-shopify-webhook-id': webhookId,
    },
    method: 'POST',
  });
}

async function loadRouteHarness(rateLimitResults: RateLimitResult[]): Promise<RouteHarness> {
  vi.resetModules();

  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  const inserts: Array<{ payload: Record<string, unknown>; table: string }> = [];
  const checkRateLimit = vi.fn<(name: string, key: string) => Promise<RateLimitResult>>();
  for (const result of rateLimitResults) {
    checkRateLimit.mockResolvedValueOnce(result);
  }
  if (rateLimitResults.length === 0) {
    checkRateLimit.mockResolvedValue({ ok: true });
  }

  vi.doMock('next/server', () => ({
    after: vi.fn(),
  }));
  vi.doMock('@/lib/security/rate-limit', () => ({
    checkRateLimit,
  }));
  vi.doMock('@/lib/shopify/apps', () => ({
    getRegisteredShopifyApps: vi.fn(() => [{ clientId: 'app-1', clientSecret: 'secret-1' }]),
    getShopifyAppForShop: vi.fn(() => ({ clientId: 'app-1', clientSecret: 'secret-1' })),
  }));
  vi.doMock('@/lib/shopify/webhook-verify', () => ({
    verifyWebhookHmacAnySecret: vi.fn(
      (_body: string, signature: string | null) => signature === 'valid-signature',
    ),
  }));
  vi.doMock('@/lib/shopify/gdpr', () => ({
    compileCustomerData: vi.fn(),
    redactCustomer: vi.fn(),
    redactShop: vi.fn(),
  }));
  vi.doMock('@/lib/shopify/orders-sync', () => ({
    persistShopifyOrder: vi.fn(),
  }));
  vi.doMock('@/lib/shopify/products-sync', () => ({
    persistShopifyProductWebhook: vi.fn(),
  }));
  vi.doMock('@/lib/shopify/reconcile', () => ({
    processFinishedBulkForShop: vi.fn(),
  }));
  vi.doMock('@/lib/shopify/refunds', () => ({
    deriveRefundWebhook: vi.fn(),
  }));
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: vi.fn(() => ({
      from(table: string) {
        const chain = {
          eq(_field: string, _value: unknown) {
            return chain;
          },
          insert(payload: Record<string, unknown>) {
            inserts.push({ payload, table });
            return {
              select(_selection: string) {
                return {
                  async single() {
                    return { data: { id: 'evt-1' }, error: null };
                  },
                };
              },
            };
          },
          maybeSingle: async () => ({
            data:
              table === 'shop'
                ? {
                    id: 'shop-1',
                    merchant_account_id: 'merchant-1',
                    shop_domain: 'boutique-a.myshopify.com',
                    shopify_client_id: 'app-1',
                    status: 'active',
                  }
                : null,
            error: null,
          }),
          select(_selection: string) {
            return chain;
          },
        };

        return chain;
      },
    })),
  }));

  const routeModule = await import('@/app/api/shopify/webhooks/route');

  return {
    checkRateLimit,
    inserts,
    POST: routeModule.POST,
  };
}

describe('POST /api/shopify/webhooks rate limit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = undefined;
    process.env.SUPABASE_SERVICE_ROLE_KEY = undefined;
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns 429 when the webhook limiter is exceeded', async () => {
    const { POST, checkRateLimit, inserts } = await loadRouteHarness([{ ok: false }]);

    const response = await POST(buildWebhookRequest('boutique-a.myshopify.com'));

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(checkRateLimit).toHaveBeenCalledWith(
      'shopify_webhook',
      'webhook:boutique-a.myshopify.com',
    );
    expect(inserts).toHaveLength(0);
  });

  it('passes under the threshold', async () => {
    const { POST, checkRateLimit, inserts } = await loadRouteHarness([{ ok: true }]);

    const response = await POST(buildWebhookRequest('boutique-a.myshopify.com'));

    expect(response.status).toBe(200);
    expect(checkRateLimit).toHaveBeenCalledWith(
      'shopify_webhook',
      'webhook:boutique-a.myshopify.com',
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      table: 'webhook_event',
    });
  });

  it('refuses an invalid HMAC before inserting a durable event', async () => {
    const { POST, inserts } = await loadRouteHarness([]);

    const response = await POST(
      buildWebhookRequest('boutique-a.myshopify.com', 'wh-invalid-hmac', 'invalid-signature'),
    );

    expect(response.status).toBe(401);
    expect(inserts).toHaveLength(0);
  });

  it('passes when the limiter fails open', async () => {
    const { POST, inserts } = await loadRouteHarness([{ ok: true }]);

    const response = await POST(buildWebhookRequest('boutique-a.myshopify.com'));

    expect(response.status).toBe(200);
    expect(inserts).toHaveLength(1);
  });

  it('uses distinct keys per shop_domain', async () => {
    const { POST, checkRateLimit } = await loadRouteHarness([{ ok: true }, { ok: true }]);

    await POST(buildWebhookRequest('boutique-a.myshopify.com', 'wh-a'));
    await POST(buildWebhookRequest('boutique-b.myshopify.com', 'wh-b'));

    expect(checkRateLimit).toHaveBeenNthCalledWith(
      1,
      'shopify_webhook',
      'webhook:boutique-a.myshopify.com',
    );
    expect(checkRateLimit).toHaveBeenNthCalledWith(
      2,
      'shopify_webhook',
      'webhook:boutique-b.myshopify.com',
    );
  });
});
