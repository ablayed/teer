import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

function readLocalEnv(): Record<string, string> {
  if (!existsSync('.env.local')) {
    return {};
  }
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

test.setTimeout(60_000);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+phase4-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('Utilisateur E2E non cree');
  return data.user.id;
}

async function waitForMerchant(admin: AdminClient, userId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data } = await admin
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.merchant_account_id) return data.merchant_account_id as string;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Merchant E2E introuvable');
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
  return { admin, email, merchantAccountId, userIds: [userId] };
}

async function createDriver(admin: AdminClient, merchantAccountId: string, fullName: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({ merchant_account_id: merchantAccountId, full_name: fullName, phone: '+221770000000' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createProduct(admin: AdminClient, merchantAccountId: string, title: string) {
  const { data, error } = await admin
    .from('product')
    .insert({ merchant_account_id: merchantAccountId, title, unit_cost: 0, is_active: true })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function seedDeliveredCashOrder(
  admin: AdminClient,
  merchantAccountId: string,
  driverId: string,
  totalAmount: number,
) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `E2E-LIV-${Date.now()}`,
      total_amount: totalAmount,
      currency: 'XOF',
      cod_status: 'LIVREE',
      order_state: 'completed',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
      assigned_driver_id: driverId,
      payment_channel_at_delivery: 'ESPECES',
      cash_collectable_minor: totalAmount,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function cleanupUsers(admin: AdminClient, userIds: string[]) {
  await Promise.all(userIds.map((userId) => admin.auth.admin.deleteUser(userId)));
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await page.waitForLoadState('networkidle');
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E livreurs');

test('ajouter un livreur: toast affiche, champs vides, pas de doublon', async ({ page }) => {
  const fixture = await createOwnerFixture('add-driver');

  try {
    await signIn(page, fixture.email, '/parametres');

    // Onglet Équipe
    await page.getByRole('tab', { name: messages.settings.tabs.team }).click();

    const nameInput = page.getByLabel(messages.settings.team.drivers.fullName);
    const phoneInput = page.getByLabel(messages.settings.team.drivers.phone);

    await nameInput.fill('Ndeye Livreuse');
    await phoneInput.fill('+221 77 555 44 33');
    await page.getByRole('button', { name: messages.settings.team.drivers.add }).click();

    // Toast de succès
    await expect(page.getByText(messages.settings.team.notices.driverCreated)).toBeVisible({
      timeout: 15_000,
    });

    // Champs vidés (le reset ne plante plus)
    await expect(nameInput).toHaveValue('');
    await expect(phoneInput).toHaveValue('');

    // Le livreur apparaît dans la liste
    await expect(page.getByText('Ndeye Livreuse')).toBeVisible({ timeout: 15_000 });

    // Une seule ligne en base — aucun doublon
    const { data: drivers } = await fixture.admin
      .from('driver')
      .select('id')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('full_name', 'Ndeye Livreuse');
    expect(drivers).toHaveLength(1);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('désactiver un livreur avec données: inactif, historique + réconciliation intacts', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('deact');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Khadim Actif');
  const productId = await createProduct(fixture.admin, fixture.merchantAccountId, 'Carton E2E');

  // Stock en main via le chemin dispatch (compté par reconcile_product_stock) :
  // purchase_in 10 puis dispatch -3 attribué au livreur → en main 3, entrepôt 7.
  await fixture.admin.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'purchase_in',
    p_qty: 10,
    p_idempotency_key: `deact-in:${productId}`,
    p_created_by: fixture.userIds[0],
    p_unit_cost: 5000,
  });
  await fixture.admin.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'dispatch',
    p_qty: -3,
    p_idempotency_key: `deact-disp:${productId}`,
    p_created_by: fixture.userIds[0],
    p_driver_id: driverId,
  });

  try {
    page.on('dialog', (dialog) => dialog.accept());
    await signIn(page, fixture.email, '/parametres');
    await page.getByRole('tab', { name: messages.settings.tabs.team }).click();

    await expect(page.getByText('Khadim Actif')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: messages.settings.team.drivers.remove }).click();

    // Désactivation (historique présent) — pas de suppression
    await expect(page.getByText(messages.settings.team.notices.driverDeactivated)).toBeVisible({
      timeout: 15_000,
    });

    // Le livreur existe toujours mais inactif
    const { data: driver } = await fixture.admin
      .from('driver')
      .select('is_active')
      .eq('id', driverId)
      .single();
    expect(driver?.is_active).toBe(false);

    // Historique stock préservé (driver_id intact sur le mouvement)
    const { data: movements } = await fixture.admin
      .from('stock_movement')
      .select('id')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId);
    expect((movements ?? []).length).toBeGreaterThan(0);

    // Réconciliation intacte : aucun écart pour ce produit (entrepôt 7 = ledger 10-3)
    const { data: discrepancies } = await (
      fixture.admin.rpc as unknown as (fn: string) => Promise<{ data: { product_id: string }[] }>
    )('reconcile_product_stock');
    expect((discrepancies ?? []).filter((d) => d.product_id === productId)).toHaveLength(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('supprimer un livreur vierge: retiré de la base (suppression dure)', async ({ page }) => {
  const fixture = await createOwnerFixture('del');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Fatou Vierge');

  try {
    page.on('dialog', (dialog) => dialog.accept());
    await signIn(page, fixture.email, '/parametres');
    await page.getByRole('tab', { name: messages.settings.tabs.team }).click();

    await expect(page.getByText('Fatou Vierge')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: messages.settings.team.drivers.remove }).click();

    await expect(page.getByText(messages.settings.team.notices.driverDeleted)).toBeVisible({
      timeout: 15_000,
    });

    const { data: driver } = await fixture.admin
      .from('driver')
      .select('id')
      .eq('id', driverId)
      .maybeSingle();
    expect(driver).toBeNull();
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('allouer un lot fait monter le stock en main du livreur', async ({ page }) => {
  const fixture = await createOwnerFixture('lot');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Moussa Lot');
  await createProduct(fixture.admin, fixture.merchantAccountId, 'Sac lot E2E');

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);

    await expect(page.getByRole('heading', { name: 'Moussa Lot' })).toBeVisible();

    // Mode "Allouer un lot" est actif par défaut ; choisir le produit + qté
    await page.locator('select').filter({ hasText: 'Sac lot E2E' }).selectOption({
      label: 'Sac lot E2E',
    });
    await page.getByPlaceholder('10').fill('15');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();

    // Le mouvement est posté hors commande ; le stock en main remonte
    await expect(page.getByText('Lot alloué au livreur.')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole('row').filter({ hasText: 'Sac lot E2E' }).getByText('15'),
    ).toBeVisible({ timeout: 15_000 });

    // Vérifie le mouvement en base
    const { data: movements } = await fixture.admin
      .from('stock_movement')
      .select('movement_type, qty, driver_id')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId);
    const alloc = (movements ?? []).find((m) => m.movement_type === 'allocate_to_courier');
    expect(alloc?.qty).toBe(-15);
    expect(alloc?.driver_id).toBe(driverId);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('cash livreur: commande livrée affiche le collecté puis la remise globale met à jour le remis', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('cash');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Awa Cash');
  await seedDeliveredCashOrder(fixture.admin, fixture.merchantAccountId, driverId, 20000);

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);

    await expect(page.getByRole('heading', { name: 'Awa Cash' })).toBeVisible();

    // Performance: 1 livrée
    await expect(
      page.locator('section').filter({ hasText: 'Performance' }).getByText('1').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Enregistrer une remise globale de 12 000
    await page.getByPlaceholder('0').fill('12000');
    await page.getByRole('button', { name: 'Enregistrer le versement' }).click();
    await expect(page.getByText('Versement enregistré.')).toBeVisible({ timeout: 15_000 });

    // Le versement est bien enregistré en base
    const { data: settlements } = await fixture.admin
      .from('cash_settlement')
      .select('amount_received_minor')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId);
    expect(settlements?.[0]?.amount_received_minor).toBe(12000);

    // Une allocation a été créée (remise globale auto-répartie)
    const { data: allocations } = await fixture.admin
      .from('settlement_allocation')
      .select('allocated_minor')
      .eq('merchant_account_id', fixture.merchantAccountId);
    expect((allocations ?? []).reduce((s, a) => s + a.allocated_minor, 0)).toBe(12000);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('ecart cash: remise partielle affiche le bandeau, remise du solde le fait disparaitre', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('ecart');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Bilal Ecart');
  await seedDeliveredCashOrder(fixture.admin, fixture.merchantAccountId, driverId, 100000);

  const remit = async (amount: string) => {
    const input = page.getByPlaceholder('0');
    await input.fill(amount);
    await page.getByRole('button', { name: 'Enregistrer le versement' }).click();
    await expect(page.getByText('Versement enregistré.')).toBeVisible({ timeout: 15_000 });
  };

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);
    await expect(page.getByRole('heading', { name: 'Bilal Ecart' })).toBeVisible();

    // Remise partielle 50 000 / 100 000 collectés → bandeau d'écart affiché.
    await remit('50000');
    await expect(page.getByText('Écart non résolu')).toBeVisible({ timeout: 15_000 });

    // Remise du solde 50 000 → remis = collecté = 100 000 → l'écart disparaît.
    await remit('50000');
    await expect(page.getByText('Écart non résolu')).toHaveCount(0, { timeout: 15_000 });

    // Le total remis couvre bien le collecté.
    const { data: allocations } = await fixture.admin
      .from('settlement_allocation')
      .select('allocated_minor')
      .eq('merchant_account_id', fixture.merchantAccountId);
    expect((allocations ?? []).reduce((s, a) => s + a.allocated_minor, 0)).toBe(100000);

    // Un settlement_shortfall figé (ROLLED_FORWARD) de la remise partielle subsiste
    // en base : le bandeau ne s'efface que parce que l'écart est dérivé du live
    // (collecté − remis), pas de cette ligne figée.
    const { data: shortfalls } = await fixture.admin
      .from('settlement_shortfall')
      .select('resolution')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId);
    expect((shortfalls ?? []).some((s) => s.resolution === 'ROLLED_FORWARD')).toBe(true);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
