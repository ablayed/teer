import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Locator, type Page, expect, test } from '@playwright/test';
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

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+tableau-period-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
    .update({ name: `Tëër E2E Tableau ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, userId };
}

async function addAgent(admin: AdminClient, merchantAccountId: string) {
  const email = e2eEmail('agent');
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin.from('merchant_member').insert({
    merchant_account_id: merchantAccountId,
    role: 'agent',
    user_id: userId,
  });
  return { email, userId };
}

async function addManager(admin: AdminClient, merchantAccountId: string) {
  const email = e2eEmail('manager');
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin.from('merchant_member').insert({
    merchant_account_id: merchantAccountId,
    role: 'manager',
    user_id: userId,
  });
  return { email, userId };
}

async function createShop(admin: AdminClient, merchantAccountId: string, domain: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: domain,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id as string;
}

async function createDriver(admin: AdminClient, merchantAccountId: string, label: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur ${label}`,
      phone: `+22177${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');
  return data.id as string;
}

async function createProduct(admin: AdminClient, merchantAccountId: string, title: string) {
  const { data, error } = await admin
    .from('product')
    .insert({ merchant_account_id: merchantAccountId, title, unit_cost: 1_000 })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id as string;
}

async function seedDeliveredCollectedOrder(
  admin: AdminClient,
  {
    assignedDriverId,
    merchantAccountId,
    productId,
    shopId,
    title,
    totalAmount,
  }: {
    assignedDriverId?: string | null;
    merchantAccountId: string;
    productId: string;
    shopId: string;
    title: string;
    totalAmount: number;
  },
) {
  const timestamp = new Date().toISOString();
  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      assigned_driver_id: assignedDriverId ?? null,
      source: 'manual',
      order_number: `TAB-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: totalAmount,
      cash_collectable_minor: totalAmount,
      delivery_fee_minor: 0,
      currency: 'XOF',
      items_summary: [{ title, quantity: 1, price: totalAmount }],
      order_state: 'completed',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
      cash_collected_at: timestamp,
      payment_channel_at_delivery: 'ESPECES',
    })
    .select('id')
    .single();
  if (orderError || !order) throw orderError ?? new Error('order insert failed');

  const { error: lineError } = await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    order_id: order.id,
    product_id: productId,
    raw_title: title,
    qty: 1,
    match_status: 'matched',
  });
  if (lineError) throw lineError;
}

async function signIn(page: Page, email: string, redirectTo = '/tableau') {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await page.waitForURL(`**${redirectTo.split('?')[0]}**`);
}

async function clickFilterUntilUrl(page: Page, getLink: () => Locator, url: RegExp) {
  await expect(async () => {
    await getLink().click();
    await expect(page).toHaveURL(url, { timeout: 1_500 });
  }).toPass({ intervals: [250, 500, 1_000], timeout: 10_000 });
}

