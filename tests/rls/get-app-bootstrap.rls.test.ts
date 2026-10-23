import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { assertLocalSupabase } from '@/tests/e2e/helpers/assert-local-supabase';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';
import { leaveSignupAccount } from '../helpers/membership-fixtures';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'v12b-bootstrap-rls-test-pw';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;
type Client = SupabaseClient<Database>;

type StoreRow = {
  id: string;
  merchant_account_id: string;
  display_name: string;
  shop_domain: string;
  store_kind: 'manual' | 'shopify';
  status: string;
  is_default: boolean;
  role: 'owner' | 'manager' | 'agent';
};

type Bootstrap = {
  stores: StoreRow[];
  member: { merchant_account_id: string; role: 'owner' | 'manager' | 'agent' } | null;
  account: { id: string; onboarded_at: string | null } | null;
};

type GenericRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function adminClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function rpcOf(client: Client) {
  return client.rpc.bind(client) as unknown as GenericRpc;
}

async function createUser(admin: Client, label: string) {
  const email = `v12b-bootstrap-${label}-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  if (error || !data.user) throw error ?? new Error('user creation failed');
  createdUserIds.push(data.user.id);
  return { email, userId: data.user.id };
}

async function waitForAccount(admin: Client, userId: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { data, error } = await admin
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.merchant_account_id) return data.merchant_account_id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('merchant member was not created');
}

async function waitForDefaultShop(admin: Client, merchantAccountId: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { data, error } = await admin
      .from('shop')
      .select('id')
      .eq('merchant_account_id', merchantAccountId)
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.id) return data.id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('default shop was not created');
}

async function createOwnerFixture(admin: Client, label: string) {
  const { email, userId } = await createUser(admin, label);
  const merchantAccountId = await waitForAccount(admin, userId);
  const shopId = await waitForDefaultShop(admin, merchantAccountId);
  return { email, merchantAccountId, shopId, userId };
}

async function createShop(admin: Client, merchantAccountId: string, label: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `v12b-${label}-${randomUUID()}.internal`,
      access_token_encrypted: 'test-encrypted-token',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('secondary shop creation failed');
  return data.id;
}

async function signIn(email: string): Promise<Client> {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function legacyBootstrap(client: Client): Promise<Bootstrap> {
  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();
  if (userError || !user) throw userError ?? new Error('signed-in user not found');

  const admin = adminClient();
  const [{ data: stores, error: storesError }, { data: member, error: memberError }] =
    await Promise.all([
      rpcOf(client)('list_my_stores', {}),
      admin
        .from('merchant_member')
        .select('merchant_account_id, role')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle(),
    ]);
  if (storesError) throw storesError;
  if (memberError) throw memberError;

  let account: Bootstrap['account'] = null;
  if (member) {
    const { data, error } = await admin
      .from('merchant_account')
      .select('id, onboarded_at')
      .eq('id', member.merchant_account_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw error;
    account = data;
  }

  return {
    stores: (stores ?? []) as StoreRow[],
    member: member as Bootstrap['member'],
    account,
  };
}

async function expectEquivalent(client: Client): Promise<Bootstrap> {
  const expected = await legacyBootstrap(client);
  const { data, error } = await rpcOf(client)('get_app_bootstrap', {});
  expect(error).toBeNull();
  expect(data).toEqual(expected);
  return data as Bootstrap;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
  createdUserIds.length = 0;
});

describe('V12b — get_app_bootstrap() équivaut aux lectures actuelles sous RLS', () => {
  skipIfNoServiceRole(
    'isole les comptes A/B, boutiques interdites et membres restreints',
    async () => {
      assertLocalSupabase(supabaseUrl);
      const admin = adminClient();
      const ownerA = await createOwnerFixture(admin, 'owner-a');
      const shopA2 = await createShop(admin, ownerA.merchantAccountId, 'a-secondary');
      const ownerAClient = await signIn(ownerA.email);
      const bootstrapA = await expectEquivalent(ownerAClient);
      expect(bootstrapA.stores.map((store) => store.id)).toContain(ownerA.shopId);
      expect(bootstrapA.stores.map((store) => store.id)).toContain(shopA2);

      const ownerB = await createOwnerFixture(admin, 'owner-b');
      const ownerBClient = await signIn(ownerB.email);
      const bootstrapB = await expectEquivalent(ownerBClient);
      expect(bootstrapB.stores.map((store) => store.id)).toContain(ownerB.shopId);
      expect(bootstrapB.stores.map((store) => store.id)).not.toContain(ownerA.shopId);
      expect(bootstrapB.stores.map((store) => store.id)).not.toContain(shopA2);

      const agent = await createUser(admin, 'restricted-agent');
      await leaveSignupAccount(admin, agent.userId);
      const { error: memberError } = await admin.from('merchant_member').insert({
        merchant_account_id: ownerA.merchantAccountId,
        user_id: agent.userId,
        role: 'agent',
      });
      if (memberError) throw memberError;
      // The merchant_member trigger seeds every account shop. Keep only the
      // intended membership so this fixture exercises a genuinely restricted agent.
      const { error: restrictStoreError } = await admin
        .from('shop_member')
        .delete()
        .eq('user_id', agent.userId)
        .neq('shop_id', ownerA.shopId);
      if (restrictStoreError) throw restrictStoreError;

      const agentClient = await signIn(agent.email);
      const agentBootstrap = await expectEquivalent(agentClient);
      expect(agentBootstrap.member).toMatchObject({ role: 'agent' });
      expect(agentBootstrap.stores.map((store) => store.id)).toEqual([ownerA.shopId]);
      const { data: forbiddenStore, error: forbiddenError } = await rpcOf(agentClient)(
        'get_my_store',
        { p_shop_id: shopA2 },
      );
      expect(forbiddenError).toBeNull();
      expect(forbiddenStore).toEqual([]);

      const emptyOwner = await createOwnerFixture(admin, 'empty-workspace');
      const { error: revokeAllStoresError } = await admin
        .from('shop_member')
        .delete()
        .eq('user_id', emptyOwner.userId);
      if (revokeAllStoresError) throw revokeAllStoresError;
      const emptyClient = await signIn(emptyOwner.email);
      const emptyBootstrap = await expectEquivalent(emptyClient);
      expect(emptyBootstrap.stores).toEqual([]);
      expect(emptyBootstrap.member).not.toBeNull();
      expect(emptyBootstrap.account).not.toBeNull();
    },
  );
});
