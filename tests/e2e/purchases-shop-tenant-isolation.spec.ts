import { expect, test } from '@playwright/test';
import {
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  landOnTarget,
  loginViaForm,
  waitForMerchant,
} from './helpers/auth';
import { defaultShopId } from './helpers/workspace';

/**
 * Couvre le correctif Stage 2 de createPurchaseLotAction/addPurchaseLotLineAction
 * (fuite 3, post-mortem migration 0138) : productId n'était jamais confronté à la
 * boutique avant d'être écrit dans purchase_lot_line — ni la boutique active
 * (création de lot), ni la boutique DU LOT porteur (ajout de ligne, où l'utilisateur
 * a pu changer de boutique active entre-temps). Même méthode que
 * products-bundle-shop-tenant-isolation.spec.ts (fuite 2) : le vrai canal HTTP est
 * capturé en clic légitime, puis rejoué avec un productId substitué dans le payload
 * capturé tel quel — mêmes en-têtes, même cookie de session, même URL. Le test
 * PostgREST direct du trigger (tests/rls/purchases.rls.test.ts) reste une assertion
 * postconditionnelle distincte ; il ne traverse ni requireRole, ni
 * resolveProductInShop, ni la logique applicative des deux actions.
 *
 * Assertion décisive au-delà du simple refus : après CHAQUE payload forgé, l'état
 * préexistant (lot + lignes déjà créés) doit rester strictement inchangé.
 */
