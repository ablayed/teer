import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'stock-rls-test-password';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type AdminClient = SupabaseClient<Database>;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('User creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: AdminClient, userId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account not found');
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password });
  return client;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `stock-rls-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(
  admin: AdminClient,
  merchantAccountId: string,
  role: 'agent' | 'manager' | 'owner',
) {
  const email = `stock-member-${role}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  return { email, userId };
}

async function createProduct(admin: AdminClient, merchantAccountId: string, unitCost = 5000) {
  const { data } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title: `Produit RLS ${Date.now()}`,
      unit_cost: unitCost,
    })
    .select('id')
    .single();
  if (!data) throw new Error('product insert returned no row');
  return data.id;
}

async function seedProductStock(
  admin: AdminClient,
  productId: string,
  merchantAccountId: string,
  { qtyOnHand = 50, unitCost = 5000 }: { qtyOnHand?: number; unitCost?: number } = {},
) {
  await admin.from('product_stock').upsert(
    {
      product_id: productId,
      merchant_account_id: merchantAccountId,
      qty_on_hand: qtyOnHand,
      unit_cost: unitCost,
    },
    { onConflict: 'product_id' },
  );
}

async function seedStockMovement(
  admin: AdminClient,
  productId: string,
  merchantAccountId: string,
  actorUserId: string,
) {
  const { data } = await admin
    .from('stock_movement')
    .insert({
      merchant_account_id: merchantAccountId,
      product_id: productId,
      movement_type: 'purchase_in',
      qty: 10,
      unit_cost: 5000,
      idempotency_key: `test-${Date.now()}-${crypto.randomUUID()}`,
      created_by: actorUserId,
    })
    .select('id')
    .single();
  if (!data) throw new Error('stock_movement insert returned no row');
  return data.id;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('stock_movement — immutabilité (RLS)', () => {
  skipIfNoServiceRole(
    'authenticated user cannot INSERT stock_movement (no table privilege)',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('sm-insert');
      const productId = await createProduct(admin, merchantAccountId);
      const userClient = await signIn(email);

      const { error } = await userClient.from('stock_movement').insert({
        merchant_account_id: merchantAccountId,
        product_id: productId,
        movement_type: 'manual_adjustment',
        qty: 1,
        reason: 'test insert',
        idempotency_key: `blocked-${Date.now()}`,
        created_by: userId,
      });

      // No INSERT privilege granted to authenticated → permission denied
      expect(error).not.toBeNull();
    },
  );

  skipIfNoServiceRole('authenticated user cannot UPDATE stock_movement', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('sm-update');
    const productId = await createProduct(admin, merchantAccountId);
    const movementId = await seedStockMovement(admin, productId, merchantAccountId, userId);
    const userClient = await signIn(email);

    const { error } = await userClient
      .from('stock_movement')
      .update({ qty: 999 })
      .eq('id', movementId);

    expect(error).not.toBeNull();
  });

  skipIfNoServiceRole('authenticated user cannot DELETE stock_movement', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('sm-delete');
    const productId = await createProduct(admin, merchantAccountId);
    const movementId = await seedStockMovement(admin, productId, merchantAccountId, userId);
    const userClient = await signIn(email);

    const { error } = await userClient.from('stock_movement').delete().eq('id', movementId);

    expect(error).not.toBeNull();
  });

  skipIfNoServiceRole(
    'tenant isolation: merchant A cannot read merchant B stock_movement',
    async () => {
      const ownerA = await createOwnerFixture('tenant-A-sm');
      const ownerB = await createOwnerFixture('tenant-B-sm');
      const productB = await createProduct(ownerB.admin, ownerB.merchantAccountId);
      await seedStockMovement(ownerB.admin, productB, ownerB.merchantAccountId, ownerB.userId);

      const clientA = await signIn(ownerA.email);
      const { data } = await clientA
        .from('stock_movement')
        .select('id')
        .eq('merchant_account_id', ownerB.merchantAccountId);

      expect(data).toHaveLength(0);
    },
  );
});

describe('product_stock — visibilité unit_cost (RLS colonne)', () => {
  skipIfNoServiceRole(
    'agent: selecting unit_cost errors (column revoked), other columns stay readable',
    async () => {
      const { admin, merchantAccountId } = await createOwnerFixture('cost-agent');
      const { email } = await addMember(admin, merchantAccountId, 'agent');
      const productId = await createProduct(admin, merchantAccountId);
      await seedProductStock(admin, productId, merchantAccountId, { unitCost: 9999 });

      const agentClient = await signIn(email);

      // unit_cost est révoqué de `authenticated` (grant colonne, migration 0028).
      // PostgREST n'omet/null-ifie pas la colonne : il erreure tout le SELECT
      // ("permission denied for column unit_cost") → data null.
      const { data, error } = await agentClient
        .from('product_stock')
        .select('qty_on_hand, unit_cost')
        .eq('product_id', productId)
        .maybeSingle();
      expect(error).not.toBeNull();
      expect(data).toBeNull();

      // Les colonnes accordées restent lisibles par l'agent.
      const { data: granted, error: grantedError } = await agentClient
        .from('product_stock')
        .select('qty_on_hand, qty_reserved')
        .eq('product_id', productId)
        .maybeSingle();
      expect(grantedError).toBeNull();
      expect(granted?.qty_on_hand).toBe(50);
    },
  );

  skipIfNoServiceRole('manager can read unit_cost via admin client', async () => {
    const { admin, merchantAccountId } = await createOwnerFixture('cost-manager');
    const productId = await createProduct(admin, merchantAccountId);
    await seedProductStock(admin, productId, merchantAccountId, { unitCost: 7500 });

    // Admin/service-role bypasses column restrictions
    const { data } = await admin
      .from('product_stock')
      .select('unit_cost')
      .eq('product_id', productId)
      .maybeSingle();

    expect(data?.unit_cost).toBe(7500);
  });

  skipIfNoServiceRole(
    'tenant isolation: merchant A cannot read merchant B product_stock',
    async () => {
      const ownerA = await createOwnerFixture('tenant-A-ps');
      const ownerB = await createOwnerFixture('tenant-B-ps');
      const productB = await createProduct(ownerB.admin, ownerB.merchantAccountId);
      await seedProductStock(ownerB.admin, productB, ownerB.merchantAccountId);

      const clientA = await signIn(ownerA.email);
      const { data } = await clientA
        .from('product_stock')
        .select('qty_on_hand')
        .eq('merchant_account_id', ownerB.merchantAccountId);

      expect(data).toHaveLength(0);
    },
  );
});

describe('order_line — isolation tenant', () => {
  skipIfNoServiceRole('merchant A cannot read merchant B order_line', async () => {
    const ownerA = await createOwnerFixture('tenant-A-ol');
    const ownerB = await createOwnerFixture('tenant-B-ol');

    // Create a bare order + order_line for merchant B via admin
    const { data: order } = await ownerB.admin
      .from('orders')
      .insert({
        merchant_account_id: ownerB.merchantAccountId,
        order_number: `TEST-OL-${Date.now()}`,
        total_amount: 1000,
        currency: 'XOF',
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      })
      .select('id')
      .single();

    await ownerB.admin.from('order_line').insert({
      merchant_account_id: ownerB.merchantAccountId,
      order_id: order?.id ?? '',
      raw_title: 'Produit secret',
      qty: 1,
      match_status: 'unresolved',
    });

    const clientA = await signIn(ownerA.email);
    const { data } = await clientA
      .from('order_line')
      .select('id')
      .eq('merchant_account_id', ownerB.merchantAccountId);

    expect(data).toHaveLength(0);
  });
});
