import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'lot-s3-rls-test-pw';
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
  throw new Error('merchant_account not found after 20 retries');
}

async function waitForDefaultShop(admin: AdminClient, merchantAccountId: string) {
  for (let i = 0; i < 30; i++) {
    const { data } = await admin
      .from('shop')
      .select('id')
      .eq('merchant_account_id', merchantAccountId)
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id as string;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('default shop not found after 30 retries');
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
  const email = `lot-s3-rls-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const shopId = await waitForDefaultShop(admin, merchantAccountId);
  return { admin, email, merchantAccountId, userId, shopId };
}

async function createShop(admin: AdminClient, merchantAccountId: string, domain: string) {
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

async function createProduct(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { data, error } = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      title: `Produit S3 ${Date.now()}`,
      unit_cost: 0,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id as string;
}

async function createLotWithLine(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string,
  productId: string,
  qty: number,
  purchasePriceTotal: number,
) {
  const { data: lot, error: lotErr } = await admin
    .from('purchase_lot')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      supplier_name: `Fournisseur S3 ${Date.now()}`,
      ordered_at: '2026-06-01',
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
      qty,
      purchase_price_total: purchasePriceTotal,
    })
    .select('id')
    .single();
  if (lineErr || !line) throw lineErr ?? new Error('purchase_lot_line insert failed');

  return { lotId: lot.id as string, lineId: line.id as string };
}

type GenericRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function receivePurchaseLotRpc(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as GenericRpc;
}

function linesPayload(lineId: string, qty: number, purchasePriceTotal: number) {
  return [
    {
      line_id: lineId,
      line_value: purchasePriceTotal,
      allocated_fees: 0,
      landed_total_value: purchasePriceTotal,
      landed_unit_cost: Math.floor(purchasePriceTotal / qty),
    },
  ];
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

// ── Lot S3 (livrable 2, migration 0150) — garde boutique de receive_purchase_lot ──
//
// receive_purchase_lot est SECURITY DEFINER, rolbypassrls=true (mesuré en
// production, docs/phaseU/S3-INVENTAIRE-RECEIVE-PURCHASE-LOT.md §3) : RLS ne
// s'applique jamais à l'intérieur de cette fonction. Sa garde interne était
// restée au niveau COMPTE (current_member_role) alors que l'isolation promise
// depuis 0127 est au niveau BOUTIQUE (current_shop_role). Même méthode que
// tests/rls/lot-f1-finances-v2-socle.rls.test.ts pour correct_purchase_lot_cost
// (0147) : appel PostgREST DIRECT (client authenticated signé, canal distinct
// de receiveLotAction/lib/actions/purchases.ts, dont la garde TS — S3 livrable
// 1, commit séparé — protège un chemin différent).

describe('receive_purchase_lot RPC — garde boutique (S3, migration 0150)', () => {
  skipIfNoServiceRole(
    "refuse un lot d'une autre boutique du même tenant (current_shop_role PAR BOUTIQUE, pas au niveau du compte)",
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('receive-cross-shop');
      const owner = await signIn(email);

      const shopB = await createShop(
        admin,
        merchantAccountId,
        `s3-cross-shop-${Date.now()}.internal`,
      );
      const productB = await createProduct(admin, merchantAccountId, shopB);
      const { lotId: lotIdB, lineId: lineIdB } = await createLotWithLine(
        admin,
        merchantAccountId,
        shopB,
        productB,
        10,
        100_000,
      );

      // seed_shop_memberships (0126) donne automatiquement à cet owner un
      // shop_member(role='owner') pour shopB aussi (owner de compte = owner de
      // toutes ses boutiques par défaut) — on retire explicitement cet accès
      // pour reproduire un accès boutique restreint après coup (scénario
      // réaliste, CLAUDE.md section Workspace), seul moyen de prouver que la
      // garde est bien scopée par boutique et non par compte.
      await admin.from('shop_member').delete().eq('shop_id', shopB).eq('user_id', userId);

      const receive = receivePurchaseLotRpc(owner);
      const { error } = await receive('receive_purchase_lot', {
        p_lot_id: lotIdB,
        p_merchant_account_id: merchantAccountId,
        p_actor_id: userId,
        p_lines: linesPayload(lineIdB, 10, 100_000),
      });

      // AVANT 0150 : error est null, le lot est reçu, un mouvement de stock est
      // posté — c'est le défaut. APRÈS 0150 : refusé, message générique
      // indistinguable d'un lot inexistant.
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/not found or not accessible/);

      const { data: lotAfter } = await admin
        .from('purchase_lot')
        .select('status, received_at')
        .eq('id', lotIdB)
        .single();
      expect(lotAfter?.status).toBe('ordered');
      expect(lotAfter?.received_at).toBeNull();

      const { data: movements } = await admin
        .from('stock_movement')
        .select('id')
        .eq('idempotency_key', `recv:${lotIdB}:${lineIdB}`);
      expect(movements ?? []).toEqual([]);
    },
  );

  skipIfNoServiceRole(
    'le chemin légitime reste ouvert : owner reçoit un lot de sa propre boutique après le durcissement 0150',
    async () => {
      const { admin, email, merchantAccountId, userId, shopId } =
        await createOwnerFixture('receive-legit');
      const owner = await signIn(email);

      const productId = await createProduct(admin, merchantAccountId, shopId);
      const { lotId, lineId } = await createLotWithLine(
        admin,
        merchantAccountId,
        shopId,
        productId,
        10,
        100_000,
      );

      const receive = receivePurchaseLotRpc(owner);
      const { error } = await receive('receive_purchase_lot', {
        p_lot_id: lotId,
        p_merchant_account_id: merchantAccountId,
        p_actor_id: userId,
        p_lines: linesPayload(lineId, 10, 100_000),
      });

      expect(error).toBeNull();

      const { data: lotAfter } = await admin
        .from('purchase_lot')
        .select('status')
        .eq('id', lotId)
        .single();
      expect(lotAfter?.status).toBe('received');

      const { data: movements } = await admin
        .from('stock_movement')
        .select('id, movement_type')
        .eq('idempotency_key', `recv:${lotId}:${lineId}`);
      expect(movements).toHaveLength(1);
      expect(movements?.[0]?.movement_type).toBe('purchase_in');
    },
  );

  skipIfNoServiceRole('refuse un appel sans session (anon)', async () => {
    const { admin, merchantAccountId, userId, shopId } = await createOwnerFixture('receive-anon');
    const productId = await createProduct(admin, merchantAccountId, shopId);
    const { lotId, lineId } = await createLotWithLine(
      admin,
      merchantAccountId,
      shopId,
      productId,
      5,
      50_000,
    );

    const anon = createClient<Database>(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const receive = receivePurchaseLotRpc(anon);
    const { error } = await receive('receive_purchase_lot', {
      p_lot_id: lotId,
      p_merchant_account_id: merchantAccountId,
      p_actor_id: userId,
      p_lines: linesPayload(lineId, 5, 50_000),
    });

    expect(error).not.toBeNull();

    const { data: lotAfter } = await admin
      .from('purchase_lot')
      .select('status')
      .eq('id', lotId)
      .single();
    expect(lotAfter?.status).toBe('ordered');
  });
});
