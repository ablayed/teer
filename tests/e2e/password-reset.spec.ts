import messages from '@/messages/fr.json';
import { expect, test } from '@playwright/test';
import {
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  fillPasswordField,
  hasSupabaseAdmin,
  supabaseUrl,
} from './helpers/auth';
import { clearMailbox, recoveryLinkIn, waitForMessageTo } from './helpers/mailpit';

/**
 * PWD-RESET-01 — parcours de récupération de mot de passe, dans un vrai navigateur.
 *
 * Complémentaire de `tests/rls/pwd-reset-recovery-flow.rls.test.ts`, qui mesure la
 * même chaîne au niveau HTTP : ici on vérifie ce que le navigateur seul peut dire —
 * le cookie de vérificateur PKCE porté d'un écran à l'autre, l'atterrissage réel, et
 * le fait qu'un second clic dans un CONTEXTE NEUF ne rouvre rien.
 */

test.setTimeout(120_000);

const NEW_PASSWORD = 'Nouveau-mot-de-passe-2027!';

test.describe('Récupération de mot de passe', () => {
  test.skip(!hasSupabaseAdmin, 'Nécessite le stack Supabase local (service-role).');

  const createdUserIds: string[] = [];

  test.afterAll(async () => {
    if (createdUserIds.length > 0) {
      await cleanupUsers(adminClient(), createdUserIds);
    }
  });

  test('le lien « Mot de passe oublié ? » mène à l’écran de demande', async ({ page }) => {
    await page.goto('/connexion');

    await page.getByRole('link', { name: messages.auth.forgot_password.link, exact: true }).click();

    await expect(page).toHaveURL(/\/mot-de-passe-oublie$/);
    await expect(
      page.getByRole('heading', { name: messages.auth.forgot_password.title }),
    ).toBeVisible();
  });

  test("l'écran de demande répond à l'identique pour une adresse inconnue", async ({ page }) => {
    await page.goto('/mot-de-passe-oublie');

    const unknown = e2eEmail('pwd-reset-unknown');
    await page.getByLabel(messages.auth.email_label, { exact: true }).fill(unknown);
    await page
      .getByRole('button', { name: messages.auth.forgot_password.submit, exact: true })
      .click();

    // Exactement l'écran qu'obtiendrait un compte existant : aucun indice.
    await expect(
      page.getByRole('heading', { name: messages.auth.forgot_password.sent_title }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(messages.auth.forgot_password.sent_spam)).toBeVisible();

    // Et aucune durée chiffrée n'est annoncée.
    await expect(page.getByText(messages.auth.forgot_password.sent_expiry)).toBeVisible();
    await expect(page.locator('body')).not.toContainText('1 heure');
    await expect(page.locator('body')).not.toContainText('60 minutes');
  });

  test('parcours complet, puis rejeu refusé dans un contexte neuf', async ({ page, browser }) => {
    const admin = adminClient();
    const email = e2eEmail('pwd-reset-flow');
    createdUserIds.push(await createConfirmedUser(admin, email));

    // Une session ouverte AVANT la réinitialisation, dans un autre contexte.
    const otherDevice = await browser.newContext();
    const otherPage = await otherDevice.newPage();
    await otherPage.goto('/connexion');
    await otherPage.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
    await fillPasswordField(otherPage.locator('input[name="password"]'), e2ePassword);
    await otherPage.getByRole('button', { name: messages.auth.signin.submit, exact: true }).click();
    await expect(otherPage).not.toHaveURL(/\/connexion/, { timeout: 60_000 });

    await clearMailbox();

    // 1. Demande, depuis le contexte principal (c'est lui qui portera le
    //    vérificateur PKCE — le lien doit être ouvert dans CE navigateur).
    await page.goto('/mot-de-passe-oublie');
    await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
    await page
      .getByRole('button', { name: messages.auth.forgot_password.submit, exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: messages.auth.forgot_password.sent_title }),
    ).toBeVisible({ timeout: 20_000 });

    // 2. Le courriel arrive réellement.
    const body = await waitForMessageTo(email);
    expect(body, 'un courriel de récupération doit arriver').toBeTruthy();
    const link = recoveryLinkIn(body as string);
    expect(link, 'le courriel doit porter un lien /auth/v1/verify').toBeTruthy();

    // 3. Le clic mène à l'écran de nouveau mot de passe.
    await page.goto(link as string);
    await expect(page).toHaveURL(/\/mot-de-passe-oublie\/nouveau$/, { timeout: 30_000 });
    await expect(
      page.getByRole('heading', { name: messages.auth.new_password.title }),
    ).toBeVisible();

    // 4. Le nouveau mot de passe est posé, et l'utilisateur reprend le parcours normal.
    await fillPasswordField(page.locator('input[name="password"]'), NEW_PASSWORD);
    await fillPasswordField(page.locator('input[name="confirmPassword"]'), NEW_PASSWORD);
    await page
      .getByRole('button', { name: messages.auth.new_password.submit, exact: true })
      .click();
    await expect(page).not.toHaveURL(/\/mot-de-passe-oublie/, { timeout: 60_000 });

    // 5. REJEU — dans un contexte NEUF, sans cookie ni stockage. Sans cette
    //    précaution, le cookie du premier clic ferait paraître le rejeu réussi et
    //    le test mesurerait le cookie, pas l'usage unique du lien.
    const replayContext = await browser.newContext();
    const replayPage = await replayContext.newPage();
    await replayPage.goto(link as string);
    await expect(replayPage).toHaveURL(/\/connexion\?reason=lien_invalide/, { timeout: 30_000 });
    await expect(replayPage.getByText(messages.auth.link_invalid_notice)).toBeVisible();
    await replayContext.close();

    // 6. SORT DES AUTRES SESSIONS — l'appareil resté connecté est coupé.
    await otherPage.goto('/tableau');
    await expect(otherPage).toHaveURL(/\/connexion/, { timeout: 60_000 });
    await otherDevice.close();

    // 7. Le nouveau mot de passe fonctionne pour se reconnecter.
    const signIn = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password: NEW_PASSWORD }),
    });
    expect(signIn.status).toBe(200);
  });

  test('aucun paramètre injecté dans le lien ne déplace la destination du rappel', async ({
    page,
  }) => {
    const admin = adminClient();
    const email = e2eEmail('pwd-reset-fixed');
    createdUserIds.push(await createConfirmedUser(admin, email));

    await clearMailbox();
    await page.goto('/mot-de-passe-oublie');
    await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
    await page
      .getByRole('button', { name: messages.auth.forgot_password.submit, exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: messages.auth.forgot_password.sent_title }),
    ).toBeVisible({ timeout: 20_000 });

    const body = await waitForMessageTo(email);
    const link = recoveryLinkIn(body as string);
    expect(link).toBeTruthy();

    // On greffe sur la cible de rappel tous les noms de paramètre qu'un attaquant
    // tenterait par courriel. C'est le test le plus important du lot.
    const tampered = new URL(link as string);
    const callback = new URL(tampered.searchParams.get('redirect_to') as string);
    callback.searchParams.set('redirectTo', 'https://evil.example/steal');
    callback.searchParams.set('next', '/parametres');
    callback.searchParams.set('returnTo', '/parametres');
    tampered.searchParams.set('redirect_to', callback.toString());

    await page.goto(tampered.toString());

    await expect(page).toHaveURL(/\/mot-de-passe-oublie\/nouveau$/, { timeout: 30_000 });
    expect(page.url()).not.toContain('evil.example');
    expect(page.url()).not.toContain('parametres');
  });

  test.describe('rendu mobile', () => {
    for (const [label, width] of [
      ['iphone-14', 390],
      ['pixel-7', 412],
    ] as const) {
      test(`écrans lisibles sans débordement horizontal à ${width}px (${label})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto('/mot-de-passe-oublie');

        await expect(
          page.getByRole('heading', { name: messages.auth.forgot_password.title }),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: messages.auth.forgot_password.submit, exact: true }),
        ).toBeVisible();

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        expect(overflow, 'aucun débordement horizontal').toBe(false);
      });
    }
  });
});
