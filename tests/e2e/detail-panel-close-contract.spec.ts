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
 * Bug signalé par le fondateur (Lot U1-F-bis-suite) : sur /dev/finance-foundations, la croix du
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
 * panneau construit dessus (page de démo `/dev/finance-foundations`, et `ProductDetailPanel`
 * sur `/produits`, couvert séparément par `tests/e2e/products-bundle-configuration.spec.ts`)
 * doit se fermer par les trois voies. Mutation testée manuellement : commenter
 * `onClick={onClose}` sur le bouton croix fait échouer "se ferme par la croix" (le panneau reste
 * ouvert) — restauré après confirmation du rouge.
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
  return { admin, email, merchantAccountId, userIds: [userId] };
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await loginViaForm(page, email, e2ePassword, redirectTo);
  await landOnTarget(page, redirectTo, 30_000);
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
}

async function openPanel(page: Page) {
  const trigger = page.getByRole('button', { name: /Marge/ }).first();
  // .focus() explicite : un clic synthétique (element.click()) ne rejoue pas la séquence
  // mousedown→focus→mouseup d'un vrai clic — sans ça, aucun élément n'est focus au moment de
  // l'ouverture, et le test de restauration du focus ne reflète pas un vrai déclenchement
  // clavier/souris.
  await trigger.focus();
  await trigger.evaluate((el) => (el as HTMLElement).click());
  const dialog = page.locator('dialog[aria-label="Marge"]').first();
  await expect(dialog).toHaveAttribute('aria-hidden', 'false');
  return { trigger, dialog };
}

test.setTimeout(60_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E');

test.describe('DetailPanel — contrat de fermeture (desktop, 1280px)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('un panneau fermé quitte réellement le viewport (pas seulement aria-hidden)', async ({
    page,
  }) => {
    const fixture = await createOwnerFixture('panel-geom');
    try {
      await signIn(page, fixture.email, '/dev/finance-foundations');
      const { dialog } = await openPanel(page);

      await dialog.getByRole('button', { name: 'Fermer' }).click();
      await expect(dialog).toHaveAttribute('aria-hidden', 'true');
      await page.waitForTimeout(400); // laisse la transition CSS (250ms) se terminer

      const rect = await dialog.evaluate((el) => el.getBoundingClientRect());
      const viewportWidth = page.viewportSize()?.width ?? 0;
      // Le bug : le panneau "fermé" restait visible dans le viewport (left ancré à 0 au lieu
      // de droite). Un panneau réellement fermé a son bord gauche au-delà du bord droit du
      // viewport.
      expect(rect.x).toBeGreaterThanOrEqual(viewportWidth);
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });

  test('se ferme par la croix', async ({ page }) => {
    const fixture = await createOwnerFixture('panel-close-x');
    try {
      await signIn(page, fixture.email, '/dev/finance-foundations');
      const { dialog } = await openPanel(page);

      await dialog.getByRole('button', { name: 'Fermer' }).click();
      await expect(dialog).toHaveAttribute('aria-hidden', 'true');
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });

  test('se ferme par Échap', async ({ page }) => {
    const fixture = await createOwnerFixture('panel-close-esc');
    try {
      await signIn(page, fixture.email, '/dev/finance-foundations');
      const { dialog } = await openPanel(page);

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveAttribute('aria-hidden', 'true');
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });

  test('se ferme par le clic extérieur', async ({ page }) => {
    const fixture = await createOwnerFixture('panel-close-out');
    try {
      await signIn(page, fixture.email, '/dev/finance-foundations');
      const { dialog } = await openPanel(page);

      await page.mouse.click(20, 20);
      await expect(dialog).toHaveAttribute('aria-hidden', 'true');
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });

  test('gestion du focus : entre au panneau à l’ouverture, revient au déclencheur à la fermeture', async ({
    page,
  }) => {
    const fixture = await createOwnerFixture('panel-focus');
    try {
      await signIn(page, fixture.email, '/dev/finance-foundations');
      const { trigger, dialog } = await openPanel(page);

      await expect(dialog.getByRole('button', { name: 'Fermer' })).toBeFocused();

      await dialog.getByRole('button', { name: 'Fermer' }).click();
      await expect(dialog).toHaveAttribute('aria-hidden', 'true');
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
        await signIn(page, fixture.email, '/dev/finance-foundations');

        const trigger = page.getByRole('button', { name: /Marge/ }).first();
        await trigger.focus();
        await trigger.evaluate((el) => (el as HTMLElement).click());

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
        await expect(trigger).toBeFocused();
      } finally {
        await cleanupUsers(fixture.admin, fixture.userIds);
      }
    });

    test('se ferme par le clic sur la zone extérieure', async ({ page }) => {
      const fixture = await createOwnerFixture(`panel-mobile-out-${viewport.width}`);
      try {
        await signIn(page, fixture.email, '/dev/finance-foundations');

        const trigger = page.getByRole('button', { name: /Marge/ }).first();
        await trigger.evaluate((el) => (el as HTMLElement).click());

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
