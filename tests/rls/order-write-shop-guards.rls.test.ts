import type { Database, Json } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

// 0163 — gardes de boutique sur les écritures de commande.
//
// replace_order_cart, reduce_order_cart_post_assignment et set_order_note sont SECURITY DEFINER :
// la RLS ne les borne pas. Avant 0163 elles ne vérifiaient que l'appartenance au COMPTE de la
// commande ; un membre du compte hors de la BOUTIQUE de la commande écrivait donc une commande
// qu'il ne peut pas lire. Contrat verrouillé ici : inexistante ou interdite (compte ou boutique)
// → P0002 / order_not_found, quel que soit l'état de la commande, et rien n'est écrit.
//
// Mutations attendues, fonction par fonction :
//   * retirer la condition de boutique de la garde PRÉALABLE → le test « hors boutique » de la
//     fonction rougit (pour les deux fonctions de panier : une erreur dépendant de l'état, ou de
//     la charge utile, répond avant P0002) ;
//   * retirer la relecture SOUS VERROU → le test « relecture sous verrou » de la fonction rougit.

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'order-write-shop-guards-password';
const pgClients: TestPostgresClient[] = [];
async function connect() {
  const client = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  pgClients.push(client);
  return client;
}
const users: string[] = [];
const run = serviceKey ? it : it.skip;
type Client = SupabaseClient<Database>;
type RpcError = { code?: string; message: string } | null;
type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: RpcError }>;
const rpc = (client: Client) => client.rpc.bind(client) as unknown as Rpc;

