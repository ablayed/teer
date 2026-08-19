import { existsSync, readFileSync } from 'node:fs';
import { legacyStatusToDimensions } from '@/lib/domain/order-transition-actions';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { landOnTarget } from './helpers/auth';
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

test.setTimeout(60_000);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+actmenu-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

async function createOwnerWithOrder() {
  const admin = adminClient();
  const email = e2eEmail('owner');
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);

  await admin
    .from('merchant_account')
    .update({ name: 'Tëër E2E ActionMenu', onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);

  // Commande en A_APPELER → actions disponibles : confirmer + journaliser_appel
  const dimensions = legacyStatusToDimensions('A_APPELER');
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Client Menu E2E',
      phone: '+221771234567',
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
      order_number: `E2E-ACT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: 12000,
      currency: 'XOF',
      cod_status: 'A_APPELER',
      order_state: dimensions.orderState,
      call_state: dimensions.callState,
      delivery_state: dimensions.deliveryState,
      cash_state: dimensions.cashState,
      items_summary: [{ title: 'Produit E2E Menu', quantity: 1, price: 12000 }],
      shipping_address: { address1: 'Almadies', city: 'Dakar', country: 'SN' },
      created_at_shopify: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (orderError) throw orderError;

  return { admin, email, orderId: order.id as string, userIds: [userId] };
}

async function signIn(page: Page, email: string) {
  await page.goto('/connexion');
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await landOnTarget(page, '/tableau');
}

async function cleanupUsers(admin: AdminClient, userIds: string[]) {
  await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)));
}

const MOBILE_PROJECTS = ['pixel-7', 'iphone-14'];

test.describe('ActionSheet — menu Actions de commande', () => {
  test("mobile : le bottom-sheet s'ouvre entièrement dans le viewport", async ({
    page,
  }, testInfo) => {
    test.skip(!hasSupabaseAdmin, 'SUPABASE_SERVICE_ROLE_KEY manquant');
    test.skip(!MOBILE_PROJECTS.includes(testInfo.project.name), 'Cas mobile uniquement');

    const fixture = await createOwnerWithOrder();

    try {
      await signIn(page, fixture.email);
      await page.goto(`/commandes/${fixture.orderId}`);

      const actionsBtn = page.getByRole('button', { name: /^Actions/ });
      await expect(actionsBtn).toBeVisible({ timeout: 15_000 });
      await actionsBtn.click();

      // Vaul Drawer porte role="dialog"
      const sheet = page.getByRole('dialog');
      await expect(sheet).toBeVisible();

      // Tous les items doivent être visibles et le dernier dans le viewport
      const items = page.locator('[data-testid^="action-sheet-item-"]');
      await expect(items.first()).toBeVisible();

      const last = items.last();
      await expect(last).toBeVisible();
      await expect(last).toBeInViewport();
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });

  test('desktop : le dropdown reste dans le viewport', async ({ page }, testInfo) => {
    test.skip(!hasSupabaseAdmin, 'SUPABASE_SERVICE_ROLE_KEY manquant');
    test.skip(testInfo.project.name !== 'chromium', 'Cas desktop uniquement');

    const fixture = await createOwnerWithOrder();

    try {
      await signIn(page, fixture.email);
      await page.goto(`/commandes/${fixture.orderId}`);

      const actionsBtn = page.getByRole('button', { name: /^Actions/ });
      await expect(actionsBtn).toBeVisible({ timeout: 15_000 });
      await actionsBtn.click();

      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu).toBeInViewport();
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });
});
