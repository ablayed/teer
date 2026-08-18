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

/**
 * Atterrissage sur la cible EXACTE une fois la session posée.
 *
 * Depuis Phase 1, `signInAction` renvoie vers `/s?next=…`. Ce point d'entrée
 * réduit `next` à une SECTION (`resolveWorkspaceSection`) : une query
 * (`?from=…`), un identifiant de ressource (`/commandes/{id}`) ou une route hors
 * sections (`/dev/primitives`) ne survivent pas au passage. Et dès DEUX
 * boutiques, `/s` attend un choix explicite qui ne viendra jamais dans un test
 * dont ce n'est pas le sujet : la connexion s'y gare, et le `waitForURL` de la
 * spec expire sur une cible qu'aucune redirection n'atteindra.
 *
 * On rejoue donc la cible telle quelle. Une URL legacy est rendue EN PLACE avec
 * la boutique par défaut (`getRequestStoreId`), soit exactement le comportement
 * d'avant Phase 1 — la spec mesure de nouveau ce qu'elle mesurait.
 *
 * À NE PAS utiliser dans les specs qui vérifient le parcours d'entrée lui-même
 * (`workspace-store-control`, `workspace-routing`, `shop-filter`) : elles
 * doivent observer `/s` et son sélecteur.
 */
export async function landOnTarget(page: Page, target: string, timeout = 60_000) {
  // On attend seulement d'avoir QUITTÉ /connexion : la destination réelle
  // dépend du nombre de boutiques et n'est pas connue de l'appelant.
  await page.waitForURL((url) => !url.pathname.startsWith('/connexion'), { timeout });

  const current = new URL(page.url());
  const expected = new URL(target, current.origin);
  if (current.pathname !== expected.pathname || current.search !== expected.search) {
    await page.goto(target);
  }
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
