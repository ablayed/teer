import type { Database, Json } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

export const MAX_PCD_RETENTION_BATCH = 100;
export const DEFAULT_PCD_RETENTION_BATCH = 25;
export const PCD_RETENTION_MAX_DURATION_MS = 45_000;
export const SHOPIFY_IDENTITY_RETENTION_MONTHS = 12;

export function isShopifyCustomerActivityRetained(
  activityAt: string | null | undefined,
  now = new Date(),
): boolean {
  if (!activityAt) {
    return false;
  }
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - SHOPIFY_IDENTITY_RETENTION_MONTHS);
  const activityMs = Date.parse(activityAt);
  return Number.isFinite(activityMs) && activityMs > cutoff.getTime();
}

export type PcdRetentionPreviewRow = {
  category: string;
  candidate_count: number;
  shop_count: number;
  earliest_expiry: string | null;
  latest_expiry: string | null;
  blocked_count: number;
};

export type PcdRetentionSummary = {
  mode: 'dry_run' | 'execute';
  preview?: PcdRetentionPreviewRow[];
  retryable_payload_count?: number;
  historical_payload_count?: number;
  tombstone_count?: number;
  order_address_count?: number;
  delivery_address_count?: number;
  customer_identity_count?: number;
  dsar_claimed_count?: number;
  dsar_purged_count?: number;
  dsar_retryable_count?: number;
  error_count?: number;
};

function assertRpc<T extends { error: { message: string } | null }>(
  result: T,
  code: string,
): asserts result is T & { error: null } {
  if (result.error) {
    throw new Error(code);
  }
}

function controlledStorageError(): string {
  return 'dsar_storage_delete_failed';
}

export async function previewShopifyPcdRetention(
  admin: AdminClient,
  now = new Date(),
): Promise<PcdRetentionPreviewRow[]> {
  const { data, error } = await admin.rpc('preview_shopify_pcd_retention', {
    p_now: now.toISOString(),
  });
  assertRpc({ error }, 'shopify_pcd_retention_preview_failed');
  return (data ?? []) as PcdRetentionPreviewRow[];
}

async function purgeExpiredDsarArtifacts(
  admin: AdminClient,
  limit: number,
  now: Date,
  deadline: number,
): Promise<
  Pick<PcdRetentionSummary, 'dsar_claimed_count' | 'dsar_purged_count' | 'dsar_retryable_count'>
> {
  const { data: claimed, error: claimError } = await admin.rpc('claim_shopify_dsar_artifacts', {
    p_limit: limit,
    p_now: now.toISOString(),
  });
  assertRpc({ error: claimError }, 'shopify_dsar_purge_claim_failed');

  let purged = 0;
  let retryable = 0;
  for (const artifact of claimed ?? []) {
    if (Date.now() >= deadline) {
      break;
    }

    let storageErrorCode: string | null = null;
    const { error: storageError } = await admin.storage
      .from(artifact.storage_bucket)
      .remove([artifact.storage_path]);
    if (storageError) {
      storageErrorCode = controlledStorageError();
    }

    const { data: finalized, error: finalizeError } = await admin.rpc(
      'finalize_shopify_dsar_artifact_purge',
      {
        p_id: artifact.id,
        p_success: storageErrorCode === null,
        p_error_code: storageErrorCode ?? undefined,
        p_now: new Date().toISOString(),
      },
    );

    if (finalizeError || finalized !== true) {
      retryable += 1;
      continue;
    }

    if (storageErrorCode) {
      retryable += 1;
    } else {
      purged += 1;
    }
  }

  return {
    dsar_claimed_count: (claimed ?? []).length,
    dsar_purged_count: purged,
    dsar_retryable_count: retryable,
  };
}

export async function executeShopifyPcdRetention(
  admin: AdminClient,
  limit: number,
  now = new Date(),
  maxDurationMs = PCD_RETENTION_MAX_DURATION_MS,
): Promise<PcdRetentionSummary> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PCD_RETENTION_BATCH) {
    throw new Error('invalid_shopify_pcd_retention_batch');
  }

  const { data, error } = await admin.rpc('execute_shopify_pcd_retention', {
    p_limit: limit,
    p_now: now.toISOString(),
  });
  assertRpc({ error }, 'shopify_pcd_retention_execute_failed');

  const dbSummary = (data ?? {}) as Record<string, Json | undefined>;
  const dsarSummary = await purgeExpiredDsarArtifacts(
    admin,
    limit,
    now,
    Date.now() + maxDurationMs,
  );

  return {
    mode: 'execute',
    retryable_payload_count: Number(dbSummary.retryable_payload_count ?? 0),
    historical_payload_count: Number(dbSummary.historical_payload_count ?? 0),
    tombstone_count: Number(dbSummary.tombstone_count ?? 0),
    order_address_count: Number(dbSummary.order_address_count ?? 0),
    delivery_address_count: Number(dbSummary.delivery_address_count ?? 0),
    customer_identity_count: Number(dbSummary.customer_identity_count ?? 0),
    error_count: Number(dbSummary.error_count ?? 0) + (dsarSummary.dsar_retryable_count ?? 0),
    ...dsarSummary,
  };
}
