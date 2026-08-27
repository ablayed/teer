import { expect, test } from '@playwright/test';
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
 * Phase F — Lot U1-F, preuve 5.4 : « Mesurer, dans le style du composant Montant, que 111111 et
 * 888888 occupent la même largeur. » jsdom ne fait pas de layout réel (voir tests/unit/ui/*) —
 * seule une mesure en navigateur réel (Playwright, déjà présent dans le dépôt, aucune nouvelle
 * dépendance) prouve quoi que ce soit ici. Si les largeurs diffèrent, ce test échoue
 * délibérément : le rapport de fin de lot doit alors constater que les chiffres tabulaires ne
 * sont pas obtenus avec la police actuelle, sans changer de police.
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

test.setTimeout(60_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E');

test('chiffres tabulaires : 111111 et 888888 occupent la même largeur', async ({ page }) => {
  const fixture = await createOwnerFixture('u1f-tabular-nums');

  try {
    await loginViaForm(page, fixture.email, e2ePassword, '/dev/finance-foundations');
    await landOnTarget(page, '/dev/finance-foundations', 30_000);
    await expect(page.getByTestId('finance-foundations-demo')).toBeVisible({ timeout: 45_000 });

    const narrow = page.getByTestId('tabular-nums-111111');
    const wide = page.getByTestId('tabular-nums-888888');
    await expect(narrow).toBeVisible();
    await expect(wide).toBeVisible();

    const narrowBox = await narrow.boundingBox();
    const wideBox = await wide.boundingBox();

    expect(narrowBox).not.toBeNull();
    expect(wideBox).not.toBeNull();

    // biome-ignore lint/style/noNonNullAssertion: vérifié juste au-dessus.
    const widthDelta = Math.abs(narrowBox!.width - wideBox!.width);

    // Sous-pixel toléré (arrondi de rendu du navigateur) — pas une marge d'approximation sur la
    // règle elle-même. Un écart d'un pixel ou plus signifie que les chiffres ne sont PAS
    // tabulaires avec la police actuelle.
    expect(widthDelta).toBeLessThan(1);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
