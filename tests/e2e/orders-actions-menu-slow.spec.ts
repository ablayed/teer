import { existsSync, readFileSync } from 'node:fs';
import { legacyStatusToDimensions } from '@/lib/domain/order-transition-actions';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { landOnTarget } from './helpers/auth';
import { grantCurrentConsents } from './helpers/consent';

// Menu « Actions » de la LISTE de commandes sous réseau lent (V4) : le code du menu n'arrive qu'après
// l'appui. Un seul appui doit suffire, l'attente doit se voir, et un téléchargement échoué doit
// pouvoir être retenté. Réseau « Slow 4G » et processeur ×6 par le protocole DevTools : Chromium
// seulement (desktop et Pixel 7), WebKit n'expose pas ce protocole.
//
// Le service worker (builds de production) rend les requêtes invisibles à `page.route()` : bloqué.
test.use({ serviceWorkers: 'block' });
test.setTimeout(90_000);

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
const password = 'Mot-de-passe-e2e-2026!';

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createOwnerWithOrder() {
  const admin = adminClient();
  const email = `e2e+actslow-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) throw createError ?? new Error('Utilisateur E2E non créé');
  const userId = created.user.id;
  await grantCurrentConsents(admin, userId);

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

  await admin
    .from('merchant_account')
    .update({ name: 'Tëër E2E ActionMenuSlow', onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);

  const dimensions = legacyStatusToDimensions('A_APPELER');
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Client Menu Lent',
      phone: '+221771234567',
      shipping_address: { address1: 'Almadies', city: 'Dakar', country: 'SN' },
    })
    .select('id')
    .single();
  if (customerError) throw customerError;

  const { error: orderError } = await admin.from('orders').insert({
    merchant_account_id: merchantAccountId,
    customer_id: customer.id,
    order_number: `E2E-SLOW-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
  });
  if (orderError) throw orderError;

  return { admin, email, userIds: [userId] };
}

async function signIn(page: Page, email: string) {
  await page.goto('/connexion');
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await landOnTarget(page, '/commandes');
}

// « Slow 4G » des outils de développement : 1,6 Mbit/s descendant, 750 kbit/s montant, 150 ms.
async function throttle(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  return cdp;
}

function openMenu(page: Page, projectName: string) {
  return page.getByRole(projectName === 'chromium' ? 'menu' : 'dialog');
}

test.describe('menu Actions de la liste — réseau lent', () => {
  test.beforeEach(({ browserName: _browserName }, testInfo) => {
    test.skip(!serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY manquant');
    test.skip(
      !['chromium', 'pixel-7'].includes(testInfo.project.name),
      'Limitation réseau et processeur : Chromium seulement',
    );
  });

  test('un seul appui : l’attente se voit, puis le menu s’ouvre, sans second appui', async ({
    page,
  }, testInfo) => {
    const fixture = await createOwnerWithOrder();
    try {
      await signIn(page, fixture.email);
      const trigger = page.getByTestId('order-actions-trigger').first();
      await expect(trigger).toBeVisible({ timeout: 20_000 });
      await expect(trigger).toHaveAttribute('data-state', 'idle');
      // La page est hydratée : on ne mesure pas l'hydratation, seulement le premier appui.
      await page.waitForLoadState('networkidle');

      await throttle(page);
      // `dispatchEvent` n'émet ni survol ni toucher : le code du menu n'a PAS été préchargé.
      await trigger.dispatchEvent('click');

      // L'attente se voit tant que le code n'est pas là, et le bouton annonce qu'il est occupé.
      const busy = page.getByTestId('order-actions-trigger').first();
      await expect(busy).toHaveAttribute('data-state', 'loading', { timeout: 5_000 });
      await expect(busy).toHaveAttribute('aria-busy', 'true');

      // Un seul appui a suffi : le menu s'ouvre de lui-même, une seule fois.
      await expect(openMenu(page, testInfo.project.name)).toBeVisible({ timeout: 45_000 });
      await expect(openMenu(page, testInfo.project.name)).toHaveCount(1);
    } finally {
      await Promise.all(fixture.userIds.map((id) => fixture.admin.auth.admin.deleteUser(id)));
    }
  });

  test('un chunk qui ne se télécharge pas : message de reprise, puis un appui réessaie', async ({
    page,
  }, testInfo) => {
    const fixture = await createOwnerWithOrder();
    try {
      await signIn(page, fixture.email);
      const trigger = page.getByTestId('order-actions-trigger').first();
      await expect(trigger).toBeVisible({ timeout: 20_000 });
      await page.waitForLoadState('networkidle');

      // Le réseau coupe les scripts qui arrivent après l'appui (le menu n'est pas encore là).
      let blocked = 0;
      await page.route('**/_next/static/chunks/**/*.js', async (route) => {
        blocked += 1;
        await route.abort('failed');
      });

      await trigger.dispatchEvent('click');
      const failed = page.getByTestId('order-actions-trigger').first();
      await expect(failed).toHaveAttribute('data-state', 'error', { timeout: 20_000 });
      await expect(failed).toHaveAccessibleName(messages.orders.actions.menuLoadFailed);
      expect(blocked).toBeGreaterThan(0);
      await expect(openMenu(page, testInfo.project.name)).toHaveCount(0);

      // Le réseau revient : un appui sur le bouton de reprise suffit.
      await page.unroute('**/_next/static/chunks/**/*.js');
      await failed.dispatchEvent('click');
      await expect(openMenu(page, testInfo.project.name)).toBeVisible({ timeout: 30_000 });
    } finally {
      await Promise.all(fixture.userIds.map((id) => fixture.admin.auth.admin.deleteUser(id)));
    }
  });
});
