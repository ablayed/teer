/**
 * Vérification manuelle Phase 9 — /commandes en pagination keyset (PROD BUILD).
 *
 * `app/(app)/commandes/page.tsx` a été reconstruit (couche présentation perdue
 * pendant la renormalisation CRLF). La logique critique (RPC 0045,
 * getOrdersPageData, recherche SN, compteurs) est intacte et prouvée
 * byte-identique. Ce spec valide le CÂBLAGE de la page reconstruite, que les
 * tests unit/RLS ne couvrent pas finement :
 *   - les 8 chips affichent les bons compteurs (seed déterministe) ;
 *   - l'ordre d'affichage (DESC sort_at, plus récent en tête) ;
 *   - le « Voir plus » charge la page suivante (25/page) ;
 *   - la recherche (nom / produit / téléphone SN) filtre par vue ;
 *   - les empty-states (recherche sans résultat).
 *
 * PROD BUILD obligatoire (cf. issue #3 Router Cache : le dev ne reproduit pas
 * le cache client). Lancer :
 *   1. supabase start
 *   2. set -a; . ./.env.test; set +a       # NEXT_PUBLIC_* → Supabase local
 *   3. pnpm build && PORT=3000 pnpm exec next start
 *   4. E2E_PROD_BUILD=1 pnpm exec playwright test \
 *        tests/e2e/orders-pagination-verify.spec.ts --project=chromium
 */
import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { grantCurrentConsents } from './helpers/consent';

