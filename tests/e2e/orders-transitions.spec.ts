import { existsSync, readFileSync } from 'node:fs';
import { legacyStatusToDimensions } from '@/lib/domain/order-transition-actions';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
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
const password = 'Mot-de-passe-e2e-2026!';

test.setTimeout(60_000);

type AdminClient = SupabaseClient;
type Role = 'owner' | 'manager' | 'agent';

function adminClient(): AdminClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Client authentifié (membre) pour les seeds passant par post_stock_movement :
// depuis 0043 la RPC exige current_member_role non NULL → le service-role est rejeté.
async function signInClient(email: string): Promise<AdminClient> {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

function e2eEmail(label: string): string {
  return `e2e+phase0-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw error ?? new Error('Utilisateur E2E non cree');
  }

  await grantCurrentConsents(admin, data.user.id);
  return data.user.id;
}

async function waitForMerchant(admin: AdminClient, userId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await admin
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (data?.merchant_account_id) {
      return data.merchant_account_id as string;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Merchant E2E introuvable');
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);

  const { error } = await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);

  if (error) {
    throw error;
  }

  return {
    admin,
    email,
    merchantAccountId,
    userIds: [userId],
  };
}

async function addMember(fixture: Awaited<ReturnType<typeof createOwnerFixture>>, role: Role) {
  const email = e2eEmail(role);
  const userId = await createConfirmedUser(fixture.admin, email);

  await fixture.admin.from('merchant_account').delete().eq('owner_user_id', userId);

  const { error } = await fixture.admin.from('merchant_member').insert({
    merchant_account_id: fixture.merchantAccountId,
    user_id: userId,
    role,
  });

  if (error) {
    throw error;
  }

  fixture.userIds.push(userId);

  return { email, userId };
}

async function createOrder(
  admin: AdminClient,
  merchantAccountId: string,
  status: string,
  totalAmount = 12345,
) {
  return createOrderWithCustomer(admin, {
    merchantAccountId,
    status,
    totalAmount,
  });
}

async function createOrderWithCustomer(
  admin: AdminClient,
  {
    customerName = 'Client Phase Zero',
    merchantAccountId,
    phone = '+221771234567',
    productName = 'Produit E2E',
    status,
    totalAmount = 12345,
  }: {
    customerName?: string;
    merchantAccountId: string;
    phone?: string;
    productName?: string;
    status: string;
    totalAmount?: number;
  },
) {
  const dimensions = legacyStatusToDimensions(
    status as Parameters<typeof legacyStatusToDimensions>[0],
  );
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: customerName,
      phone,
      shipping_address: {
        address1: 'Almadies',
        city: 'Dakar',
        country: 'SN',
      },
    })
    .select('id')
    .single();

  if (customerError) {
    throw customerError;
  }

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      customer_id: customer.id,
      order_number: `E2E-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: totalAmount,
      currency: 'XOF',
      cod_status: status,
      order_state: dimensions.orderState,
      call_state: dimensions.callState,
      delivery_state: dimensions.deliveryState,
      cash_state: dimensions.cashState,
      attempt_count: dimensions.attemptCount,
      next_contact_at: dimensions.nextContactAt,
      scheduled_for: dimensions.scheduledFor,
      cancel_reason: dimensions.cancelReason,
      assigned_driver_id: dimensions.assignedDriverId,
      items_summary: [{ title: productName, quantity: 1, price: totalAmount }],
      shipping_address: {
        address1: 'Almadies',
        city: 'Dakar',
        country: 'SN',
      },
      created_at_shopify: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (orderError) {
    throw orderError;
  }

  return order.id as string;
}

async function cleanupUsers(admin: AdminClient, userIds: string[]) {
  await Promise.all(userIds.map((userId) => admin.auth.admin.deleteUser(userId)));
}

async function createProductInCatalog(
  admin: AdminClient,
  merchantAccountId: string,
  title: string,
  sku?: string,
) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title,
      sku: sku ?? null,
      unit_cost: 0,
      is_active: true,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
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

// Confirmed order (call validated, delivery unassigned) carrying one matched
// order_line, so a later dispatch posts a stock movement attributed to the driver.
async function createConfirmedOrderWithLine(
  admin: AdminClient,
  merchantAccountId: string,
  productId: string,
  productTitle: string,
  qty: number,
) {
  const dimensions = legacyStatusToDimensions('CONFIRMEE');
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Client Assignation',
      phone: '+221770000001',
      shipping_address: { address1: 'Almadies', city: 'Dakar', country: 'SN' },
    })
    .select('id')
    .single();
  if (customerError) throw customerError;

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      customer_id: customer.id,
      order_number: `E2E-ASSIGN-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: 20000,
      currency: 'XOF',
      cod_status: 'CONFIRMEE',
      order_state: dimensions.orderState,
      call_state: dimensions.callState,
      delivery_state: dimensions.deliveryState,
      cash_state: dimensions.cashState,
      items_summary: [{ title: productTitle, quantity: qty, price: 20000 }],
      shipping_address: { address1: 'Almadies', city: 'Dakar', country: 'SN' },
      created_at_shopify: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (orderError) throw orderError;

  const { error: lineError } = await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    order_id: order.id,
    product_id: productId,
    raw_title: productTitle,
    qty,
    match_status: 'matched',
  });
  if (lineError) throw lineError;

  return order.id as string;
}

async function waitForOrderStatus(
  admin: AdminClient,
  orderId: string,
  status: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { data, error } = await admin
      .from('orders')
      .select('cod_status')
      .eq('id', orderId)
      .single();

    if (!error && data?.cod_status === status) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Statut ${status} non observe pour la commande ${orderId}.`);
}

