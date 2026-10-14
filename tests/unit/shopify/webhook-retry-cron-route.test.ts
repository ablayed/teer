import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  clients: 0,
  replay: vi.fn(),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: () => {
    h.clients += 1;
    return { marker: 'client-service-role' };
  },
}));
vi.mock('@/lib/shopify/webhook-replay', () => ({
  replayPendingShopifyWebhooks: (...args: unknown[]) => h.replay(...args),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const ENV = ['CRON_SECRET', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const previous = new Map<string, string | undefined>();

function call(authorization?: string) {
  return new NextRequest('http://localhost:3000/api/cron/shopify-webhook-retry', {
    headers: authorization ? { authorization } : {},
  });
}

describe('cron shopify-webhook-retry', () => {
  beforeEach(() => {
    for (const key of ENV) previous.set(key, process.env[key]);
    process.env.CRON_SECRET = 'secret-de-test-du-cron';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'cle-service-synthetique';
    h.clients = 0;
    h.replay.mockReset();
  });

  afterEach(() => {
    for (const key of ENV) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('sans secret, ou avec un mauvais : 401, aucun client service-role, aucune reprise', async () => {
    const { GET } = await import('@/app/api/cron/shopify-webhook-retry/route');

    for (const authorization of [undefined, 'Bearer autre', 'secret-de-test-du-cron']) {
      const response = await GET(call(authorization));
      expect(response.status).toBe(401);
    }
    process.env.CRON_SECRET = '';
    expect((await GET(call('Bearer '))).status).toBe(401);

    expect(h.clients).toBe(0);
    expect(h.replay).not.toHaveBeenCalled();
  });

  it('avec le secret : une reprise, et des comptes pour toute réponse', async () => {
    const summary = {
      examined: 3,
      needsReview: { 'app/uninstalled': 1 },
      replayed: { done: 2, retryable: 0, terminal: 0, unknown: 0 },
      scanTruncated: false,
      skipped: {},
      stoppedOnBudget: false,
    };
    h.replay.mockResolvedValue(summary);
    const { GET } = await import('@/app/api/cron/shopify-webhook-retry/route');

    const response = await GET(call('Bearer secret-de-test-du-cron'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...summary });
    expect(h.replay).toHaveBeenCalledTimes(1);
    expect(h.replay.mock.calls[0]?.[0]).toEqual({ marker: 'client-service-role' });
    // Aucun réglage ne vient de la requête.
    expect(h.replay.mock.calls[0]).toHaveLength(1);
  });

  it('reprise en échec : 500, sans détail', async () => {
    h.replay.mockRejectedValue(new Error('shopify_webhook_replay_scan_failed'));
    const { GET } = await import('@/app/api/cron/shopify-webhook-retry/route');

    const response = await GET(call('Bearer secret-de-test-du-cron'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'replay_failed', ok: false });
  });
});
