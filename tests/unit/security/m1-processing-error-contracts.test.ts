import { PcdAccessAuditError, writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import { consumePcdQuota } from '@/lib/security/pcd-access-controls';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

const client = (message: string) =>
  ({
    rpc: vi.fn().mockResolvedValue({ data: null, status: 403, error: { code: '42501', message } }),
  }) as unknown as SupabaseClient<Database>;

describe('M1: SQL authorization errors become processing errors at the current HTTP boundary', () => {
  it('preserves the audit failure cause; it is not an HTTP authorization denial', async () => {
    await expect(
      writePcdAccessAudit(client('pcd_access_audit_shop_forbidden'), {
        tenantId: '11111111-1111-4111-8111-111111111111',
        shopId: '22222222-2222-4222-8222-222222222222',
        actorKind: 'human',
        action: 'list_access',
        dataCategory: 'customer_identity',
        purpose: 'order_fulfillment',
        outcome: 'succeeded',
        resourceType: 'order',
        surface: 'server_action',
      }),
    ).rejects.toMatchObject({ name: 'PcdAccessAuditError', cause: { code: '42501', status: 403 } });
    expect(new PcdAccessAuditError()).toBeInstanceOf(Error);
  });
  it('flattens the quota SQL guard into quota_unavailable, explaining DSAR 503', async () => {
    await expect(
      consumePcdQuota(client('pcd_quota_shop_forbidden'), {
        tenantId: '11111111-1111-4111-8111-111111111111',
        shopId: '22222222-2222-4222-8222-222222222222',
        actorKind: 'human',
        action: 'generate_download_authorization',
      }),
    ).rejects.toMatchObject({ name: 'PcdAccessControlError', code: 'quota_unavailable' });
  });
});
