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
 * Couvre le Livrable 1 de S3 (docs/phaseU/S3-INVENTAIRE-RECEIVE-PURCHASE-LOT.md) :
 * quatre actions du cycle de vie d'un arrivage (addPurchaseLotLineAction,
 * removePurchaseLotLineAction, markLotInTransitAction, receiveLotAction) chargeaient
 * le lot par `id` + `merchant_account_id` seul, sans jamais le confronter à la
 * boutique active — un owner multi-boutiques du même tenant pouvait agir sur un lot
 * d'une boutique à laquelle son onglet actif ne correspond pas.
 *
 * Même méthode que purchases-shop-tenant-isolation.spec.ts (fuite 3, 0138) : le vrai
 * canal HTTP est capturé sur un appel légitime (boutique active = shopA1), puis rejoué
 * avec le SEUL `lotId`/`lineId` substitué pour désigner un lot de shopA2 (même tenant,
 * autre boutique) — mêmes en-têtes, même cookie de session, même URL. L'appel légitime
 * qui réussit d'abord fait office de contrôle positif pour chaque action.
 *
 * Assertion décisive : après CHAQUE rejeu forgé, l'état du lot de shopA2 (statut,
 * lignes, mouvements de stock) reste strictement inchangé.
 */
test.describe('purchases — lot lifecycle isolation boutique (S3)', () => {
  test.describe.configure({ timeout: 180_000 });

  type Admin = ReturnType<typeof adminClient>;

  async function createShop(admin: Admin, merchantAccountId: string) {
    const domain = `purchases-lot-scope-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
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
    admin: Admin,
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
    admin: Admin,
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

  async function createLine(
    admin: Admin,
    merchantAccountId: string,
    shopId: string,
    lotId: string,
    productId: string,
    qty: number,
    purchasePriceTotal: number,
  ) {
    const { data, error } = await admin
      .from('purchase_lot_line')
      .insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        purchase_lot_id: lotId,
        product_id: productId,
        qty,
        purchase_price_total: purchasePriceTotal,
      })
      .select('id')
      .single();
    if (error || !data) throw error ?? new Error('purchase_lot_line insert failed');
    return data.id as string;
  }

  async function setupTwoShopFixture(label: string) {
    const admin = adminClient();
    const email = e2eEmail(label);
    const userId = await createConfirmedUser(admin, email);
    const merchantAccountId = await waitForMerchant(admin, userId);
    await admin
      .from('merchant_account')
      .update({ onboarded_at: new Date().toISOString() })
      .eq('id', merchantAccountId);

    const shopA1 = await defaultShopId(admin, merchantAccountId);
    const shopA2 = await createShop(admin, merchantAccountId);

    return { admin, email, userId, merchantAccountId, shopA1, shopA2 };
  }

  type Captured = { url: string; headers: Record<string, string>; postData: string };

  function captureOnce(
    page: import('@playwright/test').Page,
    marker: string,
  ): {
    get: () => Captured | null;
  } {
    let captured: Captured | null = null;
    page.on('request', (req) => {
      if (req.method() === 'POST' && (req.postData() ?? '').includes(marker)) {
        captured = { url: req.url(), headers: req.headers(), postData: req.postData() ?? '' };
      }
    });
    return { get: () => captured };
  }

  async function replay(
    page: import('@playwright/test').Page,
    legit: Captured,
    substitution: { from: string; to: string },
  ) {
    const forgedBody = legit.postData.replaceAll(substitution.from, substitution.to);
    expect(forgedBody).not.toBe(legit.postData);
    const response = await page.request.post(legit.url, {
      headers: legit.headers,
      data: forgedBody,
    });
    expect(response.status(), 'pas de 500 sur un lotId forgé').toBeLessThan(500);
    return response;
  }

  test('addPurchaseLotLineAction : lotId forgé (autre boutique du même tenant) refusé, lignes de shopA2 intactes', async ({
    page,
  }) => {
    const userIds: string[] = [];
    try {
      const { admin, email, userId, merchantAccountId, shopA1, shopA2 } =
        await setupTwoShopFixture('lot-add-line');
      userIds.push(userId);

      const productA1 = await createProduct(
        admin,
        merchantAccountId,
        shopA1,
        `Prod A1 ${Date.now()}`,
      );
      const lotA1 = await createLot(
        admin,
        merchantAccountId,
        shopA1,
        `Fournisseur A1 ${Date.now()}`,
      );
      const lotA2 = await createLot(
        admin,
        merchantAccountId,
        shopA2,
        `Fournisseur A2 ${Date.now()}`,
      );

      await loginViaForm(page, email, e2ePassword, `/s/${shopA1}/produits`);
      await landOnTarget(page, `/s/${shopA1}/produits`);

      const purchasesTab = page.getByRole('link', { name: 'Achats fournisseur' });
      await expect(purchasesTab).toBeVisible({ timeout: 15_000 });
      await purchasesTab.click();
      await page.waitForURL('**/produits?tab=achats', { timeout: 10_000 });

      await expect(page.getByRole('button', { name: '+ Ajouter un produit' })).toBeVisible({
        timeout: 15_000,
      });
      await page.getByRole('button', { name: '+ Ajouter un produit' }).click();
      await page.locator('select').selectOption({ value: productA1 });
      await page.getByPlaceholder('Qté').pressSequentially('4');
      await page.getByPlaceholder("Prix d'achat total (F CFA)").pressSequentially('4000');

      const capture = captureOnce(page, lotA1);
      await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
      await expect(page.getByRole('button', { name: '+ Ajouter un produit' })).toBeVisible({
        timeout: 15_000,
      });
      const legit = capture.get();
      expect(legit, 'appel légitime capturé (contrôle positif)').not.toBeNull();

      const linesA2Before = await admin
        .from('purchase_lot_line')
        .select('id')
        .eq('purchase_lot_id', lotA2);

      const response = await replay(page, legit as Captured, { from: lotA1, to: lotA2 });
      const body = await response.text();
      expect(body, 'ne doit jamais remonter ok:true sur un lot hors boutique active').not.toMatch(
        /"ok"\s*:\s*true/,
      );

      const linesA2After = await admin
        .from('purchase_lot_line')
        .select('id')
        .eq('purchase_lot_id', lotA2);
      expect(linesA2After.data ?? []).toEqual(linesA2Before.data ?? []);
    } finally {
      await cleanupUsers(adminClient(), userIds);
    }
  });

  test('removePurchaseLotLineAction : lineId/lotId forgés (autre boutique) refusés, ligne de shopA2 intacte', async ({
    page,
  }) => {
    const userIds: string[] = [];
    try {
      const { admin, email, userId, merchantAccountId, shopA1, shopA2 } =
        await setupTwoShopFixture('lot-remove-line');
      userIds.push(userId);

      const productA1 = await createProduct(
        admin,
        merchantAccountId,
        shopA1,
        `Prod A1 ${Date.now()}`,
      );
      const productA2 = await createProduct(
        admin,
        merchantAccountId,
        shopA2,
        `Prod A2 ${Date.now()}`,
      );
      const lotA1 = await createLot(
        admin,
        merchantAccountId,
        shopA1,
        `Fournisseur A1 ${Date.now()}`,
      );
      const lotA2 = await createLot(
        admin,
        merchantAccountId,
        shopA2,
        `Fournisseur A2 ${Date.now()}`,
      );
      const lineA1 = await createLine(admin, merchantAccountId, shopA1, lotA1, productA1, 2, 2000);
      const lineA2 = await createLine(admin, merchantAccountId, shopA2, lotA2, productA2, 3, 3000);

      await loginViaForm(page, email, e2ePassword, `/s/${shopA1}/produits`);
      await landOnTarget(page, `/s/${shopA1}/produits`);

      const purchasesTab = page.getByRole('link', { name: 'Achats fournisseur' });
      await expect(purchasesTab).toBeVisible({ timeout: 15_000 });
      await purchasesTab.click();
      await page.waitForURL('**/produits?tab=achats', { timeout: 10_000 });

      const capture = captureOnce(page, lineA1);
      await page.getByRole('button', { name: 'Supprimer la ligne' }).first().click();
      // La requête est capturée dès son ENVOI (page.on('request')), avant que le
      // serveur ait traité la mutation — attendre uniquement `capture.get()` court-
      // circuite la vérification du contrôle positif (course observée en CI : la
      // ligne existait encore en base au moment de la lecture). Seule la
      // disparition de la ligne dans le DOM (revalidatePath + re-render RSC après
      // réponse reçue) prouve que la suppression légitime a bien abouti.
      await expect(page.getByRole('button', { name: 'Supprimer la ligne' })).toHaveCount(0, {
        timeout: 15_000,
      });
      const legit = capture.get();
      expect(legit, 'appel légitime capturé (contrôle positif)').not.toBeNull();

      const { data: lineA1After } = await admin
        .from('purchase_lot_line')
        .select('id')
        .eq('id', lineA1)
        .maybeSingle();
      expect(lineA1After, 'la suppression légitime a bien eu lieu').toBeNull();

      // Rejeu : substitue lineA1 -> lineA2 ET lotA1 -> lotA2 (les deux voyagent
      // dans le même payload JSON) pour cibler une ligne de shopA2.
      const forgedBody = (legit as Captured).postData
        .replaceAll(lineA1, lineA2)
        .replaceAll(lotA1, lotA2);
      const response = await page.request.post((legit as Captured).url, {
        headers: (legit as Captured).headers,
        data: forgedBody,
      });
      expect(response.status()).toBeLessThan(500);
      const body = await response.text();
      expect(body).not.toMatch(/"ok"\s*:\s*true/);

      const { data: lineA2After } = await admin
        .from('purchase_lot_line')
        .select('id')
        .eq('id', lineA2)
        .maybeSingle();
      expect(lineA2After?.id, 'la ligne de shopA2 doit rester intacte').toBe(lineA2);
    } finally {
      await cleanupUsers(adminClient(), userIds);
    }
  });

  test('markLotInTransitAction : lotId forgé (autre boutique) ne fait jamais passer le lot de shopA2 en transit', async ({
    page,
  }) => {
    const userIds: string[] = [];
    try {
      const { admin, email, userId, merchantAccountId, shopA1, shopA2 } =
        await setupTwoShopFixture('lot-mark-transit');
      userIds.push(userId);

      const productA1 = await createProduct(
        admin,
        merchantAccountId,
        shopA1,
        `Prod A1 ${Date.now()}`,
      );
      const lotA1 = await createLot(
        admin,
        merchantAccountId,
        shopA1,
        `Fournisseur A1 ${Date.now()}`,
      );
      const lotA2 = await createLot(
        admin,
        merchantAccountId,
        shopA2,
        `Fournisseur A2 ${Date.now()}`,
      );
      await createLine(admin, merchantAccountId, shopA1, lotA1, productA1, 1, 1000);

      await loginViaForm(page, email, e2ePassword, `/s/${shopA1}/produits`);
      await landOnTarget(page, `/s/${shopA1}/produits`);

      const purchasesTab = page.getByRole('link', { name: 'Achats fournisseur' });
      await expect(purchasesTab).toBeVisible({ timeout: 15_000 });
      await purchasesTab.click();
      await page.waitForURL('**/produits?tab=achats', { timeout: 10_000 });

      const capture = captureOnce(page, lotA1);
      await page.getByRole('button', { name: 'Marquer en transit' }).click();
      // Même piège que removePurchaseLotLineAction ci-dessus : la requête est
      // capturée à l'ENVOI (page.on('request')), pas à la réponse. Le badge de
      // statut (StatusBadge, "En transit") ne s'affiche qu'après la réponse
      // reçue et le re-render RSC (revalidatePath) — seul signal fiable que la
      // mutation légitime a abouti avant de lire la base.
      await expect(page.getByText('En transit', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      const legit = capture.get();
      expect(legit, 'appel légitime capturé (contrôle positif)').not.toBeNull();

      const { data: lotA1After } = await admin
        .from('purchase_lot')
        .select('status')
        .eq('id', lotA1)
        .single();
      expect(lotA1After?.status, 'le lot légitime passe bien en transit').toBe('in_transit');

      const response = await replay(page, legit as Captured, { from: lotA1, to: lotA2 });
      expect(response.status()).toBeLessThan(500);

      const { data: lotA2After } = await admin
        .from('purchase_lot')
        .select('status')
        .eq('id', lotA2)
        .single();
      expect(lotA2After?.status, 'le lot de shopA2 ne doit jamais être affecté').toBe('ordered');
    } finally {
      await cleanupUsers(adminClient(), userIds);
    }
  });

  test('receiveLotAction : lotId forgé (autre boutique) refusé, aucun mouvement de stock pour shopA2', async ({
    page,
  }) => {
    const userIds: string[] = [];
    try {
      const { admin, email, userId, merchantAccountId, shopA1, shopA2 } =
        await setupTwoShopFixture('lot-receive');
      userIds.push(userId);

      const productA1 = await createProduct(
        admin,
        merchantAccountId,
        shopA1,
        `Prod A1 ${Date.now()}`,
      );
      const productA2 = await createProduct(
        admin,
        merchantAccountId,
        shopA2,
        `Prod A2 ${Date.now()}`,
      );
      const lotA1 = await createLot(
        admin,
        merchantAccountId,
        shopA1,
        `Fournisseur A1 ${Date.now()}`,
      );
      const lotA2 = await createLot(
        admin,
        merchantAccountId,
        shopA2,
        `Fournisseur A2 ${Date.now()}`,
      );
      await createLine(admin, merchantAccountId, shopA1, lotA1, productA1, 2, 2000);
      await createLine(admin, merchantAccountId, shopA2, lotA2, productA2, 5, 5000);

      await loginViaForm(page, email, e2ePassword, `/s/${shopA1}/produits`);
      await landOnTarget(page, `/s/${shopA1}/produits`);

      const purchasesTab = page.getByRole('link', { name: 'Achats fournisseur' });
      await expect(purchasesTab).toBeVisible({ timeout: 15_000 });
      await purchasesTab.click();
      await page.waitForURL('**/produits?tab=achats', { timeout: 10_000 });

      const capture = captureOnce(page, lotA1);
      await page.getByRole('button', { name: 'Marquer reçu' }).click();
      // Même piège que les deux tests ci-dessus : la requête est capturée à
      // l'ENVOI, pas à la réponse. Le badge de statut (StatusBadge, "Reçu") ne
      // s'affiche qu'après la réponse reçue et le re-render RSC (revalidatePath)
      // — seul signal fiable que la mutation légitime a abouti avant de lire la
      // base (course observée en CI : le statut était encore "ordered" au
      // moment de la lecture).
      await expect(page.getByText('Reçu', { exact: true })).toBeVisible({ timeout: 15_000 });
      const legit = capture.get();
      expect(legit, 'appel légitime capturé (contrôle positif)').not.toBeNull();

      const { data: lotA1After } = await admin
        .from('purchase_lot')
        .select('status')
        .eq('id', lotA1)
        .single();
      expect(lotA1After?.status, 'le lot légitime passe bien reçu').toBe('received');

      const response = await replay(page, legit as Captured, { from: lotA1, to: lotA2 });
      const body = await response.text();
      expect(body, 'ne doit jamais remonter ok:true sur un lot hors boutique active').not.toMatch(
        /"ok"\s*:\s*true/,
      );

      const { data: lotA2After } = await admin
        .from('purchase_lot')
        .select('status')
        .eq('id', lotA2)
        .single();
      expect(lotA2After?.status, 'le lot de shopA2 ne doit jamais être reçu').toBe('ordered');

      const { data: movementsA2 } = await admin
        .from('stock_movement')
        .select('id')
        .eq('shop_id', shopA2)
        .eq('product_id', productA2);
      expect(movementsA2 ?? [], 'aucun mouvement de stock ne doit être posté pour shopA2').toEqual(
        [],
      );
    } finally {
      await cleanupUsers(adminClient(), userIds);
    }
  });
});
