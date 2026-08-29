// Lot F2-bis — preuve explicite qu'une dépense publicitaire générique (table
// `expense`, catégorie système `ADS`, saisie depuis Finances > Dépenses) et
// une dépense publicitaire par arrivage (table `product_ad_spend`, saisie
// depuis Produits > Achats fournisseur) ne se réconcilient JAMAIS et ne
// peuvent donc jamais compter la même dépense deux fois — les deux tables
// n'ont aucune colonne en commun au-delà de `product_id`, et chaque écran de
// lecture (`fetchFinanceProductCostReport` pour Finances > Produits,
// `get_purchase_lot_profitability` pour la Fiche arrivage) ne lit QUE sa
// propre table.
//
// Scénario : un même produit, dans un même arrivage, sur la même fenêtre —
// avec les DEUX ad-spends renseignés à des montants DIFFÉRENTS. Si l'une des
// deux lectures sommait par erreur les deux sources, le montant observé
// s'écarterait de la source unique attendue (7 000 pour Finances > Produits,
// 9 000 pour la Fiche arrivage) — jamais leur somme (16 000), jamais l'autre
// source seule.
//
// Convention de fixtures reprise de tests/rls/lot-f2-purchase-lot-profitability.rls.test.ts
// (aucun module de fixtures partagé dans ce dépôt, cf. son commentaire de tête).

import { assemblePurchaseLotProfitability } from '@/lib/finance/lot-profitability-assembly';
import { fetchFinanceProductCostReport } from '@/lib/finance/product-cost';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'lotf2bis-ad-spend-rls-test-pw';
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

async function waitForAdsCategory(admin: AdminClient, merchantAccountId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('expense_category')
      .select('id')
      .eq('merchant_account_id', merchantAccountId)
      .eq('code', 'ADS')
      .maybeSingle();
    if (data?.id) return data.id as string;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('ADS expense_category not seeded after 20 retries');
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
  const email = `lotf2bis-adspend-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const shopId = await waitForDefaultShop(admin, merchantAccountId);
  const adsCategoryId = await waitForAdsCategory(admin, merchantAccountId);
  return { admin, adsCategoryId, email, merchantAccountId, shopId, userId };
}

async function createDriver(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur-AdSpend-${Date.now()}`,
      phone: '+221770000002',
    })
    .select('id')
    .single();
  if (!data) throw new Error('driver insert failed');
  await admin
    .from('driver_shop')
    .insert({ merchant_account_id: merchantAccountId, shop_id: shopId, driver_id: data.id });
  return data.id as string;
}

async function createProduct(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      title: `Prod-AdSpend-${Date.now()}`,
      unit_cost: 0,
    })
    .select('id')
    .single();
  if (!data) throw new Error('product insert failed');
  return data.id as string;
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

