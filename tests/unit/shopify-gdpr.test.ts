import { redactCustomer, toGdprAuditPayload } from '@/lib/shopify/gdpr';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

function fakeAdmin(rpcResult: unknown): SupabaseClient<Database> {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as SupabaseClient<Database>;
}

describe('Shopify GDPR redaction contract', () => {
  it('delegates the complete redaction to one tenant/shop-scoped RPC', async () => {
    const rpc = {
      customer_count: 1,
      order_count: 2,
      delivery_address_count: 3,
      tombstone_count: 1,
      webhook_payload_count: 0,
    };
    const admin = fakeAdmin({ data: rpc, error: null });

    await expect(
      redactCustomer(admin, {
        merchantAccountId: 'merchant-1',
        shopId: 'shop-1',
        shopifyCustomerId: 'customer-1',
        webhookEventId: 'webhook-event-1',
      }),
    ).resolves.toEqual(rpc);
    expect(admin.rpc).toHaveBeenCalledWith('redact_shopify_customer_copies', {
      p_merchant_account_id: 'merchant-1',
      p_shop_id: 'shop-1',
      p_shopify_customer_id: 'customer-1',
      p_topic: 'customers/redact',
      p_webhook_event_id: 'webhook-event-1',
    });
  });

  it('ne marque jamais une redaction réussie si la RPC échoue', async () => {
    const admin = fakeAdmin({ data: null, error: { message: 'transaction aborted' } });

    await expect(
      redactCustomer(admin, {
        merchantAccountId: 'merchant-1',
        shopId: 'shop-1',
        shopifyCustomerId: 'customer-1',
        webhookEventId: 'webhook-event-1',
      }),
    ).rejects.toThrow('gdpr_redaction_failed');
  });

  it('ne produit qu’une preuve sans PCD pour l’audit final', () => {
    const payload = toGdprAuditPayload({
      topic: 'customers/redact',
      status: 'done',
      artifactId: 'artifact-1',
      artifactExpiresAt: '2026-08-06T00:00:00Z',
      proof: {
        customer_count: 1,
        order_count: 2,
        delivery_address_count: 3,
        tombstone_count: 1,
        webhook_payload_count: 0,
      },
    });

    expect(payload).toEqual({
      topic: 'customers/redact',
      status: 'done',
      artifact_id: 'artifact-1',
      artifact_expires_at: '2026-08-06T00:00:00Z',
      counts: {
        customer_count: 1,
        order_count: 2,
        delivery_address_count: 3,
        tombstone_count: 1,
        webhook_payload_count: 0,
      },
    });
    expect(JSON.stringify(payload)).not.toContain('compiled');
  });
});
