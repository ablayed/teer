/**
 * 0153 — finalisation atomique du rattachement WooCommerce.
 *
 * La suite appelle directement PostgreSQL pour conserver deux transactions
 * ouvertes pendant les courses. Elle ne dépend d'aucun callback TypeScript.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'r2-woocommerce-finalize-0153-password';
type Client = SupabaseClient<Database>;
type Tenant = { accountId: string; shopId: string; memberId: string; userId: string };

const createdUserIds: string[] = [];
let admin: Client;
let observer: TestPostgresClient | undefined;
const connectionIds: string[] = [];

function serviceClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function postgresClient(): TestPostgresClient {
  return createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
}

async function createTenant(label: string): Promise<Tenant> {
  const email = `r2-woocommerce-0153-${label}-${Date.now()}-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  if (!data.user) throw new Error('synthetic user missing');
  createdUserIds.push(data.user.id);

  const { data: account, error: accountError } = await admin
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', data.user.id)
    .single();
  expect(accountError).toBeNull();
  if (!account) throw new Error('synthetic account missing');

  const { data: shop, error: shopError } = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', account.id)
    .eq('is_default', true)
    .single();
  expect(shopError).toBeNull();
  if (!shop) throw new Error('synthetic shop missing');

  const { error: updateError } = await admin
    .from('shop')
    .update({ store_kind: 'woocommerce', shop_domain: `woo-0153-${randomUUID()}.example` })
    .eq('id', shop.id);
  expect(updateError).toBeNull();

  const { data: member, error: memberError } = await admin
    .from('merchant_member')
    .select('id')
    .eq('merchant_account_id', account.id)
    .eq('user_id', data.user.id)
    .single();
  expect(memberError).toBeNull();
  if (!member) throw new Error('synthetic merchant member missing');

  await admin.from('shop_member').upsert(
    {
      merchant_account_id: account.id,
      shop_id: shop.id,
      user_id: data.user.id,
      role: 'owner',
    },
    { onConflict: 'shop_id,user_id' },
  );

  return { accountId: account.id, shopId: shop.id, memberId: member.id, userId: data.user.id };
}

async function createIntent(
  client: TestPostgresClient,
  tenant: Tenant,
  identity: string,
  options: { createdAt?: string; expiresAt?: string; consumedAt?: string | null } = {},
): Promise<string> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString();
  const { rows } = await client.query<{ id: string }>(
    `insert into public.store_connection_intent
       (merchant_account_id, shop_id, platform, external_identifier, created_by_member_id,
        expires_at, consumed_at, created_at)
     values ($1, $2, 'woocommerce', $3, $4, $5, $6, $7)
     returning id`,
    [
      tenant.accountId,
      tenant.shopId,
      identity,
      tenant.memberId,
      expiresAt,
      options.consumedAt ?? null,
      createdAt,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('synthetic intent missing');
  return id;
}

async function finalize(
  client: TestPostgresClient,
  intentId: string,
  identity: string,
  keyId = `key-${randomUUID()}`,
) {
  const { rows } = await client.query<{ store_connection_id: string | null; result_code: string }>(
    `select * from public.finalize_woocommerce_connection($1, $2, 'basic_consumer', $3, 'enc-key', 'enc-secret', 'read_write')`,
    [intentId, identity, keyId],
  );
  return rows[0];
}

async function count(
  client: TestPostgresClient,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

async function waitForLock(pid: number): Promise<string | null> {
  if (!observer) throw new Error('observer unavailable');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { rows } = await observer.query<{ wait_event_type: string | null }>(
      'select wait_event_type from pg_stat_activity where pid = $1',
      [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') return 'Lock';
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function snapshot(client: TestPostgresClient, tenant: Tenant, intentId: string) {
  return {
    connections: await count(
      client,
      'select count(*)::int as n from public.store_connection where merchant_account_id = $1',
      [tenant.accountId],
    ),
    credentials: await count(
      client,
      'select count(*)::int as n from public.store_connection_credential where merchant_account_id = $1',
      [tenant.accountId],
    ),
    consumed: await count(
      client,
      'select count(*)::int as n from public.store_connection_intent where id = $1 and consumed_at is not null',
      [intentId],
    ),
  };
}

beforeAll(async () => {
  if (!serviceRoleKey) return;
  admin = serviceClient();
  observer = postgresClient();
  await observer.connect();
});

afterAll(async () => {
  if (serviceRoleKey) {
    for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
  }
  await observer?.end();
});

describe.skipIf(!serviceRoleKey)('0153 — finalisation WooCommerce', () => {
  it('ACL, propriétaire, invoker et search_path sont ceux du contrat', async () => {
    const client = postgresClient();
    await client.connect();
    try {
      const { rows } = await client.query(`
        select
          pg_get_userbyid(p.proowner) as owner,
          p.prosecdef,
          p.proconfig,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
          has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
        from pg_proc p
        where p.oid = 'public.finalize_woocommerce_connection(uuid,text,text,text,text,text,text)'::regprocedure
      `);
      expect(rows).toEqual([
        {
          owner: 'postgres',
          prosecdef: false,
          proconfig: ['search_path=""'],
          anon_exec: false,
          authenticated_exec: false,
          service_exec: true,
        },
      ]);
    } finally {
      await client.end();
    }
  });

  it('refuse intention inconnue, expirée et consommée sans écriture partielle', async () => {
    const tenant = await createTenant('states');
    const client = postgresClient();
    await client.connect();
    try {
      const unknown = await finalize(client, randomUUID(), 'https://states.example/');
      expect(unknown).toEqual({ store_connection_id: null, result_code: 'intent_not_found' });

      const createdAt = new Date(Date.now() - 120_000).toISOString();
      const expiredIntent = await createIntent(client, tenant, 'https://expired.example/', {
        createdAt,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      const expiredBefore = await snapshot(client, tenant, expiredIntent);
      expect(await finalize(client, expiredIntent, 'https://expired.example/')).toEqual({
        store_connection_id: null,
        result_code: 'intent_expired',
      });
      expect(await snapshot(client, tenant, expiredIntent)).toEqual(expiredBefore);

      const consumedIntent = await createIntent(client, tenant, 'https://consumed.example/', {
        consumedAt: new Date().toISOString(),
      });
      const consumedBefore = await snapshot(client, tenant, consumedIntent);
      expect(await finalize(client, consumedIntent, 'https://consumed.example/')).toEqual({
        store_connection_id: null,
        result_code: 'intent_consumed',
      });
      expect(await snapshot(client, tenant, consumedIntent)).toEqual(consumedBefore);
    } finally {
      await client.end();
    }
  });

  it('refuse créateur devenu non autorisé et identité divergente sans consommer', async () => {
    const tenant = await createTenant('guards');
    const client = postgresClient();
    await client.connect();
    try {
      const unauthorizedIntent = await createIntent(client, tenant, 'https://guards.example/');
      await client.query(`update public.merchant_member set role = 'agent' where id = $1`, [
        tenant.memberId,
      ]);
      await client.query(
        `update public.shop_member set role = 'agent' where merchant_account_id = $1 and shop_id = $2 and user_id = $3`,
        [tenant.accountId, tenant.shopId, tenant.userId],
      );
      const before = await snapshot(client, tenant, unauthorizedIntent);
      expect(await finalize(client, unauthorizedIntent, 'https://guards.example/')).toEqual({
        store_connection_id: null,
        result_code: 'creator_not_authorized',
      });
      expect(await snapshot(client, tenant, unauthorizedIntent)).toEqual(before);
      await client.query(`update public.merchant_member set role = 'owner' where id = $1`, [
        tenant.memberId,
      ]);
      await client.query(
        `update public.shop_member set role = 'owner' where merchant_account_id = $1 and shop_id = $2 and user_id = $3`,
        [tenant.accountId, tenant.shopId, tenant.userId],
      );

      const mismatchIntent = await createIntent(client, tenant, 'https://guards.example/');
      const mismatchBefore = await snapshot(client, tenant, mismatchIntent);
      expect(await finalize(client, mismatchIntent, 'https://other.example/')).toEqual({
        store_connection_id: null,
        result_code: 'identity_mismatch',
      });
      expect(await snapshot(client, tenant, mismatchIntent)).toEqual(mismatchBefore);
    } finally {
      await client.end();
    }
  });

  it('réserve globalement l’identité et refuse le second locataire par code nommé', async () => {
    const tenantA = await createTenant('cross-a');
    const tenantB = await createTenant('cross-b');
    const identity = 'https://same.example/';
    const client = postgresClient();
    await client.connect();
    try {
      const intentA = await createIntent(client, tenantA, identity);
      const intentB = await createIntent(client, tenantB, identity);
      const first = await finalize(client, intentA, identity);
      expect(first?.result_code).toBe('ok');
      if (first?.store_connection_id) connectionIds.push(first.store_connection_id);
      const second = await finalize(client, intentB, identity);
      expect(second).toEqual({
        store_connection_id: null,
        result_code: 'identity_already_assigned',
      });
      expect(
        await count(
          client,
          "select count(*)::int as n from public.store_connection where platform = 'woocommerce' and external_identifier = $1",
          [identity],
        ),
      ).toBe(1);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection_credential where merchant_account_id = $1',
          [tenantB.accountId],
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection_intent where id = $1 and consumed_at is null',
          [intentB],
        ),
      ).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('ne reprend jamais la connexion needs_reauth d’un autre locataire', async () => {
    const tenantA = await createTenant('reauth-a');
    const tenantB = await createTenant('reauth-b');
    const identity = 'https://reauth.example/';
    const client = postgresClient();
    await client.connect();
    try {
      const firstIntent = await createIntent(client, tenantA, identity);
      const first = await finalize(client, firstIntent, identity);
      if (!first?.store_connection_id) throw new Error('first connection missing');
      connectionIds.push(first.store_connection_id);
      await client.query(
        `update public.store_connection set status = 'needs_reauth' where id = $1`,
        [first.store_connection_id],
      );

      const foreignIntent = await createIntent(client, tenantB, identity);
      expect(await finalize(client, foreignIntent, identity)).toEqual({
        store_connection_id: null,
        result_code: 'identity_already_assigned',
      });
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection where merchant_account_id = $1',
          [tenantB.accountId],
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection_credential where merchant_account_id = $1',
          [tenantB.accountId],
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection_intent where id = $1 and consumed_at is null',
          [foreignIntent],
        ),
      ).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('révoque la génération courante avant d’insérer une rotation autorisée', async () => {
    const tenant = await createTenant('rotation');
    const identity = 'https://rotation.example/';
    const client = postgresClient();
    await client.connect();
    try {
      const firstIntent = await createIntent(client, tenant, identity);
      const first = await finalize(client, firstIntent, identity, 'generation-one');
      if (!first?.store_connection_id) throw new Error('rotation connection missing');
      connectionIds.push(first.store_connection_id);
      await client.query(
        `update public.store_connection set status = 'needs_reauth' where id = $1`,
        [first.store_connection_id],
      );
      const secondIntent = await createIntent(client, tenant, identity);
      expect(await finalize(client, secondIntent, identity, 'generation-two')).toEqual({
        store_connection_id: first.store_connection_id,
        result_code: 'ok',
      });
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection_credential where store_connection_id = $1',
          [first.store_connection_id],
        ),
      ).toBe(2);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection_credential where store_connection_id = $1 and revoked_at is null',
          [first.store_connection_id],
        ),
      ).toBe(1);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection_credential where store_connection_id = $1 and revoked_at is not null',
          [first.store_connection_id],
        ),
      ).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('sérialise deux finalisations simultanées de la même intention', async () => {
    const tenant = await createTenant('same-intent');
    const identity = 'https://same-intent.example/';
    const first = postgresClient();
    const second = postgresClient();
    await first.connect();
    await second.connect();
    try {
      const intent = await createIntent(first, tenant, identity);
      const { rows: firstPidRows } = await first.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      const { rows: secondPidRows } = await second.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      await first.query('begin');
      await second.query('begin');
      const firstResult = await finalize(first, intent, identity, 'same-one');
      const secondResultPromise = finalize(second, intent, identity, 'same-two');
      expect(await waitForLock(secondPidRows[0]?.pid ?? 0)).toBe('Lock');
      await first.query('commit');
      expect(firstResult?.result_code).toBe('ok');
      expect(await secondResultPromise).toEqual({
        store_connection_id: null,
        result_code: 'intent_consumed',
      });
      await second.query('commit');
      expect(
        await count(
          first,
          'select count(*)::int as n from public.store_connection where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(1);
      expect(
        await count(
          first,
          'select count(*)::int as n from public.store_connection_credential where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(1);
      expect(firstPidRows[0]?.pid).not.toBe(secondPidRows[0]?.pid);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('sérialise deux intentions distinctes sur la même identité avant toute écriture', async () => {
    const tenantA = await createTenant('identity-race-a');
    const tenantB = await createTenant('identity-race-b');
    const identity = 'https://identity-race.example/';
    const first = postgresClient();
    const second = postgresClient();
    await first.connect();
    await second.connect();
    try {
      const intentA = await createIntent(first, tenantA, identity);
      const intentB = await createIntent(first, tenantB, identity);
      const { rows: secondPidRows } = await second.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      await first.query('begin');
      await second.query('begin');
      const firstResult = await finalize(first, intentA, identity, 'race-one');
      const secondResultPromise = finalize(second, intentB, identity, 'race-two');
      expect(await waitForLock(secondPidRows[0]?.pid ?? 0)).toBe('Lock');
      await first.query('commit');
      expect(firstResult?.result_code).toBe('ok');
      expect(await secondResultPromise).toEqual({
        store_connection_id: null,
        result_code: 'identity_already_assigned',
      });
      await second.query('commit');
      expect(
        await count(
          first,
          "select count(*)::int as n from public.store_connection where platform = 'woocommerce' and external_identifier = $1",
          [identity],
        ),
      ).toBe(1);
      expect(
        await count(
          first,
          'select count(*)::int as n from public.store_connection_credential where merchant_account_id = $1',
          [tenantA.accountId],
        ),
      ).toBe(1);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('dérive la même clé entre sessions et des clés distinctes pour les identités témoins', async () => {
    const first = postgresClient();
    const second = postgresClient();
    await first.connect();
    await second.connect();
    try {
      const derive = async (client: TestPostgresClient, identity: string) => {
        const { rows } = await client.query<{ lock_key: string }>(
          `select pg_catalog.hashtextextended(
             pg_catalog.length($1)::text || ':' || $1 ||
             pg_catalog.length($2)::text || ':' || $2,
             0
           )::text as lock_key`,
          ['woocommerce', identity],
        );
        return rows[0]?.lock_key;
      };

      const identityA = 'https://key-derivation-a.example/';
      const identityB = 'https://key-derivation-b.example/';
      const firstA = await derive(first, identityA);
      const secondA = await derive(second, identityA);
      const firstB = await derive(first, identityB);
      const secondB = await derive(second, identityB);

      expect(firstA).toBeDefined();
      expect(firstA).toBe(secondA);
      expect(firstB).toBe(secondB);
      expect(firstA).not.toBe(firstB);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('prend le verrou d’identité avant de créer la connexion', async () => {
    const tenant = await createTenant('identity-lock');
    const identity = 'https://identity-lock.example/';
    const holder = postgresClient();
    const worker = postgresClient();
    await holder.connect();
    await worker.connect();
    try {
      const intent = await createIntent(holder, tenant, identity);
      const { rows: workerPidRows } = await worker.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      await holder.query('begin');
      await holder.query(
        `select pg_catalog.pg_advisory_xact_lock(
           pg_catalog.hashtextextended(
             pg_catalog.length('woocommerce')::text || ':woocommerce' ||
             pg_catalog.length($1)::text || ':' || $1,
             0
           )
         )`,
        [identity],
      );

      await worker.query('begin');
      const resultPromise = finalize(worker, intent, identity, 'blocked-before-write');
      expect(await waitForLock(workerPidRows[0]?.pid ?? 0)).toBe('Lock');

      if (!observer) throw new Error('observer unavailable');
      const measurementClient = observer;

      expect(
        await count(
          measurementClient,
          'select count(*)::int as n from public.store_connection where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(0);
      expect(
        await count(
          measurementClient,
          'select count(*)::int as n from public.store_connection_credential where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(0);
      expect(
        await count(
          measurementClient,
          'select count(*)::int as n from public.store_connection_intent where id = $1 and consumed_at is null',
          [intent],
        ),
      ).toBe(1);

      await holder.query('commit');
      expect((await resultPromise)?.result_code).toBe('ok');
      await worker.query('commit');
    } finally {
      await holder.end();
      await worker.end();
    }
  });
});
