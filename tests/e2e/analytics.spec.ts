import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
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
type Role = 'owner' | 'manager' | 'agent';

function adminClient(): AdminClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+phase7c-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  for (let i = 0; i < 20; i += 1) {
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
    .update({ name: `Teer E2E Phase7c ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);

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
    role,
    user_id: userId,
  });
  if (error) throw error;
  fixture.userIds.push(userId);
  return { email, userId };
}

async function cleanupUsers(admin: AdminClient, userIds: string[]) {
  await Promise.all(userIds.map((userId) => admin.auth.admin.deleteUser(userId)));
}

async function signIn(page: Page, email: string, redirectTo = '/analyses') {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await page.waitForLoadState('networkidle');
}

async function seedAnalyticsFixture(admin: AdminClient, merchantAccountId: string) {
  const now = new Date().toISOString();
  const oldDate = '2026-01-10T10:00:00.000Z';

  const { data: product } = await admin
    .from('product')
    .insert({
      is_active: true,
      merchant_account_id: merchantAccountId,
      title: `Sandale Risque ${Date.now()}`,
      unit_cost: 0,
    })
    .select('id, title')
    .single();
  if (!product) throw new Error('product missing');

  const { data: driver } = await admin
    .from('driver')
    .insert({
      full_name: 'Moussa Analytics',
      merchant_account_id: merchantAccountId,
      phone: '+221770000999',
    })
    .select('id, full_name')
    .single();
  if (!driver) throw new Error('driver missing');

  const { data: customerCancel } = await admin
    .from('customer')
    .insert({
      full_name: 'Client Annule',
      merchant_account_id: merchantAccountId,
      phone: '+221770001001',
      shipping_address: { address1: 'Plateau', city: 'Dakar', country: 'SN' },
    })
    .select('id')
    .single();
  const { data: customerRto } = await admin
    .from('customer')
    .insert({
      address: { city: 'Guediawaye', region: 'Guediawaye' },
      full_name: 'Client Refuseur',
      merchant_account_id: merchantAccountId,
      phone: '+221770001002',
      shipping_address: { address1: 'Guediawaye', city: 'Dakar', country: 'SN' },
    })
    .select('id')
    .single();
  const { data: customerReturn } = await admin
    .from('customer')
    .insert({
      address: { city: 'Almadies', region: 'Dakar Ouest' },
      full_name: 'Client Retour',
      merchant_account_id: merchantAccountId,
      phone: '+221770001003',
      shipping_address: { address1: 'Almadies', city: 'Dakar', country: 'SN' },
    })
    .select('id')
    .single();
  const { data: customerDelivered } = await admin
    .from('customer')
    .insert({
      full_name: 'Client Livre',
      merchant_account_id: merchantAccountId,
      phone: '+221770001004',
      shipping_address: { address1: 'Mermoz', city: 'Dakar', country: 'SN' },
    })
    .select('id')
    .single();

  if (!customerCancel || !customerRto || !customerReturn || !customerDelivered) {
    throw new Error('customer missing');
  }

  const { data: cancelOrder } = await admin
    .from('orders')
    .insert({
      call_state: 'to_call',
      cancel_reason: 'cancelled',
      cash_state: 'not_due',
      created_at: now,
      currency: 'XOF',
      customer_id: customerCancel.id,
      delivery_state: 'unassigned',
      items_summary: [{ price: 10000, quantity: 1, title: product.title }],
      merchant_account_id: merchantAccountId,
      order_number: `AN-CANCEL-${Date.now()}`,
      order_state: 'cancelled',
      source: 'shopify',
      total_amount: 10000,
    })
    .select('id')
    .single();
  const { data: failedOrder } = await admin
    .from('orders')
    .insert({
      assigned_driver_id: driver.id,
      call_state: 'validated',
      cancel_reason: 'refused',
      cash_state: 'expected',
      cod_status: 'REFUSEE',
      created_at: now,
      currency: 'XOF',
      customer_id: customerRto.id,
      delivery_state: 'failed',
      items_summary: [{ price: 12000, quantity: 1, title: product.title }],
      merchant_account_id: merchantAccountId,
      order_number: `AN-RTO-${Date.now()}`,
      order_state: 'open',
      source: 'whatsapp',
      total_amount: 12000,
    })
    .select('id')
    .single();
  const { data: returnOrder } = await admin
    .from('orders')
    .insert({
      assigned_driver_id: driver.id,
      call_state: 'validated',
      cash_state: 'collected',
      cod_status: 'REFUSEE',
      created_at: now,
      currency: 'XOF',
      customer_id: customerReturn.id,
      delivery_state: 'returned',
      items_summary: [{ price: 14000, quantity: 1, title: product.title }],
      merchant_account_id: merchantAccountId,
      order_number: `AN-RETURN-${Date.now()}`,
      order_state: 'returned',
      returned_at: now,
      source: 'manual',
      total_amount: 14000,
    })
    .select('id')
    .single();
  const { data: deliveredOrder } = await admin
    .from('orders')
    .insert({
      call_state: 'validated',
      cash_collected_at: now,
      cash_state: 'collected',
      cod_status: 'LIVREE',
      created_at: now,
      currency: 'XOF',
      customer_id: customerDelivered.id,
      delivery_state: 'delivered',
      items_summary: [{ price: 16000, quantity: 1, title: product.title }],
      merchant_account_id: merchantAccountId,
      order_number: `AN-DELIVERED-${Date.now()}`,
      order_state: 'completed',
      source: 'instagram',
      total_amount: 16000,
    })
    .select('id')
    .single();
  const { data: oldFailedOrder } = await admin
    .from('orders')
    .insert({
      call_state: 'validated',
      cash_state: 'expected',
      cod_status: 'REFUSEE',
      created_at: oldDate,
      currency: 'XOF',
      customer_id: customerRto.id,
      delivery_state: 'failed',
      items_summary: [{ price: 9000, quantity: 1, title: product.title }],
      merchant_account_id: merchantAccountId,
      order_number: `AN-OLD-RTO-${Date.now()}`,
      order_state: 'open',
      source: 'shopify',
      total_amount: 9000,
    })
    .select('id')
    .single();

  if (!cancelOrder || !failedOrder || !returnOrder || !deliveredOrder || !oldFailedOrder) {
    throw new Error('order missing');
  }

  await admin.from('order_line').insert([
    {
      match_status: 'matched',
      merchant_account_id: merchantAccountId,
      order_id: failedOrder.id,
      product_id: product.id,
      qty: 1,
      raw_sku: 'RISK-1',
      raw_title: product.title,
    },
    {
      match_status: 'matched',
      merchant_account_id: merchantAccountId,
      order_id: returnOrder.id,
      product_id: product.id,
      qty: 1,
      raw_sku: 'RISK-1',
      raw_title: product.title,
    },
  ]);

  await admin.from('audit_log').insert([
    {
      action: 'order.transition',
      merchant_account_id: merchantAccountId,
      payload: {
        nextDimensions: { delivery_state: 'unassigned', order_state: 'cancelled' },
        priorDimensions: { delivery_state: 'scheduled', order_state: 'open' },
      },
      resource_id: cancelOrder.id,
      resource_type: 'orders',
    },
    {
      action: 'order.transition',
      merchant_account_id: merchantAccountId,
      payload: {
        nextDimensions: { delivery_state: 'failed', order_state: 'open' },
        priorDimensions: { delivery_state: 'out_for_delivery', order_state: 'open' },
      },
      resource_id: failedOrder.id,
      resource_type: 'orders',
    },
    {
      action: 'order.transition',
      merchant_account_id: merchantAccountId,
      payload: {
        nextDimensions: { delivery_state: 'delivered', order_state: 'completed' },
        priorDimensions: { delivery_state: 'assigned', order_state: 'open' },
      },
      resource_id: returnOrder.id,
      resource_type: 'orders',
    },
    {
      action: 'order.transition',
      created_at: now,
      merchant_account_id: merchantAccountId,
      payload: {
        nextDimensions: { delivery_state: 'returned', order_state: 'returned' },
        priorDimensions: { delivery_state: 'delivered', order_state: 'completed' },
      },
      resource_id: returnOrder.id,
      resource_type: 'orders',
    },
    {
      action: 'order.transition',
      merchant_account_id: merchantAccountId,
      payload: {
        nextDimensions: { delivery_state: 'delivered', order_state: 'completed' },
        priorDimensions: { delivery_state: 'assigned', order_state: 'open' },
      },
      resource_id: deliveredOrder.id,
      resource_type: 'orders',
    },
  ]);

  return {
    productTitle: product.title,
  };
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E analytics');

test('analytics pertes COD : scorecard canal, tendance et refuseur repete visibles', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('analytics-owner');
  try {
    const seeded = await seedAnalyticsFixture(fixture.admin, fixture.merchantAccountId);
    await signIn(page, fixture.email, '/analyses');

    await expect(page.getByRole('heading', { name: messages.analytics.title })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole('heading', { name: messages.analytics.scorecard.title }).first(),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: messages.analytics.trends.title })).toBeVisible({
      timeout: 15_000,
    });

    const cancellationCard = page
      .locator('section')
      .filter({ hasText: messages.analytics.summary.cancellationRate })
      .first();
    const rtoCard = page
      .locator('section')
      .filter({ hasText: messages.analytics.summary.rtoRate })
      .first();
    const returnCard = page
      .locator('section')
      .filter({ hasText: messages.analytics.summary.returnRate })
      .first();

    await expect(cancellationCard).toContainText('25');
    await expect(rtoCard).toContainText('50');
    await expect(returnCard).toContainText('50');

    await expect(page.getByRole('cell', { name: 'shopify' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'whatsapp' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'manual' })).toBeVisible();
    await expect(page.getByText(seeded.productTitle).first()).toBeVisible();
    await expect(page.getByText('Guediawaye')).toBeVisible();
    await expect(page.getByText('Moussa Analytics')).toBeVisible();
    await expect(page.getByText('Client Refuseur')).toBeVisible();
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('analytics visibles pour un manager', async ({ page }) => {
  const fixture = await createOwnerFixture('analytics-manager');
  const manager = await addMember(fixture, 'manager');
  try {
    await seedAnalyticsFixture(fixture.admin, fixture.merchantAccountId);
    await signIn(page, manager.email, '/commandes');

    // Densité #1 : sur mobile les écrans secondaires (dont Analyses) sont regroupés dans le
    // menu « Plus » de la bottom-nav ; sur desktop le lien est dans la barre latérale. On
    // ouvre « Plus » s'il est présent, puis on prouve que le lien Analyses est atteignable
    // ET fonctionnel (clic → navigation), pas seulement présent dans le DOM.
    const plusButton = page.getByRole('button', { name: 'Plus' });
    if (await plusButton.isVisible().catch(() => false)) {
      await plusButton.click();
    }
    const analysesLink = page
      .getByRole('link', { name: messages.nav.analyses, exact: true })
      .first();
    await expect(analysesLink).toBeVisible();
    await analysesLink.click();

    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: messages.analytics.title })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('analytics cachees pour un agent', async ({ page }) => {
  const fixture = await createOwnerFixture('analytics-agent');
  const agent = await addMember(fixture, 'agent');
  try {
    await signIn(page, agent.email, '/commandes');

    await expect(
      page.getByRole('link', { name: messages.nav.analyses, exact: true }).first(),
    ).not.toBeVisible();

    await page.goto('/analyses');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(messages.analytics.restricted)).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
