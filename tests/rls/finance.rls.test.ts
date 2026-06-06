import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'finance-rls-test-pw';
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

async function waitForCategories(admin: AdminClient, merchantAccountId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('expense_category')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    if (data && data.length > 0) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('expense_categories not seeded after 20 retries');
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
  const email = `finance-rls-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  await waitForCategories(admin, merchantAccountId);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `finance-member-${role}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  return { email, userId };
}

async function seedExpense(admin: AdminClient, merchantAccountId: string, actorUserId: string) {
  const { data: cat } = await admin
    .from('expense_category')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .limit(1)
    .single();
  if (!cat) throw new Error('No category found to seed expense');

  const { data, error } = await admin
    .from('expense')
    .insert({
      merchant_account_id: merchantAccountId,
      category_id: cat.id,
      amount_minor: 5000,
      spent_at: '2026-06-01',
      created_by: actorUserId,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('expense insert failed');
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

// ── expense_category ──────────────────────────────────────────────────────────

describe('expense_category — owner-only access (RLS)', () => {
  skipIfNoServiceRole('owner voit ses catégories système (5 lignes)', async () => {
    const { merchantAccountId, email } = await createOwnerFixture('cat-read');
    const client = await signIn(email);
    const { data, error } = await client
      .from('expense_category')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(5);
  });

  skipIfNoServiceRole('owner peut créer une catégorie personnalisée', async () => {
    const { merchantAccountId, email } = await createOwnerFixture('cat-insert');
    const client = await signIn(email);
    const { error } = await client.from('expense_category').insert({
      merchant_account_id: merchantAccountId,
      code: 'CUSTOM',
      label_fr: 'Ma catégorie',
      is_system: false,
    });
    expect(error).toBeNull();
  });

  skipIfNoServiceRole('owner ne voit pas les catégories du tenant voisin', async () => {
    const fixtureA = await createOwnerFixture('cat-iso-a');
    const fixtureB = await createOwnerFixture('cat-iso-b');
    const clientA = await signIn(fixtureA.email);
    const { data, error } = await clientA
      .from('expense_category')
      .select('id')
      .eq('merchant_account_id', fixtureB.merchantAccountId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  skipIfNoServiceRole('manager ne voit aucune catégorie (0 lignes)', async () => {
    const { merchantAccountId } = await createOwnerFixture('cat-mgr');
    const admin = adminClient();
    const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');
    const client = await signIn(managerEmail);
    const { data, error } = await client
      .from('expense_category')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  skipIfNoServiceRole('agent ne voit aucune catégorie (0 lignes)', async () => {
    const { merchantAccountId } = await createOwnerFixture('cat-agent');
    const admin = adminClient();
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const client = await signIn(agentEmail);
    const { data, error } = await client
      .from('expense_category')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});

// ── expense ───────────────────────────────────────────────────────────────────

describe('expense — owner-only access (RLS)', () => {
  skipIfNoServiceRole('owner peut créer et lire ses dépenses', async () => {
    const { merchantAccountId, email, userId } = await createOwnerFixture('exp-create');
    const admin = adminClient();
    await seedExpense(admin, merchantAccountId, userId);
    const client = await signIn(email);
    const { data, error } = await client
      .from('expense')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  skipIfNoServiceRole('owner ne voit pas les dépenses du tenant voisin', async () => {
    const fixtureA = await createOwnerFixture('exp-iso-a');
    const fixtureB = await createOwnerFixture('exp-iso-b');
    const admin = adminClient();
    await seedExpense(admin, fixtureB.merchantAccountId, fixtureB.userId);
    const clientA = await signIn(fixtureA.email);
    const { data, error } = await clientA
      .from('expense')
      .select('id')
      .eq('merchant_account_id', fixtureB.merchantAccountId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  skipIfNoServiceRole(
    "owner ne peut pas insérer une dépense sur le tenant d'un autre",
    async () => {
      const fixtureA = await createOwnerFixture('exp-insert-a');
      const fixtureB = await createOwnerFixture('exp-insert-b');
      const admin = adminClient();
      const { data: cat } = await admin
        .from('expense_category')
        .select('id')
        .eq('merchant_account_id', fixtureB.merchantAccountId)
        .limit(1)
        .single();
      const clientA = await signIn(fixtureA.email);
      const { error } = await clientA.from('expense').insert({
        merchant_account_id: fixtureB.merchantAccountId,
        category_id: cat?.id ?? '',
        amount_minor: 1000,
        spent_at: '2026-06-01',
        created_by: fixtureA.userId,
      });
      expect(error).not.toBeNull();
    },
  );

  skipIfNoServiceRole('manager ne voit aucune dépense (0 lignes)', async () => {
    const { merchantAccountId, userId } = await createOwnerFixture('exp-mgr');
    const admin = adminClient();
    await seedExpense(admin, merchantAccountId, userId);
    const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');
    const client = await signIn(managerEmail);
    const { data, error } = await client
      .from('expense')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  skipIfNoServiceRole('agent ne voit aucune dépense (0 lignes)', async () => {
    const { merchantAccountId, userId } = await createOwnerFixture('exp-agent');
    const admin = adminClient();
    await seedExpense(admin, merchantAccountId, userId);
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const client = await signIn(agentEmail);
    const { data, error } = await client
      .from('expense')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  skipIfNoServiceRole('owner peut supprimer sa propre dépense', async () => {
    const { merchantAccountId, email, userId } = await createOwnerFixture('exp-delete');
    const admin = adminClient();
    const expenseId = await seedExpense(admin, merchantAccountId, userId);
    const client = await signIn(email);
    const { error } = await client
      .from('expense')
      .delete()
      .eq('id', expenseId)
      .eq('merchant_account_id', merchantAccountId);
    expect(error).toBeNull();
    const { data } = await client
      .from('expense')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    expect(data).toHaveLength(0);
  });
});
