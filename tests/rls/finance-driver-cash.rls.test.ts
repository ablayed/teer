import { deriveDriverCashConsolidation } from '@/lib/drivers/cash-consolidation';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// Phase 13.1 / C1 — la card Finances « cash chez le livreur » (RPC SQL finance_kpis,
// migration 0065) doit renvoyer EXACTEMENT le même chiffre que la page Livreurs
// (deriveDriverCashConsolidation), frais de livraison retranchés, sur des données réelles.
// On exerce le VRAI chemin de versement (record_cash_settlement, allocation oldest-first capée
// au brut = le piège multi-commandes), puis la VRAIE fonction SQL, et on compare à la référence TS.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'finance-driver-cash-rls-pw';
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
  const email = `finance-driver-cash-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `finance-driver-cash-member-${role}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  // L'utilisateur créé ci-dessus obtient AUSSI son propre merchant_account (trigger de
  // signup) — on le retire pour ne garder que le membership sur le tenant du test.
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  return { email, userId };
}

async function createDriver(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Livreur Test',
      phone: '+221770000000',
      is_active: true,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');
  return data.id;
}

type SeedOrder = {
  collectableMinor: number;
  feeMinor: number;
  ageDays: number; // pour l'ordre oldest-first du versement auto
  createdAt?: string; // borne précise (Lot 3b : tests d'inclusivité de fenêtre)
  shopId?: string | null;
};

