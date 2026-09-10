/**
 * R2.1/R2.2 — preuves d'intégration du chemin CSV (migration 0151, `create_csv_order`).
 *
 * Complète le contrat SQL `supabase/tests/0151_r2_csv_order_atomicity.sql`, qu'aucun workflow
 * n'exécute, par des preuves rejouées à chaque `pnpm test:rls` :
 *   1. ACL : `create_csv_order` n'est exécutable ni par anon ni par authenticated ;
 *   2. `external_ref` : exclusion mutuelle connexion / espace de noms, liste fermée ;
 *   3. concurrence réelle : la seconde transaction attend le verrou de l'index natif, puis
 *      échoue en 23505 — une seule commande, aucune commande orpheline ;
 *   4. héritage : les lignes portent la boutique de la commande, jamais la boutique par défaut ;
 *   5. moteur : réimport du même order_key → already_imported, aucune nouvelle écriture ;
 *   6. isolation : boutique étrangère refusée, absence de lignes prouvée ;
 *   7. atomicité : une ligne invalide n'écrit aucune commande partielle ;
 *   8. client : jamais rattaché depuis une autre boutique du même compte.
 */

import { randomUUID } from 'node:crypto';
import { writeCsvCanonicalOrder } from '@/lib/ingestion/csv-order-engine';
import { previewCsvOrderImport } from '@/lib/ingestion/csv-order-import';
import { resolveShopContext } from '@/lib/ingestion/resolve-shop-context';
import type { Database, Json } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'r2-csv-order-import-pw-0151';
const createdUserIds: string[] = [];

type Client = SupabaseClient<Database>;
type Tenant = { email: string; userId: string; merchantAccountId: string; defaultShop: string };
type ShopContextInput = { merchantAccountId: string; shopId: string };

const CSV_HEADER = 'order_key,title,quantity,unit_amount,customer_name,phone';
const VALID_LINE = { raw_title: 'Article R2', raw_sku: null, qty: 1, match_status: 'unresolved' };

function adminClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
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

