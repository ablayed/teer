import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'mot-de-passe-test-rls';
const createdUserIds: string[] = [];
const createdCustomerIds: string[] = [];

function serviceClient(): SupabaseClient<Database> {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

afterEach(async () => {
  if (!supabaseUrl || !serviceRoleKey) {
    return;
  }
  const service = serviceClient();
  if (createdCustomerIds.length > 0) {
    await service.from('customer').delete().in('id', createdCustomerIds);
    createdCustomerIds.length = 0;
  }
  await Promise.all(createdUserIds.map((userId) => service.auth.admin.deleteUser(userId)));
  createdUserIds.length = 0;
});

async function createTenant(service: SupabaseClient<Database>, label: string) {
  const email = `rls-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  const user = data.user;
  if (!user) {
    throw new Error('User was not created.');
  }
  createdUserIds.push(user.id);

  const { data: account } = await service
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', user.id)
    .single();
  if (!account) {
    throw new Error('Merchant account was not seeded.');
  }

  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  expect(signInError).toBeNull();

  return { email, userId: user.id, accountId: account.id, client };
}

describe('customer enrichi — isolation tenant (RLS)', () => {
  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'un tenant ne voit ni n_écrit la PII enrichie d_un autre',
    async () => {
      expect(supabaseUrl).not.toBe('');
      expect(anonKey).not.toBe('');

      const service = serviceClient();
      const tenantA = await createTenant(service, 'a');
      const tenantB = await createTenant(service, 'b');

      // PII enrichie insérée (service role) chez le tenant A.
      const { data: inserted, error: insertError } = await service
        .from('customer')
        .insert({
          merchant_account_id: tenantA.accountId,
          source: 'shopify',
          full_name: 'Awa Diop',
          first_name: 'Awa',
          last_name: 'Diop',
          phone: '+221771234567',
          phone_e164: '+221771234567',
          address: { raw: 'Cité Keur Gorgui, Dakar', city: 'Dakar', region: 'Dakar' },
          shopify_customer_gids: ['123456'],
        })
        .select('id')
        .single();
      expect(insertError).toBeNull();
      if (!inserted) {
        throw new Error('Customer was not inserted.');
      }
      createdCustomerIds.push(inserted.id);

      // Tenant B ne voit pas le client enrichi du tenant A.
      const { data: blocked, error: blockedError } = await tenantB.client
        .from('customer')
        .select('id, phone_e164, address')
        .eq('id', inserted.id);
      expect(blockedError).toBeNull();
      expect(blocked).toEqual([]);

      // Tenant A voit son client AVEC les colonnes enrichies.
      const { data: visible, error: visibleError } = await tenantA.client
        .from('customer')
        .select('id, phone_e164, address, shopify_customer_gids')
        .eq('id', inserted.id)
        .single();
      expect(visibleError).toBeNull();
      expect(visible?.phone_e164).toBe('+221771234567');
      expect(visible?.shopify_customer_gids).toEqual(['123456']);

      // Tenant B ne peut pas insérer un client chez le tenant A (WITH CHECK).
      const { data: crossInsert, error: crossInsertError } = await tenantB.client
        .from('customer')
        .insert({
          merchant_account_id: tenantA.accountId,
          source: 'manual',
          phone_e164: '+221770000000',
        })
        .select('id');
      expect(crossInsert ?? []).toEqual([]);
      expect(crossInsertError).not.toBeNull();
    },
  );
});
