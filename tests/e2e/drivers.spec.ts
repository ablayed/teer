import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { grantCurrentConsents } from './helpers/consent';

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
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  localEnv.SUPABASE_ANON_KEY ??
  '';
const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);
const isProdBuildRun = process.env.E2E_PROD_BUILD === '1';
const password = 'Mot-de-passe-e2e-2026!';

test.setTimeout(60_000);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Client authentifié (membre) pour les seeds qui passent par post_stock_movement :
// depuis 0043 cette RPC exige current_member_role non NULL → le service-role est rejeté.
async function signInClient(email: string): Promise<AdminClient> {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
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
  createdAt?: string,
) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `E2E-LIV-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
      ...(createdAt ? { created_at: createdAt } : {}),
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function seedAssignedCashOrder(
  admin: AdminClient,
  merchantAccountId: string,
  driverId: string,
  totalAmount: number,
  deliveryFeeMinor: number,
  createdAt?: string,
) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `E2E-ASS-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      total_amount: totalAmount,
      delivery_fee_minor: deliveryFeeMinor,
      currency: 'XOF',
      cod_status: 'EN_LIVRAISON',
      order_state: 'open',
      call_state: 'validated',
      delivery_state: 'assigned',
      cash_state: 'expected',
      assigned_driver_id: driverId,
      cash_collectable_minor: totalAmount,
      ...(createdAt ? { created_at: createdAt } : {}),
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
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await page.waitForURL(`**${redirectTo}`, { timeout: 30_000 });
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
}

