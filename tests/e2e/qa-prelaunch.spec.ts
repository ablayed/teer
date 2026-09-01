import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { legacyStatusToDimensions } from '@/lib/domain/order-transition-actions';
import { formatMoney } from '@/lib/format/fcfa';
import messages from '@/messages/fr.json';
import { callStockMovementEngine } from '@/tests/helpers/stock-movement-engine';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { landOnTarget } from './helpers/auth';
import { grantCurrentConsents } from './helpers/consent';
import { attachDriverToStore } from './helpers/workspace';

// ============================================================================
// QA pré-launch (v2) — couverture e2e UI manquante.
// Angles : (1) mark_returned via l'UI, (2) refuser / refus, (3) isolation
// tenant via l'UI, (4) XOF scale 0 bout-en-bout.
// Tests uniquement — aucune modification de code produit. Un échec révélant un
// vrai bug doit être signalé, pas corrigé.
// ============================================================================

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

// Montant affiché en FCFA scale 0 : « 50 000 F CFA » avec des espaces fines
// insécables (U+202F). \s en JS couvre U+202F → regex tolérante aux séparateurs.
function moneyRegex(amount: number): RegExp {
  const grouped = formatMoney(amount)
    .replace(/[\s  ]+/g, ' ')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s*');
  return new RegExp(grouped);
}