async function seedDeliveredCollectedOrder(
  admin: AdminClient,
  merchantAccountId: string,
  driverId: string,
  order: SeedOrder,
) {
  const ts = order.createdAt ?? new Date(Date.now() - order.ageDays * 86_400_000).toISOString();
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `FDC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: order.collectableMinor,
      currency: 'XOF',
      cod_status: 'LIVREE',
      order_state: 'open',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
      assigned_driver_id: driverId,
      shop_id: order.shopId ?? null,
      payment_channel_at_delivery: 'ESPECES',
      cash_collectable_minor: order.collectableMinor,
      delivery_fee_minor: order.feeMinor,
      created_at_shopify: ts,
      created_at: ts,
      updated_at: ts,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data.id;
}

async function createShop(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `fdc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.myshopify.com`,
      access_token_encrypted: 'test-token',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id;
}

async function financeCashChezLivreurs(client: SupabaseClient<Database>, merchantId: string) {
  const { data, error } = await client.rpc('finance_kpis', {
    p_merchant: merchantId,
    p_from: new Date(Date.now() - 365 * 86_400_000).toISOString(),
    p_to: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (error) throw error;
  const row = (data as Array<{ cash_chez_livreurs: number; a_encaisser: number }>)[0];
  return row;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('finance_kpis cash_chez_livreurs — frais retranchés, aligné Livreurs (C1)', () => {
  skipIfNoServiceRole(
    'piège multi-commandes : versement net complet → 0 (pas de résidu de frais)',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('trap');
      const driverId = await createDriver(admin, merchantAccountId);
      // A(5000, frais 1000) plus ancienne + B(3000, frais 500). Net dû = 4000 + 2500 = 6500.
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 5000,
        feeMinor: 1000,
        ageDays: 2,
      });
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 3000,
        feeMinor: 500,
        ageDays: 1,
      });

      const client = await signIn(email);
      // Versement auto (oldest-first, capé au brut) du NET total que le livreur doit.
      const { data: settleData, error: settleError } = await client.rpc('record_cash_settlement', {
        p_merchant: merchantAccountId,
        p_driver: driverId,
        p_amount_received_minor: 6500,
        p_method: 'ESPECES',
        p_note: '',
        p_client_request_id: crypto.randomUUID(),
      });
      if (settleError) throw settleError;
      const remitted = Number((settleData as { allocatedMinor: number }).allocatedMinor);

      const reference = deriveDriverCashConsolidation({
        orders: [
          {
            cashState: 'collected',
            cashCollectableMinor: 5000,
            deliveryFeeMinor: 1000,
            paymentChannel: 'ESPECES',
            totalAmount: 5000,
          },
          {
            cashState: 'collected',
            cashCollectableMinor: 3000,
            deliveryFeeMinor: 500,
            paymentChannel: 'ESPECES',
            totalAmount: 3000,
          },
        ],
        remittedMinor: remitted,
      });

      const row = await financeCashChezLivreurs(client, merchantAccountId);

      expect(remitted).toBe(6500); // le livreur a bien remis tout son net dû
      expect(reference.cashOnHandMinor).toBe(0); // référence Livreurs
      expect(row.cash_chez_livreurs).toBe(0); // card Finances (SQL) — pas de fantôme de frais
      expect(row.cash_chez_livreurs).toBe(reference.cashOnHandMinor); // égalité stricte
      expect(row.a_encaisser).toBe(row.cash_chez_livreurs); // même concept (clé dupliquée voulue)
    },
  );

  skipIfNoServiceRole(
    'versement partiel : reste = net non remis (frais déduits), identique à la référence',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('partial');
      const driverId = await createDriver(admin, merchantAccountId);
      // 1 commande : collectable 10000, frais 1000 → net dû 9000.
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 10000,
        feeMinor: 1000,
        ageDays: 1,
      });

      const client = await signIn(email);
      const { data: settleData, error: settleError } = await client.rpc('record_cash_settlement', {
        p_merchant: merchantAccountId,
        p_driver: driverId,
        p_amount_received_minor: 6000,
        p_method: 'ESPECES',
        p_note: '',
        p_client_request_id: crypto.randomUUID(),
      });
      if (settleError) throw settleError;
      const remitted = Number((settleData as { allocatedMinor: number }).allocatedMinor);

      const reference = deriveDriverCashConsolidation({
        orders: [
          {
            cashState: 'collected',
            cashCollectableMinor: 10000,
            deliveryFeeMinor: 1000,
            paymentChannel: 'ESPECES',
            totalAmount: 10000,
          },
        ],
        remittedMinor: remitted,
      });

      const row = await financeCashChezLivreurs(client, merchantAccountId);

      expect(reference.cashOnHandMinor).toBe(3000); // 10000 − 1000 − 6000
      expect(row.cash_chez_livreurs).toBe(3000);
      expect(row.cash_chez_livreurs).toBe(reference.cashOnHandMinor);
    },
  );
});

// Lot 3 perf (migration 0083) — get_driver_cash_consolidation / get_driver_cash_outstanding_orders
// remplacent les selects `orders` all-time + `.in(orderIds)` de getDriversCashOnHandTotal,
// getDriverCashConsolidation et buildDriverSettlements. Même exigence de parité stricte
// avec deriveDriverCashConsolidation que ci-dessus, plus la garde de rôle NULL-safe.
describe('get_driver_cash_consolidation / get_driver_cash_outstanding_orders (Lot 3, 0083)', () => {
  skipIfNoServiceRole(
    'piège multi-commandes : total agrégé = référence TS = 0, ET aucune ligne de détail ' +
      'pour ce livreur malgré un résidu brut non nul sur une commande',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('consolidation-trap');
      const driverId = await createDriver(admin, merchantAccountId);
      // Identique au test finance_kpis ci-dessus : net dû total = 6500, versé 6500.
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 5000,
        feeMinor: 1000,
        ageDays: 2,
      });
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 3000,
        feeMinor: 500,
        ageDays: 1,
      });

      const client = await signIn(email);
      const { error: settleError } = await client.rpc('record_cash_settlement', {
        p_merchant: merchantAccountId,
        p_driver: driverId,
        p_amount_received_minor: 6500,
        p_method: 'ESPECES',
        p_note: '',
        p_client_request_id: crypto.randomUUID(),
      });
      if (settleError) throw settleError;

      // Allocation oldest-first au BRUT (record_cash_settlement, 0018) : la commande la
      // plus ancienne (5000) est soldée en entier, la plus récente (3000) reçoit le reste
      // (1500) → résidu BRUT de 1500 sur cette commande, alors que le NET agrégé (frais
      // déduits) tombe bien à 0. C'est le piège documenté dans consolidateCashByDriver.
      const { data: consolidationRows, error: consolidationError } = await client.rpc(
        'get_driver_cash_consolidation',
        { p_merchant_id: merchantAccountId },
      );
      if (consolidationError) throw consolidationError;
      const driverRow = (consolidationRows ?? []).find((row) => row.driver_id === driverId);

      expect(driverRow?.cash_on_hand_minor).toBe(0);

      const { data: outstandingRows, error: outstandingError } = await client.rpc(
        'get_driver_cash_outstanding_orders',
        { p_merchant_id: merchantAccountId },
      );
      if (outstandingError) throw outstandingError;

      // Garde reproduite de buildDriverSettlements (`if (!entry) continue`) : un livreur
      // au net à 0 n'a AUCUNE ligne de détail, même si une commande isolée montre un
      // résidu brut de 1500 (5ème assertion du test finance_kpis jumeau : net=0 malgré
      // le résidu par commande).
      expect((outstandingRows ?? []).filter((row) => row.driver_id === driverId)).toHaveLength(0);
    },
  );

  skipIfNoServiceRole(
    'versement partiel : total agrégé = référence TS, détail = brut (peut dépasser le net)',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('consolidation-partial');
      const driverId = await createDriver(admin, merchantAccountId);
      const orderId = await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 10000,
        feeMinor: 1000,
        ageDays: 1,
      });

      const client = await signIn(email);
      const { error: settleError } = await client.rpc('record_cash_settlement', {
        p_merchant: merchantAccountId,
        p_driver: driverId,
        p_amount_received_minor: 6000,
        p_method: 'ESPECES',
        p_note: '',
        p_client_request_id: crypto.randomUUID(),
      });
      if (settleError) throw settleError;

      const reference = deriveDriverCashConsolidation({
        orders: [
          {
            cashState: 'collected',
            cashCollectableMinor: 10000,
            deliveryFeeMinor: 1000,
            paymentChannel: 'ESPECES',
            totalAmount: 10000,
          },
        ],
        remittedMinor: 6000,
      });

      const { data: consolidationRows, error: consolidationError } = await client.rpc(
        'get_driver_cash_consolidation',
        { p_merchant_id: merchantAccountId },
      );
      if (consolidationError) throw consolidationError;
      const driverRow = (consolidationRows ?? []).find((row) => row.driver_id === driverId);

      expect(reference.cashOnHandMinor).toBe(3000); // 10000 − 1000 − 6000
      expect(driverRow?.cash_on_hand_minor).toBe(3000);
      expect(driverRow?.cash_on_hand_minor).toBe(reference.cashOnHandMinor);
      expect(driverRow?.collected_minor).toBe(10000);
      expect(driverRow?.collected_delivery_fees_minor).toBe(1000);
      expect(driverRow?.remitted_minor).toBe(6000);

      const { data: outstandingRows, error: outstandingError } = await client.rpc(
        'get_driver_cash_outstanding_orders',
        { p_merchant_id: merchantAccountId },
      );
      if (outstandingError) throw outstandingError;
      const orderRow = (outstandingRows ?? []).find((row) => row.order_id === orderId);

      // Ligne de détail BRUTE (collectable − alloué = 10000 − 6000 = 4000), volontairement
      // > au net (3000) : les frais (1000) sont une déduction par livreur, pas par commande
      // (cf. commentaire buildDriverSettlements).
      expect(orderRow?.outstanding_minor).toBe(4000);
    },
  );

  skipIfNoServiceRole('agent : accès refusé (garde de rôle, ni owner ni manager)', async () => {
    const { admin, merchantAccountId } = await createOwnerFixture('consolidation-agent');
    const driverId = await createDriver(admin, merchantAccountId);
    await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
      collectableMinor: 5000,
      feeMinor: 0,
      ageDays: 0,
    });
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const client = await signIn(agentEmail);

    const consolidation = await client.rpc('get_driver_cash_consolidation', {
      p_merchant_id: merchantAccountId,
    });
    expect(consolidation.error).not.toBeNull();

    const outstanding = await client.rpc('get_driver_cash_outstanding_orders', {
      p_merchant_id: merchantAccountId,
    });
    expect(outstanding.error).not.toBeNull();
  });

  skipIfNoServiceRole(
    'isolation tenant : owner du tenant B ne peut pas lire le cash du tenant A (rôle NULL)',
    async () => {
      const { admin, merchantAccountId: merchantA } = await createOwnerFixture('consolidation-a');
      const driverId = await createDriver(admin, merchantA);
      await seedDeliveredCollectedOrder(admin, merchantA, driverId, {
        collectableMinor: 5000,
        feeMinor: 0,
        ageDays: 0,
      });
      const { email: emailB } = await createOwnerFixture('consolidation-b');
      const clientB = await signIn(emailB);

      // v_role est NULL pour B sur le tenant A → la garde `v_role is null or v_role not in
      // (...)` doit refuser, pas silencieusement renvoyer 0 ligne (cf. gotcha CLAUDE.md
      // "SECURITY DEFINER role gates must be NULL-safe").
      const result = await clientB.rpc('get_driver_cash_consolidation', {
        p_merchant_id: merchantA,
      });
      expect(result.error).not.toBeNull();
    },
  );
});