async function createTenant(admin: Client, label: string): Promise<Tenant> {
  const email = `r2-csv-${label}-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const { data, error } = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_default', true)
    .single();
  if (error || !data) throw error ?? new Error('default shop not found');
  return { email, userId, merchantAccountId, defaultShop: data.id };
}

async function createManualShop(admin: Client, tenant: Tenant) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: tenant.merchantAccountId,
      shop_domain: `manual-${randomUUID().replaceAll('-', '')}.internal`,
      store_kind: 'manual',
      is_default: false,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('manual shop insert failed');
  // shop_seed_memberships seme deja l'owner ; l'upsert reste defensif et sans effet sinon.
  await admin.from('shop_member').upsert(
    {
      merchant_account_id: tenant.merchantAccountId,
      shop_id: data.id,
      user_id: tenant.userId,
      role: 'owner',
    },
    { onConflict: 'shop_id,user_id', ignoreDuplicates: true },
  );
  return data.id;
}

async function signIn(email: string): Promise<Client> {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

function uniquePhone(): string {
  return `77${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
}

function orderArgs(
  context: ShopContextInput,
  orderKey: string,
  orderNumber: string,
  lines: Json = [VALID_LINE],
) {
  return {
    p_merchant_account_id: context.merchantAccountId,
    p_shop_id: context.shopId,
    p_customer_id: null as unknown as string,
    p_order_key: orderKey,
    p_order_number: orderNumber,
    p_total_amount: 1000,
    p_currency: 'XOF',
    p_items_summary: [{ title: 'Article R2', quantity: 1 }],
    p_shipping_address: null,
    p_lines: lines,
  };
}

function csvOrder(orderKey: string, phone: string) {
  const [preview] = previewCsvOrderImport(
    `${CSV_HEADER}\n${orderKey},Article A,2,500,Awa,${phone}\n${orderKey},Article B,1,300,Awa,${phone}`,
  );
  if (!preview?.order) throw new Error(`fixture CSV invalide : ${preview?.errors.join(' ')}`);
  return preview.order;
}

let pg: TestPostgresClient | undefined;
async function pgClient(): Promise<TestPostgresClient> {
  if (pg) return pg;
  pg = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
  await pg.connect();
  return pg;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const client = await pgClient();
  const { rows } = await client.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

async function countOrdersByNumber(orderNumbers: string[]) {
  return count('select count(*)::int as n from public.orders where order_number = any($1)', [
    orderNumbers,
  ]);
}

async function countCsvRefs(externalId: string) {
  return count(
    `select count(*)::int as n from public.external_ref
      where store_connection_id is null and source_namespace = 'csv' and external_id = $1`,
    [externalId],
  );
}

let admin: Client;
let tenantA: Tenant;
let tenantB: Tenant;
let shopA2: string;

beforeAll(async () => {
  if (!serviceRoleKey) return;
  admin = adminClient();
  tenantA = await createTenant(admin, 'a');
  tenantB = await createTenant(admin, 'b');
  shopA2 = await createManualShop(admin, tenantA);
});

afterAll(async () => {
  if (serviceRoleKey) {
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
  }
  await pg?.end();
});

describe.skipIf(!serviceRoleKey)('R2.1/R2.2 — create_csv_order et external_ref natif', () => {
  it('ACL : create_csv_order réservée au service_role (anon et authenticated refusés)', async () => {
    const client = await pgClient();
    const { rows } = await client.query<{ anon: boolean; auth: boolean; service: boolean }>(`
      select
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'create_csv_order'
    `);
    expect(rows).toEqual([{ anon: false, auth: false, service: true }]);
  });

  it('external_ref : connexion et espace de noms mutuellement exclusifs, liste fermée', async () => {
    const { data: connection, error: connectionError } = await admin
      .from('store_connection')
      .insert({
        merchant_account_id: tenantA.merchantAccountId,
        shop_id: tenantA.defaultShop,
        platform: 'shopify',
        external_identifier: `r2-csv-conn-${randomUUID()}.myshopify.com`,
        platform_app_id: 'r2-csv-test-client',
      })
      .select('id')
      .single();
    expect(connectionError).toBeNull();

    const base = {
      merchant_account_id: tenantA.merchantAccountId,
      shop_id: tenantA.defaultShop,
      entity_type: 'order',
      entity_id: randomUUID(),
    };
    const both = await admin.from('external_ref').insert({
      ...base,
      external_id: `r2-both-${randomUUID()}`,
      store_connection_id: connection?.id,
      source_namespace: 'csv',
    });
    const neither = await admin.from('external_ref').insert({
      ...base,
      external_id: `r2-neither-${randomUUID()}`,
      store_connection_id: null,
      source_namespace: null,
    });
    const unknownNamespace = await admin.from('external_ref').insert({
      ...base,
      external_id: `r2-unknown-${randomUUID()}`,
      store_connection_id: null,
      source_namespace: 'api',
    });

    expect(both.error?.code).toBe('23514');
    expect(neither.error?.code).toBe('23514');
    expect(unknownNamespace.error?.code).toBe('23514');
  });

  it('concurrence réelle : la seconde transaction attend le verrou puis échoue — une seule commande', async () => {
    const orderKey = `r2-concurrent-${randomUUID()}`;
    const firstNumber = `R2-C1-${randomUUID()}`;
    const secondNumber = `R2-C2-${randomUUID()}`;
    const callSql = `select public.create_csv_order($1, $2, null, $3, $4, 1000, 'XOF', $5::jsonb, null, $6::jsonb)`;
    const items = JSON.stringify([{ title: 'Article R2', quantity: 1 }]);
    const lines = JSON.stringify([VALID_LINE]);

    const first = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
      connectionTimeoutMillis: 10_000,
    });
    const second = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
      connectionTimeoutMillis: 10_000,
    });
    await first.connect();
    await second.connect();
    try {
      const { rows: pidRows } = await second.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      const secondPid = pidRows[0]?.pid;

      await first.query('begin');
      await second.query('begin');
      await first.query(callSql, [
        tenantA.merchantAccountId,
        shopA2,
        orderKey,
        firstNumber,
        items,
        lines,
      ]);

      const secondOutcome = second
        .query(callSql, [tenantA.merchantAccountId, shopA2, orderKey, secondNumber, items, lines])
        .then(
          () => 'committed',
          (error: { code?: string }) => error.code ?? 'unknown',
        );

      // Preuve que les deux transactions sont réellement concurrentes : la seconde est bloquée
      // sur un verrou (l'index natif d'external_ref), pas simplement exécutée après la première.
      let waitEvent: string | null = null;
      for (let attempt = 0; attempt < 40 && waitEvent !== 'Lock'; attempt++) {
        const { rows } = await (await pgClient()).query<{ wait_event_type: string | null }>(
          'select wait_event_type from pg_stat_activity where pid = $1',
          [secondPid],
        );
        waitEvent = rows[0]?.wait_event_type ?? null;
        if (waitEvent !== 'Lock') await new Promise((r) => setTimeout(r, 50));
      }
      expect(waitEvent).toBe('Lock');

      await first.query('commit');
      expect(await secondOutcome).toBe('23505');
      await second.query('rollback');
    } finally {
      await first.end();
      await second.end();
    }

    expect(await countOrdersByNumber([firstNumber, secondNumber])).toBe(1);
    expect(await countCsvRefs(orderKey)).toBe(1);
  });

  it('héritage : les lignes portent la boutique de la commande, jamais la boutique par défaut', async () => {
    const orderKey = `r2-inherit-${randomUUID()}`;
    const context = { merchantAccountId: tenantA.merchantAccountId, shopId: shopA2 };
    const { data: orderId, error } = await admin.rpc(
      'create_csv_order',
      orderArgs(context, orderKey, orderKey, [VALID_LINE, { ...VALID_LINE, raw_title: 'Autre' }]),
    );
    expect(error).toBeNull();

    const client = await pgClient();
    const { rows } = await client.query<{ shop_id: string }>(
      'select shop_id from public.order_line where order_id = $1',
      [orderId],
    );
    expect(shopA2).not.toBe(tenantA.defaultShop);
    expect(rows.map((row) => row.shop_id)).toEqual([shopA2, shopA2]);
  });

  it('atomicité : une ligne invalide n’écrit aucune commande partielle', async () => {
    const orderKey = `r2-partial-${randomUUID()}`;
    const context = { merchantAccountId: tenantA.merchantAccountId, shopId: shopA2 };
    const { error } = await admin.rpc(
      'create_csv_order',
      orderArgs(context, orderKey, orderKey, [
        VALID_LINE,
        { raw_title: null, raw_sku: null, qty: 1, match_status: 'unresolved' },
      ]),
    );
    expect(error).not.toBeNull();
    expect(await countOrdersByNumber([orderKey])).toBe(0);
    expect(await countCsvRefs(orderKey)).toBe(0);
  });

  it('isolation : boutique étrangère refusée, aucune ligne écrite nulle part', async () => {
    const signed = await signIn(tenantA.email);
    const foreignForOwnTenant = await resolveShopContext(signed, {
      merchantAccountId: tenantA.merchantAccountId,
      shopId: tenantB.defaultShop,
    });
    const foreignTenant = await resolveShopContext(signed, {
      merchantAccountId: tenantB.merchantAccountId,
      shopId: tenantB.defaultShop,
    });
    expect(foreignForOwnTenant.ok).toBe(false);
    expect(foreignTenant.ok).toBe(false);

    // Défense en profondeur : même un appelant service_role qui forgerait le couple est refusé.
    const orderKey = `r2-foreign-${randomUUID()}`;
    const { error } = await admin.rpc(
      'create_csv_order',
      orderArgs(
        { merchantAccountId: tenantA.merchantAccountId, shopId: tenantB.defaultShop },
        orderKey,
        orderKey,
      ),
    );
    expect(error?.message).toContain('r2_csv_shop_context_mismatch');

    expect(await countOrdersByNumber([orderKey])).toBe(0);
    expect(await countCsvRefs(orderKey)).toBe(0);
    expect(
      await count(
        'select count(*)::int as n from public.ingestion_event where resource_external_id = $1',
        [orderKey],
      ),
    ).toBe(0);
    expect(
      await count(
        `select count(*)::int as n from public.order_line ol
          join public.orders o on o.id = ol.order_id where o.order_number = $1`,
        [orderKey],
      ),
    ).toBe(0);
  });
});

