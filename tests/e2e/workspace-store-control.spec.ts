import { expect, test } from '@playwright/test';
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

/**
 * Trois défauts trouvés au smoke authentifié Phase 1, corrigés ensemble :
 *
 *  1. `/livreurs` affichait le MÊME parc dans les deux boutiques (0133 :
 *     `driver` n'avait aucune notion de boutique) ;
 *  2. « Changer » renvoyait en dur vers `/tableau`, faisant perdre la section ;
 *  3. le contexte de boutique occupait une bande pleine largeur en tête de
 *     contenu au lieu de vivre dans la navigation.
 *
 * S'y ajoute le sélecteur post-connexion : un utilisateur multi-boutiques doit
 * CHOISIR, jamais entrer silencieusement dans sa boutique par défaut.
 */

type Fixture = {
  admin: AdminClient;
  email: string;
  merchantAccountId: string;
  defaultStoreId: string;
  secondStoreId: string;
  defaultStoreName: string;
  secondStoreName: string;
  defaultDriverName: string;
  secondDriverName: string;
};

const createdUserIds: string[] = [];
const FORGED_ORDER_ID = '33333333-3333-4333-8333-333333333333';

async function createDriver(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  fullName: string,
) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      full_name: fullName,
      merchant_account_id: merchantAccountId,
      phone: `+2217${Math.floor(Math.random() * 90000000 + 10000000)}`,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');

  const { error: membershipError } = await admin.from('driver_shop').insert({
    driver_id: data.id as string,
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
  });
  if (membershipError) throw membershipError;
  return data.id as string;
}

