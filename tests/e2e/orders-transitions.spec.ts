import { existsSync, readFileSync } from 'node:fs';
import { legacyStatusToDimensions } from '@/lib/domain/order-transition-actions';
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
type Role = 'owner' | 'manager' | 'agent';

function adminClient(): AdminClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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

function actionButton(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

function savedViewButton(page: Page, label: string) {
  return page.getByRole('button', { name: new RegExp(`^${label} \\(`) });
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E commandes');

test('chemin nominal confirmer programmer assigner livrer en especes', async ({ page }) => {
  const fixture = await createOwnerFixture('nominal');
  const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await actionButton(page, 'Confirmer').click();
    await waitForOrderStatus(fixture.admin, orderId, 'CONFIRMEE');
    await expect(page.getByText('Confirmée').first()).toBeVisible({ timeout: 15_000 });

    await actionButton(page, 'Programmer la livraison').click();
    await waitForOrderStatus(fixture.admin, orderId, 'PROGRAMMEE');
    await page.reload();
    await expect(actionButton(page, 'Assigner')).toBeVisible({ timeout: 15_000 });

    await actionButton(page, 'Assigner').click();
    await waitForOrderStatus(fixture.admin, orderId, 'EN_LIVRAISON');
    await page.reload();
    await expect(actionButton(page, 'Marquer livree')).toBeVisible({ timeout: 15_000 });

    await actionButton(page, 'Marquer livree').click();
    await waitForOrderStatus(fixture.admin, orderId, 'LIVREE');
    await expect(page.getByText('Livrée').first()).toBeVisible({ timeout: 15_000 });

    const { data: order, error } = await fixture.admin
      .from('orders')
      .select(
        'cod_status, order_state, call_state, delivery_state, cash_state, cash_collectable_minor, payment_channel_at_delivery',
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

    await expect(actionButton(page, 'Confirmer')).toBeVisible();
    await expect(actionButton(page, 'Journaliser une tentative')).toBeVisible();
    await expect(actionButton(page, 'Programmer la livraison')).toHaveCount(0);
    await expect(actionButton(page, 'Assigner')).toHaveCount(0);
    await expect(actionButton(page, 'Marquer livree')).toHaveCount(0);
    await expect(actionButton(page, 'Annuler la commande')).toHaveCount(0);
    await expect(actionButton(page, 'Refuser')).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('confirmer puis programmer ne casse pas le rendu et survit au refresh', async ({ page }) => {
  const fixture = await createOwnerFixture('refresh');
  const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await actionButton(page, 'Confirmer').click();
    await expect(page.locator('body')).not.toBeEmpty();
    await expect(page.getByText('Confirmée').first()).toBeVisible({ timeout: 15_000 });

    await actionButton(page, 'Programmer la livraison').click();
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

  try {
    await signIn(page, fixture.email, '/commandes');

    await page.getByRole('button', { name: 'Nouvelle commande', exact: true }).click();
    await page.getByLabel('Nom client').fill('Awa Manuelle');
    await page.getByLabel('Telephone').fill('+221 77 111 22 33');
    await page.getByRole('textbox', { name: 'Produit', exact: true }).fill('Sac manuel');
    await page.getByRole('spinbutton', { name: 'Montant', exact: true }).fill('14500');
    await page.getByRole('button', { name: 'Creer la commande' }).click();

    await expect(page.getByText('Commande creee.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Awa Manuelle')).toBeVisible({ timeout: 15_000 });

    await savedViewButton(page, 'À appeler').click();
    await expect(page).toHaveURL(/\/commandes\?(.*&)?vue=a-appeler(&.*)?$/);
    await expect(page.getByText('Awa Manuelle')).toBeVisible({ timeout: 15_000 });
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

    await actionButton(page, 'Confirmer').click();
    await expect(page.locator('article').filter({ hasText: 'Client Inline' })).toHaveCount(0, {
      timeout: 15_000,
    });

    await savedViewButton(page, 'Confirmée').click();
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

test('le tableau deep-link vers la vue Cash a remettre', async ({ page }) => {
  const fixture = await createOwnerFixture('dashboard-deeplink');
  await createOrderWithCustomer(fixture.admin, {
    merchantAccountId: fixture.merchantAccountId,
    status: 'LIVREE',
    customerName: 'Cash Dashboard',
    phone: '+221781223344',
  });

  try {
    await signIn(page, fixture.email, '/tableau');

    await page.getByRole('link', { name: 'Cash a remettre' }).click();
    await page.waitForURL('**/commandes?vue=cash-a-remettre');
    await expect(page.getByText('Cash Dashboard')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
