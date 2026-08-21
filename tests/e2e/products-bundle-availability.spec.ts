import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { callStockMovementEngine } from '@/tests/helpers/stock-movement-engine';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { landOnTarget } from './helpers/auth';
import { grantCurrentConsents } from './helpers/consent';
import { attachDriverToStore, defaultShopId } from './helpers/workspace';

// Bundles PR 2 : disponibilité dérivée sur /produits (tab Stock), aucune
// régression sur /livreurs (un bundle n'y apparaît jamais), et CA par
// produit / Livraisons par produit sur /tableau restent fonctionnels sans
// changement pour un produit bundle (order_line n'est jamais éclaté).

function readLocalEnv(): Record<string, string> {
  if (!existsSync('.env.local')) return {};
  return Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const [key, ...valueParts] = line.split('=');
        return [key, valueParts.join('=').replace(/^["']|["']$/g, '')];
      }),
  );
}

const localEnv = readLocalEnv();
const supabaseUrl =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  localEnv.SUPABASE_URL ??
  localEnv.NEXT_PUBLIC_SUPABASE_URL ??
  '';
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? localEnv.SUPABASE_SERVICE_ROLE_KEY ?? '';
const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);
const password = 'Mot-de-passe-e2e-2026!';

test.setTimeout(90_000);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+bundle-avail-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('Utilisateur E2E non créé');
  await grantCurrentConsents(admin, data.user.id);
  return data.user.id;
}

async function waitForMerchant(admin: AdminClient, userId: string) {
  let merchantAccountId = '';
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('merchant_member')
          .select('merchant_account_id')
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle();
        merchantAccountId = (data?.merchant_account_id as string | undefined) ?? '';
        return merchantAccountId;
      },
      { timeout: 10_000, intervals: [150, 300, 500] },
    )
    .not.toBe('');
  return merchantAccountId;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E Bundle Dispo ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, userId };
}

async function createProduct(
  admin: AdminClient,
  merchantAccountId: string,
  title: string,
  isBundle = false,
) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title,
      unit_cost: 1_000,
      is_active: true,
      is_bundle: isBundle,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id as string;
}

async function seedProductStock(
  admin: AdminClient,
  merchantAccountId: string,
  productId: string,
  qtyOnHand: number,
  qtyReserved = 0,
) {
  const { error } = await admin.from('product_stock').insert({
    merchant_account_id: merchantAccountId,
    product_id: productId,
    qty_on_hand: qtyOnHand,
    qty_reserved: qtyReserved,
  });
  if (error) throw error;
}

async function addBundleComponent(
  admin: AdminClient,
  merchantAccountId: string,
  bundleProductId: string,
  componentProductId: string,
  quantity: number,
) {
  const { error } = await admin.from('product_bundle_component').insert({
    merchant_account_id: merchantAccountId,
    bundle_product_id: bundleProductId,
    component_product_id: componentProductId,
    quantity,
  });
  if (error) throw error;
}

async function createDriver(admin: AdminClient, merchantAccountId: string, fullName: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({ merchant_account_id: merchantAccountId, full_name: fullName, phone: '+221770000001' })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');
  // 0133 : sans rattachement, le livreur n'est plus proposé à l'affectation.
  await attachDriverToStore(admin, merchantAccountId, data.id as string);
  return data.id as string;
}

