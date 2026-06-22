import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
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
const password = 'Mot-de-passe-e2e-2026!';

test.setTimeout(90_000);

type AdminClient = SupabaseClient;
type Role = 'owner' | 'manager' | 'agent';

function adminClient(): AdminClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+phase8-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('Utilisateur E2E non cree');
  await grantCurrentConsents(admin, data.user.id);
  return data.user.id;
}

async function waitForMerchant(admin: AdminClient, userId: string) {
  for (let i = 0; i < 20; i += 1) {
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

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Teer E2E Phase8 ${label}`, onboarded_at: new Date().toISOString() })
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
  await Promise.all(userIds.map((userId) => admin.auth.admin.deleteUser(userId)));
}

async function signIn(page: Page, email: string, redirectTo = '/assistant') {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await page.waitForLoadState('domcontentloaded');
}

// Repères textuels (extraits de lib/ia/faq.ts) — role-aware.
const FAQ_MARGE = 'marge brute et le résultat net'; // minRole owner
const FAQ_CA = 'est-il calculé'; // minRole manager
const FAQ_COD = 'commande COD'; // minRole agent (tous)
const SUGGESTION_MARGE = 'marge brute ce mois'; // suggestion owner

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E assistant');

test('owner : onglet Assistant, FAQ marge + résultat net et suggestion marge', async ({ page }) => {
  const fixture = await createOwnerFixture('assistant-owner');
  try {
    await signIn(page, fixture.email, '/assistant');

    await expect(page.getByRole('heading', { name: messages.assistant.title })).toBeVisible({
      timeout: 15_000,
    });

    // Densité #1 : l'Assistant est regroupé dans le menu « Plus » de la bottom-nav sur
    // mobile (barre latérale sur desktop). On ouvre « Plus » s'il est présent, puis on
    // prouve que le lien Assistant reste atteignable ET fonctionnel (clic → navigation).
    const plusButton = page.getByRole('button', { name: 'Plus' });
    if (await plusButton.isVisible().catch(() => false)) {
      await plusButton.click();
    }
    const assistantLink = page
      .getByRole('link', { name: messages.nav.assistant, exact: true })
      .first();
    await expect(assistantLink).toBeVisible({ timeout: 15_000 });
    await assistantLink.click();
    await expect(page.getByRole('heading', { name: messages.assistant.title })).toBeVisible({
      timeout: 15_000,
    });

    // Onglet chat (par défaut) : suggestion finance réservée à l'owner.
    await expect(page.getByText(SUGGESTION_MARGE)).toBeVisible({ timeout: 15_000 });

    // Onglet FAQ : l'entrée marge/résultat net est visible pour l'owner.
    await page.getByRole('tab', { name: 'FAQ' }).click();
    await expect(page.getByText(FAQ_MARGE)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(FAQ_CA)).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('manager : FAQ CA visible mais PAS la marge ; pas de suggestion marge', async ({ page }) => {
  const fixture = await createOwnerFixture('assistant-manager');
  const manager = await addMember(fixture, 'manager');
  try {
    await signIn(page, manager.email, '/assistant');
    await expect(page.getByRole('heading', { name: messages.assistant.title })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByText(SUGGESTION_MARGE)).toHaveCount(0);

    await page.getByRole('tab', { name: 'FAQ' }).click();
    await expect(page.getByText(FAQ_CA)).toBeVisible();
    await expect(page.getByText(FAQ_MARGE)).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('agent : aucune entrée finance (ni CA ni marge), FAQ opérationnelle visible', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('assistant-agent');
  const agent = await addMember(fixture, 'agent');
  try {
    await signIn(page, agent.email, '/assistant');
    await expect(page.getByRole('heading', { name: messages.assistant.title })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByText(SUGGESTION_MARGE)).toHaveCount(0);

    await page.getByRole('tab', { name: 'FAQ' }).click();
    await expect(page.getByText(FAQ_COD)).toBeVisible();
    await expect(page.getByText(FAQ_CA)).toHaveCount(0);
    await expect(page.getByText(FAQ_MARGE)).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('conversation persistée : visible dans l’historique au chargement', async ({ page }) => {
  const fixture = await createOwnerFixture('assistant-persist');
  const title = `Conversation E2E ${Date.now()}`;
  try {
    await fixture.admin.from('ia_conversation').insert({
      merchant_account_id: fixture.merchantAccountId,
      user_id: fixture.ownerUserId,
      title,
    });
    await signIn(page, fixture.email, '/assistant');
    await expect(page.getByRole('button', { name: title })).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
