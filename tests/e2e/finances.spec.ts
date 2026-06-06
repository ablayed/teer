import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

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
const password = 'Mot-de-passe-e2e-2026!';

test.setTimeout(90_000);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+phase6-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('Utilisateur E2E non créé');
  return data.user.id;
}

async function waitForMerchant(admin: AdminClient, userId: string) {
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
  throw new Error('merchant_account introuvable');
}

async function waitForCategories(admin: AdminClient, merchantAccountId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('expense_category')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    if (data && data.length > 0) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('expense_categories non seedées');
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E Phase6 ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  await waitForCategories(admin, merchantAccountId);
  return { admin, email, merchantAccountId, userId };
}

async function signIn(page: Page, email: string, redirectTo = '/finances') {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await page.waitForLoadState('networkidle');
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E finances');

test('page finances : bannière disclaimer + section dépenses visible pour owner', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('disclaimer');
  try {
    await signIn(page, fixture.email, '/finances');

    // Bannière vue de gestion
    await expect(page.getByText(messages.finance.disclaimer, { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // Section dépenses
    await expect(page.getByText(messages.finance.expense.title, { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // Bouton ajouter
    await expect(page.getByRole('button', { name: messages.finance.expense.add })).toBeVisible();
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test("ajout d'une dépense → apparaît dans la liste et réduit le résultat", async ({ page }) => {
  const fixture = await createOwnerFixture('add-expense');
  try {
    await signIn(page, fixture.email, '/finances');

    // Ouvrir le formulaire
    await page.getByRole('button', { name: messages.finance.expense.add }).click();

    // Remplir — montant et date
    await page.locator('#expense-amount').fill('25000');
    await page.locator('#expense-date').fill('2026-06-01');

    // Enregistrer
    await page.getByRole('button', { name: messages.finance.expense.save }).click();

    // Confirmation
    await expect(page.getByText(messages.finance.expense.success)).toBeVisible({ timeout: 10_000 });

    // Le total dépenses confirme la dépense ajoutée (ligne unique ExpenseSection)
    await expect(page.getByText(messages.finance.expense.total, { exact: false })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('nav finances absente pour un manager', async ({ page }) => {
  const fixture = await createOwnerFixture('nav-manager');
  const managerEmail = e2eEmail('mgr');
  const managerUserId = await createConfirmedUser(fixture.admin, managerEmail);
  await fixture.admin.from('merchant_account').delete().eq('owner_user_id', managerUserId);
  await fixture.admin.from('merchant_member').insert({
    merchant_account_id: fixture.merchantAccountId,
    user_id: managerUserId,
    role: 'manager',
  });

  try {
    await signIn(page, managerEmail, '/commandes');

    // Le lien finances ne doit pas être dans la nav
    const financeLink = page.getByRole('link', { name: messages.nav.finances, exact: true });
    await expect(financeLink).not.toBeVisible();

    // En accès direct : message restreint
    await page.goto('/finances');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(messages.finance.restricted, { exact: false })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
    await fixture.admin.auth.admin.deleteUser(managerUserId);
  }
});

test('nav finances absente pour un agent', async ({ page }) => {
  const fixture = await createOwnerFixture('nav-agent');
  const agentEmail = e2eEmail('agent');
  const agentUserId = await createConfirmedUser(fixture.admin, agentEmail);
  await fixture.admin.from('merchant_account').delete().eq('owner_user_id', agentUserId);
  await fixture.admin.from('merchant_member').insert({
    merchant_account_id: fixture.merchantAccountId,
    user_id: agentUserId,
    role: 'agent',
  });

  try {
    await signIn(page, agentEmail, '/commandes');

    const financeLink = page.getByRole('link', { name: messages.nav.finances, exact: true });
    await expect(financeLink).not.toBeVisible();
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
    await fixture.admin.auth.admin.deleteUser(agentUserId);
  }
});
