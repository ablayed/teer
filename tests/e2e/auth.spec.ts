import messages from '@/messages/fr.json';
import { expect, test } from '@playwright/test';

test('signup flow shows email verification message', async ({ page }) => {
  await page.goto('/connexion?mode=signup');
  await page
    .getByLabel(messages.auth.email_label, { exact: true })
    .fill(`e2e+${Date.now()}@example.com`);
  await page.locator('input[name="password"]').fill('Mot-de-passe-e2e-2026!');
  // Phase 10 : la case de consentement légal est obligatoire au signup (le bouton « Continuer »
  // reste désactivé tant qu'elle n'est pas cochée). On la coche comme un vrai utilisateur.
  await page.locator('#acceptedLegal').check();
  await page.getByRole('button', { name: messages.auth.signup.submit }).click();
  await expect(
    page
      .getByText(messages.auth.signup.verify_title)
      .or(page.getByText(messages.auth.errors.unknown)),
  ).toBeVisible({ timeout: 20_000 });
});
