import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import {
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  hasSupabaseAdmin,
  landOnTarget,
  loginViaForm,
  supabaseUrl,
  waitForMerchant,
} from './helpers/auth';

/**
 * Phase F — Lot U1-F, preuve 5.4, REPORTÉE sur un écran réel (Lot F2-bis) : la page de
 * démonstration `/dev/finance-foundations` a été supprimée une fois les écrans réels
 * équivalents en place (cf. docs/lexique-microcopie.md, « Page de démonstration retirée »).
 *
 * « Mesurer, dans le style du composant `Amount`, que deux montants occupent la même largeur
 * par chiffre. » jsdom ne fait pas de layout réel (voir tests/unit/ui/*) — seule une mesure en
 * navigateur réel (Playwright) prouve quoi que ce soit ici. Si les largeurs diffèrent, ce test
 * échoue délibérément : le rapport de fin de lot doit alors constater que les chiffres
 * tabulaires ne sont pas obtenus avec la police actuelle, sans changer de police.
 *
 * Écran réel choisi : la Fiche arrivage (`purchase-lot-detail-panel.tsx`, via
 * `/produits?tab=achats`). Deux `<Amount>` y sont dérivés SANS aucune répartition
 * proportionnelle qui introduirait un arrondi imprévisible :
 *   - « CA encaissé » = somme des commandes livrées+encaissées de l'arrivage — ici UNE
 *     seule commande, total exactement 111111 F CFA.
 *   - « Dépenses publicitaires » = publicité du produit répartie entre ses lignes de CE lot —
 *     ici UNE seule ligne pour ce produit, donc 100 % de la dépense (888888 F CFA) sur cette
 *     ligne, passthrough exact (cf. commentaire de `computeAdSpendByLine`,
 *     lib/finance/lot-profitability-assembly.ts).
 * Convention de seed reprise de tests/e2e/lot-f2-purchase-lot-detail.spec.ts (aucun module de
 * fixtures partagé dans ce dépôt, cf. son commentaire de tête).
 */

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function signInSupabaseJs(email: string): Promise<SupabaseClient> {
  assertLocalSupabase(supabaseUrl);
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: e2ePassword });
  if (error) throw error;
  return client;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  const shopId = await waitForDefaultShop(admin, merchantAccountId);
  return { admin, email, merchantAccountId, shopId, userIds: [userId], userId };
}

async function waitForDefaultShop(admin: AdminClient, merchantAccountId: string): Promise<string> {
  let shopId = '';
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('shop')
          .select('id')
          .eq('merchant_account_id', merchantAccountId)
          .eq('is_default', true)
          .limit(1)
          .maybeSingle();
        shopId = (data?.id as string | undefined) ?? '';
        return shopId;
      },
      { timeout: 10_000, intervals: [150, 300, 500] },
    )
    .not.toBe('');
  return shopId;
}

async function createProduct(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      title: `Produit Tabulaire E2E ${Date.now()}`,
      unit_cost: 0,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id as string;
}

async function createDriver(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur Tabulaire E2E ${Date.now()}`,
      phone: '+221770000001',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');
  await admin
    .from('driver_shop')
    .insert({ merchant_account_id: merchantAccountId, shop_id: shopId, driver_id: data.id });
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

function receiveRpc(client: SupabaseClient) {
  return client.rpc.bind(client) as unknown as (
    fn: 'receive_purchase_lot',
    args: ReceiveRpcArgs,
  ) => Promise<{ data: null; error: { message: string } | null }>;
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

function transitionRpc(client: SupabaseClient) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionOrderArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

async function receiveLot(
  admin: AdminClient,
  ownerRpcClient: SupabaseClient,
  merchantAccountId: string,
  shopId: string,
  userId: string,
  productId: string,
  supplierName: string,
) {
  const { data: lot, error: lotErr } = await admin
    .from('purchase_lot')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      supplier_name: supplierName,
      ordered_at: '2026-04-01',
      transport_total: 0,
    })
    .select('id')
    .single();
  if (lotErr || !lot) throw lotErr ?? new Error('purchase_lot insert failed');

  const { data: line, error: lineErr } = await admin
    .from('purchase_lot_line')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      purchase_lot_id: lot.id,
      product_id: productId,
      qty: 1,
      purchase_price_total: 1,
    })
    .select('id')
    .single();
  if (lineErr || !line) throw lineErr ?? new Error('purchase_lot_line insert failed');

  const { error } = await receiveRpc(ownerRpcClient)('receive_purchase_lot', {
    p_lot_id: lot.id,
    p_merchant_account_id: merchantAccountId,
    p_actor_id: userId,
    p_lines: [
      {
        line_id: line.id,
        line_value: 1,
        allocated_fees: 0,
        landed_total_value: 1,
        landed_unit_cost: 1,
      },
    ],
  });
  if (error) throw new Error(`receive_purchase_lot failed: ${error.message}`);

  return { lotId: lot.id as string };
}

async function createOrderWithLine(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  driverId: string,
  productId: string,
  totalAmount: number,
) {
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_number: `TABNUM-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
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
  if (orderErr || !order) throw orderErr ?? new Error('order insert failed');

  const { error: lineErr } = await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    order_id: order.id,
    product_id: productId,
    raw_title: 'Produit Tabulaire E2E',
    qty: 1,
    match_status: 'matched',
  });
  if (lineErr) throw lineErr;

  return order.id as string;
}

