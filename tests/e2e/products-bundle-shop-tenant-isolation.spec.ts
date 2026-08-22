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
 * Couvre le correctif Stage 2 de `saveBundleConfigurationAction` (fuite 2, post-mortem
 * migration 0137) : `componentProductId`/`bundleProductId` n'étaient jamais confrontés
 * à la boutique active avant d'être écrits dans `product_bundle_component`. Le vrai
 * canal HTTP est capturé en clic légitime (2 composants, même boutique que le bundle),
 * puis rejoué avec un identifiant substitué dans le payload capturé tel quel — mêmes
 * en-têtes, même cookie de session, même URL. Le test PostgREST direct du trigger
 * (`tests/rls/product-bundle-cascade-shop-scope.rls.test.ts`) reste une assertion
 * postconditionnelle distincte ; il ne traverse ni `requireRole`, ni
 * `resolveActiveStoreProduct`, ni la séquence update/delete/insert de l'action.
 *
 * Assertion décisive au-delà du simple refus : après CHAQUE payload forgé, la
 * composition légitime préexistante du bundle (2 lignes) doit rester identique au
 * bit près. Sans la résolution en amont (avant le premier `product.update`), le
 * `delete` s'exécute avant que l'`insert` forgé n'échoue sur le trigger — détruisant
 * une composition valide sans jamais la remplacer (dette d'atomicité documentée,
 * distincte de la fuite elle-même).
 */
