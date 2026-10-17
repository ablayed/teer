import { type Page, expect, test } from '@playwright/test';
import { hasSupabaseAdmin } from './helpers/auth';
import {
  cleanupVisualFixture,
  createCustomer,
  createOrder,
  createVisualFixture,
  signInToRoute,
} from './helpers/visual-fixtures';

/**
 * V10 — sur une carte de commande, seul le titre menait à la fiche : le statut et le montant,
 * hors du lien, ne faisaient rien, sans aucun retour. `fullSurfaceLink` étend la zone du MÊME vrai
 * lien natif à toute la carte ; seul le bouton « ⋯ » reste au-dessus, hors de la zone du lien.
 *
 * Les gestes sont de vrais appuis aux coordonnées de chaque zone (le pseudo-élément du lien n'a
 * pas de nœud à cliquer), jamais un `click()` sur le nœud : c'est l'ajustement tactile et le
 * test de collision du navigateur qui décident, comme sous le doigt.
 */

type Zone = 'titre' | 'statut' | 'montant' | 'marge';

async function seedOneOrder(label: string) {
  const fixture = await createVisualFixture(label);
  const customerId = await createCustomer(fixture, {
    address1: 'Rue de test 1',
    fullName: 'Fatou Diallo E2E',
    phone: '+221700000000',
  });
  const now = new Date().toISOString();
  const orderId = await createOrder(fixture, {
    address1: 'Rue de test 1',
    createdAt: now,
    customerId,
    itemsSummary: [{ price: 12_500, quantity: 1, title: 'Article E2E' }],
    orderNumber: `E2E-${Date.now()}`,
    status: 'A_APPELER',
    totalAmount: 12_500,
  });
  return { fixture, orderId };
}

function carte(page: Page) {
  return page
    .locator('article')
    .filter({ has: page.getByTestId('order-row-title') })
    .first();
}

async function appuyer(page: Page, x: number, y: number) {
  if (test.info().project.use.hasTouch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function pointDe(page: Page, zone: Zone) {
  const article = carte(page);
  await article.scrollIntoViewIfNeeded();
  // Dégage la barre de navigation du bas (fixée) : la carte est amenée au centre de l'écran.
  await article.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const boite = await article.boundingBox();
  if (!boite) throw new Error('carte introuvable');
  if (zone === 'marge') return { x: boite.x + 5, y: boite.y + boite.height / 2 };
  const cible =
    zone === 'titre'
      ? article.getByTestId('order-row-title')
      : zone === 'montant'
        ? article.getByTestId('order-row-amount')
        : article.getByText('À appeler', { exact: true }).first();
  const b = await cible.boundingBox();
  if (!b) throw new Error(`zone ${zone} introuvable`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test.setTimeout(90_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E');

test.describe('Carte de commande — lien étendu à toute la carte', () => {
  for (const zone of ['titre', 'statut', 'montant', 'marge'] as const) {
    test(`un appui sur ${zone} ouvre la fiche`, async ({ page }) => {
      const { fixture, orderId } = await seedOneOrder(`rangee-${zone}`);
      try {
        await signInToRoute(page, fixture.email, '/commandes');
        await expect(carte(page)).toBeVisible({ timeout: 45_000 });
        const { x, y } = await pointDe(page, zone);
        await appuyer(page, x, y);
        await expect(page).toHaveURL(new RegExp(`/commandes/${orderId}`), { timeout: 30_000 });
      } finally {
        await cleanupVisualFixture(fixture);
      }
    });
  }

  test('un appui sur « ⋯ » n’ouvre que le menu, sans quitter la liste', async ({ page }) => {
    const { fixture, orderId } = await seedOneOrder('rangee-menu');
    try {
      await signInToRoute(page, fixture.email, '/commandes');
      const article = carte(page);
      await expect(article).toBeVisible({ timeout: 45_000 });
      await article.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const menu = article.getByRole('button', { name: /actions/i }).first();
      await expect(menu).toBeVisible();
      const boite = await menu.boundingBox();
      if (!boite) throw new Error('bouton « ⋯ » introuvable');
      await appuyer(page, boite.x + boite.width / 2, boite.y + boite.height / 2);
      await expect(page.getByRole('menu').or(page.getByRole('dialog')).first()).toBeVisible({
        timeout: 30_000,
      });
      expect(page.url()).not.toContain(`/commandes/${orderId}`);
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });

  test('un seul lien de navigation dans la carte, au nom accessible inchangé', async ({ page }) => {
    const { fixture, orderId } = await seedOneOrder('rangee-nom');
    try {
      await signInToRoute(page, fixture.email, '/commandes');
      const article = carte(page);
      await expect(article).toBeVisible({ timeout: 45_000 });
      const liens = article.locator(`a[href*="/commandes/${orderId}"]`);
      await expect(liens).toHaveCount(1);
      await expect(liens).toHaveAccessibleName(/Fatou Diallo E2E/);
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });
});
