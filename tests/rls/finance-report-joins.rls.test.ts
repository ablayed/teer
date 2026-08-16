import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// Lot 5 (migration 0087) — get_finance_collected_joins / get_finance_returned_joins
// remplacent les selects `orders` fenêtrés (cash_collected_at / returned_at) sans `.range()`
// + `.in('order_id', orderIds)` sur stock_movement/order_line (lib/finance/report-data.ts,
// product-cost.ts, driver-cost.ts). Contrat DIFFÉRENT des Lots 3/3b/4 : `security invoker`,
// AUCUNE garde de rôle applicative, grant execute à `service_role` UNIQUEMENT (ni
// `authenticated` ni `anon`) — ces RPC ne sont appelables que par le client service-role déjà
// utilisé par ces 3 fichiers (createFinanceAdminClient), jamais par une session utilisateur.
// Le contrôle owner/manager reste en amont, dans les server actions/routes appelantes.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'finance-report-joins-rls-pw';
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
  throw new Error('merchant_account not found after 20 retries');
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
  const email = `finance-report-joins-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function createShop(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `frj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.myshopify.com`,
      access_token_encrypted: 'test-token',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id;
}

async function createProduct(admin: AdminClient, merchantAccountId: string, title: string) {
  const { data, error } = await admin
    .from('product')
    .insert({ merchant_account_id: merchantAccountId, title, unit_cost: 0 })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id;
}

type SeedOrder = {
  cashCollectedAt?: string | null;
  returnedAt?: string | null;
  shopId?: string | null;
  totalAmount: number;
};

async function insertOrder(admin: AdminClient, merchantAccountId: string, order: SeedOrder) {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `FRJ-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: order.totalAmount,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
      ...(order.shopId ? { shop_id: order.shopId } : {}),
      cash_collected_at: order.cashCollectedAt ?? null,
      returned_at: order.returnedAt ?? null,
      created_at_shopify: now,
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data.id;
}

