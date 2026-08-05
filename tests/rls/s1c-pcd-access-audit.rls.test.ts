import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 's1c-audit-test-password';
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
  const email = `s1c-owner-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
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

async function addMember(accountId: string, role: 'manager' | 'agent', label: string) {
  const service = serviceClient();
  const email = `s1c-${role}-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  if (!data.user) throw new Error('synthetic member creation failed');
  createdUserIds.push(data.user.id);

  await service.from('merchant_account').delete().eq('owner_user_id', data.user.id);
  const { error: memberError } = await service.from('merchant_member').insert({
    merchant_account_id: accountId,
    user_id: data.user.id,
    role,
  });
  expect(memberError).toBeNull();

  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  expect(signInError).toBeNull();
  return client;
}

afterEach(async () => {
  if (createdUserIds.length > 0 && serviceRoleKey) {
    const service = serviceClient();
    await Promise.all(createdUserIds.map((userId) => service.auth.admin.deleteUser(userId)));
    createdUserIds.length = 0;
  }
});

describe('S1C-1 PCD access audit RLS', () => {
  runIfConfigured('owner-only tenant read and client write denial', async () => {
    const ownerA = await createOwner('a');
    const ownerB = await createOwner('b');
    const service = serviceClient();
    const manager = await addMember(ownerA.accountId, 'manager', 'a');
    const agent = await addMember(ownerA.accountId, 'agent', 'a');

    const { data: inserted, error: insertError } = await service
      .from('pcd_access_audit')
      .insert({
        tenant_id: ownerA.accountId,
        actor_kind: 'service',
        service_kind: 'worker',
        action: 'view_detail',
        data_category: 'customer_identity',
        purpose: 'order_fulfillment',
        outcome: 'succeeded',
        resource_type: 'order',
        surface: 'server_action',
        metadata: { source: 'rls_test' },
      })
      .select('id')
      .single();
    expect(insertError).toBeNull();
    if (!inserted) throw new Error('synthetic audit row missing');

    const { data: ownRows, error: ownError } = await ownerA.client
      .from('pcd_access_audit')
      .select('id, tenant_id, actor_user_id, metadata')
      .eq('id', inserted.id);
    expect(ownError).toBeNull();
    expect(ownRows).toHaveLength(1);

    const { data: crossTenantRows, error: crossTenantError } = await ownerB.client
      .from('pcd_access_audit')
      .select('id')
      .eq('id', inserted.id);
    expect(crossTenantError).toBeNull();
    expect(crossTenantRows).toEqual([]);

    const { data: managerRows, error: managerError } = await manager
      .from('pcd_access_audit')
      .select('id')
      .eq('id', inserted.id);
    expect(managerError).toBeNull();
    expect(managerRows).toEqual([]);

    const { data: agentRows, error: agentError } = await agent
      .from('pcd_access_audit')
      .select('id')
      .eq('id', inserted.id);
    expect(agentError).toBeNull();
    expect(agentRows).toEqual([]);

    const { error: directInsertError } = await ownerA.client.from('pcd_access_audit').insert({
      tenant_id: ownerA.accountId,
      actor_kind: 'human',
      action: 'view_detail',
      data_category: 'customer_identity',
      purpose: 'order_fulfillment',
      outcome: 'succeeded',
      resource_type: 'order',
      surface: 'server_action',
      metadata: {},
    });
    expect(directInsertError).not.toBeNull();
  });

  runIfConfigured('human actor derivation and append-only mutation denial', async () => {
    const owner = await createOwner('human');
    const service = serviceClient();

    const { data: eventId, error: rpcError } = await owner.client.rpc('log_pcd_access_event', {
      p_tenant_id: owner.accountId,
      p_shop_id: undefined,
      p_actor_kind: 'human',
      p_service_kind: undefined,
      p_action: 'search',
      p_data_category: 'customer_contact',
      p_purpose: 'customer_support',
      p_outcome: 'succeeded',
      p_resource_type: 'customer',
      p_resource_id: undefined,
      p_surface: 'server_action',
      p_metadata: { source: 'rls_test' },
    });
    expect(rpcError).toBeNull();
    expect(eventId).toBeTruthy();

    const { data: row, error: rowError } = await service
      .from('pcd_access_audit')
      .select('actor_user_id, actor_kind, service_kind, occurred_at, metadata')
      .eq('id', eventId as string)
      .single();
    expect(rowError).toBeNull();
    expect(row?.actor_user_id).toBe(owner.userId);
    expect(row?.actor_kind).toBe('human');
    expect(row?.service_kind).toBeNull();
    expect(row?.occurred_at).toBeTruthy();

    const { error: updateError } = await service
      .from('pcd_access_audit')
      .update({ outcome: 'failed' })
      .eq('id', eventId as string);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await service
      .from('pcd_access_audit')
      .delete()
      .eq('id', eventId as string);
    expect(deleteError).not.toBeNull();
  });

  runIfConfigured('rejects invalid metadata and a shop outside tenant scope', async () => {
    const owner = await createOwner('scope');
    const service = serviceClient();

    const { error: metadataError } = await service.from('pcd_access_audit').insert({
      tenant_id: owner.accountId,
      actor_kind: 'service',
      service_kind: 'worker',
      action: 'view_detail',
      data_category: 'customer_identity',
      purpose: 'order_fulfillment',
      outcome: 'succeeded',
      resource_type: 'order',
      surface: 'server_action',
      metadata: { query: 'synthetic' },
    });
    expect(metadataError).not.toBeNull();

    const { error: shopError } = await owner.client.rpc('log_pcd_access_event', {
      p_tenant_id: owner.accountId,
      p_shop_id: '00000000-0000-4000-8000-000000000099',
      p_actor_kind: 'human',
      p_service_kind: undefined,
      p_action: 'generate_signed_url',
      p_data_category: 'dsar_artifact',
      p_purpose: 'legal_request',
      p_outcome: 'denied',
      p_resource_type: 'dsar_artifact',
      p_resource_id: undefined,
      p_surface: 'dsar',
      p_metadata: { reason_code: 'artifact_unavailable' },
    });
    expect(shopError).not.toBeNull();
  });
});
