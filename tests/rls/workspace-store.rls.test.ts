import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'workspace-store-rls-test-pw';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;
type Client = SupabaseClient<Database>;

function adminClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(admin: Client, label: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email: `workspace-store-${label}-${Date.now()}@example.com`,
    email_confirm: true,
    password,
  });
  if (error || !data.user) throw error ?? new Error('user creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function merchantForUser(admin: Client, userId: string) {
  const { data, error } = await admin
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .single();
  if (error || !data) throw error ?? new Error('merchant member not found');
  return data.merchant_account_id;
}

async function signIn(email: string): Promise<Client> {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function emailFor(userId: string) {
  const { data, error } = await adminClient().auth.admin.getUserById(userId);
  if (error || !data.user?.email) throw error ?? new Error('email not found');
  return data.user.email;
}

async function createShop(admin: Client, merchantAccountId: string, suffix: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `workspace-${suffix}-${Date.now()}.internal`,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
  createdUserIds.length = 0;
});

describe('workspace store isolation', () => {
  skipIfNoServiceRole('restricts a member to assigned stores and tenants', async () => {
    const admin = adminClient();
    const userA = await createUser(admin, 'a');
    const merchantA = await merchantForUser(admin, userA);
    const shopA = await createShop(admin, merchantA, 'a');
    const shopB = await createShop(admin, merchantA, 'b');
    const userB = await createUser(admin, 'b');
    const merchantB = await merchantForUser(admin, userB);
    const emailB = await emailFor(userB);

    await admin.from('merchant_member').delete().eq('user_id', userB);
    const { error: memberError } = await admin.from('merchant_member').insert({
      merchant_account_id: merchantA,
      role: 'agent',
      user_id: userB,
    });
    if (memberError) throw memberError;
    const { error: removeStoreError } = await admin
      .from('shop_member')
      .delete()
      .eq('shop_id', shopB)
      .eq('user_id', userB);
    if (removeStoreError) throw removeStoreError;

    const { data: order, error: orderError } = await admin
      .from('orders')
      .insert({
        merchant_account_id: merchantA,
        shop_id: shopA,
        order_number: `workspace-${Date.now()}`,
        total_amount: 100,
        currency: 'XOF',
        cod_status: 'A_APPELER',
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      })
      .select('id')
      .single();
    if (orderError || !order) throw orderError ?? new Error('order insert failed');

    const clientB = await signIn(emailB);
    const { data: visibleOrders, error: visibleError } = await clientB
      .from('orders')
      .select('id')
      .eq('shop_id', shopA);
    if (visibleError) throw visibleError;
    expect(visibleOrders).toHaveLength(1);

    const { data: hiddenOrders, error: hiddenError } = await clientB
      .from('orders')
      .select('id')
      .eq('shop_id', shopB);
    if (hiddenError) throw hiddenError;
    expect(hiddenOrders).toHaveLength(0);

    const { data: hiddenStore } = await clientB.rpc('get_my_store', { p_shop_id: shopB });
    expect(hiddenStore).toEqual([]);

    const { error: crossStoreUpdate } = await clientB
      .from('orders')
      .update({ shop_id: shopB })
      .eq('id', order.id);
    expect(crossStoreUpdate).not.toBeNull();

    const { data: crossTenant } = await clientB
      .from('orders')
      .select('id')
      .eq('merchant_account_id', merchantB);
    expect(crossTenant).toEqual([]);
  });
});