function readLocalEnv(): Record<string, string> {
  if (!existsSync('.env.test')) {
    return {};
  }

  return Object.fromEntries(
    readFileSync('.env.test', 'utf8')
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

function adminClient() {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await expect(page.locator('main#main')).toBeVisible({ timeout: 15_000 });
}

type OrderSeed = {
  assigned_driver_id?: string | null;
  call_state: string;
  cash_state: string;
  customer_id: string;
  delivery_state: string;
  index: number;
  items_summary: { price: number; quantity: number; title: string }[];
  order_state: string;
  scheduled_for: string | null;
};

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes');
test.skip(
  !isProdBuildRun,
  'Vérification PROD-ONLY : nécessite next build && next start + E2E_PROD_BUILD=1.',
);

test('Phase 9 — /commandes : compteurs, ordre, recherche, « Voir plus » (build prod)', async ({
  page,
}) => {
  const admin = adminClient();
  const email = `e2e+pagination-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  for (let i = 0; i < 40; i++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .maybeSingle();

    if (data) {
      merchantAccountId = data.id;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await admin
    .from('merchant_account')
    .update({ name: 'Tëër E2E pagination', onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);

  // Client spécial recherchable (nom + téléphone SN) + client générique pour le volume.
  const { data: special, error: specialError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Alpha Ndiaye',
      phone: '+221771234567',
    })
    .select('id')
    .single();
  const { data: generic, error: genericError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Client Generic',
      phone: '+221770000000',
    })
    .select('id')
    .single();

  if (specialError || !special || genericError || !generic) {
    throw specialError ?? genericError ?? new Error('Clients seed non créés');
  }

  const today = new Date();
  today.setUTCHours(12, 0, 0, 0); // 12:00 UTC ≡ 12:00 Africa/Dakar (UTC+0)
  const todayIso = today.toISOString();
  const base = Date.parse('2026-06-09T12:00:00.000Z');

  // Contrainte 0057 : les commandes assigned/out_for_delivery exigent un livreur.
  const { data: seedDriver, error: seedDriverError } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Livreur Verif',
      phone: '+221770000002',
    })
    .select('id')
    .single();
  if (seedDriverError || !seedDriver) {
    throw seedDriverError ?? new Error('Livreur seed non créé');
  }
  const seedDriverId = seedDriver.id as string;

  const seeds: OrderSeed[] = [];
  const push = (s: Omit<OrderSeed, 'index' | 'customer_id' | 'items_summary'>) => {
    const index = seeds.length;
    const isSpecial = index === 0;
    seeds.push({
      ...s,
      index,
      customer_id: isSpecial ? special.id : generic.id,
      items_summary: [
        {
          title: isSpecial ? 'Sac Rare Alpha' : 'Produit Standard',
          quantity: 1,
          price: 10000,
        },
      ],
    });
  };

  // 30 × à appeler (index 0 = le client spécial, le plus récent)
  for (let i = 0; i < 30; i++) {
    push({
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      scheduled_for: null,
    });
  }
  // 2 × tentée / à rappeler
  for (let i = 0; i < 2; i++) {
    push({
      order_state: 'open',
      call_state: 'callback',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      scheduled_for: null,
    });
  }
  // 3 × confirmée (validated + delivery unassigned → pas a-livrer)
  for (let i = 0; i < 3; i++) {
    push({
      order_state: 'open',
      call_state: 'validated',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      scheduled_for: null,
    });
  }
  // 2 × à livrer aujourd'hui (assigned + scheduled today → pas confirmée)
  for (let i = 0; i < 2; i++) {
    push({
      order_state: 'open',
      call_state: 'validated',
      delivery_state: 'assigned',
      cash_state: 'not_due',
      scheduled_for: todayIso,
      assigned_driver_id: seedDriverId,
    });
  }
  // 2 × cash à remettre (completed/delivered/collected)
  for (let i = 0; i < 2; i++) {
    push({
      order_state: 'completed',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
      scheduled_for: null,
    });
  }
  // 2 × annulées
  for (let i = 0; i < 2; i++) {
    push({
      order_state: 'cancelled',
      call_state: 'validated',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      scheduled_for: null,
    });
  }
  // 2 × retours
  for (let i = 0; i < 2; i++) {
    push({
      order_state: 'returned',
      call_state: 'validated',
      delivery_state: 'failed',
      cash_state: 'not_due',
      scheduled_for: null,
    });
  }

  const rows = seeds.map((s) => ({
    merchant_account_id: merchantAccountId,
    customer_id: s.customer_id,
    order_number: `VERIF-${String(s.index).padStart(3, '0')}`,
    total_amount: 10000,
    currency: 'XOF',
    items_summary: s.items_summary,
    order_state: s.order_state,
    call_state: s.call_state,
    delivery_state: s.delivery_state,
    cash_state: s.cash_state,
    scheduled_for: s.scheduled_for,
    assigned_driver_id: s.assigned_driver_id ?? null,
    created_at_shopify: new Date(base - s.index * 60_000).toISOString(),
  }));

  const { error: insertError } = await admin.from('orders').insert(rows);

  if (insertError) {
    throw insertError;
  }

  try {
    await signIn(page, email, '/commandes');

    // 1) Les 7 chips affichent les bons compteurs.
    await expect(page.getByRole('button', { name: /^Toutes \(43\)$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^À appeler \(30\)$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Tentée \/ À rappeler \(2\)$/ })).toBeVisible();
    // « Programmer » garde l'id confirmee (open ∧ validated ∧ delivery ∈ {unassigned,scheduled}).
    await expect(page.getByRole('button', { name: /^Programmer \(3\)$/ })).toBeVisible();
    // delivery ∈ {scheduled,assigned,out_for_delivery} → les 2 commandes assignées.
    await expect(page.getByRole('button', { name: /^En cours de livraison \(2\)$/ })).toBeVisible();
    // order_state=completed → les 2 commandes livrées/encaissées.
    await expect(page.getByRole('button', { name: /^Validé \(2\)$/ })).toBeVisible();
    // order_state ∈ {cancelled,returned} → 2 annulées + 2 retours.
    await expect(page.getByRole('button', { name: /^Annulées \/ Retours \(4\)$/ })).toBeVisible();

    // 2) Page 1 = 25 cartes, ordre DESC (la plus récente VERIF-000 en tête).
    await expect(page.locator('article')).toHaveCount(25);
    await expect(page.locator('article').first()).toContainText('VERIF-000');
    await expect(page.getByRole('heading', { name: "Aujourd'hui" })).toHaveCount(1);

    // 3) « Voir plus » charge la page suivante → 43 cartes, bouton disparaît.
    await page.getByRole('button', { name: 'Voir plus' }).click();
    await expect(page.locator('article')).toHaveCount(43);
    await expect(page.getByRole('button', { name: 'Voir plus' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: "Aujourd'hui" })).toHaveCount(1);

    // 4) Recherche par nom + produit (« alpha ») → la seule commande spéciale.
    // Le filtrage local réagit avant la navigation, puis l'URL debouncée rattrape
    // l'état courant et le serveur recharge le dataset global correspondant.
    const searchBox = page.getByPlaceholder('Nom, telephone ou produit');
    await searchBox.fill('alpha');
    await page.waitForURL(/[?&]q=alpha/);
    await expect(page.locator('article')).toHaveCount(1);
    await expect(page.locator('article').first()).toContainText('VERIF-000');

    // 5) Recherche par téléphone SN (national) → même résultat.
    await searchBox.fill('771234567');
    await page.waitForURL(/[?&]q=771234567/);
    await expect(page.locator('article')).toHaveCount(1);
    await expect(page.locator('article').first()).toContainText('Alpha Ndiaye');

    // 6) Recherche sans résultat → empty-state.
    await searchBox.fill('zzznomatch');
    await page.waitForURL(/[?&]q=zzznomatch/);
    await expect(page.getByText('Aucune commande pour "zzznomatch"')).toBeVisible();
    await expect(page.locator('article')).toHaveCount(0);

    // 7) Vue « À appeler » : 30 → « Voir plus » → 30 cartes.
    await searchBox.fill('');
    await page.getByRole('button', { name: /^À appeler \(30\)$/ }).click();
    await page.waitForURL(/vue=a-appeler/);
    await expect(page.locator('article')).toHaveCount(25);
    await page.getByRole('button', { name: 'Voir plus' }).click();
    await expect(page.locator('article')).toHaveCount(30);

    // Feedback pending intra-page : retard volontaire sur la navigation pour
    // vérifier que l'onglet actif + l'état busy apparaissent avant le rerender.
    await page.route('**/commandes**', async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has('vue')) {
        await route.continue();
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });

    const deliveryViewButton = page.getByRole('button', { name: /^En cours de livraison \(2\)$/ });
    await deliveryViewButton.click();

    await expect(deliveryViewButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('orders-results')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('article').first()).toContainText('VERIF-000');

    await page.waitForURL(/vue=en-livraison/);
    await expect(page.locator('article')).toHaveCount(2);
    await expect(page.locator('article').first()).toContainText('VERIF-035');
    await expect(page.getByTestId('orders-results')).not.toHaveAttribute('aria-busy', 'true');
  } finally {
    await admin.auth.admin.deleteUser(userId);
  }
});
