import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// Phase 13 — le filtre boutique (p_shop_id) restreint les agrégats AU SEIN du
// tenant, sans jamais contourner l'isolation. On vérifie : NULL = somme des
// boutiques, par-boutique = sous-ensemble correct, et qu'un p_shop_id d'un autre
// tenant (ou un appel cross-tenant) ne révèle rien.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'shop-filter-rls-test-pw';
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
  const email = `shop-filter-rls-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function createShop(admin: AdminClient, merchantAccountId: string, domain: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: domain,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id;
}

async function seedAppelerOrder(
  admin: AdminClient,
  merchantAccountId: string,
  shopId: string | null,
) {
  const { error } = await admin.from('orders').insert({
    merchant_account_id: merchantAccountId,
    // shopId null => on laisse `assign_default_store_context` retomber sur la
    // boutique par défaut, ce que ce test exerce volontairement.
    ...(shopId ? { shop_id: shopId } : {}),
    order_number: `SF-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    total_amount: 10000,
    currency: 'XOF',
    cod_status: 'A_APPELER',
    order_state: 'open',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
    created_at_shopify: new Date().toISOString(),
  });
  if (error) throw error;
}

async function appelerCount(client: SupabaseClient<Database>, merchantId: string, shopId?: string) {
  const { data, error } = await client.rpc('get_dashboard_kpi', {
    p_merchant_id: merchantId,
    ...(shopId ? { p_shop_id: shopId } : {}),
  });
  if (error) throw error;
  return Number((data as { a_appeler_count: number }).a_appeler_count);
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('get_dashboard_kpi — filtre boutique (Phase 13)', () => {
  skipIfNoServiceRole('NULL = somme des boutiques ; par-boutique = sous-ensemble', async () => {
    const { admin, email, merchantAccountId } = await createOwnerFixture('sum');
    const shopA = await createShop(admin, merchantAccountId, `a-${Date.now()}.myshopify.com`);
    const shopB = await createShop(admin, merchantAccountId, `b-${Date.now()}.myshopify.com`);
    // 2 commandes boutique A, 1 commande boutique B.
    await seedAppelerOrder(admin, merchantAccountId, shopA);
    await seedAppelerOrder(admin, merchantAccountId, shopA);
    await seedAppelerOrder(admin, merchantAccountId, shopB);

    const client = await signIn(email);
    const all = await appelerCount(client, merchantAccountId);
    const a = await appelerCount(client, merchantAccountId, shopA);
    const b = await appelerCount(client, merchantAccountId, shopB);

    expect(a).toBe(2);
    expect(b).toBe(1);
    expect(all).toBe(a + b); // « Toutes » = somme des boutiques.
  });

  skipIfNoServiceRole("un p_shop_id d'un autre tenant ne révèle aucune commande", async () => {
    const fixtureA = await createOwnerFixture('iso-a');
    const fixtureB = await createOwnerFixture('iso-b');
    const shopB = await createShop(
      fixtureB.admin,
      fixtureB.merchantAccountId,
      `iso-b-${Date.now()}.myshopify.com`,
    );
    await seedAppelerOrder(fixtureB.admin, fixtureB.merchantAccountId, shopB);

    const clientA = await signIn(fixtureA.email);
    // A passe son propre merchant mais la boutique de B → aucune commande de A
    // ne porte ce shop_id → 0 (jamais les commandes de B).
    const leaked = await appelerCount(clientA, fixtureA.merchantAccountId, shopB);
    expect(leaked).toBe(0);
  });

  skipIfNoServiceRole(
    'appel cross-tenant (p_merchant_id du voisin) renvoie zéro (RLS invoker)',
    async () => {
      const fixtureA = await createOwnerFixture('xt-a');
      const fixtureB = await createOwnerFixture('xt-b');
      const shopB = await createShop(
        fixtureB.admin,
        fixtureB.merchantAccountId,
        `xt-b-${Date.now()}.myshopify.com`,
      );
      await seedAppelerOrder(fixtureB.admin, fixtureB.merchantAccountId, shopB);

      const clientA = await signIn(fixtureA.email);
      const leaked = await appelerCount(clientA, fixtureB.merchantAccountId, shopB);
      expect(leaked).toBe(0);
    },
  );
});