test.describe('saveBundleConfigurationAction — isolation boutique/tenant (fuite 2)', () => {
  test.describe.configure({ timeout: 120_000 });

  async function createShop(admin: ReturnType<typeof adminClient>, merchantAccountId: string) {
    const domain = `bundle-shop-scope-${Date.now()}-${Math.floor(Math.random() * 1e6)}.myshopify.com`;
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
    isBundle = false,
  ) {
    const { data, error } = await admin
      .from('product')
      .insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        title,
        unit_cost: 0,
        is_active: true,
        is_bundle: isBundle,
      })
      .select('id')
      .single();
    if (error || !data) throw error ?? new Error('product insert failed');
    return data.id as string;
  }

  test('composant/bundle forgés (autre boutique, autre tenant, inexistants) : refusés, composition existante intacte', async ({
    page,
  }) => {
    const admin = adminClient();
    const userIds: string[] = [];

    try {
      // ── Tenant A (attaquant potentiel) — 2 boutiques ────────────────────
      const emailA = e2eEmail('bundle-shop-a');
      const userA = await createConfirmedUser(admin, emailA);
      userIds.push(userA);
      const merchantA = await waitForMerchant(admin, userA);
      await admin
        .from('merchant_account')
        .update({ onboarded_at: new Date().toISOString() })
        .eq('id', merchantA);
      const shopA1 = await defaultShopId(admin, merchantA);

      const titleBundle = `Bundle Shop Scope ${Date.now()}`;
      const bundleValidId = await createProduct(admin, merchantA, shopA1, titleBundle);
      const componentValid1Id = await createProduct(
        admin,
        merchantA,
        shopA1,
        `Composant 1 valide ${Date.now()}`,
      );
      const componentValid2Id = await createProduct(
        admin,
        merchantA,
        shopA1,
        `Composant 2 valide ${Date.now()}`,
      );

      // ── Tenant B (victime cross-tenant) ─────────────────────────────────
      const emailB = e2eEmail('bundle-shop-b');
      const userB = await createConfirmedUser(admin, emailB);
      userIds.push(userB);
      const merchantB = await waitForMerchant(admin, userB);
      const shopB1 = await defaultShopId(admin, merchantB);
      const componentBId = await createProduct(
        admin,
        merchantB,
        shopB1,
        `Composant B ${Date.now()}`,
      );
      const bundleBId = await createProduct(
        admin,
        merchantB,
        shopB1,
        `Bundle B ${Date.now()}`,
        true,
      );

      // ── Connexion A, configuration légitime capturée en clic réel ──────
      // shopA2 est créée APRÈS la connexion : la créer avant ferait atterrir la
      // connexion sur le sélecteur multi-boutiques `/s` (2 boutiques déjà posées),
      // que ce test n'a pas à traverser — cf. gotcha « fixture E2E le plus coûteux »
      // (CLAUDE.md) et le même motif dans orders-transitions.spec.ts.
      await loginViaForm(page, emailA, e2ePassword, '/produits');
      await landOnTarget(page, '/produits');

      const shopA2 = await createShop(admin, merchantA);
      // Vecteur "composant forgé, autre boutique du même tenant".
      const componentA2Id = await createProduct(
        admin,
        merchantA,
        shopA2,
        `Composant A2 ${Date.now()}`,
      );
      // Vecteur "bundleProductId forgé, autre boutique du même tenant" — doit déjà
      // être is_bundle=true pour atteindre la comparaison de boutique du trigger
      // plutôt que d'être rejeté plus tôt sur "not marked is_bundle=true".
      const bundleA2Id = await createProduct(
        admin,
        merchantA,
        shopA2,
        `Bundle A2 ${Date.now()}`,
        true,
      );

      const productRow = page.getByTestId(`product-catalog-card-${bundleValidId}`);
      await productRow.waitFor({ state: 'visible' });
      await productRow.getByRole('button', { name: 'Détails', exact: true }).click();

      const panel = page.getByTestId('product-detail-panel');
      await panel.getByRole('checkbox', { name: 'Pack/bundle' }).check();

      await panel.getByRole('button', { name: 'Ajouter un composant' }).click();
      await panel.getByLabel('Produit composant sélectionné').first().selectOption({
        value: componentValid1Id,
      });
      await panel.getByLabel('Quantité requise').first().fill('2');

      await panel.getByRole('button', { name: 'Ajouter un composant' }).click();
      await panel.getByLabel('Produit composant sélectionné').nth(1).selectOption({
        value: componentValid2Id,
      });
      await panel.getByLabel('Quantité requise').nth(1).fill('3');

      let captured: { url: string; headers: Record<string, string>; postData: string } | null =
        null;
      page.on('request', (req) => {
        if (req.method() === 'POST' && (req.postData() ?? '').includes(componentValid1Id)) {
          captured = { url: req.url(), headers: req.headers(), postData: req.postData() ?? '' };
        }
      });

      await panel.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(panel.getByText('Configuration enregistrée.')).toBeVisible({ timeout: 15_000 });

      type Baseline = { bundle_product_id: string; component_product_id: string; quantity: number };
      async function readComposition(bundleProductId: string): Promise<Baseline[]> {
        const { data } = await admin
          .from('product_bundle_component')
          .select('bundle_product_id, component_product_id, quantity')
          .eq('bundle_product_id', bundleProductId)
          .order('component_product_id');
        return (data ?? []) as Baseline[];
      }

      const baseline = await readComposition(bundleValidId);
      expect(baseline).toHaveLength(2);
      const { data: bundleFlagAfterLegit } = await admin
        .from('product')
        .select('is_bundle')
        .eq('id', bundleValidId)
        .single();
      expect(bundleFlagAfterLegit?.is_bundle).toBe(true);

      expect(captured, 'la requête Server Action légitime doit avoir été capturée').not.toBeNull();
      const legit = captured as unknown as {
        url: string;
        headers: Record<string, string>;
        postData: string;
      };

      async function assertBundleValidUnchanged() {
        const composition = await readComposition(bundleValidId);
        expect(composition).toEqual(baseline);
        const { data: flag } = await admin
          .from('product')
          .select('is_bundle')
          .eq('id', bundleValidId)
          .single();
        expect(flag?.is_bundle).toBe(true);
      }

      // expectedErrorCode : affirme le code métier EXACT remonté par l'action, pas
      // seulement l'absence de 500 — un refus qui remonterait le mauvais code (ou un
      // ok:true silencieux) doit faire échouer le test au même titre qu'une mutation.
      async function replay(substitution: { from: string; to: string }, expectedErrorCode: string) {
        const forgedBody = legit.postData.replaceAll(substitution.from, substitution.to);
        expect(forgedBody).not.toBe(legit.postData);
        const response = await page.request.post(legit.url, {
          headers: legit.headers,
          data: forgedBody,
        });
        expect(response.status(), 'pas de 500 sur un identifiant forgé').toBeLessThan(500);
        const body = await response.text();
        expect(body, `doit remonter ${expectedErrorCode}`).toContain(expectedErrorCode);
        expect(body, 'ne doit jamais remonter ok:true').not.toMatch(/"ok"\s*:\s*true/);
        return response;
      }

      // ── 1. composant : autre boutique du même tenant ────────────────────
      await replay({ from: componentValid1Id, to: componentA2Id }, 'component_not_found');
      await assertBundleValidUnchanged();

      // ── 2. composant : autre tenant ──────────────────────────────────────
      await replay({ from: componentValid1Id, to: componentBId }, 'component_not_found');
      await assertBundleValidUnchanged();

      // ── 3. composant : inexistant ─────────────────────────────────────────
      await replay({ from: componentValid1Id, to: crypto.randomUUID() }, 'component_not_found');
      await assertBundleValidUnchanged();

      // ── 4. bundleProductId : autre boutique du même tenant ──────────────
      await replay({ from: bundleValidId, to: bundleA2Id }, 'bundle_not_found');
      await assertBundleValidUnchanged();
      const compositionBundleA2 = await readComposition(bundleA2Id);
      expect(compositionBundleA2).toHaveLength(0);
      const { data: bundleA2Flag } = await admin
        .from('product')
        .select('is_bundle')
        .eq('id', bundleA2Id)
        .single();
      expect(bundleA2Flag?.is_bundle).toBe(true);

      // ── 5. bundleProductId : autre tenant ────────────────────────────────
      await replay({ from: bundleValidId, to: bundleBId }, 'bundle_not_found');
      await assertBundleValidUnchanged();
      const compositionBundleB = await readComposition(bundleBId);
      expect(compositionBundleB).toHaveLength(0);

      // ── 6. bundleProductId : inexistant ──────────────────────────────────
      await replay({ from: bundleValidId, to: crypto.randomUUID() }, 'bundle_not_found');
      await assertBundleValidUnchanged();
    } finally {
      await cleanupUsers(admin, userIds);
    }
  });
});