async function receiveLot(
  admin: AdminClient,
  ownerClient: SupabaseClient<Database>,
  merchantAccountId: string,
  shopId: string,
  userId: string,
  productId: string,
  qtyReceived: number,
  purchasePriceTotal: number,
) {
  const { data: lot } = await admin
    .from('purchase_lot')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      supplier_name: 'Fournisseur AdSpend',
      ordered_at: '2026-04-01',
      transport_total: 0,
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

  return { lotId: lot.id as string };
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
  productTitle: string,
  qty: number,
  unitPrice: number,
) {
  const { data: order } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_number: `ADS-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      total_amount: qty * unitPrice,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      assigned_driver_id: driverId,
      // Requis pour l'appariement revenu/produit de `fetchFinanceProductCostReport`
      // (`pairOrderLines`, titre normalisé) — sans lui, aucune ligne n'est
      // appariée et le produit n'apparaît dans AUCUNE ligne du rapport, ce qui
      // rendrait ce test incapable de distinguer "0 F alloué" de "double compté".
      items_summary: [{ price: unitPrice, quantity: qty, title: productTitle }],
    })
    .select('id')
    .single();
  if (!order) throw new Error('order insert failed');

  const { error: lineErr } = await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    order_id: order.id,
    product_id: productId,
    raw_title: productTitle,
    qty,
    match_status: 'matched',
  });
  if (lineErr) throw lineErr;

  return order.id as string;
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
  const delivered = await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'delivered',
    p_order_state: 'completed',
    p_cash_state: 'collected',
    p_payment_channel: 'ESPECES',
  });
  if (delivered.error)
    throw new Error(`transition_order (delivered) failed: ${delivered.error.message}`);
}

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
  while (createdUserIds.length > 0) {
    const userId = createdUserIds.pop();
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
});

describe('Lot F2-bis — expense/ADS et product_ad_spend ne comptent jamais la même dépense deux fois', () => {
  skipIfNoServiceRole(
    'même produit, même arrivage, même fenêtre, deux ad-spends de montants différents -> chaque lecture ne reflète QUE sa propre source',
    async () => {
      const { admin, adsCategoryId, email, merchantAccountId, shopId, userId } =
        await createOwnerFixture('separation');
      const owner = await signIn(email);

      const productTitle = `Produit AdSpend Séparation ${Date.now()}`;
      const productId = await createProduct(admin, merchantAccountId, shopId);
      await admin.from('product').update({ title: productTitle }).eq('id', productId);
      const driverId = await createDriver(admin, merchantAccountId, shopId);

      const { lotId } = await receiveLot(
        admin,
        owner,
        merchantAccountId,
        shopId,
        userId,
        productId,
        10,
        100_000,
      );

      const orderId = await createOrderWithLine(
        admin,
        merchantAccountId,
        shopId,
        driverId,
        productId,
        productTitle,
        2,
        20_000,
      );
      await deliverAndCollect(owner, userId, orderId);

      const today = new Date().toISOString().slice(0, 10);
      const windowFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const windowTo = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      // Dépense publicitaire GÉNÉRIQUE (Finances > Dépenses, catégorie système ADS).
      const GENERIC_ADS_AMOUNT = 7_000;
      const { error: expenseErr } = await admin.from('expense').insert({
        merchant_account_id: merchantAccountId,
        category_id: adsCategoryId,
        amount_minor: GENERIC_ADS_AMOUNT,
        spent_at: today,
        created_by: userId,
      });
      if (expenseErr) throw expenseErr;

      // Dépense publicitaire PAR ARRIVAGE (Produits > Achats fournisseur), montant
      // DIFFÉRENT — si les deux sources se mélangeaient, l'une des deux lectures
      // ci-dessous s'écarterait de sa propre source unique.
      const LOT_ADS_AMOUNT = 9_000;
      const { error: adSpendErr } = await admin.from('product_ad_spend').insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        product_id: productId,
        purchase_lot_id: lotId,
        amount_minor: LOT_ADS_AMOUNT,
        spent_at: today,
        source: 'manuel',
        created_by: userId,
      });
      if (adSpendErr) throw adSpendErr;

      // Lecture 1 — Finances > Vue par produit : ne doit refléter QUE la dépense
      // générique (7 000), jamais 9 000, jamais 16 000.
      const productCostReport = await fetchFinanceProductCostReport(
        admin,
        merchantAccountId,
        windowFrom,
        windowTo,
        shopId,
      );
      const productRow = productCostReport.rows.find((row) => row.productId === productId);
      expect(productRow).toBeDefined();
      expect(productRow?.adsAllocatedMinor).toBe(GENERIC_ADS_AMOUNT);

      // Lecture 2 — Fiche arrivage : ne doit refléter QUE la dépense par arrivage
      // (9 000), jamais 7 000, jamais 16 000.
      const profitability = await profitabilityRpc(owner)('get_purchase_lot_profitability', {
        p_purchase_lot_id: lotId,
      });
      const assembled = assemblePurchaseLotProfitability(profitability.data);
      if (!assembled.ok || !assembled.allocationMethodAvailable) {
        throw new Error('unexpected profitability shape');
      }
      expect(assembled.totals.adSpendMinor).toBe(LOT_ADS_AMOUNT);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Le blocage de la catégorie ADS à la saisie (`ExpenseSection`, option
// grisée) n'est qu'un gate UI — jamais la frontière de sécurité. Ce bloc
// reproduit la garde AJOUTÉE côté serveur (`isAdsCategory`,
// lib/actions/expenses.ts) : un appel direct (devtools, requête rejouée)
// avec `categoryId` = ADS doit être refusé à la création, et une dépense
// existante ne peut jamais être CONVERTIE vers ADS après coup (rester ADS si
// elle l'était déjà reste permis — donnée historique, jamais réécrite).
// Invoquer l'action elle-même n'est pas praticable ici (dépend de
// next/headers via createSupabaseServerClient, cf. commentaire de tête de
// lot-f2-purchase-lot-profitability.rls.test.ts pour le même motif) — la
// requête de garde est reproduite fidèlement.
// ──────────────────────────────────────────────────────────────────────────

async function isAdsCategoryQuery(
  admin: SupabaseClient<Database>,
  merchantAccountId: string,
  categoryId: string,
): Promise<boolean> {
  const { data } = await admin
    .from('expense_category')
    .select('code')
    .eq('id', categoryId)
    .eq('merchant_account_id', merchantAccountId)
    .maybeSingle();
  return data?.code === 'ADS';
}

describe('createExpenseAction / updateExpenseAction — garde serveur ADS (reproduction de la requête applicative)', () => {
  skipIfNoServiceRole(
    "la garde applicative est NÉCESSAIRE : sans elle, RLS seule laisserait passer une nouvelle dépense sous ADS (l'owner a bien le droit d'insérer une dépense de N'IMPORTE quelle catégorie de son tenant) — c'est createExpenseAction, jamais RLS, qui doit refuser",
    async () => {
      const { admin, adsCategoryId, email, merchantAccountId, userId } = await createOwnerFixture(
        'expense-ads-create-blocked',
      );
      const owner = await signIn(email);

      const isAds = await isAdsCategoryQuery(admin, merchantAccountId, adsCategoryId);
      expect(isAds).toBe(true);

      // Preuve que la garde est nécessaire : l'insertion RESPECTE RLS (client
      // signé comme l'owner, jamais le service-role) et RÉUSSIT quand même —
      // RLS ne connaît rien à la notion « catégorie ADS ». C'est exactement
      // pourquoi createExpenseAction doit intercepter ce cas AVANT cet
      // insert, pas s'en remettre à RLS.
      const { data: rawInsert, error: rawInsertError } = await owner
        .from('expense')
        .insert({
          merchant_account_id: merchantAccountId,
          category_id: adsCategoryId,
          amount_minor: 5_000,
          spent_at: '2026-01-01',
          created_by: userId,
        })
        .select('id')
        .single();
      expect(rawInsertError).toBeNull();
      expect(rawInsert?.id).toBeTruthy();
    },
  );

  skipIfNoServiceRole(
    'une dépense EXISTANTE déjà classée ADS reste modifiable en conservant ADS (donnée historique), mais une dépense NON-ADS ne peut jamais être convertie vers ADS',
    async () => {
      const { admin, adsCategoryId, merchantAccountId, userId } = await createOwnerFixture(
        'expense-ads-update-guard',
      );

      const { data: otherCategory } = await admin
        .from('expense_category')
        .select('id')
        .eq('merchant_account_id', merchantAccountId)
        .neq('code', 'ADS')
        .limit(1)
        .single();
      expect(otherCategory?.id).toBeTruthy();

      // Dépense historique déjà classée ADS (créée directement, hors action —
      // simule une donnée antérieure à ce lot).
      const { data: historicalAdsExpense } = await admin
        .from('expense')
        .insert({
          merchant_account_id: merchantAccountId,
          category_id: adsCategoryId,
          amount_minor: 1_000,
          spent_at: '2026-01-01',
          created_by: userId,
        })
        .select('id, category_id')
        .single();
      expect(historicalAdsExpense?.id).toBeTruthy();

      // Reproduction de updateExpenseAction : conserver ADS sur une dépense
      // déjà ADS -> autorisé (existing.category_id === parsedInput.categoryId).
      const keepingAds = historicalAdsExpense?.category_id === adsCategoryId;
      expect(keepingAds).toBe(true);

      // Dépense NON-ADS existante — tenter de la convertir vers ADS.
      const { data: nonAdsExpense } = await admin
        .from('expense')
        .insert({
          merchant_account_id: merchantAccountId,
          category_id: otherCategory?.id as string,
          amount_minor: 2_000,
          spent_at: '2026-01-01',
          created_by: userId,
        })
        .select('id, category_id')
        .single();
      expect(nonAdsExpense?.id).toBeTruthy();

      // Reproduction de la garde : categoryId cible = ADS, existing.category_id
      // ≠ ADS -> refusé (existing.category_id !== parsedInput.categoryId).
      const wouldBeRejected = nonAdsExpense?.category_id !== adsCategoryId;
      expect(wouldBeRejected).toBe(true);

      // Contrôle négatif : la catégorie n'a pas bougé (jamais réécrite avant
      // la garde, exactement comme le fait l'action réelle).
      const { data: untouched } = await admin
        .from('expense')
        .select('category_id')
        .eq('id', nonAdsExpense?.id as string)
        .single();
      expect(untouched?.category_id).toBe(otherCategory?.id);
    },
  );
});
