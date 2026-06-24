import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'feedback-rls-pw-2026!';
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
  const email = `feedback-rls-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `feedback-member-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  return { email, userId };
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('feedback — RLS', () => {
  skipIfNoServiceRole('un membre peut insérer un feedback dans son propre tenant', async () => {
    const { merchantAccountId, email, userId } = await createOwnerFixture('fb-insert-ok');
    const owner = await signIn(email);

    const { error } = await owner.from('feedback').insert({
      merchant_account_id: merchantAccountId,
      actor_user_id: userId,
      category: 'bug',
      message: 'Test insertion feedback RLS',
    });

    expect(error).toBeNull();
  });

  skipIfNoServiceRole('un agent peut insérer un feedback dans son tenant', async () => {
    const { admin, merchantAccountId } = await createOwnerFixture('fb-agent-insert');
    const { email: agentEmail, userId: agentId } = await addMember(
      admin,
      merchantAccountId,
      'agent',
    );
    const agent = await signIn(agentEmail);

    const { error } = await agent.from('feedback').insert({
      merchant_account_id: merchantAccountId,
      actor_user_id: agentId,
      category: 'suggestion',
      message: 'Suggestion de test par un agent',
    });

    expect(error).toBeNull();
  });

  skipIfNoServiceRole(
    'WITH CHECK bloque une insertion cross-tenant (merchant_account_id étranger)',
    async () => {
      const fixtureA = await createOwnerFixture('fb-tenant-a');
      const fixtureB = await createOwnerFixture('fb-tenant-b');
      const ownerA = await signIn(fixtureA.email);

      // ownerA tente d'insérer dans le tenant B
      const { error } = await ownerA.from('feedback').insert({
        merchant_account_id: fixtureB.merchantAccountId,
        actor_user_id: fixtureA.userId,
        category: 'bug',
        message: 'Tentative cross-tenant',
      });

      expect(error).not.toBeNull();
    },
  );

  skipIfNoServiceRole('le propriétaire peut lire les feedbacks de son tenant', async () => {
    const { merchantAccountId, email, userId, admin } = await createOwnerFixture('fb-select-owner');

    // Insérer via service-role pour contourner RLS sur l'insertion
    await admin.from('feedback').insert({
      merchant_account_id: merchantAccountId,
      actor_user_id: userId,
      category: 'question',
      message: 'Feedback visible par owner',
    });

    const owner = await signIn(email);
    const { data, error } = await owner
      .from('feedback')
      .select('id, message')
      .eq('merchant_account_id', merchantAccountId);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  skipIfNoServiceRole('un agent ne peut pas lire les feedbacks (SELECT owner-only)', async () => {
    const { admin, merchantAccountId, userId } = await createOwnerFixture('fb-select-agent');
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');

    // Insérer un feedback via service-role
    await admin.from('feedback').insert({
      merchant_account_id: merchantAccountId,
      actor_user_id: userId,
      category: 'bug',
      message: 'Feedback non visible par agent',
    });

    const agent = await signIn(agentEmail);
    const { data } = await agent
      .from('feedback')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);

    // RLS retourne 0 lignes (pas d'erreur — deny silencieux)
    expect((data ?? []).length).toBe(0);
  });

  skipIfNoServiceRole('un manager ne peut pas lire les feedbacks (SELECT owner-only)', async () => {
    const { admin, merchantAccountId, userId } = await createOwnerFixture('fb-select-manager');
    const { email: managerEmail } = await addMember(admin, merchantAccountId, 'manager');

    await admin.from('feedback').insert({
      merchant_account_id: merchantAccountId,
      actor_user_id: userId,
      category: 'autre',
      message: 'Feedback non visible par manager',
    });

    const manager = await signIn(managerEmail);
    const { data } = await manager
      .from('feedback')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);

    expect((data ?? []).length).toBe(0);
  });

  skipIfNoServiceRole("un owner ne peut pas lire les feedbacks d'un autre tenant", async () => {
    const fixtureA = await createOwnerFixture('fb-cross-read-a');
    const fixtureB = await createOwnerFixture('fb-cross-read-b');

    await fixtureA.admin.from('feedback').insert({
      merchant_account_id: fixtureA.merchantAccountId,
      actor_user_id: fixtureA.userId,
      category: 'bug',
      message: 'Feedback tenant A',
    });

    const ownerB = await signIn(fixtureB.email);
    const { data } = await ownerB
      .from('feedback')
      .select('id')
      .eq('merchant_account_id', fixtureA.merchantAccountId);

    expect((data ?? []).length).toBe(0);
  });
});
