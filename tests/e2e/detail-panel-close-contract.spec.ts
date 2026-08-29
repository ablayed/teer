import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import {
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  hasSupabaseAdmin,
  landOnTarget,
  loginViaForm,
  supabaseUrl,
  waitForMerchant,
} from './helpers/auth';

/**
 * Bug signalé par le fondateur (Lot U1-F-bis-suite) : sur `/dev/finance-foundations`, la croix du
 * panneau « Marge » n'avait aucun effet visible — le panneau restait affiché en permanence.
 *
 * Cause exacte (pas une supposition — reproduite en Chromium réel via Playwright, invisible en
 * JSDOM où `tests/unit/ui/explanation-card.test.tsx` force `useIsDesktop` à `false`) :
 * `components/ui/detail-panel.tsx`, branche desktop. Le `<dialog>` reçoit ses classes Tailwind
 * `fixed top-0 right-0` mais jamais de `left`. La feuille de style par défaut du navigateur pour
 * `<dialog>` pose `inset: 0` (donc `left: 0`), qu'aucune classe ne réinitialisait. Avec
 * `right: 0` ET `left: 0` ET une largeur explicite (`max-w-[480px]`), la boîte est
 * sur-contrainte ; en LTR le navigateur ignore alors `right` au profit de ce `left: 0` hérité —
 * le panneau est ancré à GAUCHE au lieu de la droite. `translate-x-full` (pensé pour sortir par
 * la droite, donc hors écran) le fait juste glisser d'une position visible à une autre : il ne
 * quitte jamais le viewport, ouvert ou fermé. La croix, Échap et le clic extérieur mettaient
 * bien à jour l'état React (`onClose` se déclenchait) — le bug était purement géométrique.
 * Correctif : `left-auto` sur le `<dialog>`.
 *
 * Le panneau focus ne bougeait pas non plus (ni à l'ouverture, ni à la fermeture) sur aucune des
 * deux branches (desktop `<dialog>`, mobile `Drawer`/vaul) — corrigé dans le même composant.
 *
 * `DetailPanel` est un composant partagé — cette suite le traite comme une CLASSE : tout
 * panneau construit dessus doit se fermer par les trois voies. Mutation testée manuellement :
 * commenter `onClick={onClose}` sur le bouton croix fait échouer "se ferme par la croix" (le
 * panneau reste ouvert) — restauré après confirmation du rouge.
 *
 * REPORTÉE sur un écran réel (Lot F2-bis) : `/dev/finance-foundations` a été supprimée une fois
 * les écrans réels équivalents en place (cf. docs/lexique-microcopie.md). Le déclencheur choisi
 * ici est `ProductDetailPanel` (`/produits`, catalogue) — fixture la plus légère possible (un
 * seul produit, aucun arrivage/commande requis) parmi les panneaux réels construits sur
 * `DetailPanel`. `PurchaseLotDetailPanel` (Fiche arrivage) est couvert séparément par
 * tests/e2e/lot-f2-purchase-lot-detail.spec.ts (responsive, pas ce contrat générique de
 * fermeture) — pas de duplication d'objectif entre les deux suites.
 */

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function adminClient(): SupabaseClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  const shopId = await waitForDefaultShop(admin, merchantAccountId);
  return { admin, email, merchantAccountId, shopId, userIds: [userId] };
}

async function waitForDefaultShop(
  admin: SupabaseClient,
  merchantAccountId: string,
): Promise<string> {
  let shopId = '';
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('shop')
          .select('id')
          .eq('merchant_account_id', merchantAccountId)
          .eq('is_default', true)
          .limit(1)
          .maybeSingle();
        shopId = (data?.id as string | undefined) ?? '';
        return shopId;
      },
      { timeout: 10_000, intervals: [150, 300, 500] },
    )
    .not.toBe('');
  return shopId;
}

