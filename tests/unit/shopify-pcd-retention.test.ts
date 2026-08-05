import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_PCD_RETENTION_BATCH,
  executeShopifyPcdRetention,
  isShopifyCustomerActivityRetained,
  previewShopifyPcdRetention,
} from '@/lib/shopify/pcd-retention';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function fakeAdmin({
  claimRows = [],
  executeRows = {},
  storageError = null,
}: {
  claimRows?: Array<{
    id: string;
    storage_bucket: string;
    storage_path: string;
    purge_attempt_count: number;
  }>;
  executeRows?: Record<string, unknown>;
  storageError?: { message: string } | null;
} = {}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'preview_shopify_pcd_retention') {
      return {
        data: [
          {
            category: 'expired_order_address',
            candidate_count: 2,
            shop_count: 1,
            earliest_expiry: '2025-01-01T00:00:00.000Z',
            latest_expiry: '2025-01-02T00:00:00.000Z',
            blocked_count: 0,
          },
        ],
        error: null,
      };
    }
    if (name === 'execute_shopify_pcd_retention') {
      return { data: executeRows, error: null };
    }
    if (name === 'claim_shopify_dsar_artifacts') {
      return { data: claimRows, error: null };
    }
    if (name === 'finalize_shopify_dsar_artifact_purge') {
      return { data: true, error: null };
    }
    throw new Error(`unexpected_rpc_${name}`);
  });
  const remove = vi.fn().mockResolvedValue({ data: [], error: storageError });
  const admin = {
    rpc,
    storage: { from: vi.fn(() => ({ remove })) },
  } as unknown as SupabaseClient<Database>;
  return { admin, rpc, remove };
}

