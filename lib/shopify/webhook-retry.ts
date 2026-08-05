import type { Database, Json } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

export const MAX_WEBHOOK_RETRY_BATCH = 100;
export const WEBHOOK_LEASE_MS = 5 * 60 * 1_000;

export type ClaimedShopifyWebhook = {
  id: string;
  topic: string;
  shopDomain: string | null;
  shopId: string | null;
  merchantAccountId: string | null;
  payload: Json | null;
  attemptCount: number;
};

export type RetryOutcome = 'done' | 'retryable' | 'terminal';

export function webhookBackoffMs(attemptCount: number): number {
  const attempt = Math.max(1, Math.min(12, Math.floor(attemptCount)));
  return Math.min(60 * 60 * 1_000, 2 ** attempt * 1_000);
}

export async function claimRetryableShopifyWebhooks(
  admin: AdminClient,
  limit: number,
  now = new Date(),
): Promise<ClaimedShopifyWebhook[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WEBHOOK_RETRY_BATCH) {
    throw new Error('invalid_webhook_retry_batch');
  }

  const { data, error } = await admin.rpc('claim_shopify_webhook_events', {
    p_limit: limit,
    p_now: now.toISOString(),
  });
  if (error) {
    throw new Error('shopify_webhook_retry_claim_failed');
  }

  return (data ?? []).map((event) => ({
    id: event.id,
    topic: event.topic,
    shopDomain: event.shop_domain,
    shopId: event.shop_id,
    merchantAccountId: event.merchant_account_id,
    payload: event.payload,
    attemptCount: event.attempt_count,
  }));
}

function sanitizeRetryError(_error: unknown): string {
  return 'internal_processing_error';
}

export async function replayRetryableShopifyWebhooks(
  admin: AdminClient,
  limit: number,
  process: (event: ClaimedShopifyWebhook) => Promise<RetryOutcome>,
  now = new Date(),
): Promise<{ done: number; retryable: number; terminal: number }> {
  const events = await claimRetryableShopifyWebhooks(admin, limit, now);
  const counts = { done: 0, retryable: 0, terminal: 0 };

  for (const event of events) {
    let outcome: RetryOutcome;
    let errorCode: string | undefined;
    try {
      outcome = await process(event);
    } catch (error) {
      outcome = 'retryable';
      errorCode = sanitizeRetryError(error);
    }

    const { data, error } = await admin.rpc('finish_shopify_webhook_event', {
      p_event_id: event.id,
      p_outcome: outcome,
      p_error_code: errorCode,
    });
    if (error || data !== true) {
      throw new Error('shopify_webhook_retry_finalize_failed');
    }
    counts[outcome] += 1;
  }

  return counts;
}
