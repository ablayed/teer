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
 * Couvre le correctif de `setLowStockThresholdAction` (`lib/actions/stock.ts`) :
 * avant le correctif, un `productId` d'un AUTRE tenant, forgé dans le payload
 * réel de la Server Action, créait une ligne `product_stock` orpheline
 * (product_id du tenant victime, merchant_account_id/shop_id de l'attaquant) —
 * exploitable uniquement sur un produit n'ayant jamais eu de mouvement de
 * stock, faute de ligne `product_stock` préexistante pour intercepter le
 * conflit via `product_stock_store_context_guard` (BEFORE UPDATE).
 *
 * Un clic UI ne peut pas reproduire ce scénario : le tableau de T1 n'affiche
 * jamais un produit de T2. Le canal réel est donc capturé en clic legitime sur
 * le PROPRE produit de T1 (contrôle positif), puis rejoué avec l'UUID du
 * produit de T1 remplacé par celui de T2 dans le payload capturé tel quel —
 * mêmes en-têtes, même cookie de session, même URL. Le test RLS
 * (`tests/rls/stock.rls.test.ts`) reste une assertion postconditionnelle sur
 * l'état final en base ; il ne remplace pas ce canal, qui seul traverse
 * `requireRole`, `getRequestStoreId()` et `resolveActiveStoreProduct`.
 */
test.describe('stock.set_threshold — isolation cross-tenant', () => {
  // Deux fixtures multi-tenant + compilation à la demande du serveur de dev
  // consomment à elles seules le budget par défaut (30s) — cf. gotcha
  // « CLAUDE.md, workspace-routing » sur ce même symptôme.
  test.describe.configure({ timeout: 90_000 });

  test('un productId forgé d’un autre tenant est refusé, sans mutation, via le vrai canal HTTP', async ({
    page,
  }) => {
    const admin = adminClient();
    const userIds: string[] = [];

    try {
      // ── Tenant attaquant T1 ────────────────────────────────────────────
      const emailT1 = e2eEmail('threshold-t1');
      const userT1 = await createConfirmedUser(admin, emailT1);
      userIds.push(userT1);
      const merchantT1 = await waitForMerchant(admin, userT1);
      // T1 se connecte réellement à l'UI : sans onboarded_at, app/(app)/layout.tsx
      // redirige tout vers /onboarding avant d'atteindre /produits.
      await admin
        .from('merchant_account')
        .update({ onboarded_at: new Date().toISOString() })
        .eq('id', merchantT1);
      const shopT1 = await defaultShopId(admin, merchantT1);

      const titleT1 = `Seuil T1 ${Date.now()}`;
      const { data: productT1, error: productT1Error } = await admin
        .from('product')
        .insert({
          merchant_account_id: merchantT1,
          shop_id: shopT1,
          title: titleT1,
          unit_cost: 0,
        })
        .select('id')
        .single();
      if (productT1Error || !productT1) throw productT1Error ?? new Error('produit T1 non créé');

      // ── Tenant victime T2 — produit JAMAIS mouvementé (aucune ligne
      //    product_stock préexistante : c'est le vecteur exact du Stage 0) ──
      const emailT2 = e2eEmail('threshold-t2');
      const userT2 = await createConfirmedUser(admin, emailT2);
      userIds.push(userT2);
      const merchantT2 = await waitForMerchant(admin, userT2);
      const shopT2 = await defaultShopId(admin, merchantT2);

      const { data: productT2, error: productT2Error } = await admin
        .from('product')
        .insert({
          merchant_account_id: merchantT2,
          shop_id: shopT2,
          title: `Seuil T2 victime ${Date.now()}`,
          unit_cost: 0,
        })
        .select('id')
        .single();
      if (productT2Error || !productT2) throw productT2Error ?? new Error('produit T2 non créé');

      const { data: preStock } = await admin
        .from('product_stock')
        .select('product_id')
        .eq('product_id', productT2.id)
        .maybeSingle();
      expect(preStock, 'précondition : aucune ligne product_stock pour le produit T2').toBeNull();

      // ── Connexion T1, capture de la vraie requête Server Action ────────
      await loginViaForm(page, emailT1, e2ePassword, '/produits?tab=stock');
      await landOnTarget(page, '/produits?tab=stock');

      // Depuis UX-CAT-01, la ligne Stock existe en 2 variantes DOM (desktop
      // <tr> hidden md:block / mobile <article> md:hidden, même data-testid
      // stock-row-<id>) — :visible isole celle réellement rendue à ce
      // viewport ; les deux portent les mêmes contrôles (seuil, formulaire).
      const row = page.locator('[data-testid^="stock-row-"]:visible', { hasText: titleT1 });
      await expect(row).toBeVisible();

      // Défaut sans ligne product_stock (`lib/actions/products.ts` :
      // `s?.low_stock_threshold ?? 10`).
      await row.getByRole('button', { name: '10', exact: true }).click();

      let captured: { url: string; headers: Record<string, string>; postData: string } | null =
        null;
      page.on('request', (req) => {
        if (req.method() === 'POST' && (req.postData() ?? '').includes(productT1.id)) {
          captured = { url: req.url(), headers: req.headers(), postData: req.postData() ?? '' };
        }
      });

      await row.locator('input[type="number"]').fill('7');
      await row.getByRole('button', { name: 'OK', exact: true }).click();
      await expect(row.getByText('Seuil mis à jour.')).toBeVisible();

      // Contrôle positif : l'écriture légitime a bien eu lieu, scopée à T1.
      const { data: postStockT1 } = await admin
        .from('product_stock')
        .select('product_id, merchant_account_id, shop_id, low_stock_threshold')
        .eq('product_id', productT1.id)
        .single();
      expect(postStockT1?.merchant_account_id).toBe(merchantT1);
      expect(postStockT1?.shop_id).toBe(shopT1);
      expect(postStockT1?.low_stock_threshold).toBe(7);

      expect(captured, 'la requête Server Action légitime doit avoir été capturée').not.toBeNull();
      const legit = captured as unknown as {
        url: string;
        headers: Record<string, string>;
        postData: string;
      };

      // ── Rejeu forgé : UUID de T1 remplacé par celui de T2, payload sinon
      //    identique — mêmes en-têtes, même cookie de session, même URL. ──
      const forgedBody = legit.postData.replaceAll(productT1.id, productT2.id);
      expect(forgedBody).not.toBe(legit.postData);

      const forgedResponse = await page.request.post(legit.url, {
        headers: legit.headers,
        data: forgedBody,
      });
      // Le serveur ne doit jamais crasher (500) sur un identifiant forgé —
      // il doit le refuser proprement via resolveActiveStoreProduct.
      expect(forgedResponse.status(), 'pas de 500 sur un identifiant forgé').toBeLessThan(500);

      // ── Assertion décisive : absence de mutation cross-tenant ──────────
      const { data: postStockT2 } = await admin
        .from('product_stock')
        .select('product_id, merchant_account_id, shop_id')
        .eq('product_id', productT2.id)
        .maybeSingle();

      if (postStockT2) {
        // Si une ligne existe malgré tout, elle ne doit JAMAIS porter le
        // tenant/boutique de l'attaquant — ce serait la fuite elle-même.
        expect(postStockT2.merchant_account_id).not.toBe(merchantT1);
        expect(postStockT2.shop_id).not.toBe(shopT1);
      } else {
        expect(postStockT2).toBeNull();
      }
    } finally {
      await cleanupUsers(admin, userIds);
    }
  });
});