test.setTimeout(60_000);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Client authentifié (membre) pour les seeds passant par les RPC moteur :
// post_stock_movement / transition_order exigent current_member_role non NULL
// (garde 0043) → le service-role est rejeté.
async function signInClient(email: string): Promise<AdminClient> {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

function e2eEmail(label: string): string {
  return `e2e+qa-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
        if (error) throw error;
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

  // 0133 — un livreur n'est visible que dans les boutiques qu'il SERT
  // (`driver_shop`). Le chemin produit pose ce rattachement à la création
  // (`lib/actions/team.ts`) ; un seed qui insère `driver` en direct doit le
  // reproduire, sinon le livreur reste introuvable sur /livreurs sans aucune
  // erreur — écran vide, pas message d'échec.
  await attachDriverToStore(admin, merchantAccountId, data.id as string);
  return data.id as string;
}

async function createProductInCatalog(
  admin: AdminClient,
  merchantAccountId: string,
  title: string,
) {
  const { data, error } = await admin
    .from('product')
    .insert({ merchant_account_id: merchantAccountId, title, unit_cost: 0, is_active: true })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function createOrderWithMatchedLine({
  admin,
  customerName,
  merchantAccountId,
  phone = '+221771234567',
  productId,
  productTitle,
  qty,
  status,
  totalAmount,
}: {
  admin: AdminClient;
  customerName: string;
  merchantAccountId: string;
  phone?: string;
  productId: string;
  productTitle: string;
  qty: number;
  status: Parameters<typeof legacyStatusToDimensions>[0];
  totalAmount: number;
}) {
  const dimensions = legacyStatusToDimensions(status);
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: customerName,
      phone,
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
      order_number: `E2E-QA-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
      items_summary: [{ title: productTitle, quantity: qty, price: totalAmount }],
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

// Commande sans order_line : aucun mouvement stock n'est tenté par le moteur.
async function createSimpleOrder({
  admin,
  customerName,
  merchantAccountId,
  phone = '+221771234567',
  status,
  totalAmount,
}: {
  admin: AdminClient;
  customerName: string;
  merchantAccountId: string;
  phone?: string;
  status: Parameters<typeof legacyStatusToDimensions>[0];
  totalAmount: number;
}) {
  const dimensions = legacyStatusToDimensions(status);
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: customerName,
      phone,
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
      order_number: `E2E-QA-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: totalAmount,
      currency: 'XOF',
      cod_status: status,
      order_state: dimensions.orderState,
      call_state: dimensions.callState,
      delivery_state: dimensions.deliveryState,
      cash_state: dimensions.cashState,
      attempt_count: dimensions.attemptCount,
      items_summary: [{ title: 'Article E2E', quantity: 1, price: totalAmount }],
      shipping_address: { address1: 'Almadies', city: 'Dakar', country: 'SN' },
      created_at_shopify: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (orderError) throw orderError;

  return order.id as string;
}

async function seedWarehouseStock({
  merchantAccountId,
  productId,
  qty,
  actorUserId,
  unitCost = 5000,
}: {
  merchantAccountId: string;
  productId: string;
  qty: number;
  actorUserId: string;
  unitCost?: number;
}) {
  // 0136 : cœur post_stock_movement dans `private`, non exposé — connexion Postgres
  // directe (callStockMovementEngine simule l'identité via le JWT sub, sans session).
  const { error } = await callStockMovementEngine({
    p_merchant_account_id: merchantAccountId,
    p_product_id: productId,
    p_movement_type: 'purchase_in',
    p_qty: qty,
    p_idempotency_key: `qa-in:${productId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    p_created_by: actorUserId,
    p_unit_cost: unitCost,
  });
  if (error) throw error;
}

// Pilote la commande jusqu'à livrée+encaissée via les RPC moteur (stock réaliste :
// reserve → dispatch → sold). Le client doit être authentifié (membre).
async function driveToDelivered(
  ownerClient: AdminClient,
  orderId: string,
  actorUserId: string,
  driverId: string,
  paymentChannel = 'ESPECES',
) {
  const steps: Record<string, unknown>[] = [
    { p_call_state: 'validated', p_attempt_count: 1 },
    { p_delivery_state: 'scheduled', p_cash_state: 'expected' },
    { p_delivery_state: 'out_for_delivery', p_assigned_driver_id: driverId },
    {
      p_delivery_state: 'delivered',
      p_order_state: 'completed',
      p_cash_state: 'collected',
      p_payment_channel: paymentChannel,
    },
  ];
  for (const step of steps) {
    const { error } = await ownerClient.rpc('transition_order', {
      p_order_id: orderId,
      p_actor: actorUserId,
      ...step,
    });
    if (error) throw error;
  }
}

// Pilote la commande jusqu'à EN_LIVRAISON (reserve → dispatch), stock chez le livreur.
async function driveToOutForDelivery(
  ownerClient: AdminClient,
  orderId: string,
  actorUserId: string,
  driverId: string,
) {
  const steps: Record<string, unknown>[] = [
    { p_call_state: 'validated', p_attempt_count: 1 },
    { p_delivery_state: 'scheduled', p_cash_state: 'expected' },
    { p_delivery_state: 'out_for_delivery', p_assigned_driver_id: driverId },
  ];
  for (const step of steps) {
    const { error } = await ownerClient.rpc('transition_order', {
      p_order_id: orderId,
      p_actor: actorUserId,
      ...step,
    });
    if (error) throw error;
  }
}

// Attente auto-retry (expect.poll) plutôt qu'un poll à durée fixe : retente avec
// backoff jusqu'au timeout et émet un diff lisible à l'échec.
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

async function cleanupUsers(admin: AdminClient, userIds: string[]) {
  await Promise.all(userIds.map((userId) => admin.auth.admin.deleteUser(userId)));
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await landOnTarget(page, redirectTo);
}

// UX-COD-01 §3 — la premiere action legale (deja ordonnee par transitionMenuOrder)
// est desormais un bouton direct (son propre libelle) ; le dropdown "Actions" ne
// reste que pour les actions secondaires (absent s'il n'y en a aucune). `menuItem`
// matche donc les deux formes.
function menuItem(page: Page, name: string) {
  return page
    .getByRole('menuitem', { name, exact: true })
    .or(page.getByRole('button', { name, exact: true }));
}

// PIEGE (trouve en CI mobile) : le Drawer Vaul du dropdown "Actions" pose aria-hidden
// sur le RESTE de la page pendant qu'il est ouvert. Si `name` est DEJA le bouton
// primaire (visible avant toute ouverture), ouvrir "Actions" quand meme le rend
// introuvable par role une fois le menu ouvert — d'où le check direct-d'abord.
async function openActionsMenu(page: Page, name?: string) {
  if (name) {
    const direct = page.getByRole('button', { name, exact: true });
    if (await direct.isVisible().catch(() => false)) {
      return;
    }
  }

  const trigger = page.getByRole('button', { name: 'Actions' }).first();

  const hasTrigger = await trigger
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!hasTrigger) {
    // Pas de dropdown "Actions" : seule action legale = primaire, deja un bouton
    // direct — `menuItem` ci-dessus la retrouvera sans rien ouvrir.
    return;
  }

  // Le premier clic peut atterrir AVANT l'hydratation React : le bouton existe
  // déjà dans le HTML SSR mais son `onClick` n'est pas encore attaché, donc le
  // clic ne fait rien et l'attente expire sur un élément de menu qui
  // n'apparaîtra jamais (piège documenté du projet). On retente le clic tant
  // qu'aucun élément de menu n'est monté, plutôt que d'allonger un timeout qui
  // ne rattraperait pas un clic déjà perdu.
  await expect(async () => {
    await trigger.click();
    await expect(page.getByRole('menuitem').first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function runDetailMenuAction(page: Page, name: string) {
  await openActionsMenu(page, name);
  await menuItem(page, name).click();
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E QA');

// ============================================================================
// Angle 1 — mark_returned via l'UI (retour après livraison)
// ============================================================================

test('Lot D - marquer retournée via UI (sans remise) restaure le stock, aucune reprise cash', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('return-no-remit');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Livreur Retour');
  const productTitle = 'Sac Retour E2E';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  await seedWarehouseStock({
    merchantAccountId: fixture.merchantAccountId,
    productId,
    qty: 50,
    actorUserId: fixture.userIds[0],
  });
  const orderId = await createOrderWithMatchedLine({
    admin: fixture.admin,
    customerName: 'Client Retour Simple',
    merchantAccountId: fixture.merchantAccountId,
    productId,
    productTitle,
    qty: 3,
    status: 'A_APPELER',
    totalAmount: 20000,
  });

  try {
    const ownerClient = await signInClient(fixture.email);
    await driveToDelivered(ownerClient, orderId, fixture.userIds[0], driverId);
    await waitForOrderStatus(fixture.admin, orderId, 'LIVREE');

    await signIn(page, fixture.email, `/commandes/${orderId}`);

    // Seule action légale sur une commande livrée : « Marquer retournée ».
    await openActionsMenu(page, 'Marquer retournée');
    await expect(menuItem(page, 'Marquer retournée')).toBeVisible();
    await menuItem(page, 'Marquer retournée').click();

    await waitForOrderStatus(fixture.admin, orderId, 'REFUSEE');

    const { data: order } = await fixture.admin
      .from('orders')
      .select('order_state, delivery_state, cash_state, returned_at')
      .eq('id', orderId)
      .single();
    expect(order?.order_state).toBe('returned');
    expect(order?.delivery_state).toBe('returned');
    expect(order?.cash_state).toBe('not_due');
    expect(order?.returned_at).not.toBeNull();

    // Le stock revient au disponible via courier_return (+3 attribué au livreur).
    const { data: movements } = await fixture.admin
      .from('stock_movement')
      .select('movement_type, qty, driver_id')
      .eq('order_id', orderId)
      .order('created_at')
      .order('movement_type')
      .order('id');
    expect(movements?.map((m) => m.movement_type)).toEqual([
      'reserve',
      'dispatch',
      'order_assignment_commit',
      'sold',
      'courier_return',
      'order_assignment_release',
    ]);
    const courierReturn = movements?.find((m) => m.movement_type === 'courier_return');
    expect(courierReturn?.qty).toBe(3);
    expect(courierReturn?.driver_id).toBe(driverId);

    const { data: stock } = await fixture.admin
      .from('product_stock')
      .select('qty_on_hand, qty_reserved')
      .eq('product_id', productId)
      .single();
    expect(stock?.qty_on_hand).toBe(50);
    expect(stock?.qty_reserved).toBe(0);

    // Sans remise préalable : aucune allocation, donc aucune reprise cash négative.
    const { data: allocations } = await fixture.admin
      .from('settlement_allocation')
      .select('allocated_minor')
      .eq('order_id', orderId);
    expect(allocations ?? []).toHaveLength(0);

    const { data: settlements } = await fixture.admin
      .from('cash_settlement')
      .select('amount_received_minor')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId);
    expect((settlements ?? []).some((s) => s.amount_received_minor < 0)).toBe(false);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('Lot D - marquer retournée via UI après remise trace une reprise cash négative', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('return-after-remit');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Livreur Reprise');
  const productTitle = 'Carton Reprise E2E';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  await seedWarehouseStock({
    merchantAccountId: fixture.merchantAccountId,
    productId,
    qty: 50,
    actorUserId: fixture.userIds[0],
  });
  const orderTotal = 30000;
  const orderId = await createOrderWithMatchedLine({
    admin: fixture.admin,
    customerName: 'Client Retour Remis',
    merchantAccountId: fixture.merchantAccountId,
    productId,
    productTitle,
    qty: 3,
    status: 'A_APPELER',
    totalAmount: orderTotal,
  });

  try {
    const ownerClient = await signInClient(fixture.email);
    await driveToDelivered(ownerClient, orderId, fixture.userIds[0], driverId);
    await waitForOrderStatus(fixture.admin, orderId, 'LIVREE');

    // Précondition « déjà remise » seedée côté serveur (cash_settlement + allocation
    // positifs), comme le test RLS stock-atomicity. La remise via l'UI Livreurs est
    // déjà couverte par drivers.spec ; ici on isole l'action sous test (mark_returned)
    // et sa conséquence cash, sans la course router.refresh() de la page Livreurs.
    const { data: settlement, error: settlementError } = await fixture.admin
      .from('cash_settlement')
      .insert({
        merchant_account_id: fixture.merchantAccountId,
        driver_id: driverId,
        amount_received_minor: orderTotal,
        method: 'ESPECES',
        note: 'Remise test retour',
        created_by: fixture.userIds[0],
        client_request_id: randomUUID(),
      })
      .select('id')
      .single();
    if (settlementError) throw settlementError;
    await fixture.admin.from('settlement_allocation').insert({
      merchant_account_id: fixture.merchantAccountId,
      settlement_id: settlement.id,
      order_id: orderId,
      allocated_minor: orderTotal,
    });

    // Avant retour : le total remis couvre l'encaissé.
    const { data: before } = await fixture.admin
      .from('settlement_allocation')
      .select('allocated_minor')
      .eq('order_id', orderId);
    expect((before ?? []).reduce((s, a) => s + a.allocated_minor, 0)).toBe(orderTotal);

    // Retour via l'UI depuis le détail de la commande.
    await signIn(page, fixture.email, `/commandes/${orderId}`);
    await runDetailMenuAction(page, 'Marquer retournée');
    await waitForOrderStatus(fixture.admin, orderId, 'REFUSEE');

    const { data: order } = await fixture.admin
      .from('orders')
      .select('order_state, delivery_state, cash_state')
      .eq('id', orderId)
      .single();
    expect(order?.order_state).toBe('returned');
    expect(order?.delivery_state).toBe('returned');
    expect(order?.cash_state).toBe('not_due');

    // Une reprise négative neutralise la remise : allocations nettes = 0.
    const { data: allocations } = await fixture.admin
      .from('settlement_allocation')
      .select('allocated_minor')
      .eq('order_id', orderId)
      .order('allocated_minor');
    expect(allocations?.map((a) => a.allocated_minor)).toEqual([-orderTotal, orderTotal]);
    expect((allocations ?? []).reduce((s, a) => s + a.allocated_minor, 0)).toBe(0);

    // Une ligne cash_settlement négative (reprise) existe.
    const { data: settlements } = await fixture.admin
      .from('cash_settlement')
      .select('amount_received_minor')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId);
    expect((settlements ?? []).some((s) => s.amount_received_minor === -orderTotal)).toBe(true);

    // Le stock est restauré (courier_return).
    const { data: stock } = await fixture.admin
      .from('product_stock')
      .select('qty_on_hand')
      .eq('product_id', productId)
      .single();
    expect(stock?.qty_on_hand).toBe(50);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

// ============================================================================
// Angle 2 — refuser (échec livraison) + refus comme raison d'annulation
// ============================================================================

function inputDateTime(date: Date): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

test('reprogrammer depuis EN_LIVRAISON: retour à Programmée avec la nouvelle date, stock livreur libéré (order_assignment_release), pas de courier_return', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('reprogrammer');
  const driverId = await createDriver(
    fixture.admin,
    fixture.merchantAccountId,
    'Livreur Reprogrammer',
  );
  const productTitle = 'Produit Reprogrammer E2E';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  await seedWarehouseStock({
    merchantAccountId: fixture.merchantAccountId,
    productId,
    qty: 50,
    actorUserId: fixture.userIds[0],
  });
  const orderId = await createOrderWithMatchedLine({
    admin: fixture.admin,
    customerName: 'Client Reprogrammer',
    merchantAccountId: fixture.merchantAccountId,
    productId,
    productTitle,
    qty: 3,
    status: 'A_APPELER',
    totalAmount: 18000,
  });

  try {
    const ownerClient = await signInClient(fixture.email);
    await driveToOutForDelivery(ownerClient, orderId, fixture.userIds[0], driverId);
    await waitForOrderStatus(fixture.admin, orderId, 'EN_LIVRAISON');

    // Mouvements avant reprogrammer : reserve + dispatch (stock chez le livreur).
    const { data: movementsBefore } = await fixture.admin
      .from('stock_movement')
      .select('movement_type')
      .eq('order_id', orderId)
      .order('created_at')
      .order('movement_type')
      .order('id');
    expect(movementsBefore?.map((m) => m.movement_type)).toEqual([
      'reserve',
      'dispatch',
      'order_assignment_commit',
    ]);

    await signIn(page, fixture.email, `/commandes/${orderId}`);
    await runDetailMenuAction(page, 'Reprogrammer');
    const newDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    newDate.setHours(11, 0, 0, 0);
    const { date, time } = inputDateTime(newDate);
    await page.getByLabel('Date de livraison', { exact: true }).fill(date);
    await page.getByLabel('Heure de livraison', { exact: true }).fill(time);
    await page.getByRole('button', { name: 'Valider', exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');

    const { data: order } = await fixture.admin
      .from('orders')
      .select('order_state, delivery_state, cash_state, assigned_driver_id, scheduled_for')
      .eq('id', orderId)
      .single();
    // Report logistique, pas un échec de livraison : la commande reste ouverte.
    expect(order?.order_state).toBe('open');
    expect(order?.delivery_state).toBe('scheduled');
    expect(order?.cash_state).toBe('expected');
    expect(order?.assigned_driver_id).toBeNull();
    // Comparaison au jour près (pas à l'heure/minute) : le process Playwright et le
    // webServer Next.js peuvent tourner sous des TZ différentes (cf. gotcha CLAUDE.md
    // datetime-input), une comparaison exacte HH:MM serait fragile sans rapport avec
    // le comportement produit réellement vérifié ici.
    expect(order?.scheduled_for).not.toBeNull();
    expect(new Date(order?.scheduled_for ?? '').toISOString().slice(0, 10)).toBe(date);

    // order_assignment_release ajouté par reprogrammer, PAS un courier_return.
    const { data: movementsAfter } = await fixture.admin
      .from('stock_movement')
      .select('movement_type')
      .eq('order_id', orderId)
      .order('created_at')
      .order('movement_type')
      .order('id');
    expect(movementsAfter?.map((m) => m.movement_type)).toEqual([
      'reserve',
      'dispatch',
      'order_assignment_commit',
      'order_assignment_release',
    ]);

    // qty_on_hand inchangé depuis le dispatch (50 - 3 = 47) : le stock physique
    // reste chez le livreur, seul le ledger de disponibilité est libéré.
    const { data: stock } = await fixture.admin
      .from('product_stock')
      .select('qty_on_hand')
      .eq('product_id', productId)
      .single();
    expect(stock?.qty_on_hand).toBe(47);

    // La commande reprogrammée réapparaît dans la vue « Programmer ».
    await page.goto('/commandes?vue=confirmee');
    await expect(page.getByText('Client Reprogrammer').first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('En cours de livraison : le menu affiche Reprogrammer (pas Refuser), Annuler reste présent et fonctionnel', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('menu-en-livraison');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Livreur Menu');
  const productTitle = 'Produit Menu E2E';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  await seedWarehouseStock({
    merchantAccountId: fixture.merchantAccountId,
    productId,
    qty: 50,
    actorUserId: fixture.userIds[0],
  });
  const orderId = await createOrderWithMatchedLine({
    admin: fixture.admin,
    customerName: 'Client Menu',
    merchantAccountId: fixture.merchantAccountId,
    productId,
    productTitle,
    qty: 2,
    status: 'A_APPELER',
    totalAmount: 12000,
  });

  try {
    const ownerClient = await signInClient(fixture.email);
    await driveToOutForDelivery(ownerClient, orderId, fixture.userIds[0], driverId);
    await waitForOrderStatus(fixture.admin, orderId, 'EN_LIVRAISON');

    await signIn(page, fixture.email, `/commandes/${orderId}`);
    // « Reprogrammer » est la PREMIÈRE (primaire, bouton direct) — vérifiée AVANT
    // d'ouvrir "Actions" (« Annuler la commande », secondaire) : voir openActionsMenu.
    await expect(menuItem(page, 'Reprogrammer')).toBeVisible({ timeout: 15_000 });
    await openActionsMenu(page, 'Annuler la commande');
    await expect(menuItem(page, 'Refuser')).toHaveCount(0);
    await expect(menuItem(page, 'Annuler la commande')).toBeVisible();

    // Annuler reste fonctionnel, comportement inchangé (RTO/cancellation intacts).
    await menuItem(page, 'Annuler la commande').click();
    await page.getByLabel('Autres', { exact: true }).check();
    await page.getByRole('button', { name: "Confirmer l'annulation", exact: true }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'ANNULEE');
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('annuler avec la raison Refus enregistre cancel_reason=refus', async ({ page }) => {
  const fixture = await createOwnerFixture('annuler-refus');
  const orderId = await createSimpleOrder({
    admin: fixture.admin,
    customerName: 'Client Annule Refus',
    merchantAccountId: fixture.merchantAccountId,
    status: 'CONFIRMEE',
    totalAmount: 12000,
  });

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await runDetailMenuAction(page, 'Annuler la commande');
    await expect(page.getByRole('button', { name: "Confirmer l'annulation" })).toBeDisabled();
    await page.getByLabel('Refus', { exact: true }).check();
    await page.getByRole('button', { name: "Confirmer l'annulation" }).click();
    await waitForOrderStatus(fixture.admin, orderId, 'ANNULEE');

    const { data: order } = await fixture.admin
      .from('orders')
      .select('order_state, cancel_reason, cancel_reasons')
      .eq('id', orderId)
      .single();
    expect(order?.order_state).toBe('cancelled');
    expect(order?.cancel_reason).toBe('refus');
    expect(order?.cancel_reasons).toEqual(['refus']);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

// ============================================================================
// Angle 3 — isolation tenant via l'UI
// ============================================================================

test('isolation tenant via UI: B ne voit jamais une commande ni un livreur de A', async ({
  page,
}) => {
  const tenantA = await createOwnerFixture('iso-a');
  const tenantB = await createOwnerFixture('iso-b');

  const driverAId = await createDriver(tenantA.admin, tenantA.merchantAccountId, 'Livreur Alpha A');
  const productAId = await createProductInCatalog(
    tenantA.admin,
    tenantA.merchantAccountId,
    'Produit Alpha A',
  );
  const secretAmount = 77777;
  const orderAId = await createOrderWithMatchedLine({
    admin: tenantA.admin,
    customerName: 'Client Alpha Secret',
    merchantAccountId: tenantA.merchantAccountId,
    phone: '+221779990000',
    productId: productAId,
    productTitle: 'Produit Alpha A',
    qty: 1,
    status: 'A_APPELER',
    totalAmount: secretAmount,
  });

  try {
    // Connecté en tant que B.
    await signIn(page, tenantB.email, '/commandes');

    // Liste B : la commande de A est invisible (nom + montant).
    await expect(page.getByText('Client Alpha Secret')).toHaveCount(0);
    await expect(page.getByText(moneyRegex(secretAmount))).toHaveCount(0);

    // URL directe vers la commande de A → introuvable, données jamais exposées.
    await page.goto(`/commandes/${orderAId}`);
    await expect(page.getByText('Client Alpha Secret')).toHaveCount(0);
    await expect(page.getByText(moneyRegex(secretAmount))).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Actions' })).toHaveCount(0);

    // URL directe vers le livreur de A → non sélectionné, jamais affiché.
    await page.goto(`/livreurs?driver=${driverAId}&period=30j`);
    await expect(page.getByText('Livreur Alpha A')).toHaveCount(0);
    await expect(
      page.getByText('Sélectionnez un livreur pour voir son stock, son cash et sa performance.'),
    ).toBeVisible();
  } finally {
    await cleanupUsers(tenantA.admin, tenantA.userIds);
    await cleanupUsers(tenantB.admin, tenantB.userIds);
  }
});

// ============================================================================
// Angle 4 — XOF scale 0 bout-en-bout (le montant ne dérive jamais)
// ============================================================================

test('XOF scale 0: 50 000 F CFA ne dérive jamais de la saisie à la remise', async ({ page }) => {
  const fixture = await createOwnerFixture('xof');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Livreur XOF');
  const productTitle = 'Produit XOF E2E';
  const productId = await createProductInCatalog(
    fixture.admin,
    fixture.merchantAccountId,
    productTitle,
  );
  await seedWarehouseStock({
    merchantAccountId: fixture.merchantAccountId,
    productId,
    qty: 50,
    actorUserId: fixture.userIds[0],
  });
  const amount = 50000;
  const orderId = await createOrderWithMatchedLine({
    admin: fixture.admin,
    customerName: 'Client XOF Scale',
    merchantAccountId: fixture.merchantAccountId,
    phone: '+221770001122',
    productId,
    productTitle,
    qty: 1,
    status: 'A_APPELER',
    totalAmount: amount,
  });
  const money = moneyRegex(amount);

  try {
    const ownerClient = await signInClient(fixture.email);
    await driveToDelivered(ownerClient, orderId, fixture.userIds[0], driverId);
    await waitForOrderStatus(fixture.admin, orderId, 'LIVREE');

    // Saisi = stocké à l'unité près (scale 0, jamais /100).
    const { data: order } = await fixture.admin
      .from('orders')
      .select('total_amount, cash_collectable_minor')
      .eq('id', orderId)
      .single();
    expect(order?.total_amount).toBe(amount);
    expect(order?.cash_collectable_minor).toBe(amount);

    // Détail : le montant s'affiche « 50 000 F CFA ».
    await signIn(page, fixture.email, `/commandes/${orderId}`);
    await expect(
      page.getByText('Total', { exact: true }).locator('..').getByText(money),
    ).toBeVisible({ timeout: 15_000 });

    // Liste (vue par défaut « Toutes », SANS recherche) : même montant, pas
    // d'arrondi parasite. On évite volontairement `?q=` : le champ de recherche
    // déclenche un router.replace() débounced (normalisation de la requête) qui,
    // sur WebKit lent, interromprait la navigation suivante. La vue par défaut
    // (q vide) prend le early-return du debounce → aucune soft-nav.
    await page.goto('/commandes');
    await expect(
      page
        .locator('[data-testid="order-row-title"]:visible', { hasText: 'Client XOF Scale' })
        .first(),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator('[data-testid="order-row-amount"]:visible', { hasText: money }).first(),
    ).toBeVisible({
      timeout: 15_000,
    });

    // Réconciliation cash (Livreurs) : encaissé = 50 000. Dernière page visitée
    // (la remise déclenche un router.refresh() ; rien ne navigue après).
    await page.goto(`/livreurs?driver=${driverId}&period=30j`);
    await expect(page.getByTestId('driver-detail-panel').getByText(money).first()).toBeVisible({
      timeout: 15_000,
    });

    // Remise du solde : remis = encaissé, à l'unité près.
    // pressSequentially déclenche les événements natifs (keydown/input/keyup) que React
    // capte sur WebKit ; fill() seul ne déclenche pas onChange sur les spinbuttons contrôlés.
    const versementInput = page.getByRole('spinbutton', { name: 'Montant reçu (FCFA)' });
    const versementBtn = page.getByRole('button', { name: 'Enregistrer le versement' });
    await expect(versementInput).toBeVisible({ timeout: 15_000 });
    await expect(versementBtn).toBeEnabled({ timeout: 15_000 });
    await versementInput.click({ clickCount: 3 });
    await versementInput.pressSequentially(String(amount));
    await expect(versementInput).toHaveValue(String(amount));
    await versementBtn.click();
    await page.getByRole('button', { name: 'Confirmer le versement' }).click();
    await expect(page.getByText('Versement enregistré.')).toBeVisible({
      timeout: 15_000,
    });

    await expect
      .poll(
        async () => {
          const { data: allocations } = await fixture.admin
            .from('settlement_allocation')
            .select('allocated_minor')
            .eq('merchant_account_id', fixture.merchantAccountId)
            .eq('order_id', orderId);
          return (allocations ?? []).reduce((s, a) => s + a.allocated_minor, 0);
        },
        { timeout: 15_000 },
      )
      .toBe(amount);

    const { data: settlement } = await fixture.admin
      .from('cash_settlement')
      .select('amount_received_minor')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId)
      .single();
    expect(settlement?.amount_received_minor).toBe(amount);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
