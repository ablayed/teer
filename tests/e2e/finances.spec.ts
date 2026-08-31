import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { landOnTarget } from './helpers/auth';
import { grantCurrentConsents } from './helpers/consent';
import { attachDriverToStore } from './helpers/workspace';

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
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  localEnv.SUPABASE_ANON_KEY ??
  '';
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

// 0148 — transition_order confronte désormais p_actor à auth.uid() : le
// service-role n'a pas de session, auth.uid() y est nul. Un appel RPC direct
// hors interface doit passer par une session utilisateur réelle, comme
// lib/actions/transitions.ts le fait toujours en production.
async function signInClient(email: string): Promise<AdminClient> {
  assertLocalSupabase(supabaseUrl);
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
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

async function waitForCategories(admin: AdminClient, merchantAccountId: string) {
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('expense_category')
          .select('id')
          .eq('merchant_account_id', merchantAccountId);
        return data?.length ?? 0;
      },
      { timeout: 10_000, intervals: [150, 300, 500] },
    )
    .toBeGreaterThan(0);
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
  await attachDriverToStore(admin, merchantAccountId, driver.id as string);
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

// Commande encaissée d'un produit JAMAIS costé (unit_cost null) → coût manquant.
// La ligne apparaît par appariement items_summary ↔ order_line, sans COGS figé.
async function seedMissingCostOrder(admin: AdminClient, merchantAccountId: string, title: string) {
  const { data: product } = await admin
    .from('product')
    .insert({ merchant_account_id: merchantAccountId, title })
    .select('id')
    .single();
  if (!product) throw new Error('product insert returned no row');
  const { data: order } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      source: 'manual',
      order_number: `MISS-${Date.now()}`,
      total_amount: 9000,
      delivery_fee_minor: 0,
      currency: 'XOF',
      items_summary: [{ title, quantity: 3, price: 3000 }],
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
  await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    order_id: order.id,
    product_id: product.id,
    raw_title: title,
    qty: 3,
    match_status: 'matched',
  });
}

// Commande encaissée simple (sans mouvement de stock) : suffit pour prouver qu'elle est
// comptée par /finances, puis qu'elle en sort après invalidation.
async function seedCollectedOrder(admin: AdminClient, merchantAccountId: string) {
  const { data: order } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      source: 'manual',
      order_number: `INVAL-${Date.now()}`,
      total_amount: 20000,
      delivery_fee_minor: 0,
      currency: 'XOF',
      items_summary: [{ title: 'Article invalidable', quantity: 1, price: 20000 }],
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
  return order.id as string;
}

