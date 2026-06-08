import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'ia-rls-test-pw';
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

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password });
  return client;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `ia-rls-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `ia-member-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  return { email, userId };
}

async function seedProductWithCump(admin: AdminClient, merchantId: string, unitCost: number) {
  const { data: product, error } = await admin
    .from('product')
    .insert({ merchant_account_id: merchantId, title: 'Produit test IA', unit_cost: 0 })
    .select('id')
    .single();
  if (error || !product) throw error ?? new Error('product insert failed');
  await admin.from('product_stock').insert({
    product_id: product.id,
    merchant_account_id: merchantId,
    qty_on_hand: 10,
    unit_cost: unitCost,
  });
  return product.id;
}

async function seedSoldMovement(
  admin: AdminClient,
  merchantId: string,
  productId: string,
  createdBy: string,
  unitCost: number,
) {
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantId,
      total_amount: 10_000,
      order_state: 'completed',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
    })
    .select('id')
    .single();
  if (orderErr || !order) throw orderErr ?? new Error('order insert failed');

  const { error: moveErr } = await admin.from('stock_movement').insert({
    merchant_account_id: merchantId,
    product_id: productId,
    movement_type: 'sold',
    qty: 1,
    unit_cost: unitCost,
    order_id: order.id,
    idempotency_key: `ia-sold-${order.id}`,
    created_by: createdBy,
  });
  if (moveErr) throw moveErr;
  return order.id;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

// ── ia_conversation / ia_message ───────────────────────────────────────────

describe('ia_conversation / ia_message — scope tenant + user (RLS)', () => {
  skipIfNoServiceRole('un utilisateur ne lit que ses propres conversations', async () => {
    const { merchantAccountId, email, userId, admin } = await createOwnerFixture('conv-own');
    const owner = await signIn(email);
    const { data: conv, error } = await owner
      .from('ia_conversation')
      .insert({ merchant_account_id: merchantAccountId, user_id: userId, title: 'Ma conv' })
      .select('id')
      .single();
    expect(error).toBeNull();
    expect(conv?.id).toBeTruthy();

    const { data: mine } = await owner.from('ia_conversation').select('id');
    expect(mine).toHaveLength(1);

    // Un manager du MÊME tenant ne voit pas la conversation de l'owner.
    const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');
    const manager = await signIn(managerEmail);
    const { data: managerView } = await manager.from('ia_conversation').select('id');
    expect(managerView).toHaveLength(0);
  });

  skipIfNoServiceRole('isolation cross-tenant des conversations', async () => {
    const a = await createOwnerFixture('conv-a');
    const b = await createOwnerFixture('conv-b');
    const ownerB = await signIn(b.email);
    await ownerB
      .from('ia_conversation')
      .insert({ merchant_account_id: b.merchantAccountId, user_id: b.userId, title: 'B conv' });

    const ownerA = await signIn(a.email);
    const { data } = await ownerA.from('ia_conversation').select('id');
    expect(data).toHaveLength(0);
  });

  skipIfNoServiceRole('les messages suivent la possession de la conversation', async () => {
    const { merchantAccountId, email, userId, admin } = await createOwnerFixture('msg');
    const owner = await signIn(email);
    const { data: conv } = await owner
      .from('ia_conversation')
      .insert({ merchant_account_id: merchantAccountId, user_id: userId })
      .select('id')
      .single();
    const conversationId = conv?.id as string;

    const { error: insertErr } = await owner.from('ia_message').insert({
      conversation_id: conversationId,
      merchant_account_id: merchantAccountId,
      role: 'user',
      content: 'Bonjour',
    });
    expect(insertErr).toBeNull();

    const { data: mine } = await owner.from('ia_message').select('id');
    expect(mine).toHaveLength(1);

    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const agent = await signIn(agentEmail);
    const { data: agentView } = await agent.from('ia_message').select('id');
    expect(agentView).toHaveLength(0);
  });
});

// ── ia_tool_audit ────────────────────────────────────────────────────────

