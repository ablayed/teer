import messages from '@/messages/fr.json';
import { expect, test } from '@playwright/test';
import {
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  createUnconfirmedUser,
  e2eEmail,
  e2ePassword,
  fillPasswordField,
  hasSupabaseAdmin,
  loginViaForm,
  waitForMerchant,
} from './helpers/auth';
import { createUnboardedTestUser } from './helpers/onboarding';

test.setTimeout(90_000);

test('signup flow shows email verification message', async ({ page }) => {
  await page.goto('/connexion?mode=signup');
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(e2eEmail('signup'));
  await fillPasswordField(page.locator('input[name="password"]'), e2ePassword);
  await page.locator('#acceptedLegal').check();
  await page.getByRole('button', { name: messages.auth.signup.submit }).click();

  await expect(page.getByText(messages.auth.signup.verify_title)).toBeVisible({ timeout: 20_000 });
});

test('idle banner is visible on /connexion?reason=idle', async ({ page }) => {
  await page.goto('/connexion?reason=idle');

  await expect(
    page.getByRole('status').getByText(messages.auth.session_expired_idle, { exact: true }),
  ).toBeVisible();
});

test('tab switch updates URL and submit labels', async ({ page }) => {
  await page.goto('/connexion');
  await expect(page).toHaveURL(/\/connexion$/);
  await expect(
    page.getByRole('button', { name: messages.auth.signin.submit, exact: true }),
  ).toBeVisible();

  await page.getByRole('link', { name: messages.auth.signup_tab, exact: true }).click();
  await expect(page).toHaveURL(/\/connexion\?mode=signup/);
  await expect(
    page.getByRole('button', { name: messages.auth.signup.submit, exact: true }),
  ).toBeVisible();

  await page.getByRole('link', { name: messages.auth.signin_tab, exact: true }).click();
  await expect(page).toHaveURL(/\/connexion\?mode=signin/);
  await expect(
    page.getByRole('button', { name: messages.auth.signin.submit, exact: true }),
  ).toBeVisible();
});

test('password reveal toggle switches input type', async ({ page }) => {
  await page.goto('/connexion');

  const passwordField = page.locator('input[name="password"]');
  await expect(passwordField).toHaveAttribute('type', 'password');

  await page.getByRole('button', { name: messages.auth.common.show_password, exact: true }).click();
  await expect(passwordField).toHaveAttribute('type', 'text');

  await page.getByRole('button', { name: messages.auth.common.hide_password, exact: true }).click();
  await expect(passwordField).toHaveAttribute('type', 'password');
});

test('signup button stays disabled until strong password and legal consent', async ({ page }) => {
  await page.goto('/connexion?mode=signup');

  const submit = page.getByRole('button', { name: messages.auth.signup.submit, exact: true });
  const passwordField = page.locator('input[name="password"]');

  await expect(submit).toBeDisabled();

  await fillPasswordField(passwordField, 'abc');
  await expect(submit).toBeDisabled();

  await fillPasswordField(passwordField, 'TeerSecure1#');
  await expect(submit).toBeDisabled();

  await page.locator('#acceptedLegal').check();
  await expect(submit).toBeEnabled();
});

test('password strength indicator reacts to weak then strong password', async ({ page }) => {
  await page.goto('/connexion?mode=signup');

  const passwordField = page.locator('input[name="password"]');
  const minLengthCriterion = page
    .getByLabel(messages.auth.password_criteria.ariaLabel)
    .locator('li', { hasText: messages.auth.password_criteria.minLength });
  const upperCriterion = page
    .getByLabel(messages.auth.password_criteria.ariaLabel)
    .locator('li', { hasText: messages.auth.password_criteria.hasUpper });
  const lowerCriterion = page
    .getByLabel(messages.auth.password_criteria.ariaLabel)
    .locator('li', { hasText: messages.auth.password_criteria.hasLower });
  const digitCriterion = page
    .getByLabel(messages.auth.password_criteria.ariaLabel)
    .locator('li', { hasText: messages.auth.password_criteria.hasDigit });
  const specialCriterion = page
    .getByLabel(messages.auth.password_criteria.ariaLabel)
    .locator('li', { hasText: messages.auth.password_criteria.hasSpecial });

  await fillPasswordField(passwordField, 'abc');
  await expect(minLengthCriterion).toHaveClass(/text-muted/);

  await fillPasswordField(passwordField, 'TeerSecure1#');
  await expect(minLengthCriterion).toHaveClass(/text-success/);
  await expect(upperCriterion).toHaveClass(/text-success/);
  await expect(lowerCriterion).toHaveClass(/text-success/);
  await expect(digitCriterion).toHaveClass(/text-success/);
  await expect(specialCriterion).toHaveClass(/text-success/);
  await expect(page.locator('meter')).toHaveAttribute('value', '5');
});

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E auth');

test('signin happy path redirects to /tableau with checklist visible', async ({ page }) => {
  const admin = adminClient();
  const email = e2eEmail('signin-ok');
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);

  try {
    await admin
      .from('merchant_account')
      .update({ onboarded_at: new Date().toISOString() })
      .eq('id', merchantAccountId);

    await loginViaForm(page, email, e2ePassword);

    await page.waitForURL('**/tableau', { timeout: 45_000 });
    await expect(page.locator('main#main')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(messages.onboarding.checklist.title)).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await cleanupUsers(admin, [userId]);
  }
});

