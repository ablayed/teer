// Lot F2 — RPC d'agrégation get_purchase_lot_profitability (migration 0146) et
// gardes RBAC/tenant des actions d'écriture associées (lib/actions/purchases.ts).
//
// Convention reprise de tests/rls/lot-f1-finances-v2-socle.rls.test.ts (mêmes
// helpers de fixture, dupliqués ici — aucun module de fixtures partagé dans ce
// dépôt) et de tests/rls/purchases.rls.test.ts (note ligne ~345 : les actions de
// lib/actions/purchases.ts construisent leur propre client admin et lisent
// getRequestStoreId(), qui dépend de next/headers — aucun test de ce dépôt ne les
// appelle directement ; on reproduit l'opération DB équivalente).
//
// get_purchase_lot_profitability n'a AUCUNE garde de rôle propre (SECURITY
// INVOKER, cf. commentaire de tête de 0146) : la visibilité vient entièrement
// des policies RLS existantes de purchase_lot/purchase_lot_line (owner-only,
// 0127). Un lot invisible pour l'appelant → la fonction renvoie NULL (jamais
// une erreur), car ses CTE ne trouvent simplement aucune ligne.

import { assemblePurchaseLotProfitability } from '@/lib/finance/lot-profitability-assembly';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'lotf2-rls-test-pw';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type AdminClient = SupabaseClient<Database>;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function anonClient(): AdminClient {
  return createClient<Database>(supabaseUrl, anonKey, {
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

async function waitForDefaultShop(admin: AdminClient, merchantAccountId: string) {
  for (let i = 0; i < 30; i++) {
    const { data } = await admin
      .from('shop')
      .select('id')
      .eq('merchant_account_id', merchantAccountId)
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id as string;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('default shop not found after 30 retries');
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
  const email = `lotf2-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const shopId = await waitForDefaultShop(admin, merchantAccountId);
  return { admin, email, merchantAccountId, shopId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `lotf2-member-${role}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  const { error } = await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  if (error) throw error;
  return { email, userId };
}

async function createShop(admin: AdminClient, merchantAccountId: string, domain: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      access_token_encrypted: 'enc',
      merchant_account_id: merchantAccountId,
      scopes: 'read_orders',
      shop_domain: domain,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id as string;
}

async function createDriver(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur-${Date.now()}`,
      phone: '+221770000000',
    })
    .select('id')
    .single();
  if (!data) throw new Error('driver insert failed');
  await admin
    .from('driver_shop')
    .insert({ merchant_account_id: merchantAccountId, shop_id: shopId, driver_id: data.id });
  return data.id;
}

async function createProduct(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      title: `Prod-F2-${Date.now()}`,
      unit_cost: 0,
    })
    .select('id')
    .single();
  if (!data) throw new Error('product insert failed');
  return data.id;
}

type TransitionOrderArgs = {
  p_actor: string;
  p_order_id: string;
  p_call_state?: string;
  p_delivery_state?: string;
  p_order_state?: string;
  p_cash_state?: string;
  p_attempt_count?: number;
  p_payment_channel?: string;
};

function transitionRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionOrderArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

async function createOrderWithLine(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  driverId: string,
  productId: string,
  qty: number,
  totalAmount: number,
) {
  const { data: order } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_number: `F2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      total_amount: totalAmount,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      assigned_driver_id: driverId,
    })
    .select('id')
    .single();
  if (!order) throw new Error('order insert failed');

  const { data: line } = await admin
    .from('order_line')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_id: order.id,
      product_id: productId,
      raw_title: 'Produit F2',
      qty,
      match_status: 'matched',
    })
    .select('id')
    .single();
  if (!line) throw new Error('order_line insert failed');

  return { orderId: order.id as string, orderLineId: line.id as string };
}

