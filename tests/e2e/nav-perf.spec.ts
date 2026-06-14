/**
 * LOT PERF #4 — navigation perçue en 4G.
 *
 * Garde-fous déterministes (non flaky) sur les quick wins :
 *  A. `touch-action: manipulation` sur les éléments tappables de l'app → supprime le
 *     délai de tap ~300ms (la cause du « tap mort » qui pousse à re-taper).
 *  B. Indicateur de navigation « pending » (spinner via `useLinkStatus`) câblé dans
 *     chaque lien de la nav.
 *  C. Squelette `loading.tsx` affiché pendant la navigation vers une route dynamique.
 *     loading.tsx fonctionne aussi en `next dev` (frontière Suspense) — seul le
 *     prefetch/Router Cache est prod-only —, donc on ralentit volontairement la
 *     résolution de la route pour FORCER l'affichage du fallback, de façon fiable.
 */
import { existsSync, readFileSync } from 'node:fs';
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

test.setTimeout(60_000);

function adminClient(): SupabaseClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `e2e+navperf-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw error ?? new Error('Utilisateur E2E non créé');
  }
  const userId = data.user.id;
  await grantCurrentConsents(admin, userId);

  let merchantAccountId = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { data: member } = await admin
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (member?.merchant_account_id) {
      merchantAccountId = member.merchant_account_id as string;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);

  return { admin, email, merchantAccountId, userId };
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
  await page.waitForLoadState('networkidle');
}

// Lien de nav visible (sidebar sur desktop, bottom-tab sur mobile — les deux sont dans
// le DOM, un seul est visible selon le viewport). On cible par href, locale-agnostique.
function visibleNavLink(page: Page, href: string) {
  return page.locator(`a[href="${href}"]:visible`).first();
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E nav-perf');

test('A+B — feedback tap (touch-action) et indicateur pending câblés sur la nav', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('feedback');
  try {
    await signIn(page, fixture.email, '/commandes');

    const navLink = visibleNavLink(page, '/produits');
    await expect(navLink).toBeVisible();

    // A — `touch-action: manipulation` appliqué (supprime le délai de tap ~300ms).
    await expect(navLink).toHaveCSS('touch-action', 'manipulation');

    // B — l'indicateur de navigation pending (spinner) est présent dans le lien.
    await expect(navLink.locator('span.animate-spin')).toHaveCount(1);
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('C — la navigation vers une route dynamique affiche le squelette loading.tsx', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('skeleton');
  try {
    await signIn(page, fixture.email, '/commandes');

    // Ralentit la résolution de /produits pour garantir l'affichage du fallback
    // loading.tsx (sinon la navigation peut être trop rapide pour l'observer).
    await page.route('**/produits**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });

    await visibleNavLink(page, '/produits').click();

    // Le squelette (`dashboard-shimmer`) du loading.tsx apparaît pendant le chargement.
    await expect(page.locator('.dashboard-shimmer').first()).toBeVisible({ timeout: 3_000 });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});
