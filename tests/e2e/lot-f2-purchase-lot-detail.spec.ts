// Lot F2 — preuves E2E (Task 8) : responsive 412/390px sur la Fiche arrivage,
// file durable hors-ligne (poids de ligne), dépense publicitaire qui exige un
// arrivage explicite depuis la fiche produit.
//
// Convention de seed reprise de tests/rls/lot-f2-purchase-lot-profitability.rls.test.ts
// (aucun module de fixtures partagé dans ce dépôt, cf. son commentaire de tête) :
// on seed directement via un client admin (service-role) + un client supabase-js
// signé comme le owner pour les RPC `receive_purchase_lot`/`transition_order`
// (RLS owner-only), PUIS on navigue dans un vrai navigateur (page Playwright,
// session distincte via le formulaire de connexion) pour observer le rendu réel.
// C'est délibérément l'option (a) du brief Task 8 : reproduire EXACTEMENT le
// contrôle de référence chiffré (89 360 F / 21,9 %, arrivage du 27 avril) plutôt
// qu'un scénario simplifié — c'est la preuve n°1 exigée par la spec F2.
//
// GAP CORRIGÉ (voir aussi le rapport Task 8) : `initMutationQueueAutoFlush`
// (lib/offline/mutation-queue.ts) est désormais monté globalement via
// `components/offline/mutation-queue-provider.tsx` (`app/(app)/layout.tsx`,
// même convention que `AnalyticsProvider`). Un listener `online` est donc posé
// pour toute session authentifiée, ET une tentative de flush immédiate a lieu
// au montage (rattrape une mutation laissée par une session précédente, y
// compris juste après un `page.reload()` en ligne). Le test « file durable
// hors-ligne » ci-dessous prouve : la durabilité IndexedDB réelle (survit à un
// `page.reload()`), PUIS la reprise automatique réelle (sans aucune ressaisie
// utilisateur) dès que le réseau redevient disponible.

import { formatMoney } from '@/lib/format/fcfa';
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

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Client signé comme le owner, SEULEMENT pour les RPC RLS owner-only
// (`receive_purchase_lot`, `transition_order`) — jamais utilisé pour naviguer
// dans le navigateur (la session du navigateur passe par `loginViaForm`, une
// session HTTP/cookie distincte).
async function signInSupabaseJs(email: string): Promise<SupabaseClient> {
  assertLocalSupabase(supabaseUrl);
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: e2ePassword });
  if (error) throw error;
  return client;
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
  const shopId = await waitForDefaultShop(admin, merchantAccountId);
  return { admin, email, merchantAccountId, shopId, userIds: [userId], userId };
}

async function waitForDefaultShop(admin: AdminClient, merchantAccountId: string): Promise<string> {
  let shopId = '';
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('shop')
          .select('id')
          .eq('merchant_account_id', merchantAccountId)
          .eq('is_default', true)
          .limit(1)
          .maybeSingle();
        shopId = (data?.id as string | undefined) ?? '';
        return shopId;
      },
      { timeout: 10_000, intervals: [150, 300, 500] },
    )
    .not.toBe('');
  return shopId;
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await loginViaForm(page, email, e2ePassword, redirectTo);
  await landOnTarget(page, redirectTo, 30_000);
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
}

