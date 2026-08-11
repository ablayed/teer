import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 's1c3-dsar-synthetic-password';
const runIfConfigured = serviceRoleKey && supabaseUrl && anonKey ? it : it.skip;

type Client = SupabaseClient<Database>;

const createdUserIds: string[] = [];

function serviceClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function anonymousClient(): Client {
  return createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createOwner(label: string) {
  const service = serviceClient();
  const email = `s1c3-owner-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
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

  const client = anonymousClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  expect(signInError).toBeNull();
  return { accountId: account.id, client, userId: data.user.id };
}

async function createMember(accountId: string, role: 'manager' | 'agent', label: string) {
  const service = serviceClient();
  const email = `s1c3-${role}-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
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

  const client = anonymousClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  expect(signInError).toBeNull();
  return { client, userId: data.user.id };
}

async function createShop(tenantId: string, label: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from('shop')
    .insert({
      merchant_account_id: tenantId,
      shop_domain: `s1c3-${label}-${crypto.randomUUID()}.myshopify.com`,
      access_token_encrypted: 'synthetic-encrypted-token',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('synthetic shop creation failed');
  return data.id;
}

async function createReadyArtifact(tenantId: string, shopId: string, label: string) {
  const service = serviceClient();
  const webhookEventId = crypto.randomUUID();
  const { error: webhookError } = await service.from('webhook_event').insert({
    shopify_webhook_id: `s1c3-${label}-${crypto.randomUUID()}`,
    topic: 'customers/data_request',
    merchant_account_id: tenantId,
    shop_id: shopId,
    processed: true,
    status: 'done',
  });
  expect(webhookError).toBeNull();

  const { data: webhook, error: webhookLookupError } = await service
    .from('webhook_event')
    .select('id')
    .eq('shop_id', shopId)
    .order('received_at', { ascending: false })
    .limit(1)
    .single();
  expect(webhookLookupError).toBeNull();
  if (!webhook) throw new Error('synthetic webhook creation failed');

  const { data: artifact, error: artifactError } = await service
    .from('shopify_dsar_artifact')
    .insert({
      webhook_event_id: webhook.id ?? webhookEventId,
      merchant_account_id: tenantId,
      shop_id: shopId,
      storage_bucket: 'shopify-dsar',
      storage_path: `synthetic/${tenantId}/${crypto.randomUUID()}.json`,
      status: 'ready',
      byte_size: 128,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      completed_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  expect(artifactError).toBeNull();
  if (!artifact) throw new Error('synthetic DSAR artifact creation failed');
  return artifact.id;
}

async function issue(client: Client, tenantId: string, shopId: string, artifactId: string) {
  const { data, error } = await client.rpc('issue_shopify_dsar_download_authorization', {
    p_tenant_id: tenantId,
    p_shop_id: shopId,
    p_artifact_id: artifactId,
  });
  expect(error).toBeNull();
  const row = data?.[0];
  expect(row).toBeTruthy();
  if (!row) throw new Error('synthetic DSAR authorization missing');
  expect(row.download_token).toMatch(/^[0-9a-f]{64}$/);
  return row.download_token;
}

async function consume(
  client: Client,
  token: string,
  tenantId: string,
  shopId: string,
  artifactId: string,
) {
  return client.rpc('consume_shopify_dsar_download_authorization', {
    p_download_token: token,
    p_tenant_id: tenantId,
    p_shop_id: shopId,
    p_artifact_id: artifactId,
  });
}

afterEach(async () => {
  if (createdUserIds.length > 0 && serviceRoleKey) {
    const service = serviceClient();
    await Promise.all(createdUserIds.map((userId) => service.auth.admin.deleteUser(userId)));
    createdUserIds.length = 0;
  }
});

describe('S1C-3 DSAR one-shot dynamic RLS proof', () => {
  runIfConfigured('stores only a hash and consumes exactly once', async () => {
    const owner = await createOwner('hash');
    const shopId = await createShop(owner.accountId, 'hash');
    const artifactId = await createReadyArtifact(owner.accountId, shopId, 'hash');
    const token = await issue(owner.client, owner.accountId, shopId, artifactId);

    const { data: authorizations, error: authorizationError } = await serviceClient()
      .from('shopify_dsar_download_authorization')
      .select('token_hash, tenant_id, shop_id, actor_user_id, artifact_id, purpose, consumed_at')
      .eq('artifact_id', artifactId);
    expect(authorizationError).toBeNull();
    expect(authorizations).toHaveLength(1);
    const authorization = authorizations?.[0];
    expect(authorization?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(authorization?.token_hash).not.toBe(token);
    expect(authorization?.actor_user_id).toBe(owner.userId);
    expect(authorization?.tenant_id).toBe(owner.accountId);
    expect(authorization?.shop_id).toBe(shopId);
    expect(authorization?.artifact_id).toBe(artifactId);
    expect(authorization?.purpose).toBe('legal_request');
    expect(authorization?.consumed_at).toBeNull();

    const { error: alternatePurposeError } = await serviceClient()
      .from('shopify_dsar_download_authorization')
      .insert({
        token_hash: '0'.repeat(64),
        tenant_id: owner.accountId,
        shop_id: shopId,
        actor_user_id: owner.userId,
        artifact_id: artifactId,
        purpose: 'customer_support',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    expect(alternatePurposeError).not.toBeNull();

    const first = await consume(owner.client, token, owner.accountId, shopId, artifactId);
    expect(first.error).toBeNull();
    expect(first.data).toHaveLength(1);

    const second = await consume(owner.client, token, owner.accountId, shopId, artifactId);
    expect(second.data).toBeNull();
    expect(second.error).not.toBeNull();
  });

  runIfConfigured('isolates actor, tenant, shop and artifact scope', async () => {
    const ownerA = await createOwner('scope-a');
    const ownerB = await createOwner('scope-b');
    const managerA = await createMember(ownerA.accountId, 'manager', 'scope-a');
    const shopA = await createShop(ownerA.accountId, 'scope-a');
    const shopA2 = await createShop(ownerA.accountId, 'scope-a-2');
    const shopB = await createShop(ownerB.accountId, 'scope-b');
    const artifactA = await createReadyArtifact(ownerA.accountId, shopA, 'scope-a');
    const artifactA2 = await createReadyArtifact(ownerA.accountId, shopA2, 'scope-a-2');
    const artifactB = await createReadyArtifact(ownerB.accountId, shopB, 'scope-b');
    const token = await issue(ownerA.client, ownerA.accountId, shopA, artifactA);

    const actorMismatch = await consume(managerA.client, token, ownerA.accountId, shopA, artifactA);
    expect(actorMismatch.error).not.toBeNull();
    const shopMismatch = await consume(ownerA.client, token, ownerA.accountId, shopA2, artifactA);
    expect(shopMismatch.error).not.toBeNull();
    const artifactMismatch = await consume(
      ownerA.client,
      token,
      ownerA.accountId,
      shopA,
      artifactA2,
    );
    expect(artifactMismatch.error).not.toBeNull();
    const tenantMismatch = await consume(ownerB.client, token, ownerB.accountId, shopB, artifactB);
    expect(tenantMismatch.error).not.toBeNull();

    const correct = await consume(ownerA.client, token, ownerA.accountId, shopA, artifactA);
    expect(correct.error).toBeNull();
    expect(correct.data).toHaveLength(1);
  });

  runIfConfigured('allows only one concurrent consumption and refuses expiration', async () => {
    const owner = await createOwner('concurrency');
    const shopId = await createShop(owner.accountId, 'concurrency');
    const artifactId = await createReadyArtifact(owner.accountId, shopId, 'concurrency');
    const token = await issue(owner.client, owner.accountId, shopId, artifactId);
    const clientA = anonymousClient();
    const clientB = anonymousClient();
    const { data: user } = await serviceClient().auth.admin.getUserById(owner.userId);
    expect(user.user).toBeTruthy();

    const { data: userData } = await serviceClient().auth.admin.getUserById(owner.userId);
    if (!userData.user?.email) throw new Error('synthetic user email missing');
    await Promise.all([
      clientA.auth.signInWithPassword({ email: userData.user.email, password }),
      clientB.auth.signInWithPassword({ email: userData.user.email, password }),
    ]);
    const concurrent = await Promise.all([
      consume(clientA, token, owner.accountId, shopId, artifactId),
      consume(clientB, token, owner.accountId, shopId, artifactId),
    ]);
    expect(concurrent.filter((result) => !result.error && result.data?.length === 1)).toHaveLength(
      1,
    );
    expect(concurrent.filter((result) => result.error)).toHaveLength(1);

    const expiredArtifactId = await createReadyArtifact(owner.accountId, shopId, 'expired');
    const expiredToken = await issue(owner.client, owner.accountId, shopId, expiredArtifactId);
    const { data: expiredRows, error: expiredLookupError } = await serviceClient()
      .from('shopify_dsar_download_authorization')
      .select('id')
      .eq('artifact_id', expiredArtifactId)
      .limit(1);
    expect(expiredLookupError).toBeNull();
    const expiredAuthorizationId = expiredRows?.[0]?.id;
    expect(expiredAuthorizationId).toBeTruthy();
    await serviceClient()
      .from('shopify_dsar_download_authorization')
      .update({ expires_at: new Date(Date.now() - 1_000).toISOString() })
      .eq('id', expiredAuthorizationId as string);
    const expired = await consume(
      owner.client,
      expiredToken,
      owner.accountId,
      shopId,
      expiredArtifactId,
    );
    expect(expired.data).toBeNull();
    expect(expired.error).not.toBeNull();
  });

  runIfConfigured('keeps cleanup service-only and bounded', async () => {
    const owner = await createOwner('cleanup');
    const clientResult = await owner.client.rpc('purge_pcd_access_controls', {
      p_before: new Date().toISOString(),
      p_batch_size: 1,
    });
    expect(clientResult.data).toBeNull();
    expect(clientResult.error).not.toBeNull();

    const serviceResult = await serviceClient().rpc('purge_pcd_access_controls', {
      p_before: new Date().toISOString(),
      p_batch_size: 1,
    });
    expect(serviceResult.error).toBeNull();
    expect(serviceResult.data).toHaveLength(1);
    expect(serviceResult.data?.[0]).toEqual(
      expect.objectContaining({
        quota_rows: expect.any(Number),
        authorization_rows: expect.any(Number),
      }),
    );
  });
});