/** Confirmer → programmer → dispatch → livrer (encaissé). */
async function deliverAndCollect(
  client: SupabaseClient<Database>,
  userId: string,
  orderId: string,
) {
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_call_state: 'validated',
    p_attempt_count: 1,
  });
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'scheduled',
  });
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'out_for_delivery',
  });
  return transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'delivered',
    p_order_state: 'completed',
    p_cash_state: 'collected',
    p_payment_channel: 'ESPECES',
  });
}

type ReceiveRpcArgs = {
  p_lot_id: string;
  p_merchant_account_id: string;
  p_actor_id: string;
  p_lines: Array<{
    line_id: string;
    line_value: number;
    allocated_fees: number;
    landed_total_value: number;
    landed_unit_cost: number;
  }>;
};

function receiveRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'receive_purchase_lot',
    args: ReceiveRpcArgs,
  ) => Promise<{ data: null; error: { message: string } | null }>;
}

/**
 * Reçoit un lot avec un `transport_total` EXPLICITE (contrairement au helper
 * homonyme de lot-f1-finances-v2-socle.rls.test.ts) : `transport_total` est
 * nullable en base (0053, colonne ajoutée sans défaut) et la RPC dérive
 * `transportComplete = (transport_total is not null)` — laisser la colonne à
 * NULL casserait silencieusement le contrôle de référence (`transportComplete:
 * true` attendu par le fixture miroir de tests/unit/finance/
 * lot-profitability-assembly.test.ts).
 */
async function receiveLot(
  admin: AdminClient,
  ownerClient: SupabaseClient<Database>,
  merchantAccountId: string,
  shopId: string,
  userId: string,
  productId: string,
  qtyReceived: number,
  purchasePriceTotal: number,
  transportTotal: number,
) {
  const { data: lot } = await admin
    .from('purchase_lot')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      supplier_name: 'Fournisseur F2',
      ordered_at: '2026-04-01',
      transport_total: transportTotal,
    })
    .select('id')
    .single();
  if (!lot) throw new Error('purchase_lot insert failed');

  const { data: line } = await admin
    .from('purchase_lot_line')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      purchase_lot_id: lot.id,
      product_id: productId,
      qty: qtyReceived,
      purchase_price_total: purchasePriceTotal,
    })
    .select('id')
    .single();
  if (!line) throw new Error('purchase_lot_line insert failed');

  const landedUnitCost = Math.floor(purchasePriceTotal / qtyReceived);
  const { error } = await receiveRpc(ownerClient)('receive_purchase_lot', {
    p_lot_id: lot.id,
    p_merchant_account_id: merchantAccountId,
    p_actor_id: userId,
    p_lines: [
      {
        line_id: line.id,
        line_value: purchasePriceTotal,
        allocated_fees: 0,
        landed_total_value: purchasePriceTotal,
        landed_unit_cost: landedUnitCost,
      },
    ],
  });
  if (error) throw new Error(`receive_purchase_lot failed: ${error.message}`);

  return { lotId: lot.id as string, purchaseLotLineId: line.id as string };
}

// Cast temporaire, même motif que getPurchaseLotProfitabilityRpc dans
// lib/actions/purchases.ts : database.types.ts ne connaît pas encore cette
// fonction (migration 0146 non poussée sur le linked) — à retirer une fois
// pnpm db:types régénéré.
function profitabilityRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'get_purchase_lot_profitability',
    args: { p_purchase_lot_id: string },
  ) => Promise<{
    data: Parameters<typeof assemblePurchaseLotProfitability>[0];
    error: { message: string } | null;
  }>;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

// ──────────────────────────────────────────────────────────────────────────
// get_purchase_lot_profitability — RLS + contrôle de référence (27 avril).
// ──────────────────────────────────────────────────────────────────────────

