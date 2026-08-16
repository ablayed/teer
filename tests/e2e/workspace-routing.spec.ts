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
 * Preuve d'absence de boucle : une page stabilisée ne doit plus générer de
 * requêtes RSC. En état cassé, la boucle en produisait ~5 par seconde.
 */
async function expectNoRscLoop(page: Page, rscCount: () => number): Promise<void> {
  const before = rscCount();
  await page.waitForTimeout(5_000);
  const emitted = rscCount() - before;
  expect(
    emitted,
    `la page a émis ${emitted} requêtes RSC après stabilisation (boucle de navigation ?)`,
  ).toBeLessThanOrEqual(3);
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
    await loginViaForm(page, fixture.email, e2ePassword, '/produits');

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
    await loginViaForm(page, fixture.email, e2ePassword, '/commandes');

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

    // Shell Workspace : la boutique demandée est bien la boutique active.
    await expect(page.getByText(secondStore.displayName).first()).toBeVisible();
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
    await loginViaForm(page, fixture.email, e2ePassword, '/produits');
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
    await loginViaForm(page, fixture.email, e2ePassword, '/produits');

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
    await loginViaForm(page, fixture.email, e2ePassword, '/produits');
    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });
    await expect(page.getByRole('heading', { name: 'Selecteur Defaut' })).toBeVisible();

    await page.getByRole('group').filter({ hasText: 'Changer' }).first().click();
    await page.getByRole('link', { name: secondStore.displayName }).first().click();

    await page.waitForURL(`**/s/${fixture.secondStoreId}/tableau`, {
      timeout: FIRST_RENDER_TIMEOUT,
    });
    await expect(page.getByText(secondStore.displayName).first()).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });

    await page.goto(`/s/${fixture.secondStoreId}/produits`);
    await expect(page.getByRole('heading', { level: 1, name: 'Produits' })).toBeVisible({
      timeout: FIRST_RENDER_TIMEOUT,
    });
    // Données de la nouvelle boutique, sans fuite de l'ancienne.
    await expect(page.getByRole('heading', { name: 'Selecteur Secondaire' })).toBeVisible();
    await expect(page.getByText('Selecteur Defaut')).toHaveCount(0);

    await expectNoRscLoop(page, rscCount);
  });
});
