import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
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
  assertLocalSupabase(supabaseUrl);
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
      { timeout: 10_000, intervals: [100, 250, 500] },
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
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await expect(page.getByRole('heading', { name: 'Produits' })).toBeVisible();
}

async function openPurchasesTab(page: Page) {
  const purchasesTab = page.getByRole('link', { name: 'Achats fournisseur' });
  await expect(purchasesTab).toBeVisible({ timeout: 15_000 });
  await purchasesTab.click();
  await page.waitForURL('**/produits?tab=achats', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Nouveau lot' })).toBeVisible();
}

async function getProductStock(admin: AdminClient, productId: string) {
  const { data } = await admin
    .from('product_stock')
    .select('qty_on_hand, unit_cost')
    .eq('product_id', productId)
    .maybeSingle();
  return data;
}

async function waitForPurchaseLot(
  admin: AdminClient,
  merchantAccountId: string,
  supplierName: string,
) {
  let lotId = '';
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('purchase_lot')
          .select('id')
          .eq('merchant_account_id', merchantAccountId)
          .eq('supplier_name', supplierName)
          .maybeSingle();
        lotId = (data?.id as string | undefined) ?? '';
        return lotId;
      },
      { timeout: 10_000, intervals: [250, 500, 1000] },
    )
    .not.toBe('');
  return lotId;
}