describe('get_purchase_lot_profitability — RLS', () => {
  skipIfNoServiceRole(
    'owner du bon tenant/boutique lit le document complet — reproduit exactement 89 360 F / 21,9 % via le RPC réel (arrivage du 27 avril)',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('ref-27avril');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);

      const { lotId, purchaseLotLineId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        20,
        265_200,
        0,
      );

      await admin
        .from('purchase_lot_line')
        .update({ weight_grams: 5_000 })
        .eq('id', purchaseLotLineId);

      const { orderId } = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
        19,
        408_000,
      );
      const delivered = await deliverAndCollect(owner, userId, orderId);
      expect(delivered.error).toBeNull();
      expect(delivered.data).toBe('LIVREE');

      await admin.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        purchase_lot_id: lotId,
        amount_minor: 66_700,
        spent_at: '2026-04-27',
        source: 'manuel',
        created_by: userId,
      });

      const { data, error } = await profitabilityRpc(owner)('get_purchase_lot_profitability', {
        p_purchase_lot_id: lotId,
      });

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      if (!data) throw new Error('unexpected null');
      expect(data.purchaseLotId).toBe(lotId);
      expect(data.transportTotalMinor).toBe(0);
      expect(data.transportComplete).toBe(true);
      expect(data.allocationMethod).toBe('value');
      expect(data.lines).toHaveLength(1);
      expect(data.lines[0].qtyReceived).toBe(20);
      expect(data.lines[0].qtySold).toBe(19);
      expect(data.lines[0].purchaseValueMinor).toBe(265_200);
      expect(data.lines[0].weightGrams).toBe(5_000);
      expect(data.lines[0].cashCollectedMinor).toBe(408_000);
      expect(data.productAdSpend).toHaveLength(1);
      expect(data.productAdSpend[0].productId).toBe(productId);
      expect(data.productAdSpend[0].amountMinor).toBe(66_700);

      // Preuve que ces mêmes agrégats, une fois passés dans l'assemblage réel
      // (lib/finance/lot-profitability-assembly.ts), reproduisent EXACTEMENT
      // les mêmes chiffres que le fixture à la main de
      // tests/unit/finance/lot-profitability-assembly.test.ts — la RPC contre
      // une vraie base produit la même sortie qu'un fixture construit à la main.
      const summary = assemblePurchaseLotProfitability(data);
      if (!summary.ok || !summary.allocationMethodAvailable) {
        throw new Error(`unexpected shape: ${JSON.stringify(summary)}`);
      }
      expect(summary.totals.marginMinor).toBe(89_360);
      expect(Math.round(summary.totals.marginPct * 1000)).toBe(219);
      expect(summary.totals.complete).toBe(true);
    },
  );

  skipIfNoServiceRole(
    "arrivage d'une autre boutique du même tenant -> null (current_shop_role(shop_id) requis owner PAR BOUTIQUE, pas au niveau du compte)",
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('cross-shop');
      const owner = await signIn(email);

      const shopB = await createShop(
        admin,
        merchantAccountId,
        `f2-cross-shop-${Date.now()}.internal`,
      );
      const productB = await createProduct(admin, merchantAccountId, shopB);
      const { lotId: lotIdB } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopB,
        userId,
        productB,
        10,
        100_000,
        0,
      );

      // La création de shopB déclenche seed_shop_memberships (0126) : CET
      // owner (déjà merchant_member owner) reçoit automatiquement un
      // shop_member(role='owner') pour shopB aussi — comportement PAR DÉFAUT
      // du modèle multi-boutique de ce projet (un owner de compte est owner de
      // toutes ses boutiques). Pour prouver que get_purchase_lot_profitability
      // est bien gaté par current_shop_role(shop_id) et non par une notion
      // globale « owner du compte », on retire explicitement ce shop_member —
      // scénario réaliste : un accès boutique restreint après coup (CLAUDE.md,
      // section Workspace).
      await admin.from('shop_member').delete().eq('shop_id', shopB).eq('user_id', userId);

      const { data } = await profitabilityRpc(owner)('get_purchase_lot_profitability', {
        p_purchase_lot_id: lotIdB,
      });

      expect(data).toBeNull();
    },
  );

  skipIfNoServiceRole("arrivage d'un autre tenant -> null", async () => {
    const a = await createOwnerFixture('cross-tenant-a');
    const b = await createOwnerFixture('cross-tenant-b');
    const ownerB = await signIn(b.email);
    const productB = await createProduct(b.admin, b.merchantAccountId, b.shopId);
    const { lotId: lotIdB } = await receiveLot(
      b.admin,
      ownerB,
      b.merchantAccountId,
      b.shopId,
      b.userId,
      productB,
      10,
      100_000,
      0,
    );

    const ownerA = await signIn(a.email);
    const { data } = await profitabilityRpc(ownerA)('get_purchase_lot_profitability', {
      p_purchase_lot_id: lotIdB,
    });

    expect(data).toBeNull();
  });

  skipIfNoServiceRole(
    'manager -> null (owner-only, hérité de purchase_lot RLS, jamais une garde de rôle dans la RPC)',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('mgr-refused');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const { lotId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        10,
        100_000,
        0,
      );
      const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');
      const manager = await signIn(managerEmail);

      const { data, error } = await profitabilityRpc(manager)('get_purchase_lot_profitability', {
        p_purchase_lot_id: lotId,
      });

      expect(error).toBeNull();
      expect(data).toBeNull();
    },
  );

  skipIfNoServiceRole('agent -> null (même garde héritée que manager)', async () => {
    const { admin, email, merchantAccountId, shopId, userId } =
      await createOwnerFixture('agent-refused');
    const owner = await signIn(email);
    const productId = await createProduct(admin, merchantAccountId, shopId);
    const { lotId } = await receiveLot(
      admin,
      owner,
      merchantAccountId,
      shopId,
      userId,
      productId,
      10,
      100_000,
      0,
    );
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const agent = await signIn(agentEmail);

    const { data, error } = await profitabilityRpc(agent)('get_purchase_lot_profitability', {
      p_purchase_lot_id: lotId,
    });

    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  skipIfNoServiceRole(
    'anon -> refusé avec une ERREUR (jamais null) : EXECUTE non accordé à anon (revoke all ... from public, anon, authenticated ; grant execute ... to authenticated)',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('anon-refused');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const { lotId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        10,
        100_000,
        0,
      );

      const { data, error } = await profitabilityRpc(anonClient())(
        'get_purchase_lot_profitability',
        { p_purchase_lot_id: lotId },
      );

      expect(error).not.toBeNull();
      expect(data).toBeNull();
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// createProductAdSpendAction — RBAC (RLS) + intégrité tenant/boutique
// (trigger) + idempotence (external_ref). L'action elle-même n'est pas
// invocable hors contexte de requête (getRequestStoreId() dépend de
// next/headers, cf. tests/rls/purchases.rls.test.ts) : on prouve ici les DEUX
// couches indépendantes de défense qui la sous-tendent réellement — les
// policies RLS de product_ad_spend (0145, owner-only, s'appliquent même à un
// appel direct qui contournerait requireRole('owner')) et le trigger
// assert_product_ad_spend_integrity (SECURITY DEFINER, s'applique même à
// l'admin client que l'action utilise réellement).
// ──────────────────────────────────────────────────────────────────────────

describe('product_ad_spend — RBAC (RLS) sur l’insertion directe', () => {
  skipIfNoServiceRole(
    'owner peut insérer une dépense publicitaire rattachée à un arrivage réel (contrôle positif)',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('adspend-owner-ok');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const { lotId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        10,
        100_000,
        0,
      );

      const { error } = await owner.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        purchase_lot_id: lotId,
        amount_minor: 5_000,
        spent_at: '2026-04-01',
        source: 'manuel',
        external_ref: crypto.randomUUID(),
        created_by: userId,
      });

      expect(error).toBeNull();
    },
  );

  skipIfNoServiceRole(
    'manager refusé par RLS sur une insertion DIRECTE (défense en profondeur, indépendante de requireRole côté TS)',
    async () => {
      const { admin, merchantAccountId, shopId, userId } =
        await createOwnerFixture('adspend-mgr-refused');
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const { email: managerEmail, userId: managerUserId } = await addMember(
        admin,
        merchantAccountId,
        'manager',
      );
      const manager = await signIn(managerEmail);

      const { error } = await manager.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        amount_minor: 5_000,
        spent_at: '2026-04-01',
        source: 'manuel',
        created_by: managerUserId,
      });

      expect(error).not.toBeNull();
      const { count } = await admin
        .from('product_ad_spend')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', merchantAccountId);
      expect(count).toBe(0);
      void userId;
    },
  );

  skipIfNoServiceRole('agent refusé par RLS sur une insertion DIRECTE', async () => {
    const { admin, merchantAccountId, shopId } = await createOwnerFixture('adspend-agent-refused');
    const productId = await createProduct(admin, merchantAccountId, shopId);
    const { email: agentEmail, userId: agentUserId } = await addMember(
      admin,
      merchantAccountId,
      'agent',
    );
    const agent = await signIn(agentEmail);

    const { error } = await agent.from('product_ad_spend').insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      product_id: productId,
      amount_minor: 5_000,
      spent_at: '2026-04-01',
      source: 'manuel',
      created_by: agentUserId,
    });

    expect(error).not.toBeNull();
  });
});