async function seedDeliveredCollectedOrder(
  admin: AdminClient,
  {
    merchantAccountId,
    productId,
    shopId,
    title,
    totalAmount,
  }: {
    merchantAccountId: string;
    productId: string;
    shopId: string;
    title: string;
    totalAmount: number;
  },
) {
  const timestamp = new Date().toISOString();
  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      source: 'manual',
      order_number: `BUNDLE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: totalAmount,
      cash_collectable_minor: totalAmount,
      delivery_fee_minor: 0,
      currency: 'XOF',
      items_summary: [{ title, quantity: 1, price: totalAmount }],
      order_state: 'completed',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
      cash_collected_at: timestamp,
      created_at: timestamp,
      created_at_shopify: timestamp,
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
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  // Timeout généreux : premier compile dev-mode d'une route jamais visitée
  // dans ce run peut dépasser 30s (observé ~20-30s sur /produits/livreurs/tableau).
  await landOnTarget(page, redirectTo, 60_000);
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
}

function bundleRow(page: Page, title: string): Locator {
  return page.locator('tr', { has: page.getByText(title, { exact: true }) });
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E bundles');

test('produits (stock) : un bundle affiche sa disponibilité dérivée, pas son qty_on_hand propre', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('derived');
  try {
    const support = await createProduct(fixture.admin, fixture.merchantAccountId, 'Support E2E');
    const cable = await createProduct(fixture.admin, fixture.merchantAccountId, 'Câble E2E');
    const bundle = await createProduct(fixture.admin, fixture.merchantAccountId, 'Kit E2E', true);

    // Support/2 requis : 10 en stock → 5 assemblables. Câble/1 requis : 3 en
    // stock → 3 assemblables. Le plus restrictif (Câble) doit s'afficher : 3.
    await seedProductStock(fixture.admin, fixture.merchantAccountId, support, 10);
    await seedProductStock(fixture.admin, fixture.merchantAccountId, cable, 3);
    // product_stock du bundle lui-même volontairement à une valeur trompeuse
    // (999) pour prouver que l'UI ne l'affiche jamais.
    await seedProductStock(fixture.admin, fixture.merchantAccountId, bundle, 999);
    await addBundleComponent(fixture.admin, fixture.merchantAccountId, bundle, support, 2);
    await addBundleComponent(fixture.admin, fixture.merchantAccountId, bundle, cable, 1);

    await signIn(page, fixture.email, '/produits?tab=stock');

    const row = bundleRow(page, 'Kit E2E');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('3');
    await expect(row).not.toContainText('999');
    await expect(row.getByText('Bundle', { exact: true })).toBeVisible();
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('produits (stock) : composant à stock négatif → disponibilité bundle négative, sans plancher', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('negative');
  try {
    const support = await createProduct(
      fixture.admin,
      fixture.merchantAccountId,
      'Support Nég E2E',
    );
    const bundle = await createProduct(
      fixture.admin,
      fixture.merchantAccountId,
      'Kit Nég E2E',
      true,
    );

    // Disponible composant = qty_on_hand(0) - qty_reserved(2) = -2 ; quantité
    // requise = 1 → disponibilité bundle = floor(-2/1) = -2 (pas 0).
    await seedProductStock(fixture.admin, fixture.merchantAccountId, support, 0, 2);
    await addBundleComponent(fixture.admin, fixture.merchantAccountId, bundle, support, 1);

    await signIn(page, fixture.email, '/produits?tab=stock');

    const row = bundleRow(page, 'Kit Nég E2E');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('-2');
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('livreurs : aucun bundle n’apparaît, aucune régression sur le stock livreur normal', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('livreurs-regression');
  try {
    const driverId = await createDriver(
      fixture.admin,
      fixture.merchantAccountId,
      'Livreur Bundle E2E',
    );
    const support = await createProduct(
      fixture.admin,
      fixture.merchantAccountId,
      'Support Livreur E2E',
    );
    const bundle = await createProduct(
      fixture.admin,
      fixture.merchantAccountId,
      'Kit Livreur E2E',
      true,
    );
    await addBundleComponent(fixture.admin, fixture.merchantAccountId, bundle, support, 1);

    // Stock livreur normal (composant) via le ledger réel.
    // 0136 : cœur post_stock_movement dans `private`, non exposé — connexion Postgres
    // directe (callStockMovementEngine simule l'identité via le JWT sub, sans session).
    await callStockMovementEngine({
      p_merchant_account_id: fixture.merchantAccountId,
      p_product_id: support,
      p_movement_type: 'purchase_in',
      p_qty: 20,
      p_idempotency_key: `bundle-livreur-in:${support}`,
      p_created_by: fixture.userId,
      p_unit_cost: 1_000,
    });
    await callStockMovementEngine({
      p_merchant_account_id: fixture.merchantAccountId,
      p_product_id: support,
      p_movement_type: 'dispatch',
      p_qty: -8,
      p_idempotency_key: `bundle-livreur-disp:${support}`,
      p_created_by: fixture.userId,
      p_driver_id: driverId,
    });

    await signIn(page, fixture.email, `/livreurs?driver=${driverId}`);
    await expect(page.getByRole('heading', { name: 'Livreur Bundle E2E' })).toBeVisible({
      timeout: 15_000,
    });

    // Le composant apparaît normalement (aucune régression PR 2 sur /livreurs).
    await expect(page.locator(':visible', { hasText: 'Support Livreur E2E' }).last()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(':visible', { hasText: '8' }).last()).toBeVisible({
      timeout: 15_000,
    });

    // Le bundle lui-même n'apparaît jamais dans /livreurs (PR 1 : jamais
    // chargeable directement sur un livreur).
    await expect(page.getByText('Kit Livreur E2E')).toHaveCount(0);
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('tableau : CA par produit / Livraisons par produit fonctionnent sans changement pour un bundle vendu', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('tableau');
  try {
    const shopId = await defaultShopId(fixture.admin, fixture.merchantAccountId);
    const bundle = await createProduct(
      fixture.admin,
      fixture.merchantAccountId,
      'Kit Tableau E2E',
      true,
    );

    // order_line n'est jamais éclaté en composants (0109) : le bundle apparaît
    // comme un produit normal dans les deux blocs, sans changement de code.
    await seedDeliveredCollectedOrder(fixture.admin, {
      merchantAccountId: fixture.merchantAccountId,
      productId: bundle,
      shopId,
      title: 'Kit Tableau E2E',
      totalAmount: 12_000,
    });

    await signIn(page, fixture.email, '/tableau');

    await page.getByRole('button', { name: /Choisir la période/ }).click();
    await page
      .getByRole('button', { name: messages.periodPicker.presets['30j'], exact: true })
      .click();
    await expect(page).toHaveURL(/period=30j/);

    const cashPeriodCard = page.locator('section.rounded-lg').filter({
      has: page.getByText(messages.tableau.blocks.operationsEssentials.cashCollected.label, {
        exact: true,
      }),
    });
    const deliveriesCard = page.locator('section.rounded-lg').filter({
      has: page.getByText(messages.tableau.blocks.operationsEssentials.deliveries.label, {
        exact: true,
      }),
    });

    await expect(cashPeriodCard).toContainText(/12.?000/);
    await expect(deliveriesCard).toContainText('1');
    await expect(page.getByText('CA par produit', { exact: true })).toHaveCount(1);
    const chart = page.getByTestId('tableau-cash-by-product-chart');
    await expect(chart).toBeVisible();
    // Labels tronqués sur mobile (composant local, PR #85) : le rendu peut
    // coller le titre au montant sans espace ("Kit TableauE2E12 k F") selon
    // le viewport — on vérifie juste que le début du titre du bundle apparaît.
    await expect(chart).toContainText(/Kit Tableau/);
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});