describe('ia_tool_audit — owner-only en lecture, écriture via definer (RLS)', () => {
  skipIfNoServiceRole(
    'owner journalise (incl. refus) et lit ; manager/agent ne lisent rien',
    async () => {
      const { merchantAccountId, email, admin } = await createOwnerFixture('audit');
      const owner = await signIn(email);

      // Écriture via la RPC SECURITY DEFINER : un appel autorisé ET un refus.
      const allowed = await owner.rpc('log_ia_tool_audit', {
        p_merchant_account_id: merchantAccountId,
        p_user_role: 'owner',
        p_tool_name: 'get_margin',
        p_tool_args: { period: '30d' },
        p_allowed: true,
      });
      expect(allowed.error).toBeNull();
      await owner.rpc('log_ia_tool_audit', {
        p_merchant_account_id: merchantAccountId,
        p_user_role: 'agent',
        p_tool_name: 'get_margin',
        p_tool_args: {},
        p_allowed: false,
        p_denied_reason: 'forbidden_role',
      });

      const { data: ownerView, error: ownerErr } = await owner.from('ia_tool_audit').select('id');
      expect(ownerErr).toBeNull();
      expect((ownerView ?? []).length).toBeGreaterThanOrEqual(2);

      // Insertion directe interdite (aucune policy d'écriture).
      const { error: directInsert } = await owner.from('ia_tool_audit').insert({
        merchant_account_id: merchantAccountId,
        user_id: (await owner.auth.getUser()).data.user?.id ?? '',
        user_role: 'owner',
        tool_name: 'x',
        allowed: true,
      });
      expect(directInsert).not.toBeNull();

      const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');
      const manager = await signIn(managerEmail);
      const { data: managerView } = await manager.from('ia_tool_audit').select('id');
      expect(managerView).toHaveLength(0);
    },
  );

  skipIfNoServiceRole(
    'ia_count_recent_tool_calls compte les appels récents du caller',
    async () => {
      const { merchantAccountId, email } = await createOwnerFixture('count');
      const owner = await signIn(email);
      await owner.rpc('log_ia_tool_audit', {
        p_merchant_account_id: merchantAccountId,
        p_user_role: 'owner',
        p_tool_name: 'get_revenue',
        p_tool_args: {},
        p_allowed: true,
      });
      const since = new Date(Date.now() - 60_000).toISOString();
      const { data, error } = await owner.rpc('ia_count_recent_tool_calls', {
        p_merchant_account_id: merchantAccountId,
        p_since: since,
      });
      expect(error).toBeNull();
      expect(Number(data ?? 0)).toBeGreaterThanOrEqual(1);
    },
  );
});

// ── RPC finance owner/manager (déblocage unit_cost) ──────────────────────

describe('ia_finance_cost_movements / ia_product_cump — owner/manager only (RLS)', () => {
  skipIfNoServiceRole('owner et manager obtiennent le CUMP ; agent obtient 0 ligne', async () => {
    const { merchantAccountId, email, admin } = await createOwnerFixture('cump');
    const productId = await seedProductWithCump(admin, merchantAccountId, 750);

    const owner = await signIn(email);
    const ownerRes = await owner.rpc('ia_product_cump', {
      p_merchant: merchantAccountId,
      p_product_ids: [productId],
    });
    expect(ownerRes.error).toBeNull();
    expect(ownerRes.data).toHaveLength(1);
    expect(ownerRes.data?.[0]?.unit_cost).toBe(750);

    const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');
    const manager = await signIn(managerEmail);
    const managerRes = await manager.rpc('ia_product_cump', {
      p_merchant: merchantAccountId,
      p_product_ids: [productId],
    });
    expect(managerRes.data).toHaveLength(1);

    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const agent = await signIn(agentEmail);
    const agentRes = await agent.rpc('ia_product_cump', {
      p_merchant: merchantAccountId,
      p_product_ids: [productId],
    });
    expect(agentRes.error).toBeNull();
    expect(agentRes.data).toHaveLength(0);
  });

  skipIfNoServiceRole('ia_finance_cost_movements : owner voit le coût, agent 0', async () => {
    const { merchantAccountId, email, userId, admin } = await createOwnerFixture('cost');
    const productId = await seedProductWithCump(admin, merchantAccountId, 0);
    const orderId = await seedSoldMovement(admin, merchantAccountId, productId, userId, 800);

    const owner = await signIn(email);
    const ownerRes = await owner.rpc('ia_finance_cost_movements', {
      p_merchant: merchantAccountId,
      p_order_ids: [orderId],
    });
    expect(ownerRes.error).toBeNull();
    expect(ownerRes.data).toHaveLength(1);
    expect(ownerRes.data?.[0]?.unit_cost).toBe(800);

    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const agent = await signIn(agentEmail);
    const agentRes = await agent.rpc('ia_finance_cost_movements', {
      p_merchant: merchantAccountId,
      p_order_ids: [orderId],
    });
    expect(agentRes.data).toHaveLength(0);
  });

  skipIfNoServiceRole('refus cross-tenant : owner A ne lit pas le coût de B', async () => {
    const a = await createOwnerFixture('cross-a');
    const b = await createOwnerFixture('cross-b');
    const productB = await seedProductWithCump(b.admin, b.merchantAccountId, 500);

    const ownerA = await signIn(a.email);
    const res = await ownerA.rpc('ia_product_cump', {
      p_merchant: b.merchantAccountId,
      p_product_ids: [productB],
    });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(0);
  });
});

// ── ia_faq ────────────────────────────────────────────────────────────────

describe('ia_faq — lisible par tout authentifié (RLS)', () => {
  skipIfNoServiceRole('un membre peut lire la table FAQ sans erreur', async () => {
    const { email } = await createOwnerFixture('faq');
    const owner = await signIn(email);
    const { error } = await owner.from('ia_faq').select('id').limit(1);
    expect(error).toBeNull();
  });
});