function statValue(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator('xpath=following-sibling::p[1]');
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
  // post_stock_movement exige un membre (garde NULL-safe 0043) → client owner authentifié.
  const ownerClient = await signInClient(fixture.email);
  await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'purchase_in',
    p_qty: 10,
    p_idempotency_key: `deact-in:${productId}`,
    p_created_by: fixture.userIds[0],
    p_unit_cost: 5000,
  });
  await ownerClient.rpc('post_stock_movement', {
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

test('modifier le stock (nouveau produit) poste un driver_stock_set et affiche physique+disponible', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('dss-new');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Moussa Lot');
  const productId = await createProduct(fixture.admin, fixture.merchantAccountId, 'Sac lot E2E');
  const ownerClient = await signInClient(fixture.email);

  // Stock central suffisant (20) pour couvrir la demande de 15 ci-dessous —
  // ce test vérifie le CAS DE SUCCÈS, pas le blocage cas 1.
  await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'purchase_in',
    p_qty: 20,
    p_idempotency_key: `dss-new:${productId}:in`,
    p_created_by: fixture.userIds[0],
    p_unit_cost: 1000,
  });

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);

    await expect(page.getByRole('heading', { name: 'Moussa Lot' })).toBeVisible();

    // Produit sans position (physique ET disponible = 0) : uniquement dans
    // le sélecteur "+ Ajouter un produit", pas encore une ligne de tableau.
    // Ce contrôle n'est jamais dupliqué desktop/mobile (contrairement aux
    // lignes du tableau) — pas d'ambiguïté ici.
    await page.getByLabel(messages.livreurs.stock.addProduct).selectOption({
      label: 'Sac lot E2E',
    });
    const qtyInput = page.getByLabel(messages.livreurs.stock.newQtyLabel);
    await qtyInput.click({ clickCount: 3 });
    await qtyInput.pressSequentially('15');
    await expect(qtyInput).toHaveValue('15');
    await page.getByRole('button', { name: messages.livreurs.stock.submit, exact: true }).click();

    await expect(page.getByText(messages.livreurs.stock.success)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const { data } = await fixture.admin
            .from('stock_movement')
            .select('movement_type, qty, driver_id')
            .eq('merchant_account_id', fixture.merchantAccountId)
            .eq('driver_id', driverId);
          return (data ?? []).find((movement) => movement.movement_type === 'driver_stock_set');
        },
        { timeout: 15_000 },
      )
      .toMatchObject({ driver_id: driverId, qty: 15 });

    // product_stock (stock central) n'est JAMAIS affecté par ce mouvement —
    // reste à 20 (le purchase_in de seed), pas 20+15 ni 20-15.
    const { data: stock } = await fixture.admin
      .from('product_stock')
      .select('qty_on_hand')
      .eq('product_id', productId)
      .maybeSingle();
    expect(stock?.qty_on_hand).toBe(20);

    await page.reload();
    // Le <table> desktop (md+) et la liste mobile (< md) existent TOUS LES
    // DEUX dans le DOM en permanence (l'un masqué en CSS selon le viewport) —
    // `:visible` + `.last()` cible l'élément réellement affiché quel que soit
    // le viewport (desktop <td> ou carte mobile).
    await expect(page.locator(':visible', { hasText: 'Sac lot E2E' }).last()).toBeVisible({
      timeout: 15_000,
    });
    // Physique ET disponible affichent 15 (aucun engagement de commande sur
    // ce produit) — les deux colonnes/valeurs sont visibles simultanément.
    await expect(page.locator(':visible', { hasText: '15' }).last()).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('modifier le stock: augmentation au-delà du stock central est bloquée avec le montant manquant', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('dss-central');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Alpha Central');
  const productId = await createProduct(
    fixture.admin,
    fixture.merchantAccountId,
    'Carton central E2E',
  );
  const ownerClient = await signInClient(fixture.email);

  // Stock central : 5 unités seulement.
  await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'purchase_in',
    p_qty: 5,
    p_idempotency_key: `dss-central:${productId}:in`,
    p_created_by: fixture.userIds[0],
    p_unit_cost: 1000,
  });

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);
    await expect(page.getByRole('heading', { name: 'Alpha Central' })).toBeVisible();

    // Demande 10 alors que le central n'en a que 5 → manque 5.
    await page.getByLabel(messages.livreurs.stock.addProduct).selectOption({
      label: 'Carton central E2E',
    });
    const qtyInput = page.getByLabel(messages.livreurs.stock.newQtyLabel);
    await qtyInput.click({ clickCount: 3 });
    await qtyInput.pressSequentially('10');
    await expect(qtyInput).toHaveValue('10');
    await page.getByRole('button', { name: messages.livreurs.stock.submit, exact: true }).click();

    await expect(
      page.getByText(
        messages.livreurs.stock.shortageCentral.item
          .replace('{qty}', '5')
          .replace('{product}', 'Carton central E2E'),
      ),
    ).toBeVisible({ timeout: 15_000 });

    // Aucune écriture : ni driver_stock_set, ni effet sur product_stock.
    const { data: movements } = await fixture.admin
      .from('stock_movement')
      .select('movement_type')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId);
    expect((movements ?? []).some((m) => m.movement_type === 'driver_stock_set')).toBe(false);
    const { data: stock } = await fixture.admin
      .from('product_stock')
      .select('qty_on_hand')
      .eq('product_id', productId)
      .single();
    expect(stock?.qty_on_hand).toBe(5);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('modifier le stock: retrait excédentaire (valeur négative) est bloqué avec le montant en trop', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('dss-physical');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Beta Physique');
  const productId = await createProduct(
    fixture.admin,
    fixture.merchantAccountId,
    'Carton physique E2E',
  );
  const ownerClient = await signInClient(fixture.email);

  // Le livreur a 3 en main via driver_stock_set (ledger-only).
  await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'driver_stock_set',
    p_qty: 3,
    p_idempotency_key: `dss-physical:${productId}:set`,
    p_created_by: fixture.userIds[0],
    p_driver_id: driverId,
  });

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);
    await expect(page.getByRole('heading', { name: 'Beta Physique' })).toBeVisible();

    await expect(page.locator(':visible', { hasText: 'Carton physique E2E' }).last()).toBeVisible({
      timeout: 15_000,
    });
    await page.locator(':visible', { hasText: messages.livreurs.stock.action }).last().click();

    // Le formulaire ouvert existe en double dans le DOM (desktop <table> +
    // carte mobile, l'un masqué en CSS selon le viewport) — `.and(page.locator(':visible'))`
    // (combinateur Playwright officiel, contrairement à `.locator(':visible')`
    // chaîné qui ne filtre pas par visibilité ici) cible l'élément réellement affiché.
    const qtyInput = page
      .getByLabel(messages.livreurs.stock.newQtyLabel)
      .and(page.locator(':visible'));
    // Valeur cible négative (-2) : au-delà de 0, quel que soit le physique
    // actuel (3) — retrait en trop demandé = 2.
    await qtyInput.click({ clickCount: 3 });
    await qtyInput.pressSequentially('-2');
    await expect(qtyInput).toHaveValue('-2');
    await page
      .getByRole('button', { name: messages.livreurs.stock.submit, exact: true })
      .and(page.locator(':visible'))
      .click();

    await expect(
      page.getByText(
        messages.livreurs.stock.shortagePhysical.item
          .replace('{current}', '3')
          .replace('{product}', 'Carton physique E2E')
          .replace('{qty}', '2'),
      ),
    ).toBeVisible({ timeout: 15_000 });

    // Un seul mouvement driver_stock_set en base (le seed initial) — le
    // retrait bloqué n'a rien écrit.
    const { data: movements } = await fixture.admin
      .from('stock_movement')
      .select('qty')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId)
      .eq('movement_type', 'driver_stock_set');
    expect(movements).toHaveLength(1);
    expect(movements?.[0]?.qty).toBe(3);
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
    await expect(statValue(page, messages.livreurs.cash.collectedTotal)).toContainText(
      /20\s*000\s*F\s*CFA/,
      { timeout: 15_000 },
    );
    await expect(statValue(page, messages.livreurs.cash.deliveryFees)).toContainText(
      /0\s*F\s*CFA/,
      { timeout: 15_000 },
    );

    // Performance: 1 livrée
    await expect(
      page.locator('section').filter({ hasText: 'Performance' }).getByText('1').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Enregistrer une remise globale de 12 000
    const settlementInput = page.getByPlaceholder('0');
    await settlementInput.click({ clickCount: 3 });
    await settlementInput.pressSequentially('12000');
    await expect(settlementInput).toHaveValue('12000');
    await page.getByRole('button', { name: 'Enregistrer le versement' }).click();
    await expect(page.getByText('Versement enregistré.')).toBeVisible({
      timeout: 15_000,
    });

    // La carte « Cash chez le livreur » reflète le net collecté − frais − remis.
    await expect(statValue(page, messages.livreurs.cash.cashOnHand)).toContainText(
      /8\s*000\s*F\s*CFA/,
      { timeout: 15_000 },
    );
    await expect(statValue(page, messages.livreurs.cash.collectedTotal)).toContainText(
      /20\s*000\s*F\s*CFA/,
      { timeout: 15_000 },
    );

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

test('cash livreur: les frais de livraison attendent la collecte avant de monter', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('cash-fee-timing');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Awa Fee');
  const orderId = await seedAssignedCashOrder(
    fixture.admin,
    fixture.merchantAccountId,
    driverId,
    20_000,
    3_500,
  );
  const ownerClient = await signInClient(fixture.email);

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);

    await expect(page.getByRole('heading', { name: 'Awa Fee' })).toBeVisible();
    await expect(statValue(page, messages.livreurs.cash.collectedTotal)).toContainText(
      /0\s*F\s*CFA/,
      { timeout: 15_000 },
    );
    await expect(statValue(page, messages.livreurs.cash.deliveryFees)).toContainText(
      /0\s*F\s*CFA/,
      { timeout: 15_000 },
    );

    const { error } = await ownerClient.rpc('transition_order', {
      p_order_id: orderId,
      p_actor: fixture.userIds[0],
      p_call_state: 'validated',
      p_delivery_state: 'delivered',
      p_order_state: 'completed',
      p_cash_state: 'collected',
      p_payment_channel: 'ESPECES',
    });
    if (error) throw error;

    await expect
      .poll(
        async () => {
          const { data } = await fixture.admin
            .from('orders')
            .select('cash_state, delivery_state')
            .eq('id', orderId)
            .single();
          return data?.cash_state ?? null;
        },
        { timeout: 15_000 },
      )
      .toBe('collected');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Awa Fee' })).toBeVisible();
    await expect(statValue(page, messages.livreurs.cash.collectedTotal)).toContainText(
      /20\s*000\s*F\s*CFA/,
      { timeout: 15_000 },
    );
    await expect(statValue(page, messages.livreurs.cash.deliveryFees)).toContainText(
      /3\s*500\s*F\s*CFA/,
      { timeout: 15_000 },
    );
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('cash livreur: le filtre période exclut réellement les commandes hors plage (Cash total collecté)', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('cash-period');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Fatou Period');
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 60);
  await seedDeliveredCashOrder(
    fixture.admin,
    fixture.merchantAccountId,
    driverId,
    15000,
    oldDate.toISOString(),
  );
  await seedDeliveredCashOrder(fixture.admin, fixture.merchantAccountId, driverId, 20000);

  try {
    // period=today : seule la commande créée à l'instant doit compter (20 000),
    // pas celle vieille de 60 jours (15 000) — régression du bug de comparaison
    // de strings (created_at Postgres "+00:00" vs .toISOString() JS "Z").
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=today`);

    await expect(page.getByRole('heading', { name: 'Fatou Period' })).toBeVisible();
    await expect(statValue(page, messages.livreurs.cash.collectedTotal)).toContainText(
      /20\s*000\s*F\s*CFA/,
      { timeout: 15_000 },
    );

    // period=90j : les deux commandes comptent (35 000).
    await page.goto(`/livreurs?driver=${driverId}&period=90j`);
    await expect(statValue(page, messages.livreurs.cash.collectedTotal)).toContainText(
      /35\s*000\s*F\s*CFA/,
      { timeout: 15_000 },
    );
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('cash livreur: cliquer un preset du PeriodPicker recharge réellement les cards cash', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('cash-picker-click');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Modou Click');
  // 10 jours : dans la fenêtre 30j (défaut), hors de la fenêtre « Aujourd'hui ».
  const tenDaysAgo = new Date();
  tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
  await seedDeliveredCashOrder(
    fixture.admin,
    fixture.merchantAccountId,
    driverId,
    15000,
    tenDaysAgo.toISOString(),
  );
  await seedDeliveredCashOrder(fixture.admin, fixture.merchantAccountId, driverId, 20000);

  try {
    const performanceDelivered = () =>
      page.locator('section').filter({ hasText: 'Performance' }).getByText('2', { exact: true });

    // Défaut 30j au chargement : les deux commandes comptent (35 000, 2 livrées).
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}`);
    await expect(page.getByRole('heading', { name: 'Modou Click' })).toBeVisible();
    await expect(statValue(page, messages.livreurs.cash.collectedTotal)).toContainText(
      /35\s*000\s*F\s*CFA/,
      { timeout: 15_000 },
    );
    await expect(performanceDelivered()).toBeVisible({ timeout: 15_000 });

    // Clic réel sur le trigger + preset « Aujourd'hui » (flux utilisateur, pas un
    // page.goto direct) : ne doit garder que la commande créée à l'instant
    // (20 000, 1 livrée). Vérifie Performance ET Cash : si seul Cash reste figé,
    // le bug est dans DriverCashPanel, pas dans la navigation nuqs elle-même.
    const trigger = page.getByRole('button', { name: /Choisir la période/ });
    const presets = messages.periodPicker.presets;
    await trigger.click();
    await page.getByRole('button', { name: presets.today, exact: true }).click();
    await expect(page).toHaveURL(/period=today/);
    await expect(
      page.locator('section').filter({ hasText: 'Performance' }).getByText('1', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(statValue(page, messages.livreurs.cash.collectedTotal)).toContainText(
      /20\s*000\s*F\s*CFA/,
      { timeout: 15_000 },
    );
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

  // Attend l'EFFET RENDU de CETTE remise — la carte « Cash chez le livreur » —
  // et NON le toast seul. Sérialise les deux remises et prouve que l'affichage cash
  // reflète la lecture serveur fraîche.
  // « Cash chez le livreur » = collecté − frais − remis cumulé. Frais = 0 ici,
  // donc il DÉCROÎT à chaque remise (100 000 → 50 000 → 0). On attend le rendu
  // exact (toHaveText ancré) pour ne pas matcher un « 0 » contenu dans « 50 000 ».
  const remit = async (amount: string, expectedCashOnHandMinor: number) => {
    const settlementInput = page.getByPlaceholder('0');
    await settlementInput.click({ clickCount: 3 });
    await settlementInput.pressSequentially(amount);
    await expect(settlementInput).toHaveValue(amount);
    await page.getByRole('button', { name: 'Enregistrer le versement' }).click();
    const grouped = String(expectedCashOnHandMinor).replace(/\B(?=(\d{3})+(?!\d))/g, '\\s*');
    await expect(page.getByText('Versement enregistré.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(statValue(page, messages.livreurs.cash.cashOnHand)).toHaveText(
      new RegExp(`^${grouped}\\s*F\\s*CFA$`),
      { timeout: 15_000 },
    );
  };

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);
    await expect(page.getByRole('heading', { name: 'Bilal Ecart' })).toBeVisible();

    // Remise partielle 50 000 / 100 000 collectés → cash chez le livreur = 50 000,
    // bandeau d'écart affiché.
    await remit('50000', 50000);
    await expect(page.getByText('Écart non résolu')).toBeVisible({ timeout: 15_000 });

    // Remise du solde 50 000 → remis = collecté = 100 000 → cash chez le livreur = 0,
    // l'écart disparaît.
    await remit('50000', 0);
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

test('feedback pending sur changement de livreur (build prod)', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(
    !isProdBuildRun,
    'Vérification PROD-ONLY : nécessite next build && next start + E2E_PROD_BUILD=1.',
  );

  const fixture = await createOwnerFixture('pending-driver');
  const driverAId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Moussa A');
  const driverBId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Moussa B');
  await seedDeliveredCashOrder(fixture.admin, fixture.merchantAccountId, driverAId, 25000);

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverAId}&period=30j`);

    await expect(page.getByRole('heading', { name: 'Moussa A' })).toBeVisible();

    await page.route('**/livreurs**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('driver') !== driverBId) {
        await route.continue();
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });

    const driverButton = page.getByRole('button', { name: /^Moussa B/ });
    await driverButton.click();

    await expect(driverButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('driver-detail-panel')).toHaveAttribute('aria-busy', 'true');

    // Ordre des params non garanti : `driver` (nuqs) et `period` (PeriodPicker, nuqs
    // séparé) sont deux instances distinctes du même mécanisme d'écriture URL.
    await page.waitForURL((url) => url.searchParams.get('driver') === driverBId);
    await expect.poll(() => new URL(page.url()).searchParams.get('period')).toBe('30j');
    await expect(page.getByTestId('driver-detail-panel')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('heading', { name: 'Moussa B' })).toBeVisible();
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('stock disponible: un engagement (order_assignment_commit) au-delà de la main physique affiche une valeur négative', async ({
  page,
}) => {
  // Lot 2 / PR 2 : contrairement au stock EN MAIN (toujours >= 0), le stock
  // DISPONIBLE peut être négatif — ex. le livreur a rendu physiquement des
  // unités (courier_return_lot) alors qu'elles restent engagées sur une
  // commande ouverte assignée (order_assignment_commit non relâché). C'est
  // précisément ce que ce panneau doit surfacer, cf. décision produit Phase A.
  const fixture = await createOwnerFixture('stock-dispo-negatif');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Ousmane Négatif');
  const productId = await createProduct(fixture.admin, fixture.merchantAccountId, 'Bidon E2E');
  const orderId = await seedAssignedCashOrder(
    fixture.admin,
    fixture.merchantAccountId,
    driverId,
    30_000,
    0,
  );
  const ownerClient = await signInClient(fixture.email);

  // Main physique du livreur : dispatch 5 → hand = 5.
  await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'dispatch',
    p_qty: -5,
    p_idempotency_key: `neg-dispatch:${productId}`,
    p_created_by: fixture.userIds[0],
    p_driver_id: driverId,
    p_order_id: orderId,
  });
  // Engagement sur la commande ouverte : 8 unités (au-delà des 5 en main).
  await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'order_assignment_commit',
    p_qty: 8,
    p_idempotency_key: `neg-commit:${productId}`,
    p_created_by: fixture.userIds[0],
    p_driver_id: driverId,
    p_order_id: orderId,
  });

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);

    await expect(page.getByRole('heading', { name: 'Ousmane Négatif' })).toBeVisible();
    await expect(page.getByText(messages.livreurs.stock.title, { exact: true })).toBeVisible();

    // hand(5) − commit(8) = −3, visible tel quel (pas de plancher à 0).
    await expect(page.locator(':visible', { hasText: 'Bidon E2E' }).last()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(':visible', { hasText: '-3' }).last()).toBeVisible({
      timeout: 15_000,
    });

    // La base confirme le même calcul que l'UI affiche (pas de dérive read-model).
    const { data: movements } = await fixture.admin
      .from('stock_movement')
      .select('movement_type, qty')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId)
      .eq('product_id', productId);
    const net = (movements ?? []).reduce((sum, m) => {
      if (m.movement_type === 'dispatch' || m.movement_type === 'order_assignment_commit') {
        return sum - m.qty;
      }
      return sum;
    }, 0);
    expect(net).toBe(-3);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
