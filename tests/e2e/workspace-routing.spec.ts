import { type Page, expect, test } from '@playwright/test';
import {
  type AdminClient,
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  hasSupabaseAdmin,
  loginViaForm,
  waitForMerchant,
} from './helpers/auth';
import { revealStoreContext } from './helpers/workspace';

// Non-régression du cycle legacy → canonique → rewrite (PHASE1-DIAG-ROUTING).
//
// Rappel du défaut corrigé : AppLayout redirigeait /produits vers
// /s/{storeId}/produits, que le middleware réécrit vers /produits. Sur une
// navigation RSC côté client, le routeur re-parcourait ce cycle indéfiniment :
// boucle de requêtes silencieuse (aucune erreur console) et page blanche
// terminale qui ne se résorbait qu'au rechargement complet.
//
// Ces tests vérifient donc DEUX choses distinctes, et pas seulement la
// visibilité du contenu : le rendu converge, ET le nombre de requêtes RSC
// reste borné une fois la page rendue. Une assertion de visibilité seule
// resterait verte sur une page qui martèle le serveur en arrière-plan.
//
// Note de localisation : le catalogue produits rend la MÊME donnée deux fois
// (carte desktop + ligne mobile), l'une des deux étant masquée selon le
// viewport. Les assertions de PRÉSENCE passent donc par getByRole, qui ne voit
// que la représentation accessible — getByText(...).first() pouvait résoudre la
// jumelle masquée et échouait sur pixel-7/iphone-14. Les assertions d'ABSENCE
// gardent getByText, volontairement plus strict : elles couvrent aussi le DOM
// masqué.

type WorkspaceFixture = {
  admin: AdminClient;
  email: string;
  userId: string;
  merchantAccountId: string;
  stores: Array<{ id: string; displayName: string; isDefault: boolean }>;
  defaultStoreId: string;
  secondStoreId: string | null;
};

const createdUserIds: string[] = [];

