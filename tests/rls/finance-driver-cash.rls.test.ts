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
};

async function seedDeliveredCollectedOrder(
  admin: AdminClient,
  merchantAccountId: string,
  driverId: string,
  order: SeedOrder,
) {
  const ts = new Date(Date.now() - order.ageDays * 86_400_000).toISOString();
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
