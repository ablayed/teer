import { existsSync, readFileSync } from 'node:fs';
import { legacyStatusToDimensions } from '@/lib/domain/order-transition-actions';
import messages from '@/messages/fr.json';
import { type Locator, type Page, expect, test } from '@playwright/test';
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
const password = 'Mot-de-passe-e2e-2026!';

test.setTimeout(60_000);

type AdminClient = SupabaseClient;
type Role = 'owner' | 'manager' | 'agent';

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
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
  let merchantAccountId = '';
  await expect
    .poll(
      async () => {
        const { data, error } = await admin
          .from('merchant_member')
          .select('merchant_account_id')
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle();

        if (error) {
          throw error;
        }

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
  // Contrainte 0057 : un statut dispatché (assigned/out_for_delivery) exige un livreur.
  const needsDriver =
    dimensions.deliveryState === 'assigned' || dimensions.deliveryState === 'out_for_delivery';
  const assignedDriverId = needsDriver
    ? await createDriver(admin, merchantAccountId, 'Livreur Seed')
    : dimensions.assignedDriverId;
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
      assigned_driver_id: assignedDriverId,
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

async function createShop(admin: AdminClient, merchantAccountId: string, domain: string) {
  const { error } = await admin.from('shop').insert({
    access_token_encrypted: 'enc',
    merchant_account_id: merchantAccountId,
    scopes: 'read_orders',
    shop_domain: domain,
  });
  if (error) throw error;
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

async function createOrderWithMatchedLine({
  admin,
  customerName,
  merchantAccountId,
  productId,
  productTitle,
  qty,
  status,
}: {
  admin: AdminClient;
  customerName: string;
  merchantAccountId: string;
  productId: string;
  productTitle: string;
  qty: number;
  status: Parameters<typeof legacyStatusToDimensions>[0];
}) {
  const orderId = await createOrderWithCustomer(admin, {
    customerName,
    merchantAccountId,
    productName: productTitle,
    status,
    totalAmount: 15000,
  });

  const { error } = await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    order_id: orderId,
    product_id: productId,
    raw_title: productTitle,
    qty,
    match_status: 'matched',
  });
  if (error) throw error;

  return orderId;
}

async function seedWarehouseStock({
  actorUserId,
  email,
  merchantAccountId,
  productId,
  qty,
  unitCost = 5000,
}: {
  actorUserId: string;
  email: string;
  merchantAccountId: string;
  productId: string;
  qty: number;
  unitCost?: number;
}) {
  const ownerClient = await signInClient(email);
  const { error } = await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'purchase_in',
    p_qty: qty,
    p_idempotency_key: `e2e-in:${productId}:${Date.now()}`,
    p_created_by: actorUserId,
    p_unit_cost: unitCost,
  });
  if (error) throw error;
}

async function reserveStockForOrder({
  actorUserId,
  email,
  merchantAccountId,
  orderId,
  productId,
  qty,
}: {
  actorUserId: string;
  email: string;
  merchantAccountId: string;
  orderId: string;
  productId: string;
  qty: number;
}) {
  const ownerClient = await signInClient(email);
  const { error } = await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'reserve',
    p_qty: qty,
    p_idempotency_key: `e2e-reserve:${orderId}:${Date.now()}`,
    p_created_by: actorUserId,
    p_order_id: orderId,
  });
  if (error) throw error;
}

// Attente auto-retry de l'état dérivé/dimensionnel en DB après une transition UI.
// expect.poll (et non un poll à durée fixe) : retente jusqu'au timeout avec un
// backoff, et émet un diff lisible à l'échec au lieu d'un throw opaque.
async function waitForOrderStatus(
  admin: AdminClient,
  orderId: string,
  status: string,
  timeoutMs = 30_000,
) {
  await expect
    .poll(
      async () => {
        const { data } = await admin.from('orders').select('cod_status').eq('id', orderId).single();
        return data?.cod_status ?? null;
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] },
    )
    .toBe(status);
}

async function waitForOrderDeliveryState(
  admin: AdminClient,
  orderId: string,
  deliveryState: string,
  timeoutMs = 30_000,
) {
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('orders')
          .select('delivery_state')
          .eq('id', orderId)
          .single();
        return data?.delivery_state ?? null;
      },
      { timeout: timeoutMs, intervals: [250, 500, 1000] },
    )
    .toBe(deliveryState);
}

async function signIn(page: Page, email: string, redirectTo = '/tableau') {
  const targetUrl =
    redirectTo === '/tableau'
      ? '/connexion'
      : `/connexion?redirectTo=${encodeURIComponent(redirectTo)}`;

  await page.goto(targetUrl);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
}