// Lot 3b perf (migration 0084) — get_report_driver_cash_pending remplace le select `orders`
// fenêtré + `.in(orderIds)` de getReportData (rapport PDF). Contrat DIFFÉRENT de 0083 :
// borné à la période du rapport [from,to] (bornes INCLUSIVES, cf. data.ts:300-301) et
// scopé boutique en option — ce n'est PAS le cash total en main cross-boutique all-time.
describe('get_report_driver_cash_pending (Lot 3b, 0084)', () => {
  skipIfNoServiceRole(
    'parité avec deriveDriverCashConsolidation dans la fenêtre (piège multi-commandes)',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('report-pending-trap');
      const driverId = await createDriver(admin, merchantAccountId);
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 5000,
        feeMinor: 1000,
        ageDays: 2,
      });
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 3000,
        feeMinor: 500,
        ageDays: 1,
      });

      const client = await signIn(email);
      const { error: settleError } = await client.rpc('record_cash_settlement', {
        p_merchant: merchantAccountId,
        p_driver: driverId,
        p_amount_received_minor: 6500,
        p_method: 'ESPECES',
        p_note: '',
        p_client_request_id: crypto.randomUUID(),
      });
      if (settleError) throw settleError;

      const reference = deriveDriverCashConsolidation({
        orders: [
          {
            cashState: 'collected',
            cashCollectableMinor: 5000,
            deliveryFeeMinor: 1000,
            paymentChannel: 'ESPECES',
            totalAmount: 5000,
          },
          {
            cashState: 'collected',
            cashCollectableMinor: 3000,
            deliveryFeeMinor: 500,
            paymentChannel: 'ESPECES',
            totalAmount: 3000,
          },
        ],
        remittedMinor: 6500,
      });

      const { data, error } = await client.rpc('get_report_driver_cash_pending', {
        p_merchant_id: merchantAccountId,
        p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        p_to: new Date(Date.now() + 86_400_000).toISOString(),
      });
      if (error) throw error;
      const row = (data ?? []).find((entry) => entry.driver_id === driverId);

      expect(reference.cashOnHandMinor).toBe(0);
      // Livreur au net 0 : absent ou pending_minor=0 selon la RPC (agrégat, pas de garde
      // "having" ici — driver_id apparaît toujours, cf. get_driver_cash_consolidation).
      expect(row?.pending_minor ?? 0).toBe(0);
    },
  );

  skipIfNoServiceRole(
    'bornes de fenêtre INCLUSIVES aux deux extrémités, commande hors fenêtre exclue',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('report-pending-window');
      const driverId = await createDriver(admin, merchantAccountId);
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() - 5 * 86_400_000);

      // Une commande pile sur chaque borne (incluse) + une hors fenêtre (exclue).
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 2000,
        feeMinor: 0,
        ageDays: 0,
        createdAt: from.toISOString(),
      });
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 3000,
        feeMinor: 0,
        ageDays: 0,
        createdAt: to.toISOString(),
      });
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 9000,
        feeMinor: 0,
        ageDays: 0,
        createdAt: new Date(Date.now() - 1 * 86_400_000).toISOString(), // après `to`
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_report_driver_cash_pending', {
        p_merchant_id: merchantAccountId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });
      if (error) throw error;
      const row = (data ?? []).find((entry) => entry.driver_id === driverId);

      // Seules les 2 commandes sur les bornes comptent : 2000 + 3000 = 5000. La 3ᵉ (9000,
      // hors fenêtre) doit être exclue malgré un cash_state collecté identique.
      expect(row?.pending_minor).toBe(5000);
    },
  );

  skipIfNoServiceRole(
    'scope boutique optionnel : exclut les commandes des autres boutiques',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('report-pending-shop');
      const driverId = await createDriver(admin, merchantAccountId);
      const shopA = await createShop(admin, merchantAccountId);
      const shopB = await createShop(admin, merchantAccountId);
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 4000,
        feeMinor: 0,
        ageDays: 1,
        shopId: shopA,
      });
      await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
        collectableMinor: 7000,
        feeMinor: 0,
        ageDays: 1,
        shopId: shopB,
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_report_driver_cash_pending', {
        p_merchant_id: merchantAccountId,
        p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        p_to: new Date(Date.now() + 86_400_000).toISOString(),
        p_shop_id: shopA,
      });
      if (error) throw error;
      const row = (data ?? []).find((entry) => entry.driver_id === driverId);

      // Scopé shopA : seule la commande de 4000 compte, pas celle de shopB (7000).
      expect(row?.pending_minor).toBe(4000);
    },
  );

  skipIfNoServiceRole('agent : accès refusé (garde de rôle, ni owner ni manager)', async () => {
    const { admin, merchantAccountId } = await createOwnerFixture('report-pending-agent');
    const driverId = await createDriver(admin, merchantAccountId);
    await seedDeliveredCollectedOrder(admin, merchantAccountId, driverId, {
      collectableMinor: 5000,
      feeMinor: 0,
      ageDays: 0,
    });
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const client = await signIn(agentEmail);

    const result = await client.rpc('get_report_driver_cash_pending', {
      p_merchant_id: merchantAccountId,
      p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      p_to: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(result.error).not.toBeNull();
  });

  skipIfNoServiceRole(
    'isolation tenant : owner du tenant B ne peut pas lire le cash du tenant A (rôle NULL)',
    async () => {
      const { admin, merchantAccountId: merchantA } = await createOwnerFixture('report-pending-a');
      const driverId = await createDriver(admin, merchantA);
      await seedDeliveredCollectedOrder(admin, merchantA, driverId, {
        collectableMinor: 5000,
        feeMinor: 0,
        ageDays: 0,
      });
      const { email: emailB } = await createOwnerFixture('report-pending-b');
      const clientB = await signIn(emailB);

      const result = await clientB.rpc('get_report_driver_cash_pending', {
        p_merchant_id: merchantA,
        p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        p_to: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(result.error).not.toBeNull();
    },
  );
});
