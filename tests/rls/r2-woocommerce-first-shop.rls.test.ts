/**
 * 0154 — première boutique WooCommerce créée atomiquement au callback.
 *
 * Ces tests restent au niveau PostgreSQL : aucune Server Action ni callback
 * HTTP ne peut contourner les verrous et l'absence d'écriture partielle.
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
const password = 'r2-woocommerce-0154-password';

type Client = SupabaseClient<Database>;
type Tenant = { accountId: string; manualShopId: string; memberId: string; userId: string };

const createdUserIds: string[] = [];
let admin: Client;

function serviceClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function postgresClient(): TestPostgresClient {
  return createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
}

async function createTenant(label: string): Promise<Tenant> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `r2-woocommerce-0154-${label}-${Date.now()}-${randomUUID()}@example.com`,
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

  const { data: manualShop, error: shopError } = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', account.id)
    .eq('store_kind', 'manual')
    .single();
  expect(shopError).toBeNull();
  if (!manualShop) throw new Error('manual shop missing');

  const { data: member, error: memberError } = await admin
    .from('merchant_member')
    .select('id')
    .eq('merchant_account_id', account.id)
    .eq('user_id', data.user.id)
    .single();
  expect(memberError).toBeNull();
  if (!member) throw new Error('merchant member missing');

  return {
    accountId: account.id,
    manualShopId: manualShop.id,
    memberId: member.id,
    userId: data.user.id,
  };
}

async function createNewIntent(
  client: TestPostgresClient,
  tenant: Tenant,
  identity: string,
  options: { createdAt?: string; expiresAt?: string; consumedAt?: string | null } = {},
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.store_connection_intent
       (merchant_account_id, shop_id, target_kind, platform, external_identifier,
        created_by_member_id, expires_at, consumed_at, created_at)
     values ($1, null, 'new_shop', 'woocommerce', $2, $3, $4, $5, $6)
     returning id`,
    [
      tenant.accountId,
      identity,
      tenant.memberId,
      options.expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString(),
      options.consumedAt ?? null,
      options.createdAt ?? new Date().toISOString(),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('new-shop intent missing');
  return id;
}

async function createExistingIntent(
  client: TestPostgresClient,
  tenant: Tenant,
  shopId: string,
  identity: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.store_connection_intent
       (merchant_account_id, shop_id, target_kind, platform, external_identifier,
        created_by_member_id, expires_at)
     values ($1, $2, 'existing_shop', 'woocommerce', $3, $4, $5)
     returning id`,
    [
      tenant.accountId,
      shopId,
      identity,
      tenant.memberId,
      new Date(Date.now() + 5 * 60_000).toISOString(),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('existing-shop intent missing');
  return id;
}

async function finalize(
  client: TestPostgresClient,
  intentId: string,
  identity: string,
  keyId?: string,
) {
  const { rows } = await client.query<{ store_connection_id: string | null; result_code: string }>(
    `select * from public.finalize_woocommerce_connection($1, $2, 'basic_consumer', $3, 'enc-key', 'enc-secret', 'read_write')`,
    [intentId, identity, keyId ?? `key-${randomUUID()}`],
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

async function createWooShop(client: TestPostgresClient, tenant: Tenant): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.shop
       (merchant_account_id, shop_domain, access_token_encrypted, scopes, status, display_name, store_kind, is_default)
     values ($1, $2, null, '', 'active', 'Boutique WooCommerce existante', 'woocommerce', false)
     returning id`,
    [tenant.accountId, `woocommerce-${randomUUID().replaceAll('-', '')}.internal`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('woocommerce shop missing');
  return id;
}

async function waitForLock(observer: TestPostgresClient, pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { rows } = await observer.query<{ wait_event_type: string | null }>(
      'select wait_event_type from pg_stat_activity where pid = $1',
      [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

beforeAll(() => {
  if (serviceRoleKey) admin = serviceClient();
});

afterAll(async () => {
  if (serviceRoleKey) {
    for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
  }
});

describe.skipIf(!serviceRoleKey)('0154 — première boutique WooCommerce', () => {
  it('n’accepte que les deux formes exclusives target_kind/shop_id', async () => {
    const tenant = await createTenant('intent-shape');
    const client = postgresClient();
    await client.connect();
    try {
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      await expect(
        client.query(
          `insert into public.store_connection_intent
             (merchant_account_id, shop_id, target_kind, platform, external_identifier, created_by_member_id, expires_at)
           values ($1, $2, 'new_shop', 'woocommerce', $3, $4, $5)`,
          [
            tenant.accountId,
            tenant.manualShopId,
            `https://invalid-new-${randomUUID()}.example.test/`,
            tenant.memberId,
            expiresAt,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        client.query(
          `insert into public.store_connection_intent
             (merchant_account_id, shop_id, target_kind, platform, external_identifier, created_by_member_id, expires_at)
           values ($1, null, 'existing_shop', 'woocommerce', $2, $3, $4)`,
          [
            tenant.accountId,
            `https://invalid-existing-${randomUUID()}.example.test/`,
            tenant.memberId,
            expiresAt,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  it('conserve existing_shop pour une intention écrite par l’ancien déploiement', async () => {
    const tenant = await createTenant('legacy-default');
    const client = postgresClient();
    await client.connect();
    try {
      const { rows } = await client.query<{ target_kind: string }>(
        `insert into public.store_connection_intent
           (merchant_account_id, shop_id, platform, external_identifier, created_by_member_id, expires_at)
         values ($1, $2, 'woocommerce', $3, $4, $5)
         returning target_kind`,
        [
          tenant.accountId,
          tenant.manualShopId,
          `https://legacy-default-${randomUUID()}.example.test/`,
          tenant.memberId,
          new Date(Date.now() + 5 * 60_000).toISOString(),
        ],
      );
      expect(rows).toEqual([{ target_kind: 'existing_shop' }]);
    } finally {
      await client.end();
    }
  });

  it('crée boutique, appartenances, connexion et credentials ensemble sans convertir la boutique manual', async () => {
    const tenant = await createTenant('success');
    const client = postgresClient();
    await client.connect();
    try {
      const { rows: manualBeforeRows } = await client.query<{
        shop_domain: string;
        store_kind: string;
        is_default: boolean;
      }>('select shop_domain, store_kind, is_default from public.shop where id = $1', [
        tenant.manualShopId,
      ]);
      const manualBefore = manualBeforeRows[0];
      const identity = 'https://first-shop.example.test/';
      const intentId = await createNewIntent(client, tenant, identity);

      const result = await finalize(client, intentId, identity);
      expect(result?.result_code).toBe('ok');
      if (!result?.store_connection_id) throw new Error('connection missing');

      const { rows: wooRows } = await client.query<{
        id: string;
        shop_domain: string;
        display_name: string;
        store_kind: string;
        is_default: boolean;
        api_version: string;
      }>(
        `select s.id, s.shop_domain, s.display_name, s.store_kind, s.is_default, s.api_version
         from public.shop s
         join public.store_connection sc on sc.shop_id = s.id
         where sc.id = $1`,
        [result.store_connection_id],
      );
      expect(wooRows).toHaveLength(1);
      expect(wooRows[0]).toMatchObject({
        display_name: 'first-shop.example.test',
        store_kind: 'woocommerce',
        is_default: false,
        api_version: '2026-04',
      });
      expect(wooRows[0]?.shop_domain).toMatch(/^woocommerce-[0-9a-f]{32}\.internal$/);
      expect(wooRows[0]?.shop_domain).not.toBe(identity);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.shop_member where shop_id = $1 and user_id = $2',
          [wooRows[0]?.id, tenant.userId],
        ),
      ).toBe(1);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection_credential where store_connection_id = $1 and revoked_at is null',
          [result.store_connection_id],
        ),
      ).toBe(1);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection_intent where id = $1 and consumed_at is not null',
          [intentId],
        ),
      ).toBe(1);
      const { rows: manualAfterRows } = await client.query(
        'select shop_domain, store_kind, is_default from public.shop where id = $1',
        [tenant.manualShopId],
      );
      expect(manualAfterRows).toEqual([manualBefore]);
    } finally {
      await client.end();
    }
  });

  it('connecte WooCommerce depuis un compte qui ne possède qu’une boutique Shopify', async () => {
    const tenant = await createTenant('shopify-only');
    const client = postgresClient();
    await client.connect();
    try {
      const shopifyDomain = `shopify-only-${randomUUID()}.myshopify.com`;
      await client.query(
        `update public.shop
         set store_kind = 'shopify', shop_domain = $2, display_name = 'Boutique Shopify', scopes = 'read_orders'
         where id = $1`,
        [tenant.manualShopId, shopifyDomain],
      );
      const identity = 'https://shopify-only-tenant.example.test/';
      const result = await finalize(
        client,
        await createNewIntent(client, tenant, identity),
        identity,
      );
      expect(result?.result_code).toBe('ok');
      expect(
        await count(
          client,
          "select count(*)::int as n from public.shop where merchant_account_id = $1 and store_kind = 'manual'",
          [tenant.accountId],
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          "select count(*)::int as n from public.shop where merchant_account_id = $1 and store_kind = 'shopify'",
          [tenant.accountId],
        ),
      ).toBe(1);
      const { rows: wooRows } = await client.query<{ shop_id: string; shop_domain: string }>(
        `select sc.shop_id, s.shop_domain
         from public.store_connection sc
         join public.shop s on s.id = sc.shop_id
         where sc.merchant_account_id = $1 and sc.platform = 'woocommerce'`,
        [tenant.accountId],
      );
      expect(wooRows).toHaveLength(1);
      expect(wooRows[0]?.shop_domain).toMatch(/^woocommerce-[0-9a-f]{32}\.internal$/);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.shop_member where shop_id = $1 and user_id = $2',
          [wooRows[0]?.shop_id, tenant.userId],
        ),
      ).toBe(1);
      expect(
        await count(
          client,
          "select count(*)::int as n from public.store_connection where merchant_account_id = $1 and platform = 'shopify'",
          [tenant.accountId],
        ),
      ).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('ne crée rien pour une intention abandonnée, expirée ou consommée', async () => {
    const tenant = await createTenant('no-partial');
    const client = postgresClient();
    await client.connect();
    try {
      const initialShops = await count(
        client,
        'select count(*)::int as n from public.shop where merchant_account_id = $1',
        [tenant.accountId],
      );
      const abandoned = await createNewIntent(client, tenant, 'https://abandoned.example.test/');
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.shop where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(initialShops);
      expect(abandoned).toBeDefined();

      const expired = await createNewIntent(client, tenant, 'https://expired-new.example.test/', {
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      expect(await finalize(client, expired, 'https://expired-new.example.test/')).toEqual({
        store_connection_id: null,
        result_code: 'intent_expired',
      });
      const consumed = await createNewIntent(client, tenant, 'https://consumed-new.example.test/', {
        consumedAt: new Date().toISOString(),
      });
      expect(await finalize(client, consumed, 'https://consumed-new.example.test/')).toEqual({
        store_connection_id: null,
        result_code: 'intent_consumed',
      });
      expect(
        await count(
          client,
          'select count(*)::int as n from public.shop where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(initialShops);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(0);
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection_credential where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('applique merchant_member seulement à new_shop et merchant_member plus shop_member à existing_shop', async () => {
    const tenant = await createTenant('membership');
    const client = postgresClient();
    await client.connect();
    try {
      const newIdentity = 'https://membership-new.example.test/';
      const newIntent = await createNewIntent(client, tenant, newIdentity);
      await client.query("update public.merchant_member set role = 'agent' where id = $1", [
        tenant.memberId,
      ]);
      expect(await finalize(client, newIntent, newIdentity)).toEqual({
        store_connection_id: null,
        result_code: 'creator_not_authorized',
      });
      await client.query("update public.merchant_member set role = 'owner' where id = $1", [
        tenant.memberId,
      ]);

      const existingShopId = await createWooShop(client, tenant);
      const existingIdentity = 'https://membership-existing.example.test/';
      const existingIntent = await createExistingIntent(
        client,
        tenant,
        existingShopId,
        existingIdentity,
      );
      await client.query(
        "update public.shop_member set role = 'agent' where merchant_account_id = $1 and shop_id = $2 and user_id = $3",
        [tenant.accountId, existingShopId, tenant.userId],
      );
      expect(await finalize(client, existingIntent, existingIdentity)).toEqual({
        store_connection_id: null,
        result_code: 'creator_not_authorized',
      });

      const independentNewIdentity = 'https://membership-new-still-works.example.test/';
      const independentNewIntent = await createNewIntent(client, tenant, independentNewIdentity);
      expect(
        (await finalize(client, independentNewIntent, independentNewIdentity))?.result_code,
      ).toBe('ok');
    } finally {
      await client.end();
    }
  });

  it('sérialise deux intentions new_shop de même identité : une boutique et une connexion', async () => {
    const tenant = await createTenant('same-identity');
    const identity = 'https://same-new-shop.example.test/';
    const first = postgresClient();
    const second = postgresClient();
    const observer = postgresClient();
    await first.connect();
    await second.connect();
    await observer.connect();
    try {
      const firstIntent = await createNewIntent(first, tenant, identity);
      const secondIntent = await createNewIntent(first, tenant, identity);
      const { rows: secondPidRows } = await second.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      await first.query('begin');
      await second.query('begin');
      const firstResult = await finalize(first, firstIntent, identity, 'same-first');
      const secondResult = finalize(second, secondIntent, identity, 'same-second');
      expect(await waitForLock(observer, secondPidRows[0]?.pid ?? 0)).toBe(true);
      await first.query('commit');
      expect(firstResult?.result_code).toBe('ok');
      expect(await secondResult).toEqual({
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
          "select count(*)::int as n from public.shop where merchant_account_id = $1 and store_kind = 'woocommerce'",
          [tenant.accountId],
        ),
      ).toBe(1);
      expect(
        await count(
          first,
          'select count(*)::int as n from public.store_connection_credential where merchant_account_id = $1 and revoked_at is null',
          [tenant.accountId],
        ),
      ).toBe(1);
    } finally {
      await first.end();
      await second.end();
      await observer.end();
    }
  });

  it('crée deux boutiques distinctes pour deux identités et coexiste avec Shopify', async () => {
    const tenant = await createTenant('two-identities');
    const client = postgresClient();
    await client.connect();
    try {
      await client.query(
        `insert into public.shop
           (merchant_account_id, shop_domain, access_token_encrypted, scopes, status, display_name, store_kind, is_default)
         values ($1, $2, null, 'read_orders', 'active', 'Boutique Shopify', 'shopify', false)`,
        [tenant.accountId, `shopify-${randomUUID()}.myshopify.com`],
      );
      const firstIdentity = 'https://first-distinct.example.test/';
      const secondIdentity = 'https://second-distinct.example.test/';
      expect(
        (
          await finalize(
            client,
            await createNewIntent(client, tenant, firstIdentity),
            firstIdentity,
          )
        )?.result_code,
      ).toBe('ok');
      expect(
        (
          await finalize(
            client,
            await createNewIntent(client, tenant, secondIdentity),
            secondIdentity,
          )
        )?.result_code,
      ).toBe('ok');
      expect(
        await count(
          client,
          "select count(*)::int as n from public.shop where merchant_account_id = $1 and store_kind = 'woocommerce'",
          [tenant.accountId],
        ),
      ).toBe(2);
      expect(
        await count(
          client,
          "select count(*)::int as n from public.shop where merchant_account_id = $1 and store_kind = 'shopify'",
          [tenant.accountId],
        ),
      ).toBe(1);
      expect(
        await count(
          client,
          "select count(*)::int as n from public.shop where merchant_account_id = $1 and store_kind = 'manual' and is_default",
          [tenant.accountId],
        ),
      ).toBe(1);
      const { rows: domains } = await client.query<{ total: number; distinct_total: number }>(
        `select count(*)::int as total, count(distinct shop_domain)::int as distinct_total
         from public.shop
         where merchant_account_id = $1 and store_kind = 'woocommerce'`,
        [tenant.accountId],
      );
      expect(domains[0]).toEqual({ total: 2, distinct_total: 2 });
    } finally {
      await client.end();
    }
  });

  it('laisse deux finalisations concurrentes d’identités distinctes créer deux boutiques distinctes', async () => {
    const tenant = await createTenant('different-identities-race');
    const first = postgresClient();
    const second = postgresClient();
    await first.connect();
    await second.connect();
    try {
      const identityA = 'https://race-distinct-a.example.test/';
      const identityB = 'https://race-distinct-b.example.test/';
      const intentA = await createNewIntent(first, tenant, identityA);
      const intentB = await createNewIntent(first, tenant, identityB);
      await first.query('begin');
      await second.query('begin');
      const [firstResult, secondResult] = await Promise.all([
        finalize(first, intentA, identityA, 'distinct-a'),
        finalize(second, intentB, identityB, 'distinct-b'),
      ]);
      await first.query('commit');
      await second.query('commit');
      expect(firstResult?.result_code).toBe('ok');
      expect(secondResult?.result_code).toBe('ok');
      expect(
        await count(
          first,
          "select count(*)::int as n from public.shop where merchant_account_id = $1 and store_kind = 'woocommerce'",
          [tenant.accountId],
        ),
      ).toBe(2);
      expect(
        await count(
          first,
          'select count(distinct shop_id)::int as n from public.store_connection where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(2);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('sérialise deux intentions existing_shop sur la même boutique et refuse la seconde nommément', async () => {
    const tenant = await createTenant('existing-shop-race');
    const first = postgresClient();
    const second = postgresClient();
    const observer = postgresClient();
    await first.connect();
    await second.connect();
    await observer.connect();
    try {
      const shopId = await createWooShop(first, tenant);
      const identityA = 'https://existing-race-a.example.test/';
      const identityB = 'https://existing-race-b.example.test/';
      const intentA = await createExistingIntent(first, tenant, shopId, identityA);
      const intentB = await createExistingIntent(first, tenant, shopId, identityB);
      const { rows: secondPidRows } = await second.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      await first.query('begin');
      await second.query('begin');
      const firstResult = await finalize(first, intentA, identityA, 'existing-a');
      const secondResult = finalize(second, intentB, identityB, 'existing-b');
      expect(await waitForLock(observer, secondPidRows[0]?.pid ?? 0)).toBe(true);
      await first.query('commit');
      expect(firstResult?.result_code).toBe('ok');
      expect(await secondResult).toEqual({
        store_connection_id: null,
        result_code: 'shop_already_connected',
      });
      await second.query('commit');
      expect(
        await count(
          first,
          'select count(*)::int as n from public.store_connection where merchant_account_id = $1 and shop_id = $2',
          [tenant.accountId, shopId],
        ),
      ).toBe(1);
      expect(
        await count(
          first,
          'select count(*)::int as n from public.store_connection_credential where merchant_account_id = $1 and shop_id = $2',
          [tenant.accountId, shopId],
        ),
      ).toBe(1);
    } finally {
      await first.end();
      await second.end();
      await observer.end();
    }
  });

  it('refuse existing_shop sur la boutique manual sans la convertir ni écrire de connexion', async () => {
    const tenant = await createTenant('manual-guard');
    const client = postgresClient();
    await client.connect();
    try {
      const identity = 'https://manual-guard.example.test/';
      const intent = await createExistingIntent(client, tenant, tenant.manualShopId, identity);
      expect(await finalize(client, intent, identity)).toEqual({
        store_connection_id: null,
        result_code: 'intent_shop_kind_mismatch',
      });
      expect(
        await count(
          client,
          'select count(*)::int as n from public.store_connection where merchant_account_id = $1',
          [tenant.accountId],
        ),
      ).toBe(0);
    } finally {
      await client.end();
    }
  });
});
