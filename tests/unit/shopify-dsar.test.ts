import {
  DSAR_MAX_TTL_SECONDS,
  consumePrivateDsarDownloadAuthorization,
  issuePrivateDsarDownloadAuthorization,
} from '@/lib/shopify/dsar';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

function fakeClient(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { client: { rpc } as unknown as SupabaseClient<Database>, rpc };
}

describe('private Shopify DSAR one-shot authorizations', () => {
  it('issues an opaque authorization through the authenticated RPC', async () => {
    const { client, rpc } = fakeClient([
      { download_token: 'synthetic-download-token', expires_at: '2026-08-05T00:10:00.000Z' },
    ]);

    await expect(
      issuePrivateDsarDownloadAuthorization(client, {
        artifactId: '00000000-0000-4000-8000-000000000001',
        merchantAccountId: '00000000-0000-4000-8000-000000000002',
        shopId: '00000000-0000-4000-8000-000000000003',
      }),
    ).resolves.toEqual({
      downloadToken: 'synthetic-download-token',
      expiresAt: '2026-08-05T00:10:00.000Z',
    });
    expect(rpc).toHaveBeenCalledWith('issue_shopify_dsar_download_authorization', {
      p_artifact_id: '00000000-0000-4000-8000-000000000001',
      p_shop_id: '00000000-0000-4000-8000-000000000003',
      p_tenant_id: '00000000-0000-4000-8000-000000000002',
    });
  });

  it('consumes the authorization through a scoped RPC and never queries Storage by token', async () => {
    const { client, rpc } = fakeClient([
      {
        authorization_id: '00000000-0000-4000-8000-000000000004',
        byte_size: 128,
        storage_bucket: 'shopify-dsar',
        storage_path: 'synthetic-tenant/synthetic-event.json',
      },
    ]);

    await expect(
      consumePrivateDsarDownloadAuthorization(client, {
        artifactId: '00000000-0000-4000-8000-000000000001',
        downloadToken: 'synthetic-download-token',
        merchantAccountId: '00000000-0000-4000-8000-000000000002',
        shopId: '00000000-0000-4000-8000-000000000003',
      }),
    ).resolves.toEqual({
      authorizationId: '00000000-0000-4000-8000-000000000004',
      bucket: 'shopify-dsar',
      path: 'synthetic-tenant/synthetic-event.json',
      byteSize: 128,
    });
    expect(rpc).toHaveBeenCalledWith('consume_shopify_dsar_download_authorization', {
      p_artifact_id: '00000000-0000-4000-8000-000000000001',
      p_download_token: 'synthetic-download-token',
      p_shop_id: '00000000-0000-4000-8000-000000000003',
      p_tenant_id: '00000000-0000-4000-8000-000000000002',
    });
  });

  it('fails closed when the authorization RPC rejects a second or expired use', async () => {
    const { client } = fakeClient(null, { message: 'authorization_forbidden' });

    await expect(
      consumePrivateDsarDownloadAuthorization(client, {
        artifactId: '00000000-0000-4000-8000-000000000001',
        downloadToken: 'synthetic-download-token',
        merchantAccountId: '00000000-0000-4000-8000-000000000002',
        shopId: '00000000-0000-4000-8000-000000000003',
      }),
    ).rejects.toThrow('dsar_download_authorization_forbidden');
    expect(DSAR_MAX_TTL_SECONDS).toBe(24 * 60 * 60);
  });
});