/** Confirmer → programmer → dispatch → livrer (encaissé). */
async function deliverAndCollect(client: SupabaseClient, userId: string, orderId: string) {
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

async function insertAdSpend(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  productId: string,
  purchaseLotId: string,
  userId: string,
  amountMinor: number,
) {
  const { error } = await admin.from('product_ad_spend').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    product_id: productId,
    purchase_lot_id: purchaseLotId,
    amount_minor: amountMinor,
    spent_at: '2026-04-02',
    source: 'manuel',
    created_by: userId,
  });
  if (error) throw error;
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await loginViaForm(page, email, e2ePassword, redirectTo);
  await landOnTarget(page, redirectTo, 30_000);
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
}

async function openLotProfitabilityPanel(page: Page, supplierName: string) {
  await page.goto('/produits?tab=achats');
  await expect(page.getByText(supplierName, { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Voir la rentabilité' }).click();
  await expect(page.getByText(`Rentabilité — ${supplierName}`, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

test.setTimeout(60_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E');

test('chiffres tabulaires : deux montants réels (111111 F et 888888 F) occupent la même largeur par chiffre', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('u1f-tabular-nums');
  const supplierName = `Fournisseur Tabulaire ${Date.now()}`;

  try {
    const ownerRpcClient = await signInSupabaseJs(fixture.email);
    const productId = await createProduct(fixture.admin, fixture.merchantAccountId, fixture.shopId);
    const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, fixture.shopId);
    const { lotId } = await receiveLot(
      fixture.admin,
      ownerRpcClient,
      fixture.merchantAccountId,
      fixture.shopId,
      fixture.userId,
      productId,
      supplierName,
    );

    // CA encaissé = 111111 F CFA exactement (une seule commande, aucune répartition).
    const orderId = await createOrderWithLine(
      fixture.admin,
      fixture.merchantAccountId,
      fixture.shopId,
      driverId,
      productId,
      111_111,
    );
    await deliverAndCollect(ownerRpcClient, fixture.userId, orderId);

    // Dépenses publicitaires = 888888 F CFA exactement (une seule ligne pour ce
    // produit dans ce lot → passthrough intégral, aucun arrondi de répartition).
    await insertAdSpend(
      fixture.admin,
      fixture.merchantAccountId,
      fixture.shopId,
      productId,
      lotId,
      fixture.userId,
      888_888,
    );

    await signIn(page, fixture.email, '/produits?tab=achats');
    await openLotProfitabilityPanel(page, supplierName);

    const widths = await page.evaluate(() => {
      const amounts = Array.from(document.querySelectorAll('[data-testid="amount"]'));
      const digitsOnly = (el: Element) => (el.textContent ?? '').replace(/[^0-9]/g, '');
      const narrow = amounts.find((el) => digitsOnly(el) === '111111');
      const wide = amounts.find((el) => digitsOnly(el) === '888888');
      return {
        narrow: narrow ? narrow.getBoundingClientRect().width : null,
        wide: wide ? wide.getBoundingClientRect().width : null,
      };
    });

    expect(widths.narrow).not.toBeNull();
    expect(widths.wide).not.toBeNull();

    // biome-ignore lint/style/noNonNullAssertion: vérifié juste au-dessus.
    const widthDelta = Math.abs(widths.narrow! - widths.wide!);

    // Sous-pixel toléré (arrondi de rendu du navigateur) — pas une marge
    // d'approximation sur la règle elle-même. Un écart d'un pixel ou plus
    // signifie que les chiffres ne sont PAS tabulaires avec la police actuelle.
    expect(widthDelta).toBeLessThan(1);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
