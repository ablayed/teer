import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { createTestPostgresClient } from '../helpers/postgres-client';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { grantCurrentConsents } from './helpers/consent';

// 0162 — parcours applicatifs de l'équipe, sous la garde du dernier owner.
//
// Le retrait et le changement de rôle passent par le client service-role de
// `lib/actions/team.ts` : ils doivent continuer d'aboutir une fois les écritures de session
// fermées. Le troisième test joue la course que le décompte applicatif ne voit pas : la base
// refuse, et l'écran nomme le refus au lieu d'afficher l'erreur générique.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'Mot-de-passe-e2e-2026!';
const team = messages.settings.team;

test.setTimeout(90_000);
test.skip(!supabaseUrl || !serviceRoleKey, 'Variables Supabase admin manquantes');

type AdminClient = SupabaseClient;
type Role = 'owner' | 'manager' | 'agent';

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+equipe-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createConfirmedUser(admin: AdminClient, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  if (error || !data.user) throw error ?? new Error('Utilisateur E2E non créé');
  await grantCurrentConsents(admin, data.user.id);
  return data.user.id;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(`owner-${label}`);
  const ownerUserId = await createConfirmedUser(admin, email);
  let merchantAccountId = '';
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('merchant_account')
          .select('id')
          .eq('owner_user_id', ownerUserId)
          .maybeSingle();
        merchantAccountId = (data?.id as string | undefined) ?? '';
        return merchantAccountId;
      },
      { intervals: [150, 300, 500], timeout: 10_000 },
    )
    .not.toBe('');
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, ownerUserId };
}

/** Utilisateur neuf, sorti de son compte d'inscription, ajouté au compte de la fixture. */
async function addMember(admin: AdminClient, merchantAccountId: string, role: Role, label: string) {
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const left = await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  if (left.error) throw left.error;
  const joined = await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId })
    .select('id')
    .single();
  if (joined.error || !joined.data) throw joined.error ?? new Error('Membre E2E non créé');
  return { email, memberId: joined.data.id as string, userId };
}

async function openTeam(page: Page, email: string) {
  await page.goto('/connexion?redirectTo=/parametres');
  const emailInput = page.getByLabel(messages.auth.email_label, { exact: true });
  const passwordInput = page.getByLabel(messages.auth.password_label, { exact: true });
  await expect(emailInput).toBeVisible({ timeout: 30_000 });
  await emailInput.click();
  await emailInput.pressSequentially(email);
  await passwordInput.click();
  await passwordInput.pressSequentially(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await page.waitForURL('**/parametres', { timeout: 45_000 });
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('tab', { name: messages.settings.tabs.team }).click();
}

function memberRow(page: Page, email: string) {
  return page
    .locator('div')
    .filter({ has: page.getByRole('combobox', { name: team.members.roleAria }) })
    .filter({ hasText: email })
    .last();
}

test('un owner change le rôle d’un membre : la base porte le nouveau rôle', async ({ page }) => {
  const fixture = await createOwnerFixture('role');
  const agent = await addMember(fixture.admin, fixture.merchantAccountId, 'agent', 'agent-role');

  await openTeam(page, fixture.email);
  const row = memberRow(page, agent.email);
  await expect(row).toBeVisible({ timeout: 45_000 });
  await row.getByRole('combobox', { name: team.members.roleAria }).selectOption('manager');

  await expect(page.getByText(team.notices.roleChanged)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const { data } = await fixture.admin
        .from('merchant_member')
        .select('role')
        .eq('id', agent.memberId)
        .maybeSingle();
      return data?.role;
    })
    .toBe('manager');
});

test('un owner retire un membre : la ligne disparaît, le compte garde son owner', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('retrait');
  const agent = await addMember(fixture.admin, fixture.merchantAccountId, 'agent', 'agent-retrait');

  await openTeam(page, fixture.email);
  const row = memberRow(page, agent.email);
  await expect(row).toBeVisible({ timeout: 45_000 });
  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: team.members.remove }).click();

  await expect(page.getByText(team.notices.memberRemoved)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const { data } = await fixture.admin
        .from('merchant_member')
        .select('user_id, role')
        .eq('merchant_account_id', fixture.merchantAccountId);
      return (data ?? []).map((member) => `${member.user_id}:${member.role}`);
    })
    .toEqual([`${fixture.ownerUserId}:owner`]);
});

test('course sur le dernier owner : la base refuse, l’écran nomme le refus', async ({ page }) => {
  const fixture = await createOwnerFixture('course');
  const second = await addMember(fixture.admin, fixture.merchantAccountId, 'owner', 'owner-b');

  await openTeam(page, fixture.email);
  const row = memberRow(page, second.email);
  await expect(row).toBeVisible({ timeout: 45_000 });

  // Un retrait concurrent du premier owner est en vol, non validé : il tient le verrou du
  // compte. Le décompte applicatif voit encore deux owners et laisse passer la rétrogradation.
  const rival = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
    connectionTimeoutMillis: 10_000,
  });
  const observer = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
    connectionTimeoutMillis: 10_000,
  });
  await Promise.all([rival.connect(), observer.connect()]);
  try {
    await rival.query('begin');
    await rival.query(
      'delete from public.merchant_member where merchant_account_id = $1 and user_id = $2',
      [fixture.merchantAccountId, fixture.ownerUserId],
    );

    await row.getByRole('combobox', { name: team.members.roleAria }).selectOption('manager');

    // La rétrogradation attend le verrou : c'est bien la base qui arbitre.
    await expect
      .poll(
        async () => {
          const { rows } = await observer.query(
            `select count(*)::int as waiting from pg_stat_activity
              where wait_event_type = 'Lock' and query ilike '%merchant_member%'
                and pid <> pg_backend_pid()`,
          );
          return rows[0].waiting;
        },
        { intervals: [100, 200, 400], timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    await rival.query('commit');

    await expect(page.getByText(team.errors.last_owner)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(team.errors.generic)).toHaveCount(0);
    const { data } = await fixture.admin
      .from('merchant_member')
      .select('user_id, role')
      .eq('merchant_account_id', fixture.merchantAccountId);
    expect((data ?? []).map((member) => `${member.user_id}:${member.role}`)).toEqual([
      `${second.userId}:owner`,
    ]);
  } finally {
    await rival.query('rollback').catch(() => undefined);
    await Promise.all([rival.end(), observer.end()]);
  }
});
