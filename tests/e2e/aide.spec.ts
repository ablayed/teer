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
const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);
const password = 'Mot-de-passe-e2e-aide-2026!';

test.setTimeout(90_000);

type AdminClient = SupabaseClient;
type Role = 'owner' | 'manager' | 'agent';

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+aide-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('Utilisateur E2E non créé');
  await grantCurrentConsents(admin, data.user.id);
  return data.user.id;
}

async function waitForMerchant(admin: AdminClient, userId: string) {
  let merchantAccountId = '';
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('merchant_member')
          .select('merchant_account_id')
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle();
        merchantAccountId = (data?.merchant_account_id as string | undefined) ?? '';
        return merchantAccountId;
      },
      { timeout: 10_000, intervals: [150, 300, 500] },
    )
    .not.toBe('');
  return merchantAccountId;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Teer E2E Aide ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, ownerUserId: userId, userIds: [userId] };
}

async function addMember(fixture: Awaited<ReturnType<typeof createOwnerFixture>>, role: Role) {
  const email = e2eEmail(role);
  const userId = await createConfirmedUser(fixture.admin, email);
  await fixture.admin.from('merchant_account').delete().eq('owner_user_id', userId);
  const { error } = await fixture.admin.from('merchant_member').insert({
    merchant_account_id: fixture.merchantAccountId,
    role,
    user_id: userId,
  });
  if (error) throw error;
  fixture.userIds.push(userId);
  return { email, userId };
}

async function cleanupUsers(admin: AdminClient, userIds: string[]) {
  await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)));
}

