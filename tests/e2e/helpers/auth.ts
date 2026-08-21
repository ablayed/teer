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
 * Depuis Phase 1, `signInAction` renvoie vers `/s?next=…`. Avec une seule
 * boutique, ce point d'entrée préserve le chemin complet ; avec plusieurs, il
 * attend un choix explicite puis réduit `next` à sa section routable. Cette
 * fonction ne convient donc toujours pas aux specs qui observent ce mécanisme.
 *
 * On rejoue donc la cible telle quelle. Une URL legacy est rendue EN PLACE avec
 * la boutique par défaut (`getRequestStoreId`), soit exactement le comportement
 * d'avant Phase 1 — la spec mesure de nouveau ce qu'elle mesurait.
 *
 * Critère de vulnérabilité (pas une liste de fichiers, un fait à vérifier pour
 * CHAQUE spec) : atterrir sur `/s?next=…` ne bloque QUE si les DEUX conditions
 * sont réunies à la fois — (a) l'utilisateur qui se connecte a deux boutiques
 * actives ou plus, ET (b) la cible passée est une route bare/legacy (pas déjà
 * `/s/{id}/…`). `/s` n'attend un choix explicite que sous (a) ; sans (a), une
 * seule boutique déclenche une redirection SERVEUR immédiate quelle que soit la
 * cible. Créer une 2ᵉ boutique n'est donc jamais fautif en soi — seule la
 * combinaison avec un `signIn`/`landOnTarget` appelé sur une cible bare AVANT
 * que cette 2ᵉ boutique n'existe encore protège une spec ; l'appeler APRÈS,
 * avec 2 boutiques déjà posées, expose le même blocage que celui corrigé ici.
 *
 * Critère de non-usage (même logique : un fait sur le SUJET du test, pas une
 * liste de fichiers) : à ne pas utiliser quand l'assertion de la spec porte sur
 * le mécanisme d'entrée lui-même — `/s`, son sélecteur, ou la chaîne de
 * redirection — puisqu'atterrir au-delà invaliderait précisément ce qui est
 * observé. Dans tout autre spec, `/s?next=…` n'est qu'une amorce de connexion
 * hors sujet, et cette fonction sert à la traverser.
 */
export async function landOnTarget(page: Page, target: string, timeout = 60_000) {
  // Motif canonique `/s/{id}/…` : le hop intermédiaire `/s?next=…` a pour
  // pathname exactement `/s` (rien après le slash), il ne matche donc jamais
  // ce motif — contrairement à `!pathname.startsWith('/connexion')`, satisfait
  // dès CE hop, avant que la redirection finale n'ait committé (résolution
  // prématurée = source des « navigation interrupted »/doubles `main#main`
  // observés en CI). Motif volontairement SANS forme d'identifiant (pas de
  // regex UUID) : une évolution du format d'id ne casse pas silencieusement ce
  // prédicat, l'échec resterait un timeout lisible.
  await page.waitForURL((url) => /^\/s\/[^/]+/.test(url.pathname), { timeout });

  const current = new URL(page.url());
  const expected = new URL(target, current.origin);

  // Comparaison normalisée, préfixe `/s/{id}` retiré des DEUX côtés : `current`
  // le porte toujours (on vient de l'attendre ci-dessus), `target` ne le porte
  // quasiment jamais (routes bare/legacy passées par les appelants). Sans cette
  // normalisation, les pathnames divergent à CHAQUE appel et le repli
  // ci-dessous se déclenche systématiquement — atterrissant sur l'URL legacy
  // plutôt que l'URL canonique réellement obtenue en production, ET créant une
  // navigation concurrente à la redirection qui vient tout juste de committer.
  const stripStorePrefix = (pathname: string) => pathname.replace(/^\/s\/[^/]+/, '') || '/';
  const currentSection = stripStorePrefix(current.pathname);
  const expectedSection = stripStorePrefix(expected.pathname);

  if (currentSection !== expectedSection || current.search !== expected.search) {
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