async function insertStockMovement(
  admin: AdminClient,
  merchantAccountId: string,
  ownerUserId: string,
  opts: {
    driverId?: string | null;
    movementType: 'sold' | 'courier_return';
    orderId: string;
    productId: string;
    qty: number;
    unitCost?: number | null;
  },
) {
  const { error } = await admin.from('stock_movement').insert({
    merchant_account_id: merchantAccountId,
    product_id: opts.productId,
    movement_type: opts.movementType,
    qty: opts.qty,
    unit_cost: opts.unitCost ?? null,
    order_id: opts.orderId,
    driver_id: opts.driverId ?? null,
    idempotency_key: `frj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    created_by: ownerUserId,
  });
  if (error) throw error;
}

async function insertOrderLine(
  admin: AdminClient,
  merchantAccountId: string,
  opts: { orderId: string; productId: string; qty: number; rawTitle: string },
) {
  const { error } = await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    order_id: opts.orderId,
    product_id: opts.productId,
    raw_title: opts.rawTitle,
    qty: opts.qty,
    match_status: 'matched',
  });
  if (error) throw error;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('get_finance_collected_joins (Lot 5, 0087)', () => {
  skipIfNoServiceRole(
    'fenêtre cash_collected_at inclusive, jointures sold+orderLines exactes',
    async () => {
      const { admin, merchantAccountId, userId } = await createOwnerFixture('collected-window');
      const productId = await createProduct(admin, merchantAccountId, 'Robe Wax');
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() - 5 * 86_400_000);

      const inWindowOrderId = await insertOrder(admin, merchantAccountId, {
        cashCollectedAt: from.toISOString(),
        totalAmount: 5000,
      });
      await insertStockMovement(admin, merchantAccountId, userId, {
        movementType: 'sold',
        orderId: inWindowOrderId,
        productId,
        qty: 2,
        unitCost: 1000,
      });
      await insertOrderLine(admin, merchantAccountId, {
        orderId: inWindowOrderId,
        productId,
        qty: 2,
        rawTitle: 'Robe Wax',
      });

      const outsideOrderId = await insertOrder(admin, merchantAccountId, {
        cashCollectedAt: new Date(Date.now() - 1 * 86_400_000).toISOString(), // après `to`
        totalAmount: 9000,
      });
      await insertStockMovement(admin, merchantAccountId, userId, {
        movementType: 'sold',
        orderId: outsideOrderId,
        productId,
        qty: 7,
        unitCost: 1000,
      });

      const { data, error } = await admin.rpc('get_finance_collected_joins', {
        p_merchant_id: merchantAccountId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });
      if (error) throw error;

      const payload = data as unknown as {
        soldMovements: Array<{ order_id: string; product_id: string; qty: number }>;
        orderLines: Array<{ order_id: string; raw_title: string; qty: number }>;
      };

      expect(payload.soldMovements).toHaveLength(1);
      expect(payload.soldMovements[0]?.order_id).toBe(inWindowOrderId);
      expect(payload.soldMovements[0]?.qty).toBe(2);
      expect(payload.orderLines).toHaveLength(1);
      expect(payload.orderLines[0]?.raw_title).toBe('Robe Wax');
    },
  );

  skipIfNoServiceRole(
    'scope boutique optionnel : exclut les commandes des autres boutiques',
    async () => {
      const { admin, merchantAccountId, userId } = await createOwnerFixture('collected-shop');
      const productId = await createProduct(admin, merchantAccountId, 'Produit');
      const shopA = await createShop(admin, merchantAccountId);
      const shopB = await createShop(admin, merchantAccountId);
      const from = new Date(Date.now() - 10 * 86_400_000).toISOString();
      const to = new Date(Date.now() + 86_400_000).toISOString();

      const orderA = await insertOrder(admin, merchantAccountId, {
        cashCollectedAt: new Date().toISOString(),
        shopId: shopA,
        totalAmount: 4000,
      });
      await insertStockMovement(admin, merchantAccountId, userId, {
        movementType: 'sold',
        orderId: orderA,
        productId,
        qty: 1,
        unitCost: 500,
      });
      const orderB = await insertOrder(admin, merchantAccountId, {
        cashCollectedAt: new Date().toISOString(),
        shopId: shopB,
        totalAmount: 7000,
      });
      await insertStockMovement(admin, merchantAccountId, userId, {
        movementType: 'sold',
        orderId: orderB,
        productId,
        qty: 9,
        unitCost: 500,
      });

      const { data, error } = await admin.rpc('get_finance_collected_joins', {
        p_merchant_id: merchantAccountId,
        p_from: from,
        p_to: to,
        p_shop_id: shopA,
      });
      if (error) throw error;

      const payload = data as unknown as {
        soldMovements: Array<{ order_id: string }>;
      };
      expect(payload.soldMovements).toHaveLength(1);
      expect(payload.soldMovements[0]?.order_id).toBe(orderA);
    },
  );

  skipIfNoServiceRole(
    'aucune commande dans la fenêtre → tableaux vides ([] jamais null)',
    async () => {
      const { admin, merchantAccountId } = await createOwnerFixture('collected-empty');
      const { data, error } = await admin.rpc('get_finance_collected_joins', {
        p_merchant_id: merchantAccountId,
        p_from: new Date(Date.now() - 86_400_000).toISOString(),
        p_to: new Date().toISOString(),
      });
      if (error) throw error;
      const payload = data as unknown as { soldMovements: unknown[]; orderLines: unknown[] };
      expect(payload.soldMovements).toEqual([]);
      expect(payload.orderLines).toEqual([]);
    },
  );

  skipIfNoServiceRole(
    'session authentifiée (owner) refusée — grant execute réservé à service_role',
    async () => {
      const { email, merchantAccountId } = await createOwnerFixture('collected-authenticated');
      const client = await signIn(email);

      const result = await client.rpc('get_finance_collected_joins', {
        p_merchant_id: merchantAccountId,
        p_from: new Date(Date.now() - 86_400_000).toISOString(),
        p_to: new Date().toISOString(),
      });
      expect(result.error).not.toBeNull();
    },
  );
});

describe('get_finance_returned_joins (Lot 5, 0087)', () => {
  skipIfNoServiceRole(
    'fenêtre returned_at inclusive ET cash_collected_at non null — contra-revenue réel uniquement',
    async () => {
      const { admin, merchantAccountId, userId } = await createOwnerFixture('returned-window');
      const productId = await createProduct(admin, merchantAccountId, 'Produit retourné');
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() - 5 * 86_400_000);

      // Retour réel : returned_at dans la fenêtre ET cash_collected_at renseigné.
      const realReturnOrderId = await insertOrder(admin, merchantAccountId, {
        cashCollectedAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
        returnedAt: from.toISOString(),
        totalAmount: 3000,
      });
      await insertStockMovement(admin, merchantAccountId, userId, {
        movementType: 'sold',
        orderId: realReturnOrderId,
        productId,
        qty: 1,
        unitCost: 800,
      });
      await insertStockMovement(admin, merchantAccountId, userId, {
        movementType: 'courier_return',
        orderId: realReturnOrderId,
        productId,
        qty: 1,
      });

      // Retour sans encaissement préalable (cash_collected_at NULL) : exclu par construction
      // (pas de contra-revenue réel, reproduit `.not('cash_collected_at','is',null)` du TS).
      const neverCollectedOrderId = await insertOrder(admin, merchantAccountId, {
        cashCollectedAt: null,
        returnedAt: to.toISOString(),
        totalAmount: 2000,
      });
      await insertStockMovement(admin, merchantAccountId, userId, {
        movementType: 'courier_return',
        orderId: neverCollectedOrderId,
        productId,
        qty: 5,
      });

      const { data, error } = await admin.rpc('get_finance_returned_joins', {
        p_merchant_id: merchantAccountId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });
      if (error) throw error;

      const payload = data as unknown as {
        soldMovements: Array<{ order_id: string }>;
        courierReturns: Array<{ order_id: string; qty: number }>;
      };

      expect(payload.soldMovements).toHaveLength(1);
      expect(payload.soldMovements[0]?.order_id).toBe(realReturnOrderId);
      expect(payload.courierReturns).toHaveLength(1);
      expect(payload.courierReturns[0]?.order_id).toBe(realReturnOrderId);
      expect(payload.courierReturns[0]?.qty).toBe(1);
    },
  );

  skipIfNoServiceRole(
    'session authentifiée (owner) refusée — grant execute réservé à service_role',
    async () => {
      const { email, merchantAccountId } = await createOwnerFixture('returned-authenticated');
      const client = await signIn(email);

      const result = await client.rpc('get_finance_returned_joins', {
        p_merchant_id: merchantAccountId,
        p_from: new Date(Date.now() - 86_400_000).toISOString(),
        p_to: new Date().toISOString(),
      });
      expect(result.error).not.toBeNull();
    },
  );

  skipIfNoServiceRole(
    'isolation tenant : lit uniquement les commandes du merchant_id demandé',
    async () => {
      const {
        admin,
        merchantAccountId: merchantA,
        userId,
      } = await createOwnerFixture('returned-a');
      const productId = await createProduct(admin, merchantA, 'Produit A');
      const { merchantAccountId: merchantB } = await createOwnerFixture('returned-b');

      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() + 86_400_000);
      const orderId = await insertOrder(admin, merchantA, {
        cashCollectedAt: from.toISOString(),
        returnedAt: from.toISOString(),
        totalAmount: 1000,
      });
      await insertStockMovement(admin, merchantA, userId, {
        movementType: 'courier_return',
        orderId,
        productId,
        qty: 1,
      });

      const { data, error } = await admin.rpc('get_finance_returned_joins', {
        p_merchant_id: merchantB,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });
      if (error) throw error;
      const payload = data as unknown as { courierReturns: unknown[] };
      expect(payload.courierReturns).toEqual([]);
    },
  );
});
