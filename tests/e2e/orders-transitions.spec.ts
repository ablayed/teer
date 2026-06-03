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
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Client Phase Zero',
      phone: '+221771234567',
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
      items_summary: [{ title: 'Produit E2E', quantity: 1, price: totalAmount }],
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

async function signIn(page: Page, email: string, redirectTo = '/tableau') {
  await page.goto('/connexion');
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL('**/tableau');
  await page.waitForLoadState('networkidle');

  if (redirectTo !== '/tableau') {
    await page.goto(redirectTo);
  }
}

function actionButton(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E commandes');

test('chemin nominal confirmer programmer assigner livrer en especes', async ({ page }) => {
  const fixture = await createOwnerFixture('nominal');
  const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

  try {
    await signIn(page, fixture.email, `/commandes/${orderId}`);

    await actionButton(page, 'Confirmer').click();
    await expect(page.getByText('Confirmée').first()).toBeVisible({ timeout: 15_000 });

    await actionButton(page, 'Programmer la livraison').click();
    await expect(page.getByText('Programmée').first()).toBeVisible({ timeout: 15_000 });

    await actionButton(page, 'Assigner').click();
    await expect(page.getByText('En livraison').first()).toBeVisible({ timeout: 15_000 });

    await actionButton(page, 'Marquer livree').click();
    await expect(page.getByText('Livrée').first()).toBeVisible({ timeout: 15_000 });

    const { data: order, error } = await fixture.admin
      .from('orders')
      .select('cod_status, cash_collectable_minor, payment_channel_at_delivery')
      .eq('id', orderId)
      .single();

    expect(error).toBeNull();
    expect(order?.cod_status).toBe('LIVREE');
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