async function createFixture(label: string, options: { multiStore: boolean }): Promise<Fixture> {
  const admin = adminClient();
  const email = e2eEmail(`store-control-${label}`);
  const userId = await createConfirmedUser(admin, email);
  createdUserIds.push(userId);
  const merchantAccountId = await waitForMerchant(admin, userId);

  await admin
    .from('merchant_account')
    .update({ name: `Store control ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);

  if (options.multiStore) {
    const { error } = await admin.from('shop').insert({
      access_token_encrypted: 'e2e-encrypted-token',
      display_name: `Boutique Secondaire ${label}`,
      merchant_account_id: merchantAccountId,
      scopes: 'read_orders',
      shop_domain: `store-control-${label}-${Date.now()}.myshopify.com`,
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

  const defaultShop = shops.find((s) => s.is_default) ?? shops[0];
  const secondShop = shops.find((s) => s.id !== defaultShop.id) ?? defaultShop;

  const defaultDriverName = `Livreur Defaut ${label}`;
  const secondDriverName = `Livreur Secondaire ${label}`;
  await createDriver(admin, merchantAccountId, defaultShop.id as string, defaultDriverName);
  if (options.multiStore) {
    await createDriver(admin, merchantAccountId, secondShop.id as string, secondDriverName);
  }

  return {
    admin,
    defaultDriverName,
    defaultStoreId: defaultShop.id as string,
    defaultStoreName: defaultShop.display_name as string,
    email,
    merchantAccountId,
    secondDriverName,
    secondStoreId: secondShop.id as string,
    secondStoreName: secondShop.display_name as string,
  };
}

/**
 * Ouvre le contrôle de boutique là où il est RÉELLEMENT atteignable.
 *
 * Desktop (≥ md = 768 px) : barre latérale. Mobile : le même composant vit dans
 * le menu « Plus » de la navigation basse, la barre latérale étant `hidden`
 * (présente au DOM mais jamais cliquable). Mettre les deux en course rendrait le
 * test dépendant du hasard ; on choisit d'après le viewport Playwright réel.
 */
async function openStoreSwitcher(page: import('@playwright/test').Page) {
  const width = page.viewportSize()?.width ?? 1280;

  if (width < 768) {
    await page.getByRole('button', { name: 'Plus' }).click();
  }

  const switcher = page.locator('[data-testid="store-switcher"]:visible').first();
  await switcher.waitFor({ state: 'visible', timeout: 20_000 });
  await switcher.getByRole('button', { name: /Changer/ }).click();
  return switcher;
}

test.afterAll(async () => {
  if (!hasSupabaseAdmin) return;
  await cleanupUsers(adminClient(), createdUserIds);
  createdUserIds.length = 0;
});

test.describe('Phase 1 — contexte de boutique et isolation des livreurs', () => {
  test.skip(!hasSupabaseAdmin, 'Supabase admin indisponible');

  // Chaque test provisionne un utilisateur, deux boutiques et deux livreurs avant
  // même de se connecter : le budget par défaut de 30 s est consommé par la
  // FIXTURE, pas par le comportement mesuré. On aligne sur les 90 s déjà accordées
  // au profil iphone-14. Aucune assertion n'est relâchée.
  test.describe.configure({ timeout: 90_000 });

  test('un utilisateur multi-boutiques choisit sa boutique après connexion', async ({ page }) => {
    const fixture = await createFixture('chooser', { multiStore: true });
    const deepLink =
      `/commandes/${FORGED_ORDER_ID}?tab=stock&vue=a-appeler` +
      `&shop=${fixture.defaultStoreId}&driver=${FORGED_ORDER_ID}`;
    await loginViaForm(page, fixture.email, e2ePassword, deepLink);

    // Aucune entrée silencieuse dans la boutique par défaut.
    await page.waitForURL(/\/s(\?|$)/, { timeout: 40_000 });
    await expect(page.getByRole('heading', { name: 'Choisissez une boutique' })).toBeVisible();

    const options = page.getByTestId('store-chooser-option');
    await expect(options).toHaveCount(2);
    await expect(page.getByText(fixture.defaultStoreName, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(fixture.secondStoreName, { exact: false }).first()).toBeVisible();
    const expectedQuery = '?tab=stock&vue=a-appeler';
    await expect(options.nth(0)).toHaveAttribute(
      'href',
      `/s/${fixture.defaultStoreId}/commandes${expectedQuery}`,
    );
    await expect(options.nth(1)).toHaveAttribute(
      'href',
      `/s/${fixture.secondStoreId}/commandes${expectedQuery}`,
    );

    // Choix EXPLICITE de la boutique secondaire (donc pas celle par défaut).
    await page.getByRole('link', { name: new RegExp(fixture.secondStoreName) }).click();
    await page.waitForURL(`**/s/${fixture.secondStoreId}/commandes${expectedQuery}`, {
      timeout: 40_000,
    });
    await expect(page.getByRole('heading', { level: 1, name: 'Commandes' })).toBeVisible({
      timeout: 40_000,
    });

    // La boutique choisie apparaît dans la navigation.
    await expect(await revealStoreContext(page)).toContainText(fixture.secondStoreName);

    // F5 : on reste dans la boutique choisie, le sélecteur ne réapparaît pas.
    await page.reload();
    await expect(page).toHaveURL(
      new RegExp(`/s/${fixture.secondStoreId}/commandes\\?tab=stock&vue=a-appeler`),
    );
    await expect(page.getByRole('heading', { name: 'Choisissez une boutique' })).toHaveCount(0);

    // Une nouvelle connexion rouvre toujours le choix, sans boutique active
    // préselectionnée ni réutilisation du choix précédent.
    await page.goto('/parametres');
    await page
      .locator('main#main')
      .getByRole('button', { name: 'Se déconnecter', exact: true })
      .click();
    await page.waitForURL((url) => url.pathname === '/', { timeout: 20_000 });
    await loginViaForm(page, fixture.email, e2ePassword);
    await page.waitForURL(/\/s(\?|$)/, { timeout: 40_000 });
    await expect(page.getByRole('heading', { name: 'Choisissez une boutique' })).toBeVisible();
    await expect(page.locator('[data-testid="store-chooser-option"][aria-current]')).toHaveCount(0);
  });

  test('un utilisateur mono-boutique entre directement, sans voir le sélecteur', async ({
    page,
  }) => {
    const fixture = await createFixture('single', { multiStore: false });
    await loginViaForm(
      page,
      fixture.email,
      e2ePassword,
      `/commandes/${FORGED_ORDER_ID}?tab=stock&vue=a-appeler`,
    );

    await page.waitForURL(
      `**/s/${fixture.defaultStoreId}/commandes/${FORGED_ORDER_ID}?tab=stock&vue=a-appeler`,
      { timeout: 40_000 },
    );
    await expect(page.getByRole('heading', { name: 'Choisissez une boutique' })).toHaveCount(0);
  });

  test('chaque boutique affiche SES livreurs, jamais ceux de l autre', async ({ page }) => {
    const fixture = await createFixture('drivers', { multiStore: true });
    await loginViaForm(page, fixture.email, e2ePassword, `/s/${fixture.defaultStoreId}/livreurs`);
    await expect(page.getByText(fixture.defaultDriverName).first()).toBeVisible({
      timeout: 40_000,
    });
    // Assertion d'ABSENCE volontairement sur getByText : elle couvre aussi le DOM
    // masqué, donc un simple filtrage visuel ne la rendrait pas verte.
    await expect(page.getByText(fixture.secondDriverName)).toHaveCount(0);

    await page.goto(`/s/${fixture.secondStoreId}/livreurs`);
    await expect(page.getByText(fixture.secondDriverName).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(fixture.defaultDriverName)).toHaveCount(0);
  });

  test('changer de boutique depuis Livreurs RESTE sur Livreurs', async ({ page }) => {
    const fixture = await createFixture('route-livreurs', { multiStore: true });
    await loginViaForm(page, fixture.email, e2ePassword, `/s/${fixture.defaultStoreId}/livreurs`);
    await expect(page.getByText(fixture.defaultDriverName).first()).toBeVisible({
      timeout: 40_000,
    });

    const switcher = await openStoreSwitcher(page);
    await switcher.getByRole('menuitem', { name: new RegExp(fixture.secondStoreName) }).click();

    // Le défaut corrigé renvoyait ici vers /tableau.
    await page.waitForURL(`**/s/${fixture.secondStoreId}/livreurs`, { timeout: 40_000 });
    await expect(page.getByText(fixture.secondDriverName).first()).toBeVisible();
    await expect(page.getByText(fixture.defaultDriverName)).toHaveCount(0);
  });

  test('changer de boutique depuis Produits préserve ?tab=stock', async ({ page }) => {
    const fixture = await createFixture('route-tab', { multiStore: true });
    await loginViaForm(
      page,
      fixture.email,
      e2ePassword,
      `/s/${fixture.defaultStoreId}/produits?tab=stock`,
    );
    await expect(page.locator('main#main')).toBeVisible({ timeout: 40_000 });

    const switcher = await openStoreSwitcher(page);
    await switcher.getByRole('menuitem', { name: new RegExp(fixture.secondStoreName) }).click();

    await page.waitForURL(`**/s/${fixture.secondStoreId}/produits?tab=stock`, { timeout: 40_000 });
    expect(new URL(page.url()).searchParams.get('tab')).toBe('stock');
  });

  test('la barre boutique pleine largeur a disparu du contenu', async ({ page }) => {
    const fixture = await createFixture('no-bar', { multiStore: true });
    await loginViaForm(page, fixture.email, e2ePassword, `/s/${fixture.defaultStoreId}/tableau`);
    await expect(page.locator('main#main')).toBeVisible({ timeout: 40_000 });

    // Le contexte de boutique existe, mais PAS dans la zone de contenu.
    await expect(page.getByTestId('store-switcher').first()).toHaveCount(1);
    await expect(page.locator('main#main').getByTestId('store-switcher')).toHaveCount(0);
  });

  test('une boutique forgée est refusée sans repli sur une autre', async ({ page }) => {
    const fixture = await createFixture('forged', { multiStore: true });
    await loginViaForm(page, fixture.email, e2ePassword, `/s/${fixture.defaultStoreId}/tableau`);
    await expect(page.locator('main#main')).toBeVisible({ timeout: 40_000 });

    const response = await page.goto('/s/00000000-0000-0000-0000-000000000000/livreurs');
    expect(response?.status()).toBe(404);
    await expect(page.getByText(fixture.defaultDriverName)).toHaveCount(0);
    await expect(page.getByText(fixture.secondDriverName)).toHaveCount(0);
  });
});
