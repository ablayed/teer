/**
 * Bundles/packs — PR 1 : composition + cascade de stock (migrations 0107/0108/0109).
 *
 * Couvre les 7 points de dette identifiés en revue avant merge (aucun n'était verrouillé
 * par un test committé avant ce fichier) :
 *  1. Cascade quantités multiples (2x Support + 1x Câble, 3 bundles → 6/3).
 *  2. Aucun mouvement jamais posté sur le product_id du bundle lui-même.
 *  3. Composant partagé entre 2 bundles, additif sans écrasement.
 *  4. Rejet explicite allocate_to_courier / courier_return_lot / driver_stock_set sur un bundle.
 *  5. Contraintes anti-imbrication / anti-promotion (triggers 0107).
 *  6. Fix 0109 : order_assignment_release libère bien le ledger des composants après annulation
 *     (le bug le plus grave trouvé dans cette PR — sans ce fix, la disponibilité livreur restait
 *     engagée indéfiniment pour les composants d'un bundle).
 *  7. Atomicité : une erreur ailleurs dans le MÊME appel transition_order annule tout, y compris
 *     les mouvements de cascade bundle déjà postés plus tôt dans le même appel.
 */

import type { Database } from '@/lib/supabase/database.types';
import { callStockMovementEngine } from '@/tests/helpers/stock-movement-engine';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'bundle-cascade-test-pw';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type AdminClient = SupabaseClient<Database>;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('User creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: AdminClient, userId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account not found');
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password });
  return client;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `bundle-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function createProduct(
  admin: AdminClient,
  merchantAccountId: string,
  opts: { title: string; isBundle?: boolean; unitCost?: number },
) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      title: opts.title,
      unit_cost: opts.unitCost ?? 0,
      is_bundle: opts.isBundle ?? false,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id;
}

async function addBundleComponent(
  admin: AdminClient,
  merchantAccountId: string,
  bundleProductId: string,
  componentProductId: string,
  quantity: number,
) {
  const { error } = await admin.from('product_bundle_component').insert({
    merchant_account_id: merchantAccountId,
    bundle_product_id: bundleProductId,
    component_product_id: componentProductId,
    quantity,
  });
  return error;
}

async function createDriver(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur-${Date.now()}`,
      phone: '+221770000000',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');
  return data.id;
}

/** Les seeds de livreur doivent reproduire le rattachement créé par l'action produit. */
async function seedDriverShop(admin: AdminClient, merchantAccountId: string, driverId: string) {
  const { data: shop, error: shopError } = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_default', true)
    .single();
  if (shopError || !shop) throw shopError ?? new Error('default shop missing');
  const { error } = await admin.from('driver_shop').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shop.id,
    driver_id: driverId,
  });
  if (error) throw error;
  return shop.id;
}

async function seedProductStock(
  admin: AdminClient,
  productId: string,
  merchantAccountId: string,
  qtyOnHand = 100,
) {
  await admin.from('product_stock').upsert(
    {
      product_id: productId,
      merchant_account_id: merchantAccountId,
      qty_on_hand: qtyOnHand,
      unit_cost: 1000,
    },
    { onConflict: 'product_id' },
  );
}

