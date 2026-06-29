/**
 * Phase 0c / C1 — fraîcheur des données APRÈS le round-trip recherche → détail → retour
 * → mutation (PROD-ONLY).
 *
 * ⚠️ La classe de bug « Router Cache client périmé » ne se reproduit QUE sur un build de
 * production (`next build && next start`), jamais en `next dev`. La recherche met l'URL à
 * jour en shallow (history.replaceState) puis relit le serveur en paradigme A ; ce test
 * vérifie qu'après être entré sur une commande puis revenu (back), une mutation
 * (confirmer) affiche bien des compteurs FRAIS — pas une vue mise en cache.
 *
 * Skippé sauf E2E_PROD_BUILD=1 (vert à tort en `pnpm dev`). Pour l'exécuter :
 *   1. supabase start
 *   2. set -a; . ./.env.test; set +a
 *   3. pnpm build
 *   4. E2E_PROD_BUILD=1 pnpm exec playwright test tests/e2e/orders-search-prod-cache.spec.ts \
 *        --project=chromium   (Playwright lance `pnpm start` lui-même)
 */
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
const isProdBuildRun = process.env.E2E_PROD_BUILD === '1';
const password = 'Mot-de-passe-e2e-2026!';

test.setTimeout(90_000);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function signIn(page: Page, email: string) {
  await page.goto('/connexion?redirectTo=%2Fcommandes');
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await page.waitForURL('**/commandes');
  await expect(page.getByRole('heading', { name: 'Commandes' })).toBeVisible();
}

async function seedToCallOrder(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  customerName: string,
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
    order_number: `SPC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    total_amount: 12000,
    currency: 'XOF',
    order_state: 'open',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
    created_at_shopify: new Date().toISOString(),
  });
  if (error) throw error;
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes');
test.skip(
  !isProdBuildRun,
  'Fraîcheur Router Cache PROD-ONLY : nécessite next build && next start + E2E_PROD_BUILD=1.',
);

test('recherche → détail → retour → mutation : compteurs frais (build prod)', async ({ page }) => {
  const admin = adminClient();
  const email = `e2e+searchcache-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
        const { data } = await admin
          .from('merchant_account')
          .select('id')
          .eq('owner_user_id', userId)
          .maybeSingle();
        merchantAccountId = data?.id ?? '';
        return merchantAccountId;
      },
      { timeout: 10_000, intervals: [100, 250, 500] },
    )
    .not.toBe('');

  await admin
    .from('merchant_account')
    .update({ name: 'Tëër E2E search-cache', onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  const { data: shop, error: shopError } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `searchcache-${Date.now()}.myshopify.com`,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (shopError || !shop) throw shopError ?? new Error('Boutique seed non créée');

  await seedToCallOrder(admin, merchantAccountId, shop.id, 'Recherche Cible Unique');
  await seedToCallOrder(admin, merchantAccountId, shop.id, 'Client Autre Un');
  await seedToCallOrder(admin, merchantAccountId, shop.id, 'Client Autre Deux');

  try {
    await signIn(page, email);
    await expect(page.getByRole('button', { name: /^À appeler \(3\)/ })).toBeVisible();

    // Recherche en page (synchro shallow + refetch serveur paradigme A).
    await page.getByRole('searchbox').fill('Cible Unique');
    await page.waitForURL(/\/commandes\?.*q=cible/i);
    await expect(page.getByText('Recherche Cible Unique')).toBeVisible();
    await expect(page.getByText('Client Autre Un')).toHaveCount(0);

    // Ouvre la commande, puis revient en arrière (back) — c'est ce round-trip qui exposait
    // le Router Cache périmé à travers un client component.
    await page.getByText('Recherche Cible Unique').click();
    await page.waitForURL(/\/commandes\/[0-9a-f-]{36}/i);
    await page.goBack();
    await page.waitForURL(/\/commandes(\?|$)/);

    // Recherche préservée au retour (back) : la cible reste seule visible, compteurs frais.
    await expect(page.getByRole('searchbox')).toHaveValue('Cible Unique');
    await expect(page.getByText('Recherche Cible Unique')).toBeVisible();
    await expect(page.getByRole('button', { name: /^À appeler \(1\)/ })).toBeVisible();

    // Mutation directe (sans dialog) depuis la liste sur la cible : « Refuser par le client »
    // est l'action directe disponible pour une commande À appeler.
    const cibleRow = page.locator('article').filter({ hasText: 'Recherche Cible Unique' });
    await cibleRow.getByRole('button', { name: /^Actions/ }).click();
    await page.getByRole('menuitem', { name: 'Refuser par le client' }).click();

    // Chiffres FRAIS après la mutation : « À appeler » retombe à (0) (la cible a quitté la
    // file). Une vue mise en cache à travers le client component aurait laissé le compteur figé.
    await expect(page.getByRole('button', { name: /^À appeler \(0\)/ })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});