test.describe('purchases — isolation boutique/tenant (fuite 3)', () => {
  test.describe.configure({ timeout: 120_000 });

  async function createShop(admin: ReturnType<typeof adminClient>, merchantAccountId: string) {
    const domain = `purchases-shop-scope-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
    const { data, error } = await admin
      .from('shop')
      .insert({
        access_token_encrypted: 'enc',
        merchant_account_id: merchantAccountId,
        scopes: 'read_orders',
        shop_domain: domain,
      })
      .select('id')
      .single();
    if (error || !data) throw error ?? new Error('shop insert failed');
    return data.id as string;
  }

  async function createProduct(
    admin: ReturnType<typeof adminClient>,
    merchantAccountId: string,
    shopId: string,
    title: string,
  ) {
    const { data, error } = await admin
      .from('product')
      .insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        title,
        unit_cost: 0,
        is_active: true,
      })
      .select('id')
      .single();
    if (error || !data) throw error ?? new Error('product insert failed');
    return data.id as string;
  }

  async function createLot(
    admin: ReturnType<typeof adminClient>,
    merchantAccountId: string,
    shopId: string,
    supplierName: string,
  ) {
    const { data, error } = await admin
      .from('purchase_lot')
      .insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        supplier_name: supplierName,
        ordered_at: '2026-06-01',
      })
      .select('id')
      .single();
    if (error || !data) throw error ?? new Error('purchase_lot insert failed');
    return data.id as string;
  }

  test('addPurchaseLotLineAction : productId forgé (autre boutique, autre tenant, inexistant) refusé, lot/lignes intacts', async ({
    page,
  }) => {
    const admin = adminClient();
    const userIds: string[] = [];

    try {
      // ── Tenant A (attaquant potentiel) — 2 boutiques ────────────────────
      const emailA = e2eEmail('purchases-shop-a');
      const userA = await createConfirmedUser(admin, emailA);
      userIds.push(userA);
      const merchantA = await waitForMerchant(admin, userA);
      await admin
        .from('merchant_account')
        .update({ onboarded_at: new Date().toISOString() })
        .eq('id', merchantA);
      const shopA1 = await defaultShopId(admin, merchantA);

      const productValidId = await createProduct(
        admin,
        merchantA,
        shopA1,
        `Produit valide ${Date.now()}`,
      );
      const lotId = await createLot(admin, merchantA, shopA1, `Fournisseur A1 ${Date.now()}`);

      // ── Tenant B (victime cross-tenant) ─────────────────────────────────
      const emailB = e2eEmail('purchases-shop-b');
      const userB = await createConfirmedUser(admin, emailB);
      userIds.push(userB);
      const merchantB = await waitForMerchant(admin, userB);
      const shopB1 = await defaultShopId(admin, merchantB);
      const productBId = await createProduct(admin, merchantB, shopB1, `Produit B ${Date.now()}`);

      // ── Connexion A ───────────────────────────────────────────────────
      await loginViaForm(page, emailA, e2ePassword, '/produits');
      await landOnTarget(page, '/produits');

      const shopA2 = await createShop(admin, merchantA);
      // Vecteur "productId forgé, autre boutique du même tenant".
      const productA2Id = await createProduct(admin, merchantA, shopA2, `Produit A2 ${Date.now()}`);

      const purchasesTab = page.getByRole('link', { name: 'Achats fournisseur' });
      await expect(purchasesTab).toBeVisible({ timeout: 15_000 });
      await purchasesTab.click();
      await page.waitForURL('**/produits?tab=achats', { timeout: 10_000 });

      // La carte du lot A1 (seul lot de la page) affiche directement le bouton
      // "+ Ajouter un produit" — pas de dépliage préalable requis (LotCard rend le
      // panneau inline, cf. components/purchases/purchase-lots-view.tsx).
      await expect(page.getByRole('button', { name: '+ Ajouter un produit' })).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole('button', { name: '+ Ajouter un produit' }).click();
      await page.locator('select').selectOption({ value: productValidId });
      const qtyInput = page.getByPlaceholder('Qté');
      await qtyInput.pressSequentially('4');
      const priceInput = page.getByPlaceholder("Prix d'achat total (F CFA)");
      await priceInput.pressSequentially('4000');

      let captured: { url: string; headers: Record<string, string>; postData: string } | null =
        null;
      page.on('request', (req) => {
        if (req.method() === 'POST' && (req.postData() ?? '').includes(productValidId)) {
          captured = { url: req.url(), headers: req.headers(), postData: req.postData() ?? '' };
        }
      });

      // Succès = le formulaire se replie (setShowAddLine(false)) et la ligne apparaît
      // dans le tableau du lot — aucun message de confirmation n'est affiché.
      await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
      await expect(page.getByRole('button', { name: '+ Ajouter un produit' })).toBeVisible({
        timeout: 15_000,
      });

      type LineRow = { id: string; product_id: string; qty: number };
      async function readLines(): Promise<LineRow[]> {
        const { data } = await admin
          .from('purchase_lot_line')
          .select('id, product_id, qty')
          .eq('purchase_lot_id', lotId)
          .order('id');
        return (data ?? []) as LineRow[];
      }

      const baseline = await readLines();
      expect(baseline.length).toBeGreaterThanOrEqual(1);
      const { data: lotBefore } = await admin
        .from('purchase_lot')
        .select('status')
        .eq('id', lotId)
        .single();

      expect(captured, 'la requête Server Action légitime doit avoir été capturée').not.toBeNull();
      const legit = captured as unknown as {
        url: string;
        headers: Record<string, string>;
        postData: string;
      };

      async function assertLotUnchanged() {
        const lines = await readLines();
        expect(lines).toEqual(baseline);
        const { data: lotAfter } = await admin
          .from('purchase_lot')
          .select('status')
          .eq('id', lotId)
          .single();
        expect(lotAfter?.status).toBe(lotBefore?.status);
      }

      // Le message attendu est celui de resolveProductInShop ('Produit introuvable dans
      // cette boutique.'), délibérément DIFFÉRENT du message brut que lèverait le trigger
      // SQL (0138, « must belong to the same shop_id »/« not found ») s'il devait
      // rattraper seul un contournement de la garde TS. Asserter ce texte précis, et non
      // seulement ok:false, est ce qui rend ce test rouge quand la garde TS est retirée
      // (mutation testing) — le trigger continuerait de refuser, mais avec un texte
      // différent, prouvant que c'est bien resolveProductInShop qui a répondu ici.
      async function replay(substitution: { from: string; to: string }) {
        const forgedBody = legit.postData.replaceAll(substitution.from, substitution.to);
        expect(forgedBody).not.toBe(legit.postData);
        const response = await page.request.post(legit.url, {
          headers: legit.headers,
          data: forgedBody,
        });
        expect(response.status(), 'pas de 500 sur un identifiant forgé').toBeLessThan(500);
        const body = await response.text();
        expect(body, 'ne doit jamais remonter ok:true').not.toMatch(/"ok"\s*:\s*true/);
        expect(body, 'doit remonter le message TS de resolveProductInShop').toContain(
          'Produit introuvable dans cette boutique.',
        );
        return response;
      }

      // ── 1. productId : autre boutique du même tenant ────────────────────
      await replay({ from: productValidId, to: productA2Id });
      await assertLotUnchanged();

      // ── 2. productId : autre tenant ──────────────────────────────────────
      await replay({ from: productValidId, to: productBId });
      await assertLotUnchanged();

      // ── 3. productId : inexistant ─────────────────────────────────────────
      await replay({ from: productValidId, to: crypto.randomUUID() });
      await assertLotUnchanged();
    } finally {
      await cleanupUsers(admin, userIds);
    }
  });
});