async function createOrderForDriver(
  admin: AdminClient,
  merchantAccountId: string,
  driverId: string,
  lines: Array<{ productId: string; qty: number }>,
) {
  const { data: order, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `BUNDLE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      total_amount: 10000,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      assigned_driver_id: driverId,
    })
    .select('id')
    .single();
  if (error || !order) throw error ?? new Error('order insert failed');

  await admin.from('order_line').insert(
    lines.map((l) => ({
      merchant_account_id: merchantAccountId,
      order_id: order.id,
      product_id: l.productId,
      raw_title: 'Bundle test line',
      qty: l.qty,
      match_status: 'matched' as const,
    })),
  );
  return order.id;
}

type TransitionOrderArgs = {
  p_actor: string;
  p_order_id: string;
  p_call_state?: string;
  p_delivery_state?: string;
  p_order_state?: string;
  p_cash_state?: string;
  p_attempt_count?: number;
};

function transitionRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionOrderArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

type PostStockMovementArgs = {
  p_merchant_account_id: string;
  p_product_id: string;
  p_movement_type: string;
  p_qty: number;
  p_idempotency_key: string;
  p_created_by: string;
  p_expected_shop_id?: string;
  p_driver_id?: string;
};

function postStockMovementRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'post_stock_movement',
    args: PostStockMovementArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

async function readMovements(admin: AdminClient, productId: string, movementType?: string) {
  let query = admin
    .from('stock_movement')
    .select('product_id, movement_type, qty, order_id')
    .eq('product_id', productId);
  if (movementType) query = query.eq('movement_type', movementType);
  const { data } = await query;
  return data ?? [];
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

// ──────────────────────────────────────────────────────────────────────────
// 1 + 2 : cascade quantités multiples, aucun mouvement sur le bundle lui-même
// ──────────────────────────────────────────────────────────────────────────

describe('cascade bundle : quantités multiples et absence de mouvement sur le bundle', () => {
  skipIfNoServiceRole(
    'dispatch de 3 bundles (2x Support + 1x Câble) → 6 Support / 3 Câble, 0 mouvement bundle',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('multi-qty');
      const driverId = await createDriver(admin, merchantAccountId);
      await seedDriverShop(admin, merchantAccountId, driverId);

      const supportId = await createProduct(admin, merchantAccountId, { title: 'Support' });
      const cableId = await createProduct(admin, merchantAccountId, { title: 'Câble' });
      await seedProductStock(admin, supportId, merchantAccountId, 100);
      await seedProductStock(admin, cableId, merchantAccountId, 100);

      const bundleId = await createProduct(admin, merchantAccountId, {
        title: 'Bundle Support+Câble',
        isBundle: true,
      });
      expect(await addBundleComponent(admin, merchantAccountId, bundleId, supportId, 2)).toBeNull();
      expect(await addBundleComponent(admin, merchantAccountId, bundleId, cableId, 1)).toBeNull();

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId: bundleId, qty: 3 },
      ]);

      const client = await signIn(email);
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
      const dispatch = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });
      expect(dispatch.error).toBeNull();
      expect(dispatch.data).toBe('EN_LIVRAISON');

      // `reserve` (posté par confirmer) est hors scope de la cascade (décision #3) et se
      // pose donc directement sur le bundle — attendu, pas une régression. Seuls les
      // movement_type EN scope (dispatch, order_assignment_commit) ne doivent jamais
      // apparaître sur le bundle lui-même (point 2).
      const bundleDispatch = await readMovements(admin, bundleId, 'dispatch');
      const bundleCommit = await readMovements(admin, bundleId, 'order_assignment_commit');
      expect(bundleDispatch).toHaveLength(0);
      expect(bundleCommit).toHaveLength(0);

      const supportDispatch = await readMovements(admin, supportId, 'dispatch');
      const cableDispatch = await readMovements(admin, cableId, 'dispatch');
      expect(supportDispatch.reduce((s, m) => s + (m.qty ?? 0), 0)).toBe(-6);
      expect(cableDispatch.reduce((s, m) => s + (m.qty ?? 0), 0)).toBe(-3);

      const supportCommit = await readMovements(admin, supportId, 'order_assignment_commit');
      const cableCommit = await readMovements(admin, cableId, 'order_assignment_commit');
      expect(supportCommit.reduce((s, m) => s + (m.qty ?? 0), 0)).toBe(6);
      expect(cableCommit.reduce((s, m) => s + (m.qty ?? 0), 0)).toBe(3);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 3 : composant partagé entre 2 bundles, additif
// ──────────────────────────────────────────────────────────────────────────

describe('cascade bundle : composant partagé entre 2 bundles', () => {
  skipIfNoServiceRole(
    'Support composant de bundleA (2x) et bundleB (1x) : ventes cumulées sans écrasement',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('shared-comp');
      const driverId = await createDriver(admin, merchantAccountId);
      await seedDriverShop(admin, merchantAccountId, driverId);
      const supportId = await createProduct(admin, merchantAccountId, { title: 'Support' });
      await seedProductStock(admin, supportId, merchantAccountId, 100);

      const bundleA = await createProduct(admin, merchantAccountId, {
        title: 'Bundle A',
        isBundle: true,
      });
      const bundleB = await createProduct(admin, merchantAccountId, {
        title: 'Bundle B',
        isBundle: true,
      });
      await addBundleComponent(admin, merchantAccountId, bundleA, supportId, 2);
      await addBundleComponent(admin, merchantAccountId, bundleB, supportId, 1);

      // Seed service-role : on exerce le cœur interne, jamais atteignable depuis authenticated.
      // No direct engine seed here: sold is exercised by transition_order below.

      // Bundle A : 2 vendus (2x Support chacun) → 4 Support
      // soldA is exercised through transition_order below.

      // Bundle B : 5 vendus (1x Support chacun) → 5 Support
      // soldB is exercised through transition_order below.

      async function deliverBundle(bundleId: string, qty: number) {
        const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
          { productId: bundleId, qty },
        ]);
        const client = await signIn(email);
        for (const args of [
          { p_call_state: 'validated', p_attempt_count: 1 },
          { p_delivery_state: 'scheduled' },
          { p_delivery_state: 'out_for_delivery' },
          { p_delivery_state: 'delivered', p_cash_state: 'not_due' },
        ]) {
          const result = await transitionRpc(client)('transition_order', {
            p_actor: userId,
            p_order_id: orderId,
            ...args,
          });
          expect(result.error).toBeNull();
        }
      }
      await deliverBundle(bundleA, 2);
      await deliverBundle(bundleB, 5);

      const supportSold = await readMovements(admin, supportId, 'sold');
      expect(supportSold).toHaveLength(2); // 2 lignes distinctes, pas d'écrasement
      expect(supportSold.reduce((s, m) => s + (m.qty ?? 0), 0)).toBe(9); // 4 + 5
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 4 : rejet explicite des mouvements interdits sur un bundle
// ──────────────────────────────────────────────────────────────────────────

describe('garde bundle : allocate_to_courier / courier_return_lot / driver_stock_set rejetés', () => {
  skipIfNoServiceRole('un bundle ne peut jamais être la cible de ces 3 movement_type', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('guard');
    const driverId = await createDriver(admin, merchantAccountId);
    const bundleId = await createProduct(admin, merchantAccountId, {
      title: 'Bundle',
      isBundle: true,
    });

    // Ces deux appels exercent la garde du cœur, chemin interne jamais atteignable
    // depuis une session authentifiée. 0136 : le cœur vit dans `private`, non exposé
    // par PostgREST — connexion Postgres directe.
    const allocate = await callStockMovementEngine({
      p_merchant_account_id: merchantAccountId,
      p_product_id: bundleId,
      p_movement_type: 'allocate_to_courier',
      p_qty: -1,
      p_idempotency_key: `guard:allocate:${bundleId}`,
      p_created_by: userId,
      p_driver_id: driverId,
    });
    expect(allocate.error).not.toBeNull();
    expect(allocate.error?.message).toMatch(/cannot be the target of movement_type/);

    const returnLot = await callStockMovementEngine({
      p_merchant_account_id: merchantAccountId,
      p_product_id: bundleId,
      p_movement_type: 'courier_return_lot',
      p_qty: 1,
      p_idempotency_key: `guard:return_lot:${bundleId}`,
      p_created_by: userId,
      p_driver_id: driverId,
    });
    expect(returnLot.error).not.toBeNull();
    expect(returnLot.error?.message).toMatch(/cannot be the target of movement_type/);

    const publicPost = postStockMovementRpc(await signIn(email));
    const { data: bundle } = await admin
      .from('product')
      .select('shop_id')
      .eq('id', bundleId)
      .single();
    if (!bundle?.shop_id) throw new Error('bundle shop_id missing');
    const setStock = await publicPost('post_stock_movement', {
      p_merchant_account_id: merchantAccountId,
      p_product_id: bundleId,
      p_movement_type: 'driver_stock_set',
      p_qty: 4,
      p_idempotency_key: `guard:driver_set:${bundleId}`,
      p_created_by: userId,
      p_expected_shop_id: bundle.shop_id,
      p_driver_id: driverId,
    });
    expect(setStock.error).not.toBeNull();
    expect(setStock.error?.message).toMatch(/cannot be the target of movement_type/);

    const movements = await readMovements(admin, bundleId);
    expect(movements).toHaveLength(0); // aucun des 3 n'a réussi à écrire quoi que ce soit
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 5 : contraintes anti-imbrication / anti-promotion
// ──────────────────────────────────────────────────────────────────────────

describe('contraintes composition : pas de bundle imbriqué', () => {
  skipIfNoServiceRole(
    'un composant déjà lui-même un bundle est rejeté à la composition',
    async () => {
      const { admin, merchantAccountId } = await createOwnerFixture('nested');
      const outerBundle = await createProduct(admin, merchantAccountId, {
        title: 'Outer',
        isBundle: true,
      });
      const innerBundle = await createProduct(admin, merchantAccountId, {
        title: 'Inner (also a bundle)',
        isBundle: true,
      });

      const error = await addBundleComponent(admin, merchantAccountId, outerBundle, innerBundle, 1);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/is itself a bundle/);
    },
  );

  skipIfNoServiceRole(
    'un produit déjà utilisé comme composant ne peut pas être promu bundle après coup',
    async () => {
      const { admin, merchantAccountId } = await createOwnerFixture('promote');
      const bundleId = await createProduct(admin, merchantAccountId, {
        title: 'Bundle',
        isBundle: true,
      });
      const componentId = await createProduct(admin, merchantAccountId, { title: 'Composant' });
      const composed = await addBundleComponent(admin, merchantAccountId, bundleId, componentId, 1);
      expect(composed).toBeNull();

      const { error } = await admin
        .from('product')
        .update({ is_bundle: true })
        .eq('id', componentId);

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/already used as a bundle component/);
    },
  );

  // PR 3 (UI de configuration) : saveBundleConfigurationAction n'ajoute AUCUNE validation
  // TS dupliquant ces deux contraintes — elle s'appuie entièrement sur les triggers 0107.
  // Les 2 tests ci-dessous appellent l'opération EXACTE que fait l'action (un insert
  // authentifié owner sur product_bundle_component, via ctx.supabase = un client RLS
  // identique à `client` ici), avec un payload qu'aucune UI ne permettrait de construire
  // — la preuve porte donc sur la contrainte SQL elle-même, pas sur l'absence d'option
  // dans un <select>.
  skipIfNoServiceRole(
    'saveBundleConfigurationAction contournée : un composant = le bundle lui-même est rejeté par la contrainte SQL (pas par une validation TS)',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('self-ref-direct');
      const bundleId = await createProduct(admin, merchantAccountId, {
        title: 'Bundle Auto-Ref',
        isBundle: true,
      });
      const client = await signIn(email);

      // Payload qu'aucun <select> de ProductDetailPanel ne peut produire (le produit
      // courant est filtré des candidats) — simule un appel direct à l'action avec un
      // component_product_id égal au bundle lui-même.
      const { error } = await client.from('product_bundle_component').insert({
        merchant_account_id: merchantAccountId,
        bundle_product_id: bundleId,
        component_product_id: bundleId,
        quantity: 1,
      });

      expect(error).not.toBeNull();
      // Le trigger assert_bundle_component_integrity (BEFORE INSERT) intercepte AVANT
      // que le check constraint product_bundle_component_no_self_reference ne soit
      // évalué : lire is_bundle sur le même produit pour les deux rôles bundle/composant
      // trippe systématiquement "is itself a bundle" en premier (le produit référencé
      // par lui-même DOIT être is_bundle=true pour passer le 1er check du trigger, ce
      // qui fait automatiquement échouer son 2e check "le composant ne doit pas être un
      // bundle"). Le check constraint no_self_reference reste posé en base (défense en
      // profondeur) mais est actuellement inatteignable en pratique via ce chemin — la
      // preuve recherchée ici (rejet SQL, pas TS/UI) tient malgré tout.
      expect(error?.message).toMatch(/is itself a bundle/);
    },
  );

  skipIfNoServiceRole(
    'saveBundleConfigurationAction contournée : un composant déjà bundle est rejeté par la contrainte SQL en session owner authentifiée',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('already-bundle-direct');
      const bundleId = await createProduct(admin, merchantAccountId, {
        title: 'Bundle Cible',
        isBundle: true,
      });
      const alreadyBundleId = await createProduct(admin, merchantAccountId, {
        title: 'Déjà un bundle',
        isBundle: true,
      });
      const client = await signIn(email);

      // Même appel exact que saveBundleConfigurationAction (ctx.supabase.insert), en
      // session owner réelle plutôt qu'en service-role — le composant sélectionné est
      // déjà is_bundle=true, ce qu'aucun <select> ne propose (candidateProducts filtre
      // !p.isBundle), mais que la contrainte SQL doit rejeter indépendamment.
      const { error } = await client.from('product_bundle_component').insert({
        merchant_account_id: merchantAccountId,
        bundle_product_id: bundleId,
        component_product_id: alreadyBundleId,
        quantity: 1,
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/is itself a bundle/);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 6 : fix 0109 — order_assignment_release libère le ledger des composants
// ──────────────────────────────────────────────────────────────────────────

describe('fix 0109 : annulation post-dispatch libère la disponibilité des composants', () => {
  skipIfNoServiceRole(
    "annuler après dispatch d'un bundle → le net_open de CHAQUE composant revient à 0",
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('release-fix');
      const driverId = await createDriver(admin, merchantAccountId);
      await seedDriverShop(admin, merchantAccountId, driverId);
      const supportId = await createProduct(admin, merchantAccountId, { title: 'Support' });
      const cableId = await createProduct(admin, merchantAccountId, { title: 'Câble' });
      await seedProductStock(admin, supportId, merchantAccountId, 100);
      await seedProductStock(admin, cableId, merchantAccountId, 100);

      const bundleId = await createProduct(admin, merchantAccountId, {
        title: 'Bundle',
        isBundle: true,
      });
      await addBundleComponent(admin, merchantAccountId, bundleId, supportId, 2);
      await addBundleComponent(admin, merchantAccountId, bundleId, cableId, 1);

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId: bundleId, qty: 1 },
      ]);

      const client = await signIn(email);
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
      const dispatch = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });
      expect(dispatch.error).toBeNull();

      // Avant le fix 0109, ce net_open par composant aurait été non nul (fuite de
      // disponibilité) car `required` (product_id=bundle) ne matchait jamais le ledger
      // (product_id=composant après cascade 0108).
      async function netOpenForOrder(productId: string) {
        const { data } = await admin
          .from('stock_movement')
          .select('movement_type, qty')
          .eq('order_id', orderId)
          .eq('product_id', productId)
          .in('movement_type', ['order_assignment_commit', 'order_assignment_release']);
        return (data ?? []).reduce(
          (sum, m) =>
            sum +
            (m.movement_type === 'order_assignment_commit' ? (m.qty ?? 0) : -Math.abs(m.qty ?? 0)),
          0,
        );
      }

      expect(await netOpenForOrder(supportId)).toBe(2);
      expect(await netOpenForOrder(cableId)).toBe(1);

      const cancel = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_order_state: 'cancelled',
        p_cash_state: 'not_due',
      });
      expect(cancel.error).toBeNull();

      expect(await netOpenForOrder(supportId)).toBe(0); // le point critique du fix
      expect(await netOpenForOrder(cableId)).toBe(0);
    },
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 7 : atomicité — une erreur ailleurs dans le MÊME appel annule tout,
//     y compris la cascade bundle déjà postée plus tôt dans ce même appel.
// ──────────────────────────────────────────────────────────────────────────

describe('atomicité : une erreur dans le même appel transition_order annule la cascade bundle', () => {
  skipIfNoServiceRole(
    "assigner échoue à cause d'une 2ᵉ ligne cross-tenant → aucun mouvement bundle ne survit",
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('atomic');
      const driverId = await createDriver(admin, merchantAccountId);
      await seedDriverShop(admin, merchantAccountId, driverId);
      const supportId = await createProduct(admin, merchantAccountId, { title: 'Support' });
      const cableId = await createProduct(admin, merchantAccountId, { title: 'Câble' });
      await seedProductStock(admin, supportId, merchantAccountId, 100);
      await seedProductStock(admin, cableId, merchantAccountId, 100);

      const bundleId = await createProduct(admin, merchantAccountId, {
        title: 'Bundle',
        isBundle: true,
      });
      await addBundleComponent(admin, merchantAccountId, bundleId, supportId, 2);
      await addBundleComponent(admin, merchantAccountId, bundleId, cableId, 1);

      // Produit d'un AUTRE marchand : post_stock_movement échouera dessus avec
      // "product not found for this merchant account" (garde déjà existante, indépendante
      // des bundles — cf. stock-atomicity.rls.test.ts).
      const foreign = await createOwnerFixture('atomic-foreign');
      const foreignProductId = await createProduct(foreign.admin, foreign.merchantAccountId, {
        title: 'Foreign',
      });

      const orderId = await createOrderForDriver(admin, merchantAccountId, driverId, [
        { productId: bundleId, qty: 1 },
      ]);

      const client = await signIn(email);
      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_state: 'validated',
        p_attempt_count: 1,
      });
      const scheduled = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'scheduled',
      });
      expect(scheduled.error).toBeNull();

      // Ajoute la ligne cross-tenant juste avant l'appel qui va échouer, pour ne pas
      // faire échouer confirmer/programmer (reserve/release ne cascadent pas les bundles —
      // hors scope PR1 — donc ces étapes précédentes doivent réussir normalement).
      await admin.from('order_line').insert({
        merchant_account_id: merchantAccountId,
        order_id: orderId,
        product_id: foreignProductId,
        raw_title: 'Ligne cross-tenant (fault injection)',
        qty: 1,
        match_status: 'matched',
      });

      const dispatch = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_delivery_state: 'out_for_delivery',
      });

      // L'appel échoue (la ligne cross-tenant lève "product not found for this merchant
      // account" quelque part dans la même boucle que la cascade du bundle).
      expect(dispatch.error !== null || dispatch.data === null).toBe(true);

      // L'UPDATE orders lui-même a été annulé : toujours 'scheduled', jamais avancé.
      const { data: orderAfter } = await admin
        .from('orders')
        .select('delivery_state')
        .eq('id', orderId)
        .single();
      expect(orderAfter?.delivery_state).toBe('scheduled');

      // Aucun mouvement 'dispatch' ni 'order_assignment_commit' n'a survécu pour les
      // composants du bundle, alors même que leur cascade a pu être tentée dans cet appel.
      const supportDispatch = await readMovements(admin, supportId, 'dispatch');
      const cableDispatch = await readMovements(admin, cableId, 'dispatch');
      const supportCommit = await readMovements(admin, supportId, 'order_assignment_commit');
      const cableCommit = await readMovements(admin, cableId, 'order_assignment_commit');
      expect(supportDispatch).toHaveLength(0);
      expect(cableDispatch).toHaveLength(0);
      expect(supportCommit).toHaveLength(0);
      expect(cableCommit).toHaveLength(0);

      // Et bien sûr aucun mouvement dispatch/commit n'est jamais posté sur le bundle
      // lui-même non plus (le `reserve` de l'étape confirmer, hors scope cascade décision
      // #3, reste seul présent sur le bundle — attendu, cf. test précédent).
      expect(await readMovements(admin, bundleId, 'dispatch')).toHaveLength(0);
      expect(await readMovements(admin, bundleId, 'order_assignment_commit')).toHaveLength(0);
    },
  );
});
