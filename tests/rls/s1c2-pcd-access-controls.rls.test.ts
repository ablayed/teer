import type { Database } from '@/lib/supabase/database.types';
import { nullableRpcArg } from '@/lib/supabase/rpc-args';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 's1c2-synthetic-test-password';
const createdUserIds: string[] = [];
const runIfConfigured = serviceRoleKey && supabaseUrl && anonKey ? it : it.skip;

type Client = SupabaseClient<Database>;

function serviceClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createSyntheticOwner() {
  const service = serviceClient();
  const email = `s1c2-owner-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  if (!data.user) throw new Error('synthetic owner creation failed');
  createdUserIds.push(data.user.id);

  const { data: account, error: accountError } = await service
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', data.user.id)
    .single();
  expect(accountError).toBeNull();
  if (!account) throw new Error('synthetic account creation failed');

  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  expect(signInError).toBeNull();
  return { accountId: account.id, client };
}

afterEach(async () => {
  if (createdUserIds.length > 0 && serviceRoleKey) {
    const service = serviceClient();
    await Promise.all(createdUserIds.map((userId) => service.auth.admin.deleteUser(userId)));
    createdUserIds.length = 0;
  }
});

describe('S1C-2 bounded quota and authorization RLS', () => {
  runIfConfigured(
    'refuses direct quota writes and enforces an atomic per-action limit',
    async () => {
      const owner = await createSyntheticOwner();
      const service = serviceClient();

      const { error: directInsertError } = await owner.client
        .from('pcd_access_quota_bucket')
        .insert({
          tenant_id: owner.accountId,
          actor_scope_key: 'user:synthetic',
          action: 'generate_export',
          window_start: new Date().toISOString(),
          // `count` est NOT NULL SANS default en base : il doit être fourni.
          count: 0,
        });
      expect(directInsertError).not.toBeNull();

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          owner.client.rpc('consume_pcd_access_quota', {
            p_action: 'generate_export',
            p_actor_kind: 'human',
            p_service_kind: nullableRpcArg<string>(null),
            p_shop_id: nullableRpcArg<string>(null),
            p_tenant_id: owner.accountId,
          }),
        ),
      );
      const errors = results.filter((result) => result.error);
      const rows = results.flatMap((result) => result.data ?? []);
      expect(errors).toHaveLength(0);
      expect(rows.filter((row) => row.allowed)).toHaveLength(5);
      expect(rows.filter((row) => !row.allowed)).toHaveLength(1);

      const { data: buckets, error: bucketError } = await service
        .from('pcd_access_quota_bucket')
        .select('tenant_id, shop_id, actor_scope_key, action, count')
        .eq('tenant_id', owner.accountId);
      expect(bucketError).toBeNull();
      expect(buckets).toHaveLength(1);
      expect(buckets?.[0]?.count).toBe(5);
      expect(JSON.stringify(buckets)).not.toMatch(/synthetic customer|phone|address|payload/i);
    },
  );

  runIfConfigured('rejects service identities and cross-tenant quota scopes', async () => {
    const owner = await createSyntheticOwner();
    const { data, error } = await owner.client.rpc('consume_pcd_access_quota', {
      p_action: 'search',
      p_actor_kind: 'service',
      p_service_kind: 'worker',
      p_shop_id: nullableRpcArg<string>(null),
      p_tenant_id: owner.accountId,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();

    const { data: crossTenantData, error: crossTenantError } = await owner.client.rpc(
      'consume_pcd_access_quota',
      {
        p_action: 'search',
        p_actor_kind: 'human',
        p_service_kind: nullableRpcArg<string>(null),
        p_shop_id: nullableRpcArg<string>(null),
        p_tenant_id: '00000000-0000-4000-8000-000000000099',
      },
    );
    expect(crossTenantData).toBeNull();
    expect(crossTenantError).not.toBeNull();
  });
});
