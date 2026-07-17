import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'order-cart-rls-test-password';
const createdUserIds: string[] = [];
const skipIfNoServiceRole = serviceRoleKey ? it : it.skip;

type AdminClient = SupabaseClient<Database>;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(admin: AdminClient, email: string) {
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
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('merchant_account not found');
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  await Promise.all(createdUserIds.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
});

describe('replace_order_cart — accès et atomicité', () => {
  skipIfNoServiceRole(
    'manager remplace le panier; agent et commande assignée sont refusés',
    async () => {
      const admin = adminClient();
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ownerEmail = `cart-owner-${suffix}@example.com`;
      const ownerId = await createUser(admin, ownerEmail);
      const merchantAccountId = await waitForMerchantAccount(admin, ownerId);

      const managerEmail = `cart-manager-${suffix}@example.com`;
      const managerId = await createUser(admin, managerEmail);
      const agentEmail = `cart-agent-${suffix}@example.com`;
      const agentId = await createUser(admin, agentEmail);
      await admin.from('merchant_account').delete().in('owner_user_id', [managerId, agentId]);
      await admin.from('merchant_member').insert([
        { merchant_account_id: merchantAccountId, role: 'manager', user_id: managerId },
        { merchant_account_id: merchantAccountId, role: 'agent', user_id: agentId },
      ]);

      const { data: product, error: productError } = await admin
        .from('product')
        .insert({
          merchant_account_id: merchantAccountId,
          title: 'Produit panier RLS',
          unit_cost: 100,
        })
        .select('id')
        .single();
      if (productError || !product) throw productError ?? new Error('product not created');

      const { data: driver, error: driverError } = await admin
        .from('driver')
        .insert({
          merchant_account_id: merchantAccountId,
          full_name: 'Livreur panier RLS',
          phone: '+221770000000',
        })
        .select('id')
        .single();
      if (driverError || !driver) throw driverError ?? new Error('driver not created');

      const { data: order, error: orderError } = await admin
        .from('orders')
        .insert({
          merchant_account_id: merchantAccountId,
          order_number: `CART-RLS-${suffix}`,
          total_amount: 100,
          currency: 'XOF',
          order_state: 'open',
          call_state: 'to_call',
          delivery_state: 'unassigned',
          cash_state: 'not_due',
          items_summary: [{ title: 'Ancien produit', quantity: 1, price: 100 }],
        })
        .select('id')
        .single();
      if (orderError || !order) throw orderError ?? new Error('order not created');

      const manager = await signIn(managerEmail);
      const managerUpdate = await manager.rpc('replace_order_cart', {
        p_order_id: order.id,
        p_lines: [{ product_id: product.id, quantity: 2, unit_price: 120 }],
      });
      expect(managerUpdate.error).toBeNull();

      const { data: updated } = await admin
        .from('orders')
        .select('total_amount, cash_collectable_minor, cart_locally_modified_at')
        .eq('id', order.id)
        .single();
      expect(updated).toMatchObject({ total_amount: 240, cash_collectable_minor: 240 });
      expect(updated?.cart_locally_modified_at).toBeTruthy();

      const { data: lines } = await admin
        .from('order_line')
        .select('product_id, qty, match_status')
        .eq('order_id', order.id);
      expect(lines).toEqual([{ product_id: product.id, qty: 2, match_status: 'matched' }]);

      const agent = await signIn(agentEmail);
      const agentUpdate = await agent.rpc('replace_order_cart', {
        p_order_id: order.id,
        p_lines: [{ product_id: product.id, quantity: 1, unit_price: 10 }],
      });
      expect(agentUpdate.error).not.toBeNull();

      const assignment = await admin
        .from('orders')
        .update({ assigned_driver_id: driver.id, delivery_state: 'assigned' })
        .eq('id', order.id)
        .select('delivery_state')
        .single();
      expect(assignment.error).toBeNull();
      expect(assignment.data?.delivery_state).toBe('assigned');
      const afterAssignment = await manager.rpc('replace_order_cart', {
        p_order_id: order.id,
        p_lines: [{ product_id: product.id, quantity: 1, unit_price: 10 }],
      });
      expect(afterAssignment.error).not.toBeNull();
    },
  );
});
