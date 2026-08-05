import { DSAR_MAX_TTL_SECONDS, createPrivateDsarSignedUrl } from '@/lib/shopify/dsar';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

function fakeAdmin(artifact: Record<string, string> | null) {
  const createSignedUrl = vi
    .fn()
    .mockResolvedValue({ data: { signedUrl: 'https://private.test/url' }, error: null });
  const update = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  });
  const maybeSingle = vi.fn().mockResolvedValue({ data: artifact, error: null });
  const eq = vi.fn().mockReturnThis();
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq,
    maybeSingle,
    update,
  };
  const admin = {
    from: vi.fn(() => chain),
    storage: {
      from: vi.fn(() => ({ createSignedUrl })),
    },
  } as unknown as SupabaseClient<Database>;
  return { admin, createSignedUrl, eq };
}

describe('private Shopify DSAR artifacts', () => {
  it('never signs beyond the artifact expiration or 24 hours', async () => {
    const { admin, createSignedUrl } = fakeAdmin({
      storage_bucket: 'shopify-dsar',
      storage_path: 'merchant-1/event-1.json',
      shop_id: 'shop-1',
      status: 'ready',
      expires_at: '2026-08-05T02:00:00.000Z',
    });

    await expect(
      createPrivateDsarSignedUrl(admin, {
        artifactId: 'artifact-1',
        merchantAccountId: 'merchant-1',
        shopId: 'shop-1',
        now: new Date('2026-08-05T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ expiresAt: '2026-08-05T02:00:00.000Z' });
    expect(createSignedUrl).toHaveBeenCalledWith('merchant-1/event-1.json', 2 * 60 * 60);
    expect(DSAR_MAX_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('refuses an expired artifact', async () => {
    const { admin, createSignedUrl } = fakeAdmin({
      storage_bucket: 'shopify-dsar',
      storage_path: 'merchant-1/event-1.json',
      shop_id: 'shop-1',
      status: 'ready',
      expires_at: '2026-08-04T23:59:59.000Z',
    });

    await expect(
      createPrivateDsarSignedUrl(admin, {
        artifactId: 'artifact-1',
        merchantAccountId: 'merchant-1',
        shopId: 'shop-1',
        now: new Date('2026-08-05T00:00:00.000Z'),
      }),
    ).rejects.toThrow('dsar_artifact_expired');
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('always scopes the artifact lookup by tenant and shop', async () => {
    const { admin, eq } = fakeAdmin({
      storage_bucket: 'shopify-dsar',
      storage_path: 'tenant-a/event-a.json',
      shop_id: 'shop-a',
      status: 'ready',
      expires_at: '2026-08-05T02:00:00.000Z',
    });

    await createPrivateDsarSignedUrl(admin, {
      artifactId: '00000000-0000-4000-8000-000000000001',
      merchantAccountId: '00000000-0000-4000-8000-000000000002',
      shopId: '00000000-0000-4000-8000-000000000003',
      now: new Date('2026-08-05T00:00:00.000Z'),
    });

    expect(eq).toHaveBeenCalledWith('merchant_account_id', '00000000-0000-4000-8000-000000000002');
    expect(eq).toHaveBeenCalledWith('shop_id', '00000000-0000-4000-8000-000000000003');
  });

  it('turns an artifact outside the tenant or shop scope into a closed denial', async () => {
    const { admin } = fakeAdmin(null);

    await expect(
      createPrivateDsarSignedUrl(admin, {
        artifactId: '00000000-0000-4000-8000-000000000001',
        merchantAccountId: '00000000-0000-4000-8000-000000000002',
        shopId: '00000000-0000-4000-8000-000000000003',
      }),
    ).rejects.toThrow('dsar_artifact_not_found');
  });
});
