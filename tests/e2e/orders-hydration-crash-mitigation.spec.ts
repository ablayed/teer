import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { grantCurrentConsents } from './helpers/consent';

// Mitigation NON PROUVÉE à 100 % (cf. CLAUDE.md, PR fix/orders-hydration-crash-mitigation) :
// une reproduction directe du crash React #418 n'a jamais été obtenue (ni par l'agent
// précédent, ni ici). Ce spec ne peut donc PAS prouver l'absence du bug — il prouve
// seulement que : (a) `prefetch={false}` supprime la salve de requêtes de préchargement RSC
// par ligne de commande observée précédemment, (b) aucune erreur console/aucun crash de
// boundary ne se produit sur un cycle recherche/effacement répété, sur ce jeu de données et
// cet environnement précis.

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
  return `e2e+hydration-crash-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
    .update({ name: `Tëër E2E Hydration Crash ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, userId };
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

async function seedOrder(
  admin: AdminClient,
  {
    customerName,
    merchantAccountId,
    shopId,
  }: { customerName: string; merchantAccountId: string; shopId: string },
) {
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: customerName,
      phone: `+22177${Math.floor(Math.random() * 9000000 + 1000000)}`,
    })
    .select('id')
    .single();
  if (customerError || !customer) throw customerError ?? new Error('customer insert failed');

  const { error } = await admin.from('orders').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    customer_id: customer.id,
    source: 'manual',
    order_number: `HC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    total_amount: 12000,
    currency: 'XOF',
    order_state: 'open',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
    created_at: new Date().toISOString(),
    created_at_shopify: new Date().toISOString(),
  });
  if (error) throw error;
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await page.waitForURL(`**${redirectTo.split('?')[0]}**`);
}

test.describe('Mitigation crash /commandes (hydratation #418) — prefetch désactivé sur les lignes', () => {
  test.skip(!hasSupabaseAdmin, 'SUPABASE service role requis pour seeder les fixtures');

  test('cycles recherche/effacement répétés : aucune requête de prefetch par ligne, aucune erreur console', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'interception réseau : desktop only');

    const { admin, email, merchantAccountId } = await createOwnerFixture('mitig');
    const shopId = await createShop(admin, merchantAccountId, `hc-${Date.now()}.myshopify.com`);

    const sharedToken = `Freezetest${Date.now()}`;
    for (let i = 0; i < 20; i += 1) {
      await seedOrder(admin, {
        customerName: `${sharedToken} Client ${i}`,
        merchantAccountId,
        shopId,
      });
    }

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      consoleErrors.push(error.message);
      pageErrors.push(error.message);
    });

    // Une requête de PRECHARGEMENT (pas une navigation cliquée) vers une page de détail de
    // commande porte l'en-tête `next-router-prefetch` posé par le client Next lorsqu'un
    // `<Link>` visible programme un prefetch. Après le fix (`prefetch={false}` sur
    // ResourceRow), ce compteur doit rester à 0 pendant tout le cycle recherche/effacement,
    // qui monte/démonte des dizaines de `<Link>` de ligne à chaque frappe.
    let orderDetailPrefetchCount = 0;
    page.on('request', (request) => {
      const url = new URL(request.url());
      const isOrderDetailPath = /^\/commandes\/[^/]+$/.test(url.pathname);
      const isPrefetch = request.headers()['next-router-prefetch'] !== undefined;
      if (isOrderDetailPath && isPrefetch) {
        orderDetailPrefetchCount += 1;
      }
    });

    await signIn(page, email, '/commandes');

    let injectedSearchFailure = false;
    await page.route('**/api/orders/search**', async (route) => {
      const url = new URL(route.request().url());
      if (!injectedSearchFailure && url.searchParams.get('q') === `${sharedToken} Client 1`) {
        injectedSearchFailure = true;
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    const searchBox = page.getByRole('searchbox');

    // Rétrécissement progressif puis effacement complet — reproduit le détail rapporté en
    // production (le freeze survient spécifiquement en VIDANT la recherche).
    await searchBox.fill(sharedToken);
    await page.waitForTimeout(400);
    await searchBox.fill(`${sharedToken} Client 1`);
    await expect.poll(() => injectedSearchFailure).toBe(true);
    const results = page.getByTestId('orders-results');
    await expect(results).not.toHaveAttribute('aria-busy', 'true');
    await expect(results).not.toHaveClass(/pointer-events-none/);
    await searchBox.fill('');
    await page.waitForTimeout(400);
    await searchBox.fill(sharedToken);
    await page.waitForTimeout(400);
    await searchBox.fill('');
    await page.waitForTimeout(600);

    expect(orderDetailPrefetchCount).toBe(0);
    expect(
      consoleErrors.filter((text) => /Minified React error #4(18|19|21|25)/.test(text)),
    ).toEqual([]);
    expect(pageErrors).toEqual([]);

    // Non-régression : le clic normal sur une ligne doit toujours ouvrir le détail (modale
    // interceptée) — seul le PRÉCHARGEMENT anticipé disparaît, pas la navigation au clic.
    // Ciblage de la première ligne (topmost, sans scroll) pour isoler l'assertion du
    // comportement de clic — le rang exact de la ligne n'est pas ce qui est vérifié ici.
    const firstRowLink = page
      .getByRole('link', { name: new RegExp(`${sharedToken} Client`) })
      .first();
    const orderHref = await firstRowLink.getAttribute('href');
    await firstRowLink.scrollIntoViewIfNeeded();
    await firstRowLink.click();
    await expect(page).toHaveURL(new RegExp(`${orderHref}$`), { timeout: 15_000 });
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
  });
});
