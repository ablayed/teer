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
    orderNumber,
    phone = '+221771234567',
    productName = 'Produit E2E',
    status,
    totalAmount = 12345,
  }: {
    customerName?: string;
    merchantAccountId: string;
    orderNumber?: string;
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
      order_number: orderNumber ?? `E2E-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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

  // Le seed insère l'état final directement (bypass transition_order) : sans cette ligne,
  // order_state_transition reste vide pour cette commande — cassant tout code qui borne une
  // vue Tableau sur la dernière transition (ex. « En cours de livraison » / « Annulées /
  // Retours », period=7j via order_state_transition.to_status). On simule la transition
  // d'arrivée dans l'état seedé pour que ces vues restent cohérentes en E2E.
  const { data: member } = await admin
    .from('merchant_member')
    .select('user_id')
    .eq('merchant_account_id', merchantAccountId)
    .limit(1)
    .maybeSingle();

  if (member?.user_id) {
    await admin.from('order_state_transition').insert({
      merchant_account_id: merchantAccountId,
      order_id: order.id,
      from_status: null,
      to_status: status,
      actor_user_id: member.user_id,
    });
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

function orderRowTitle(page: Page, name: string) {
  return page.locator('[data-testid="order-row-title"]:visible', { hasText: name }).first();
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
  const listUrl = page.url();
  const detailDialog = page.getByRole('dialog');
  const detailHeading = detailDialog.getByRole('heading', { name: customerName, exact: true });
  const closeButton = detailDialog.getByRole('button', { name: 'Fermer', exact: true });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) {
      // Résidu documenté des intercepting routes Next.js sous charge : l'URL détail
      // est atteinte mais le @modal ne se monte pas. On réouvre une fois depuis la
      // liste filtrée pour garder l'intention métier du test sans délai fixe.
      await page.goto(listUrl);
      await expect(page).toHaveURL(listUrl);
    }

    await page.locator(`a[href="/commandes/${orderId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/commandes/${orderId}$`, 'u'));

    try {
      await expect(detailHeading).toBeVisible({ timeout: 15_000 });
      await expect(closeButton).toBeVisible({ timeout: 15_000 });
      return detailDialog;
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
    }
  }

  throw new Error('Order detail sheet did not open');
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
      .route('https://api.whatsapp.com/**', (route) =>
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

    // C5 : l'onglet WhatsApp ouvre le composeur sans destinataire pré-rempli (api.whatsapp.com/send).
    await whatsappPopup.waitForURL(/api\.whatsapp\.com\/send/, { timeout: 15_000 });
    expect(whatsappPopup.url()).toContain('api.whatsapp.com/send');
    await whatsappPopup.close();

    await waitForOrderStatus(fixture.admin, orderId, 'EN_LIVRAISON');
    await page.reload();
    await openActionsMenu(page);
    await expect(menuItem(page, 'Marquer livree')).toBeVisible({ timeout: 15_000 });

    await menuItem(page, 'Marquer livree').click();
    // 0114 : « Marquer livrée » ouvre désormais un dialog. On valide sans rien saisir —
    // le champ de date réelle est optionnel, et ne pas le remplir doit reproduire
    // exactement la transition d'avant ce lot (cash_collected_at = now()).
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
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
      .route('https://api.whatsapp.com/**', (route) =>
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

test('stock insuffisant : le bandeau informatif detaille le manque par produit sans bloquer l assignation', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('stock-warning');
  const driverId = await createDriver(
    fixture.admin,
    fixture.merchantAccountId,
    'Livreur Sous Stock',
  );
  const productTitle = 'Sac Manque E2E';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  const ownerClient = await signInClient(fixture.email);
  // Le livreur détient déjà 1 unité (dispatch antérieur simulé) ; la commande ci-dessous
  // en requiert 3 → disponible=1, requis=3, manque attendu = 2 (Lot 2 / PR 3).
  await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'dispatch',
    p_qty: -1,
    p_idempotency_key: `stock-warn-seed:${productId}`,
    p_created_by: fixture.userIds[0],
    p_driver_id: driverId,
  });
  const orderId = await createConfirmedOrderWithLine(
    fixture.admin,
    fixture.merchantAccountId,
    productId,
    productTitle,
    3,
  );

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');
    await page.reload();
    await expect(page.getByText('Programmée').first()).toBeVisible({ timeout: 15_000 });

    await runDetailMenuAction(page, 'Assigner');
    await page.getByLabel('Livreur', { exact: true }).selectOption(driverId);
    // Lot 2 / PR 4 — non-régression owner/manager : TransitionDialog (cette étape, avant le
    // clic Valider) ne montre JAMAIS le bandeau pour owner/manager (enableStockWarning=false
    // ici, car canEditAmounts=true bascule vers AssignmentDetailsDialog juste après) — même
    // livreur sous-stocké que ci-dessous, la seule alerte visible reste celle du popup.
    await expect(page.getByText('Stock insuffisant')).not.toBeVisible();
    await page.getByRole('button', { name: 'Valider', exact: true }).click();

    // Bandeau informatif : titre + détail par produit avec le manque exact (3 requis − 1
    // disponible = 2), affiché avant même le clic sur « Envoyer au livreur ».
    await expect(page.getByText('Stock insuffisant')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`${productTitle} : manque 2`)).toBeVisible();

    await page
      .context()
      .route('https://api.whatsapp.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }),
      );
    // Non-bloquant : le bouton d'assignation reste actif malgré le manque et l'assignation
    // aboutit exactement comme sans alerte.
    await expect(
      page.getByRole('button', { name: 'Envoyer au livreur (WhatsApp)', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Envoyer au livreur (WhatsApp)', exact: true }).click();
    await waitForOrderDeliveryState(fixture.admin, orderId, 'out_for_delivery');

    const { data: order } = await fixture.admin
      .from('orders')
      .select('assigned_driver_id, delivery_state')
      .eq('id', orderId)
      .single();
    expect(order?.delivery_state).toBe('out_for_delivery');
    expect(order?.assigned_driver_id).toBe(driverId);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('stock insuffisant (agent) : le bandeau apparait dans TransitionDialog sans bloquer l assignation', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('stock-warning-agent');
  const driverId = await createDriver(
    fixture.admin,
    fixture.merchantAccountId,
    'Livreur Agent Sous Stock',
  );
  const productTitle = 'Sac Manque Agent E2E';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  const ownerClient = await signInClient(fixture.email);
  // Même scénario que le test owner/manager ci-dessus : disponible=1, requis=3, manque=2.
  await ownerClient.rpc('post_stock_movement', {
    p_merchant_account_id: fixture.merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'dispatch',
    p_qty: -1,
    p_idempotency_key: `stock-warn-agent-seed:${productId}`,
    p_created_by: fixture.userIds[0],
    p_driver_id: driverId,
  });
  const orderId = await createConfirmedOrderWithLine(
    fixture.admin,
    fixture.merchantAccountId,
    productId,
    productTitle,
    3,
  );
  const agent = await addMember(fixture, 'agent');

  try {
    // Chemin agent de bout en bout (Programmer + Assigner autorisés pour agent).
    await signIn(page, agent.email, `/commandes/${orderId}`);

    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');
    await page.reload();
    await expect(page.getByText('Programmée').first()).toBeVisible({ timeout: 15_000 });

    // Un agent n'atteint jamais AssignmentDetailsDialog (canEditAmounts=false) : le clic
    // « Assigner » ouvre TransitionDialog et y reste jusqu'à « Valider ».
    await runDetailMenuAction(page, 'Assigner');
    await page.getByLabel('Livreur', { exact: true }).selectOption(driverId);

    await expect(page.getByText('Stock insuffisant')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`${productTitle} : manque 2`)).toBeVisible();

    // Non-bloquant : « Valider » reste actif malgré le manque et assigne directement
    // (pas de popup WhatsApp intermédiaire pour l'agent).
    await expect(page.getByRole('button', { name: 'Valider', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderDeliveryState(fixture.admin, orderId, 'assigned');

    const { data: order } = await fixture.admin
      .from('orders')
      .select('assigned_driver_id, delivery_state')
      .eq('id', orderId)
      .single();
    expect(order?.delivery_state).toBe('assigned');
    expect(order?.assigned_driver_id).toBe(driverId);
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
    await expect(orderRowTitle(page, 'Client Editable')).toBeVisible({ timeout: 15_000 });

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
    await expect(orderRowTitle(page, 'Client Editable')).toBeVisible({ timeout: 15_000 });

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

    await expect(page.getByLabel('Frais de livraison', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Frais de livraison', { exact: true })).toHaveAttribute(
      'placeholder',
      'Frais de livraison',
    );

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
      .route('https://api.whatsapp.com/**', (route) =>
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

    // C5 : le message d'expédition porte le total édité (25 000), sans destinataire pré-rempli.
    await whatsappPopup.waitForURL(/api\.whatsapp\.com\/send/, { timeout: 15_000 });
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
    await expect(orderRowTitle(page, 'Client Editable')).toBeVisible({ timeout: 15_000 });

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

    // Neutralise api.whatsapp.com et on NE consomme PAS l'event popup (source de flakiness WebKit) :
    // l'assignation (assigner + demarrer_livraison) se fait côté serveur quel que soit
    // le sort de la fenêtre WhatsApp → on s'aligne sur l'état DB.
    await page
      .context()
      .route('https://api.whatsapp.com/**', (route) =>
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

// Sujets 1.1 / 1.2 : la date+heure programmée et l'heure de réception sont rendues.
// Avant ce lot, `scheduled_for` n'était visible QUE dans le modal « Modifier les
// montants » (owner/manager) et `created_at` nulle part dans le détail.
test('la date/heure programmée et l heure de reception sont visibles (liste + detail)', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('schedule-display');
  await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'CONFIRMEE',
    customerName: 'Client Affichage',
    phone: '+221772223355',
  });
  const { data: createdOrder } = await fixture.admin
    .from('orders')
    .select('id')
    .eq('merchant_account_id', fixture.merchantAccountId)
    .limit(1)
    .single();
  const orderId = createdOrder?.id as string;
  const dateTimePattern = /\d{1,2} \S+ \d{4} à \d{2}:\d{2}/;

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    // 1.2 : l'heure de réception est affichée dès l'ouverture du détail, quel que
    // soit l'état de la commande (aucune programmation nécessaire).
    await expect(page.getByTestId('order-created-at')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('order-created-at')).toContainText(dateTimePattern);

    // Une commande non programmée n'affiche AUCUNE date de livraison.
    await expect(page.getByTestId('order-scheduled-for')).toHaveCount(0);

    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');

    // 1.1 (detail) : jour ET heure, pas seulement le jour.
    // `page.reload()` et non `page.goto(<url courante>)` : la seconde entre en course
    // avec la navigation que l'app déclenche elle-même après la transition
    // (« Navigation is interrupted by another navigation », observé sur iphone-14).
    await page.reload();
    await expect(page.getByTestId('order-scheduled-for')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('order-scheduled-for')).toContainText(dateTimePattern);

    // 1.1 (vue « Programmer ») : même information sur la ligne de liste.
    //
    // ⚠️ Uniquement au-delà des écrans étroits. `ResourceRow` masque TOUTE sa ligne
    // `meta` sous 22rem de largeur de conteneur (`@max-[22rem]/row:hidden`,
    // components/ui/resource-row.tsx) — numéro de commande, date relative et cette
    // date de livraison comprises. Sur iphone-14 (390 px) le conteneur passe sous ce
    // seuil, la ligne n'est donc jamais rendue. Ce n'est pas une régression de ce lot
    // mais un comportement responsive préexistant ; sur ces écrans, la date de
    // livraison reste accessible sur le DÉTAIL de la commande, déjà asserté ci-dessus
    // sur tous les profils. Assertion conditionnée à la largeur réelle du viewport
    // plutôt que supprimée : elle garde toute sa valeur sur desktop et pixel-7.
    await page.goto('/commandes?vue=confirmee');
    await expect(page.getByText('Client Affichage')).toBeVisible({ timeout: 15_000 });
    const viewportWidth = page.viewportSize()?.width ?? 0;
    if (viewportWidth >= 400) {
      const rowScheduled = page.locator('[data-testid="order-row-scheduled-for"]:visible').first();
      await expect(rowScheduled).toBeVisible({ timeout: 15_000 });
      await expect(rowScheduled).toContainText(dateTimePattern);
    }
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
      .order('created_at')
      .order('movement_type')
      .order('id');
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
      .order('created_at')
      .order('movement_type')
      .order('id');
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

test('Commandes : creer une commande manuelle la fait apparaitre dans Toutes et A appeler', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('manual-list');
  // Products must exist before page load (server-rendered props).
  await createProductInCatalog(fixture.admin, fixture.merchantAccountId, 'Sac Dakar E2E');
  await createShop(fixture.admin, fixture.merchantAccountId, `manual-${Date.now()}.myshopify.com`);
  await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'A_APPELER',
    customerName: 'Ancienne commande manuelle',
    orderNumber: 'MAN-1784224328347',
  });

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

    // Le numéro est une méta masquée par la container query sur un rail iPhone étroit.
    // La non-régression demandée est la persistance du numéro historique, vérifiée ici
    // directement plutôt que par une visibilité qui varie selon le viewport.
    const { data: legacyManualOrder, error: legacyManualOrderError } = await fixture.admin
      .from('orders')
      .select('order_number')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('order_number', 'MAN-1784224328347')
      .single();

    expect(legacyManualOrderError).toBeNull();
    expect(legacyManualOrder?.order_number).toBe('MAN-1784224328347');

    const { data: createdManualCustomer, error: createdManualCustomerError } = await fixture.admin
      .from('customer')
      .select('id')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('full_name', 'Awa Manuelle')
      .single();

    expect(createdManualCustomerError).toBeNull();

    const { data: createdManualOrder, error: createdManualOrderError } = await fixture.admin
      .from('orders')
      .select('order_number')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('customer_id', createdManualCustomer?.id ?? '')
      .single();

    expect(createdManualOrderError).toBeNull();
    expect(createdManualOrder?.order_number).toMatch(/^M-\d+$/);

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

test('panier : owner remplace les lignes avant assignation et le total est recalculé', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('cart-edit');
  const productA = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    'Produit panier initial',
  );
  const productB = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    'Produit panier remplacé',
  );
  const orderId = await createOrderWithMatchedLine({
    admin: fixture.admin,
    customerName: 'Client panier',
    merchantAccountId: fixture.merchantAccountId,
    productId: productA,
    productTitle: 'Produit panier initial',
    qty: 1,
    status: 'A_APPELER',
  });

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await page.getByRole('button', { name: 'Modifier panier' }).click();
    const productSelect = page.getByLabel('Produit sélectionné');
    await expect(productSelect).toBeVisible();
    await page.getByRole('textbox', { name: 'Produit' }).fill('remplacé');
    await productSelect.selectOption(productB);
    await typeControlledNumber(page.getByLabel('Quantité'), '3');
    await typeControlledNumber(page.getByLabel('Prix unitaire'), '2500');
    await expect(page.getByText('7 500', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Enregistrer le panier' }).click();
    await expect(page.getByText('Panier mis à jour.')).toBeVisible({ timeout: 15_000 });

    const { data: order } = await fixture.admin
      .from('orders')
      .select('total_amount, cash_collectable_minor, cart_locally_modified_at')
      .eq('id', orderId)
      .single();
    expect(order).toMatchObject({ total_amount: 7500, cash_collectable_minor: 7500 });
    expect(order?.cart_locally_modified_at).toBeTruthy();

    const { data: lines } = await fixture.admin
      .from('order_line')
      .select('product_id, qty, match_status')
      .eq('order_id', orderId);
    expect(lines).toEqual([{ product_id: productB, qty: 3, match_status: 'matched' }]);
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

test.describe('detail sheet preserve search and view', () => {
  // Bruit résiduel documenté des intercepting routes Next.js en CI extrême :
  // l'URL /commandes/<id> est atteinte mais le @modal ne se monte pas 1 fois de
  // temps en temps, sans erreur applicative ni régression produit. On borne ce
  // résidu au seul scénario touché, sans remonter les retries globalement. Le
  // protocole zéro-flake garde `retries:0` pour continuer à mesurer ce bruit.
  test.describe.configure({ retries: process.env.GITHUB_WORKFLOW === 'e2e-zero-flake' ? 0 : 1 });

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

test('Commandes : la recherche par order-number retrouve Shopify avec ou sans # sans confondre le format manuel', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('search-order-number');
  await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'A_APPELER',
    customerName: 'Recherche numero Shopify',
    orderNumber: '#2803',
  });
  await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'A_APPELER',
    customerName: 'Recherche numero manuel',
    orderNumber: 'M-2803',
  });

  try {
    await signIn(page, fixture.email, '/commandes');

    const searchInput = page.getByPlaceholder('Nom, telephone ou produit');
    await searchInput.fill('# 2803');
    await expect(page.getByText('Recherche numero Shopify')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Recherche numero manuel')).toHaveCount(0);

    await searchInput.fill('2803');
    await expect(page.getByText('Recherche numero Shopify')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Recherche numero manuel')).toHaveCount(0);
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
    await expect(orderRowTitle(page, 'Livraison Dashboard')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

// Lot 3 (Sujet A/B/C) : "Déprogrammer" + template client conditionnel + fix du
// cycle d'ouverture WhatsApp en mode compact (liste). Voir CLAUDE.md.
function whatsappComposeDialog(page: Page) {
  return page.getByRole('dialog').filter({ hasText: messages.whatsapp.composeTitle });
}

test('Lot 3 - Déprogrammer ramène une commande Programmée vers À appeler', async ({ page }) => {
  const fixture = await createOwnerFixture('lot3-deprogrammer');
  const orderId = await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'PROGRAMMEE',
    customerName: 'Client Deprogrammer',
    phone: '+221771667788',
  });

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await openActionsMenu(page);
    // Le libellé reflète le contexte "scheduled" — jamais "Déconfirmer" ici.
    await expect(menuItem(page, 'Déprogrammer')).toBeVisible({ timeout: 15_000 });
    await expect(menuItem(page, 'Déconfirmer')).toHaveCount(0);
    await menuItem(page, 'Déprogrammer').click();
    await waitForOrderStatus(fixture.admin, orderId, 'A_APPELER');

    const { data: reverted } = await fixture.admin
      .from('orders')
      .select('call_state, delivery_state, cash_state, scheduled_for')
      .eq('id', orderId)
      .single();
    expect(reverted?.call_state).toBe('to_call');
    expect(reverted?.delivery_state).toBe('unassigned');
    expect(reverted?.cash_state).toBe('not_due');
    expect(reverted?.scheduled_for).toBeNull();

    await page.reload();
    await expect(page.getByText('À appeler').first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('Lot 3 - Message client (détail) pré-remplit le template pour une commande ouverte', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('lot3-whatsapp-open');
  const productTitle = 'Produit Whatsapp Ouvert';
  const orderId = await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'A_APPELER',
    customerName: 'Client Whatsapp Ouvert',
    phone: '+221771778899',
    productName: productTitle,
    totalAmount: 17500,
  });

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await page.getByRole('button', { name: 'Message client', exact: true }).click();
    const textarea = whatsappComposeDialog(page).getByRole('textbox');
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await expect(textarea).toHaveValue(new RegExp(`1x ${productTitle}`));
    await expect(textarea).not.toHaveValue('');
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('Lot 3 - Message client (détail) reste vide pour une commande livrée', async ({ page }) => {
  const fixture = await createOwnerFixture('lot3-whatsapp-livree');
  const orderId = await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'LIVREE',
    customerName: 'Client Whatsapp Livree',
    phone: '+221771889900',
  });

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await page.getByRole('button', { name: 'Message client', exact: true }).click();
    const textarea = whatsappComposeDialog(page).getByRole('textbox');
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await expect(textarea).toHaveValue('');
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('Lot 3 - Message client (détail) reste vide pour une commande annulée', async ({ page }) => {
  const fixture = await createOwnerFixture('lot3-whatsapp-annulee');
  const orderId = await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'ANNULEE',
    customerName: 'Client Whatsapp Annulee',
    phone: '+221771990022',
  });

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await page.getByRole('button', { name: 'Message client', exact: true }).click();
    const textarea = whatsappComposeDialog(page).getByRole('textbox');
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await expect(textarea).toHaveValue('');
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('Lot 3 - Message client depuis le menu de la liste (mode compact) pré-remplit le template', async ({
  page,
}) => {
  // Régression du bug de cycle de vie : en mode compact, WhatsappComposeSheet était
  // monté avec open déjà true (aucune transition fermé→ouvert observable par Vaul),
  // donc handleOpenChange ne se déclenchait jamais et le textarea restait vide.
  const fixture = await createOwnerFixture('lot3-whatsapp-compact');
  const productTitle = 'Produit Whatsapp Liste';
  await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'A_APPELER',
    customerName: 'Client Whatsapp Liste',
    phone: '+221771990011',
    productName: productTitle,
  });

  try {
    await signIn(page, fixture.email, '/commandes?vue=a-appeler');
    await expect(orderRowTitle(page, 'Client Whatsapp Liste')).toBeVisible({ timeout: 15_000 });

    await runRowMenuAction(page, 'Client Whatsapp Liste', 'Message client');
    const textarea = whatsappComposeDialog(page).getByRole('textbox');
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await expect(textarea).toHaveValue(new RegExp(`1x ${productTitle}`));
    await expect(textarea).not.toHaveValue('');
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('Lot 3 - Message client : le texte tapé manuellement n est jamais écrasé pendant l ouverture', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('lot3-whatsapp-edit');
  const orderId = await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'A_APPELER',
    customerName: 'Client Whatsapp Edit',
    phone: '+221771001122',
  });

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await page.getByRole('button', { name: 'Message client', exact: true }).click();
    const textarea = whatsappComposeDialog(page).getByRole('textbox');
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await expect(textarea).not.toHaveValue('');

    await textarea.fill('Message personnalisé du marchand');
    await expect(textarea).toHaveValue('Message personnalisé du marchand');
    // Laisse le temps à un éventuel re-render parent de se produire : si
    // l'initialisation du message se re-déclenchait à chaque render (bug naïf), le
    // texte tapé serait écrasé par le template recalculé.
    await page.waitForTimeout(500);
    await expect(textarea).toHaveValue('Message personnalisé du marchand');
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

// Fix 1 — le dialog « Programmer la livraison » a perdu son second bloc « Date de
// confirmation » (0114) : décision produit, il n'a pas sa place ici. call_confirmed_at
// retombe donc sur le défaut dimensionnel now() de la RPC (mécanisme SQL inchangé,
// seul le front ne le sollicite plus jamais pour cette action).
// Fix 2 — le dialog « Marquer livrée » est désormais prérempli avec order.scheduled_for
// (posé par la vraie transition Programmer ci-dessus, jamais injecté à la main), pas
// vide et pas la date du jour ; il reste éditable si la livraison a eu lieu à une autre
// date.
test('programmer ne demande que la date de livraison ; marquer livrée préremplit avec la date programmée', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('dates-editables');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Livreur Dates');
  const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

  // La borne serveur refuse toute date antérieure à la création : on antidate la
  // commande pour représenter le cas réel (commande passée il y a des jours, traitée
  // au bureau aujourd'hui).
  const createdAt = addDays(new Date(), -6).toISOString();
  await fixture.admin
    .from('orders')
    .update({ created_at: createdAt, created_at_shopify: createdAt })
    .eq('id', orderId);

  // Volontairement demain (pas aujourd'hui) : distingue sans ambiguïté un préremplissage
  // correct (Fix 2) d'un bug qui retomberait silencieusement sur la date du jour.
  const scheduledDate = formatDateInput(addDays(new Date(), 1));
  const scheduledTime = formatTimeInput(10, 0);
  const deliveredDate = formatDateInput(addDays(new Date(), -1));

  const beforeProgram = new Date();

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    // 1) « Programmer la livraison » : un seul groupe de champs (date de livraison
    //    prévue). Le bloc « Date de confirmation » n'existe plus, quelle que soit
    //    l'action.
    await runDetailMenuAction(page, 'Programmer la livraison');
    await expect(page.getByTestId('transition-confirmed-date')).toHaveCount(0);
    await expect(page.getByTestId('transition-delivered-date')).toHaveCount(0);
    await page.getByLabel('Date de livraison', { exact: true }).fill(scheduledDate);
    await page.getByLabel('Heure de livraison', { exact: true }).fill(scheduledTime);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');

    const { data: afterProgram } = await fixture.admin
      .from('orders')
      .select('call_confirmed_at, cash_collected_at, scheduled_for')
      .eq('id', orderId)
      .single();
    // Aucune saisie n'est plus transmise pour cette action : la RPC retombe sur son
    // défaut dimensionnel now() (0114/0116), inchangé côté SQL — seul le front a perdu
    // le champ qui permettait de le corriger.
    expect(afterProgram?.call_confirmed_at).not.toBeNull();
    expect(new Date(afterProgram?.call_confirmed_at ?? '').getTime()).toBeGreaterThanOrEqual(
      beforeProgram.getTime() - 1_000,
    );
    expect(afterProgram?.cash_collected_at).toBeNull();
    expect(afterProgram?.scheduled_for?.slice(0, 10)).toBe(scheduledDate);

    // Recul de call_confirmed_at à une date antérieure : mise en situation nécessaire
    // pour exercer plus bas une correction de livraison antérieure à « maintenant »
    // (contrainte SQL « confirmation ≤ livraison », 0114) — PAS le comportement testé
    // ici, déjà vérifié juste au-dessus via la vraie transition « programmer ». Même
    // logique que le contournement assigned_driver_id/delivery_state ci-dessous.
    await fixture.admin
      .from('orders')
      .update({ call_confirmed_at: addDays(new Date(), -3).toISOString() })
      .eq('id', orderId);

    // « Marquer livrée » n'est légale qu'en delivery_state='assigned'. On amène la
    // commande à cet état par le service-role plutôt que de rejouer tout le flux
    // d'assignation (choix du livreur puis envoi WhatsApp), hors sujet ici : ce test
    // porte sur le préremplissage de la date de livraison, et la transition « livrer »
    // qu'il déclenche ensuite passe bien par le vrai chemin transition_order.
    const { error: dispatchError } = await fixture.admin
      .from('orders')
      .update({ assigned_driver_id: driverId, delivery_state: 'assigned' })
      .eq('id', orderId);
    expect(dispatchError).toBeNull();
    await waitForOrderStatus(fixture.admin, orderId, 'EN_LIVRAISON');

    // 2) « Marquer livrée » : préremplie avec scheduled_for, sans aucun champ de date
    //    de confirmation.
    await page.reload();
    // Stabilisation post-reload avant d'interagir : le bouton existe dans le HTML SSR
    // avant que React ait attaché son onClick (gotcha connu du projet).
    await expect(page.getByRole('button', { name: 'Actions' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await runDetailMenuAction(page, 'Marquer livree');
    await expect(page.getByTestId('transition-delivered-date')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('transition-confirmed-date')).toHaveCount(0);
    await expect(page.getByTestId('transition-delivered-date')).toHaveValue(scheduledDate);
    await expect(page.getByTestId('transition-delivered-time')).toHaveValue(scheduledTime);

    // L'agent corrige : la livraison a réellement eu lieu la veille, pas à la date
    // programmée.
    await page.getByTestId('transition-delivered-date').fill(deliveredDate);
    await page.getByTestId('transition-delivered-time').fill(formatTimeInput(16, 0));
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'LIVREE');

    const { data: afterDelivery } = await fixture.admin
      .from('orders')
      .select('cash_collected_at')
      .eq('id', orderId)
      .single();
    expect(afterDelivery?.cash_collected_at?.slice(0, 10)).toBe(deliveredDate);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

// Fix 2 — laisser le dialog « Marquer livrée » intact (ne pas éditer le préremplissage)
// doit reproduire exactement le comportement d'avant ce lot : p_delivered_at n'est PAS
// transmis, la RPC coalesce sur scheduled_for. Sans cette garde, renvoyer verbatim la
// valeur préremplie déclencherait la validation « jamais dans le futur » de 0114 dès
// qu'une commande est programmée pour une date à venir et livrée par erreur en avance.
test('marquer livrée sans toucher au préremplissage ne transmet aucune date explicite', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('dates-non-editees');
  const driverId = await createDriver(
    fixture.admin,
    fixture.merchantAccountId,
    'Livreur Non Edite',
  );
  const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

  const createdAt = addDays(new Date(), -6).toISOString();
  await fixture.admin
    .from('orders')
    .update({ created_at: createdAt, created_at_shopify: createdAt })
    .eq('id', orderId);

  // Programmée pour DEMAIN : si le front envoyait cette valeur telle quelle comme
  // p_delivered_at, la RPC la rejetterait (invalid_date_future). Ne rien transmettre
  // est la seule façon dont cette validation par livraison en avance sur la date
  // programmée reste acceptée, comme avant ce lot.
  const scheduledDate = formatDateInput(addDays(new Date(), 1));
  const scheduledTime = formatTimeInput(9, 0);

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByLabel('Date de livraison', { exact: true }).fill(scheduledDate);
    await page.getByLabel('Heure de livraison', { exact: true }).fill(scheduledTime);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');

    const { error: dispatchError } = await fixture.admin
      .from('orders')
      .update({ assigned_driver_id: driverId, delivery_state: 'assigned' })
      .eq('id', orderId);
    expect(dispatchError).toBeNull();
    await waitForOrderStatus(fixture.admin, orderId, 'EN_LIVRAISON');

    await page.reload();
    await expect(page.getByRole('button', { name: 'Actions' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await runDetailMenuAction(page, 'Marquer livree');
    await expect(page.getByTestId('transition-delivered-date')).toHaveValue(scheduledDate);
    // Aucune édition : on valide directement.
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'LIVREE');

    const { data: afterDelivery } = await fixture.admin
      .from('orders')
      .select('cash_collected_at')
      .eq('id', orderId)
      .single();
    // coalesce(p_delivered_at, scheduled_for, now()) retombe sur scheduled_for :
    // aucune erreur malgré une date programmée dans le futur.
    expect(afterDelivery?.cash_collected_at?.slice(0, 10)).toBe(scheduledDate);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('0116 - invalider une commande livrée la ramène dans « À appeler » et la retire des rapports', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('invalider-livree');
  const driverId = await createDriver(
    fixture.admin,
    fixture.merchantAccountId,
    'Livreur Invalidation',
  );
  const productTitle = 'Produit Invalidation E2E';
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
    qty: 10,
  });
  const orderId = await createConfirmedOrderWithLine(
    fixture.admin,
    fixture.merchantAccountId,
    productId,
    productTitle,
    2,
  );

  // Fenêtre large volontairement : ce test ne mesure pas le découpage de période, il
  // mesure la présence/absence de la commande dans les rapports.
  const reportFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const reportTo = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Les 2 RPC de rapport sont owner/manager (garde NULL-safe) : le client service-role
  // serait rejeté (rôle NULL). On lit donc avec la session owner, comme le fait /tableau.
  const ownerClient = await signInClient(fixture.email);
  async function readReports() {
    const { data: cash, error: cashError } = await ownerClient.rpc(
      'get_dashboard_cash_collected_total',
      { p_merchant_id: fixture.merchantAccountId, p_from: reportFrom, p_to: reportTo },
    );
    if (cashError) throw cashError;
    const { data: deliveries, error: deliveriesError } = await ownerClient.rpc(
      'get_dashboard_deliveries_by_product',
      { p_merchant_id: fixture.merchantAccountId, p_from: reportFrom, p_to: reportTo },
    );
    if (deliveriesError) throw deliveriesError;
    // get_dashboard_deliveries_by_product renvoie un jsonb OBJET
    // ({total_deliveries, products[]}), pas un tableau de lignes.
    const payload = (deliveries ?? {}) as {
      total_deliveries?: number;
      products?: { title: string; delivered_orders_count: number }[];
    };
    return {
      caMinor: Number(
        (cash as { ca_encaisse_minor: number }[] | null)?.[0]?.ca_encaisse_minor ?? 0,
      ),
      totalDeliveries: Number(payload.total_deliveries ?? 0),
      deliveredTitles: (payload.products ?? []).map((row) => row.title),
    };
  }

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    // 1) Chemin réel jusqu'à LIVREE — jamais un insert direct : il faut de vrais
    //    mouvements de stock et un vrai cash_collected_at pour prouver la restitution.
    await runDetailMenuAction(page, 'Programmer la livraison');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');
    await page.reload();
    // Stabilisation post-reload avant tout clic (gotcha projet : le bouton existe en SSR
    // avant que React ait attaché son onClick — le clic part dans le vide).
    await expect(page.getByText('Programmée').first()).toBeVisible({ timeout: 15_000 });

    await runDetailMenuAction(page, 'Assigner');
    await page.getByLabel('Livreur', { exact: true }).selectOption(driverId);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderDeliveryState(fixture.admin, orderId, 'scheduled');
    await page
      .context()
      .route('https://api.whatsapp.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }),
      );
    const startButton = page.getByRole('button', {
      name: 'Envoyer au livreur (WhatsApp)',
      exact: true,
    });
    await expect(startButton).toBeEnabled({ timeout: 15_000 });
    const [whatsappPopup] = await Promise.all([page.waitForEvent('popup'), startButton.click()]);
    await whatsappPopup.close();
    await waitForOrderStatus(fixture.admin, orderId, 'EN_LIVRAISON');

    await page.reload();
    await expect(page.getByRole('button', { name: 'Actions' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await runDetailMenuAction(page, 'Marquer livree');
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'LIVREE');

    // 2) Baseline rapports : la commande EST comptée avant l'invalidation. Sans cette
    //    lecture, l'assertion « absente après » serait vacuement verte.
    const before = await readReports();
    expect(before.caMinor).toBe(20000);
    expect(before.totalDeliveries).toBe(1);
    expect(before.deliveredTitles).toContain(productTitle);

    // 3) Invalider — proposée à côté de « Marquer retournée », sans dialog de saisie.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Actions' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await openActionsMenu(page);
    await expect(menuItem(page, 'Invalider')).toBeVisible({ timeout: 15_000 });
    await expect(menuItem(page, 'Marquer retournée')).toBeVisible();
    await menuItem(page, 'Invalider').click();
    await waitForOrderStatus(fixture.admin, orderId, 'A_APPELER');

    const { data: reverted } = await fixture.admin
      .from('orders')
      .select(
        'order_state, call_state, delivery_state, cash_state, assigned_driver_id, cash_collected_at, call_confirmed_at, payment_channel_at_delivery',
      )
      .eq('id', orderId)
      .single();
    expect(reverted?.order_state).toBe('open');
    expect(reverted?.call_state).toBe('to_call');
    expect(reverted?.delivery_state).toBe('unassigned');
    expect(reverted?.cash_state).toBe('not_due');
    expect(reverted?.assigned_driver_id).toBeNull();
    expect(reverted?.cash_collected_at).toBeNull();
    expect(reverted?.call_confirmed_at).toBeNull();
    expect(reverted?.payment_channel_at_delivery).toBeNull();

    // 4) Stock central restitué à son niveau d'avant le dispatch.
    const { data: stock } = await fixture.admin
      .from('product_stock')
      .select('qty_on_hand, qty_reserved')
      .eq('product_id', productId)
      .single();
    expect(stock?.qty_on_hand).toBe(10);

    // 5) Les rapports ne la comptent plus — recalcul naturel, aucune correction manuelle.
    const after = await readReports();
    expect(after.caMinor).toBe(0);
    expect(after.totalDeliveries).toBe(0);
    expect(after.deliveredTitles).not.toContain(productTitle);

    // 6) Elle réapparaît bien dans la vue « À appeler » de /commandes.
    await page.goto('/commandes?vue=a-appeler');
    await expect(orderRowTitle(page, 'Client Assignation')).toBeVisible({ timeout: 15_000 });

    // 7) « Activité récente » (/tableau, components/dashboard/RecentActivity.tsx, alimenté
    //    par fetchRecentActivityForUser qui lit order_state_transition SANS filtre de
    //    statut) : le bloc rend normalement, affiche bien les transitions réelles de la
    //    commande, et l'invalidation n'y apparaît PAS — elle ne pose aucune ligne.
    await page.goto('/tableau');
    const recentActivity = page.getByRole('heading', { name: 'Activité récente' }).locator('..');
    await expect(recentActivity).toBeVisible({ timeout: 15_000 });
    // Le bloc n'est ni vide ni cassé : les transitions normales de la commande y sont.
    await expect(recentActivity.getByText('En livraison → Livrée')).toBeVisible({
      timeout: 15_000,
    });
    await expect(recentActivity.getByText('Aucune transition récente.')).toHaveCount(0);
    // Et aucune entrée « Livrée → À appeler », la signature de l'invalidation.
    await expect(recentActivity.getByText('Livrée → À appeler')).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
