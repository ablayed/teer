import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './assert-local-supabase';
import { grantCurrentConsents } from './consent';

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

export const supabaseUrl =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  localEnv.SUPABASE_URL ??
  localEnv.NEXT_PUBLIC_SUPABASE_URL ??
  '';

const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? localEnv.SUPABASE_SERVICE_ROLE_KEY ?? '';

export const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);
export const e2ePassword = 'Mot-de-passe-e2e-2026!';

export type AdminClient = SupabaseClient;

export function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function e2eEmail(label: string): string {
  return `e2e+auth-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

type CreateE2EUserOptions = {
  userMetadata?: {
    full_name?: string;
    name?: string;
  };
};

export async function createConfirmedUser(
  admin: AdminClient,
  email: string,
  options?: CreateE2EUserOptions,
): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: e2ePassword,
    email_confirm: true,
    user_metadata: options?.userMetadata,
  });

  if (error || !data.user) {
    throw error ?? new Error('Utilisateur E2E non cree');
  }

  await grantCurrentConsents(admin, data.user.id);
  return data.user.id;
}

export async function createUnconfirmedUser(admin: AdminClient, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: e2ePassword,
    email_confirm: false,
  });

  if (error || !data.user) {
    throw error ?? new Error('Utilisateur E2E non cree');
  }

  await grantCurrentConsents(admin, data.user.id);
  return data.user.id;
}

export async function waitForMerchant(admin: AdminClient, userId: string): Promise<string> {
  let merchantAccountId = '';
  await expect
    .poll(
      async () => {
        const { data, error } = await admin
          .from('merchant_member')
          .select('merchant_account_id')
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle();

        if (error) {
          throw error;
        }

        merchantAccountId = (data?.merchant_account_id as string | undefined) ?? '';
        return merchantAccountId;
      },
      { timeout: 10_000, intervals: [150, 300, 500] },
    )
    .not.toBe('');
  return merchantAccountId;
}

export async function cleanupUsers(admin: AdminClient, userIds: string[]): Promise<void> {
  await Promise.all(userIds.map((userId) => admin.auth.admin.deleteUser(userId)));
}

export async function fillPasswordField(field: ReturnType<Page['locator']>, value: string) {
  await field.click({ clickCount: 3 });
  await field.pressSequentially(value);
  await expect(field).toHaveValue(value);
}

export async function loginViaForm(
  page: Page,
  email: string,
  password: string,
  redirectTo = '/tableau',
) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await fillPasswordField(page.locator('input[name="password"]'), password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
}
