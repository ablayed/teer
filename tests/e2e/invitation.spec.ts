import { existsSync, readFileSync } from 'node:fs';
import { generateInvitationToken, hashInvitationToken } from '@/lib/team/invitation-token';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { grantCurrentConsents } from './helpers/consent';

function readLocalEnv(): Record<string, string> {
  if (!existsSync('.env.local')) {
    return {};
  }
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
const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);
const password = 'Mot-de-passe-e2e-2026!';

test.setTimeout(90_000);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+lot2b-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data } = await admin
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.merchant_account_id) return data.merchant_account_id as string;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Merchant E2E introuvable');
}

// Crée un fondateur (owner) avec une organisation onboardée. Renvoie de quoi
// inviter (admin, ownerUserId, merchantAccountId, nom de l'org).
async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(`owner-${label}`);
  const ownerUserId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, ownerUserId);
  const orgName = `Tëër E2E ${label}`;
  await admin
    .from('merchant_account')
    .update({ name: orgName, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, orgName, ownerUserId };
}

// Insère une invitation pending avec un token clair connu (le hash est stocké).
async function createInvitation(
  admin: AdminClient,
  merchantAccountId: string,
  email: string,
  role: 'manager' | 'agent',
  invitedBy: string,
): Promise<string> {
  const token = generateInvitationToken();
  const { error } = await admin.from('invitation').insert({
    merchant_account_id: merchantAccountId,
    email: email.toLowerCase(),
    role,
    token_hash: hashInvitationToken(token),
    invited_by: invitedBy,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  if (error) throw error;
  return token;
}

async function fillLogin(page: Page, email: string) {
  const emailInput = page.getByLabel(messages.auth.email_label);
  const passwordInput = page.getByLabel(messages.auth.password_label);
  await expect(emailInput).toBeVisible({ timeout: 30_000 });
  await emailInput.click();
  await emailInput.pressSequentially(email);
  await passwordInput.click();
  await passwordInput.pressSequentially(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E invitation');

// B1 + B5 : l'invité ouvre le lien token, se connecte (le token est réinjecté
// à travers /connexion), rejoint l'org et voit le bandeau d'accueil sur /tableau.
test('invité avec token accepte via le lien et voit le message d’accueil', async ({ page }) => {
  const fixture = await createOwnerFixture('token');
  const inviteeEmail = e2eEmail('invitee-token');
  const token = await createInvitation(
    fixture.admin,
    fixture.merchantAccountId,
    inviteeEmail,
    'agent',
    fixture.ownerUserId,
  );
  // L'utilisateur signup avec une invitation pending → le trigger conditionnel
  // ne lui crée PAS d'organisation (il reste « sans org »).
  await createConfirmedUser(fixture.admin, inviteeEmail);

  // Ouverture du lien token sans être connecté → redirection vers /connexion
  // avec le token réinjecté dans redirectTo (B1).
  await page.goto(`/invitation/accept?token=${encodeURIComponent(token)}`);
  await fillLogin(page, inviteeEmail);

  // Après connexion, retour sur /invitation/accept?token=... → acceptation →
  // redirection vers /tableau avec le bandeau d'accueil (B5).
  await page.waitForURL('**/tableau**', { timeout: 45_000 });
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(fixture.orgName)).toBeVisible({ timeout: 15_000 });
});

// B3 + B4 : l'invité (sans org) se connecte, est routé vers /invitation/accept
// (mode liste, sans token), choisit son invitation et rejoint.
test('invité sans org sans token est routé vers la liste et rejoint', async ({ page }) => {
  const fixture = await createOwnerFixture('liste');
  const inviteeEmail = e2eEmail('invitee-list');
  await createInvitation(
    fixture.admin,
    fixture.merchantAccountId,
    inviteeEmail,
    'manager',
    fixture.ownerUserId,
  );
  await createConfirmedUser(fixture.admin, inviteeEmail);

  // Connexion vers /tableau : le layout (app) voit « pas d'org + invitation
  // pending » → redirige vers /invitation/accept (B3).
  await page.goto('/connexion?redirectTo=/tableau');
  await fillLogin(page, inviteeEmail);
  await page.waitForURL('**/invitation/accept', { timeout: 45_000 });

  // La liste affiche l'org invitante ; on accepte explicitement (B4).
  await expect(page.getByText(fixture.orgName)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: messages.invitation.accept.accept }).first().click();

  await page.waitForURL('**/tableau**', { timeout: 45_000 });
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
});

// Non-régression B3 : un fondateur sans invitation va bien vers /onboarding.
test('fondateur sans invitation est routé vers /onboarding', async ({ page }) => {
  const admin = adminClient();
  const email = e2eEmail('founder');
  // Pas d'invitation pending → le trigger crée une org NON onboardée.
  await createConfirmedUser(admin, email);

  await page.goto('/connexion?redirectTo=/tableau');
  await fillLogin(page, email);
  await page.waitForURL('**/onboarding', { timeout: 45_000 });
  await expect(page.locator('main, form').first()).toBeVisible({ timeout: 30_000 });
});

// B2 : après une invitation réussie, le lien s'affiche avec un bouton Copier et
// un lien WhatsApp bien formé.
test('inviteMemberAction affiche le lien, le bouton copier et le lien WhatsApp', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('invite-ui');

  await page.goto('/connexion?redirectTo=/parametres');
  await fillLogin(page, fixture.email);
  await page.waitForURL('**/parametres', { timeout: 45_000 });
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });

  await page.getByRole('tab', { name: messages.settings.tabs.team }).click();

  const emailInput = page.getByLabel(messages.settings.team.invite.email);
  await expect(emailInput).toBeVisible({ timeout: 15_000 });
  await emailInput.click();
  await emailInput.pressSequentially(e2eEmail('invited-member'));
  await page.getByRole('button', { name: messages.settings.team.invite.submit }).click();

  // Le bloc « lien d'invitation » apparaît.
  await expect(page.getByText(messages.settings.team.invite.linkTitle)).toBeVisible({
    timeout: 15_000,
  });

  // Le champ lien contient bien un lien d'acceptation avec token.
  const linkInput = page.getByLabel(messages.settings.team.invite.linkLabel);
  await expect(linkInput).toHaveValue(/\/invitation\/accept\?token=/, { timeout: 15_000 });

  // Bouton copier présent.
  await expect(
    page.getByRole('button', { name: messages.settings.team.invite.copy }),
  ).toBeVisible();

  // Lien WhatsApp bien formé : wa.me + message encodé contenant le lien.
  const whatsapp = page.getByRole('link', { name: messages.settings.team.invite.whatsapp });
  await expect(whatsapp).toBeVisible();
  const href = await whatsapp.getAttribute('href');
  expect(href).toContain('https://wa.me/?text=');
  expect(href).toMatch(/invitation%2Faccept/);
});
