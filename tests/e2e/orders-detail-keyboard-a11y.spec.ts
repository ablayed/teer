import { expect, test } from '@playwright/test';
import {
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  hasSupabaseAdmin,
  landOnTarget,
  loginViaForm,
  waitForMerchant,
} from './helpers/auth';

// UX-COD-01 §3/§6 — passage Tab complet sur la fiche Commande reorganisee, a
// 1280px (poste de travail). Exige que le NAVIGATEUR tranche (activeElement
// reel apres chaque Tab), pas une relecture du JSX : deux bugs mobiles de ce
// lot (Retour perdant les query params, backdrop du Drawer masquant le bouton
// primaire) ont deja ete manques par le seul raisonnement statique.
//
// Verifie : (1) chaque cible interactive de l'en-tete/rail d'actions
// rapides/action du stade actuel est atteignable au clavier dans un ordre
// document coherent (haut -> bas) ; (2) chaque cible recoit un style de focus
// visible (outline non supprime) ; (3) aucune de ces cibles n'est un element
// non interactif (div/span) qui ne serait actionnable qu'au survol.

test.setTimeout(90_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour cet E2E');
test.use({ viewport: { width: 1280, height: 900 } });

async function markOnboarded(admin: ReturnType<typeof adminClient>, merchantAccountId: string) {
  const { error } = await admin
    .from('merchant_account')
    .update({ onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  if (error) throw error;
}

async function seedCallableOrder(admin: ReturnType<typeof adminClient>, merchantAccountId: string) {
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Client Clavier Test',
      phone: '+221771234567',
    })
    .select('id')
    .single();
  if (customerError) throw customerError;

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      customer_id: customer.id,
      order_number: `E2E-KBD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: 12000,
      currency: 'XOF',
      items_summary: [{ title: 'Article clavier', sku: 'KBD-1', quantity: 1, price: 12000 }],
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
    })
    .select('id, cod_status')
    .single();
  if (orderError) throw orderError;
  return order;
}

type FocusSnapshot = {
  hasVisibleOutline: boolean;
  label: string;
  tag: string;
};

async function focusSnapshot(page: import('@playwright/test').Page): Promise<FocusSnapshot | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) {
      return null;
    }
    const style = window.getComputedStyle(el);
    const hasVisibleOutline =
      style.outlineStyle !== 'none' &&
      style.outlineWidth !== '0px' &&
      style.outlineColor !== 'transparent';
    return {
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '',
      hasVisibleOutline,
    };
  });
}

test('passage Tab complet sur la fiche reorganisee a 1280px : ordre, focus visible, cibles reelles', async ({
  page,
}) => {
  const admin = adminClient();
  const email = e2eEmail('kbd-fiche');
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await markOnboarded(admin, merchantAccountId);

  try {
    const order = await seedCallableOrder(admin, merchantAccountId);
    expect(order.cod_status).toBe('A_APPELER');

    await loginViaForm(page, email, e2ePassword, `/commandes/${order.id}`);
    await landOnTarget(page, `/commandes/${order.id}`);

    // En mode "page" (>= md), pas de dialog : le panneau est la page elle-meme.
    await expect(page.getByRole('heading', { name: 'Client Clavier Test' })).toBeVisible({
      timeout: 15_000,
    });

    // Le libelle de "l'action du stade actuel" depend du catalogue de transitions
    // (premier item legal de `transitionMenuOrder`, pas necessairement
    // "journaliser_appel" — un role owner peut aussi voir "annuler" legal des
    // A_APPELER). On le lit depuis le DOM plutot que de le deviner, pour ne pas
    // coupler ce test au catalogue.
    const primaryButton = page.getByTestId('primary-transition-action');
    await expect(primaryButton).toBeVisible({ timeout: 15_000 });
    const primaryLabel = (await primaryButton.textContent())?.trim() ?? '';
    expect(primaryLabel.length, 'action du stade actuel introuvable').toBeGreaterThan(0);

    // Cibles attendues, dans l'ordre document reel du JSX (header -> quick
    // actions -> action du stade actuel -> corps). "Retour" est un <Link>
    // ici (entree directe /commandes/[id], hors interception).
    const expectedLabels = ['Retour', 'Appeler', 'Message client', primaryLabel];

    const seen: FocusSnapshot[] = [];
    // On part du body puis on avance jusqu'a couvrir les 4 cibles attendues.
    // La nav de shell (skip link + liens Tableau/Commandes/.../Boutiques,
    // hors perimetre de ce lot UX-COD-01) precede le contenu de la page dans
    // l'ordre document : marge large pour la traverser sans coupler ce test
    // a son nombre exact d'items.
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press('Tab');
      const snapshot = await focusSnapshot(page);
      if (snapshot) {
        seen.push(snapshot);
      }
      if (
        seen.length >= expectedLabels.length &&
        expectedLabels.every((l) => seen.some((s) => s.label === l))
      ) {
        break;
      }
    }

    for (const label of expectedLabels) {
      const match = seen.find((s) => s.label === label);
      expect(
        match,
        `cible "${label}" jamais atteinte au Tab parmi [${seen.map((s) => s.label).join(', ')}]`,
      ).toBeTruthy();
      // Cible interactive native (a/button), jamais un div/span cliquable au survol seul.
      expect(['a', 'button'], `"${label}" doit etre <a>/<button>, recu <${match?.tag}>`).toContain(
        match?.tag,
      );
      expect(match?.hasVisibleOutline, `"${label}" n'a pas d'outline de focus visible`).toBe(true);
    }

    // Ordre document : chaque cible attendue apparait dans "seen" au moins
    // dans l'ordre relatif attendu (pas d'inversion header <-> corps).
    const indices = expectedLabels.map((label) => seen.findIndex((s) => s.label === label));
    for (let i = 1; i < indices.length; i += 1) {
      expect(
        indices[i],
        `"${expectedLabels[i]}" doit suivre "${expectedLabels[i - 1]}" dans l'ordre Tab`,
      ).toBeGreaterThan(indices[i - 1]);
    }

    // Le declencheur du menu de debordement (ChevronDown) n'existe que s'il y
    // a plus d'une transition legale ; A_APPELER n'en a qu'une ("À rappeler"
    // est ici la seule action visible aux cotes de "journaliser_appel"/
    // "confirmer" selon le catalogue), donc pas de bouton overflow attendu
    // dans ce scenario — non verifie ici pour ne pas coupler le test a un
    // detail du catalogue de transitions qui peut evoluer independamment.
  } finally {
    await cleanupUsers(admin, [userId]);
  }
});
