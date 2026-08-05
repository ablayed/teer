import {
  MAX_WEBHOOK_RETRY_BATCH,
  claimRetryableShopifyWebhooks,
  replayRetryableShopifyWebhooks,
  webhookBackoffMs,
} from '@/lib/shopify/webhook-retry';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

function fakeAdmin(result: unknown): SupabaseClient<Database> {
  return {
    rpc: vi.fn().mockResolvedValue(result),
  } as unknown as SupabaseClient<Database>;
}

describe('Shopify webhook retry primitive', () => {
  it('uses a bounded deterministic exponential backoff', () => {
    expect(webhookBackoffMs(1)).toBe(2_000);
    expect(webhookBackoffMs(2)).toBe(4_000);
    expect(webhookBackoffMs(99)).toBe(3_600_000);
  });

  it('rejects an unbounded claim batch', async () => {
    await expect(
      claimRetryableShopifyWebhooks(
        fakeAdmin({ data: [], error: null }),
        MAX_WEBHOOK_RETRY_BATCH + 1,
      ),
    ).rejects.toThrow('invalid_webhook_retry_batch');
  });

  it('maps only technical fields returned by the SQL claim', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 'event-1',
            topic: 'customers/redact',
            shop_domain: 'shop.myshopify.com',
            shop_id: 'shop-1',
            merchant_account_id: 'merchant-1',
            payload: { customer: { id: 123 } },
            attempt_count: 2,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });
    const admin = { rpc } as unknown as SupabaseClient<Database>;

    await expect(
      claimRetryableShopifyWebhooks(admin, 1, new Date('2026-08-05T00:00:00Z')),
    ).resolves.toEqual([
      {
        id: 'event-1',
        topic: 'customers/redact',
        shopDomain: 'shop.myshopify.com',
        shopId: 'shop-1',
        merchantAccountId: 'merchant-1',
        payload: { customer: { id: 123 } },
        attemptCount: 2,
      },
    ]);
    expect(admin.rpc).toHaveBeenCalledWith('claim_shopify_webhook_events', {
      p_limit: 1,
      p_now: '2026-08-05T00:00:00.000Z',
    });
  });

  it('rejoue chaque tâche réclamée et finalise son état sans exposer l’erreur', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 'event-1',
            topic: 'customers/redact',
            shop_domain: 'shop.myshopify.com',
            shop_id: 'shop-1',
            merchant_account_id: 'merchant-1',
            payload: { customer: { id: 123 } },
            attempt_count: 2,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });
    const admin = { rpc } as unknown as SupabaseClient<Database>;
    const processor = vi
      .fn()
      .mockRejectedValue(new Error('customer name leaked in an upstream error'));

    await expect(replayRetryableShopifyWebhooks(admin, 1, processor)).resolves.toEqual({
      done: 0,
      retryable: 1,
      terminal: 0,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'finish_shopify_webhook_event', {
      p_event_id: 'event-1',
      p_outcome: 'retryable',
      p_error_code: 'internal_processing_error',
    });
  });
});