async function createWorkspaceFixture(
  label: string,
  options: { extraStore: boolean },
): Promise<WorkspaceFixture> {
  const admin = adminClient();
  const email = e2eEmail(`workspace-routing-${label}`);
  const userId = await createConfirmedUser(admin, email);
  createdUserIds.push(userId);
  const merchantAccountId = await waitForMerchant(admin, userId);

  await admin
    .from('merchant_account')
    .update({ name: `Workspace ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);

  // handle_new_user (migration 0126) provisionne déjà une boutique manuelle par
  // défaut : ajouter une boutique ici suffit à obtenir le workspace
  // multi-boutiques qui déclenchait la boucle.
  if (options.extraStore) {
    const { error } = await admin.from('shop').insert({
      display_name: `Boutique secondaire ${label}`,
      merchant_account_id: merchantAccountId,
      shop_domain: `workspace-routing-${label}-${Date.now()}.myshopify.com`,
      access_token_encrypted: 'e2e-encrypted-token',
      scopes: 'read_orders',
    });
    if (error) throw error;
  }

  const { data: shops, error: shopError } = await admin
    .from('shop')
    .select('id, display_name, is_default, installed_at')
    .eq('merchant_account_id', merchantAccountId)
    .order('is_default', { ascending: false })
    .order('installed_at', { ascending: true });
  if (shopError || !shops) throw shopError ?? new Error('boutiques introuvables');

  const stores = shops.map((shop) => ({
    displayName: shop.display_name as string,
    id: shop.id as string,
    isDefault: shop.is_default as boolean,
  }));
  const defaultStore = stores.find((store) => store.isDefault) ?? stores[0];

  return {
    admin,
    defaultStoreId: defaultStore.id,
    email,
    merchantAccountId,
    secondStoreId: stores.find((store) => store.id !== defaultStore.id)?.id ?? null,
    stores,
    userId,
  };
}

async function seedProduct(
  fixture: WorkspaceFixture,
  shopId: string,
  title: string,
): Promise<void> {
  const { error } = await fixture.admin.from('product').insert({
    is_active: true,
    merchant_account_id: fixture.merchantAccountId,
    shop_id: shopId,
    sku: `WR-${title.replace(/\s+/g, '-')}-${Date.now()}`,
    title,
    unit_cost: 1000,
  });
  if (error) throw error;
}

/** Compte les requêtes RSC (navigations client) émises par la page. */
function countRscRequests(page: Page): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.headers().rsc) count += 1;
  });
  return () => count;
}

/**
 * Preuve d'absence de boucle de navigation.
 *
 * Ce qui distingue une boucle d'un trafic RSC normal n'est PAS un volume brut :
 * en build de production, les liens de navigation déclenchent une rafale de
 * prefetch RSC ponctuelle (4-5 requêtes observées sur iphone-14) parfaitement
 * saine. Le vrai discriminant est la PERSISTANCE — un prefetch retombe, une
 * boucle ne retombe jamais (mesuré en état cassé : 96 requêtes en 18 s, soit
 * ~27 par fenêtre de 5 s, sans fin).
 *
 * On laisse donc d'abord la rafale retomber, puis on mesure une seconde
 * fenêtre qui doit être quasi silencieuse. Le seuil résiduel garde une marge
 * ~5x sous le débit d'une boucle réelle.
 */
async function expectNoRscLoop(page: Page, rscCount: () => number): Promise<void> {
  await page.waitForTimeout(3_000);
  const before = rscCount();
  await page.waitForTimeout(5_000);
  const emitted = rscCount() - before;
  expect(
    emitted,
    `la page a émis ${emitted} requêtes RSC APRÈS retombée du prefetch (boucle de navigation ?)`,
  ).toBeLessThanOrEqual(5);
}

// Premier rendu d'une page applicative après connexion. Marge volontairement
// large : en dev local, la première requête vers une route lourde paie sa
// compilation à la demande (mesuré > 30 s sur /commandes selon l'ordre des
// tests), alors que la CI tourne en build de production. Cette marge ne peut
// pas masquer le défaut corrigé : en état cassé la page ne convergeait JAMAIS
// (35 s mesurées), et la borne de boucle RSC ci-dessous reste inchangée.
const FIRST_RENDER_TIMEOUT = 60_000;

test.skip(!hasSupabaseAdmin, 'Supabase admin indisponible');

test.afterAll(async () => {
  if (!hasSupabaseAdmin || createdUserIds.length === 0) return;
  await cleanupUsers(adminClient(), createdUserIds);
  createdUserIds.length = 0;
});

/**
 * Entre dans une boutique puis exerce l'URL LEGACY.
 *
 * Depuis le sélecteur post-connexion, la connexion d'un utilisateur
 * multi-boutiques passe par `/s` : elle ne rend donc plus directement une route
 * legacy. Ce que ces tests protègent — l'URL legacy est rendue EN PLACE, sans
 * canonicalisation ni boucle RSC — reste inchangé et se vérifie en naviguant vers
 * elle une fois la boutique choisie.
 */
async function enterStoreThenLegacy(
  page: Page,
  email: string,
  storeId: string,
  legacyPath: string,
) {
  await loginViaForm(page, email, e2ePassword, `/s/${storeId}/tableau`);
  await page.waitForURL(`**/s/${storeId}/tableau`, { timeout: FIRST_RENDER_TIMEOUT });
  await page.goto(legacyPath);
}

test.describe('routage workspace legacy et canonique', () => {
  // Budget assumé, PAS un contournement : chaque test enchaîne une connexion
  // réelle, un premier rendu de page applicative, puis une fenêtre
  // d'observation de 5 s indispensable à la détection de boucle RSC. Le défaut
  // corrigé se manifestait par une page qui ne convergeait JAMAIS (35 s
  // mesurées) : allonger le budget ne peut donc pas le masquer.
  test.describe.configure({ timeout: 150_000 });

  // OBLIGATOIRE ici, pas une précaution de confort : en build de production
  // (E2E_PROD_BUILD=1, le mode de la CI) le service worker prend le contrôle de
  // la page quelques centaines de ms après la connexion, et TOUTES les requêtes
  // de la page cessent alors d'être visibles de `page.on('request')`
  // (cf. CLAUDE.md). Le compteur de requêtes RSC tomberait à 0 et
  // `expectNoRscLoop` passerait au vert POUR LA MAUVAISE RAISON — y compris si
  // la boucle était réintroduite. Bloquer le SW est ce qui rend l'assertion
  // réellement probante en CI. Aucun comportement applicatif testé ici n'en
  // dépend : sw.js ne touche jamais ces routes.
  test.use({ serviceWorkers: 'block' });

  test('multi-boutiques : /produits legacy rend en place, sans boucle RSC', async ({ page }) => {
    const fixture = await createWorkspaceFixture('legacy-produits', { extraStore: true });
    expect(fixture.stores.length).toBe(2);
    if (!fixture.secondStoreId) throw new Error('seconde boutique manquante');
    await seedProduct(fixture, fixture.defaultStoreId, 'Produit Boutique Defaut');
    await seedProduct(fixture, fixture.secondStoreId, 'Produit Boutique Secondaire');

    const rscCount = countRscRequests(page);
    await enterStoreThenLegacy(page, fixture.email, fixture.defaultStoreId, '/produits');

    // Le contenu, pas l'URL, est le signal de réussite : le diagnostic a montré
    // qu'une URL correcte pouvait coexister avec un DOM vide.
    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });

    // Option 2 : l'URL legacy est rendue en place, sans canonicalisation.
    expect(new URL(page.url()).pathname).toBe('/produits');

    // Le store actif est résolu côté serveur et le scope des données le suit.
    await expect(page.getByRole('heading', { name: 'Produit Boutique Defaut' })).toBeVisible();
    await expect(page.getByText('Produit Boutique Secondaire')).toHaveCount(0);

    await expectNoRscLoop(page, rscCount);
    // Le shell n'a pas disparu entre-temps (symptôme de la page blanche).
    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toBeVisible();
  });

  test('multi-boutiques : /commandes legacy rend en place, sans page blanche', async ({ page }) => {
    const fixture = await createWorkspaceFixture('legacy-commandes', { extraStore: true });
    expect(fixture.stores.length).toBe(2);

    const rscCount = countRscRequests(page);
    await enterStoreThenLegacy(page, fixture.email, fixture.defaultStoreId, '/commandes');

    await expect(page.getByRole('heading', { level: 1, name: 'Commandes' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });
    expect(new URL(page.url()).pathname).toBe('/commandes');

    await expectNoRscLoop(page, rscCount);
    await expect(page.getByRole('heading', { level: 1, name: 'Commandes' })).toBeVisible();
  });

  test('route canonique /s/{storeId}/produits : rendu et contexte de boutique corrects', async ({
    page,
  }) => {
    const fixture = await createWorkspaceFixture('canonique', { extraStore: true });
    if (!fixture.secondStoreId) throw new Error('seconde boutique manquante');
    await seedProduct(fixture, fixture.defaultStoreId, 'Canonique Defaut');
    await seedProduct(fixture, fixture.secondStoreId, 'Canonique Secondaire');
    const secondStore = fixture.stores.find((store) => store.id === fixture.secondStoreId);
    if (!secondStore) throw new Error('boutique secondaire introuvable');

    const rscCount = countRscRequests(page);
    await loginViaForm(page, fixture.email, e2ePassword, `/s/${fixture.secondStoreId}/produits`);

    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });
    expect(new URL(page.url()).pathname).toBe(`/s/${fixture.secondStoreId}/produits`);

    // Shell Workspace : la boutique demandée est bien la boutique active. Le
    // contexte vit dans la navigation (barre latérale desktop, menu « Plus »
    // mobile) et le composant est monté deux fois : on cible la copie VISIBLE.
    await expect(await revealStoreContext(page)).toHaveText(secondStore.displayName);
    await expect(page.getByRole('heading', { name: 'Canonique Secondaire' })).toBeVisible();
    await expect(page.getByText('Canonique Defaut')).toHaveCount(0);

    await expectNoRscLoop(page, rscCount);
  });

  test('boutique forgée : aucun accès aux données, aucun repli silencieux', async ({ page }) => {
    const fixture = await createWorkspaceFixture('forge', { extraStore: true });
    await seedProduct(fixture, fixture.defaultStoreId, 'Produit Non Divulgable');

    // On se connecte d'abord normalement : la session est valide, seul
    // l'identifiant de boutique demandé ensuite est illégitime. Sans cela, le
    // test pourrait passer pour la mauvaise raison (simple non-authentifié).
    await loginViaForm(page, fixture.email, e2ePassword, `/s/${fixture.defaultStoreId}/produits`);
    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });

    // Identifiant valide en forme mais qui n'appartient à aucune boutique
    // accessible à cet utilisateur.
    const forgedStoreId = '00000000-0000-4000-8000-000000000000';
    const response = await page.goto(`/s/${forgedStoreId}/produits`);

    // Statut explicite, pas seulement une absence de contenu : une page vide
    // servie en 200 serait indistinguable d'un rendu raté.
    expect(response?.status()).toBe(404);

    // La page ne doit jamais rendre le catalogue d'une autre boutique.
    await expect(page.getByText('Produit Non Divulgable')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toHaveCount(0);

    // Et surtout : aucune substitution silencieuse vers la boutique par défaut,
    // qui laisserait croire que la boutique demandée a été ouverte.
    expect(new URL(page.url()).pathname).toBe(`/s/${forgedStoreId}/produits`);
  });

  test('mono-boutique : les routes legacy continuent de fonctionner', async ({ page }) => {
    const fixture = await createWorkspaceFixture('mono', { extraStore: false });
    expect(fixture.stores.length).toBe(1);
    await seedProduct(fixture, fixture.defaultStoreId, 'Produit Mono Boutique');

    const rscCount = countRscRequests(page);
    // Un utilisateur mono-boutique entre automatiquement dans sa boutique, sur la
    // route CANONIQUE. L'URL legacy reste servie en place, ce que vérifie la
    // navigation explicite qui suit.
    await enterStoreThenLegacy(page, fixture.email, fixture.defaultStoreId, '/produits');

    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });
    expect(new URL(page.url()).pathname).toBe('/produits');
    await expect(page.getByRole('heading', { name: 'Produit Mono Boutique' })).toBeVisible();

    await expectNoRscLoop(page, rscCount);
  });

  test('sélecteur de boutique : bascule vers la route canonique et les bonnes données', async ({
    page,
  }) => {
    const fixture = await createWorkspaceFixture('selecteur', { extraStore: true });
    if (!fixture.secondStoreId) throw new Error('seconde boutique manquante');
    await seedProduct(fixture, fixture.defaultStoreId, 'Selecteur Defaut');
    await seedProduct(fixture, fixture.secondStoreId, 'Selecteur Secondaire');
    const secondStore = fixture.stores.find((store) => store.id === fixture.secondStoreId);
    if (!secondStore) throw new Error('boutique secondaire introuvable');

    const rscCount = countRscRequests(page);
    await loginViaForm(page, fixture.email, e2ePassword, `/s/${fixture.defaultStoreId}/produits`);
    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });
    await expect(page.getByRole('heading', { name: 'Selecteur Defaut' })).toBeVisible();

    // Le contrôle de boutique vit désormais DANS la navigation : barre latérale
    // sur desktop, menu « Plus » sur mobile (l'ancienne barre `<details>` en tête
    // de contenu a été retirée).
    await revealStoreContext(page);
    const switcher = page.locator('[data-testid="store-switcher"]:visible').first();
    await switcher.getByRole('button', { name: /Changer/ }).click();
    await switcher.getByRole('menuitem', { name: secondStore.displayName }).click();

    // Changement de comportement VOULU : le changement de boutique préserve la
    // section courante. Avant, il renvoyait systématiquement vers /tableau et
    // faisait perdre la page consultée.
    await page.waitForURL(`**/s/${fixture.secondStoreId}/produits`, {
      timeout: FIRST_RENDER_TIMEOUT,
    });
    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });
    // Données de la nouvelle boutique, sans fuite de l'ancienne.
    await expect(page.getByRole('heading', { name: 'Selecteur Secondaire' })).toBeVisible();
    await expect(page.getByText('Selecteur Defaut')).toHaveCount(0);

    await expectNoRscLoop(page, rscCount);
  });

  // Attribution des ÉCRITURES à la boutique active.
  //
  // Les tables scopées portent un trigger BEFORE INSERT
  // (`assign_default_store_context`) qui renseigne `shop_id` quand l'insertion
  // l'omet — mais toujours avec la boutique PAR DÉFAUT. Un site d'écriture qui
  // se repose dessus produit donc, pour un marchand multi-boutiques, une ligne
  // écrite dans la mauvaise boutique : aucune erreur, aucune alerte, et la
  // donnée devient simplement invisible depuis la boutique où l'utilisateur
  // travaillait.
  //
  // Ce test crée une commande manuelle depuis la boutique SECONDAIRE et vérifie
  // en service-role que la commande, le client créé au passage et les lignes de
  // commande portent tous cette boutique — jamais la boutique par défaut.
  // Il échouerait sur le comportement d'avant l'audit des sites d'écriture.
  test('création manuelle depuis la boutique secondaire : commande, client et lignes suivent la boutique ACTIVE', async ({
    page,
  }) => {
    const fixture = await createWorkspaceFixture('ecriture-active', { extraStore: true });
    if (!fixture.secondStoreId) throw new Error('seconde boutique manquante');
    const activeStoreId = fixture.secondStoreId;
    await seedProduct(fixture, activeStoreId, 'Sac Boutique Active');

    await loginViaForm(page, fixture.email, e2ePassword, `/s/${activeStoreId}/produits`);
    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });

    await page.goto(`/s/${activeStoreId}/commandes`);
    await expect(page.getByRole('heading', { level: 1, name: 'Commandes' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });

    await page.getByRole('button', { name: 'Nouvelle commande', exact: true }).click();
    await page.getByLabel('Nom client').fill('Awa Boutique Active');
    await page.getByLabel('Téléphone').fill('+221 77 444 55 66');
    await page.getByPlaceholder('Rechercher titre ou SKU').fill('Sac Boutique Active');
    // Ciblage par CONTENU, pas par index de <select> : un workspace
    // multi-boutiques peut ajouter un <select> au shell et décaler un `.nth(n)`.
    // La sélection se fait par INDEX D'OPTION car le libellé rendu concatène le
    // titre et le SKU — un `selectOption({ label })` exact ne matcherait pas.
    // Que ce <select> ne contienne QUE ce produit prouve déjà que le catalogue
    // est scopé à la boutique active.
    const productSelect = page
      .locator('select')
      .filter({ has: page.locator('option', { hasText: 'Sac Boutique Active' }) })
      .first();
    await expect(productSelect.locator('option')).toHaveCount(2);
    await productSelect.selectOption({ index: 1 });
    const quantityInput = page.getByLabel('Quantité');
    await quantityInput.press('ControlOrMeta+A');
    await quantityInput.pressSequentially('1');
    await expect(quantityInput).toHaveValue('1');
    const priceInput = page.getByLabel('Prix unitaire (FCFA)');
    await priceInput.press('ControlOrMeta+A');
    await priceInput.pressSequentially('9000');
    await expect(priceInput).toHaveValue('9000');
    await page.getByRole('button', { name: 'Créer la commande' }).click();
    await expect(page.getByText('Commande créée.')).toBeVisible({ timeout: 15_000 });

    const { data: orders, error: orderError } = await fixture.admin
      .from('orders')
      .select('id, shop_id, customer_id')
      .eq('merchant_account_id', fixture.merchantAccountId);
    if (orderError) throw orderError;
    expect(orders).toHaveLength(1);
    const order = orders?.[0];
    if (!order) throw new Error('commande introuvable');

    expect(order.shop_id).toBe(activeStoreId);
    expect(order.shop_id).not.toBe(fixture.defaultStoreId);

    const { data: customers, error: customerError } = await fixture.admin
      .from('customer')
      .select('id, shop_id')
      .eq('merchant_account_id', fixture.merchantAccountId);
    if (customerError) throw customerError;
    expect(customers).toHaveLength(1);
    expect(customers?.[0]?.shop_id).toBe(activeStoreId);

    // Les lignes sont écrites en best-effort après la commande : on laisse la
    // résolution converger avant d'affirmer leur rattachement.
    await expect
      .poll(
        async () => {
          const { data } = await fixture.admin
            .from('order_line')
            .select('shop_id')
            .eq('order_id', order.id);
          return (data ?? []).map((line) => line.shop_id);
        },
        { timeout: 15_000, intervals: [200, 500, 1_000] },
      )
      .toEqual([activeStoreId]);
  });
});
