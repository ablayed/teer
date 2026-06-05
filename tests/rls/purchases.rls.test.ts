import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'purchases-rls-test-pw';
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
  const email = `purchases-rls-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `purchases-member-${role}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  // Remove auto-created merchant_account for this user, then insert member record.
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  return { email, userId };
}

async function seedLot(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('purchase_lot')
    .insert({
      merchant_account_id: merchantAccountId,
      supplier_name: 'Fournisseur RLS',
      ordered_at: '2026-06-01',
      shipping_mode: 'normal',
      supplier_prep_days: 0,
      transport_days: 7,
      local_buffer_days: 0,
      freight_total: 10000,
      customs_total: 0,
      transit_total: 0,
      local_transport_total: 0,
      status: 'ordered',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('purchase_lot insert returned no row');
  return data.id;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

// ── Owner access ──────────────────────────────────────────────────────────────

describe('purchase_lot — owner-only access (RLS)', () => {
  skipIfNoServiceRole('owner peut lire ses lots', async () => {
    const { merchantAccountId, email } = await createOwnerFixture('owner-read');
    const admin = adminClient();
    await seedLot(admin, merchantAccountId);

    const client = await signIn(email);
    const { data, error } = await client
      .from('purchase_lot')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  skipIfNoServiceRole('owner peut créer un lot sur son tenant', async () => {
    const { merchantAccountId, email } = await createOwnerFixture('owner-insert');

    const client = await signIn(email);
    const { error } = await client.from('purchase_lot').insert({
      merchant_account_id: merchantAccountId,
      supplier_name: 'Fournisseur test',
      ordered_at: '2026-06-01',
      shipping_mode: 'normal',
      supplier_prep_days: 0,
      transport_days: 7,
      local_buffer_days: 0,
      freight_total: 0,
      customs_total: 0,
      transit_total: 0,
      local_transport_total: 0,
      status: 'ordered',
    });

    expect(error).toBeNull();
  });

  skipIfNoServiceRole("owner ne peut pas insérer un lot sur le tenant d'un autre", async () => {
    const fixtureA = await createOwnerFixture('owner-insert-a');
    const fixtureB = await createOwnerFixture('owner-insert-b');

    const clientA = await signIn(fixtureA.email);
    const { error } = await clientA.from('purchase_lot').insert({
      merchant_account_id: fixtureB.merchantAccountId, // autre tenant
      supplier_name: 'Fraude',
      ordered_at: '2026-06-01',
      shipping_mode: 'normal',
      supplier_prep_days: 0,
      transport_days: 7,
      local_buffer_days: 0,
      freight_total: 0,
      customs_total: 0,
      transit_total: 0,
      local_transport_total: 0,
      status: 'ordered',
    });

    expect(error).not.toBeNull();
  });
});

// ── Manager denied ────────────────────────────────────────────────────────────

describe('purchase_lot — manager refusé (RLS)', () => {
  skipIfNoServiceRole('manager ne voit aucun lot (0 lignes)', async () => {
    const { merchantAccountId } = await createOwnerFixture('mgr-read');
    const admin = adminClient();
    await seedLot(admin, merchantAccountId);
    const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');

    const client = await signIn(managerEmail);
    const { data, error } = await client
      .from('purchase_lot')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);

    expect(error).toBeNull(); // RLS retourne [] sans erreur
    expect(data).toHaveLength(0);
  });

  skipIfNoServiceRole('manager ne peut pas insérer un lot', async () => {
    const { merchantAccountId } = await createOwnerFixture('mgr-insert');
    const admin = adminClient();
    const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');

    const client = await signIn(managerEmail);
    const { error } = await client.from('purchase_lot').insert({
      merchant_account_id: merchantAccountId,
      supplier_name: 'Test manager',
      ordered_at: '2026-06-01',
      shipping_mode: 'normal',
      supplier_prep_days: 0,
      transport_days: 7,
      local_buffer_days: 0,
      freight_total: 0,
      customs_total: 0,
      transit_total: 0,
      local_transport_total: 0,
      status: 'ordered',
    });

    expect(error).not.toBeNull();
  });
});

// ── Agent denied ──────────────────────────────────────────────────────────────

describe('purchase_lot — agent refusé (RLS)', () => {
  skipIfNoServiceRole('agent ne voit aucun lot (0 lignes)', async () => {
    const { merchantAccountId } = await createOwnerFixture('agent-read');
    const admin = adminClient();
    await seedLot(admin, merchantAccountId);
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');

    const client = await signIn(agentEmail);
    const { data, error } = await client
      .from('purchase_lot')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});

// ── Tenant isolation ──────────────────────────────────────────────────────────

describe('purchase_lot — isolation tenant', () => {
  skipIfNoServiceRole('merchant A ne voit pas les lots de merchant B', async () => {
    const fixtureA = await createOwnerFixture('iso-a');
    const fixtureB = await createOwnerFixture('iso-b');
    const admin = adminClient();

    await seedLot(admin, fixtureB.merchantAccountId);

    const clientA = await signIn(fixtureA.email);
    const { data } = await clientA
      .from('purchase_lot')
      .select('id')
      .eq('merchant_account_id', fixtureB.merchantAccountId);

    expect(data).toHaveLength(0);
  });
});

// ── receive_purchase_lot RPC — garde tenant ───────────────────────────────────

describe('receive_purchase_lot RPC — garde tenant', () => {
  skipIfNoServiceRole('le RPC rejette un lot appartenant à un autre tenant', async () => {
    const fixtureA = await createOwnerFixture('rpc-a');
    const fixtureB = await createOwnerFixture('rpc-b');
    const admin = adminClient();

    const lotIdB = await seedLot(admin, fixtureB.merchantAccountId);

    // Owner A essaie de recevoir un lot de B.
    const clientA = await signIn(fixtureA.email);
    type GenericRpc = (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
    const { error } = await (clientA.rpc as unknown as GenericRpc)('receive_purchase_lot', {
      p_lot_id: lotIdB,
      p_merchant_account_id: fixtureA.merchantAccountId, // mauvais tenant
      p_actor_id: fixtureA.userId,
      p_lines: [],
    });

    // La fonction SECURITY DEFINER doit lever une exception tenant mismatch
    // ou "not found" car le lot n'appartient pas à fixtureA.
    expect(error).not.toBeNull();
  });
});
