import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'mot-de-passe-test-rls';
const createdUserIds: string[] = [];

afterEach(async () => {
  if (!supabaseUrl || !serviceRoleKey) {
    return;
  }

  const serviceClient = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  await Promise.all(createdUserIds.map((userId) => serviceClient.auth.admin.deleteUser(userId)));
  createdUserIds.length = 0;
});

describe('merchant_account RLS', () => {
  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'isolates merchant accounts between authenticated users',
    async () => {
      expect(supabaseUrl).not.toBe('');
      expect(anonKey).not.toBe('');

      const serviceClient = createClient<Database>(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const emailSuffix = `${Date.now()}-${crypto.randomUUID()}`;
      const emailA = `rls-a-${emailSuffix}@example.com`;
      const emailB = `rls-b-${emailSuffix}@example.com`;

      const { data: userAData, error: userAError } = await serviceClient.auth.admin.createUser({
        email: emailA,
        password,
        email_confirm: true,
      });
      expect(userAError).toBeNull();
      expect(userAData.user).not.toBeNull();

      const { data: userBData, error: userBError } = await serviceClient.auth.admin.createUser({
        email: emailB,
        password,
        email_confirm: true,
      });
      expect(userBError).toBeNull();
      expect(userBData.user).not.toBeNull();

      const userA = userAData.user;
      const userB = userBData.user;
      if (!userA || !userB) {
        throw new Error('Users were not created.');
      }

      createdUserIds.push(userA.id, userB.id);

      const { data: accountA, error: accountAError } = await serviceClient
        .from('merchant_account')
        .select('*')
        .eq('owner_user_id', userA.id)
        .single();

      expect(accountAError).toBeNull();
      if (!accountA) {
        throw new Error('Merchant account was not created.');
      }

      const userBClient = createClient<Database>(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: signInBError } = await userBClient.auth.signInWithPassword({
        email: emailB,
        password,
      });
      expect(signInBError).toBeNull();

      const { data: blockedRows, error: blockedError } = await userBClient
        .from('merchant_account')
        .select('*')
        .eq('id', accountA.id);

      expect(blockedError).toBeNull();
      expect(blockedRows).toEqual([]);

      const userAClient = createClient<Database>(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: signInAError } = await userAClient.auth.signInWithPassword({
        email: emailA,
        password,
      });
      expect(signInAError).toBeNull();

      const { data: allowedRows, error: allowedError } = await userAClient
        .from('merchant_account')
        .select('*')
        .eq('id', accountA.id);

      expect(allowedError).toBeNull();
      expect(allowedRows).toHaveLength(1);
    },
  );
});
