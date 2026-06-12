import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'mot-de-passe-test-rls';
const createdUserIds: string[] = [];

function serviceClient() {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(label: string) {
  const service = serviceClient();
  const email = `rls-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  const user = data.user;
  if (!user) {
    throw new Error(`User ${label} was not created.`);
  }
  createdUserIds.push(user.id);
  return { id: user.id, email };
}

// auth.admin.createUser déclenche handle_new_user -> merchant_account perso
// + merchant_member owner. On récupère l'id du compte dont l'user est owner.
async function ownedAccountId(userId: string) {
  const service = serviceClient();
  const { data, error } = await service
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', userId)
    .single();
  expect(error).toBeNull();
  if (!data) {
    throw new Error('Merchant account was not created.');
  }
  return data.id;
}

async function signedInClient(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  expect(error).toBeNull();
  return client;
}

function isRlsDenial(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return error.code === '42501' || /row-level security/i.test(error.message ?? '');
}

afterEach(async () => {
  if (!supabaseUrl || !serviceRoleKey) {
    return;
  }
  const service = serviceClient();
  await Promise.all(createdUserIds.map((id) => service.auth.admin.deleteUser(id)));
  createdUserIds.length = 0;
});

describe('merchant_member INSERT RLS (anti-escalation)', () => {
  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'blocks cross-tenant self-insert (un user non-membre ne peut pas s’ajouter owner ailleurs)',
    async () => {
      const userA = await createUser('a');
      const userB = await createUser('b');
      const accountA = await ownedAccountId(userA.id);

      const clientB = await signedInClient(userB.email);
      const { error } = await clientB
        .from('merchant_member')
        .insert({ merchant_account_id: accountA, user_id: userB.id, role: 'owner' });

      console.log('cross-tenant error:', JSON.stringify(error));
      expect(isRlsDenial(error)).toBe(true);
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'blocks intra-tenant escalation (un agent ne peut pas insérer un membre owner)',
    async () => {
      const userA = await createUser('a');
      const userB = await createUser('b');
      const userC = await createUser('c');
      const accountA = await ownedAccountId(userA.id);

      // Seed userB comme agent du tenant A via service role (bypass RLS).
      const service = serviceClient();
      const { error: seedError } = await service
        .from('merchant_member')
        .insert({ merchant_account_id: accountA, user_id: userB.id, role: 'agent' });
      expect(seedError).toBeNull();

      // userB (agent) tente d'insérer userC comme owner dans A -> doit échouer.
      const clientB = await signedInClient(userB.email);
      const { error } = await clientB
        .from('merchant_member')
        .insert({ merchant_account_id: accountA, user_id: userC.id, role: 'owner' });

      expect(isRlsDenial(error)).toBe(true);
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'allows an owner to insert a member in their own tenant (policy not over-restrictive)',
    async () => {
      const userA = await createUser('a');
      const userC = await createUser('c');
      const accountA = await ownedAccountId(userA.id);

      const clientA = await signedInClient(userA.email);
      const { data, error } = await clientA
        .from('merchant_member')
        .insert({ merchant_account_id: accountA, user_id: userC.id, role: 'agent' })
        .select();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    },
  );
});
