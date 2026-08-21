import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { landOnTarget } from './helpers/auth';
import { grantCurrentConsents } from './helpers/consent';
import { defaultShopId } from './helpers/workspace';

// Fix de triage (freeze /commandes à la recherche, cf. CLAUDE.md) : 2 comportements couverts.
// 1) Le chemin de recherche legacy est désormais borné à 12 mois glissants (sort_at) —
//    indépendant du filtre de période UI actif.
// 2) Une réponse de recherche obsolète (résolue après une recherche plus récente) ne doit
//    plus jamais écraser un résultat plus frais (searchRequestGenerationRef,
//    components/orders/orders-workspace.tsx).

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
  return `e2e+search-window-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
    .update({ name: `Tëër E2E Search Window ${label}`, onboarded_at: new Date().toISOString() })
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
    order_number: `SW-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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

test.describe('Fix triage — bornage recherche 12 mois', () => {
  test.skip(!hasSupabaseAdmin, 'SUPABASE service role requis pour seeder les fixtures');

  test('une commande récente est trouvée, une commande de plus de 12 mois ne l’est pas', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'fixture lourde : une seule cible suffit');

    const { admin, email, merchantAccountId } = await createOwnerFixture('bound');
    const shopId = await seedShopId(admin, merchantAccountId, `sw-${Date.now()}.myshopify.com`);

    const thirteenMonthsAgo = new Date();
    thirteenMonthsAgo.setUTCMonth(thirteenMonthsAgo.getUTCMonth() - 13);
    const oneMonthAgo = new Date();
    oneMonthAgo.setUTCMonth(oneMonthAgo.getUTCMonth() - 1);

    await seedOrder(admin, {
      createdAt: thirteenMonthsAgo.toISOString(),
      customerName: 'Vieille Cible Unique',
      merchantAccountId,
      shopId,
    });
    await seedOrder(admin, {
      createdAt: oneMonthAgo.toISOString(),
      customerName: 'Recente Cible Unique',
      merchantAccountId,
      shopId,
    });

    // Filtre de période UI volontairement large (couvre les 2 dates) — la borne 12 mois du fix
    // de triage doit s'appliquer indépendamment de ce filtre, jamais en le remplaçant.
    await signIn(page, email, '/commandes?period=90j');

    await page.getByRole('searchbox').fill('Cible Unique');
    await page.waitForURL(/\/commandes\?.*q=cible/i);
    await page.waitForTimeout(500);

    await expect(page.getByText('Recente Cible Unique')).toBeVisible();
    await expect(page.getByText('Vieille Cible Unique')).toHaveCount(0);
  });
});