async function signIn(page: Page, email: string, redirectTo = '/finances') {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await landOnTarget(page, redirectTo);
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
    const expenseAmountInput = page.locator('#expense-amount');
    await expenseAmountInput.click({ clickCount: 3 });
    await expenseAmountInput.pressSequentially('25000');
    await expect(expenseAmountInput).toHaveValue('25000');
    // Date dynamique DANS la fenêtre 30 j par défaut (les dépenses sont filtrées par
    // période). Une date en dur au bord de la fenêtre sortait du périmètre au fil du
    // calendrier (ex. 2026-06-01 exclu dès le 2026-07-01) → « Total dépenses » absent.
    const inWindowDate = new Date();
    inWindowDate.setDate(inWindowDate.getDate() - 10);
    await page.locator('#expense-date').fill(inWindowDate.toISOString().slice(0, 10));

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
    await expect(page.getByRole('link', { name: messages.finance.tabs.products })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: messages.finance.tabs.drivers })).toBeVisible({
      timeout: 15_000,
    });
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
    // La vue produit rend un tableau (desktop) ET des cards (mobile) ; on cible
    // l'occurrence visible selon le viewport.
    await expect(
      page.getByText('Produit Frac', { exact: false }).and(page.locator(':visible')).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Vue par livreur : total_amount numeric fractionnaire → COGS/CA rendus, pas de 500.
    await page.goto('/finances?tab=livreurs');
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

test('filtres période : les presets du PeriodPicker rechargent réellement', async ({ page }) => {
  const fixture = await createOwnerFixture('presets');
  try {
    await signIn(page, fixture.email, '/finances');
    await expect(
      page.getByText(messages.finance.kpis.caUnified, { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Nouveau composant : un trigger compact ouvre la surface (Popover desktop /
    // Drawer mobile) ; chaque preset s'applique en 1 tap et referme la surface.
    const trigger = page.getByRole('button', { name: /Choisir la période/ });
    const presets = messages.periodPicker.presets;

    await trigger.click();
    await page.getByRole('button', { name: presets['7j'], exact: true }).click();
    await expect(page).toHaveURL(/period=7j/);

    await trigger.click();
    await page.getByRole('button', { name: presets['90j'], exact: true }).click();
    await expect(page).toHaveURL(/period=90j/);

    // 30j est le défaut mais reste écrit explicitement (cf. persistence localStorage
    // /finances) → l'URL porte bien period=30j, pas d'effacement du param.
    await trigger.click();
    await page.getByRole('button', { name: presets['30j'], exact: true }).click();
    await expect(page).toHaveURL(/period=30j/);
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('filtres période : une plage personnalisée DD/MM/YYYY est transmise en ISO', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('custom-period');
  try {
    await signIn(page, fixture.email, '/finances');
    await expect(
      page.getByText(messages.finance.kpis.caUnified, { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /Choisir la période/ }).click();
    await page
      .getByRole('button', { name: messages.periodPicker.presets.custom, exact: true })
      .click();
    await page.getByRole('textbox', { name: /^Du(?:\s|$)/ }).fill('30/06/2026');
    await page.getByRole('textbox', { name: /^Au(?:\s|$)/ }).fill('15/07/2026');
    await page.getByRole('button', { name: messages.periodPicker.apply, exact: true }).click();

    await expect(page).toHaveURL(/from=2026-06-30/);
    await expect(page).toHaveURL(/to=2026-07-15/);
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('filtres période : une date personnalisée invalide bloque l’application', async ({ page }) => {
  const fixture = await createOwnerFixture('invalid-custom-period');
  try {
    await signIn(page, fixture.email, '/finances');
    await expect(
      page.getByText(messages.finance.kpis.caUnified, { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /Choisir la période/ }).click();
    await page
      .getByRole('button', { name: messages.periodPicker.presets.custom, exact: true })
      .click();
    await page.getByRole('textbox', { name: /^Du(?:\s|$)/ }).fill('31/02/2026');
    await page.getByRole('textbox', { name: /^Au(?:\s|$)/ }).fill('15/07/2026');

    await expect(page.getByText(messages.periodPicker.invalidDate, { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: messages.periodPicker.apply, exact: true }),
    ).toBeDisabled();
    await expect(page).not.toHaveURL(/from=/);
    await expect(page).not.toHaveURL(/to=/);

    await page.getByRole('textbox', { name: /^Du(?:\s|$)/ }).fill('15/07/2026');
    await page.getByRole('textbox', { name: /^Au(?:\s|$)/ }).fill('30/06/2026');
    await expect(page.getByText(messages.periodPicker.invalidRange, { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: messages.periodPicker.apply, exact: true }),
    ).toBeDisabled();
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('vue globale sans « Versements par livreur », présent sur l’onglet livreurs', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('no-settlements');
  try {
    await signIn(page, fixture.email, '/finances');
    await expect(
      page.getByText(messages.finance.kpis.caUnified, { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // §3.6 : ni le titre ni l'état vide des versements ne sont dans la Vue globale.
    await expect(page.getByText(messages.finance.settlements.title, { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText(messages.finance.settlements.empty, { exact: true })).toHaveCount(
      0,
    );

    // …mais la section (ici son état vide, fixture sans versement) est sur l'onglet Livreurs.
    await page.getByRole('link', { name: messages.finance.tabs.drivers }).click();
    await expect(
      page.getByText(messages.finance.settlements.empty, { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('vue produit : coût manquant éditable in-cell + card à définition au tap', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('inline-edit');
  const title = `Sans Cout ${Date.now()}`;
  try {
    await seedMissingCostOrder(fixture.admin, fixture.merchantAccountId, title);
    await signIn(page, fixture.email, '/finances?tab=produits');
    await expect(page.getByRole('heading', { name: messages.finance.products.title })).toBeVisible({
      timeout: 15_000,
    });

    // Card à définition : tap → définition en langage simple visible.
    await page
      .getByRole('button')
      .filter({ hasText: messages.finance.products.cards.purchase.label })
      .first()
      .click();
    await expect(
      page.getByText(messages.finance.products.cards.purchase.definition, { exact: false }).first(),
    ).toBeVisible();

    // Coût manquant signalé (jamais 0 silencieux). Badge présent dans le tableau ET
    // les cards mobile → on cible l'occurrence visible.
    await expect(
      page
        .getByText(messages.finance.products.table.costMissing, { exact: true })
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible({ timeout: 15_000 });

    // Édition in-cell : crayon (visible) → saisie → OK → bascule en « estimée ».
    await page
      .locator(`button[aria-label="${messages.finance.products.table.editPurchase}"]:visible`)
      .first()
      .click();
    const unitCostInput = page
      .locator(
        `input[aria-label="${messages.finance.products.table.purchaseUnitPlaceholder}"]:visible`,
      )
      .first();
    await unitCostInput.click({ clickCount: 3 });
    await unitCostInput.pressSequentially('2000');
    await expect(unitCostInput).toHaveValue('2000');
    await page
      .locator('button:visible')
      .filter({ hasText: messages.finance.products.table.save })
      .first()
      .click();

    await expect(
      page
        .getByText(messages.finance.products.table.estimated, { exact: true })
        .and(page.locator(':visible'))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

// 0116 + 0117 — preuve À L'ÉCRAN, en complément des tests RLS qui prouvent la même chose au
// niveau de `finance_kpis`. Une commande invalidée doit disparaître de /finances, et pas
// seulement du Tableau. L'invalidation passe par le VRAI chemin `transition_order`
// (p_invalidate_delivered), jamais par un UPDATE direct : c'est lui qui remet
// `cash_collected_at` à null et fait sortir la commande de la fenêtre financière.
test('0116 : une commande invalidée disparaît du CA de /finances', async ({ page }) => {
  const fixture = await createOwnerFixture('invalidation-finances');
  try {
    const orderId = await seedCollectedOrder(fixture.admin, fixture.merchantAccountId);
    await signIn(page, fixture.email, '/finances');

    // La valeur est portée par le <p class="font-mono"> de la carte « CA ».
    const caValue = page
      .locator('section')
      .filter({ hasText: messages.finance.kpis.caUnified })
      .last()
      .locator('p.font-mono');

    // Avant : la commande est bien comptée.
    await expect(caValue).toHaveText(/^20\s*000\s*F/, { timeout: 15_000 });

    // 0148 — p_actor doit désormais correspondre à auth.uid() : appel via une
    // session réelle de fixture.email, jamais via fixture.admin (service-role,
    // auth.uid() nul, refusé depuis 0148).
    const ownerClient = await signInClient(fixture.email);
    const invalidated = await ownerClient.rpc('transition_order', {
      p_actor: fixture.userId,
      p_order_id: orderId,
      p_order_state: 'open',
      p_call_state: 'to_call',
      p_delivery_state: 'unassigned',
      p_cash_state: 'not_due',
      p_clear_assigned_driver: true,
      p_clear_cancel_reasons: true,
      p_clear_scheduled_for: true,
      p_invalidate_delivered: true,
    });
    expect(invalidated.error).toBeNull();
    expect(invalidated.data).toBe('A_APPELER');

    // Après : le chiffre affiché retombe à 0. `^` empêche « 20 000 F CFA » de satisfaire
    // par accident une assertion sur « 0 F CFA ».
    await page.goto('/finances');
    await expect(caValue).toHaveText(/^0\s*F/, { timeout: 15_000 });
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