describe('product_ad_spend — trigger assert_product_ad_spend_integrity (0145), même sous le client admin de l’action', () => {
  skipIfNoServiceRole(
    "refuse un product_id d'un autre tenant (le trigger charge le produit PAR LUI-MÊME, jamais depuis les colonnes new.* envoyées par l'appelant)",
    async () => {
      const a = await createOwnerFixture('adspend-trigger-a');
      const b = await createOwnerFixture('adspend-trigger-b');
      const productB = await createProduct(b.admin, b.merchantAccountId, b.shopId);

      const { error } = await a.admin.from('product_ad_spend').insert({
        merchant_account_id: a.merchantAccountId, // tenant A...
        shop_id: a.shopId,
        product_id: productB, // ...mais produit du tenant B
        amount_minor: 5_000,
        spent_at: '2026-04-01',
        source: 'manuel',
        created_by: a.userId,
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/merchant_account_id/);
    },
  );

  skipIfNoServiceRole(
    'refuse un purchase_lot_id appartenant à une AUTRE boutique du même tenant',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('adspend-trigger-shop');
      const owner = await signIn(email);
      const shopB = await createShop(
        admin,
        merchantAccountId,
        `f2-adspend-shopB-${Date.now()}.internal`,
      );
      const productA = await createProduct(admin, merchantAccountId, shopId);
      const productB = await createProduct(admin, merchantAccountId, shopB);
      const { lotId: lotIdB } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopB,
        userId,
        productB,
        5,
        50_000,
        0,
      );

      const { error } = await admin.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId, // boutique A...
        product_id: productA, // ...produit A cohérent avec shopId...
        purchase_lot_id: lotIdB, // ...mais lot de la boutique B
        amount_minor: 5_000,
        spent_at: '2026-04-01',
        source: 'manuel',
        created_by: userId,
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/purchase_lot_id/);
    },
  );
});

