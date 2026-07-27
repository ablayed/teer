import type { Database, Json } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'cart-reduction-rls-password';
const users: string[] = [];
const run = serviceKey ? it : it.skip;
type Admin = SupabaseClient<Database>;

type ReduceArgs = { p_order_id: string; p_lines: Array<{ product_id: string; quantity: number }> };
function reduce(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as (
    fn: 'reduce_order_cart_post_assignment',
    args: ReduceArgs,
  ) => Promise<{ data: null; error: { message: string } | null }>;
}
function admin(): Admin {
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
async function user(client: Admin, email: string) {
  const { data, error } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('user');
  users.push(data.user.id);
  return data.user.id;
}
async function merchant(client: Admin, userId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await client
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
  const ownerEmail = `reduce-owner-${suffix}@example.com`;
  const ownerId = await user(db, ownerEmail);
  const merchantId = await merchant(db, ownerId);
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
  async function product(title: string, isBundle = false) {
    const result = await db
      .from('product')
      .insert({ merchant_account_id: merchantId, title, unit_cost: 100, is_bundle: isBundle })
      .select('id')
      .single();
    if (!result.data) throw result.error;
    return result.data.id;
  }
  const driverId = driver.data.id;
  async function order(lines: Array<{ id: string; qty: number; price: number }>, summary?: Json[]) {
    const total = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
    const created = await db
      .from('orders')
      .insert({
        merchant_account_id: merchantId,
        order_number: `RED-${suffix}-${Math.random()}`,
        total_amount: total,
        currency: 'XOF',
        order_state: 'open',
        call_state: 'validated',
        delivery_state: 'assigned',
        cash_state: 'not_due',
        assigned_driver_id: driverId,
        items_summary:
          summary ??
          lines.map((line) => ({
            product_id: line.id,
            title: 'Produit',
            quantity: line.qty,
            price: line.price,
          })),
      })
      .select('id')
      .single();
    if (!created.data) throw created.error;
    const inserted = await db.from('order_line').insert(
      lines.map((line) => ({
        merchant_account_id: merchantId,
        order_id: created.data.id,
        product_id: line.id,
        raw_title: 'Produit',
        qty: line.qty,
        match_status: 'matched',
      })),
    );
    if (inserted.error) throw inserted.error;
    const commitments = await db.from('stock_movement').insert(
      lines.map((line) => ({
        merchant_account_id: merchantId,
        product_id: line.id,
        movement_type: 'order_assignment_commit',
        qty: line.qty,
        idempotency_key: `reduce-commit-${created.data.id}-${line.id}`,
        created_by: ownerId,
        order_id: created.data.id,
        driver_id: driverId,
      })),
    );
    if (commitments.error) throw commitments.error;
    return created.data.id;
  }
  const agentEmail = `reduce-agent-${suffix}@example.com`;
  const agentId = await user(db, agentEmail);
  await db.from('merchant_account').delete().eq('owner_user_id', agentId);
  await db
    .from('merchant_member')
    .insert({ merchant_account_id: merchantId, role: 'agent', user_id: agentId });
  return {
    agent: await login(agentEmail),
    db,
    driverId,
    merchantId,
    order,
    owner: await login(ownerEmail),
    ownerId,
    product,
  };
}
afterEach(async () => {
  if (serviceKey) await Promise.all(users.splice(0).map((id) => admin().auth.admin.deleteUser(id)));
});

describe('reduce_order_cart_post_assignment', () => {
  run(
    'réduction partielle et suppression complète libèrent exactement le ledger du livreur',
    async () => {
      const f = await fixture('delta');
      const a = await f.product('A');
      const b = await f.product('B');
      const id = await f.order([
        { id: a, qty: 2, price: 100 },
        { id: b, qty: 1, price: 50 },
      ]);
      const result = await reduce(f.owner)('reduce_order_cart_post_assignment', {
        p_order_id: id,
        p_lines: [{ product_id: a, quantity: 1 }],
      });
      expect(result.error).toBeNull();
      const { data: releases } = await f.db
        .from('stock_movement')
        .select('product_id,qty,driver_id')
        .eq('order_id', id)
        .eq('movement_type', 'order_assignment_release');
      expect(releases).toEqual(
        expect.arrayContaining([
          { product_id: a, qty: -1, driver_id: f.driverId },
          { product_id: b, qty: -1, driver_id: f.driverId },
        ]),
      );
      const { data: order } = await f.db
        .from('orders')
        .select('total_amount,cash_collectable_minor')
        .eq('id', id)
        .single();
      expect(order).toMatchObject({ total_amount: 100, cash_collectable_minor: 100 });
    },
  );

  run('rejette ajout, hausse, cash dû, prix ambigu et agent', async () => {
    const f = await fixture('reject');
    const a = await f.product('A');
    const b = await f.product('B');
    const id = await f.order([{ id: a, qty: 1, price: 100 }]);
    await expect(
      reduce(f.owner)('reduce_order_cart_post_assignment', {
        p_order_id: id,
        p_lines: [{ product_id: a, quantity: 2 }],
      }),
    ).resolves.toMatchObject({
      error: { message: 'cart_reduction_quantity_increase_not_allowed' },
    });
    await expect(
      reduce(f.owner)('reduce_order_cart_post_assignment', {
        p_order_id: id,
        p_lines: [{ product_id: b, quantity: 1 }],
      }),
    ).resolves.toMatchObject({ error: { message: 'cart_reduction_product_not_in_order' } });
    await f.db.from('orders').update({ cash_state: 'expected' }).eq('id', id);
    await expect(
      reduce(f.owner)('reduce_order_cart_post_assignment', {
        p_order_id: id,
        p_lines: [{ product_id: a, quantity: 1 }],
      }),
    ).resolves.toMatchObject({ error: { message: 'cart_reduction_not_allowed_after_cash_due' } });
  });

  run('rejette un prix ambigu et un agent', async () => {
    const f = await fixture('ambiguous');
    const a = await f.product('A');
    const id = await f.order(
      [{ id: a, qty: 2, price: 100 }],
      [
        { product_id: a, title: 'Produit', quantity: 1, price: 100 },
        { product_id: a, title: 'Produit', quantity: 1, price: 200 },
      ],
    );
    await expect(
      reduce(f.owner)('reduce_order_cart_post_assignment', {
        p_order_id: id,
        p_lines: [{ product_id: a, quantity: 1 }],
      }),
    ).resolves.toMatchObject({ error: { message: 'cart_reduction_ambiguous_existing_price' } });
    await expect(
      reduce(f.agent)('reduce_order_cart_post_assignment', {
        p_order_id: id,
        p_lines: [{ product_id: a, quantity: 1 }],
      }),
    ).resolves.toMatchObject({ error: { message: 'forbidden' } });
  });

  run('rejette deux livreurs avec un engagement net ouvert sur le même produit', async () => {
    const f = await fixture('multi-driver');
    const a = await f.product('A');
    const id = await f.order([{ id: a, qty: 2, price: 100 }]);
    const second = await f.db
      .from('driver')
      .insert({
        merchant_account_id: f.merchantId,
        full_name: 'Second livreur',
        phone: '+221778888888',
      })
      .select('id')
      .single();
    if (!second.data) throw second.error;
    await f.db.from('stock_movement').insert({
      merchant_account_id: f.merchantId,
      product_id: a,
      movement_type: 'order_assignment_commit',
      qty: 1,
      idempotency_key: `second-${id}`,
      created_by: f.ownerId,
      order_id: id,
      driver_id: second.data.id,
    });
    await expect(
      reduce(f.owner)('reduce_order_cart_post_assignment', {
        p_order_id: id,
        p_lines: [{ product_id: a, quantity: 1 }],
      }),
    ).resolves.toMatchObject({
      error: { message: 'cart_reduction_multiple_open_commitment_drivers' },
    });
  });

  run('réduit un bundle et libère exactement ses composants, jamais le bundle', async () => {
    const f = await fixture('bundle');
    const componentA = await f.product('Composant A');
    const componentB = await f.product('Composant B');
    const bundle = await f.product('Bundle', true);
    await f.db.from('product_bundle_component').insert([
      {
        merchant_account_id: f.merchantId,
        bundle_product_id: bundle,
        component_product_id: componentA,
        quantity: 2,
      },
      {
        merchant_account_id: f.merchantId,
        bundle_product_id: bundle,
        component_product_id: componentB,
        quantity: 1,
      },
    ]);
    const id = await f.order([{ id: bundle, qty: 2, price: 500 }]);
    await f.db
      .from('stock_movement')
      .delete()
      .eq('order_id', id)
      .eq('movement_type', 'order_assignment_commit');
    await f.db.from('stock_movement').insert([
      {
        merchant_account_id: f.merchantId,
        product_id: componentA,
        movement_type: 'order_assignment_commit',
        qty: 4,
        idempotency_key: `bundle-a-${id}`,
        created_by: f.ownerId,
        order_id: id,
        driver_id: f.driverId,
      },
      {
        merchant_account_id: f.merchantId,
        product_id: componentB,
        movement_type: 'order_assignment_commit',
        qty: 2,
        idempotency_key: `bundle-b-${id}`,
        created_by: f.ownerId,
        order_id: id,
        driver_id: f.driverId,
      },
    ]);
    const result = await reduce(f.owner)('reduce_order_cart_post_assignment', {
      p_order_id: id,
      p_lines: [{ product_id: bundle, quantity: 1 }],
    });
    expect(result.error).toBeNull();
    const { data } = await f.db
      .from('stock_movement')
      .select('product_id,qty')
      .eq('order_id', id)
      .eq('movement_type', 'order_assignment_release');
    expect(data).toEqual(
      expect.arrayContaining([
        { product_id: componentA, qty: -2 },
        { product_id: componentB, qty: -1 },
      ]),
    );
    expect(data?.some((row) => row.product_id === bundle)).toBe(false);
  });
});