test.describe('Fix triage — invalidation des réponses de recherche obsolètes', () => {
  test.skip(!hasSupabaseAdmin, 'SUPABASE service role requis pour seeder les fixtures');

  // Même cause que `orders-hydration-crash-mitigation.spec.ts` : en CI (`E2E_PROD_BUILD=1`),
  // `ServiceWorkerRegister` enregistre `/sw.js`, qui fait `skipWaiting()` + `clients.claim()`.
  // Une fois la page contrôlée par le SW, ses requêtes ne passent plus par `page.route` /
  // `page.on('request')` — le ralentissement et l'abort injectés ici ne s'appliqueraient
  // jamais, et `firstRequestFailed` resterait faux sans que le mécanisme applicatif soit
  // en cause. Le blocage du SW est indispensable pour que ces deux tests observent vraiment
  // le réseau ; il ne change aucun comportement applicatif (`/sw.js` n'intercepte pas /api/**).
  test.use({ serviceWorkers: 'block' });

  test('une réponse de recherche en retard n’écrase pas un résultat plus récent', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'interception réseau : desktop only');

    const { admin, email, merchantAccountId } = await createOwnerFixture('race');
    const shopId = await seedShopId(admin, merchantAccountId, `sr-${Date.now()}.myshopify.com`);

    await seedOrder(admin, {
      createdAt: new Date().toISOString(),
      customerName: 'Premiere Recherche Client',
      merchantAccountId,
      shopId,
    });
    await seedOrder(admin, {
      createdAt: new Date().toISOString(),
      customerName: 'Seconde Recherche Client',
      merchantAccountId,
      shopId,
    });

    await signIn(page, email, '/commandes');

    let firstRequestFailed = false;
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      // 53bd42f (S1C-2) : fetchOrdersSearchPageData envoie `q` dans un corps POST JSON,
      // plus en query-string (minimisation PCD — le terme de recherche ne doit pas
      // transiter par l'URL/logs d'accès).
      const searchQuery = request.postDataJSON()?.q as string | undefined;
      if (url.pathname === '/api/orders/search' && searchQuery === 'Premiere Recherche') {
        firstRequestFailed = true;
      }
    });

    // La seconde génération doit interrompre le fetch, pas seulement ignorer sa réponse.
    await page.route('**/api/orders/search**', async (route) => {
      const searchQuery = route.request().postDataJSON()?.q as string | undefined;
      if (searchQuery === 'Premiere Recherche') {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue().catch(() => undefined);
    });

    const searchBox = page.getByRole('searchbox');
    await searchBox.fill('Premiere Recherche');
    // Laisse le debounce (280ms) déclencher la 1ère requête (délibérément ralentie ci-dessus),
    // puis tape la 2ème recherche avant qu'elle ne résolve.
    await page.waitForTimeout(400);
    await searchBox.fill('');
    await searchBox.fill('Seconde Recherche');

    // La 2ème requête résout et la première est réellement annulée par AbortController.
    await expect(page.getByText('Seconde Recherche Client')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => firstRequestFailed).toBe(true);

    // Laisse le temps à la requête ralentie de résoudre après coup, puis vérifie qu'elle n'a
    // pas écrasé le résultat affiché (pas de retour silencieux à "Premiere Recherche Client").
    await page.waitForTimeout(2000);
    await expect(page.getByText('Seconde Recherche Client')).toBeVisible();
    await expect(page.getByText('Premiere Recherche Client')).toHaveCount(0);
  });

  test('un échec réseau est absorbé et réinitialise explicitement le pending', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'interception réseau : desktop only');

    const { admin, email, merchantAccountId } = await createOwnerFixture('network-failure');
    const shopId = await seedShopId(admin, merchantAccountId, `nf-${Date.now()}.myshopify.com`);
    const customerName = `Reseau Interrompu ${Date.now()}`;

    await seedOrder(admin, {
      createdAt: new Date().toISOString(),
      customerName,
      merchantAccountId,
      shopId,
    });
    await signIn(page, email, '/commandes');

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/api/orders/search**', async (route) => {
      const searchQuery = route.request().postDataJSON()?.q as string | undefined;
      if (searchQuery === customerName) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.getByRole('searchbox').fill(customerName);
    await page.waitForURL(/\/commandes\?.*q=/);

    const results = page.getByTestId('orders-results');
    await expect(results).not.toHaveAttribute('aria-busy', 'true');
    await expect(results).toHaveClass(/opacity-100/);
    await expect(results).not.toHaveClass(/pointer-events-none/);
    expect(pageErrors).toEqual([]);
    await expect(page.getByText(customerName)).toBeVisible();
  });
});

test.describe('RLS — endpoint GET /api/orders/search', () => {
  test.skip(!hasSupabaseAdmin, 'SUPABASE service role requis pour seeder les fixtures');

  test('un marchand ne peut jamais lire le résultat unique d’un autre tenant', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'preuve RLS exécutée une seule fois');

    const tenantA = await createOwnerFixture('endpoint-rls-a');
    const tenantB = await createOwnerFixture('endpoint-rls-b');
    const shopA = await seedShopId(
      tenantA.admin,
      tenantA.merchantAccountId,
      `rls-a-${Date.now()}.myshopify.com`,
    );
    const shopB = await seedShopId(
      tenantB.admin,
      tenantB.merchantAccountId,
      `rls-b-${Date.now()}.myshopify.com`,
    );
    const ownCustomer = `Tenant A Visible ${Date.now()}`;
    const foreignCustomer = `Tenant B Interdit ${Date.now()}`;

    await seedOrder(tenantA.admin, {
      createdAt: new Date().toISOString(),
      customerName: ownCustomer,
      merchantAccountId: tenantA.merchantAccountId,
      shopId: shopA,
    });
    await seedOrder(tenantB.admin, {
      createdAt: new Date().toISOString(),
      customerName: foreignCustomer,
      merchantAccountId: tenantB.merchantAccountId,
      shopId: shopB,
    });
    await signIn(page, tenantA.email, '/commandes');

    const fetchSearch = async (q: string) => {
      const params = new URLSearchParams({
        dateFrom: new Date(Date.now() - 86_400_000).toISOString(),
        dateTo: new Date(Date.now() + 86_400_000).toISOString(),
        q,
        view: 'toutes',
      });
      const response = await page.request.get(`/api/orders/search?${params.toString()}`);
      expect(response.status()).toBe(200);
      return (await response.json()) as {
        orders: Array<{ customer: { full_name: string | null } | null }>;
      };
    };

    const ownResult = await fetchSearch(ownCustomer);
    expect(ownResult.orders.map((order) => order.customer?.full_name)).toContain(ownCustomer);

    const crossTenantAttempt = await fetchSearch(foreignCustomer);
    expect(crossTenantAttempt.orders).toEqual([]);
  });
});
