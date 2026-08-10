// Bridge S3-A3 (0121) — prouve que markWebhookStatus (app/api/shopify/webhooks/route.ts) reste
// compatible AVANT et APRÈS la migration 0121, qui remplace la contrainte
// `status in ('processing','done','error')` par `status in ('processing','retryable','terminal','done')`.
// Écrire l'ancien statut `'error'` viole la nouvelle contrainte (23514, check_violation) — le
// bridge doit détecter EXACTEMENT cette erreur et retomber sur `'retryable'`, sans jamais avaler
// une autre erreur SQL ni marquer un échec comme `'done'`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PostgrestLikeError = { code: string; message: string };
type UpdateCall = { payload: Record<string, unknown>; table: string };

type RouteHarness = {
  afterCallback: () => Promise<void>;
  updateCalls: UpdateCall[];
  POST: (request: Request) => Promise<Response>;
};

function buildWebhookRequest(): Request {
  const body = JSON.stringify({
    id: 123,
    myshopify_domain: 'boutique-a.myshopify.com',
    shop_domain: 'boutique-a.myshopify.com',
  });

  return new Request('http://localhost:3000/api/shopify/webhooks', {
    body,
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': 'valid-signature',
      'x-shopify-shop-domain': 'boutique-a.myshopify.com',
      'x-shopify-topic': 'orders/create',
      'x-shopify-triggered-at': '2026-06-21T10:00:00.000Z',
      'x-shopify-webhook-id': 'wh-status-bridge',
    },
    method: 'POST',
  });
}

// `updateErrorForAttempt` lets each test decide what the Nth update on `webhook_event` returns —
// the first attempt always writes the legacy 'error' value, a possible second attempt is the
// bridge's 'retryable' fallback.
async function loadRouteHarness(
  updateErrorForAttempt: (
    attempt: number,
    payload: Record<string, unknown>,
  ) => PostgrestLikeError | null,
): Promise<RouteHarness> {
  vi.resetModules();

  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  let capturedAfterCallback: (() => Promise<void>) | null = null;
  const updateCalls: UpdateCall[] = [];
  let webhookUpdateAttempt = 0;

  vi.doMock('next/server', () => ({
    after: vi.fn((fn: () => Promise<void>) => {
      capturedAfterCallback = fn;
    }),
  }));
  vi.doMock('@/lib/security/rate-limit', () => ({
    checkRateLimit: vi.fn(async () => ({ ok: true })),
  }));
  vi.doMock('@/lib/shopify/apps', () => ({
    getRegisteredShopifyApps: vi.fn(() => [{ clientId: 'app-1', clientSecret: 'secret-1' }]),
    getShopifyAppForShop: vi.fn(() => ({ clientId: 'app-1', clientSecret: 'secret-1' })),
  }));
  vi.doMock('@/lib/shopify/webhook-verify', () => ({
    verifyWebhookHmacAnySecret: vi.fn(() => true),
  }));
  vi.doMock('@/lib/shopify/gdpr', () => ({
    compileCustomerData: vi.fn(),
    redactCustomer: vi.fn(),
    redactShop: vi.fn(),
  }));
  // Le traitement métier échoue systématiquement dans ce harness : c'est le chemin d'échec
  // webhook (markWebhookStatus('error')) qui est sous test, pas persistShopifyOrder lui-même.
  vi.doMock('@/lib/shopify/orders-sync', () => ({
    persistShopifyOrder: vi.fn(async () => {
      throw new Error('simulated business processing failure');
    }),
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
            if (table === 'webhook_event') {
              return {
                select(_selection: string) {
                  return {
                    async single() {
                      return { data: { id: 'evt-1' }, error: null };
                    },
                  };
                },
              };
            }
            return { payload, table };
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
          update(payload: Record<string, unknown>) {
            if (table === 'webhook_event') {
              webhookUpdateAttempt += 1;
              updateCalls.push({ payload, table });
              const error = updateErrorForAttempt(webhookUpdateAttempt, payload);
              return {
                eq: async (_field: string, _value: unknown) => ({ error }),
              };
            }
            return { eq: async () => ({ error: null }) };
          },
        };

        return chain;
      },
    })),
  }));

  const routeModule = await import('@/app/api/shopify/webhooks/route');
  const POST = routeModule.POST;

  // Enregistre le callback after() avant de laisser le test l'invoquer explicitement — le test
  // contrôle donc le timing au lieu de dépendre d'un scheduler async implicite.
  await POST(buildWebhookRequest());

  if (!capturedAfterCallback) {
    throw new Error('after() callback was not captured');
  }

  return {
    afterCallback: capturedAfterCallback,
    updateCalls,
    POST,
  };
}

const CHECK_VIOLATION_ON_LEGACY_ERROR: PostgrestLikeError = {
  code: '23514',
  message:
    'new row for relation "webhook_event" violates check constraint "webhook_event_status_check"',
};

describe('markWebhookStatus — bridge dual-schema 0121', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = undefined;
    process.env.SUPABASE_SERVICE_ROLE_KEY = undefined;
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('schéma AVANT 0121 : écrit encore "error" tel quel, un seul update', async () => {
    const { afterCallback, updateCalls } = await loadRouteHarness(() => null);

    await afterCallback();

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.payload).toMatchObject({ status: 'error', processed: false });
  });

  it('schéma APRÈS 0121 : "error" rejeté par la contrainte → bascule sur "retryable"', async () => {
    const { afterCallback, updateCalls } = await loadRouteHarness((attempt) =>
      attempt === 1 ? CHECK_VIOLATION_ON_LEGACY_ERROR : null,
    );

    await afterCallback();

    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]?.payload).toMatchObject({ status: 'error', processed: false });
    expect(updateCalls[1]?.payload).toMatchObject({ status: 'retryable', processed: false });
    // Jamais 'done' pour un événement réellement en échec, sous aucun schéma.
    expect(updateCalls.some((call) => call.payload.status === 'done')).toBe(false);
  });

  it('toute autre erreur SQL (non liée à 0121) est relancée, pas avalée en fallback silencieux', async () => {
    const unrelatedError: PostgrestLikeError = { code: '42501', message: 'permission denied' };
    const { afterCallback, updateCalls } = await loadRouteHarness(() => unrelatedError);

    await expect(afterCallback()).rejects.toThrow();

    // Un seul essai : le fallback 'retryable' ne doit JAMAIS se déclencher pour une erreur qui
    // n'est pas la violation précise de webhook_event_status_check sur 'error'.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.payload).toMatchObject({ status: 'error' });
  });

  it('le fallback "retryable" qui échoue à son tour est relancé (jamais avalé)', async () => {
    const fallbackFailure: PostgrestLikeError = { code: '55000', message: 'object in use' };
    const { afterCallback, updateCalls } = await loadRouteHarness((attempt) =>
      attempt === 1 ? CHECK_VIOLATION_ON_LEGACY_ERROR : fallbackFailure,
    );

    await expect(afterCallback()).rejects.toThrow();

    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[1]?.payload).toMatchObject({ status: 'retryable' });
  });
});
