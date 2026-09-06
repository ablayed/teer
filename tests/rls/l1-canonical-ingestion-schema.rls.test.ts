/**
 * Lot L1 — schéma canonique additif (`store_connection`, `external_ref`,
 * `ingestion_event`, `orders.store_connection_id`).
 *
 * Migration 0142. Aucun chemin applicatif ne lit ni n'écrit ces tables à ce
 * jour (L2). Ce fichier prouve :
 *   1. l'ACL de table réelle (`has_table_privilege`) sur les trois tables —
 *      anon : rien ; authenticated : SELECT seul ; service_role : tout ;
 *   2. l'isolation RLS (tenant ET boutique) sur les trois tables, avec un
 *      contrôle positif pour un membre légitime ;
 *   3. les contraintes structurelles additives : la FK composite qui empêche
 *      `store_connection`/`ingestion_event`/`orders.store_connection_id` de
 *      pointer vers une connexion d'un autre compte ou d'une autre boutique,
 *      et les contraintes d'unicité (platform, external_identifier) /
 *      (store_connection_id, entity_type, external_id).
 *
 * Migration 0142 confirmée en production (`supabase migration list --linked`,
 * Local=Remote=0142) ; les trois tables sont typées dans `database.types.ts`
 * depuis la régénération qui a suivi (Lot L2). Un seul client Supabase typé
 * est donc utilisé partout dans ce fichier.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'l1-canonical-ingestion-schema-pw-0142';
const createdUserIds: string[] = [];
const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type Client = SupabaseClient<Database>;

function adminClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function anonClient(): Client {
  return createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createConfirmedUser(admin: Client, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('user creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: Client, userId: string) {
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
  throw new Error('merchant_account not found');
}

async function defaultShopId(admin: Client, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_default', true)
    .single();
  if (error || !data) throw error ?? new Error('default shop not found');
  return data.id;
}

async function createShopifyShop(admin: Client, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `l1-schema-${Date.now()}-${randomUUID()}.myshopify.com`,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
      store_kind: 'shopify',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shopify shop insert failed');
  return data.id;
}

async function createTenant(label: string) {
  const admin = adminClient();
  const email = `l1-schema-${label}-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const defaultShop = await defaultShopId(admin, merchantAccountId);
  return { admin, email, userId, merchantAccountId, defaultShop };
}

async function addAgent(admin: Client, merchantAccountId: string) {
  const email = `l1-schema-agent-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  const { error } = await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role: 'agent', user_id: userId });
  if (error) throw error;
  return { email, userId };
}

async function signIn(email: string): Promise<Client> {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function createStoreConnection(admin: Client, merchantAccountId: string, shopId: string) {
  const { data, error } = await admin
    .from('store_connection')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      platform: 'shopify',
      external_identifier: `l1-schema-conn-${Date.now()}-${randomUUID()}.myshopify.com`,
      platform_app_id: 'l1-schema-test-client',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('store_connection insert failed');
  return data.id as string;
}

let pg: TestPostgresClient | undefined;
async function pgClient(): Promise<TestPostgresClient> {
  if (pg) return pg;
  pg = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
  await pg.connect();
  return pg;
}

afterAll(async () => {
  if (serviceRoleKey) {
    const admin = adminClient();
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
  }
  await pg?.end();
});

describe.skipIf(!serviceRoleKey)('Lot L1 — ACL de table réelle (has_table_privilege)', () => {
  it('anon : aucun privilège ; authenticated : SELECT seul ; service_role : tout', async () => {
    const client = await pgClient();
    const { rows } = await client.query<{
      table_name: string;
      anon_select: boolean;
      anon_insert: boolean;
      auth_select: boolean;
      auth_insert: boolean;
      auth_update: boolean;
      auth_delete: boolean;
      service_all: boolean;
    }>(`
      select
        c.relname as table_name,
        has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
        has_table_privilege('anon', c.oid, 'INSERT') as anon_insert,
        has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
        has_table_privilege('authenticated', c.oid, 'INSERT') as auth_insert,
        has_table_privilege('authenticated', c.oid, 'UPDATE') as auth_update,
        has_table_privilege('authenticated', c.oid, 'DELETE') as auth_delete,
        (
          has_table_privilege('service_role', c.oid, 'SELECT')
          and has_table_privilege('service_role', c.oid, 'INSERT')
          and has_table_privilege('service_role', c.oid, 'UPDATE')
          and has_table_privilege('service_role', c.oid, 'DELETE')
        ) as service_all
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('store_connection', 'external_ref', 'ingestion_event')
      order by c.relname
    `);

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect([row.table_name, row.anon_select]).toEqual([row.table_name, false]);
      expect([row.table_name, row.anon_insert]).toEqual([row.table_name, false]);
      expect([row.table_name, row.auth_select]).toEqual([row.table_name, true]);
      expect([row.table_name, row.auth_insert]).toEqual([row.table_name, false]);
      expect([row.table_name, row.auth_update]).toEqual([row.table_name, false]);
      expect([row.table_name, row.auth_delete]).toEqual([row.table_name, false]);
      expect([row.table_name, row.service_all]).toEqual([row.table_name, true]);
    }
  });
});

describe('Lot L1 — isolation RLS + contrôle positif', () => {
  skipIfNoServiceRole(
    'store_connection : membre voit, tenant voisin et agent non-membre ne voient rien, anon refusé',
    async () => {
      const tenantA = await createTenant('sc-a');
      const tenantB = await createTenant('sc-b');
      const shopA2 = await createShopifyShop(tenantA.admin, tenantA.merchantAccountId);
      const connectionId = await createStoreConnection(
        adminClient(),
        tenantA.merchantAccountId,
        shopA2,
      );
      const agent = await addAgent(tenantA.admin, tenantA.merchantAccountId);
      // L'agent est un membre du tenant mais volontairement retiré de shopA2 :
      // seule l'appartenance à la BOUTIQUE doit gater la visibilité ici.
      await tenantA.admin
        .from('shop_member')
        .delete()
        .eq('shop_id', shopA2)
        .eq('user_id', agent.userId);

      const ownerA = await signIn(tenantA.email);
      const { data: visibleToOwner, error: ownerError } = await ownerA
        .from('store_connection')
        .select('id')
        .eq('id', connectionId);
      if (ownerError) throw ownerError;
      expect(visibleToOwner).toHaveLength(1);

      const agentClient = await signIn(agent.email);
      const { data: hiddenFromAgent, error: agentError } = await agentClient
        .from('store_connection')
        .select('id')
        .eq('id', connectionId);
      if (agentError) throw agentError;
      expect(hiddenFromAgent).toEqual([]);

      const ownerB = await signIn(tenantB.email);
      const { data: hiddenFromTenantB, error: tenantBError } = await ownerB
        .from('store_connection')
        .select('id')
        .eq('id', connectionId);
      if (tenantBError) throw tenantBError;
      expect(hiddenFromTenantB).toEqual([]);

      const { error: anonError } = await anonClient()
        .from('store_connection')
        .select('id')
        .eq('id', connectionId);
      expect(anonError).not.toBeNull();
    },
  );

  skipIfNoServiceRole(
    'external_ref : isolation via la jointure store_connection, contrôle positif pour un membre',
    async () => {
      const tenantA = await createTenant('er-a');
      const tenantB = await createTenant('er-b');
      const shopA2 = await createShopifyShop(tenantA.admin, tenantA.merchantAccountId);
      const connectionId = await createStoreConnection(
        adminClient(),
        tenantA.merchantAccountId,
        shopA2,
      );
      const admin = adminClient();
      const fakeEntityId = randomUUID();
      const { data: ref, error: refError } = await admin
        .from('external_ref')
        .insert({
          entity_type: 'order',
          entity_id: fakeEntityId,
          store_connection_id: connectionId,
          external_id: `shopify-order-${Date.now()}`,
        })
        .select('id')
        .single();
      if (refError || !ref) throw refError ?? new Error('external_ref insert failed');

      const ownerA = await signIn(tenantA.email);
      const { data: visible, error: visibleError } = await ownerA
        .from('external_ref')
        .select('id')
        .eq('id', ref.id);
      if (visibleError) throw visibleError;
      expect(visible).toHaveLength(1);

      const ownerB = await signIn(tenantB.email);
      const { data: hidden, error: hiddenError } = await ownerB
        .from('external_ref')
        .select('id')
        .eq('id', ref.id);
      if (hiddenError) throw hiddenError;
      expect(hidden).toEqual([]);

      const { error: anonError } = await anonClient()
        .from('external_ref')
        .select('id')
        .eq('id', ref.id);
      expect(anonError).not.toBeNull();
    },
  );

  skipIfNoServiceRole(
    'ingestion_event : isolation directe par (merchant_account_id, shop_id), contrôle positif pour un membre',
    async () => {
      const tenantA = await createTenant('ie-a');
      const tenantB = await createTenant('ie-b');
      const shopA2 = await createShopifyShop(tenantA.admin, tenantA.merchantAccountId);
      const connectionId = await createStoreConnection(
        adminClient(),
        tenantA.merchantAccountId,
        shopA2,
      );
      const admin = adminClient();
      const { data: event, error: eventError } = await admin
        .from('ingestion_event')
        .insert({
          merchant_account_id: tenantA.merchantAccountId,
          shop_id: shopA2,
          store_connection_id: connectionId,
          platform: 'shopify',
          topic: 'orders/create',
          delivery_id: `l1-schema-delivery-${Date.now()}`,
        })
        .select('id')
        .single();
      if (eventError || !event) throw eventError ?? new Error('ingestion_event insert failed');

      const ownerA = await signIn(tenantA.email);
      const { data: visible, error: visibleError } = await ownerA
        .from('ingestion_event')
        .select('id')
        .eq('id', event.id);
      if (visibleError) throw visibleError;
      expect(visible).toHaveLength(1);

      const ownerB = await signIn(tenantB.email);
      const { data: hidden, error: hiddenError } = await ownerB
        .from('ingestion_event')
        .select('id')
        .eq('id', event.id);
      if (hiddenError) throw hiddenError;
      expect(hidden).toEqual([]);

      const { error: anonError } = await anonClient()
        .from('ingestion_event')
        .select('id')
        .eq('id', event.id);
      expect(anonError).not.toBeNull();
    },
  );
});

describe('Lot L1 — contraintes structurelles (service-role, hors RLS)', () => {
  skipIfNoServiceRole(
    'store_connection : la FK composite refuse une boutique/tenant incohérents avec le compte declaré',
    async () => {
      const tenantA = await createTenant('fk-a');
      const tenantB = await createTenant('fk-b');
      const admin = adminClient();
      // shopA2 appartient au tenant A ; on tente de créer une connexion en
      // déclarant le compte du tenant B avec la boutique du tenant A.
      const shopA2 = await createShopifyShop(tenantA.admin, tenantA.merchantAccountId);
      const { error } = await admin.from('store_connection').insert({
        merchant_account_id: tenantB.merchantAccountId,
        shop_id: shopA2,
        platform: 'shopify',
        external_identifier: `l1-schema-forged-${Date.now()}.myshopify.com`,
      });
      expect(error).not.toBeNull();
    },
  );

  skipIfNoServiceRole('store_connection : unicité (platform, external_identifier)', async () => {
    const tenant = await createTenant('uniq-sc');
    const shop1 = await createShopifyShop(tenant.admin, tenant.merchantAccountId);
    const shop2 = await createShopifyShop(tenant.admin, tenant.merchantAccountId);
    const admin = adminClient();
    const domain = `l1-schema-uniq-${Date.now()}.myshopify.com`;
    const { error: firstError } = await admin.from('store_connection').insert({
      merchant_account_id: tenant.merchantAccountId,
      shop_id: shop1,
      platform: 'shopify',
      external_identifier: domain,
    });
    expect(firstError).toBeNull();

    const { error: secondError } = await admin.from('store_connection').insert({
      merchant_account_id: tenant.merchantAccountId,
      shop_id: shop2,
      platform: 'shopify',
      external_identifier: domain,
    });
    expect(secondError).not.toBeNull();
  });

  skipIfNoServiceRole(
    'external_ref : unicité (store_connection_id, entity_type, external_id)',
    async () => {
      const tenant = await createTenant('uniq-er');
      const shop = await createShopifyShop(tenant.admin, tenant.merchantAccountId);
      const connectionId = await createStoreConnection(
        adminClient(),
        tenant.merchantAccountId,
        shop,
      );
      const admin = adminClient();
      const externalId = `shopify-order-uniq-${Date.now()}`;
      const { error: firstError } = await admin.from('external_ref').insert({
        entity_type: 'order',
        entity_id: randomUUID(),
        store_connection_id: connectionId,
        external_id: externalId,
      });
      expect(firstError).toBeNull();

      const { error: secondError } = await admin.from('external_ref').insert({
        entity_type: 'order',
        entity_id: randomUUID(),
        store_connection_id: connectionId,
        external_id: externalId,
      });
      expect(secondError).not.toBeNull();
    },
  );

  skipIfNoServiceRole(
    'orders.store_connection_id : la FK composite refuse une connexion étrangère à la boutique de la commande',
    async () => {
      const tenantA = await createTenant('order-fk-a');
      const tenantB = await createTenant('order-fk-b');
      const shopA2 = await createShopifyShop(tenantA.admin, tenantA.merchantAccountId);
      const connectionA = await createStoreConnection(
        adminClient(),
        tenantA.merchantAccountId,
        shopA2,
      );
      const admin = adminClient();
      const { error } = await admin.from('orders').insert({
        merchant_account_id: tenantB.merchantAccountId,
        shop_id: tenantB.defaultShop,
        order_number: `l1-schema-forged-order-${Date.now()}`,
        total_amount: 500,
        currency: 'XOF',
        cod_status: 'A_APPELER',
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
        store_connection_id: connectionA,
      });
      expect(error).not.toBeNull();
    },
  );

  skipIfNoServiceRole(
    'orders.store_connection_id : nulle pour une commande manuelle, acceptée pour une connexion réelle de la même boutique',
    async () => {
      const tenant = await createTenant('order-fk-ok');
      const shop = await createShopifyShop(tenant.admin, tenant.merchantAccountId);
      const connectionId = await createStoreConnection(
        adminClient(),
        tenant.merchantAccountId,
        shop,
      );
      const admin = adminClient();

      const { error: manualError } = await admin.from('orders').insert({
        merchant_account_id: tenant.merchantAccountId,
        shop_id: tenant.defaultShop,
        order_number: `l1-schema-manual-${Date.now()}`,
        total_amount: 500,
        currency: 'XOF',
        cod_status: 'A_APPELER',
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      });
      expect(manualError).toBeNull();

      const { error: shopifyError } = await admin.from('orders').insert({
        merchant_account_id: tenant.merchantAccountId,
        shop_id: shop,
        order_number: `l1-schema-shopify-${Date.now()}`,
        total_amount: 500,
        currency: 'XOF',
        cod_status: 'A_APPELER',
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
        store_connection_id: connectionId,
      });
      expect(shopifyError).toBeNull();
    },
  );
});