describe.skipIf(!serviceRoleKey)('R2.1/R2.2 — moteur CSV (writeCsvCanonicalOrder)', () => {
  it('réimport du même order_key : already_imported, aucune nouvelle écriture', async () => {
    const signed = await signIn(tenantA.email);
    const resolved = await resolveShopContext(signed, {
      merchantAccountId: tenantA.merchantAccountId,
      shopId: shopA2,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const orderKey = `R2-ENG-${randomUUID()}`;
    const phone = uniquePhone();
    const order = csvOrder(orderKey, phone);

    const first = await writeCsvCanonicalOrder(admin, resolved.context, order);
    expect(first.ok).toBe(true);
    const second = await writeCsvCanonicalOrder(admin, resolved.context, order);
    expect(second).toEqual({ ok: false, code: 'already_imported' });

    expect(await countCsvRefs(orderKey)).toBe(1);
    expect(
      await count(
        `select count(*)::int as n from public.order_line ol
          join public.external_ref er on er.entity_id = ol.order_id
         where er.external_id = $1 and er.source_namespace = 'csv' and ol.shop_id = $2`,
        [orderKey, shopA2],
      ),
    ).toBe(2);
    expect(
      await count(
        'select count(*)::int as n from public.customer where shop_id = $1 and phone_e164 = $2',
        [shopA2, `+221${phone}`],
      ),
    ).toBe(1);

    const client = await pgClient();
    const { rows: events } = await client.query<{
      status: string;
      store_connection_id: string | null;
      platform: string;
      attempt_count: number;
    }>(
      `select status, store_connection_id, platform, attempt_count from public.ingestion_event
        where resource_external_id = $1`,
      [orderKey],
    );
    expect(events).toEqual([
      { status: 'done', store_connection_id: null, platform: 'csv', attempt_count: 1 },
    ]);
  });

  it('client : jamais rattaché depuis une autre boutique du même compte', async () => {
    const phone = uniquePhone();
    const { error: seedError } = await admin.from('customer').insert({
      merchant_account_id: tenantA.merchantAccountId,
      shop_id: tenantA.defaultShop,
      full_name: 'Client boutique par défaut',
      phone: `+221${phone}`,
      phone_e164: `+221${phone}`,
      source: 'manual',
    });
    expect(seedError).toBeNull();

    const signed = await signIn(tenantA.email);
    const resolved = await resolveShopContext(signed, {
      merchantAccountId: tenantA.merchantAccountId,
      shopId: shopA2,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const orderKey = `R2-XSHOP-${randomUUID()}`;
    const result = await writeCsvCanonicalOrder(admin, resolved.context, csvOrder(orderKey, phone));

    expect(result).toEqual({ ok: false, code: 'customer_write_failed' });
    expect(await countCsvRefs(orderKey)).toBe(0);
    expect(
      await count(
        'select count(*)::int as n from public.customer where shop_id = $1 and phone_e164 = $2',
        [shopA2, `+221${phone}`],
      ),
    ).toBe(0);
  });
});