test.describe('Tableau période + CA/livraisons', () => {
  test.skip(!hasSupabaseAdmin, 'SUPABASE service role requis pour seeder les fixtures');

  test('owner : PeriodPicker conserve shop et les blocs période ne se dupliquent pas', async ({
    page,
  }) => {
    const { admin, email, merchantAccountId } = await createOwnerFixture('owner-period');
    const shopA = await createShop(admin, merchantAccountId, `ta-${Date.now()}.myshopify.com`);
    const shopB = await createShop(admin, merchantAccountId, `tb-${Date.now()}.myshopify.com`);
    const driverId = await createDriver(admin, merchantAccountId, 'Owner');
    const productA = await createProduct(admin, merchantAccountId, 'Sac owner');
    const productB = await createProduct(admin, merchantAccountId, 'Ceinture owner');

    await seedDeliveredCollectedOrder(admin, {
      assignedDriverId: driverId,
      merchantAccountId,
      productId: productA,
      shopId: shopA,
      title: 'Sac owner',
      totalAmount: 10_000,
    });
    await seedDeliveredCollectedOrder(admin, {
      assignedDriverId: driverId,
      merchantAccountId,
      productId: productB,
      shopId: shopB,
      title: 'Ceinture owner',
      totalAmount: 8_000,
    });

    await signIn(page, email, '/tableau');

    const selector = page.getByRole('navigation', { name: messages.tableau.shops.ariaLabel });
    await clickFilterUntilUrl(
      page,
      () => selector.getByRole('link', { name: /ta-.*\.myshopify\.com/ }),
      new RegExp(`/tableau\\?.*shop=${shopA}`),
    );

    await page.getByRole('button', { name: /Choisir la période/ }).click();
    await page
      .getByRole('button', { name: messages.periodPicker.presets['30j'], exact: true })
      .click();

    await expect(page).toHaveURL(
      new RegExp(`/tableau\\?(?=[^#]*shop=${shopA})(?=[^#]*period=30j)`),
    );
    await expect(page.getByText(messages.finance.profit.ca, { exact: true })).toHaveCount(1);
    await expect(page.getByText('CA par produit', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Livraisons', { exact: true })).toHaveCount(1);
  });

  test('manager : voit tous les blocs (CA total, CA par produit, Livraisons)', async ({ page }) => {
    const { admin, merchantAccountId } = await createOwnerFixture('manager-visibility');
    const { email: managerEmail } = await addManager(admin, merchantAccountId);
    const shopId = await createShop(
      admin,
      merchantAccountId,
      `manager-${Date.now()}.myshopify.com`,
    );
    const driverId = await createDriver(admin, merchantAccountId, 'Manager');
    const productId = await createProduct(admin, merchantAccountId, 'Produit manager');

    await seedDeliveredCollectedOrder(admin, {
      assignedDriverId: driverId,
      merchantAccountId,
      productId,
      shopId,
      title: 'Produit manager',
      totalAmount: 12_000,
    });

    await signIn(page, managerEmail, '/tableau?period=30j');

    await expect(page.getByText(messages.finance.profit.ca, { exact: true })).toHaveCount(1);
    await expect(page.getByText('CA par produit', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Livraisons', { exact: true })).toHaveCount(1);
  });

  test('agent : blocs CA masqués, Livraisons visible', async ({ page }) => {
    const { admin, merchantAccountId } = await createOwnerFixture('agent-visibility');
    const { email: agentEmail } = await addAgent(admin, merchantAccountId);
    const shopId = await createShop(admin, merchantAccountId, `agent-${Date.now()}.myshopify.com`);
    const productId = await createProduct(admin, merchantAccountId, 'Produit agent');

    await seedDeliveredCollectedOrder(admin, {
      merchantAccountId,
      productId,
      shopId,
      title: 'Produit agent',
      totalAmount: 9_000,
    });

    await signIn(page, agentEmail, '/tableau?period=30j');

    await expect(page.getByText(messages.finance.profit.ca, { exact: true })).toHaveCount(0);
    await expect(page.getByText('CA par produit', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Livraisons', { exact: true })).toBeVisible();
  });

  test('owner : le cash livreurs du Tableau respecte le filtre shop', async ({ page }) => {
    const { admin, email, merchantAccountId } = await createOwnerFixture('cash-shop');
    const shopA = await createShop(admin, merchantAccountId, `casha-${Date.now()}.myshopify.com`);
    const shopB = await createShop(admin, merchantAccountId, `cashb-${Date.now()}.myshopify.com`);
    const driverId = await createDriver(admin, merchantAccountId, 'Cash');
    const productId = await createProduct(admin, merchantAccountId, 'Produit cash');

    await seedDeliveredCollectedOrder(admin, {
      assignedDriverId: driverId,
      merchantAccountId,
      productId,
      shopId: shopA,
      title: 'Produit cash',
      totalAmount: 10_000,
    });
    await seedDeliveredCollectedOrder(admin, {
      assignedDriverId: driverId,
      merchantAccountId,
      productId,
      shopId: shopB,
      title: 'Produit cash',
      totalAmount: 7_000,
    });

    await signIn(page, email, '/tableau');

    const cashCard = page
      .locator('section.rounded-lg')
      .filter({ has: page.getByText('Cash total chez les livreurs', { exact: true }) });
    await expect(cashCard).toContainText(/17.?000/);

    const selector = page.getByRole('navigation', { name: messages.tableau.shops.ariaLabel });
    await clickFilterUntilUrl(
      page,
      () => selector.getByRole('link', { name: /casha-.*\.myshopify\.com/ }),
      new RegExp(`/tableau\\?.*shop=${shopA}`),
    );

    await expect(cashCard).toContainText(/10.?000/);
  });
});
