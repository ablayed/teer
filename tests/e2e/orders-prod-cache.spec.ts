/**
 * Non-régression issue #3 — commande manuelle invisible après création (PROD-ONLY).
 *
 * ⚠️ Ce bug ne se reproduit QUE sur un build de production (`next build && next start`),
 * jamais en `next dev`. Symptôme : en créant depuis une vue filtrée, la commande tout
 * juste créée restait invisible (la vue filtrée périmée restait affichée).
 *
 * Historique : un 1er correctif client (router.refresh() AVANT router.replace()) a été
 * remplacé car il restait racy en build de prod — trois navigations concurrentes (le
 * refresh implicite de revalidatePath + router.refresh() + router.replace()), élargies
 * par le router.replace du debounce de recherche → ~20 % d'échec sur chromium.
 * Correctif actuel : redirection 100 % SERVEUR dans createManualOrderAction
 * (redirect '/commandes?created=1', RedirectType.replace) — UNE seule navigation
 * déterministe vers « Toutes » fraîche ; la bannière de succès est rendue via ?created=1.
 *
 * Conséquence pour la CI : le webServer Playwright tourne en `pnpm dev` (cf.
 * playwright.config.ts). Lancé contre le dev, CE TEST SERAIT VERT MÊME SUR LE CODE BUGUÉ
 * — il ne prouverait rien. Il est donc volontairement SKIPPÉ sauf si `E2E_PROD_BUILD=1`,
 * drapeau qu'on ne pose qu'en visant un vrai `next start`.
 *
 * Pour l'exécuter (reproduit le bug sur l'ancien code, vert sur le correctif) :
 *   1. supabase start           # stack locale (migrations à jour)
 *   2. set -a; . ./.env.test; set +a   # NEXT_PUBLIC_* inliné au build → Supabase local
 *   3. pnpm build && PORT=3000 pnpm exec next start   # build de PROD
 *   4. E2E_PROD_BUILD=1 pnpm exec playwright test tests/e2e/orders-prod-cache.spec.ts \
 *        --project=pixel-7
 */
import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { grantCurrentConsents } from './helpers/consent';
import { defaultShopId } from './helpers/workspace';

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
const isProdBuildRun = process.env.E2E_PROD_BUILD === '1';
const password = 'Mot-de-passe-e2e-2026!';

test.setTimeout(60_000);

function adminClient() {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await expect(page.getByRole('heading', { name: 'Commandes' })).toBeVisible();
}

async function selectDeliveryView(page: Page) {
  const deliveryView = page.getByRole('button', { name: /^En cours de livraison \(/ });

  await expect(async () => {
    await deliveryView.click();
    await expect(page).toHaveURL(/\/commandes\?(?=[^#]*\bvue=en-livraison(?:&|$))/u, {
      timeout: 1_500,
    });
  }).toPass({ intervals: [250, 500, 1_000], timeout: 10_000 });

  await expect(page.getByRole('button', { name: /^En cours de livraison \(0\)$/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.locator('[data-testid="order-row-title"]:visible', { hasText: 'Client Seed' }),
  ).toHaveCount(0);
  await expect(page.locator('article')).toHaveCount(0);
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E commandes');
test.skip(
  !isProdBuildRun,
  'Régression Router Cache PROD-ONLY : nécessite next build && next start + E2E_PROD_BUILD=1 ' +
    '(vert à tort en pnpm dev). Voir l’en-tête du fichier.',
);

test('issue #3 — commande créée depuis une vue filtrée visible dans Toutes (build prod)', async ({
  page,
}) => {
  const admin = adminClient();
  const email = `e2e+prodcache-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError || !created.user) {
    throw createError ?? new Error('Utilisateur E2E non créé');
  }

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
    .update({ name: 'Tëër E2E prod-cache', onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  await admin.from('product').insert({
    merchant_account_id: merchantAccountId,
    title: 'Sac Prod Cache',
    unit_cost: 0,
    is_active: true,
  });
  // Phase 1 : semer dans la boutique ACTIVE (celle que la session atteint
  // sur une route legacy). Une boutique créée à part laisserait l'écran vide.
  const shop = { id: await defaultShopId(admin, merchantAccountId) };

  // Une commande pré-existante : la vue « Toutes » initiale (donc l'entrée mise en cache)
  // n'est PAS vide — on prouve que c'est bien la fraîcheur du cache, pas un rendu vide.
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Client Seed',
      phone: '+221770000001',
    })
    .select('id')
    .single();

  if (customerError || !customer) {
    throw customerError ?? new Error('Client seed non créé');
  }

  await admin.from('orders').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shop.id,
    source: 'manual',
    customer_id: customer.id,
    order_number: `SEED-${Date.now()}`,
    total_amount: 9999,
    currency: 'XOF',
    order_state: 'open',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
    items_summary: [{ title: 'Seed', quantity: 1, price: 9999 }],
    created_at_shopify: new Date().toISOString(),
  });

  try {
    await signIn(page, email, '/commandes');
    // « /commandes » nu est rendu (Client Seed visible) puis mis en Router Cache.
    await expect(
      page.locator('[data-testid="order-row-title"]:visible', { hasText: 'Client Seed' }).first(),
    ).toBeVisible();

    // On part vers une vue filtrée : l'entrée « /commandes » nu reste en cache, périmée.
    await selectDeliveryView(page);

    // Création manuelle DEPUIS la vue filtrée (déclencheur exact de l'issue #3).
    await page.getByRole('button', { name: 'Nouvelle commande', exact: true }).click();
    await page.getByLabel('Nom client').fill('Awa Vue Filtree');
    await page.getByLabel('Téléphone').fill('+221 77 111 22 33');
    await page.getByPlaceholder('Rechercher titre ou SKU').fill('Sac Prod Cache');
    await page.locator('select').nth(1).selectOption({ label: 'Sac Prod Cache' });
    const quantityInput = page.getByLabel('Quantité');
    await quantityInput.press('ControlOrMeta+A');
    await quantityInput.pressSequentially('1');
    await expect(quantityInput).toHaveValue('1');
    const priceInput = page.getByLabel('Prix unitaire (FCFA)');
    await priceInput.press('ControlOrMeta+A');
    await priceInput.pressSequentially('14500');
    await expect(priceInput).toHaveValue('14500');
    await page.getByRole('button', { name: 'Créer la commande' }).click();

    // Le correctif (Paradigm A, PR #17) : après création, NewOrderForm notifie
    // OrdersWorkspace qui relit getOrdersPageData(vue=toutes) côté serveur et réinjecte
    // la liste FRAÎCHE dans son state — sans navigation ni router.refresh(). La bannière
    // de succès et la bascule sur « Toutes » sont pilotées par le state client, donc
    // indépendantes du Router Cache / RSC périmé (cause des ~20 % d'invisibilité).
    await expect(page.getByText('Commande créée.')).toBeVisible({ timeout: 10_000 });

    // Vue « Toutes » fraîche : la commande tout juste créée est visible ET le compteur
    // « Toutes » passe à (2). Sur le bug, la vue filtrée périmée restait affichée → la
    // commande restait invisible et le compteur figé à (1).
    await expect(page.getByRole('button', { name: /^Toutes \(2\)$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText('Awa Vue Filtree')).toBeVisible({ timeout: 6_000 });
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});