async function typeControlledNumber(input: Locator, value: string) {
  await input.click({ clickCount: 3 });
  await input.pressSequentially(value);
  await expect(input).toHaveValue(value);
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

async function openOrderDetailSheet(page: Page, orderId: string, customerName: string) {
  const detailDialog = page.getByRole('dialog');
  await page.locator(`a[href="/commandes/${orderId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/commandes/${orderId}$`, 'u'));
  // Attend un élément intérieur au dialog : intercepting routes Next.js peuvent être lentes
  // sous charge CI — le heading est le signal fiable que le panel est hydraté.
  await expect(detailDialog.getByRole('heading', { name: customerName, exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(detailDialog.getByRole('button', { name: 'Fermer', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  return detailDialog;
}

function savedViewButton(page: Page, label: string) {
  return page.getByRole('button', { name: new RegExp(`^${label} \\(`) });
}

function formatDateInput(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatTimeInput(hours: number, minutes: number): string {
  return `${`${hours}`.padStart(2, '0')}:${`${minutes}`.padStart(2, '0')}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E commandes');

test('chemin nominal confirmer programmer assigner livrer en especes', async ({ page }) => {
  const fixture = await createOwnerFixture('nominal');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Livreur Nominal');
  const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    // Programmer remplace le vieux couple Confirmer + Programmer.
    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');
    await page.reload();
    await expect(page.getByText('Programmée').first()).toBeVisible({ timeout: 15_000 });
    await openActionsMenu(page);
    await expect(menuItem(page, 'Assigner')).toBeVisible({ timeout: 15_000 });

    // Assigner ouvre un dialog imposant le choix d'un livreur actif.
    await menuItem(page, 'Assigner').click();
    await page.getByLabel('Livreur', { exact: true }).selectOption(driverId);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    // Phase 13.1 : le choix du livreur n'assigne PLUS — la commande reste « Programmée »
    // (scheduled) et le popup s'ouvre. C'est « Envoyer au livreur (WhatsApp) » qui assigne
    // (+dispatch) puis passe en out_for_delivery ET ouvre WhatsApp (C5). Réseau wa.me neutralisé.
    await waitForOrderDeliveryState(fixture.admin, orderId, 'scheduled');
    await page
      .context()
      .route('https://wa.me/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }),
      );
    const startButton = page.getByRole('button', {
      name: 'Envoyer au livreur (WhatsApp)',
      exact: true,
    });
    await expect(startButton).toBeVisible({ timeout: 15_000 });
    // Attendre que le bouton soit activable (dialog peut être en « Chargement… » avec bouton disabled).
    await expect(startButton).toBeEnabled({ timeout: 15_000 });
    const [whatsappPopup] = await Promise.all([page.waitForEvent('popup'), startButton.click()]);
    await waitForOrderDeliveryState(fixture.admin, orderId, 'out_for_delivery');

    // C5 : l'onglet WhatsApp cible le numéro du LIVREUR (+221 77 000 00 00 → 221770000000).
    await whatsappPopup.waitForURL(/wa\.me\/221770000000/, { timeout: 15_000 });
    expect(whatsappPopup.url()).toContain('wa.me/221770000000');
    await whatsappPopup.close();

    await waitForOrderStatus(fixture.admin, orderId, 'EN_LIVRAISON');
    await page.reload();
    await openActionsMenu(page);
    await expect(menuItem(page, 'Marquer livree')).toBeVisible({ timeout: 15_000 });

    await menuItem(page, 'Marquer livree').click();
    await waitForOrderStatus(fixture.admin, orderId, 'LIVREE');
    await page.reload();
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
    // Phase 13.1 : le picker n'assigne plus ; le popup s'ouvre. « Envoyer au livreur »
    // assigne (+dispatch attribué au livreur) puis passe en out_for_delivery. wa.me neutralisé.
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');
    await page
      .context()
      .route('https://wa.me/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }),
      );
    await page.getByRole('button', { name: 'Envoyer au livreur (WhatsApp)', exact: true }).click();
    await waitForOrderDeliveryState(fixture.admin, orderId, 'out_for_delivery');

    // assigned_driver_id renseigné avec le livreur ciblé (assignation faite au popup).
    const { data: order } = await fixture.admin
      .from('orders')
      .select('assigned_driver_id, delivery_state')
      .eq('id', orderId)
      .single();
    expect(order?.delivery_state).toBe('out_for_delivery');
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

test('phase13.1 - annuler le popup d assignation laisse la commande programmee sans livreur ni dispatch', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const fixture = await createOwnerFixture('assign-cancel');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Livreur Annule');
  const productTitle = 'Produit Annule Popup';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  const ownerClient = await signInClient(fixture.email);
  await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'purchase_in',
    p_qty: 10,
    p_idempotency_key: `assign-cancel-in:${productId}`,
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

    // Choix du livreur : ouvre le popup SANS assigner (Phase 13.1).
    await runDetailMenuAction(page, 'Assigner');
    await page.getByLabel('Livreur', { exact: true }).selectOption(driverId);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();

    // Annuler le popup → aucune transition.
    await expect(page.getByRole('button', { name: 'Annuler', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();

    // La commande reste « Programmée » : scheduled, aucun livreur affecté.
    const { data: order } = await fixture.admin
      .from('orders')
      .select('cod_status, delivery_state, assigned_driver_id')
      .eq('id', orderId)
      .single();
    expect(order?.cod_status).toBe('PROGRAMMEE');
    expect(order?.delivery_state).toBe('scheduled');
    expect(order?.assigned_driver_id).toBeNull();

    // Aucun dispatch stock posté (seule la réserve molle du programmer existe).
    const { data: movements } = await fixture.admin
      .from('stock_movement')
      .select('movement_type')
      .eq('order_id', orderId);
    const types = (movements ?? []).map((movement) => movement.movement_type);
    expect(types).not.toContain('dispatch');
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('phase11 - assigner ouvre le popup details puis passe en cours de livraison', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('phase11-editable');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Livreur Editable');
  const orderId = await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'A_APPELER',
    customerName: 'Client Editable',
    phone: '+221771223344',
  });
  const programDate = formatDateInput(addDays(new Date(), 1));
  const programTime = formatTimeInput(14, 30);
  const revisedDate = formatDateInput(addDays(new Date(), 1));
  const revisedTime = formatTimeInput(16, 45);

  try {
    await signIn(page, fixture.email, '/commandes?vue=a-appeler');
    await expect(page.getByText('Client Editable')).toBeVisible({ timeout: 15_000 });

    await runRowMenuAction(page, 'Client Editable', 'Programmer la livraison');
    await page.getByLabel('Date de livraison', { exact: true }).fill(programDate);
    await page.getByLabel('Heure de livraison', { exact: true }).fill(programTime);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');

    const { data: programmedOrder, error: programmedError } = await fixture.admin
      .from('orders')
      .select('delivery_state, scheduled_for')
      .eq('id', orderId)
      .single();
    expect(programmedError).toBeNull();
    expect(programmedOrder?.delivery_state).toBe('scheduled');
    expect(programmedOrder?.scheduled_for).not.toBeNull();

    // Phase 11.1 : une commande seulement programmée reste dans « Programmer »
    // (id confirmee), PAS dans « En cours de livraison » (migration 0062).
    await page.goto('/commandes?vue=confirmee');
    await expect(page.getByText('Client Editable')).toBeVisible({ timeout: 15_000 });

    await openActionsMenu(page);
    await expect(menuItem(page, 'Assigner')).toBeVisible({ timeout: 15_000 });
    await expect(menuItem(page, 'Marquer livree')).toHaveCount(0);
    // « Démarrer la livraison » n'est jamais dans le dropdown (popup uniquement).
    await expect(menuItem(page, 'Démarrer la livraison')).toHaveCount(0);
    await menuItem(page, 'Assigner').click();
    await expect(page.getByRole('button', { name: 'Valider', exact: true })).toBeDisabled();
    await page.getByLabel('Livreur', { exact: true }).selectOption(driverId);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    // Phase 13.1 : le choix du livreur n'assigne PLUS ; la commande reste scheduled et le
    // popup s'ouvre. L'assignation (+dispatch) se fait au clic « Envoyer au livreur ».
    await waitForOrderDeliveryState(fixture.admin, orderId, 'scheduled');

    // Le popup détails/prix s'ouvre automatiquement après le choix du livreur (depuis la liste).
    await expect(page.getByLabel('Total', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel('Frais de livraison', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByLabel('Date de livraison', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByLabel('Heure de livraison', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const totalInput = page.getByLabel('Total', { exact: true });
    await typeControlledNumber(totalInput, '25000');

    const deliveryFeeInput = page.getByLabel('Frais de livraison', { exact: true });
    await typeControlledNumber(deliveryFeeInput, '1500');
    await page.getByLabel('Date de livraison', { exact: true }).fill(revisedDate);
    await page.getByLabel('Heure de livraison', { exact: true }).fill(revisedTime);
    // « Envoyer au livreur (WhatsApp) » sauvegarde, passe en cours de livraison ET ouvre
    // WhatsApp avec le message reflétant le TOTAL ÉDITÉ (C5). Réseau wa.me neutralisé.
    await page
      .context()
      .route('https://wa.me/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }),
      );
    const sendButton = page.getByRole('button', {
      name: 'Envoyer au livreur (WhatsApp)',
      exact: true,
    });
    // Attendre que le bouton soit activable avant d'armer l'écouteur popup.
    await expect(sendButton).toBeEnabled({ timeout: 15_000 });
    const [whatsappPopup] = await Promise.all([page.waitForEvent('popup'), sendButton.click()]);
    await waitForOrderDeliveryState(fixture.admin, orderId, 'out_for_delivery');

    // C5 : le message d'expédition cible le livreur et porte le total édité (25 000).
    await whatsappPopup.waitForURL(/wa\.me\/221770000000/, { timeout: 15_000 });
    expect(decodeURIComponent(whatsappPopup.url())).toContain('25 000 F CFA');
    await whatsappPopup.close();

    const { data: updatedOrder, error: updatedError } = await fixture.admin
      .from('orders')
      .select('total_amount, delivery_fee_minor, scheduled_for, delivery_state')
      .eq('id', orderId)
      .single();
    expect(updatedError).toBeNull();
    expect(updatedOrder?.total_amount).toBe(25000);
    expect(updatedOrder?.delivery_fee_minor).toBe(1500);
    expect(updatedOrder?.scheduled_for).not.toBeNull();
    expect(updatedOrder?.delivery_state).toBe('out_for_delivery');

    // La commande est désormais dans « En cours de livraison ».
    await page.goto('/commandes?vue=en-livraison');
    await expect(page.getByText('Client Editable')).toBeVisible({ timeout: 15_000 });

    // En cours de livraison, le détail reste réouvrable/modifiable via « Modifier ».
    // WebKit/iphone-14 : la navigation RSC vers la vue peut être encore EN VOL et
    // interrompre le goto de réouverture (« interrupted by another navigation to
    // …vue=en-livraison »). On retente le goto jusqu'à stabilisation — déterministe et
    // borné (toPass), pas un timeout passif.
    await expect(async () => {
      await page.goto(`/commandes/${orderId}`);
    }).toPass({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Modifier', exact: true }).click();
    await expect(page.getByLabel('Total', { exact: true })).toHaveValue('25000');
    await expect(page.getByLabel('Frais de livraison', { exact: true })).toHaveValue('1500');
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('phase11 - la reassignation depuis Programmer et l agent n a pas les controles', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('phase11-reassign');
  const driverAId = await createDriver(
    fixture.admin,
    fixture.merchantAccountId,
    'Livreur A Phase11',
  );
  const driverBId = await createDriver(
    fixture.admin,
    fixture.merchantAccountId,
    'Livreur B Phase11',
  );
  const orderId = await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'A_APPELER',
    customerName: 'Client Reassign',
    phone: '+221771334455',
  });
  const agent = await addMember(fixture, 'agent');

  try {
    await signIn(page, fixture.email, '/commandes?vue=a-appeler');
    await runRowMenuAction(page, 'Client Reassign', 'Programmer la livraison');
    await page
      .getByLabel('Date de livraison', { exact: true })
      .fill(formatDateInput(addDays(new Date(), 1)));
    await page.getByLabel('Heure de livraison', { exact: true }).fill(formatTimeInput(10, 15));
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');

    // Programmée → vue « Programmer » (confirmee) ; on y CHOISIT le livreur via le picker.
    await page.goto('/commandes?vue=confirmee');
    await openActionsMenu(page);
    await menuItem(page, 'Assigner').click();
    await page.getByLabel('Livreur', { exact: true }).selectOption(driverAId);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    // Phase 13.1 : le picker CAPTURE le livreur SANS transition (la commande reste
    // « Programmée »/scheduled) et ouvre le popup. C'est « Envoyer au livreur (WhatsApp) »
    // qui assigne réellement (assigner + demarrer_livraison → out_for_delivery).
    await waitForOrderDeliveryState(fixture.admin, orderId, 'scheduled');

    // Neutralise wa.me et on NE consomme PAS l'event popup (source de flakiness WebKit) :
    // l'assignation (assigner + demarrer_livraison) se fait côté serveur quel que soit
    // le sort de la fenêtre WhatsApp → on s'aligne sur l'état DB.
    await page
      .context()
      .route('https://wa.me/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }),
      );
    await page.getByRole('button', { name: 'Envoyer au livreur (WhatsApp)', exact: true }).click();
    await waitForOrderDeliveryState(fixture.admin, orderId, 'out_for_delivery');

    // Affectée au livreur A et désormais « En cours de livraison ». On y réassigne vers B :
    // reassign_order_driver (0058) ne touche PAS delivery_state → la commande reste
    // out_for_delivery (donc dans cette vue), seul assigned_driver_id change.
    await page.goto('/commandes?vue=en-livraison');
    const row = page.locator('article').filter({ hasText: 'Client Reassign' });
    await expect(row.getByText('Affecté à', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('Livreur A Phase11')).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole('button', { name: 'Changer le livreur' })).toBeVisible({
      timeout: 15_000,
    });

    await row.getByRole('button', { name: 'Changer le livreur' }).click();
    await page.getByLabel('Nouveau livreur', { exact: true }).selectOption(driverBId);
    await page.getByRole('button', { name: 'Réassigner', exact: true }).click();
    await expect(row.getByText('Livreur B Phase11')).toBeVisible({ timeout: 15_000 });

    const { data: reassigned, error: reassignedError } = await fixture.admin
      .from('orders')
      .select('assigned_driver_id, delivery_state')
      .eq('id', orderId)
      .single();
    expect(reassignedError).toBeNull();
    expect(reassigned?.delivery_state).toBe('out_for_delivery');
    expect(reassigned?.assigned_driver_id).toBe(driverBId);

    await signIn(page, agent.email, `/commandes/${orderId}`);
    await expect(page.getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Changer le livreur' })).toHaveCount(0);
    await expect(page.getByLabel('Frais de livraison', { exact: true })).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('phase11 - la reassignation fonctionne aussi depuis la fiche commande', async ({ page }) => {
  const fixture = await createOwnerFixture('phase11-reassign-detail');
  const driverAId = await createDriver(
    fixture.admin,
    fixture.merchantAccountId,
    'Livreur Detail A',
  );
  const driverBId = await createDriver(
    fixture.admin,
    fixture.merchantAccountId,
    'Livreur Detail B',
  );
  const orderId = await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'PROGRAMMEE',
    customerName: 'Client Reassign Detail',
    phone: '+221771335566',
  });

  try {
    const { error: seedAssignedError } = await fixture.admin
      .from('orders')
      .update({
        cod_status: 'EN_LIVRAISON',
        delivery_state: 'assigned',
        assigned_driver_id: driverAId,
      })
      .eq('id', orderId);
    expect(seedAssignedError).toBeNull();

    await signIn(page, fixture.email, `/commandes/${orderId}`);
    await page.goto(`/commandes/${orderId}`);
    const reassignButton = page.getByRole('button', { name: 'Changer le livreur' });
    await expect(reassignButton).toBeVisible({ timeout: 15_000 });
    await reassignButton.click();
    await expect(page.getByLabel('Nouveau livreur', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByLabel('Nouveau livreur', { exact: true }).selectOption(driverBId);
    await page.getByRole('button', { name: 'Réassigner', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Livreur réassigné.');

    await expect
      .poll(
        async () => {
          const { data: reassigned, error: reassignedError } = await fixture.admin
            .from('orders')
            .select('assigned_driver_id, delivery_state')
            .eq('id', orderId)
            .single();
          expect(reassignedError).toBeNull();
          return {
            driverId: reassigned?.assigned_driver_id ?? null,
            state: reassigned?.delivery_state ?? null,
          };
        },
        { timeout: 15_000 },
      )
      .toEqual({ driverId: driverBId, state: 'assigned' });
    await page.reload();
    await expect(page.getByText('Affecté à Livreur Detail B')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('programmer garde la commande dans Programmer et hors En cours de livraison', async ({
  page,
}) => {
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

    // Phase 11.1 (0061) : scheduled reste dans « Programmer » (confirmee)…
    await page.goto('/commandes?vue=confirmee');
    await expect(page.getByText('Client Programme')).toBeVisible({ timeout: 15_000 });

    // …et est ABSENTE de « En cours de livraison » tant qu'elle n'est pas assignée.
    await page.goto('/commandes?vue=en-livraison');
    await expect(page).toHaveURL(/\/commandes\?(.*&)?vue=en-livraison(&.*)?$/);
    await expect(page.getByText('Client Programme')).toHaveCount(0);
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
    // Un agent sur A_APPELER : Programmer + À rappeler sont légales.
    await expect(menuItem(page, 'Programmer la livraison')).toBeVisible();
    await expect(menuItem(page, 'À rappeler')).toBeVisible();
    await expect(menuItem(page, 'Journaliser un appel')).toHaveCount(0);
    await expect(menuItem(page, 'Confirmer')).toHaveCount(0);
    await expect(menuItem(page, 'Assigner')).toHaveCount(0);
    await expect(menuItem(page, 'Marquer livree')).toHaveCount(0);
    await expect(menuItem(page, 'Annuler la commande')).toHaveCount(0);
    await expect(menuItem(page, 'Refuser')).toHaveCount(0);
    await expect(menuItem(page, 'Refuser par le client')).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('Lot B - deconfirmer libere la reserve et disparait apres dispatch', async ({ page }) => {
  const fixture = await createOwnerFixture('lotb-deconfirm-ui');
  const productTitle = 'Produit Deconfirmer E2E';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  await seedWarehouseStock({
    actorUserId: fixture.userIds[0],
    email: fixture.email,
    merchantAccountId: fixture.merchantAccountId,
    productId,
    qty: 20,
  });
  const orderId = await createOrderWithMatchedLine({
    admin: fixture.admin,
    customerName: 'Client Deconfirmer',
    merchantAccountId: fixture.merchantAccountId,
    productId,
    productTitle,
    qty: 3,
    status: 'CONFIRMEE',
  });
  await reserveStockForOrder({
    actorUserId: fixture.userIds[0],
    email: fixture.email,
    merchantAccountId: fixture.merchantAccountId,
    orderId,
    productId,
    qty: 3,
  });

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    const reservedAfterConfirm = await fixture.admin
      .from('product_stock')
      .select('qty_on_hand, qty_reserved')
      .eq('product_id', productId)
      .single();
    expect(reservedAfterConfirm.data?.qty_on_hand).toBe(20);
    expect(reservedAfterConfirm.data?.qty_reserved).toBe(3);

    await runDetailMenuAction(page, 'Déconfirmer');
    await waitForOrderStatus(fixture.admin, orderId, 'A_APPELER');

    const { data: deconfirmed } = await fixture.admin
      .from('orders')
      .select('call_state, delivery_state, scheduled_for')
      .eq('id', orderId)
      .single();
    expect(deconfirmed?.call_state).toBe('to_call');
    expect(deconfirmed?.delivery_state).toBe('unassigned');
    expect(deconfirmed?.scheduled_for).toBeNull();

    const reservedAfterDeconfirm = await fixture.admin
      .from('product_stock')
      .select('qty_on_hand, qty_reserved')
      .eq('product_id', productId)
      .single();
    expect(reservedAfterDeconfirm.data?.qty_on_hand).toBe(20);
    expect(reservedAfterDeconfirm.data?.qty_reserved).toBe(0);

    const { data: firstMovements } = await fixture.admin
      .from('stock_movement')
      .select('movement_type, qty')
      .eq('order_id', orderId)
      .order('created_at');
    expect(firstMovements?.map((movement) => movement.movement_type)).toEqual([
      'reserve',
      'release',
    ]);
    expect(firstMovements?.map((movement) => movement.qty)).toEqual([3, -3]);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test("Lot B - deconfirmer n'est pas propose apres dispatch", async ({ page }) => {
  const fixture = await createOwnerFixture('lotb-no-deconfirm-dispatch');
  const orderId = await createOrderWithCustomer(fixture.admin, {
    customerName: 'Client Dispatch Lot B',
    merchantAccountId: fixture.merchantAccountId,
    status: 'EN_LIVRAISON',
  });

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    // Phase 13.1 (bug #2) : rouvrir une commande déjà assignée en consultation NE rouvre
    // PLUS le popup d'assignation (autoOpenAssignment retiré du détail — l'overlay
    // interceptait les clics, p.ex. « Changer le livreur »). On accède donc directement
    // au menu, sans popup à fermer.
    await openActionsMenu(page);
    await expect(menuItem(page, 'Déconfirmer')).toHaveCount(0);
    await expect(menuItem(page, 'Livrer')).toHaveCount(0);
    await expect(menuItem(page, 'Marquer livree')).toBeVisible();
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('Lot B - annuler avec raisons puis desannuler efface sans mouvement stock', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('lotb-desannuler-ui');
  const productTitle = 'Produit Desannuler E2E';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  await seedWarehouseStock({
    actorUserId: fixture.userIds[0],
    email: fixture.email,
    merchantAccountId: fixture.merchantAccountId,
    productId,
    qty: 20,
  });
  const orderId = await createOrderWithMatchedLine({
    admin: fixture.admin,
    customerName: 'Client Desannuler',
    merchantAccountId: fixture.merchantAccountId,
    productId,
    productTitle,
    qty: 2,
    status: 'A_APPELER',
  });

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');

    await page.reload();
    await runDetailMenuAction(page, 'Annuler la commande');
    await expect(page.getByRole('button', { name: "Confirmer l'annulation" })).toBeDisabled();
    await page.getByLabel('Prix trop élevé').check();
    await page.getByLabel('Trouvé moins cher ailleurs').check();
    await page.getByRole('button', { name: "Confirmer l'annulation" }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'ANNULEE');

    await page.reload();
    await expect(page.getByText('Prix trop élevé')).toBeVisible();
    await expect(page.getByText('Trouvé moins cher ailleurs')).toBeVisible();

    const { data: cancelled } = await fixture.admin
      .from('orders')
      .select('order_state, cancel_reason, cancel_reasons')
      .eq('id', orderId)
      .single();
    expect(cancelled?.order_state).toBe('cancelled');
    expect(cancelled?.cancel_reason).toBe('prix');
    expect(cancelled?.cancel_reasons).toEqual(['prix', 'concurrence']);

    const { data: movementsBefore } = await fixture.admin
      .from('stock_movement')
      .select('movement_type, qty')
      .eq('order_id', orderId)
      .order('created_at');
    expect(movementsBefore?.map((movement) => movement.movement_type)).toEqual([
      'reserve',
      'release',
    ]);
    expect(movementsBefore?.map((movement) => movement.qty)).toEqual([2, -2]);

    await runDetailMenuAction(page, 'Désannuler');
    await waitForOrderStatus(fixture.admin, orderId, 'A_APPELER');

    const { data: reopened } = await fixture.admin
      .from('orders')
      .select('order_state, call_state, delivery_state, cancel_reason, cancel_reasons')
      .eq('id', orderId)
      .single();
    expect(reopened?.order_state).toBe('open');
    expect(reopened?.call_state).toBe('to_call');
    expect(reopened?.delivery_state).toBe('unassigned');
    expect(reopened?.cancel_reason).toBeNull();
    expect(reopened?.cancel_reasons).toBeNull();

    const { data: movementsAfter } = await fixture.admin
      .from('stock_movement')
      .select('id')
      .eq('order_id', orderId);
    expect(movementsAfter).toHaveLength(2);

    const { data: stock } = await fixture.admin
      .from('product_stock')
      .select('qty_on_hand, qty_reserved')
      .eq('product_id', productId)
      .single();
    expect(stock?.qty_on_hand).toBe(20);
    expect(stock?.qty_reserved).toBe(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('programmer ne casse pas le rendu et survit au refresh', async ({ page }) => {
  const fixture = await createOwnerFixture('refresh');
  const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await expect(page.locator('body')).not.toBeEmpty();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');
    await page.reload();
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
  await createShop(fixture.admin, fixture.merchantAccountId, `manual-${Date.now()}.myshopify.com`);

  try {
    await signIn(page, fixture.email, '/commandes');

    await page.getByRole('button', { name: 'Nouvelle commande', exact: true }).click();
    await page.getByLabel('Nom client').fill('Awa Manuelle');
    await page.getByLabel('Téléphone').fill('+221 77 111 22 33');

    // Filter the product dropdown then select.
    // select nth(0)=Source, nth(1)=first product line.
    await page.getByPlaceholder('Rechercher titre ou SKU').fill('Sac Dakar');
    await page.locator('select').nth(1).selectOption({ label: 'Sac Dakar E2E' });
    await typeControlledNumber(page.getByLabel('Quantité'), '1');
    await typeControlledNumber(page.getByLabel('Prix unitaire (FCFA)'), '14500');

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
  await createShop(
    fixture.admin,
    fixture.merchantAccountId,
    `manual-2-${Date.now()}.myshopify.com`,
  );

  try {
    await signIn(page, fixture.email, '/commandes');

    await page.getByRole('button', { name: 'Nouvelle commande', exact: true }).click();
    await page.getByLabel('Nom client').fill('Multi Produit');
    await page.getByLabel('Téléphone').fill('+221 77 222 33 44');

    // Ligne 1 : Sac cuir
    await page.getByPlaceholder('Rechercher titre ou SKU').first().fill('Sac');
    await page.locator('select').nth(1).selectOption({ label: 'Sac cuir E2E (SAC-01)' });
    await typeControlledNumber(page.getByLabel('Quantité').first(), '2');
    await typeControlledNumber(page.getByLabel('Prix unitaire (FCFA)').first(), '10000');

    // Ajouter ligne 2
    await page.getByRole('button', { name: '+ Ajouter une ligne' }).click();

    // Ligne 2 : Ceinture — nth(1) car la première search box contient encore 'Sac'
    await page.getByPlaceholder('Rechercher titre ou SKU').nth(1).fill('Cein');
    await page.locator('select').nth(2).selectOption({ label: 'Ceinture E2E (CEIN-01)' });
    await typeControlledNumber(page.getByLabel('Quantité').nth(1), '3');
    await typeControlledNumber(page.getByLabel('Prix unitaire (FCFA)').nth(1), '8000');

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

    await runRowMenuAction(page, 'Client Inline', 'Programmer la livraison');
    // « Programmer » ouvre un dialog (date du jour par défaut) avant la transition.
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await expect
      .poll(
        () => {
          const url = new URL(page.url());
          return {
            q: url.searchParams.get('q'),
            vue: url.searchParams.get('vue'),
          };
        },
        { timeout: 15_000 },
      )
      // Phase 13.1 : l'URL préserve la recherche en CASSE D'ORIGINE (le router.replace
      // cosmétique de re-casse a été retiré — il causait une course avec l'ouverture du
      // modal). Le matching reste insensible à la casse côté serveur ; q est conservé tel
      // que tapé/deep-linké (« Client Inline »), pas re-cassé en « client inline ».
      .toEqual({
        q: 'Client Inline',
        vue: 'a-appeler',
      });
    await expect(page).toHaveURL(/\/commandes\?/);
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

test('fermer le detail conserve la vue et la recherche d origine', async ({ page }) => {
  const fixture = await createOwnerFixture('detail-close-preserves-view');
  const orderId = await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'PROGRAMMEE',
    customerName: 'Client Detail Preserve',
    phone: '+221771556677',
  });

  try {
    await signIn(page, fixture.email, '/commandes');

    // L'app NORMALISE la recherche dans l'URL : « Client Detail Preserve » →
    // « q=client+detail+preserve » (minuscules + encodage `+`). Le regex tolère
    // donc la casse (i) et les deux encodages (`+` ou `%20`), et vérifie que vue ET
    // recherche sont présentes (lookaheads, ordre indifférent).
    const preservedViewUrl =
      /\/commandes\?(?=.*vue=confirmee)(?=.*q=client(\+|%20)detail(\+|%20)preserve)/i;
    await page.goto('/commandes?q=Client%20Detail%20Preserve&vue=confirmee');
    await expect(page).toHaveURL(preservedViewUrl);
    await expect(page.getByText('Client Detail Preserve')).toBeVisible({ timeout: 15_000 });

    const detailDialog = await openOrderDetailSheet(page, orderId, 'Client Detail Preserve');

    // Geste central : fermer le détail (router.back) → retour dans la vue filtrée AVEC la
    // recherche (vérifié manuellement : .../commandes?q=client+detail+preserve&vue=confirmee).
    await detailDialog.getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(page).toHaveURL(preservedViewUrl, { timeout: 20_000 });
    await expect(detailDialog).toHaveCount(0);
    await expect(page.getByText('Client Detail Preserve')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Client Detail Preserve' })).toHaveCount(0);
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

test('#2 le menu Actions de la carte la plus basse reste atteignable en portrait', async ({
  page,
}, testInfo) => {
  const fixture = await createOwnerFixture('actions-reachable');
  // Plusieurs commandes pour que la liste defile : la derniere carte se retrouve
  // en bas de l'ecran, juste au-dessus de la barre de nav fixe (cas du bug #2).
  for (let i = 0; i < 8; i += 1) {
    await createOrderWithCustomer(fixture.admin, {
      merchantAccountId: fixture.merchantAccountId,
      status: 'A_APPELER',
      customerName: `Client Bas ${i}`,
      phone: `+22177100${String(i).padStart(4, '0')}`,
    });
  }

  try {
    await signIn(page, fixture.email, '/commandes');
    await expect(page.getByText('Client Bas 0')).toBeVisible({ timeout: 15_000 });

    // Defile en bas pour placer la derniere carte au ras de la barre de nav.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    const lastCard = page.locator('article').last();
    await lastCard.getByRole('button', { name: 'Actions' }).click();

    // La derniere entree du menu doit etre cliquable (non masquee par la nav fixe) :
    // un trial click verifie l'actionnabilite (visible + recoit les evenements)
    // sans declencher la transition, et echoue si la barre de nav l'intercepte.
    const items = page.getByRole('menuitem');
    const lastItem = items.last();
    await expect(lastItem).toBeVisible({ timeout: 5_000 });
    await lastItem.click({ trial: true });

    // Et son bord inferieur reste dans le viewport (jamais sous le bas de l'ecran).
    const box = await lastItem.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize() ??
      testInfo.project.use.viewport ?? { width: 0, height: 0 };
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height + 1);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('le tableau deep-link vers la vue En cours de livraison', async ({ page }) => {
  const fixture = await createOwnerFixture('dashboard-deeplink');
  const orderId = await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'EN_LIVRAISON',
    customerName: 'Livraison Dashboard',
    phone: '+221781223344',
  });
  // Phase 11.1 (0062) : seule out_for_delivery apparaît dans « En cours de livraison »
  // (assigned reste dans « Programmer »). Le seed legacy EN_LIVRAISON pose assigned →
  // on passe la dimension à out_for_delivery (le livreur seed est déjà renseigné).
  await fixture.admin
    .from('orders')
    .update({ delivery_state: 'out_for_delivery' })
    .eq('id', orderId);

  try {
    await signIn(page, fixture.email, '/tableau');

    const deepLink = page.getByRole('link', { name: 'En cours de livraison' });
    await expect(deepLink).toBeVisible({ timeout: 15_000 });
    await deepLink.click();
    await expect(page.getByText('Livraison Dashboard')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
