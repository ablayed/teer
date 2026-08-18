import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { landOnTarget } from './helpers/auth';
import { grantCurrentConsents } from './helpers/consent';
import { defaultShopId } from './helpers/workspace';

// Bundles PR 3 : UI de configuration (onglet Détails, /produits vue Catalogue) — case
// "Pack/bundle", sélection des composants + quantités, sauvegarde. Réutilise les
// contraintes SQL anti-imbrication/anti-auto-référence posées en PR 1 (migration 0107) ;
// ne duplique aucune validation, ne vérifie que le message d'erreur remonté à l'UI.

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

// CI (runner Linux) s'est montré plus lent que la machine locale sur ces tests (3
// timeouts marginaux à 90s observés en CI, verts sur retry) — bornage relevé pour
// couvrir cette marge sans dépendre du retry.
test.setTimeout(120_000);

type AdminClient = SupabaseClient;
type Role = 'agent' | 'manager';

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+bundle-config-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
    .update({ name: `Tëër E2E Bundle Config ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  await createShop(admin, merchantAccountId, `bundle-${label}-${Date.now()}.myshopify.com`);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(
  admin: AdminClient,
  merchantAccountId: string,
  role: Role,
): Promise<{ email: string; userId: string }> {
  const email = e2eEmail(role);
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  return { email, userId };
}

async function createProduct(
  admin: AdminClient,
  merchantAccountId: string,
  title: string,
  isBundle = false,
) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title,
      unit_cost: 1_000,
      is_active: true,
      is_bundle: isBundle,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id as string;
}

async function seedProductStock(
  admin: AdminClient,
  merchantAccountId: string,
  productId: string,
  qtyOnHand: number,
  qtyReserved = 0,
) {
  const { error } = await admin.from('product_stock').insert({
    merchant_account_id: merchantAccountId,
    product_id: productId,
    qty_on_hand: qtyOnHand,
    qty_reserved: qtyReserved,
  });
  if (error) throw error;
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

async function seedDeliveredCollectedOrder(
  admin: AdminClient,
  {
    merchantAccountId,
    productId,
    shopId,
    title,
    totalAmount,
  }: {
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
      source: 'manual',
      order_number: `BUNDLECFG-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
      created_at: timestamp,
      created_at_shopify: timestamp,
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

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  // Timeout généreux : premier compile dev-mode d'une route jamais visitée dans ce run
  // peut dépasser 30s (observé sur /produits, cf. PR 2 bundles).
  await landOnTarget(page, redirectTo, 60_000);
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
}

// page.goto() juste après une mutation (router.refresh()) ou un clic PeriodPicker (nuqs)
// peut être rejeté par Next.js : "Navigation interrupted by another navigation" — une
// navigation client-side interne (refresh RSC, sync d'URL différée) est encore en vol et
// entre en conflit avec le goto explicite. `waitForLoadState('networkidle')` ne suffit
// pas (ce n'est pas une requête réseau qui traîne, mais un routing client). Un simple
// retry du goto absorbe cette course sans avoir à deviner un délai fixe.
async function gotoStable(page: Page, url: string) {
  await expect(async () => {
    await page.goto(url);
  }).toPass({ timeout: 20_000 });
}

// Ouvre le PeriodPicker et sélectionne "30 derniers jours". Auto-réessaie l'ouverture :
// après un page.goto() brut (pas via signIn), le clic sur le déclencheur peut arriver
// avant que l'hydratation React n'ait attaché son onClick (le clic DOM se produit sur le
// HTML SSR, silencieusement absorbé) — cf. gotcha hydratation /commandes documenté dans
// CLAUDE.md. Le retry avec toPass rend l'attente robuste sans deviner un délai fixe.
async function selectPeriod30j(page: Page) {
  const trigger = page.getByRole('button', { name: /Choisir la période/ });
  const preset = page.getByRole('button', {
    name: messages.periodPicker.presets['30j'],
    exact: true,
  });
  await expect(async () => {
    await trigger.click();
    await expect(preset).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await preset.click();
  await expect(page).toHaveURL(/period=30j/);
}

// Table Stock : desktop = `<tr>` (sr-only md:not-sr-only md:table, cf. CLAUDE.md), la
// même ligne accessible sert de source de vérité même sous md (cf. PR 2, bundleRow).
function stockRow(page: Page, title: string): Locator {
  return page.locator('tr', { has: page.getByText(title, { exact: true }) });
}

// Le catalogue reste dans le DOM derrière le panneau (chaque ligne a déjà son propre
// bouton "Enregistrer" pour le coût unitaire) : toute interaction dans le panneau doit
// être scopée à ce testid pour éviter une correspondance multiple ("Enregistrer",
// "Composant" qui matche aussi "Produit composant sélectionné" en sous-chaîne).
function panel(page: Page): Locator {
  return page.getByTestId('product-detail-panel');
}

async function openDetails(page: Page, productId: string, title: string) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Viewport Playwright requis pour ouvrir les détails produit');

  const isDesktop = viewport.width >= 768;
  const productRow = page.getByTestId(
    `${isDesktop ? 'product-catalog-card' : 'product-catalog-row'}-${productId}`,
  );

  // La présence de main#main ne garantit pas que le catalogue client est déjà monté.
  // Attendre d'abord la ligne évite qu'un count() instantané choisisse le contrôle mobile
  // sur Chromium desktop pendant ce bref état intermédiaire.
  await productRow.waitFor({ state: 'visible' });

  if (isDesktop) {
    await productRow.getByRole('button', { name: 'Détails', exact: true }).click();
    return;
  }

  const overflowTrigger = productRow.getByRole('button', {
    name: `Actions — ${title}`,
    exact: true,
  });
  await overflowTrigger.click();
  await page.getByRole('menuitem', { name: 'Détails', exact: true }).click();
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E bundles');

test('configurer un bundle : 2 composants, quantités différentes → composition enregistrée, disponibilité dérivée à jour', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('save');
  try {
    const support = await createProduct(
      fixture.admin,
      fixture.merchantAccountId,
      'Support Cfg E2E',
    );
    const cable = await createProduct(fixture.admin, fixture.merchantAccountId, 'Câble Cfg E2E');
    const bundleProductTitle = 'Kit Cfg E2E';
    const bundleId = await createProduct(
      fixture.admin,
      fixture.merchantAccountId,
      bundleProductTitle,
    );

    // Support/2 requis, 10 en stock → 5 assemblables. Câble/1 requis, 3 en stock →
    // 3 assemblables. Le plus restrictif (Câble) doit s'afficher après sauvegarde : 3.
    await seedProductStock(fixture.admin, fixture.merchantAccountId, support, 10);
    await seedProductStock(fixture.admin, fixture.merchantAccountId, cable, 3);

    await signIn(page, fixture.email, '/produits');
    await openDetails(page, bundleId, bundleProductTitle);
    const detailPanel = panel(page);

    await detailPanel.getByRole('checkbox', { name: 'Pack/bundle' }).check();

    await detailPanel.getByRole('button', { name: 'Ajouter un composant' }).click();
    await detailPanel.getByLabel('Composant', { exact: true }).first().fill('Support Cfg E2E');
    await detailPanel
      .getByLabel('Produit composant sélectionné')
      .first()
      .selectOption({ label: 'Support Cfg E2E' });
    await expect(detailPanel.getByLabel('Produit composant sélectionné').first()).toHaveValue(
      support,
    );
    await detailPanel.getByLabel('Quantité requise').first().fill('2');
    await expect(detailPanel.getByLabel('Quantité requise').first()).toHaveValue('2');

    await detailPanel.getByRole('button', { name: 'Ajouter un composant' }).click();
    await detailPanel.getByLabel('Composant', { exact: true }).nth(1).fill('Câble Cfg E2E');
    await detailPanel
      .getByLabel('Produit composant sélectionné')
      .nth(1)
      .selectOption({ label: 'Câble Cfg E2E' });
    await expect(detailPanel.getByLabel('Produit composant sélectionné').nth(1)).toHaveValue(cable);
    await detailPanel.getByLabel('Quantité requise').nth(1).fill('1');
    await expect(detailPanel.getByLabel('Quantité requise').nth(1)).toHaveValue('1');

    await detailPanel.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(detailPanel.getByText('Configuration enregistrée.')).toBeVisible({
      timeout: 15_000,
    });

    // Vérification directe DB avant de recharger la page — isole un bug de sauvegarde
    // (composition non persistée) d'un bug de lecture (resolveBundleAvailabilities).
    await expect
      .poll(
        async () => {
          const { data } = await fixture.admin
            .from('product_bundle_component')
            .select('component_product_id, quantity')
            .eq('bundle_product_id', bundleId);
          return data?.length ?? 0;
        },
        { timeout: 10_000 },
      )
      .toBe(2);

    // saveBundleConfigurationAction déclenche un router.refresh() côté client après
    // succès : gotoStable absorbe la course avec cette navigation encore en vol.
    await gotoStable(page, '/produits?tab=stock');
    const row = stockRow(page, bundleProductTitle);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('3');
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('sélectionner un composant déjà promu bundle entre le chargement et la sauvegarde → rejeté avec message clair', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('component-race');
  try {
    const other = await createProduct(fixture.admin, fixture.merchantAccountId, 'Autre Cfg E2E');
    const bundleProductTitle = 'Kit Race E2E';
    const bundleId = await createProduct(
      fixture.admin,
      fixture.merchantAccountId,
      bundleProductTitle,
    );

    await signIn(page, fixture.email, '/produits');
    await openDetails(page, bundleId, bundleProductTitle);
    const detailPanel = panel(page);

    await detailPanel.getByRole('checkbox', { name: 'Pack/bundle' }).check();
    await detailPanel.getByRole('button', { name: 'Ajouter un composant' }).click();
    await detailPanel.getByLabel('Composant', { exact: true }).first().fill('Autre Cfg E2E');
    await detailPanel
      .getByLabel('Produit composant sélectionné')
      .first()
      .selectOption({ label: 'Autre Cfg E2E' });
    await detailPanel.getByLabel('Quantité requise').first().fill('1');

    // Course simulée : un autre utilisateur/onglet promeut "Autre Cfg E2E" en bundle
    // PENDANT que ce panneau reste ouvert avec la sélection déjà faite côté client.
    // La contrainte SQL (trigger assert_bundle_component_integrity, migration 0107)
    // doit rejeter l'insertion au moment de "Enregistrer", pas avant.
    await fixture.admin.from('product').update({ is_bundle: true }).eq('id', other);

    await detailPanel.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(
      detailPanel.getByText(
        'Ce produit est déjà un bundle, il ne peut pas être ajouté comme composant.',
      ),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('un produit ne peut jamais se sélectionner lui-même comme composant (filtré par construction)', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('self-ref');
  try {
    const bundleProductTitle = 'Kit Self E2E';
    const bundleId = await createProduct(
      fixture.admin,
      fixture.merchantAccountId,
      bundleProductTitle,
    );

    await signIn(page, fixture.email, '/produits');
    await openDetails(page, bundleId, bundleProductTitle);
    const detailPanel = panel(page);
    await detailPanel.getByRole('checkbox', { name: 'Pack/bundle' }).check();
    await detailPanel.getByRole('button', { name: 'Ajouter un composant' }).click();

    // Le produit courant est retiré des candidats côté client (confort UX, la
    // contrainte SQL product_bundle_component_no_self_reference reste la source de
    // vérité en cas de contournement) : il ne doit apparaître dans AUCUNE <option>.
    const options = detailPanel
      .getByLabel('Produit composant sélectionné')
      .first()
      .locator('option');
    await expect(options.filter({ hasText: bundleProductTitle })).toHaveCount(0);
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('décocher un bundle déjà vendu : autorisé sans blocage, historique des ventes inchangé', async ({
  page,
}) => {
  // Ce test visite /tableau ET /produits deux fois chacun (avant/après décochage) —
  // budget par défaut (90s) trop juste en dev-mode avec compile à froid sur les deux
  // routes (observé ~1.2-1.5 min sur les deux runs précédents).
  test.setTimeout(180_000);
  const fixture = await createOwnerFixture('uncheck-history');
  try {
    const shopId = await defaultShopId(fixture.admin, fixture.merchantAccountId);
    const bundleProductTitle = 'Kit Vendu E2E';
    const bundle = await createProduct(
      fixture.admin,
      fixture.merchantAccountId,
      bundleProductTitle,
      true,
    );

    await seedDeliveredCollectedOrder(fixture.admin, {
      merchantAccountId: fixture.merchantAccountId,
      productId: bundle,
      shopId,
      title: bundleProductTitle,
      totalAmount: 15_000,
    });

    await signIn(page, fixture.email, '/tableau');
    await selectPeriod30j(page);
    const chartBefore = page.getByTestId('tableau-cash-by-product-chart');
    await expect(chartBefore).toContainText(/Kit Vendu/);
    const chartTextBefore = await chartBefore.innerText();

    // Décochage — décision produit validée (PR 3) : autorisé sans blocage, malgré
    // l'historique de vente existant sur ce bundle. gotoStable absorbe la navigation
    // nuqs encore en vol suite à selectPeriod30j.
    await gotoStable(page, '/produits');
    await openDetails(page, bundle, bundleProductTitle);
    const detailPanel = panel(page);
    const checkbox = detailPanel.getByRole('checkbox', { name: 'Pack/bundle' });
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await detailPanel.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(detailPanel.getByText('Configuration enregistrée.')).toBeVisible({
      timeout: 15_000,
    });

    // L'historique (rapport CA par produit /tableau) reste strictement inchangé —
    // aucune réécriture rétroactive d'une commande déjà résolue.
    await gotoStable(page, '/tableau');
    await selectPeriod30j(page);
    const chartAfter = page.getByTestId('tableau-cash-by-product-chart');
    await expect(chartAfter).toContainText(/Kit Vendu/);
    // Comparaison stricte au texte capturé AVANT le décochage : preuve que le rendu du
    // rapport historique n'a pas bougé d'un caractère (pas seulement "contient 15000",
    // qui serait fragile face au format abrégé du graphe, ex. "15 k F").
    await expect(async () => {
      expect(await chartAfter.innerText()).toBe(chartTextBefore);
    }).toPass({ timeout: 15_000 });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('RBAC : un agent ne voit aucune affordance de configuration bundle sur /produits', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('rbac-agent');
  let agentUserId: string | null = null;
  try {
    const productTitle = 'Produit RBAC E2E';
    await createProduct(fixture.admin, fixture.merchantAccountId, productTitle);
    const agent = await addMember(fixture.admin, fixture.merchantAccountId, 'agent');
    agentUserId = agent.userId;

    await signIn(page, agent.email, '/produits');
    // Le titre existe 2x dans le DOM (carte desktop hidden md:grid + ligne mobile
    // md:hidden) : seul un des deux est réellement visible selon le viewport — filtrer
    // sur :visible évite de cibler l'exemplaire caché (cf. stockRow/pattern du fichier).
    await expect(page.locator(':visible', { hasText: productTitle }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Ni bouton desktop, ni item de menu overflow mobile "Détails" — cohérent avec
    // le masquage déjà en place pour le coût unitaire ("masqué pour ce rôle").
    await expect(page.getByRole('button', { name: 'Détails' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Détails' })).toHaveCount(0);
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
    if (agentUserId) await fixture.admin.auth.admin.deleteUser(agentUserId);
  }
});
