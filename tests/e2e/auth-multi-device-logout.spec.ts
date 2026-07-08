import messages from '@/messages/fr.json';
import { expect, test } from '@playwright/test';
import {
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  hasSupabaseAdmin,
  loginViaForm,
  waitForMerchant,
} from './helpers/auth';

test.setTimeout(90_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E auth');

test('logout on one device does not sign out other devices', async ({ browser }) => {
  const admin = adminClient();
  const email = e2eEmail('multi-device-logout');
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  try {
    await admin
      .from('merchant_account')
      .update({ onboarded_at: new Date().toISOString() })
      .eq('id', merchantAccountId);

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await loginViaForm(pageA, email, e2ePassword);
    await pageA.waitForURL('**/tableau', { timeout: 45_000 });

    await loginViaForm(pageB, email, e2ePassword);
    await pageB.waitForURL('**/tableau', { timeout: 45_000 });

    // The sidebar SignOutButton is desktop-only (`hidden md:flex`); /parametres
    // renders SignOutButton unconditionally under the default "profile" tab, so it
    // works on every viewport (chromium/pixel-7/iphone-14).
    await pageA.goto('/parametres');
    await pageA.getByRole('button', { name: messages.nav.signOut, exact: true }).click();
    await pageA.waitForURL((url) => url.pathname === '/', { timeout: 20_000 });

    await pageB.reload();
    await expect(pageB.locator('main#main')).toBeVisible({ timeout: 20_000 });
    await expect(pageB).toHaveURL(/\/tableau/);
  } finally {
    await contextA.close();
    await contextB.close();
    await cleanupUsers(admin, [userId]);
  }
});