describe('Shopify PCD retention', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('dry-run appelle uniquement la preview SQL et ne mute rien', async () => {
    const { admin, rpc } = fakeAdmin();
    const result = await previewShopifyPcdRetention(admin, new Date('2026-08-05T00:00:00.000Z'));

    expect(result).toHaveLength(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('preview_shopify_pcd_retention', {
      p_now: '2026-08-05T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toMatch(/phone|address1|payload|compiled|storage_path/);
  });

  it('exécute par lots et purge un artefact DSAR seulement après le claim', async () => {
    const { admin, rpc, remove } = fakeAdmin({
      claimRows: [
        {
          id: 'artifact-technical-id',
          storage_bucket: 'shopify-dsar',
          storage_path: 'merchant-technical-id/event-technical-id.json',
          purge_attempt_count: 1,
        },
      ],
      executeRows: {
        retryable_payload_count: 1,
        historical_payload_count: 1,
        tombstone_count: 1,
        order_address_count: 1,
        delivery_address_count: 1,
        customer_identity_count: 1,
        error_count: 0,
      },
    });

    const result = await executeShopifyPcdRetention(
      admin,
      MAX_PCD_RETENTION_BATCH,
      new Date('2026-08-05T00:00:00.000Z'),
    );

    expect(result).toMatchObject({
      retryable_payload_count: 1,
      historical_payload_count: 1,
      tombstone_count: 1,
      order_address_count: 1,
      delivery_address_count: 1,
      customer_identity_count: 1,
      dsar_claimed_count: 1,
      dsar_purged_count: 1,
      dsar_retryable_count: 0,
    });
    expect(remove).toHaveBeenCalledWith(['merchant-technical-id/event-technical-id.json']);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'execute_shopify_pcd_retention',
      'claim_shopify_dsar_artifacts',
      'finalize_shopify_dsar_artifact_purge',
    ]);
  });

  it('un échec Storage devient retryable et ne finalise pas purged', async () => {
    const { admin, rpc } = fakeAdmin({
      claimRows: [
        {
          id: 'artifact-technical-id',
          storage_bucket: 'shopify-dsar',
          storage_path: 'merchant-technical-id/event-technical-id.json',
          purge_attempt_count: 1,
        },
      ],
      storageError: { message: 'temporary storage failure' },
    });

    await executeShopifyPcdRetention(admin, 1, new Date('2026-08-05T00:00:00.000Z'));

    expect(rpc).toHaveBeenLastCalledWith('finalize_shopify_dsar_artifact_purge', {
      p_id: 'artifact-technical-id',
      p_success: false,
      p_error_code: 'dsar_storage_delete_failed',
      p_now: expect.any(String),
    });
  });

  it('deux exécutions successives sont idempotentes lorsque la seconde ne reçoit aucun candidat', async () => {
    const admin = fakeAdmin({
      executeRows: {
        retryable_payload_count: 0,
        historical_payload_count: 0,
        tombstone_count: 0,
        order_address_count: 0,
        delivery_address_count: 0,
        customer_identity_count: 0,
        error_count: 0,
      },
    }).admin;

    const first = await executeShopifyPcdRetention(admin, 1);
    const second = await executeShopifyPcdRetention(admin, 1);

    expect(first).toMatchObject({
      retryable_payload_count: 0,
      tombstone_count: 0,
      dsar_claimed_count: 0,
    });
    expect(second).toEqual(first);
  });

  it('deux workers concurrents ne traitent qu’une seule cible claimée', async () => {
    let claimCalls = 0;
    const remove = vi.fn().mockResolvedValue({ data: [], error: null });
    const rpc = vi.fn(async (name: string) => {
      if (name === 'execute_shopify_pcd_retention') {
        return { data: { error_count: 0 }, error: null };
      }
      if (name === 'claim_shopify_dsar_artifacts') {
        claimCalls += 1;
        return {
          data:
            claimCalls === 1
              ? [
                  {
                    id: 'concurrent-artifact',
                    storage_bucket: 'shopify-dsar',
                    storage_path: 'technical/path.json',
                    purge_attempt_count: 1,
                  },
                ]
              : [],
          error: null,
        };
      }
      return { data: true, error: null };
    });
    const admin = {
      rpc,
      storage: { from: vi.fn(() => ({ remove })) },
    } as unknown as SupabaseClient<Database>;

    await Promise.all([executeShopifyPcdRetention(admin, 1), executeShopifyPcdRetention(admin, 1)]);

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('conserve les critères, durées et barrières dans la source SQL unique', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/0122_shopify_pcd_retention_and_purge.sql'),
      'utf8',
    );

    expect(migration).toContain("interval '90 days'");
    expect(migration).toContain("interval '12 months'");
    expect(migration).toContain("interval '7 days'");
    expect(migration).toContain("status in ('ready', 'expired', 'purge_retryable')");
    expect(migration).toContain('for update skip locked');
    expect(migration).toContain(
      'create or replace function public.shopify_pcd_retention_candidates',
    );
    expect(migration).toContain('from public.shopify_pcd_retention_candidates(p_now) c');
    expect(migration).toContain("(o.order_state = 'returned'");
    expect(migration).toContain("o.cash_state in ('expected', 'collected', 'discrepancy')");
    expect(migration).toContain('revoke all on function public.preview_shopify_pcd_retention');
    expect(migration).toContain('revoke all on function public.execute_shopify_pcd_retention');
    expect(migration).toContain('revoke all on function public.claim_shopify_dsar_artifacts');
    expect(migration).toContain(
      'revoke all on function public.finalize_shopify_dsar_artifact_purge',
    );
    expect(migration).toContain('pcd_finalized_at := null');
    expect(migration).toContain('shopify_last_activity_at');
    expect(migration).not.toContain('set pcd_finalized_at = updated_at');
  });

  it('bloque une activité Shopify ancienne ou inconnue avant toute réhydratation PCD', () => {
    const now = new Date('2026-08-05T00:00:00.000Z');
    expect(isShopifyCustomerActivityRetained('2026-08-04T00:00:00.000Z', now)).toBe(true);
    expect(isShopifyCustomerActivityRetained('2025-08-04T00:00:00.000Z', now)).toBe(false);
    expect(isShopifyCustomerActivityRetained(null, now)).toBe(false);
  });
});