function admin(): Client {
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
async function createUser(db: Client, email: string) {
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('user');
  users.push(data.user.id);
  return data.user.id;
}
async function merchantOf(db: Client, userId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await db
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .maybeSingle();
    if (data) return data.id;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('merchant');
}
async function login(email: string) {
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function fixture(tag: string) {
  const db = admin();
  const suffix = `${Date.now()}-${tag}`;
  const ownerEmail = `guards-owner-${suffix}@example.com`;
  const ownerId = await createUser(db, ownerEmail);
  const merchantId = await merchantOf(db, ownerId);
  const { data: shopA } = await db
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantId)
    .eq('is_default', true)
    .single();
  if (!shopA) throw new Error('shop A');
  const shopBInsert = await db
    .from('shop')
    .insert({
      merchant_account_id: merchantId,
      shop_domain: `guards-b-${suffix}.internal`,
      scopes: '',
      store_kind: 'manual',
      display_name: 'B',
    })
    .select('id')
    .single();
  if (!shopBInsert.data) throw shopBInsert.error;
  const shopB = shopBInsert.data.id;

  // Membres : restreints à la boutique A. Le trigger leur donne toutes les boutiques ; on retire B.
  async function member(role: 'manager' | 'agent', shops: string[]) {
    const email = `guards-${role}-${shops.length}-${suffix}@example.com`;
    const id = await createUser(db, email);
    await db.from('merchant_account').delete().eq('owner_user_id', id);
    const inserted = await db
      .from('merchant_member')
      .insert({ merchant_account_id: merchantId, role, user_id: id });
    if (inserted.error) throw inserted.error;
    const removed = await db
      .from('shop_member')
      .delete()
      .eq('user_id', id)
      .not('shop_id', 'in', `(${shops.join(',') || '00000000-0000-0000-0000-000000000000'})`);
    if (removed.error) throw removed.error;
    return login(email);
  }
  const outsiderEmail = `guards-outsider-${suffix}@example.com`;
  await createUser(db, outsiderEmail);

  const driver = await db
    .from('driver')
    .insert({
      merchant_account_id: merchantId,
      full_name: 'Livreur',
      phone: `+22177${suffix.replace(/\D/g, '').slice(-7).padStart(7, '0')}`,
    })
    .select('id')
    .single();
  if (!driver.data) throw driver.error;
  const driverId = driver.data.id;
  for (const shopId of [shopA.id, shopB]) {
    const link = await db
      .from('driver_shop')
      .insert({ merchant_account_id: merchantId, shop_id: shopId, driver_id: driverId });
    if (link.error) throw link.error;
  }
  async function product(shopId: string) {
    const result = await db
      .from('product')
      .insert({
        merchant_account_id: merchantId,
        shop_id: shopId,
        title: `Produit ${Math.random()}`,
        unit_cost: 100,
      })
      .select('id, title')
      .single();
    if (!result.data) throw result.error;
    return result.data;
  }
  async function order(shopId: string, state: 'unassigned' | 'assigned') {
    const p = await product(shopId);
    const summary: Json[] = [{ product_id: p.id, title: p.title, quantity: 2, price: 5000 }];
    const created = await db
      .from('orders')
      .insert({
        merchant_account_id: merchantId,
        shop_id: shopId,
        order_number: `GRD-${suffix}-${Math.random()}`,
        total_amount: 10_000,
        currency: 'XOF',
        order_state: 'open',
        call_state: state === 'assigned' ? 'validated' : 'to_call',
        delivery_state: state,
        cash_state: state === 'assigned' ? 'expected' : 'not_due',
        assigned_driver_id: state === 'assigned' ? driverId : null,
        items_summary: summary,
      })
      .select('id')
      .single();
    if (!created.data) throw created.error;
    const line = await db.from('order_line').insert({
      merchant_account_id: merchantId,
      shop_id: shopId,
      order_id: created.data.id,
      product_id: p.id,
      raw_title: p.title,
      qty: 2,
      match_status: 'matched',
    });
    if (line.error) throw line.error;
    if (state === 'assigned') {
      const commit = await db.from('stock_movement').insert({
        merchant_account_id: merchantId,
        shop_id: shopId,
        product_id: p.id,
        movement_type: 'order_assignment_commit',
        qty: 2,
        idempotency_key: `guards-commit-${created.data.id}`,
        created_by: ownerId,
        order_id: created.data.id,
        driver_id: driverId,
      });
      if (commit.error) throw commit.error;
    }
    return { id: created.data.id, productId: p.id };
  }
  async function snapshot(orderId: string) {
    const [o, l, m, a] = await Promise.all([
      db.from('orders').select('note, total_amount, items_summary').eq('id', orderId).single(),
      db.from('order_line').select('product_id, qty').eq('order_id', orderId),
      db.from('stock_movement').select('movement_type, qty').eq('order_id', orderId),
      db.from('audit_log').select('action').eq('resource_id', orderId),
    ]);
    return JSON.stringify({
      o: o.data,
      l: l.data,
      m: (m.data ?? []).length,
      a: (a.data ?? []).length,
    });
  }
  return {
    db,
    order,
    snapshot,
    shopA: shopA.id,
    shopB,
    owner: await login(ownerEmail),
    managerA: await member('manager', [shopA.id]),
    agentA: await member('agent', [shopA.id]),
    noShop: await member('manager', []),
    outsider: await login(outsiderEmail),
    anon: createClient<Database>(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }),
  };
}

afterEach(async () => {
  if (serviceKey) await Promise.all(users.splice(0).map((id) => admin().auth.admin.deleteUser(id)));
});

afterAll(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.end().catch(() => undefined)));
});

const NOT_FOUND = { code: 'P0002', message: 'order_not_found' };

/**
 * Joue la course que la garde préalable ne voit pas. Une transaction concurrente tient le verrou
 * de la commande et y pose un changement non validé ; l'appel passe sa garde préalable sur
 * l'ancien état, attend le verrou, puis relit la commande une fois le changement validé.
 */