async function waitForPurchaseLotStatus(admin: AdminClient, lotId: string, status: string) {
  await expect
    .poll(
      async () => {
        const { data } = await admin.from('purchase_lot').select('status').eq('id', lotId).single();
        return data?.status ?? null;
      },
      { timeout: 10_000, intervals: [250, 500, 1000] },
    )
    .toBe(status);
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

    // Transport unique (Lot C : un seul frais).
    const transportInput = page.locator('#f-transport');
    await transportInput.press('ControlOrMeta+A');
    await transportInput.pressSequentially('20000');
    await expect(transportInput).toHaveValue('20000');

    // Sélectionner le produit dans la première ligne.
    await page.locator('select').last().selectOption({ label: 'Sac cuir E2E (SAC-E2E)' });

    // Quantité et prix d'achat global de la ligne (Lot C : prix global, pas unitaire).
    const quantityInput = page.getByPlaceholder('Qté');
    await quantityInput.pressSequentially('10');
    await expect(quantityInput).toHaveValue('10');
    const priceInput = page.getByPlaceholder('Prix total');
    await priceInput.pressSequentially('80000');
    await expect(priceInput).toHaveValue('80000');

    // Créer le lot.
    await page.getByRole('button', { name: 'Créer le lot' }).click();
    const lotId = await waitForPurchaseLot(
      fixture.admin,
      fixture.merchantAccountId,
      'Guangzhou Imports',
    );
    await page.reload();

    // Le lot doit apparaître dans la liste avec le statut "Commandé" (badge exact).
    await expect(page.getByText('Guangzhou Imports')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Commandé', { exact: true })).toBeVisible({ timeout: 5_000 });

    // Marquer le lot reçu (bouton toujours disponible en statut "Commandé").
    await page.getByRole('button', { name: 'Marquer reçu' }).click();
    await expect(page.getByText('Lot reçu. Stock mis à jour.')).toBeVisible({ timeout: 15_000 });
    await waitForPurchaseLotStatus(fixture.admin, lotId, 'received');
    await page.reload();

    // Vérifier que le statut est passé à "Reçu" (badge exact, pas "Reçu le …").
    await expect(page.getByText('Reçu', { exact: true })).toBeVisible({ timeout: 10_000 });

    // Vérifier en base : qty_on_hand = 10, unit_cost = (80000 + 20000) / 10 = 10000.
    // lineValue = prix global = 80_000
    // transportTotal = 20_000
    // landedTotalValue = 80_000 + 20_000 = 100_000
    // landedUnitCost = floor(100_000 / 10) = 10_000
    await expect
      .poll(
        async () => {
          const stock = await getProductStock(fixture.admin, productId);
          return {
            qtyOnHand: stock?.qty_on_hand ?? null,
            unitCost: stock?.unit_cost ?? null,
          };
        },
        { timeout: 10_000 },
      )
      .toEqual({ qtyOnHand: 10, unitCost: 10_000 });

    // Détail coût atterri — ouvrir le panel et vérifier le récapitulatif.
    await page.getByText('Détail du coût atterri').click();
    await expect(page.getByText(/Σ transport alloué/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Total transport ✓/)).toBeVisible({ timeout: 5_000 });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('nouveau lot : créer un produit maison à la volée', async ({ page }) => {
  const fixture = await createOwnerFixture('achats-produit-vol');
  const productTitle = `Produit volée ${Date.now()}`;
  const productSku = `VOL-${Date.now()}`;

  try {
    await signIn(page, fixture.email, '/produits');
    await openPurchasesTab(page);

    await page.getByRole('button', { name: 'Nouveau lot' }).click();
    await expect(page.getByText("Nouveau lot d'achat")).toBeVisible({ timeout: 5_000 });

    await page.locator('select').last().selectOption({ label: '+ Créer un produit' });
    await page.getByPlaceholder('Ex : Sac cuir noir').fill(productTitle);
    await page.getByPlaceholder('Ex : SAC-NOIR').fill(productSku);
    await page.getByRole('button', { name: 'Créer', exact: true }).click();

    await expect(page.getByText('Produit créé et sélectionné.')).toBeVisible({
      timeout: 10_000,
    });

    await page.locator('#f-supplier').fill('Fournisseur produit volée');
    await page.locator('#f-ordered-at').fill('2026-06-01');
    const quantityInput = page.getByPlaceholder('Qté');
    await quantityInput.press('ControlOrMeta+A');
    await quantityInput.pressSequentially('3');
    await expect(quantityInput).toHaveValue('3');
    const priceInput = page.getByPlaceholder('Prix total');
    await priceInput.press('ControlOrMeta+A');
    await priceInput.pressSequentially('15000');
    await expect(priceInput).toHaveValue('15000');
    await page.getByRole('button', { name: 'Créer le lot' }).click();
    await waitForPurchaseLot(fixture.admin, fixture.merchantAccountId, 'Fournisseur produit volée');
    await page.reload();

    await expect(page.getByText('Fournisseur produit volée')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(productTitle)).toBeVisible({ timeout: 10_000 });

    const { data: product } = await fixture.admin
      .from('product')
      .select('id, title, sku')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('title', productTitle)
      .single();
    expect(product?.sku).toBe(productSku);

    const { data: line } = await fixture.admin
      .from('purchase_lot_line')
      .select('product_id, qty, purchase_price_total')
      .eq('product_id', product?.id ?? '')
      .single();
    expect(line?.qty).toBe(3);
    expect(line?.purchase_price_total).toBe(15000);
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('#9 le formulaire « Nouveau lot » ne déborde pas en portrait', async ({ page }) => {
  const fixture = await createOwnerFixture('lot-responsive');
  await createProduct(fixture.admin, fixture.merchantAccountId);

  try {
    await signIn(page, fixture.email, '/produits');
    await openPurchasesTab(page);

    await page.getByRole('button', { name: 'Nouveau lot' }).click();
    await expect(page.getByText("Nouveau lot d'achat")).toBeVisible({ timeout: 5_000 });

    // Aucun débordement horizontal (les champs s'empilent en portrait).
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    // Les trois champs de la ligne produit restent dans le viewport.
    const viewportWidth = overflow.clientWidth;
    const qty = page.getByPlaceholder('Qté');
    const price = page.getByPlaceholder('Prix total');
    const select = page.locator('select').last();
    for (const field of [select, qty, price]) {
      await expect(field).toBeVisible();
      const box = await field.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewportWidth + 1);
    }
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
