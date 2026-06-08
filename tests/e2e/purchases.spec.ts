import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

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
  return `e2e+phase5-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('Utilisateur E2E non créé');
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

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E Phase5 ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, userId };
}

async function createProduct(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title: 'Sac cuir E2E',
      sku: 'SAC-E2E',
      unit_cost: 0,
      is_active: true,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return { id: data.id as string };
}

async function signIn(page: Page, email: string, redirectTo = '/produits') {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await page.waitForLoadState('networkidle');
}

async function openPurchasesTab(page: Page) {
  const purchasesTab = page.getByRole('link', { name: 'Achats fournisseur' });
  await expect(purchasesTab).toBeVisible({ timeout: 15_000 });
  await purchasesTab.click();
  await page.waitForURL('**/produits?tab=achats', { timeout: 10_000 });
  await page.waitForLoadState('networkidle');
}

async function getProductStock(admin: AdminClient, productId: string) {
  const { data } = await admin
    .from('product_stock')
    .select('qty_on_hand, unit_cost')
    .eq('product_id', productId)
    .maybeSingle();
  return data;
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E achats');

test('chemin nominal : créer lot → marquer reçu → stock mis à jour', async ({ page }) => {
  const fixture = await createOwnerFixture('achats-nominal');
  const { id: productId } = await createProduct(fixture.admin, fixture.merchantAccountId);

  try {
    await signIn(page, fixture.email, '/produits');

    // Les achats sont dans l'onglet dédié de la page Produits.
    await openPurchasesTab(page);

    // Ouvrir le formulaire de création.
    await page.getByRole('button', { name: 'Nouveau lot' }).click();
    await expect(page.getByText("Nouveau lot d'achat")).toBeVisible({ timeout: 5_000 });

    // Remplir le formulaire (ids dédiés pour éviter l'ambiguïté de label).
    await page.locator('#f-supplier').fill('Guangzhou Imports');
    await page.locator('#f-ordered-at').fill('2026-06-01');

    // Remplir les frais.
    await page.locator('#f-fee-freightTotal').fill('15000');
    await page.locator('#f-fee-customsTotal').fill('5000');

    // Sélectionner le produit dans la première ligne.
    await page.locator('select').last().selectOption({ label: 'Sac cuir E2E (SAC-E2E)' });

    // Quantité et prix unitaire.
    await page.getByPlaceholder('Qté').fill('10');
    await page.getByPlaceholder('Prix/u').fill('8000');

    // Créer le lot.
    await page.getByRole('button', { name: 'Créer le lot' }).click();

    // Le lot doit apparaître dans la liste avec le statut "Commandé" (badge exact).
    await expect(page.getByText('Guangzhou Imports')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Commandé', { exact: true })).toBeVisible({ timeout: 5_000 });

    // Marquer le lot reçu (bouton toujours disponible en statut "Commandé").
    await page.getByRole('button', { name: 'Marquer reçu' }).click();
    await expect(page.getByText('Lot reçu. Stock mis à jour.')).toBeVisible({ timeout: 15_000 });

    // Vérifier que le statut est passé à "Reçu" (badge exact, pas "Reçu le …").
    await expect(page.getByText('Reçu', { exact: true })).toBeVisible({ timeout: 10_000 });

    // Vérifier en base : qty_on_hand = 10, unit_cost = (8000×10 + 20000) / 10 = 10000.
    // lineValue = 10 × 8000 = 80_000
    // totalFees = 15000 + 5000 = 20_000
    // landedTotalValue = 80_000 + 20_000 = 100_000
    // landedUnitCost = floor(100_000 / 10) = 10_000
    let stock = await getProductStock(fixture.admin, productId);
    for (let retry = 0; retry < 10 && !stock; retry++) {
      await new Promise((r) => setTimeout(r, 300));
      stock = await getProductStock(fixture.admin, productId);
    }

    expect(stock?.qty_on_hand).toBe(10);
    expect(stock?.unit_cost).toBe(10_000);

    // Détail coût atterri — ouvrir le panel et vérifier le récapitulatif.
    await page.getByText('Détail du coût atterri').click();
    await expect(page.getByText(/Σ frais alloués/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Total frais ✓/)).toBeVisible({ timeout: 5_000 });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('section Achats masquée pour un agent', async ({ page }) => {
  const fixture = await createOwnerFixture('achats-agent');

  const agentEmail = e2eEmail('agent');
  const agentUserId = await createConfirmedUser(fixture.admin, agentEmail);
  await fixture.admin.from('merchant_account').delete().eq('owner_user_id', agentUserId);
  await fixture.admin.from('merchant_member').insert({
    merchant_account_id: fixture.merchantAccountId,
    user_id: agentUserId,
    role: 'agent',
  });

  try {
    await signIn(page, agentEmail, '/produits');

    // Le catalogue produit est toujours visible (la page a chargé) — heading exact.
    await expect(page.getByRole('heading', { name: 'Catalogue', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // La section "Achats fournisseur" ne doit PAS être visible pour un agent.
    await expect(page.getByRole('heading', { name: 'Achats fournisseur' })).toHaveCount(0);
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
    await fixture.admin.auth.admin.deleteUser(agentUserId);
  }
});
