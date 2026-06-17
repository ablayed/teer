import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { grantCurrentConsents } from './helpers/consent';

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
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+phase6-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.merchant_account_id) return data.merchant_account_id as string;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account introuvable');
}

async function waitForCategories(admin: AdminClient, merchantAccountId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('expense_category')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    if (data && data.length > 0) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('expense_categories non seedées');
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E Phase6 ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  await waitForCategories(admin, merchantAccountId);
  return { admin, email, merchantAccountId, userId };
}

// Sème une commande encaissée dans la période + un mouvement sold au coût figé connu,
// pour prouver un COGS non nul (marge brute ≠ 100 %) bout-en-bout.
async function seedCollectedOrderWithCogs(
  admin: AdminClient,
  merchantAccountId: string,
  userId: string,
) {
  const { data: product } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title: `Produit COGS ${Date.now()}`,
      unit_cost: 5000,
    })
    .select('id')
    .single();
  if (!product) throw new Error('product insert returned no row');
  await admin.from('product_stock').upsert(
    {
      product_id: product.id,
      merchant_account_id: merchantAccountId,
      qty_on_hand: 50,
      unit_cost: 5000,
    },
    { onConflict: 'product_id' },
  );
  const { data: order } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      source: 'manual',
      order_number: `COGS-${Date.now()}`,
      total_amount: 20000,
      currency: 'XOF',
      items_summary: [{ title: 'Produit COGS', quantity: 2, price: 10000 }],
      order_state: 'completed',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
      cash_collected_at: new Date().toISOString(),
      payment_channel_at_delivery: 'ESPECES',
    })
    .select('id')
    .single();
  if (!order) throw new Error('order insert returned no row');
  await admin.from('stock_movement').insert({
    merchant_account_id: merchantAccountId,
    product_id: product.id,
    order_id: order.id,
    movement_type: 'sold',
    qty: 2,
    unit_cost: 5000,
    idempotency_key: `e2e-sold-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    created_by: userId,
  });
}

// Commande encaissée avec des montants FRACTIONNAIRES : `orders.total_amount` est
// `numeric` et le prix `items_summary` est du jsonb libre (devise majeure Shopify).
// Reproduit le crash prod BigInt(2536.06) sur tab=produits ET tab=livreurs.
async function seedFractionalCollectedOrder(
  admin: AdminClient,
  merchantAccountId: string,
  userId: string,
) {
  const { data: product } = await admin
    .from('product')
    .insert({ merchant_account_id: merchantAccountId, title: 'Produit Frac', unit_cost: 5000 })
    .select('id')
    .single();
  if (!product) throw new Error('product insert returned no row');
  await admin.from('product_stock').upsert(
    {
      product_id: product.id,
      merchant_account_id: merchantAccountId,
      qty_on_hand: 50,
      unit_cost: 5000,
    },
    { onConflict: 'product_id' },
  );
  const { data: driver } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Livreur Frac',
      phone: `+22177${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    })
    .select('id')
    .single();
  if (!driver) throw new Error('driver insert returned no row');
  const title = 'Sac Frac';
  const { data: order } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      source: 'manual',
      order_number: `FRAC-${Date.now()}`,
      total_amount: 2536.06,
      delivery_fee_minor: 0,
      currency: 'XOF',
      items_summary: [{ title, quantity: 2, price: 2536.06 }],
      order_state: 'completed',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
      cash_collected_at: new Date().toISOString(),
      assigned_driver_id: driver.id,
      payment_channel_at_delivery: 'ESPECES',
    })
    .select('id')
    .single();
  if (!order) throw new Error('order insert returned no row');
  await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    order_id: order.id,
    product_id: product.id,
    raw_title: title,
    qty: 2,
    match_status: 'matched',
  });
  await admin.from('stock_movement').insert({
    merchant_account_id: merchantAccountId,
    product_id: product.id,
    order_id: order.id,
    driver_id: driver.id,
    movement_type: 'sold',
    qty: 2,
    unit_cost: 5000,
    idempotency_key: `e2e-frac-sold-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    created_by: userId,
  });
}

async function signIn(page: Page, email: string, redirectTo = '/finances') {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await page.waitForLoadState('networkidle');
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E finances');

test('page finances : bannière disclaimer + section dépenses visible pour owner', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('disclaimer');
  try {
    await signIn(page, fixture.email, '/finances');

    // Bannière vue de gestion
    await expect(page.getByText(messages.finance.disclaimer, { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // Section dépenses
    await expect(page.getByText(messages.finance.expense.title, { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // Bouton ajouter
    await expect(page.getByRole('button', { name: messages.finance.expense.add })).toBeVisible();
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test("ajout d'une dépense → apparaît dans la liste et réduit le résultat", async ({ page }) => {
  const fixture = await createOwnerFixture('add-expense');
  try {
    await signIn(page, fixture.email, '/finances');

    // Ouvrir le formulaire
    await page.getByRole('button', { name: messages.finance.expense.add }).click();

    // Remplir — montant et date
    await page.locator('#expense-amount').fill('25000');
    await page.locator('#expense-date').fill('2026-06-01');

    // Enregistrer
    await page.getByRole('button', { name: messages.finance.expense.save }).click();

    // Confirmation
    await expect(page.getByText(messages.finance.expense.success)).toBeVisible({ timeout: 10_000 });

    // Le total dépenses confirme la dépense ajoutée (ligne unique ExpenseSection)
    await expect(page.getByText(messages.finance.expense.total, { exact: false })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('nav finances absente pour un manager', async ({ page }) => {
  const fixture = await createOwnerFixture('nav-manager');
  const managerEmail = e2eEmail('mgr');
  const managerUserId = await createConfirmedUser(fixture.admin, managerEmail);
  await fixture.admin.from('merchant_account').delete().eq('owner_user_id', managerUserId);
  await fixture.admin.from('merchant_member').insert({
    merchant_account_id: fixture.merchantAccountId,
    user_id: managerUserId,
    role: 'manager',
  });

  try {
    await signIn(page, managerEmail, '/commandes');

    // Le lien finances ne doit pas être dans la nav
    const financeLink = page.getByRole('link', { name: messages.nav.finances, exact: true });
    await expect(financeLink).not.toBeVisible();

    // En accès direct : message restreint
    await page.goto('/finances');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(messages.finance.restricted, { exact: false })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
    await fixture.admin.auth.admin.deleteUser(managerUserId);
  }
});

test('CA unifié + onglets finances + graphe CA par boutique + exports PDF/CSV (owner)', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('cards-charts');
  try {
    await signIn(page, fixture.email, '/finances');

    // CA unifié + onglets
    await expect(
      page.getByText(messages.finance.kpis.caUnified, { exact: true }).first(),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: messages.finance.tabs.products })).toBeVisible();
    await expect(page.getByRole('link', { name: messages.finance.tabs.drivers })).toBeVisible();
    await expect(
      page.getByText(messages.finance.kpis.netProfit, { exact: true }).first(),
    ).toBeVisible();

    // Exports : PDF (lien) + CSV SYSCOHADA (bouton) coexistent
    await expect(page.getByRole('link', { name: messages.finance.report.download })).toBeVisible();
    await expect(page.getByRole('button', { name: messages.finance.profit.csv })).toBeVisible();

    // Graphe CA encaissé par boutique (titre rendu même sans données)
    await expect(page.getByText(messages.finance.charts.shops, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('link', { name: messages.finance.tabs.products }).click();
    await expect(page.getByText(messages.finance.products.title, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('link', { name: messages.finance.tabs.drivers }).click();
    await expect(page.getByText(messages.finance.driverCost.title, { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Le PDF se génère réellement sur la période (cookies de session transmis)
    const today = new Date().toISOString().slice(0, 10);
    const pdf = await page.request.get(`/api/rapport?from=${today}&to=${today}`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('Vue par produit + par livreur : montants fractionnaires (numeric/jsonb) rendent sans 500', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('frac-bigint');
  try {
    await seedFractionalCollectedOrder(fixture.admin, fixture.merchantAccountId, fixture.userId);

    // Vue par produit : la ligne au prix items_summary fractionnaire (2536.06) rend
    // réellement — avant le fix, BigInt(float) levait un 500 RangeError.
    await signIn(page, fixture.email, '/finances?tab=produits');
    await expect(page.getByRole('heading', { name: messages.finance.products.title })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Produit Frac', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Vue par livreur : total_amount numeric fractionnaire → COGS/CA rendus, pas de 500.
    await page.goto('/finances?tab=livreurs');
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('heading', { name: messages.finance.driverCost.title }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Livreur Frac', { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('COGS réel sur commande encaissée à coût connu → marge brute < 100 %', async ({ page }) => {
  const fixture = await createOwnerFixture('cogs');
  try {
    await seedCollectedOrderWithCogs(fixture.admin, fixture.merchantAccountId, fixture.userId);
    await signIn(page, fixture.email, '/finances');

    const pnl = page.locator('section').filter({ hasText: messages.finance.profit.title });

    // COGS issu du coût figé → badge « Marge réelle »…
    await expect(pnl.getByText(messages.finance.profit.marginReal)).toBeVisible({
      timeout: 15_000,
    });
    // …et marge brute ≠ 100 % (le bug COGS=0 affichait 100 %). CA 20 000 − COGS 10 000 = 50 %.
    await expect(pnl.getByText('100 %')).toHaveCount(0);
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('nav finances absente pour un agent', async ({ page }) => {
  const fixture = await createOwnerFixture('nav-agent');
  const agentEmail = e2eEmail('agent');
  const agentUserId = await createConfirmedUser(fixture.admin, agentEmail);
  await fixture.admin.from('merchant_account').delete().eq('owner_user_id', agentUserId);
  await fixture.admin.from('merchant_member').insert({
    merchant_account_id: fixture.merchantAccountId,
    user_id: agentUserId,
    role: 'agent',
  });

  try {
    await signIn(page, agentEmail, '/commandes');

    const financeLink = page.getByRole('link', { name: messages.nav.finances, exact: true });
    await expect(financeLink).not.toBeVisible();
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
    await fixture.admin.auth.admin.deleteUser(agentUserId);
  }
});
