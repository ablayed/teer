import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { landOnTarget } from './helpers/auth';
import { grantCurrentConsents } from './helpers/consent';

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
const password = 'Mot-de-passe-e2e-2026!';
const newPassword = 'Nouveau-Mdp-E2E-2026!';

test.setTimeout(90_000);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+vague1-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createConfirmedUser(admin: AdminClient, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('Utilisateur E2E non créé');
  await grantCurrentConsents(admin, data.user.id);
  return data.user.id;
}

async function waitForMerchant(admin: AdminClient, userId: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.merchant_account_id) return data.merchant_account_id as string;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account introuvable après 3s');
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Teer E2E Vague1 ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, userId, merchantAccountId };
}

async function cleanupFixture(fixture: Awaited<ReturnType<typeof createOwnerFixture>>) {
  await fixture.admin.auth.admin.deleteUser(fixture.userId);
}

async function signIn(page: Page, email: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent('/parametres')}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await landOnTarget(page, '/parametres');
  await page.waitForLoadState('networkidle');
}

async function fillPassword(page: Page, selector: string, value: string) {
  const input = page.locator(selector);
  await input.click({ clickCount: 3 });
  await input.pressSequentially(value);
  await expect(input).toHaveValue(value);
}

async function navigateToSecurityTab(page: Page) {
  await page.getByRole('tab', { name: messages.settings.tabs.security }).click();
  await expect(
    page.getByRole('heading', { name: messages.settings.security.password.title }),
  ).toBeVisible();
}

test.describe('Onglet Sécurité — Paramètres', () => {
  test.skip(!serviceRoleKey, 'SUPABASE_SERVICE_ROLE_KEY absent — test ignoré');

  test("affiche les deux sections apres clic sur l'onglet Securite", async ({ page }) => {
    const fixture = await createOwnerFixture('nav');
    try {
      await signIn(page, fixture.email);
      await navigateToSecurityTab(page);
      await expect(
        page.getByRole('heading', { name: messages.settings.security.email.title }),
      ).toBeVisible();
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("mot de passe actuel incorrect affiche l'erreur dediee", async ({ page }) => {
    const fixture = await createOwnerFixture('wrong-pwd');
    try {
      await signIn(page, fixture.email);
      await navigateToSecurityTab(page);

      await fillPassword(page, '#sec-current-pwd', 'mauvais-mot-de-passe');
      await fillPassword(page, '#sec-new-pwd', newPassword);
      await fillPassword(page, '#sec-confirm-pwd', newPassword);

      await page.getByRole('button', { name: messages.settings.security.password.save }).click();

      // Cibler uniquement le <p role="alert"> — le route-announcer Next.js est
      // un <div role="alert"> toujours présent et causerait un strict-mode violation.
      await expect(page.locator('p[role="alert"]')).toContainText(
        messages.settings.security.password.errors.wrong_current,
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test('changement de mot de passe réussi → affiche le succès', async ({ page }) => {
    const fixture = await createOwnerFixture('change-pwd');
    try {
      await signIn(page, fixture.email);
      await navigateToSecurityTab(page);

      await fillPassword(page, '#sec-current-pwd', password);
      await fillPassword(page, '#sec-new-pwd', newPassword);
      await fillPassword(page, '#sec-confirm-pwd', newPassword);

      await page.getByRole('button', { name: messages.settings.security.password.save }).click();

      await expect(page.locator('output')).toContainText(
        messages.settings.security.password.success,
        { timeout: 15_000 },
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("changement d'email affiche le message de double confirmation", async ({ page }) => {
    const fixture = await createOwnerFixture('change-email');
    try {
      await signIn(page, fixture.email);
      await navigateToSecurityTab(page);

      await page.locator('#sec-new-email').fill(`new+${Date.now()}@example.com`);
      await fillPassword(page, '#sec-email-pwd', password);

      await page.getByRole('button', { name: messages.settings.security.email.save }).click();

      await expect(page.locator('output')).toContainText('confirmation', { timeout: 15_000 });
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