async function createProduct(admin: SupabaseClient, merchantAccountId: string, shopId: string) {
  const title = `Produit DetailPanel E2E ${Date.now()}`;
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      title,
      unit_cost: 0,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return { productId: data.id as string, title };
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await loginViaForm(page, email, e2ePassword, redirectTo);
  await landOnTarget(page, redirectTo, 30_000);
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
}

// Desktop rend `product-catalog-card` (bouton "Détails" inline), mobile rend
// `product-catalog-row` (menu "Actions — <titre>" à la place) — même motif que
// `openDetails()` dans tests/e2e/products-bundle-configuration.spec.ts (aucun
// module de fixtures partagé dans ce dépôt).
async function openProductDetails(page: Page, productId: string, title: string) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Viewport Playwright requis pour ouvrir les détails produit');

  const isDesktop = viewport.width >= 768;
  const productRow = page.getByTestId(
    `${isDesktop ? 'product-catalog-card' : 'product-catalog-row'}-${productId}`,
  );
  await productRow.waitFor({ state: 'visible' });

  if (isDesktop) {
    await productRow.getByRole('button', { name: 'Détails', exact: true }).click();
    return;
  }

  await productRow.getByRole('button', { name: `Actions — ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Détails', exact: true }).click();
}

async function openPanel(page: Page, productId: string, title: string) {
  await openProductDetails(page, productId, title);
  const dialog = page.locator(`dialog[aria-label="${title}"]`).first();
  await expect(dialog).toHaveAttribute('aria-hidden', 'false');
  return { dialog };
}

test.setTimeout(60_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E');

test.describe('DetailPanel — contrat de fermeture (desktop, 1280px)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  // `ProductDetailPanel` est démonté par son PARENT à la fermeture (`open={true}`
  // figé, cf. commentaire de tête de detail-panel.tsx sur les deux façons
  // d'utiliser ce composant) — contrairement à l'ancienne page de démo
  // (`ExplanationCard`, `open` qui bascule sur un composant qui reste monté).
  // Un panneau réellement fermé ici quitte donc le DOM (`toHaveCount(0)`),
  // preuve plus forte qu'un `aria-hidden` sur un nœud qui resterait présent.
  test('le panneau est ancré à droite (jamais hors-écran/gauche) et disparaît réellement à la fermeture', async ({
    page,
  }) => {
    const fixture = await createOwnerFixture('panel-geom');
    try {
      const { productId, title } = await createProduct(
        fixture.admin,
        fixture.merchantAccountId,
        fixture.shopId,
      );
      await signIn(page, fixture.email, '/produits');
      const { dialog } = await openPanel(page, productId, title);

      const rect = await dialog.evaluate((el) => el.getBoundingClientRect());
      const viewportWidth = page.viewportSize()?.width ?? 0;
      // Le bug : `left: 0` hérité du navigateur pour <dialog> faisait ignorer
      // `right: 0` en LTR — le panneau s'ancrait à GAUCHE au lieu de la
      // droite. Un panneau correctement ancré a son bord droit au bord droit
      // du viewport, jamais très en-deçà.
      expect(rect.right).toBeGreaterThan(viewportWidth - 5);
      expect(rect.right).toBeLessThanOrEqual(viewportWidth + 1);

      await dialog.getByRole('button', { name: 'Fermer' }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });

  test('se ferme par la croix', async ({ page }) => {
    const fixture = await createOwnerFixture('panel-close-x');
    try {
      const { productId, title } = await createProduct(
        fixture.admin,
        fixture.merchantAccountId,
        fixture.shopId,
      );
      await signIn(page, fixture.email, '/produits');
      const { dialog } = await openPanel(page, productId, title);

      await dialog.getByRole('button', { name: 'Fermer' }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });

  test('se ferme par Échap', async ({ page }) => {
    const fixture = await createOwnerFixture('panel-close-esc');
    try {
      const { productId, title } = await createProduct(
        fixture.admin,
        fixture.merchantAccountId,
        fixture.shopId,
      );
      await signIn(page, fixture.email, '/produits');
      const { dialog } = await openPanel(page, productId, title);

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });

  test('se ferme par le clic extérieur', async ({ page }) => {
    const fixture = await createOwnerFixture('panel-close-out');
    try {
      const { productId, title } = await createProduct(
        fixture.admin,
        fixture.merchantAccountId,
        fixture.shopId,
      );
      await signIn(page, fixture.email, '/produits');
      const { dialog } = await openPanel(page, productId, title);

      await page.mouse.click(20, 20);
      await expect(dialog).toHaveCount(0);
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });

  test('gestion du focus : entre au panneau à l’ouverture, revient au déclencheur à la fermeture', async ({
    page,
  }) => {
    const fixture = await createOwnerFixture('panel-focus');
    try {
      const { productId, title } = await createProduct(
        fixture.admin,
        fixture.merchantAccountId,
        fixture.shopId,
      );
      await signIn(page, fixture.email, '/produits');
      const trigger = page
        .getByTestId(`product-catalog-card-${productId}`)
        .getByRole('button', { name: 'Détails', exact: true });
      const { dialog } = await openPanel(page, productId, title);

      await expect(dialog.getByRole('button', { name: 'Fermer' })).toBeFocused();

      await dialog.getByRole('button', { name: 'Fermer' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });
});

for (const viewport of [
  { name: '412px (pixel-7)', width: 412, height: 900 },
  { name: '390px (iphone-14)', width: 390, height: 844 },
]) {
  test.describe(`DetailPanel — contrat de fermeture (mobile, ${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('se ferme par la croix, aucun débordement horizontal, focus géré', async ({ page }) => {
      const fixture = await createOwnerFixture(`panel-mobile-${viewport.width}`);
      try {
        const { productId, title } = await createProduct(
          fixture.admin,
          fixture.merchantAccountId,
          fixture.shopId,
        );
        await signIn(page, fixture.email, '/produits');

        // Déclenché ici via le menu « Actions — {titre} » (ActionSheet, Radix) →
        // « Détails » : contrairement au bouton "Détails" desktop (persistant),
        // l'élément réellement focus juste avant l'ouverture est le menuitem
        // Radix, démonté dès la sélection — sa restauration de focus au bouton
        // "Actions" est un comportement d'ActionSheet, orthogonal au contrat de
        // `DetailPanel` testé ici (entrée/sortie de focus du panneau lui-même).
        // Non réaffirmé pour cette raison ; le contrat DetailPanel testé plus
        // haut (desktop, trigger persistant) couvre déjà "revient au déclencheur".
        await openProductDetails(page, productId, title);

        const closeBtn = page.getByRole('button', { name: 'Fermer' });
        await expect(closeBtn).toBeVisible();
        await expect(closeBtn).toBeFocused();

        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(overflow.scrollWidth).toBe(overflow.clientWidth);

        const box = await closeBtn.boundingBox();
        expect(box).not.toBeNull();
        expect(box?.x).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);

        await closeBtn.click();
        await expect(closeBtn).toHaveCount(0);
      } finally {
        await cleanupUsers(fixture.admin, fixture.userIds);
      }
    });

    test('se ferme par le clic sur la zone extérieure', async ({ page }) => {
      const fixture = await createOwnerFixture(`panel-mobile-out-${viewport.width}`);
      try {
        const { productId, title } = await createProduct(
          fixture.admin,
          fixture.merchantAccountId,
          fixture.shopId,
        );
        await signIn(page, fixture.email, '/produits');

        await openProductDetails(page, productId, title);

        const closeBtn = page.getByRole('button', { name: 'Fermer' });
        await expect(closeBtn).toBeVisible();

        await page.mouse.click(10, 10);
        await expect(closeBtn).toHaveCount(0);
      } finally {
        await cleanupUsers(fixture.admin, fixture.userIds);
      }
    });
  });
}
