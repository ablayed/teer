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
 * Phase F — Lot U1-F, garde de classe (pas d'instance) sur le bug trouvé en revue :
 * `ScopedMetricCard` appliquait `truncate` (overflow:hidden + text-overflow:ellipsis) à son
 * montant — « 1 539 116 F ... » au lieu du montant complet. jsdom n'applique pas le CSS réel
 * (voir tests/unit/ui/*) : seul un navigateur réel peut prouver qu'aucun ancêtre d'un montant
 * n'a `text-overflow: ellipsis`.
 *
 * Généralisé à TOUT `[data-testid="amount"]` de la page de démo, pas seulement ScopedMetricCard —
 * si un futur composant de components/ui/ répète l'erreur, ce test le détecte sans modification.
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

test('aucun ancêtre d’un montant ne porte overflow:hidden + text-overflow:ellipsis, à 380px', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('u1f-money-truncation');

  try {
    await loginViaForm(page, fixture.email, e2ePassword, '/dev/finance-foundations');
    await landOnTarget(page, '/dev/finance-foundations', 30_000);
    await expect(page.getByTestId('finance-foundations-demo')).toBeVisible({ timeout: 45_000 });
    // Largeur délibérément étroite : c'est à cette largeur que le bug (carte ScopedMetricCard à
    // 220px) s'est manifesté en revue.
    await page.setViewportSize({ width: 380, height: 900 });

    const violations = await page.evaluate(() => {
      const found: Array<{ text: string; ancestorTag: string; ancestorClass: string }> = [];
      for (const amountEl of Array.from(document.querySelectorAll('[data-testid="amount"]'))) {
        let node: Element | null = amountEl;
        let depth = 0;
        while (node && depth < 8) {
          const style = getComputedStyle(node);
          if (style.textOverflow === 'ellipsis') {
            found.push({
              text: amountEl.textContent ?? '',
              ancestorTag: node.tagName,
              ancestorClass: node.className.toString(),
            });
          }
          node = node.parentElement;
          depth += 1;
        }
      }
      return found;
    });

    expect(violations).toEqual([]);
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
