import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import {
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  hasSupabaseAdmin,
  landOnTarget,
  loginViaForm,
  supabaseUrl,
  waitForMerchant,
} from './helpers/auth';

/**
 * Phase F — Lot U1-F, §6 : la page de démo est protégée par l'authentification existante,
 * réservée aux rôles propriétaire ou manager. Même pattern que tests/e2e/drivers.spec.ts
 * (`createOwnerFixture` + `addAgent` + assertion sur le message de restriction déjà utilisé par
 * app/(app)/livreurs/page.tsx).
 */

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, userIds: [userId] };
}

async function addAgent(admin: AdminClient, merchantAccountId: string) {
  const email = e2eEmail('agent');
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin.from('merchant_member').insert({
    merchant_account_id: merchantAccountId,
    role: 'agent',
    user_id: userId,
  });
  return { email, userId };
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await loginViaForm(page, email, e2ePassword, redirectTo);
  await landOnTarget(page, redirectTo, 30_000);
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
}

test.setTimeout(60_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E');

test('owner : la page de démo est accessible', async ({ page }) => {
  const fixture = await createOwnerFixture('u1f-owner');

  try {
    await signIn(page, fixture.email, '/dev/finance-foundations');
    await expect(page.getByTestId('finance-foundations-demo')).toBeVisible();
    await expect(
      page.getByText('Cette section est réservée au propriétaire et aux managers.'),
    ).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});

test('agent : la page de démo reste inaccessible (RBAC owner/manager)', async ({ page }) => {
  const fixture = await createOwnerFixture('u1f-agent-rbac');
  const agent = await addAgent(fixture.admin, fixture.merchantAccountId);

  try {
    await signIn(page, agent.email, '/dev/finance-foundations');
    await expect(
      page.getByText('Cette section est réservée au propriétaire et aux managers.'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('finance-foundations-demo')).toHaveCount(0);
  } finally {
    await cleanupUsers(fixture.admin, [...fixture.userIds, agent.userId]);
  }
});