async function signIn(page: Page, email: string, redirectTo = '/assistant') {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await landOnTarget(page, redirectTo);
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E aide');

// ── Page /aide (= /assistant) ─────────────────────────────────────────────────

test('la page /assistant charge avec le titre Aide et les 3 tabs', async ({ page }) => {
  const fixture = await createOwnerFixture('aide-load');
  try {
    await signIn(page, fixture.email, '/assistant');
    await expect(page.getByRole('heading', { name: messages.assistant.title })).toBeVisible({
      timeout: 15_000,
    });
    // Les 3 tabs sont présents
    await expect(page.getByRole('tab', { name: messages.assistant.tab.faq })).toBeVisible();
    await expect(page.getByRole('tab', { name: messages.assistant.tab.chat })).toBeVisible();
    await expect(page.getByRole('tab', { name: messages.assistant.tab.contact })).toBeVisible();
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

// ── FAQ : recherche ───────────────────────────────────────────────────────────

test('FAQ : la recherche filtre les entrées', async ({ page }) => {
  const fixture = await createOwnerFixture('aide-search');
  try {
    await signIn(page, fixture.email, '/assistant');
    await page.getByRole('heading', { name: messages.assistant.title }).waitFor({
      timeout: 15_000,
    });

    const searchInput = page.getByPlaceholder(messages.assistant.faq.searchPlaceholder);
    await expect(searchInput).toBeVisible();

    // Rechercher "livreur" — doit retourner des résultats
    await searchInput.fill('livreur');
    await expect(page.getByRole('group', { name: 'Filtrer par catégorie' })).not.toBeVisible();
    // Au moins un résultat contenant "livreur"
    const details = page.locator('details');
    await expect(details.first()).toBeVisible({ timeout: 5_000 });

    // Vider la recherche — les pills catégories reviennent
    await searchInput.fill('');
    await expect(page.getByRole('group', { name: 'Filtrer par catégorie' })).toBeVisible();
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('FAQ : une recherche sans résultat affiche le CTA assistant', async ({ page }) => {
  const fixture = await createOwnerFixture('aide-no-results');
  try {
    await signIn(page, fixture.email, '/assistant');
    await page.getByRole('heading', { name: messages.assistant.title }).waitFor({
      timeout: 15_000,
    });

    const searchInput = page.getByPlaceholder(messages.assistant.faq.searchPlaceholder);
    // Terme absurde, aucun résultat attendu
    await searchInput.fill('xyzabsurde999teer');
    await expect(
      page.getByRole('button', { name: messages.assistant.faq.noResultsCta }),
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('FAQ : les pills de catégorie filtrent les entrées', async ({ page }) => {
  const fixture = await createOwnerFixture('aide-pills');
  try {
    await signIn(page, fixture.email, '/assistant');
    await page.getByRole('heading', { name: messages.assistant.title }).waitFor({
      timeout: 15_000,
    });

    // Cliquer sur la catégorie "Compte & équipe"
    const compteBtn = page.getByRole('button', {
      name: messages.support.categories['compte-equipe'],
    });
    await expect(compteBtn).toBeVisible({ timeout: 5_000 });
    await compteBtn.click();

    // Des entrées de la catégorie sont visibles
    const details = page.locator('details');
    await expect(details.first()).toBeVisible({ timeout: 5_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

// ── FAQ : filtrage par rôle ──────────────────────────────────────────────────

test("FAQ : une FAQ owner-only (finance-marge) n'est pas visible pour un agent", async ({
  page,
}) => {
  const fixture = await createOwnerFixture('aide-role-agent');
  const agent = await addMember(fixture, 'agent');
  try {
    await signIn(page, agent.email, '/assistant');
    await page.getByRole('heading', { name: messages.assistant.title }).waitFor({
      timeout: 15_000,
    });

    // L'entrée finance-marge (minRole owner) ne doit pas apparaître pour un agent
    await expect(page.getByText('marge brute et le résultat net')).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

// ── Contact : bouton WhatsApp conditionnel ────────────────────────────────────

test('Contact : le tab Contact est accessible et affiche le bouton signalement', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('aide-contact');
  try {
    await signIn(page, fixture.email, '/assistant');
    await page.getByRole('heading', { name: messages.assistant.title }).waitFor({
      timeout: 15_000,
    });

    await page.getByRole('tab', { name: messages.assistant.tab.contact }).click();
    await expect(
      page.getByRole('button', { name: messages.assistant.contact.reportBug }),
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

// ── Feedback dialog ──────────────────────────────────────────────────────────

test("Feedback : le dialog s'ouvre, on peut soumettre et recevoir un toast succès", async ({
  page,
}) => {
  const fixture = await createOwnerFixture('aide-feedback');
  try {
    await signIn(page, fixture.email, '/assistant');
    await page.getByRole('heading', { name: messages.assistant.title }).waitFor({
      timeout: 15_000,
    });

    // Ouvrir le tab Contact puis le dialog
    await page.getByRole('tab', { name: messages.assistant.tab.contact }).click();
    await page.getByRole('button', { name: messages.assistant.contact.reportBug }).click();

    // Le dialog est ouvert
    const dialog = page.getByRole('dialog', { name: messages.assistant.feedback.title });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Remplir le message — WebKit : pressSequentially pour les champs contrôlés
    const textarea = dialog.locator('textarea');
    await textarea.click({ clickCount: 3 });
    await textarea.pressSequentially('Ceci est un test de feedback depuis les E2E Playwright.');

    // Soumettre
    await dialog.getByRole('button', { name: messages.assistant.feedback.submit }).click();

    // Toast succès (le feedback est en DB même si email échoue)
    await expect(page.getByText(messages.assistant.feedback.successTitle)).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

// ── Checklist onboarding sur /tableau ────────────────────────────────────────

test('Checklist : visible pour un owner sans commandes', async ({ page }) => {
  const fixture = await createOwnerFixture('aide-checklist');
  // Le fresh owner n'a pas de commandes/livraisons/encaissements → steps 2-4 incomplètes → checklist visible.
  // Ne pas mettre onboarded_at=null : cela déclenche un redirect middleware vers /onboarding
  // qui empêche d'atteindre /tableau.

  try {
    await signIn(page, fixture.email, '/tableau');
    await expect(page.getByText(messages.onboarding.checklist.title)).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('Checklist : non visible pour un agent (owner/manager uniquement)', async ({ page }) => {
  const fixture = await createOwnerFixture('aide-checklist-agent');
  const agent = await addMember(fixture, 'agent');
  try {
    await signIn(page, agent.email, '/tableau');
    // Attendre le chargement de la page
    await page.waitForURL('**/tableau**', { timeout: 15_000 });
    await page.waitForTimeout(2_000);
    await expect(page.getByText(messages.onboarding.checklist.title)).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