// Responsive : desktop rend product-catalog-card (bouton "Détails" inline),
// mobile rend product-catalog-row (menu "Actions — <titre>" à la place). Même
// motif que openDetails() dans tests/e2e/products-bundle-configuration.spec.ts
// (aucun module de fixtures partagé dans ce dépôt — cf. commentaire de tête).
// Absent ici avant correctif : timeout de 90s sur iphone-14/pixel-7 en CI
// (jamais chromium, qui rend toujours la carte desktop), le bouton "Détails"
// visé étant caché à l'accessibilité sur mobile.
async function openProductDetails(page: Page, productId: string, title: string) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Viewport Playwright requis pour ouvrir les détails produit');

  const isDesktop = viewport.width >= 768;
  const productRow = page.getByTestId(
    `${isDesktop ? 'product-catalog-card' : 'product-catalog-row'}-${productId}`,
  );
  await productRow.waitFor({ state: 'visible' });

  if (isDesktop) {
    await productRow.getByRole('button', { name: 'Détails', exact: true }).click();
    return;
  }

  await productRow.getByRole('button', { name: `Actions — ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Détails', exact: true }).click();
}

async function createProduct(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      title: `Produit F2 E2E ${Date.now()}`,
      unit_cost: 0,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id as string;
}

async function createDriver(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur F2 E2E ${Date.now()}`,
      phone: '+221770000000',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');
  await admin
    .from('driver_shop')
    .insert({ merchant_account_id: merchantAccountId, shop_id: shopId, driver_id: data.id });
  return data.id as string;
}

// ── RPC casts — database.types.ts ne connaît pas encore la migration 0146
// (appliquée en LOCAL uniquement, non poussée sur le linked — cf. CLAUDE.md
// header d'attestation). Même motif que lib/actions/purchases.ts et
// tests/rls/lot-f2-purchase-lot-profitability.rls.test.ts ; à retirer une fois
// `pnpm db:types` régénéré depuis le linked après le push de 0146.
type ReceiveRpcArgs = {
  p_lot_id: string;
  p_merchant_account_id: string;
  p_actor_id: string;
  p_lines: Array<{
    line_id: string;
    line_value: number;
    allocated_fees: number;
    landed_total_value: number;
    landed_unit_cost: number;
  }>;
};

function receiveRpc(client: SupabaseClient) {
  return client.rpc.bind(client) as unknown as (
    fn: 'receive_purchase_lot',
    args: ReceiveRpcArgs,
  ) => Promise<{ data: null; error: { message: string } | null }>;
}

type TransitionOrderArgs = {
  p_actor: string;
  p_order_id: string;
  p_call_state?: string;
  p_delivery_state?: string;
  p_order_state?: string;
  p_cash_state?: string;
  p_attempt_count?: number;
  p_payment_channel?: string;
};

function transitionRpc(client: SupabaseClient) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionOrderArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

async function receiveLot(
  admin: AdminClient,
  ownerRpcClient: SupabaseClient,
  merchantAccountId: string,
  shopId: string,
  userId: string,
  productId: string,
  supplierName: string,
  qtyReceived: number,
  purchasePriceTotal: number,
  transportTotal: number | null,
) {
  const { data: lot, error: lotErr } = await admin
    .from('purchase_lot')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      supplier_name: supplierName,
      ordered_at: '2026-04-01',
      transport_total: transportTotal,
    })
    .select('id')
    .single();
  if (lotErr || !lot) throw lotErr ?? new Error('purchase_lot insert failed');

  const { data: line, error: lineErr } = await admin
    .from('purchase_lot_line')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      purchase_lot_id: lot.id,
      product_id: productId,
      qty: qtyReceived,
      purchase_price_total: purchasePriceTotal,
    })
    .select('id')
    .single();
  if (lineErr || !line) throw lineErr ?? new Error('purchase_lot_line insert failed');

  const landedUnitCost = Math.floor(purchasePriceTotal / qtyReceived);
  const { error } = await receiveRpc(ownerRpcClient)('receive_purchase_lot', {
    p_lot_id: lot.id,
    p_merchant_account_id: merchantAccountId,
    p_actor_id: userId,
    p_lines: [
      {
        line_id: line.id,
        line_value: purchasePriceTotal,
        allocated_fees: 0,
        landed_total_value: purchasePriceTotal,
        landed_unit_cost: landedUnitCost,
      },
    ],
  });
  if (error) throw new Error(`receive_purchase_lot failed: ${error.message}`);

  return { lotId: lot.id as string, purchaseLotLineId: line.id as string };
}