describe('product_ad_spend — idempotence par external_ref (forme exacte de createProductAdSpendAction)', () => {
  skipIfNoServiceRole(
    'un renvoi du même clientRequestId (external_ref) ne crée pas de second enregistrement',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('adspend-idem');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const { lotId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        10,
        100_000,
        0,
      );
      const clientRequestId = crypto.randomUUID();

      const insertPayload = {
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        purchase_lot_id: lotId,
        amount_minor: 12_000,
        spent_at: '2026-04-15',
        source: 'manuel' as const,
        external_ref: clientRequestId,
        created_by: userId,
      };

      const first = await admin.from('product_ad_spend').insert(insertPayload);
      expect(first.error).toBeNull();

      const second = await admin.from('product_ad_spend').insert(insertPayload);
      expect(second.error).not.toBeNull();
      // Code exact que createProductAdSpendAction traite comme un succès
      // idempotent (AD_SPEND_UNIQUE_EXTERNAL_REF_VIOLATION), jamais une erreur.
      expect(second.error?.code).toBe('23505');

      const { count } = await admin
        .from('product_ad_spend')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopId)
        .eq('external_ref', clientRequestId);
      expect(count).toBe(1);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// setPurchaseLotAllocationMethodAction / setPurchaseLotLineWeightAction —
// garde tenant/boutique. Ces deux actions écrivent via le client ADMIN
// (contourne RLS) : leur SEULE protection tenant/boutique est la clause
// .eq('merchant_account_id', …).eq('shop_id', shopId) posée AVANT toute
// écriture (motif récurrent du projet, cf. commentaires de
// lib/actions/purchases.ts). On reproduit ici exactement cette requête, même
// convention que tests/rls/purchases.rls.test.ts.
// ──────────────────────────────────────────────────────────────────────────

describe('setPurchaseLotAllocationMethodAction / setPurchaseLotLineWeightAction — garde tenant/boutique (reproduction de la requête applicative)', () => {
  skipIfNoServiceRole(
    "un lot d'une autre boutique du même tenant est invisible à la garde (setPurchaseLotAllocationMethodAction traiterait ceci comme « Lot introuvable »)",
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('setmethod-cross-shop');
      const owner = await signIn(email);
      const shopB = await createShop(
        admin,
        merchantAccountId,
        `f2-setmethod-shopB-${Date.now()}.internal`,
      );
      const productB = await createProduct(admin, merchantAccountId, shopB);
      const { lotId: lotIdB } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopB,
        userId,
        productB,
        5,
        50_000,
        0,
      );

      // Requête identique à la garde de setPurchaseLotAllocationMethodAction :
      // shopId = boutique ACTIVE (shopA), lot réellement dans shopB.
      const found = await admin
        .from('purchase_lot')
        .select('id')
        .eq('id', lotIdB)
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopId)
        .maybeSingle();

      expect(found.data).toBeNull();
    },
  );

  skipIfNoServiceRole(
    "une ligne d'un lot d'une autre boutique du même tenant est invisible à la garde (setPurchaseLotLineWeightAction traiterait ceci comme une non-mise à jour silencieuse)",
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('setweight-cross-shop');
      const owner = await signIn(email);
      const shopB = await createShop(
        admin,
        merchantAccountId,
        `f2-setweight-shopB-${Date.now()}.internal`,
      );
      const productB = await createProduct(admin, merchantAccountId, shopB);
      const { lotId: lotIdB, purchaseLotLineId: lineIdB } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopB,
        userId,
        productB,
        5,
        50_000,
        0,
      );

      // Requête identique à la garde de setPurchaseLotLineWeightAction :
      // shopId = boutique ACTIVE (shopA), ligne/lot réellement dans shopB.
      const found = await admin
        .from('purchase_lot_line')
        .select('id')
        .eq('id', lineIdB)
        .eq('purchase_lot_id', lotIdB)
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopId)
        .maybeSingle();

      expect(found.data).toBeNull();
    },
  );

  skipIfNoServiceRole(
    'contrôle positif : un lot de la bonne boutique/tenant est bien trouvé par la garde',
    async () => {
      const { admin, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('setmethod-positive');
      const owner = await signIn(email);
      const productId = await createProduct(admin, merchantAccountId, shopId);
      const { lotId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        5,
        50_000,
        0,
      );

      const found = await admin
        .from('purchase_lot')
        .select('id')
        .eq('id', lotId)
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopId)
        .maybeSingle();

      expect(found.data?.id).toBe(lotId);
    },
  );
});
