import { computeFinanceReport } from '@/lib/finance/profit';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'dashboard-period-rls-test-pw';
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
  for (let i = 0; i < 20; i += 1) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((resolve) => setTimeout(resolve, 150));
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
  const email = `dashboard-period-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `dashboard-period-member-${role}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  return { email, userId };
}

async function createShop(admin: AdminClient, merchantAccountId: string, label: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `${label}-${Date.now()}.myshopify.com`,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id;
}

async function createDriver(admin: AdminClient, merchantAccountId: string, label: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur ${label}`,
      phone: `+22177${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');
  return data.id;
}

async function createProduct(admin: AdminClient, merchantAccountId: string, title: string) {
  const { data, error } = await admin
    .from('product')
    .insert({ merchant_account_id: merchantAccountId, title, unit_cost: 1_000 })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id;
}

async function seedDeliveredCollectedOrder(
  admin: AdminClient,
  {
    assignedDriverId,
    cashCollectedAt,
    merchantAccountId,
    orderNumber,
    productId,
    shopId,
    title,
    totalAmount,
  }: {
    assignedDriverId?: string | null;
    cashCollectedAt: string;
    merchantAccountId: string;
    orderNumber: string;
    productId: string;
    shopId: string;
    title: string;
    totalAmount: number;
  },
) {
  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      assigned_driver_id: assignedDriverId ?? null,
      source: 'manual',
      order_number: orderNumber,
      total_amount: totalAmount,
      cash_collectable_minor: totalAmount,
      delivery_fee_minor: 0,
      currency: 'XOF',
      items_summary: [{ price: totalAmount, quantity: 1, title }],
      order_state: 'completed',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
      cash_collected_at: cashCollectedAt,
      payment_channel_at_delivery: 'ESPECES',
    })
    .select('id')
    .single();
  if (orderError || !order) throw orderError ?? new Error('order insert failed');

  const { error: lineError } = await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    order_id: order.id,
    product_id: productId,
    raw_title: title,
    qty: 1,
    match_status: 'matched',
  });
  if (lineError) throw lineError;

  return order.id;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('dashboard period metrics RPCs', () => {
  skipIfNoServiceRole(
    'CA encaissé dashboard = report.caMinor Finances sur même boutique/période',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('parity');
      const ownerClient = await signIn(email);
      const shopA = await createShop(admin, merchantAccountId, 'shop-a');
      const shopB = await createShop(admin, merchantAccountId, 'shop-b');
      const productA = await createProduct(admin, merchantAccountId, 'Sac premium');
      const productB = await createProduct(admin, merchantAccountId, 'Ceinture duo');
      const driverId = await createDriver(admin, merchantAccountId, 'Parité');
      const from = new Date('2026-07-01T00:00:00.000Z');
      const to = new Date('2026-07-31T23:59:59.999Z');

      await seedDeliveredCollectedOrder(admin, {
        assignedDriverId: driverId,
        cashCollectedAt: '2026-07-10T10:00:00.000Z',
        merchantAccountId,
        orderNumber: `PAR-${Date.now()}-1`,
        productId: productA,
        shopId: shopA,
        title: 'Sac premium',
        totalAmount: 12_000,
      });
      await seedDeliveredCollectedOrder(admin, {
        assignedDriverId: driverId,
        cashCollectedAt: '2026-07-11T10:00:00.000Z',
        merchantAccountId,
        orderNumber: `PAR-${Date.now()}-2`,
        productId: productB,
        shopId: shopA,
        title: 'Ceinture duo',
        totalAmount: 8_000,
      });
      await seedDeliveredCollectedOrder(admin, {
        assignedDriverId: driverId,
        cashCollectedAt: '2026-07-12T10:00:00.000Z',
        merchantAccountId,
        orderNumber: `PAR-${Date.now()}-3`,
        productId: productA,
        shopId: shopB,
        title: 'Sac premium',
        totalAmount: 15_000,
      });

      const rpc = await ownerClient.rpc('get_dashboard_cash_collected_total', {
        p_merchant_id: merchantAccountId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
        p_shop_id: shopA,
      });
      expect(rpc.error).toBeNull();

      const report = computeFinanceReport({
        collectedOrders: [
          {
            deliveryFeeMinor: 0,
            id: 'a1',
            paymentChannelAtDelivery: 'ESPECES',
            totalAmount: 12_000,
          },
          {
            deliveryFeeMinor: 0,
            id: 'a2',
            paymentChannelAtDelivery: 'ESPECES',
            totalAmount: 8_000,
          },
        ],
        courierReturns: [],
        expenses: [],
        productInfo: new Map(),
        returnedOrders: [],
        settings: {
          freeMoneyFee: 100,
          orangeMoneyFee: 100,
          transferTaxBps: 50,
          transferTaxCapMinor: 2_000,
          waveFee: 100,
        },
        soldMovementsForCollected: [],
        soldMovementsForReturned: [],
      });

      expect(rpc.data?.[0]?.ca_encaisse_minor ?? 0).toBe(report.caMinor);

      const deliveries = await ownerClient.rpc('get_dashboard_deliveries_by_product', {
        p_merchant_id: merchantAccountId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
        p_shop_id: shopA,
      });
      expect(deliveries.error).toBeNull();
      const deliveriesPayload = deliveries.data as {
        products: Array<{
          delivered_orders_count: number;
          product_id: string;
          title: string;
        }>;
        total_deliveries: number;
      };
      expect(deliveriesPayload.total_deliveries).toBe(2);
      expect(deliveriesPayload.products).toEqual([
        {
          delivered_orders_count: 1,
          product_id: productB,
          title: 'Ceinture duo',
        },
        {
          delivered_orders_count: 1,
          product_id: productA,
          title: 'Sac premium',
        },
      ]);
    },
  );

  skipIfNoServiceRole(
    'agent refusé sur CA mais autorisé sur livraisons; non-membre refusé',
    async () => {
      const { admin, merchantAccountId } = await createOwnerFixture('rbac');
      const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
      const outsider = await createOwnerFixture('outsider');
      const agentClient = await signIn(agentEmail);
      const outsiderClient = await signIn(outsider.email);
      const from = new Date('2026-07-01T00:00:00.000Z').toISOString();
      const to = new Date('2026-07-31T23:59:59.999Z').toISOString();

      const cashForAgent = await agentClient.rpc('get_dashboard_cash_collected_total', {
        p_merchant_id: merchantAccountId,
        p_from: from,
        p_to: to,
      });
      expect(cashForAgent.error).not.toBeNull();

      const deliveriesForAgent = await agentClient.rpc('get_dashboard_deliveries_by_product', {
        p_merchant_id: merchantAccountId,
        p_from: from,
        p_to: to,
      });
      expect(deliveriesForAgent.error).toBeNull();

      const cashForOutsider = await outsiderClient.rpc('get_dashboard_cash_collected_total', {
        p_merchant_id: merchantAccountId,
        p_from: from,
        p_to: to,
      });
      expect(cashForOutsider.error).not.toBeNull();
    },
  );

  skipIfNoServiceRole(
    'get_driver_cash_consolidation filtre par boutique sans casser le cas null',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('driver-shop');
      const ownerClient = await signIn(email);
      const shopA = await createShop(admin, merchantAccountId, 'cash-a');
      const shopB = await createShop(admin, merchantAccountId, 'cash-b');
      const productId = await createProduct(admin, merchantAccountId, 'Cash produit');
      const driverId = await createDriver(admin, merchantAccountId, 'Cash');
      const collectedAt = new Date('2026-07-15T10:00:00.000Z').toISOString();

      await seedDeliveredCollectedOrder(admin, {
        assignedDriverId: driverId,
        cashCollectedAt: collectedAt,
        merchantAccountId,
        orderNumber: `CASH-${Date.now()}-1`,
        productId,
        shopId: shopA,
        title: 'Cash produit',
        totalAmount: 10_000,
      });
      await seedDeliveredCollectedOrder(admin, {
        assignedDriverId: driverId,
        cashCollectedAt: collectedAt,
        merchantAccountId,
        orderNumber: `CASH-${Date.now()}-2`,
        productId,
        shopId: shopB,
        title: 'Cash produit',
        totalAmount: 7_000,
      });

      const allShops = await ownerClient.rpc('get_driver_cash_consolidation', {
        p_merchant_id: merchantAccountId,
        p_driver_id: driverId,
      });
      expect(allShops.error).toBeNull();

      const filtered = await ownerClient.rpc('get_driver_cash_consolidation', {
        p_merchant_id: merchantAccountId,
        p_driver_id: driverId,
        p_shop_id: shopA,
      });
      expect(filtered.error).toBeNull();

      expect(allShops.data?.[0]?.cash_on_hand_minor ?? 0).toBe(17_000);
      expect(filtered.data?.[0]?.cash_on_hand_minor ?? 0).toBe(10_000);
    },
  );
});