async function createOrderWithLine(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  driverId: string,
  productId: string,
  qty: number,
  totalAmount: number,
) {
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_number: `F2E2E-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      total_amount: totalAmount,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      assigned_driver_id: driverId,
    })
    .select('id')
    .single();
  if (orderErr || !order) throw orderErr ?? new Error('order insert failed');

  const { error: lineErr } = await admin.from('order_line').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    order_id: order.id,
    product_id: productId,
    raw_title: 'Produit F2 E2E',
    qty,
    match_status: 'matched',
  });
  if (lineErr) throw lineErr;

  return order.id as string;
}

/** Confirmer → programmer → dispatch → livrer (encaissé). */
async function deliverAndCollect(client: SupabaseClient, userId: string, orderId: string) {
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_call_state: 'validated',
    p_attempt_count: 1,
  });
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'scheduled',
  });
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'out_for_delivery',
  });
  const delivered = await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'delivered',
    p_order_state: 'completed',
    p_cash_state: 'collected',
    p_payment_channel: 'ESPECES',
  });
  if (delivered.error)
    throw new Error(`transition_order (delivered) failed: ${delivered.error.message}`);
}

async function insertAdSpend(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  productId: string,
  purchaseLotId: string,
  userId: string,
  amountMinor: number,
  spentAt: string,
) {
  const { error } = await admin.from('product_ad_spend').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    product_id: productId,
    purchase_lot_id: purchaseLotId,
    amount_minor: amountMinor,
    spent_at: spentAt,
    source: 'manuel',
    created_by: userId,
  });
  if (error) throw error;
}

/** Ouvre la Fiche arrivage ("Voir la rentabilité") depuis /produits?tab=achats. */
async function openLotProfitabilityPanel(page: Page, supplierName: string) {
  await page.goto('/produits?tab=achats');
  // `exact: true` est nécessaire ici : un `getByText` non-exact matche à la fois
  // ce nom de fournisseur sur la carte de la liste ET le titre du panneau
  // "Rentabilité — {supplierName}" (le panneau reste monté dans le DOM, juste
  // masqué, avant tout clic) -> violation "strict mode" intermittente (~1 run/3
  // sur stack froide, reproduite via --repeat-each). L'intention ici est bien de
  // cibler la carte de la liste (attendre qu'elle soit rendue avant de cliquer),
  // jamais "n'importe quel élément contenant ce nom".
  await expect(page.getByText(supplierName, { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Voir la rentabilité' }).click();
  await expect(page.getByText(`Rentabilité — ${supplierName}`, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

// Le contrat réel du produit sur un montant, établi par
// tests/e2e/lot-u1f-money-no-truncation.spec.ts (ScopedMetricCard) : jamais de
// `text-overflow: ellipsis` sur un ancêtre — PAS "jamais de dépassement du
// viewport en pixels". `ScopedMetricCard` défile HORIZONTALEMENT à dessein
// (`overflow-x-auto whitespace-nowrap`, voir son commentaire) quand la carte
// est trop étroite pour un montant + une icône + un libellé d'état long
// ("~0 F CFA Transport pas encore facturé") plutôt que de le tronquer — un
// montant ainsi scrollable peut légitimement avoir une `boundingBox()` dont
// `x + width` dépasse la largeur du viewport (position de LAYOUT réelle,
// avant tout défilement), ce n'est pas un bug. Une version antérieure de ce
// test vérifiait à tort cette limite en pixels : elle échouait en CI Linux
// (fontes plus larges qu'en local Windows) sur des montants qui défilent
// correctement — pas des montants perdus.
function noOverflowAssertions(page: Page) {
  return async () => {
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    const amounts = page.locator('[data-testid="amount"]');
    const count = await amounts.count();
    expect(count).toBeGreaterThan(0);

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
  };
}

test.setTimeout(90_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E');

// ──────────────────────────────────────────────────────────────────────────
// Proof 9 (spec F2) — largeurs réelles 412px (pixel-7) ET 390px (iphone-14),
// reproduites via test.use({viewport}) plutôt que via --project, pour que la
// commande de jugement locale (`--project=chromium`, cf. CLAUDE.md) exécute
// réellement ces deux largeurs — même convention que
// tests/e2e/detail-panel-close-contract.spec.ts (boucle for + test.describe +
// test.use, ligne ~171).
// ──────────────────────────────────────────────────────────────────────────
for (const viewport of [
  { name: '412px (pixel-7)', width: 412, height: 915 },
  { name: '390px (iphone-14)', width: 390, height: 844 },
]) {
  test.describe(`Lot F2 — fiche arrivage (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('aucun montant tronqué ni débordement — reproduit 89 360 F / 21,9 % (arrivage du 27 avril)', async ({
      page,
    }) => {
      const fixture = await createOwnerFixture(`lotf2-e2e-${viewport.width}`);
      const owner = await signInSupabaseJs(fixture.email);
      try {
        const productId = await createProduct(
          fixture.admin,
          fixture.merchantAccountId,
          fixture.shopId,
        );
        const driverId = await createDriver(
          fixture.admin,
          fixture.merchantAccountId,
          fixture.shopId,
        );

        const { lotId } = await receiveLot(
          fixture.admin,
          owner,
          fixture.merchantAccountId,
          fixture.shopId,
          fixture.userId,
          productId,
          'Fournisseur F2 E2E',
          20,
          265_200,
          0,
        );

        const orderId = await createOrderWithLine(
          fixture.admin,
          fixture.merchantAccountId,
          fixture.shopId,
          driverId,
          productId,
          19,
          408_000,
        );
        await deliverAndCollect(owner, fixture.userId, orderId);

        await insertAdSpend(
          fixture.admin,
          fixture.merchantAccountId,
          fixture.shopId,
          productId,
          lotId,
          fixture.userId,
          66_700,
          '2026-04-27',
        );

        await signIn(page, fixture.email, '/produits?tab=achats');
        await openLotProfitabilityPanel(page, 'Fournisseur F2 E2E');

        // Contrôle de référence exact (89 360 F / 21,9 %) : le composant formate
        // désormais le pourcentage en fr-FR (`formatPercentFr`, virgule décimale) —
        // corrigé (revue finale, ce n'était PAS localisé auparavant, point anglais).
        // On calcule le libellé exact attendu avec la MÊME formule que le
        // composant plutôt que de coder en dur "21,9" à la main.
        const marginMinor = 89_360;
        const cashCollectedMinor = 408_000;
        const marginPctLabel = `${((marginMinor / cashCollectedMinor) * 100).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

        const bodyText = await page.locator('body').innerText();
        expect(bodyText).toContain(formatMoney(marginMinor));
        expect(bodyText).toContain(marginPctLabel);

        await noOverflowAssertions(page)();
      } finally {
        await cleanupUsers(fixture.admin, fixture.userIds);
      }
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Marge provisoire ET masquage distinct sur le même écran. Déviation assumée
// par rapport au snippet illustratif du brief Task 8 : une ligne sans
// `purchase_price_total` ne produit AUCUN `data-testid="value-state-missing"`
// dédié dans le code réel (la RPC 0146 fait `coalesce(purchase_price_total, 0)`
// — la valeur devient silencieusement 0, jamais "masquée" via ValueAmount).
// Le SEUL état `missing` réellement produit par purchase-lot-detail-panel.tsx
// est la carte "Marge %" quand `cashCollectedMinor === 0` (MARGIN_PCT_MISSING_LABEL).
// On seed donc un second arrivage reçu, transport_total=NULL (marge provisoire,
// `value-state-estimated` sur "Coût de revient rendu"/"Les articles vendus vous
// ont coûté") et SANS commande livrée (cashCollectedMinor=0, `value-state-missing`
// sur "Marge %") — les deux mécanismes de masquage distincts prouvés sur le
// même écran, fidèle au comportement RÉEL du composant.
// ──────────────────────────────────────────────────────────────────────────
test.describe('Lot F2 — fiche arrivage (412px)', () => {
  test.use({ viewport: { width: 412, height: 915 } });

  test('marge provisoire (transport non facturé) ET Marge % masquée (aucun CA encaissé) sur le même écran', async ({
    page,
  }) => {
    const fixture = await createOwnerFixture('lotf2-provisoire');
    const owner = await signInSupabaseJs(fixture.email);
    try {
      const productId = await createProduct(
        fixture.admin,
        fixture.merchantAccountId,
        fixture.shopId,
      );

      await receiveLot(
        fixture.admin,
        owner,
        fixture.merchantAccountId,
        fixture.shopId,
        fixture.userId,
        productId,
        'Fournisseur F2 Provisoire',
        10,
        100_000,
        null, // transport_total jamais facturé -> transportComplete=false -> marge provisoire
      );
      // Aucune commande livrée pour ce produit -> cashCollectedMinor=0 -> Marge % masquée.

      await signIn(page, fixture.email, '/produits?tab=achats');
      await openLotProfitabilityPanel(page, 'Fournisseur F2 Provisoire');

      // Scopé au panneau détail (aria-label = son titre, posé par vaul/Radix sur
      // mobile et le `<dialog aria-label>` sur desktop) : depuis le correctif Lot F2
      // qui réutilise `ValueAmount`/`MARGIN_PCT_MISSING_LABEL` dans la carte LISTE
      // (purchase-lots-view.tsx) pour rester cohérent avec ce panneau détail, le
      // même libellé apparaît maintenant DEUX fois sur cet écran (carte + panneau)
      // — un `getByText` non scopé casse en "strict mode violation".
      const panel = page.getByLabel('Rentabilité — Fournisseur F2 Provisoire');
      await expect(panel.getByText(/Marge provisoire — en attente de/)).toBeVisible();
      await expect(panel.locator('[data-testid="value-state-estimated"]').first()).toBeVisible();
      await expect(panel.locator('[data-testid="value-state-missing"]').first()).toBeVisible();
      await expect(panel.getByText('Pas encore de CA encaissé sur cet arrivage')).toBeVisible();

      await noOverflowAssertions(page)();
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Proof 5 (spec F2) — file durable hors-ligne (poids de ligne).
// `initMutationQueueAutoFlush` (lib/offline/mutation-queue.ts) est câblé
// globalement depuis `MutationQueueProvider` (cf. en-tête de fichier) : un
// listener `online` est posé pour toute session authentifiée, et une
// tentative de flush a lieu dès le montage. Ce test prouve donc, dans cet
// ordre : (1) la mutation entre en file SANS aucune tentative réseau tant que
// le navigateur se croit hors-ligne (`navigator.onLine === false`,
// court-circuit dans `useQueuedAction.submit`) ; (2) l'enregistrement survit
// à un VRAI `page.reload()` alors que la mutation est TOUJOURS en attente
// (jamais déjà vidée par un flush qui aurait réussi avant le reload) ; (3) la
// reprise automatique réelle applique la valeur une seule fois dès que le
// réseau redevient disponible, sans aucune ressaisie utilisateur.
//
// `context.setOffline(true)` seul ne peut pas prouver (2) : Playwright bloque
// alors TOUT le trafic, y compris la requête de `page.reload()` lui-même —
// remettre le réseau en ligne avant de recharger laisserait le listener
// `online` (posé par `MutationQueueProvider`, toujours monté à ce moment)
// vider la file AVANT le reload, ce qui prouverait seulement qu'un formulaire
// encore monté survit à un aller-retour réseau, jamais qu'un `reload` réel
// préserve une mutation encore en attente. On isole donc précisément la
// requête réseau du serveur-action de sauvegarde du poids via `page.route`
// (même convention que `orders-hydration-crash-mitigation.spec.ts`, qui cible
// `**/api/orders/search**` ; ici la mutation est un Server Action Next.js —
// POST vers l'URL de la page courante, identifié par l'en-tête `next-action`,
// pas par un chemin distinct) : on la bloque tant qu'on n'a pas fini de
// vérifier la survie post-reload, en laissant passer toute navigation/chargement
// de page normal (dont le `reload` lui-même).
// ──────────────────────────────────────────────────────────────────────────
test.describe('Lot F2 — file durable hors-ligne', () => {
  // Ce describe observe le réseau via page.route — le service worker (prod builds
  // uniquement) rendrait les requêtes invisibles à ce mécanisme (cf. CLAUDE.md).
  test.use({ serviceWorkers: 'block' });

  test('coupure réseau après clic Enregistrer -> file -> survit à un reload réellement hors-ligne -> synchronisée sans doublon au retour réseau', async ({
    page,
    context,
  }) => {
    const fixture = await createOwnerFixture('lotf2-offline');
    const owner = await signInSupabaseJs(fixture.email);
    try {
      const productId = await createProduct(
        fixture.admin,
        fixture.merchantAccountId,
        fixture.shopId,
      );
      const { purchaseLotLineId } = await receiveLot(
        fixture.admin,
        owner,
        fixture.merchantAccountId,
        fixture.shopId,
        fixture.userId,
        productId,
        'Fournisseur F2 Offline',
        5,
        50_000,
        0,
      );

      await signIn(page, fixture.email, '/produits?tab=achats');
      await openLotProfitabilityPanel(page, 'Fournisseur F2 Offline');

      const weightInput = page.locator(`#weight-${purchaseLotLineId}`);
      await expect(weightInput).toBeVisible({ timeout: 10_000 });
      const saveButton = weightInput.locator('xpath=following-sibling::button[1]');

      const readQueuedCount = () =>
        page.evaluate(
          () =>
            new Promise<number>((resolve, reject) => {
              const request = indexedDB.open('teer-mutation-queue');
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const db = request.result;
                const tx = db.transaction('mutations', 'readonly');
                const countReq = tx.objectStore('mutations').count();
                countReq.onsuccess = () => resolve(countReq.result);
                countReq.onerror = () => reject(countReq.error);
              };
            }),
        );

      // 1. Coupure réseau réelle au moment de la soumission : `navigator.onLine`
      // passe à `false`, donc `useQueuedAction.submit` prend le chemin
      // "enqueue puis retour immédiat" sans jamais tenter le réseau (cf.
      // mutation-queue-provider.tsx / use-queued-action.ts) — c'est bien l'état
      // "queued" (et son libellé) qui est prouvé ici, pas un état "error" déguisé.
      await context.setOffline(true);

      await weightInput.click({ clickCount: 3 });
      await weightInput.pressSequentially('1500');
      await expect(weightInput).toHaveValue('1500');
      await saveButton.click();
      await expect(saveButton).toHaveText(
        "Enregistré sur l'appareil — en attente de synchronisation",
        {
          timeout: 10_000,
        },
      );

      // Rien n'a atteint le serveur pendant la coupure.
      const { data: stillNull } = await fixture.admin
        .from('purchase_lot_line')
        .select('weight_grams')
        .eq('id', purchaseLotLineId)
        .single();
      expect(stillNull?.weight_grams).toBeNull();

      // Durabilité IndexedDB : au moins un enregistrement en file avant le reload.
      const queuedBefore = await readQueuedCount();
      expect(queuedBefore).toBeGreaterThan(0);

      // 2. On bloque désormais SEULEMENT la requête réseau du Server Action de
      // sauvegarde du poids (identifiée par l'en-tête `next-action` posé par
      // Next.js sur tout appel direct à une fonction 'use server' — jamais un
      // chemin dédié comme pour une route API classique), puis on repasse le
      // navigateur en ligne : le `reload` a besoin d'un réseau fonctionnel pour
      // aboutir, mais le blocage ciblé empêche toute tentative de flush
      // (montage de `MutationQueueProvider`, écouteur `online`) de vider la
      // file avant qu'on ait pu vérifier la survie post-reload.
      let blockWeightMutation = true;
      await page.route('**/*', async (route) => {
        const req = route.request();
        if (blockWeightMutation && req.method() === 'POST' && req.headers()['next-action']) {
          await route.abort('failed');
          return;
        }
        await route.continue();
      });

      await context.setOffline(false);
      await page.reload();
      await openLotProfitabilityPanel(page, 'Fournisseur F2 Offline');

      // Preuve de survie réelle à un reload : la tentative de flush posée par
      // `MutationQueueProvider` au montage (juste après ce reload) a échoué
      // (route bloquée) -> la mutation posée pendant la coupure est encore là,
      // et le serveur ne l'a toujours pas reçue. Sans ce blocage ciblé, rien ne
      // permettrait de distinguer "le reload a préservé la mutation" de "la
      // mutation avait déjà été vidée avant même que le reload ne parte".
      const queuedAfterReload = await readQueuedCount();
      expect(queuedAfterReload).toBeGreaterThan(0);
      const { data: stillNullAfterReload } = await fixture.admin
        .from('purchase_lot_line')
        .select('weight_grams')
        .eq('id', purchaseLotLineId)
        .single();
      expect(stillNullAfterReload?.weight_grams).toBeNull();

      // 3. On lève le blocage puis on déclenche un aller-retour réseau bref
      // (offline -> online) pour faire réagir le VRAI écouteur `online` posé
      // par `MutationQueueProvider` — sans jamais resoumettre le formulaire
      // nous-mêmes, ce qui serait une preuve différente (ressaisie manuelle,
      // pas reprise automatique).
      blockWeightMutation = false;
      await context.setOffline(true);
      await context.setOffline(false);

      // Reprise automatique réelle : le serveur reçoit la valeur posée PENDANT
      // la coupure originale, ce qui n'est possible que si l'enregistrement a
      // bien survécu au reload (prouvé ci-dessus) puis a été rejoué tout seul.
      await expect
        .poll(
          async () => {
            const { data } = await fixture.admin
              .from('purchase_lot_line')
              .select('weight_grams')
              .eq('id', purchaseLotLineId)
              .single();
            return data?.weight_grams ?? null;
          },
          { timeout: 15_000, intervals: [200, 400, 800, 1500] },
        )
        .toBe(1500);

      // Réglée (ok:true) -> supprimée de la file durable, jamais laissée en
      // doublon derrière un second passage de flush (form-level ou global).
      // `withStore('readwrite', delete)` (mutation-queue.ts) s'exécute APRÈS que
      // le serveur ait confirmé l'écriture (poll ci-dessus) : une courte fenêtre
      // sépare les deux, d'où un `expect.poll` ici aussi plutôt qu'une lecture
      // ponctuelle qui pourrait courir plus vite que cette suppression.
      await expect.poll(readQueuedCount, { timeout: 5_000, intervals: [100, 200, 400] }).toBe(0);
    } finally {
      await page.unroute('**/*');
      await context.setOffline(false);
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Proof 6 (spec F2, mutation-testée au niveau unitaire par
// tests/unit/purchases/product-ad-spend-form.test.tsx) — depuis la fiche
// produit, un choix explicite d'arrivage est requis dès que plusieurs
// candidats existent. Cette preuve E2E montre que le MÊME comportement est
// atteignable via le vrai navigateur/réseau, pas une seconde preuve par
// mutation à ce niveau (une mutation-test E2E casserait du code committé pour
// de vrai -- pas pratique ici, la preuve par mutation reste au niveau unitaire).
// ──────────────────────────────────────────────────────────────────────────
test.describe('Lot F2 — dépense publicitaire exige un arrivage explicite', () => {
  test('produit avec 2 arrivages reçus -> select requis, aucune présélection, bouton désactivé jusqu’au choix', async ({
    page,
  }) => {
    const fixture = await createOwnerFixture('lotf2-adspend-2lots');
    const owner = await signInSupabaseJs(fixture.email);
    try {
      const productId = await createProduct(
        fixture.admin,
        fixture.merchantAccountId,
        fixture.shopId,
      );

      await receiveLot(
        fixture.admin,
        owner,
        fixture.merchantAccountId,
        fixture.shopId,
        fixture.userId,
        productId,
        'Fournisseur F2 Candidat A',
        5,
        50_000,
        0,
      );
      await receiveLot(
        fixture.admin,
        owner,
        fixture.merchantAccountId,
        fixture.shopId,
        fixture.userId,
        productId,
        'Fournisseur F2 Candidat B',
        5,
        50_000,
        0,
      );

      await signIn(page, fixture.email, '/produits');

      const { data: product } = await fixture.admin
        .from('product')
        .select('title')
        .eq('id', productId)
        .single();
      const productTitle = product?.title as string;

      await openProductDetails(page, productId, productTitle);

      await expect(page.getByText('Dépenses publicitaires')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Recherche de l'arrivage concerné…")).toHaveCount(0, {
        timeout: 10_000,
      });

      await page.getByRole('button', { name: 'Ajouter une dépense publicitaire' }).click();

      const select = page.locator('[data-testid="ad-spend-lot-select"]');
      await expect(select).toBeVisible();
      await expect(select).toHaveValue('');

      const submit = page.locator('[data-testid="ad-spend-submit"]');
      await expect(submit).toBeDisabled();

      const optionsCount = await select.locator('option').count();
      // 1 option placeholder ("Sélectionnez…") + 2 arrivages candidats.
      expect(optionsCount).toBe(3);

      await select.selectOption({ index: 1 });
      await expect(select).not.toHaveValue('');
      await expect(submit).toBeEnabled();
    } finally {
      await cleanupUsers(fixture.admin, fixture.userIds);
    }
  });
});