async function raceUnderLock(
  orderId: string,
  functionName: string,
  change: (holder: TestPostgresClient) => Promise<unknown>,
  call: () => PromiseLike<{ data: unknown; error: RpcError }>,
) {
  const [holder, observer] = await Promise.all([connect(), connect()]);
  await holder.query('begin');
  try {
    await holder.query('select id from public.orders where id = $1 for update', [orderId]);
    await change(holder);
    const pending = (async () => await call())();

    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const { rows } = await observer.query(
        `select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike $1 and pid <> pg_backend_pid()`,
        [`%${functionName}%`],
      );
      waiting = rows[0].n > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // L'appel a franchi sa garde préalable et attend le verrou de la commande.
    expect(waiting).toBe(true);

    await holder.query('commit');
    return await pending;
  } catch (error) {
    await holder.query('rollback').catch(() => undefined);
    throw error;
  }
}
const cart = (productId: string, quantity: number) => [
  { product_id: productId, quantity, unit_price: 5000 },
];

describe('0163 — gardes de boutique sur les écritures de commande', () => {
  run(
    'set_order_note : hors boutique, hors compte et inexistante → P0002, note inchangée',
    async () => {
      const f = await fixture('note-deny');
      const target = await f.order(f.shopB, 'unassigned');
      const before = await f.snapshot(target.id);
      for (const client of [f.managerA, f.agentA, f.noShop, f.outsider]) {
        const { error } = await rpc(client)('set_order_note', {
          p_order_id: target.id,
          p_note: 'interdit',
        });
        expect(error).toMatchObject(NOT_FOUND);
      }
      const ghost = await rpc(f.owner)('set_order_note', {
        p_order_id: crypto.randomUUID(),
        p_note: 'x',
      });
      expect(ghost.error).toMatchObject(NOT_FOUND);
      const anon = await rpc(f.anon)('set_order_note', { p_order_id: target.id, p_note: 'x' });
      expect(anon.error).not.toBeNull();
      expect(await f.snapshot(target.id)).toBe(before);
    },
  );

  run('set_order_note : membres de la boutique → note écrite', async () => {
    const f = await fixture('note-allow');
    const inA = await f.order(f.shopA, 'unassigned');
    const inB = await f.order(f.shopB, 'unassigned');
    expect(
      (await rpc(f.agentA)('set_order_note', { p_order_id: inA.id, p_note: 'agent' })).error,
    ).toBeNull();
    expect(
      (await rpc(f.managerA)('set_order_note', { p_order_id: inA.id, p_note: 'manager' })).error,
    ).toBeNull();
    expect(
      (await rpc(f.owner)('set_order_note', { p_order_id: inB.id, p_note: 'owner' })).error,
    ).toBeNull();
    const { data } = await f.db.from('orders').select('id, note').in('id', [inA.id, inB.id]);
    expect(Object.fromEntries((data ?? []).map((r) => [r.id, r.note]))).toEqual({
      [inA.id]: 'manager',
      [inB.id]: 'owner',
    });
  });

  run(
    'replace_order_cart : hors boutique → P0002 quel que soit l’état, panier inchangé',
    async () => {
      const f = await fixture('replace-deny');
      const editable = await f.order(f.shopB, 'unassigned');
      const assigned = await f.order(f.shopB, 'assigned');
      for (const target of [editable, assigned]) {
        const before = await f.snapshot(target.id);
        for (const client of [f.managerA, f.noShop, f.outsider]) {
          const { error } = await rpc(client)('replace_order_cart', {
            p_order_id: target.id,
            p_lines: cart(target.productId, 1),
          });
          expect(error).toMatchObject(NOT_FOUND);
        }
        // Charge utile invalide : la réponse reste P0002, jamais une erreur de validation.
        const invalid = await rpc(f.managerA)('replace_order_cart', {
          p_order_id: target.id,
          p_lines: [],
        });
        expect(invalid.error).toMatchObject(NOT_FOUND);
        expect(await f.snapshot(target.id)).toBe(before);
      }
    },
  );

  run('replace_order_cart : membres de la boutique → comportement inchangé', async () => {
    const f = await fixture('replace-allow');
    const inA = await f.order(f.shopA, 'unassigned');
    const inB = await f.order(f.shopB, 'unassigned');
    const assignedA = await f.order(f.shopA, 'assigned');
    expect(
      (
        await rpc(f.managerA)('replace_order_cart', {
          p_order_id: inA.id,
          p_lines: cart(inA.productId, 1),
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await rpc(f.owner)('replace_order_cart', {
          p_order_id: inB.id,
          p_lines: cart(inB.productId, 3),
        })
      ).error,
    ).toBeNull();
    const { data } = await f.db
      .from('order_line')
      .select('order_id, qty')
      .in('order_id', [inA.id, inB.id]);
    expect(Object.fromEntries((data ?? []).map((r) => [r.order_id, r.qty]))).toEqual({
      [inA.id]: 1,
      [inB.id]: 3,
    });
    // Rôle insuffisant dans la boutique : toujours 42501. État interdit : toujours l'erreur d'état.
    const agent = await rpc(f.agentA)('replace_order_cart', {
      p_order_id: inA.id,
      p_lines: cart(inA.productId, 2),
    });
    expect(agent.error).toMatchObject({ code: '42501', message: 'forbidden' });
    const state = await rpc(f.managerA)('replace_order_cart', {
      p_order_id: assignedA.id,
      p_lines: cart(assignedA.productId, 1),
    });
    expect(state.error).toMatchObject({
      code: '22023',
      message: 'cart_edit_not_allowed_after_assignment',
    });
  });

  run(
    'reduce_order_cart_post_assignment : hors boutique → P0002, quantité, total, stock et audit inchangés',
    async () => {
      const f = await fixture('reduce-deny');
      const assigned = await f.order(f.shopB, 'assigned');
      const unassigned = await f.order(f.shopB, 'unassigned');
      for (const target of [assigned, unassigned]) {
        const before = await f.snapshot(target.id);
        for (const client of [f.managerA, f.noShop, f.outsider]) {
          const { error } = await rpc(client)('reduce_order_cart_post_assignment', {
            p_order_id: target.id,
            p_lines: [{ product_id: target.productId, quantity: 1 }],
          });
          expect(error).toMatchObject(NOT_FOUND);
        }
        // Charge utile invalide : la réponse reste P0002, jamais une erreur de validation. C'est
        // ce cas qui distingue la garde préalable de la relecture sous verrou.
        const invalid = await rpc(f.managerA)('reduce_order_cart_post_assignment', {
          p_order_id: target.id,
          p_lines: [],
        });
        expect(invalid.error).toMatchObject(NOT_FOUND);
        expect(await f.snapshot(target.id)).toBe(before);
      }
    },
  );

  run(
    'reduce_order_cart_post_assignment : membres de la boutique → comportement inchangé',
    async () => {
      const f = await fixture('reduce-allow');
      const inB = await f.order(f.shopB, 'assigned');
      const inA = await f.order(f.shopA, 'assigned');
      const lines = (o: { productId: string }) => [{ product_id: o.productId, quantity: 1 }];
      expect(
        (
          await rpc(f.owner)('reduce_order_cart_post_assignment', {
            p_order_id: inB.id,
            p_lines: lines(inB),
          })
        ).error,
      ).toBeNull();
      expect(
        (
          await rpc(f.managerA)('reduce_order_cart_post_assignment', {
            p_order_id: inA.id,
            p_lines: lines(inA),
          })
        ).error,
      ).toBeNull();
      const { data: orders } = await f.db
        .from('orders')
        .select('id, total_amount')
        .in('id', [inA.id, inB.id]);
      expect((orders ?? []).map((o) => Number(o.total_amount))).toEqual([5000, 5000]);
      const { data: releases } = await f.db
        .from('stock_movement')
        .select('order_id, qty')
        .in('order_id', [inA.id, inB.id])
        .eq('movement_type', 'order_assignment_release');
      expect((releases ?? []).map((r) => r.qty).sort()).toEqual([-1, -1]);
      const agentOrder = await f.order(f.shopA, 'assigned');
      const agent = await rpc(f.agentA)('reduce_order_cart_post_assignment', {
        p_order_id: agentOrder.id,
        p_lines: lines(agentOrder),
      });
      expect(agent.error).toMatchObject({ code: '42501', message: 'forbidden' });
    },
  );
});

describe('0163 — relecture sous verrou', () => {
  type Target = { id: string; productId: string };
  const calls = {
    reduce_order_cart_post_assignment: (target: Target) => ({
      p_lines: [{ product_id: target.productId, quantity: 1 }],
      p_order_id: target.id,
    }),
    replace_order_cart: (target: Target) => ({
      p_lines: cart(target.productId, 1),
      p_order_id: target.id,
    }),
    set_order_note: (target: Target) => ({
      p_note: 'écrite pendant la course',
      p_order_id: target.id,
    }),
  } as const;
  const states = {
    reduce_order_cart_post_assignment: 'assigned',
    replace_order_cart: 'unassigned',
    set_order_note: 'unassigned',
  } as const;

  for (const fn of Object.keys(calls) as Array<keyof typeof calls>) {
    run(
      `${fn} : la commande change de boutique entre la garde et le verrou → P0002, rien d écrit`,
      async () => {
        const f = await fixture(`lock-shop-${fn.slice(0, 6)}`);
        const target = await f.order(f.shopA, states[fn]);
        const before = await f.snapshot(target.id);

        const { error } = await raceUnderLock(
          target.id,
          fn,
          // La base interdit de changer la boutique d'une commande (store_context_immutable) :
          // le changement est SIMULÉ, triggers neutralisés dans cette seule transaction.
          async (holder) => {
            await holder.query("set local session_replication_role = 'replica'");
            await holder.query('update public.orders set shop_id = $1 where id = $2', [
              f.shopB,
              target.id,
            ]);
          },
          () => rpc(f.managerA)(fn, calls[fn](target)),
        );

        expect(error).toMatchObject(NOT_FOUND);
        expect(await f.snapshot(target.id)).toBe(before);
        const moved = await f.db.from('orders').select('shop_id').eq('id', target.id).single();
        expect(moved.data?.shop_id).toBe(f.shopB);
      },
    );
  }

  for (const fn of ['replace_order_cart', 'reduce_order_cart_post_assignment'] as const) {
    run(
      `${fn} : l accès à la boutique est retiré entre la garde et le verrou → P0002, rien d écrit`,
      async () => {
        const f = await fixture(`lock-member-${fn.slice(0, 6)}`);
        const target = await f.order(f.shopA, states[fn]);
        const before = await f.snapshot(target.id);

        const { error } = await raceUnderLock(
          target.id,
          fn,
          // managerA est le seul manager à avoir accès à la boutique A.
          (holder) =>
            holder.query("delete from public.shop_member where shop_id = $1 and role = 'manager'", [
              f.shopA,
            ]),
          () => rpc(f.managerA)(fn, calls[fn](target)),
        );

        expect(error).toMatchObject(NOT_FOUND);
        expect(await f.snapshot(target.id)).toBe(before);
      },
    );
  }

  run(
    'contrôle positif : sans changement concurrent, l appel qui attend le verrou aboutit',
    async () => {
      const f = await fixture('lock-positive');
      const target = await f.order(f.shopA, 'unassigned');

      const { error } = await raceUnderLock(
        target.id,
        'set_order_note',
        async () => undefined,
        () => rpc(f.managerA)('set_order_note', calls.set_order_note(target)),
      );

      expect(error).toBeNull();
      const written = await f.db.from('orders').select('note').eq('id', target.id).single();
      expect(written.data?.note).toBe('écrite pendant la course');
    },
  );
});
