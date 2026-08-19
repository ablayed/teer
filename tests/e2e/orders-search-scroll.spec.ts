import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { landOnTarget } from './helpers/auth';
import { grantCurrentConsents } from './helpers/consent';
import { defaultShopId } from './helpers/workspace';

// Phase 0c / C1 — la recherche met l'URL à jour en shallow (history.replaceState) : pas de
// navigation, donc pas de scroll-jump, et le refetch serveur (paradigme A) couvre toute la
// période — y compris les commandes au-delà de la première page chargée.

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
  return `e2e+search-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
    .update({ name: `Tëër E2E Search ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, userId };
}

// Phase 1 : les fixtures sèment dans la boutique ACTIVE.
//
// Auparavant ce helper INSÉRAIT une boutique et les commandes y étaient
// rattachées. Depuis 0126 l'organisation possède déjà une boutique par défaut,
// et c'est elle que la session atteint sur une route legacy : semer dans une
// boutique fraîchement créée laissait l'écran vide (compteurs à zéro, lignes
// absentes) sans la moindre erreur. Le paramètre de domaine est conservé pour
// ne pas toucher les appels, mais n'a plus d'effet.
async function seedShopId(
  admin: AdminClient,
  merchantAccountId: string,
  _domain: string,
): Promise<string> {
  return defaultShopId(admin, merchantAccountId);
}

async function seedOrder(
  admin: AdminClient,
  {
    createdAt,
    customerName,
    merchantAccountId,
    shopId,
  }: {
    createdAt: string;
    customerName: string;
    merchantAccountId: string;
    shopId: string;
  },
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
    order_number: `SR-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    total_amount: 12000,
    currency: 'XOF',
    order_state: 'open',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
    created_at: createdAt,
    created_at_shopify: createdAt,
  });
  if (error) throw error;
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await landOnTarget(page, redirectTo);
}

test.describe('Phase 0c — recherche commandes : scroll & couverture serveur', () => {
  test.skip(!hasSupabaseAdmin, 'SUPABASE service role requis pour seeder les fixtures');

  test('le scroll est préservé pendant la recherche (desktop)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'mesure de window.scrollY : desktop only');

    const { admin, email, merchantAccountId } = await createOwnerFixture('scroll');
    const shopId = await seedShopId(admin, merchantAccountId, `sr-${Date.now()}.myshopify.com`);

    // 26 commandes partageant le token « Commun » → une recherche dessus garde la liste
    // pleine (≥ 25 résultats) : seul le scroll-jump pourrait alors déplacer la page.
    for (let index = 0; index < 26; index += 1) {
      await seedOrder(admin, {
        createdAt: new Date(Date.now() - index * 60_000).toISOString(),
        customerName: `Client Commun ${index}`,
        merchantAccountId,
        shopId,
      });
    }

    await signIn(page, email, '/commandes');
    await expect(page.locator('article')).toHaveCount(25);

    // Reproduit le scénario réel : on saisit la recherche (champ en haut, visible — pas de
    // scroll parasite), PUIS on descend immédiatement dans la liste. La mise à jour d'URL
    // debouncée + le refetch serveur tombent ENSUITE, pendant qu'on est descendu. Avec
    // l'ancien `router.replace` (navigation + loading.tsx), le scroll sautait en haut ; avec
    // la synchro shallow (history.replaceState, aucune navigation), il est préservé.
    await page.getByRole('searchbox').fill('Commun');
    await page.mouse.wheel(0, 800);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const before = await page.evaluate(() => window.scrollY);

    await page.waitForURL(/\/commandes\?.*q=commun/i);
    // La liste reste pleine (la recherche matche toutes les commandes) → la hauteur est
    // stable, seule une navigation pourrait alors réinitialiser le scroll.
    await expect(page.locator('article')).toHaveCount(25);
    // Laisse le refetch serveur (et son re-render implicite) se produire pendant qu'on est
    // descendu, puis vérifie l'absence de saut.
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.scrollY);
    expect(Math.abs(after - before)).toBeLessThan(40);
  });

  test('la recherche trouve une commande au-delà de la première page', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'fixture lourde : une seule cible suffit');

    const { admin, email, merchantAccountId } = await createOwnerFixture('beyond');
    const shopId = await seedShopId(admin, merchantAccountId, `sb-${Date.now()}.myshopify.com`);

    // Cible la plus ANCIENNE → triée en dernier (sort_at desc) → page 2 (au-delà des 25).
    await seedOrder(admin, {
      createdAt: new Date(Date.now() - 100 * 60_000).toISOString(),
      customerName: 'Zlatan Cible Unique',
      merchantAccountId,
      shopId,
    });
    for (let index = 0; index < 25; index += 1) {
      await seedOrder(admin, {
        createdAt: new Date(Date.now() - index * 60_000).toISOString(),
        customerName: `Client Liste ${index}`,
        merchantAccountId,
        shopId,
      });
    }

    await signIn(page, email, '/commandes');
    await expect(page.locator('article')).toHaveCount(25);
    // Hors de la page 1 chargée : un filtre en mémoire seul ne la trouverait jamais.
    await expect(page.getByText('Zlatan Cible Unique')).toHaveCount(0);

    await page.getByRole('searchbox').fill('Zlatan');
    await page.waitForURL(/\/commandes\?.*q=zlatan/i);

    // Visible → le refetch serveur (paradigme A) a bien couvert toute la période.
    await expect(page.getByText('Zlatan Cible Unique')).toBeVisible();
  });

  test('cibles tactiles principales ≥ 44px (mobile)', async ({ page }, testInfo) => {
    test.skip(
      !['pixel-7', 'iphone-14'].includes(testInfo.project.name),
      'cibles tactiles : mobile only',
    );

    const { admin, email, merchantAccountId } = await createOwnerFixture('touch');
    const shopId = await seedShopId(admin, merchantAccountId, `st-${Date.now()}.myshopify.com`);
    await seedOrder(admin, {
      createdAt: new Date().toISOString(),
      customerName: 'Client Tactile',
      merchantAccountId,
      shopId,
    });

    await signIn(page, email, '/commandes');

    const searchBox = page.getByRole('searchbox');
    await expect(searchBox).toBeVisible();
    expect((await searchBox.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    const actions = page.getByRole('button', { name: /Actions/i }).first();
    await expect(actions).toBeVisible();
    expect((await actions.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
