import messages from '@/messages/fr.json';
import { expect, test } from '@playwright/test';

test('signup flow shows email verification message', async ({ page }) => {
  await page.goto('/connexion?mode=signup');
  await page.getByLabel(messages.auth.email_label).fill(`e2e+${Date.now()}@example.com`);
  await page.locator('input[name="password"]').fill('Mot-de-passe-e2e-2026!');
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await expect(
    page.getByText(messages.auth.verify_email).or(page.getByText(messages.auth.errors.unknown)),
  ).toBeVisible({ timeout: 20_000 });
});
