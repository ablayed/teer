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
    // Optionnel : seuls get_dashboard_shop_performance (created_at) en dépendent parmi
    // les RPC exercées par ce fichier. Omis, `created_at` retombe sur `now()` — ce qui a
    // cassé le test shop_performance au passage au 1er août 2026 : sa fenêtre [from,to]
    // était codée en dur sur juillet 2026, et la commande créée par le fixture (created_at
    // implicite = now(), donc en août) en sortait dès que "maintenant" a dépassé juillet.
    createdAt,
    merchantAccountId,
    orderNumber,
    productId,
    shopId,
    title,
    totalAmount,
  }: {
    assignedDriverId?: string | null;
    cashCollectedAt: string;
    createdAt?: string;
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
      ...(createdAt ? { created_at: createdAt, created_at_shopify: createdAt } : {}),
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

  // get_dashboard_shop_performance filtre sur orders.created_at (migration 0105) — la commande
  // seedée doit donc avoir un created_at explicite DANS la fenêtre [from,to], et cette fenêtre
  // doit être calculée à partir du MÊME ancrage que le seed, jamais une date absolue codée en
  // dur : sinon, dès que « maintenant » dépasse la fenêtre codée en dur, created_at (qui
  // retombe sur now() si non fourni) en sort silencieusement et le test casse au premier
  // rollover de calendrier — exactement ce qui s'est produit le 1er août 2026 avec l'ancienne
  // fenêtre [2026-07-01, 2026-07-31].
  //
  // Factorisé en scénario paramétré par un ANCRAGE arbitraire (pas nécessairement "maintenant")
  // pour prouver la robustesse au rollover SANS faker l'horloge globale de Node (vi.useFakeTimers
  // casserait les timeouts/retries internes de supabase-js, qui ne sont pas sous notre contrôle) :
  // la commande et la fenêtre sont toutes deux dérivées du même ancrage passé en paramètre, donc
  // rejouer ce scénario avec un ancrage de septembre 2026 (bien après la panne réelle du 1er août)
  // exerce EXACTEMENT le même code que le run "aujourd'hui", ce qui est une preuve équivalente à
  // une horloge système simulée pour ce test précis (le seed insère des ISO strings explicites,
  // jamais un now() côté Postgres).
  async function runShopPerformanceScenario(anchor: Date) {
    const { admin, email, merchantAccountId } = await createOwnerFixture(
      `shop-perf-rbac-${anchor.getTime()}`,
    );
    const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const outsider = await createOwnerFixture(`shop-perf-outsider-${anchor.getTime()}`);
    const ownerClient = await signIn(email);
    const managerClient = await signIn(managerEmail);
    const agentClient = await signIn(agentEmail);
    const outsiderClient = await signIn(outsider.email);
    const shopId = await createShop(admin, merchantAccountId, 'shop-perf');
    const productId = await createProduct(admin, merchantAccountId, 'Produit shop perf');

    // Fenêtre RELATIVE à l'ancrage : ±3 jours, jamais une date absolue.
    const from = new Date(anchor.getTime() - 3 * 86_400_000).toISOString();
    const to = new Date(anchor.getTime() + 3 * 86_400_000).toISOString();
    const orderCreatedAt = anchor.toISOString();

    await seedDeliveredCollectedOrder(admin, {
      cashCollectedAt: orderCreatedAt,
      createdAt: orderCreatedAt,
      merchantAccountId,
      orderNumber: `SHOPPERF-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      productId,
      shopId,
      title: 'Produit shop perf',
      totalAmount: 10_000,
    });

    const agentResult = await agentClient.rpc('get_dashboard_shop_performance', {
      p_merchant_id: merchantAccountId,
      p_from: from,
      p_to: to,
    });
    expect(agentResult.error).not.toBeNull();

    const outsiderResult = await outsiderClient.rpc('get_dashboard_shop_performance', {
      p_merchant_id: merchantAccountId,
      p_from: from,
      p_to: to,
    });
    expect(outsiderResult.error).not.toBeNull();

    // Preuve NULL-safe : un rôle explicitement rejeté (agent, membre du tenant) et un rôle
    // NULL (outsider, non-membre) doivent produire EXACTEMENT la même erreur — sinon la garde
    // fuite une information ("vous êtes membre mais mauvais rôle" vs "vous n'êtes pas membre")
    // qu'un attaquant pourrait utiliser pour énumérer l'appartenance à un tenant.
    expect(agentResult.error?.code).toBe('42501');
    expect(agentResult.error?.message).toBe(outsiderResult.error?.message);
    expect(agentResult.error?.code).toBe(outsiderResult.error?.code);
    expect(agentResult.status).toBe(outsiderResult.status);

    const ownerResult = await ownerClient.rpc('get_dashboard_shop_performance', {
      p_merchant_id: merchantAccountId,
      p_from: from,
      p_to: to,
    });
    expect(ownerResult.error).toBeNull();
    const ownerPayload = ownerResult.data as Array<{
      id: string;
      orders_count: number;
      revenue: number;
    }>;
    expect(ownerPayload).toEqual([
      expect.objectContaining({ id: shopId, orders_count: 1, revenue: 10_000 }),
    ]);

    const managerResult = await managerClient.rpc('get_dashboard_shop_performance', {
      p_merchant_id: merchantAccountId,
      p_from: from,
      p_to: to,
    });
    expect(managerResult.error).toBeNull();
    expect(managerResult.data).toEqual(ownerResult.data);
  }

  skipIfNoServiceRole(
    'get_dashboard_shop_performance : agent et non-membre rejetés avec le même message (NULL-safe), owner/manager autorisés avec résultat inchangé',
    async () => {
      await runShopPerformanceScenario(new Date());
    },
    20_000,
  );

  // Preuve de robustesse au rollover de calendrier : rejoue EXACTEMENT le même scénario avec un
  // ancrage de septembre 2026 (après la panne réelle du 1er août) — si la fenêtre ou le seed
  // redevenaient un jour une date absolue codée en dur, ce test-ci casserait immédiatement en CI,
  // sans attendre le prochain rollover réel.
  skipIfNoServiceRole(
    'get_dashboard_shop_performance : robuste à un ancrage futur arbitraire (anti-régression rollover calendaire)',
    async () => {
      await runShopPerformanceScenario(new Date('2026-09-15T12:00:00.000Z'));
    },
    20_000,
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