test('signin invalid credentials shows alert and clears password', async ({ page }) => {
  const admin = adminClient();
  const email = e2eEmail('signin-invalid');
  const userId = await createConfirmedUser(admin, email);

  try {
    await page.goto('/connexion');
    await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
    await fillPasswordField(page.locator('input[name="password"]'), 'Mot-de-passe-faux-2026!');
    await page.getByRole('button', { name: messages.auth.signin.submit }).click();

    await expect(page.locator('p[role="alert"]')).toHaveText(
      messages.auth.errors.invalid_credentials,
    );
    await expect(page.locator('input[name="password"]')).toHaveValue('');
  } finally {
    await cleanupUsers(admin, [userId]);
  }
});

test('signin unconfirmed email shows resend button', async ({ page }) => {
  const admin = adminClient();
  const email = e2eEmail('signin-unconfirmed');
  const userId = await createUnconfirmedUser(admin, email);

  try {
    await page.goto('/connexion');
    await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
    await fillPasswordField(page.locator('input[name="password"]'), e2ePassword);
    await page.getByRole('button', { name: messages.auth.signin.submit }).click();

    await expect(page.locator('p[role="alert"]')).toHaveText(
      messages.auth.errors.email_not_confirmed,
    );
    await expect(
      page.getByRole('button', { name: messages.auth.signup.verify_resend, exact: true }),
    ).toBeVisible();
  } finally {
    await cleanupUsers(admin, [userId]);
  }
});

test('signup success shows verify screen with submitted email and resend button', async ({
  page,
}) => {
  const email = e2eEmail('signup-screen');

  await page.goto('/connexion?mode=signup');
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await fillPasswordField(page.locator('input[name="password"]'), 'TeerSecure1#');
  await page.locator('#acceptedLegal').check();
  await page.getByRole('button', { name: messages.auth.signup.submit }).click();

  await expect(page.getByLabel(messages.auth.signup.verify_aria)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(messages.auth.signup.verify_title)).toBeVisible();
  await expect(page.getByText(email, { exact: false })).toBeVisible();
  await expect(
    page.getByRole('button', { name: messages.auth.signup.verify_resend, exact: true }),
  ).toBeVisible();
});

test('mobile signup keeps brand strip compact and password meter visible', async ({
  page,
  isMobile,
  browserName,
}) => {
  test.skip(!isMobile || browserName !== 'chromium', 'Scenario mobile dedie pixel-7 uniquement');

  await page.goto('/connexion');
  await expect(page.getByText(messages.auth.brand.tagline_line1)).not.toBeVisible();
  await expect(page.getByRole('heading', { name: messages.auth.signin.title })).toBeVisible();

  await page.getByRole('link', { name: messages.auth.signup_tab, exact: true }).click();
  await expect(page.locator('meter')).toBeVisible();
});

test('onboarding happy path reaches welcome then /tableau', async ({ page }) => {
  const admin = adminClient();
  const fixture = await createUnboardedTestUser(admin);

  try {
    await loginViaForm(page, fixture.email, fixture.password);
    await page.waitForURL('**/onboarding', { timeout: 45_000 });

    await expect(
      page.getByRole('heading', { name: messages.onboarding.step1.title, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(messages.onboarding.stepIndicator.replace('{step}', '1')),
    ).toBeVisible();
    await expect(page.locator('[style*="width: 50%"]')).toBeVisible();

    await page.getByRole('button', { name: messages.onboarding.actions.continue }).click();
    await expect(page.locator('p[role="alert"]')).toHaveText(messages.onboarding.errors.shopName);

    await page.locator('input[name="shopName"]').fill('Boutique Auth E2E');
    await page.getByRole('button', { name: messages.onboarding.actions.continue }).click();

    await expect(
      page.getByRole('heading', { name: messages.onboarding.step2.title, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(messages.onboarding.stepSaved)).toBeVisible();
    await expect(page.locator('[style*="width: 100%"]')).toBeVisible();

    await page.getByRole('button', { name: messages.onboarding.actions.back }).click();
    await expect(
      page.getByRole('heading', { name: messages.onboarding.step1.title, exact: true }),
    ).toBeVisible();
    await expect(page.locator('[style*="width: 50%"]')).toBeVisible();

    await page.locator('input[name="shopName"]').fill('Boutique Auth E2E');
    await page.getByRole('button', { name: messages.onboarding.actions.continue }).click();

    await page.locator('input[name="ownerFullName"]').fill('Ablaye Dia');
    await page.locator('input[name="whatsapp"]').fill('1234');
    await page.getByRole('button', { name: messages.onboarding.actions.finish }).click();
    await expect(page.locator('p[role="alert"]')).toHaveText(
      messages.onboarding.errors.invalid_whatsapp,
    );

    await page.locator('input[name="whatsapp"]').fill('+221771234567');
    await page.getByRole('button', { name: messages.onboarding.actions.finish }).click();

    await expect(
      page.getByRole('heading', {
        name: messages.onboarding.welcome.title.replace('{name}', 'Ablaye'),
      }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(messages.onboarding.welcome.cta)).toBeVisible();

    await expect
      .poll(
        async () => {
          const { data, error } = await admin
            .from('merchant_account')
            .select('onboarded_at')
            .eq('id', fixture.merchantAccountId)
            .limit(1)
            .maybeSingle();

          if (error) {
            throw error;
          }

          return data?.onboarded_at ?? null;
        },
        { timeout: 10_000, intervals: [150, 300, 500] },
      )
      .not.toBeNull();

    await page.getByRole('button', { name: messages.onboarding.welcome.cta }).click();
    await page.waitForURL('**/tableau', { timeout: 45_000 });
    await expect(page.locator('main#main')).toBeVisible({ timeout: 20_000 });
  } finally {
    await cleanupUsers(admin, [fixture.userId]);
  }
});
