import { beforeEach, describe, expect, it, vi } from 'vitest';

const replay = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, fail: false }));
const captured = vi.hoisted(() => ({ errors: [] as unknown[] }));

vi.mock('@/lib/shopify/webhook-replay', () => ({
  replayPendingShopifyWebhooks: vi.fn(async (_admin: unknown, options: Record<string, unknown>) => {
    replay.calls.push(options);
    if (replay.fail) throw new Error('shopify_webhook_replay_scan_failed');
  }),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn((error: unknown) => {
    captured.errors.push(error);
  }),
}));

import {
  OPPORTUNISTIC_SWEEP_BUDGET_MS,
  OPPORTUNISTIC_SWEEP_MIN_INTERVAL_MS,
  OPPORTUNISTIC_SWEEP_SCAN_LIMIT,
  resetOpportunisticSweepThrottleForTests,
  sweepPendingShopifyWebhooks,
} from '@/lib/shopify/webhook-opportunistic-sweep';

const admin = {} as never;

describe('balayage opportuniste des webhooks Shopify', () => {
  beforeEach(() => {
    resetOpportunisticSweepThrottleForTests();
    replay.calls = [];
    replay.fail = false;
    captured.errors = [];
  });

  it('reprend les plus anciens éligibles avec un budget et une lecture bornés, sans relevé de revue', async () => {
    await sweepPendingShopifyWebhooks(admin, 1_000_000);

    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]).toMatchObject({
      budgetMs: OPPORTUNISTIC_SWEEP_BUDGET_MS,
      reportReview: false,
      scanLimit: OPPORTUNISTIC_SWEEP_SCAN_LIMIT,
    });
  });

  it('ne balaye qu’une fois par intervalle et par instance', async () => {
    await sweepPendingShopifyWebhooks(admin, 1_000_000);
    await sweepPendingShopifyWebhooks(admin, 1_000_000 + OPPORTUNISTIC_SWEEP_MIN_INTERVAL_MS - 1);
    expect(replay.calls).toHaveLength(1);

    await sweepPendingShopifyWebhooks(admin, 1_000_000 + OPPORTUNISTIC_SWEEP_MIN_INTERVAL_MS);
    expect(replay.calls).toHaveLength(2);
  });

  it('absorbe un échec de reprise et le signale, sans jamais le propager', async () => {
    replay.fail = true;
    await expect(sweepPendingShopifyWebhooks(admin, 1_000_000)).resolves.toBeUndefined();
    expect(captured.errors).toHaveLength(1);
  });

  it('garde un budget très inférieur au bail de quatre minutes d’un événement réclamé', () => {
    expect(OPPORTUNISTIC_SWEEP_BUDGET_MS).toBeLessThan(4 * 60 * 1_000);
  });
});
