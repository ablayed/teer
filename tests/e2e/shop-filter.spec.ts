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
        return [key, valueParts.join('=').replace(/^['"]|['"]$/g, '')];
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
type AdminClient = SupabaseClient;
type Role = 'manager' | 'agent';

test.setTimeout(90_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E workspace');

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+phase1-workspace-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
    .update({ name: `Tëër E2E Phase 1 ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, userIds: [userId] };
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

async function createShop(admin: AdminClient, merchantAccountId: string, label: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      display_name: label,
      merchant_account_id: merchantAccountId,
      shop_domain: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.myshopify.com`,
      access_token_encrypted: 'e2e-encrypted-token',
      scopes: 'read_orders',
    })
    .select('id, display_name')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data as { id: string; display_name: string };
}

async function seedScopedData(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  label: string,
) {
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      full_name: `Client ${label}`,
      phone: `+22177${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    })
    .select('id')
    .single();
  if (customerError || !customer) throw customerError ?? new Error('customer insert failed');

  const { error: productError } = await admin.from('product').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    title: `Produit ${label}`,
    unit_cost: 1000,
  });
  if (productError) throw productError;

  const { error: orderError } = await admin.from('orders').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    customer_id: customer.id,
    source: 'manual',
    order_number: `P1-${label}-${Date.now()}`,
    total_amount: 12000,
    currency: 'XOF',
    order_state: 'open',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
  });
  if (orderError) throw orderError;
}

async function cleanupUsers(admin: AdminClient, userIds: string[]) {
  await Promise.all(userIds.map((userId) => admin.auth.admin.deleteUser(userId)));
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  try {
    await page.waitForURL(/\/s(?:\/|$)/, { timeout: 15_000 });
  } catch (error) {
    const alert = (await page.getByRole('alert').textContent())?.trim() ?? '';
    throw new Error(`E2E sign-in did not reach workspace: ${alert || 'no error message'}`, {
      cause: error,
    });
  }
}

async function getStores(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .select('id, display_name, shop_domain')
    .eq('merchant_account_id', merchantAccountId)
    .order('installed_at');
  if (error || !data) throw error ?? new Error('stores unavailable');
  return data as { id: string; display_name: string; shop_domain: string }[];
}

test('single-store owner: login selects the only store automatically', async ({ page }) => {
  const fixture = await createOwnerFixture('single');
  try {
    const [store] = await getStores(fixture.admin, fixture.merchantAccountId);
    await signIn(page, fixture.email, '/s');
    await expect(page).toHaveURL(new RegExp(`/s/${store.id}/tableau$`));
    await expect(page.getByText(store.display_name, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Changer' })).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('multi-store owner: chooser, authorized deep link and valid switch', async ({ page }) => {
  const fixture = await createOwnerFixture('chooser');
  try {
    const first = await getStores(fixture.admin, fixture.merchantAccountId);
    const storeA = await createShop(fixture.admin, fixture.merchantAccountId, 'Boutique A');
    const storeB = await createShop(fixture.admin, fixture.merchantAccountId, 'Boutique B');
    const stores = [...first, storeA, storeB];

    await signIn(page, fixture.email, '/s');
    await expect(page).toHaveURL(/\/s$/);
    await expect(page.getByRole('heading', { name: 'Choisissez une boutique' })).toBeVisible();
    for (const store of stores) {
      await expect(page.locator(`a[href="/s/${store.id}/tableau"]`)).toBeVisible();
    }

    await page.locator(`a[href="/s/${storeA.id}/tableau"]`).click();
    await expect(page).toHaveURL(new RegExp(`/s/${storeA.id}/tableau$`));
    await expect(page.getByText(storeA.display_name, { exact: true }).first()).toBeVisible();
    await page.getByText('Changer', { exact: true }).click();
    await page.locator(`a[href="/s/${storeB.id}/tableau"]`).click();
    await expect(page).toHaveURL(new RegExp(`/s/${storeB.id}/tableau$`));
    await expect(page.getByText(storeB.display_name, { exact: true }).first()).toBeVisible();
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('unauthorized store URL redirects safely; authorized deep link preserves context', async ({
  page,
}) => {
  const tenantA = await createOwnerFixture('route-a');
  const tenantB = await createOwnerFixture('route-b');
  try {
    const [storeA] = await getStores(tenantA.admin, tenantA.merchantAccountId);
    const [storeB] = await getStores(tenantB.admin, tenantB.merchantAccountId);
    await signIn(page, tenantA.email, `/s/${storeA.id}/tableau`);
    await expect(page).toHaveURL(new RegExp(`/s/${storeA.id}/tableau$`));
    await page.goto(`/s/${storeB.id}/tableau`);
    await expect(page).toHaveURL(new RegExp(`/s/${storeA.id}/tableau$`));
    await expect(page.getByText(storeB.shop_domain, { exact: true })).toHaveCount(0);
    await page.goto(`/s/${storeA.id}/clients`);
    await expect(page).toHaveURL(new RegExp(`/s/${storeA.id}/clients$`));
    await expect(page.getByText(storeA.display_name, { exact: true }).first()).toBeVisible();
  } finally {
    await cleanupUsers(tenantA.admin, tenantA.userIds);
    await cleanupUsers(tenantB.admin, tenantB.userIds);
  }
});

test('Orders, Customers and Products stay scoped to the active store', async ({ page }, testInfo) => {
  const fixture = await createOwnerFixture('scope');
  try {
    const storeA = await createShop(fixture.admin, fixture.merchantAccountId, 'Scope A');
    const storeB = await createShop(fixture.admin, fixture.merchantAccountId, 'Scope B');
    await seedScopedData(fixture.admin, fixture.merchantAccountId, storeA.id, 'A');
    await seedScopedData(fixture.admin, fixture.merchantAccountId, storeB.id, 'B');
    await signIn(page, fixture.email, '/s');
    await page.goto(`/s/${storeA.id}/commandes`);

    await expect(page).toHaveURL(new RegExp(`/s/${storeA.id}/commandes$`));
    await expect(page.getByText('Client A', { exact: true })).toBeVisible();
    await expect(page.getByText('Client B', { exact: true })).toHaveCount(0);
    await page.goto(`/s/${storeA.id}/clients`);
    await expect(page.getByText('Client A', { exact: true })).toBeVisible();
    await expect(page.getByText('Client B', { exact: true })).toHaveCount(0);
    await page.goto(`/s/${storeA.id}/produits`);
    const productContainer =
      testInfo.project.name === 'chromium'
        ? '[data-testid^="product-catalog-card-"]'
        : '[data-testid^="product-catalog-row-"]';
    await expect(
      page.locator(productContainer, { hasText: 'Produit A' }),
    ).toBeVisible();
    await expect(page.locator(productContainer, { hasText: 'Produit B' })).toHaveCount(0);
    await page.getByPlaceholder('Rechercher par titre ou SKU…').fill('a');
    await expect(page).toHaveURL(new RegExp(`/s/${storeA.id}/produits[?]q=a`));
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('owner and manager can reach organization courier cash; agent sees explicit restriction', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('cash-rbac');
  try {
    const [store] = await getStores(fixture.admin, fixture.merchantAccountId);
    const manager = await addMember(fixture, 'manager');
    const agent = await addMember(fixture, 'agent');

    await signIn(page, fixture.email, `/s/${store.id}/livreurs`);
    await expect(page.getByRole('heading', { name: 'Livreurs' })).toBeVisible();
    await page.context().clearCookies();
    await signIn(page, manager.email, `/s/${store.id}/livreurs`);
    await expect(page.getByRole('heading', { name: 'Livreurs' })).toBeVisible();
    await page.context().clearCookies();
    await signIn(page, agent.email, `/s/${store.id}/livreurs`);
    await expect(
      page.getByText('Cette section est réservée au propriétaire et aux managers.'),
    ).toBeVisible();
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('mobile keeps the active store and primary navigation reachable', async ({
  page,
}, testInfo) => {
  test.skip(!['pixel-7', 'iphone-14'].includes(testInfo.project.name), 'mobile project only');
  const fixture = await createOwnerFixture('mobile');
  try {
    const [store] = await getStores(fixture.admin, fixture.merchantAccountId);
    await signIn(page, fixture.email, `/s/${store.id}/tableau`);
    const activeStore = page.getByText(store.display_name, { exact: true }).first();
    await expect(activeStore).toBeVisible();
    const nav = page.locator('nav').last();
    await expect(nav).toBeVisible();
    const box = await nav.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('link', { name: 'Commandes' }).last()).toBeVisible();
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