async function signIn(page: Page, email: string, redirectTo = '/tableau') {
  const targetUrl =
    redirectTo === '/tableau'
      ? '/connexion'
      : `/connexion?redirectTo=${encodeURIComponent(redirectTo)}`;

  await page.goto(targetUrl);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await page.waitForLoadState('networkidle');
}

// Les actions de commande vivent desormais dans un dropdown unique « Actions »
// (liste + detail). Les entrees sont des role="menuitem".
function menuItem(page: Page, name: string) {
  return page.getByRole('menuitem', { name, exact: true });
}

async function openActionsMenu(page: Page) {
  await page.getByRole('button', { name: 'Actions' }).first().click();
}

// Detail (page mode) : ouvre le dropdown puis clique l'entree d'action.
async function runDetailMenuAction(page: Page, name: string) {
  await openActionsMenu(page);
  await menuItem(page, name).click();
}

// Liste : ouvre le dropdown de la carte ciblee puis clique l'entree d'action.
async function runRowMenuAction(page: Page, rowText: string, name: string) {
  const row = page.locator('article').filter({ hasText: rowText });
  await row.getByRole('button', { name: 'Actions' }).click();
  await menuItem(page, name).click();
}

function savedViewButton(page: Page, label: string) {
  return page.getByRole('button', { name: new RegExp(`^${label} \\(`) });
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E commandes');

test('chemin nominal confirmer programmer assigner livrer en especes', async ({ page }) => {
  const fixture = await createOwnerFixture('nominal');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Livreur Nominal');
  const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await runDetailMenuAction(page, 'Confirmer');
    await waitForOrderStatus(fixture.admin, orderId, 'CONFIRMEE');
    await expect(page.getByText('Confirmée').first()).toBeVisible({ timeout: 15_000 });

    // Programmer ouvre un dialog (date du jour par défaut) avant la transition.
    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');
    await page.reload();
    await openActionsMenu(page);
    await expect(menuItem(page, 'Assigner')).toBeVisible({ timeout: 15_000 });

    // Assigner ouvre un dialog imposant le choix d'un livreur actif.
    await menuItem(page, 'Assigner').click();
    await page.getByLabel('Livreur', { exact: true }).selectOption(driverId);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'EN_LIVRAISON');
    await page.reload();
    await openActionsMenu(page);
    await expect(menuItem(page, 'Marquer livree')).toBeVisible({ timeout: 15_000 });

    await menuItem(page, 'Marquer livree').click();
    await waitForOrderStatus(fixture.admin, orderId, 'LIVREE');
    await expect(page.getByText('Livrée').first()).toBeVisible({ timeout: 15_000 });

    const { data: order, error } = await fixture.admin
      .from('orders')
      .select(
        'cod_status, order_state, call_state, delivery_state, cash_state, cash_collectable_minor, payment_channel_at_delivery, assigned_driver_id',
      )
      .eq('id', orderId)
      .single();

    expect(error).toBeNull();
    expect(order?.cod_status).toBe('LIVREE');
    expect(order?.order_state).toBe('completed');
    expect(order?.call_state).toBe('validated');
    expect(order?.delivery_state).toBe('delivered');
    expect(order?.cash_state).toBe('collected');
    expect(order?.payment_channel_at_delivery).toBe('ESPECES');
    expect(order?.cash_collectable_minor).toBe(12345);
    // Le livreur choisi dans le dialog est bien persisté.
    expect(order?.assigned_driver_id).toBe(driverId);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('assigner a un livreur precis renseigne assigned_driver_id et monte le stock en main', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('assign-driver');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Livreur Stock');
  const productTitle = 'Sac Assign E2E';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  // Stock entrepôt via purchase_in (crée la position product_stock).
  // post_stock_movement exige un membre (garde NULL-safe 0043) → client owner authentifié.
  const ownerClient = await signInClient(fixture.email);
  await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'purchase_in',
    p_qty: 10,
    p_idempotency_key: `assign-in:${productId}`,
    p_created_by: fixture.userIds[0],
    p_unit_cost: 5000,
  });
  const orderId = await createConfirmedOrderWithLine(
    fixture.admin,
    fixture.merchantAccountId,
    productId,
    productTitle,
    2,
  );

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');
    await page.reload();

    await runDetailMenuAction(page, 'Assigner');
    // Sans livreur choisi, le bouton Valider reste désactivé.
    await expect(page.getByRole('button', { name: 'Valider', exact: true })).toBeDisabled();
    await page.getByLabel('Livreur', { exact: true }).selectOption(driverId);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'EN_LIVRAISON');

    // assigned_driver_id renseigné avec le livreur ciblé.
    const { data: order } = await fixture.admin
      .from('orders')
      .select('assigned_driver_id, delivery_state')
      .eq('id', orderId)
      .single();
    expect(order?.delivery_state).toBe('assigned');
    expect(order?.assigned_driver_id).toBe(driverId);

    // Le dispatch est attribué au livreur → stock en main du livreur dérivé = +2.
    const { data: movements } = await fixture.admin
      .from('stock_movement')
      .select('movement_type, qty, driver_id')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId);
    const dispatch = (movements ?? []).find((m) => m.movement_type === 'dispatch');
    expect(dispatch?.qty).toBe(-2);
    expect(dispatch?.driver_id).toBe(driverId);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('programmer fait passer la commande dans la vue En cours de livraison', async ({ page }) => {
  const fixture = await createOwnerFixture('schedule-today');
  await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'CONFIRMEE',
    customerName: 'Client Programme',
    phone: '+221772223344',
  });
  const { data: createdOrder } = await fixture.admin
    .from('orders')
    .select('id')
    .eq('merchant_account_id', fixture.merchantAccountId)
    .limit(1)
    .single();
  const orderId = createdOrder?.id as string;

  try {
    await signIn(page, fixture.email, '/commandes?vue=confirmee');
    await expect(page.getByText('Client Programme')).toBeVisible({ timeout: 15_000 });

    // Programmer (dropdown de la carte) ouvre le dialog date — défaut aujourd'hui.
    await runRowMenuAction(page, 'Client Programme', 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');

    const { data: order } = await fixture.admin
      .from('orders')
      .select('delivery_state, scheduled_for')
      .eq('id', orderId)
      .single();
    expect(order?.delivery_state).toBe('scheduled');
    expect(order?.scheduled_for).not.toBeNull();

    // delivery_state=scheduled → la commande tombe dans « En cours de livraison ».
    await page.goto('/commandes?vue=en-livraison');
    await expect(page).toHaveURL(/\/commandes\?(.*&)?vue=en-livraison(&.*)?$/);
    await expect(page.getByText('Client Programme')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('un agent ne voit que les actions legales sur une commande a appeler', async ({ page }) => {
  const fixture = await createOwnerFixture('agent-actions');
  const agent = await addMember(fixture, 'agent');
  const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

  try {
    await signIn(page, agent.email, `/commandes/${orderId}`);

    await openActionsMenu(page);
    // Un agent sur A_APPELER : seules Confirmer + journalisation d'appel sont légales.
    await expect(menuItem(page, 'Confirmer')).toBeVisible();
    await expect(menuItem(page, 'Journaliser un appel')).toBeVisible();
    await expect(menuItem(page, 'Programmer la livraison')).toHaveCount(0);
    await expect(menuItem(page, 'Assigner')).toHaveCount(0);
    await expect(menuItem(page, 'Marquer livree')).toHaveCount(0);
    await expect(menuItem(page, 'Annuler la commande')).toHaveCount(0);
    await expect(menuItem(page, 'Refuser')).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('confirmer puis programmer ne casse pas le rendu et survit au refresh', async ({ page }) => {
  const fixture = await createOwnerFixture('refresh');
  const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await runDetailMenuAction(page, 'Confirmer');
    await expect(page.locator('body')).not.toBeEmpty();
    await expect(page.getByText('Confirmée').first()).toBeVisible({ timeout: 15_000 });

    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await expect(page.locator('body')).not.toBeEmpty();
    await expect(page.getByText('Programmée').first()).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByText('Programmée').first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('un agent est refuse sur la page finances cote serveur', async ({ page }) => {
  const fixture = await createOwnerFixture('finance-agent');
  const agent = await addMember(fixture, 'agent');

  try {
    await signIn(page, agent.email, '/finances');
    await expect(page.getByText(messages.finance.restricted)).toBeVisible();
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('creer une commande manuelle la fait apparaitre dans Toutes et A appeler', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('manual-list');
  // Products must exist before page load (server-rendered props).
  await createProductInCatalog(fixture.admin, fixture.merchantAccountId, 'Sac Dakar E2E');

  try {
    await signIn(page, fixture.email, '/commandes');

    await page.getByRole('button', { name: 'Nouvelle commande', exact: true }).click();
    await page.getByLabel('Nom client').fill('Awa Manuelle');
    await page.getByLabel('Téléphone').fill('+221 77 111 22 33');

    // Filter the product dropdown then select.
    // select nth(0)=Source, nth(1)=first product line.
    await page.getByPlaceholder('Rechercher titre ou SKU').fill('Sac Dakar');
    await page.locator('select').nth(1).selectOption({ label: 'Sac Dakar E2E' });
    await page.getByLabel('Quantité').fill('1');
    await page.getByLabel('Prix unitaire (FCFA)').fill('14500');

    await page.getByRole('button', { name: 'Créer la commande' }).click();

    await expect(page.getByText('Commande créée.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Awa Manuelle')).toBeVisible({ timeout: 15_000 });

    await savedViewButton(page, 'À appeler').click();
    await expect(page).toHaveURL(/\/commandes\?(.*&)?vue=a-appeler(&.*)?$/);
    await expect(page.getByText('Awa Manuelle')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('commande manuelle a 2 produits cree 2 order_line matchees', async ({ page }) => {
  const fixture = await createOwnerFixture('manual-2prods');
  const idA = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    'Sac cuir E2E',
    'SAC-01',
  );
  const idB = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    'Ceinture E2E',
    'CEIN-01',
  );

  try {
    await signIn(page, fixture.email, '/commandes');

    await page.getByRole('button', { name: 'Nouvelle commande', exact: true }).click();
    await page.getByLabel('Nom client').fill('Multi Produit');
    await page.getByLabel('Téléphone').fill('+221 77 222 33 44');

    // Ligne 1 : Sac cuir
    await page.getByPlaceholder('Rechercher titre ou SKU').first().fill('Sac');
    await page.locator('select').nth(1).selectOption({ label: 'Sac cuir E2E (SAC-01)' });
    await page.getByLabel('Quantité').first().fill('2');
    await page.getByLabel('Prix unitaire (FCFA)').first().fill('10000');

    // Ajouter ligne 2
    await page.getByRole('button', { name: '+ Ajouter une ligne' }).click();

    // Ligne 2 : Ceinture — nth(1) car la première search box contient encore 'Sac'
    await page.getByPlaceholder('Rechercher titre ou SKU').nth(1).fill('Cein');
    await page.locator('select').nth(2).selectOption({ label: 'Ceinture E2E (CEIN-01)' });
    await page.getByLabel('Quantité').nth(1).fill('3');
    await page.getByLabel('Prix unitaire (FCFA)').nth(1).fill('8000');

    await page.getByRole('button', { name: 'Créer la commande' }).click();

    await expect(page.getByText('Commande créée.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Multi Produit')).toBeVisible({ timeout: 15_000 });

    // Vérifier 2 order_line matchées en base
    const { data: lines } = await fixture.admin
      .from('order_line')
      .select('product_id, qty, match_status')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .order('created_at');

    expect(lines).toHaveLength(2);
    expect(lines?.every((l) => l.match_status === 'matched')).toBe(true);
    expect(lines?.map((l) => l.product_id).sort()).toEqual([idA, idB].sort());
    expect(lines?.find((l) => l.product_id === idA)?.qty).toBe(2);
    expect(lines?.find((l) => l.product_id === idB)?.qty).toBe(3);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('la transition inline confirmee deplace la commande vers la bonne vue et survit au refresh', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('inline-list');
  await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'A_APPELER',
    customerName: 'Client Inline',
    phone: '+221771445566',
  });

  try {
    await signIn(page, fixture.email, '/commandes');

    await page.goto('/commandes?q=Client%20Inline&vue=a-appeler');
    await expect(page).toHaveURL(/\/commandes\?(.*&)?vue=a-appeler(&.*)?$/);
    await expect(page.getByText('Client Inline')).toBeVisible({ timeout: 15_000 });

    await runRowMenuAction(page, 'Client Inline', 'Confirmer');
    await expect(page.locator('article').filter({ hasText: 'Client Inline' })).toHaveCount(0, {
      timeout: 15_000,
    });

    // La vue « Programmer » garde l'id `confirmee` (deep-links préservés).
    await savedViewButton(page, 'Programmer').click();
    await expect(page).toHaveURL(/\/commandes\?(.*&)?vue=confirmee(&.*)?$/);
    await expect(page.getByText('Client Inline')).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByText('Client Inline')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('la recherche retrouve une commande par nom puis par telephone', async ({ page }) => {
  const fixture = await createOwnerFixture('search-list');
  await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'A_APPELER',
    customerName: 'Recherche Nadia',
    phone: '+221771998877',
    productName: 'Chaussure cuir',
  });

  try {
    await signIn(page, fixture.email, '/commandes');

    const searchInput = page.getByPlaceholder('Nom, telephone ou produit');

    await searchInput.fill('Nadia');
    await expect(page.getByText('Recherche Nadia')).toBeVisible({ timeout: 15_000 });

    await searchInput.fill('771998877');
    await expect(page.getByText('Recherche Nadia')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('le tableau deep-link vers la vue En cours de livraison', async ({ page }) => {
  const fixture = await createOwnerFixture('dashboard-deeplink');
  await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'EN_LIVRAISON',
    customerName: 'Livraison Dashboard',
    phone: '+221781223344',
  });

  try {
    await signIn(page, fixture.email, '/tableau');

    await page.getByRole('link', { name: 'En cours de livraison' }).click();
    await page.waitForURL('**/commandes?vue=en-livraison');
    await expect(page.getByText('Livraison Dashboard')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
