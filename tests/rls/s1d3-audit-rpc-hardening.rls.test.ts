import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 's1d3-rpc-test-password';
const createdUserIds: string[] = [];
const runIfConfigured = serviceRoleKey && supabaseUrl && anonKey ? it : it.skip;

type Client = SupabaseClient<Database>;

function serviceClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createOwner(label: string) {
  const service = serviceClient();
  const email = `s1d3-rpc-owner-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  if (!data.user) throw new Error('synthetic user creation failed');
  createdUserIds.push(data.user.id);

  const { data: account, error: accountError } = await service
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', data.user.id)
    .single();
  expect(accountError).toBeNull();
  if (!account) throw new Error('synthetic merchant creation failed');

  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  expect(signInError).toBeNull();
  return { accountId: account.id, client, userId: data.user.id };
}

function validArgs(tenantId: string, idempotencyKey: string) {
  return {
    p_tenant_id: tenantId,
    p_shop_id: null,
    p_actor_kind: 'human',
    p_service_kind: null,
    p_action: 'view_detail',
    p_data_category: 'customer_identity',
    p_purpose: 'order_fulfillment',
    p_outcome: 'succeeded',
    p_resource_type: 'customer',
    p_resource_id: null,
    p_surface: 'server_action',
    p_metadata: { source: 's1d3_rpc' },
    p_idempotency_key: idempotencyKey,
  };
}

afterEach(async () => {
  if (createdUserIds.length > 0 && serviceRoleKey) {
    const service = serviceClient();
    await Promise.all(createdUserIds.map((userId) => service.auth.admin.deleteUser(userId)));
    createdUserIds.length = 0;
  }
});

describe('S1D-3R direct log_pcd_access_event RPC boundary', () => {
  runIfConfigured('accepts a legitimate human event and derives the actor', async () => {
    const owner = await createOwner('legitimate');
    const service = serviceClient();
    const { data: eventId, error } = await owner.client.rpc(
      'log_pcd_access_event',
      validArgs(owner.accountId, `s1d3-legitimate-${crypto.randomUUID()}`),
    );

    expect(error).toBeNull();
    expect(eventId).toEqual(expect.any(String));

    const { data: row, error: rowError } = await service
      .from('pcd_access_audit')
      .select('actor_user_id, actor_kind, service_kind, metadata')
      .eq('id', eventId as string)
      .single();
    expect(rowError).toBeNull();
    expect(row).toEqual({
      actor_user_id: owner.userId,
      actor_kind: 'human',
      service_kind: null,
      metadata: { source: 's1d3_rpc' },
    });
  });

  runIfConfigured(
    'rejects unbounded direct arguments without creating rows or echoing them',
    async () => {
      const owner = await createOwner('invalid');
      const service = serviceClient();
      const sentinel = 'S1D3_SYNTHETIC_NO_ECHO';
      const cases = [
        ['unknown action', { p_action: 'unknown_action' }],
        ['unknown actor', { p_actor_kind: 'unknown_actor' }],
        ['unknown category', { p_data_category: 'unknown_category' }],
        ['unknown outcome', { p_outcome: 'unknown_outcome' }],
        ['unknown surface', { p_surface: 'unknown_surface' }],
        ['free purpose', { p_purpose: 'free purpose' }],
        ['long idempotency key', { p_idempotency_key: 'x'.repeat(97) }],
        ['malformed idempotency key', { p_idempotency_key: 'not allowed' }],
        ['unknown metadata key', { p_metadata: { unknown_key: sentinel } }],
        ['nested metadata', { p_metadata: { source: { nested: true } } }],
        ['array metadata', { p_metadata: { source: [sentinel] } }],
        ['email-like metadata', { p_metadata: { source: 'synthetic@example.invalid' } }],
        ['phone-like metadata', { p_metadata: { source: '+221770000000' } }],
        ['address-like metadata', { p_metadata: { source: '12 rue synthetic' } }],
        ['token key', { p_metadata: { token: sentinel } }],
        ['header key', { p_metadata: { authorization: sentinel } }],
        ['token-like value', { p_metadata: { source: 'Bearer synthetic-token' } }],
        ['header-like value', { p_metadata: { source: 'Authorization:synthetic' } }],
        ['control character', { p_metadata: { source: 'synthetic\u0000control' } }],
        ['null metadata value', { p_metadata: { source: null } }],
        ['missing required action', { p_action: null }],
        [
          'service actor from authenticated session',
          { p_actor_kind: 'service', p_service_kind: 'worker' },
        ],
        ['missing service kind', { p_actor_kind: 'service', p_service_kind: null }],
      ] as const;

      for (const [label, overrides] of cases) {
        const idempotencyKey = `s1d3-invalid-${label.replaceAll(' ', '_')}-${crypto.randomUUID()}`;
        const { p_idempotency_key: _ignored, ...baseWithoutKey } = validArgs(
          owner.accountId,
          idempotencyKey,
        );
        const callIdempotencyKey =
          'p_idempotency_key' in overrides && overrides.p_idempotency_key !== undefined
            ? overrides.p_idempotency_key
            : idempotencyKey;
        const rpcArgs = {
          ...baseWithoutKey,
          ...overrides,
          p_idempotency_key: callIdempotencyKey,
        } as unknown as Database['public']['Functions']['log_pcd_access_event']['Args'];
        const { error } = await owner.client.rpc('log_pcd_access_event', rpcArgs);

        expect(error, label).not.toBeNull();
        if (label !== 'control character') {
          expect(error?.message, label).toMatch(/^pcd_access_audit_[a-z_]+$/);
        }
        expect(error?.message, label).not.toContain(sentinel);

        const { data: rows, error: queryError } = await service
          .from('pcd_access_audit')
          .select('id')
          .eq('idempotency_key', idempotencyKey);
        expect(queryError, label).toBeNull();
        expect(rows, label).toEqual([]);
      }
    },
  );

  runIfConfigured('rejects forged tenants, anon callers, and direct audit mutation', async () => {
    const ownerA = await createOwner('tenant-a');
    const ownerB = await createOwner('tenant-b');
    const service = serviceClient();
    const forgedTenant = await ownerA.client.rpc('log_pcd_access_event', {
      ...validArgs(ownerB.accountId, `s1d3-forged-${crypto.randomUUID()}`),
    });
    expect(forgedTenant.error).not.toBeNull();
    expect(forgedTenant.error?.message).toBe('pcd_access_audit_tenant_forbidden');

    const anonymous = createClient<Database>(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const anonymousCall = await anonymous.rpc(
      'log_pcd_access_event',
      validArgs(ownerA.accountId, `s1d3-anon-${crypto.randomUUID()}`),
    );
    expect(anonymousCall.error).not.toBeNull();
    expect(anonymousCall.error?.message).not.toContain(ownerA.accountId);

    const { data: eventId, error: eventError } = await ownerA.client.rpc(
      'log_pcd_access_event',
      validArgs(ownerA.accountId, `s1d3-immutable-${crypto.randomUUID()}`),
    );
    expect(eventError).toBeNull();
    expect(eventId).toEqual(expect.any(String));

    const { error: updateError } = await ownerA.client
      .from('pcd_access_audit')
      .update({ outcome: 'failed' })
      .eq('id', eventId as string);
    const { error: deleteError } = await ownerA.client
      .from('pcd_access_audit')
      .delete()
      .eq('id', eventId as string);
    expect(updateError).not.toBeNull();
    expect(deleteError).not.toBeNull();

    const { data: retained, error: retainedError } = await service
      .from('pcd_access_audit')
      .select('id, outcome')
      .eq('id', eventId as string)
      .single();
    expect(retainedError).toBeNull();
    expect(retained).toEqual({ id: eventId, outcome: 'succeeded' });
  });
});
