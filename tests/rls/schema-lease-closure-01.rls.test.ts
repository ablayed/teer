// SCHEMA-LEASE-CLOSURE-01 — contrat SQL des primitives préemptives et fencées (migration 0159).
//
// Ce qui est exercé : les RPC réelles, appelées par le client réellement utilisé en production
// (supabase-js → PostgREST, rôle service_role), et, pour les courses, deux connexions PostgreSQL
// dont les transactions sont entrelacées à la main sous `set local role service_role` — une
// concurrence DÉTERMINISTE, pas un chevauchement espéré.
//
// Ce qui n'est PAS exercé ici, et relève du lot applicatif : le branchement TypeScript des huit
// écrivains sur ces primitives, donc la preuve 9B (un seul appel Shopify réellement émis).
//
// Aucun import applicatif : ce fichier ne charge ni `lib/env`, ni client service-role de l'app.
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const hasStack = Boolean(serviceRoleKey);

const APP_X = 'lease-closure-01-app-x-sentinel';
const APP_Y = 'lease-closure-01-app-y-sentinel';
const TTL = 60;

const SHOP_COLUMNS =
  'id, merchant_account_id, shop_domain, shopify_client_id, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at, scopes, status, uninstalled_at, updated_at';

type ShopRow = {
  id: string;
  merchant_account_id: string;
  shop_domain: string;
  shopify_client_id: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  scopes: string;
  status: string;
  uninstalled_at: string | null;
  updated_at: string;
};

type Tenant = { userId: string; merchantAccountId: string };
type DestructiveVerdict = { outcome: string; shop_id: string | null; generation: number | null };

const createdUserIds: string[] = [];
const createdDomains: string[] = [];
const pgClients: TestPostgresClient[] = [];
let tenantA: Tenant;
let tenantB: Tenant;

function service() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function pgConnect(): Promise<TestPostgresClient> {
  const client = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  pgClients.push(client);
  return client;
}

async function createTenant(prefix: string): Promise<Tenant> {
  const admin = service();
  const email = `${prefix}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'mot-de-passe-test-rls',
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`user creation failed: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { data: member, error: memberError } = await admin
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', data.user.id)
    .single();
  if (memberError || !member) throw new Error(`no membership for ${data.user.id}`);
  return { userId: data.user.id, merchantAccountId: member.merchant_account_id as string };
}

function freshDomain(label: string): string {
  const domain = `closure-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireOne(domain: string, ttlSeconds: number): Promise<number> {
  const { data, error } = await service().rpc('acquire_shopify_token_lease', {
    p_shop_domain: domain,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new Error(`acquire failed: ${error.code} ${error.message}`);
  const rows = data as Array<{ acquired_generation: number }>;
  expect(rows).toHaveLength(1);
  return Number(rows[0]?.acquired_generation);
}

async function releaseLease(domain: string, generation: number) {
  const { data, error } = await service()
    .from('shopify_token_lease')
    .update({ lease_expires_at: null })
    .eq('shop_domain', domain)
    .eq('generation', generation)
    .not('lease_expires_at', 'is', null)
    .select('generation');
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
}

async function leaseRow(domain: string) {
  const { data, error } = await service()
    .from('shopify_token_lease')
    .select('shop_domain, generation, lease_expires_at')
    .eq('shop_domain', domain)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as {
    shop_domain: string;
    generation: number;
    lease_expires_at: string | null;
  } | null;
}

async function shopRow(domain: string): Promise<ShopRow | null> {
  const { data, error } = await service()
    .from('shop')
    .select(SHOP_COLUMNS)
    .eq('shop_domain', domain)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as ShopRow | null;
}

async function connectionRow(domain: string) {
  const { data, error } = await service()
    .from('store_connection')
    .select('id, merchant_account_id, shop_id, platform_app_id, status, uninstalled_at')
    .eq('platform', 'shopify')
    .eq('external_identifier', domain)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function seedShop(
  domain: string,
  merchantAccountId: string,
  overrides: Partial<ShopRow> & { store_kind?: string } = {},
): Promise<ShopRow> {
  const { error } = await service()
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: domain,
      shopify_client_id: APP_X,
      access_token_encrypted: 'seed-access',
      refresh_token_encrypted: 'seed-refresh',
      access_token_expires_at: '2030-01-01T00:00:00+00:00',
      refresh_token_expires_at: '2030-06-01T00:00:00+00:00',
      scopes: 'seed_scope',
      status: 'active',
      ...overrides,
    });
  if (error) throw new Error(`seed shop failed: ${error.message}`);
  const row = await shopRow(domain);
  if (!row) throw new Error('seeded shop not found');
  return row;
}

// Connexion `store_connection` active, écrite par la primitive fencée de 0158 sous un bail
// aussitôt libéré — la seule voie d'écriture que la production utilisera.
async function seedConnection(domain: string, merchantAccountId: string) {
  const generation = await acquireOne(domain, TTL);
  const { data, error } = await service().rpc('write_shopify_store_connection_fenced', {
    p_shop_domain: domain,
    p_generation: generation,
    p_merchant_account_id: merchantAccountId,
    p_client_id: APP_X,
  });
  if (error) throw new Error(`seed connection failed: ${error.message}`);
  expect((data as Array<{ outcome: string }>)[0]?.outcome).toBe('written');
  await releaseLease(domain, generation);
  return generation;
}

async function uninstall(input: {
  domain: string;
  shopId: string;
  merchantAccountId: string;
  clientId?: string;
}): Promise<DestructiveVerdict> {
  const { data, error } = await service().rpc('uninstall_shopify_shop_fenced', {
    p_shop_domain: input.domain,
    p_shop_id: input.shopId,
    p_merchant_account_id: input.merchantAccountId,
    p_client_id: input.clientId ?? APP_X,
    p_ttl_seconds: TTL,
  });
  if (error) throw new Error(`uninstall failed: ${error.code} ${error.message}`);
  const rows = data as DestructiveVerdict[];
  expect(rows).toHaveLength(1);
  return rows[0] as DestructiveVerdict;
}

async function disconnect(
  userId: string,
  merchantAccountId: string,
  shopId: string,
): Promise<DestructiveVerdict> {
  const { data, error } = await service().rpc('disconnect_shop_fenced', {
    p_user_id: userId,
    p_merchant_account_id: merchantAccountId,
    p_shop_id: shopId,
    p_ttl_seconds: TTL,
  });
  if (error) throw new Error(`disconnect failed: ${error.code} ${error.message}`);
  const rows = data as DestructiveVerdict[];
  expect(rows).toHaveLength(1);
  return rows[0] as DestructiveVerdict;
}

async function release(userId: string, shopId: string, oldClientId: string) {
  const { data, error } = await service().rpc('release_shopify_shop_app_identity_fenced', {
    p_user_id: userId,
    p_shop_id: shopId,
    p_old_client_id: oldClientId,
    p_ttl_seconds: TTL,
  });
  if (error) throw new Error(`release failed: ${error.code} ${error.message}`);
  const rows = data as Array<{ outcome: string; generation: number | null }>;
  expect(rows).toHaveLength(1);
  return rows[0] as { outcome: string; generation: number | null };
}

async function link(input: {
  tenant: Tenant;
  domain: string;
  generation: number;
  clientId?: string;
}): Promise<string> {
  const { data, error } = await service().rpc('link_shopify_embedded_shop_fenced', {
    p_user_id: input.tenant.userId,
    p_merchant_account_id: input.tenant.merchantAccountId,
    p_shop_domain: input.domain,
    p_client_id: input.clientId ?? APP_X,
    p_generation: input.generation,
  });
  if (error) throw new Error(`link failed: ${error.code} ${error.message}`);
  return data as string;
}

async function markConnectionUninstalled(
  domain: string,
  generation: number,
  merchantAccountId: string,
) {
  const { data, error } = await service().rpc('mark_shopify_store_connection_uninstalled_fenced', {
    p_shop_domain: domain,
    p_generation: generation,
    p_merchant_account_id: merchantAccountId,
  });
  if (error) throw new Error(`mark connection failed: ${error.code} ${error.message}`);
  const rows = data as Array<{ outcome: string; connection_id: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0] as { outcome: string; connection_id: string | null };
}

async function persistAuthorizationCode(domain: string, generation: number, tenant: Tenant) {
  const { data, error } = await service().rpc('persist_shopify_credentials_fenced', {
    p_mode: 'authorization_code',
    p_shop_domain: domain,
    p_generation: generation,
    p_merchant_account_id: tenant.merchantAccountId,
    p_client_id: APP_X,
    p_access_token_encrypted: 'late-access',
    p_refresh_token_encrypted: 'late-refresh',
    p_access_token_expires_at: '2031-01-01T00:00:00+00:00',
    p_refresh_token_expires_at: '2031-06-01T00:00:00+00:00',
    p_scopes: 'late_scope',
  });
  if (error) throw new Error(`persist failed: ${error.code} ${error.message}`);
  return (data as Array<{ outcome: string }>)[0]?.outcome;
}

async function beginAsServiceRole(client: TestPostgresClient) {
  await client.query('begin');
  await client.query('set local role service_role');
}

async function isStillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([promise.then(() => null), sleep(ms).then(() => marker)]);
  return winner === marker;
}

beforeAll(async () => {
  if (!hasStack) return;
  tenantA = await createTenant('lease-closure-a');
  tenantB = await createTenant('lease-closure-b');
}, 60_000);

afterEach(async () => {
  if (!hasStack || createdDomains.length === 0) return;
  const admin = service();
  await admin.from('store_connection').delete().in('external_identifier', createdDomains);
  await admin.from('shop').delete().in('shop_domain', createdDomains);
  // service_role n'a volontairement pas DELETE sur la table de bail (0158).
  const pg = await pgConnect();
  await pg.query('delete from public.shopify_token_lease where shop_domain = any($1)', [
    createdDomains,
  ]);
  createdDomains.length = 0;
});

afterAll(async () => {
  await Promise.all(pgClients.map((client) => client.end().catch(() => undefined)));
  if (!hasStack) return;
  const admin = service();
  await Promise.all(createdUserIds.map((userId) => admin.auth.admin.deleteUser(userId)));
});

describe('SCHEMA-LEASE-CLOSURE-01 — préemption destructive', () => {
  it.skipIf(!hasStack)(
    'preuve 1 — la désinstallation préempte un bail TENU : la génération s’incrémente, l’ancien détenteur est périmé',
    async () => {
      const domain = freshDomain('p1');
      const shop = await seedShop(domain, tenantA.merchantAccountId);
      const held = await acquireOne(domain, TTL);

      const verdict = await uninstall({
        domain,
        shopId: shop.id,
        merchantAccountId: tenantA.merchantAccountId,
      });
      expect(verdict).toEqual({ outcome: 'uninstalled', shop_id: shop.id, generation: held + 1 });

      const lease = await leaseRow(domain);
      expect(lease?.generation).toBe(held + 1);
      expect(lease?.lease_expires_at).not.toBeNull();

      // L'ancien détenteur ne peut plus renouveler.
      const { data: renewed, error } = await service().rpc('renew_shopify_token_lease', {
        p_shop_domain: domain,
        p_generation: held,
        p_ttl_seconds: TTL,
      });
      expect(error).toBeNull();
      expect(renewed).toEqual([]);
    },
  );

  it.skipIf(!hasStack)(
    'preuve 2 — après préemption, l’ancien détenteur n’écrit RIEN, colonne par colonne',
    async () => {
      const domain = freshDomain('p2');
      const shop = await seedShop(domain, tenantA.merchantAccountId);
      await seedConnection(domain, tenantA.merchantAccountId);
      const held = await acquireOne(domain, TTL);

      const verdict = await uninstall({
        domain,
        shopId: shop.id,
        merchantAccountId: tenantA.merchantAccountId,
      });
      expect(verdict.outcome).toBe('uninstalled');
      const shopAfterUninstall = await shopRow(domain);
      const connectionBefore = await connectionRow(domain);

      // authorization_code est le mode qui RANIMERAIT la boutique s'il passait.
      expect(await persistAuthorizationCode(domain, held, tenantA)).toBe('lease_lost');
      const { data: connectionVerdict } = await service().rpc(
        'write_shopify_store_connection_fenced',
        {
          p_shop_domain: domain,
          p_generation: held,
          p_merchant_account_id: tenantA.merchantAccountId,
          p_client_id: APP_X,
        },
      );
      expect((connectionVerdict as Array<{ outcome: string }>)[0]?.outcome).toBe('lease_lost');
      expect(await markConnectionUninstalled(domain, held, tenantA.merchantAccountId)).toEqual({
        outcome: 'lease_lost',
        connection_id: null,
      });
      expect(await link({ tenant: tenantA, domain, generation: held })).toBe('lease_lost');

      expect(await shopRow(domain)).toEqual(shopAfterUninstall);
      expect(await connectionRow(domain)).toEqual(connectionBefore);
      expect(shopAfterUninstall).toMatchObject({
        status: 'uninstalled',
        access_token_encrypted: null,
        refresh_token_encrypted: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
      });
    },
  );

  it.skipIf(!hasStack)('preuve 3a — un refus ne fait jamais bouger la génération', async () => {
    const domain = freshDomain('p3a');
    const shop = await seedShop(domain, tenantA.merchantAccountId);
    const generation = await acquireOne(domain, TTL);
    await releaseLease(domain, generation);
    const before = await leaseRow(domain);

    expect(
      (
        await uninstall({
          domain,
          shopId: shop.id,
          merchantAccountId: tenantB.merchantAccountId,
        })
      ).outcome,
    ).toBe('ownership_refused');
    expect(
      (
        await uninstall({
          domain,
          shopId: shop.id,
          merchantAccountId: tenantA.merchantAccountId,
          clientId: APP_Y,
        })
      ).outcome,
    ).toBe('app_identity_mismatch');
    expect((await disconnect(tenantB.userId, tenantB.merchantAccountId, shop.id)).outcome).toBe(
      'ownership_refused',
    );
    expect((await release(tenantA.userId, shop.id, APP_X)).outcome).toBe('state_changed');

    expect(await leaseRow(domain)).toEqual(before);
  });

  it.skipIf(!hasStack)(
    'preuve 3b — préemption et écriture sont indissociables : un échec de l’écriture annule l’incrément',
    async () => {
      const domain = freshDomain('p3b');
      const shop = await seedShop(domain, tenantA.merchantAccountId);
      const generation = await acquireOne(domain, TTL);
      await releaseLease(domain, generation);
      const leaseBefore = await leaseRow(domain);
      const shopBefore = await shopRow(domain);

      // Panne injectée APRÈS l'incrément : un déclencheur fait échouer la seule mise à jour de
      // `shop` que la primitive émet. Déclencheur créé et détruit dans la MÊME transaction : il
      // n'est jamais visible d'une autre connexion.
      const pg = await pgConnect();
      await pg.query('begin');
      let injectedError = '';
      try {
        await pg.query(`
          create function public.lease_closure_01_injected_failure() returns trigger
          language plpgsql as $f$ begin raise exception 'lease_closure_01_injected'; end $f$`);
        await pg.query(
          `create trigger lease_closure_01_injected_failure before update on public.shop
           for each row when (new.shop_domain = '${domain}')
           execute function public.lease_closure_01_injected_failure()`,
        );
        await pg.query('savepoint before_rpc');
        await pg.query('set local role service_role');
        try {
          await pg.query('select * from public.uninstall_shopify_shop_fenced($1, $2, $3, $4, $5)', [
            domain,
            shop.id,
            tenantA.merchantAccountId,
            APP_X,
            TTL,
          ]);
        } catch (error) {
          injectedError = (error as Error).message;
        }
        await pg.query('rollback to savepoint before_rpc');
        const { rows } = await pg.query<{ generation: string; lease_expires_at: Date | null }>(
          'select generation, lease_expires_at from public.shopify_token_lease where shop_domain = $1',
          [domain],
        );
        expect(Number(rows[0]?.generation)).toBe(leaseBefore?.generation);
        expect(rows[0]?.lease_expires_at).toBeNull();
      } finally {
        await pg.query('rollback');
      }
      expect(injectedError).toContain('lease_closure_01_injected');
      expect(await leaseRow(domain)).toEqual(leaseBefore);
      expect(await shopRow(domain)).toEqual(shopBefore);

      // Témoin : sans panne, la même primitive incrémente ET écrit.
      const verdict = await uninstall({
        domain,
        shopId: shop.id,
        merchantAccountId: tenantA.merchantAccountId,
      });
      expect(verdict.generation).toBe(generation + 1);
      expect((await shopRow(domain))?.status).toBe('uninstalled');
    },
  );

  it.skipIf(!hasStack)(
    'preuve 4 — deux désinstallations concurrentes : une seule aboutit, génération incrémentée une fois',
    async () => {
      const domain = freshDomain('p4');
      const shop = await seedShop(domain, tenantA.merchantAccountId);
      const generation = await acquireOne(domain, TTL);
      await releaseLease(domain, generation);

      const first = await pgConnect();
      const second = await pgConnect();
      await beginAsServiceRole(first);
      await beginAsServiceRole(second);
      const args = [domain, shop.id, tenantA.merchantAccountId, APP_X, TTL];
      const sql = 'select * from public.uninstall_shopify_shop_fenced($1, $2, $3, $4, $5)';

      const winner = await first.query(sql, args);
      const loserPromise = second.query(sql, args);
      expect(await isStillPending(loserPromise, 500)).toBe(true);
      await first.query('commit');
      const loser = await loserPromise;
      await second.query('commit');

      expect(winner.rows).toHaveLength(1);
      expect(winner.rows[0]).toMatchObject({ outcome: 'uninstalled' });
      expect(Number(winner.rows[0]?.generation)).toBe(generation + 1);
      expect(loser.rows).toEqual([
        { outcome: 'already_uninstalled', shop_id: shop.id, generation: null },
      ]);
      expect((await leaseRow(domain))?.generation).toBe(generation + 1);
      expect(await shopRow(domain)).toMatchObject({
        status: 'uninstalled',
        access_token_encrypted: null,
        refresh_token_encrypted: null,
      });
    },
  );

  it.skipIf(!hasStack)(
    'preuve 5 — désinstallation concurrente d’une acquisition : l’acquisition perd et n’écrit rien',
    async () => {
      const domain = freshDomain('p5');
      const shop = await seedShop(domain, tenantA.merchantAccountId);
      const acquired = await acquireOne(domain, TTL);

      // La désinstallation tient le verrou de bail ; l'écriture de l'acquéreur arrive pendant.
      const destructive = await pgConnect();
      await beginAsServiceRole(destructive);
      const { rows } = await destructive.query(
        'select * from public.uninstall_shopify_shop_fenced($1, $2, $3, $4, $5)',
        [domain, shop.id, tenantA.merchantAccountId, APP_X, TTL],
      );
      expect(rows[0]).toMatchObject({ outcome: 'uninstalled' });

      const persistPromise = persistAuthorizationCode(domain, acquired, tenantA);
      expect(await isStillPending(persistPromise, 500)).toBe(true);
      await destructive.query('commit');

      expect(await persistPromise).toBe('lease_lost');
      expect(await shopRow(domain)).toMatchObject({
        status: 'uninstalled',
        access_token_encrypted: null,
        refresh_token_encrypted: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scopes: 'seed_scope',
      });
    },
  );

  it.skipIf(!hasStack)(
    'désinstallation : boutique sans app rattachée (NULL) acceptée, écriture fencée de store_connection',
    async () => {
      const domain = freshDomain('null-app');
      const shop = await seedShop(domain, tenantA.merchantAccountId);
      await seedConnection(domain, tenantA.merchantAccountId);
      await service().from('shop').update({ shopify_client_id: null }).eq('id', shop.id);

      const verdict = await uninstall({
        domain,
        shopId: shop.id,
        merchantAccountId: tenantA.merchantAccountId,
        clientId: APP_Y,
      });
      expect(verdict.outcome).toBe('uninstalled');
      const generation = Number(verdict.generation);

      expect(
        await markConnectionUninstalled(domain, generation, tenantB.merchantAccountId),
      ).toEqual({ outcome: 'ownership_refused', connection_id: null });
      expect((await connectionRow(domain))?.status).toBe('active');
      const written = await markConnectionUninstalled(
        domain,
        generation,
        tenantA.merchantAccountId,
      );
      expect(written.outcome).toBe('written');
      expect(await connectionRow(domain)).toMatchObject({ status: 'uninstalled' });
    },
  );
});

describe('SCHEMA-LEASE-CLOSURE-01 — rattachement embarqué sous bail', () => {
  it.skipIf(!hasStack)(
    'preuve 6 — génération périmée ou bail libéré : lease_lost, zéro ligne créée ou modifiée',
    async () => {
      const newDomain = freshDomain('p6-new');
      const stale = await acquireOne(newDomain, 1);
      await sleep(1_200);
      const current = await acquireOne(newDomain, TTL);
      expect(current).not.toBe(stale);
      expect(await link({ tenant: tenantA, domain: newDomain, generation: stale })).toBe(
        'lease_lost',
      );
      expect(await shopRow(newDomain)).toBeNull();

      // Ligne existante, libérée (client_id NULL) : une écriture tardive ne la rattache pas.
      const existingDomain = freshDomain('p6-existing');
      await seedShop(existingDomain, tenantA.merchantAccountId, {
        shopify_client_id: null,
        status: 'uninstalled',
        access_token_encrypted: null,
      });
      const before = await shopRow(existingDomain);
      const generation = await acquireOne(existingDomain, TTL);
      await releaseLease(existingDomain, generation);
      // Génération courante mais bail LIBÉRÉ : toujours refusé.
      expect(await link({ tenant: tenantA, domain: existingDomain, generation })).toBe(
        'lease_lost',
      );
      expect(
        await link({ tenant: tenantA, domain: existingDomain, generation: generation - 1 }),
      ).toBe('lease_lost');
      expect(await shopRow(existingDomain)).toEqual(before);
    },
  );

  it.skipIf(!hasStack)(
    'preuve 7 — génération courante : insertion puis mise à jour, gardes de 0155 conservées',
    async () => {
      const domain = freshDomain('p7');
      const generation = await acquireOne(domain, TTL);
      expect(await link({ tenant: tenantA, domain, generation })).toBe('inserted');
      expect(await shopRow(domain)).toMatchObject({
        merchant_account_id: tenantA.merchantAccountId,
        shopify_client_id: APP_X,
        status: 'active',
        access_token_encrypted: null,
      });

      expect(await link({ tenant: tenantA, domain, generation })).toBe('updated');
      expect(await link({ tenant: tenantA, domain, generation, clientId: APP_Y })).toBe(
        'app_switch_refused',
      );
      expect(await link({ tenant: tenantB, domain, generation })).toBe('ownership_refused');
      expect(await link({ tenant: tenantA, domain: domain.toUpperCase(), generation })).toBe(
        'intent_invalid',
      );
    },
  );
});

describe('SCHEMA-LEASE-CLOSURE-01 — propriété et déconnexion', () => {
  it.skipIf(!hasStack)(
    'preuve 8 — locataire différent : zéro écriture, refus nommé, sur les trois primitives destructives',
    async () => {
      const domain = freshDomain('p8');
      const shop = await seedShop(domain, tenantA.merchantAccountId);
      const before = await shopRow(domain);

      expect(
        await uninstall({ domain, shopId: shop.id, merchantAccountId: tenantB.merchantAccountId }),
      ).toEqual({ outcome: 'ownership_refused', shop_id: null, generation: null });
      expect(
        (
          await uninstall({
            domain,
            shopId: crypto.randomUUID(),
            merchantAccountId: tenantA.merchantAccountId,
          })
        ).outcome,
      ).toBe('ownership_refused');
      expect(await disconnect(tenantB.userId, tenantB.merchantAccountId, shop.id)).toEqual({
        outcome: 'ownership_refused',
        shop_id: null,
        generation: null,
      });
      // Un utilisateur qui se réclame d'un locataire dont il n'est pas membre.
      expect((await disconnect(tenantB.userId, tenantA.merchantAccountId, shop.id)).outcome).toBe(
        'not_a_member',
      );

      await service().from('shop').update({ status: 'uninstalled' }).eq('id', shop.id);
      const uninstalledBefore = await shopRow(domain);
      expect((await release(tenantB.userId, shop.id, APP_X)).outcome).toBe('not_a_member');
      expect(await shopRow(domain)).toEqual(uninstalledBefore);

      await service().from('shop').update({ status: 'active' }).eq('id', shop.id);
      expect(await shopRow(domain)).toMatchObject({
        shopify_client_id: before?.shopify_client_id,
        access_token_encrypted: before?.access_token_encrypted,
        refresh_token_encrypted: before?.refresh_token_encrypted,
        access_token_expires_at: before?.access_token_expires_at,
        refresh_token_expires_at: before?.refresh_token_expires_at,
        scopes: before?.scopes,
        uninstalled_at: before?.uninstalled_at,
      });
      expect(await leaseRow(domain)).toEqual({
        shop_domain: domain,
        generation: 0,
        lease_expires_at: null,
      });
    },
  );

  it.skipIf(!hasStack)(
    'preuve 9 — la déconnexion EFFACE réellement les credentials, pas seulement le statut',
    async () => {
      const domain = freshDomain('p9');
      const shop = await seedShop(domain, tenantA.merchantAccountId);
      const held = await acquireOne(domain, TTL);

      const verdict = await disconnect(tenantA.userId, tenantA.merchantAccountId, shop.id);
      expect(verdict).toEqual({ outcome: 'disconnected', shop_id: shop.id, generation: held + 1 });
      expect(await shopRow(domain)).toMatchObject({
        status: 'uninstalled',
        access_token_encrypted: null,
        refresh_token_encrypted: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        shopify_client_id: APP_X,
        uninstalled_at: null,
      });
      expect(await persistAuthorizationCode(domain, held, tenantA)).toBe('lease_lost');
      expect((await disconnect(tenantA.userId, tenantA.merchantAccountId, shop.id)).outcome).toBe(
        'already_disconnected',
      );
    },
  );

  it.skipIf(!hasStack)(
    'déconnexion d’une boutique non Shopify : écrite sans bail, génération NULL, aucune ligne de bail',
    async () => {
      const domain = `manual-closure-${crypto.randomUUID().replaceAll('-', '')}.internal`;
      createdDomains.push(domain);
      const shop = await seedShop(domain, tenantA.merchantAccountId, {
        shopify_client_id: null,
        access_token_encrypted: null,
        refresh_token_encrypted: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        store_kind: 'manual',
      });
      expect(await disconnect(tenantA.userId, tenantA.merchantAccountId, shop.id)).toEqual({
        outcome: 'disconnected',
        shop_id: shop.id,
        generation: null,
      });
      expect((await shopRow(domain))?.status).toBe('uninstalled');
      expect(await leaseRow(domain)).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'libération d’identité : gardes de 0155, puis préemption avant la remise à NULL',
    async () => {
      const domain = freshDomain('release');
      const shop = await seedShop(domain, tenantA.merchantAccountId, {
        status: 'uninstalled',
        access_token_encrypted: null,
        refresh_token_encrypted: null,
      });
      const held = await acquireOne(domain, TTL);

      expect((await release(tenantA.userId, shop.id, APP_Y)).outcome).toBe('state_changed');
      expect(await release(tenantA.userId, shop.id, APP_X)).toEqual({
        outcome: 'released',
        generation: held + 1,
      });
      expect((await shopRow(domain))?.shopify_client_id).toBeNull();
      expect(await persistAuthorizationCode(domain, held, tenantA)).toBe('lease_lost');
      expect((await release(tenantA.userId, shop.id, APP_X)).outcome).toBe('state_changed');
    },
  );
});

describe('SCHEMA-LEASE-CLOSURE-01 — ACL et additivité, lues au catalogue', () => {
  const NEW_FUNCTIONS = [
    'public.uninstall_shopify_shop_fenced(text, uuid, uuid, text, integer)',
    'public.disconnect_shop_fenced(uuid, uuid, uuid, integer)',
    'public.release_shopify_shop_app_identity_fenced(uuid, uuid, text, integer)',
    'public.link_shopify_embedded_shop_fenced(uuid, uuid, text, text, bigint)',
    'public.mark_shopify_store_connection_uninstalled_fenced(text, bigint, uuid)',
  ];

  it.skipIf(!hasStack)(
    'preuve 10 — nouvelles RPC : security invoker, search_path vide, EXECUTE au seul service_role',
    async () => {
      const pg = await pgConnect();
      for (const signature of NEW_FUNCTIONS) {
        const { rows } = await pg.query(
          `select p.proacl::text as proacl,
                  p.prosecdef,
                  p.proconfig,
                  has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
           from pg_proc p
           where p.oid = $1::regprocedure`,
          [signature],
        );
        expect(rows).toEqual([
          {
            proacl: '{postgres=X/postgres,service_role=X/postgres}',
            prosecdef: false,
            proconfig: ['search_path=""'],
            anon: false,
            authenticated: false,
            service_role: true,
          },
        ]);
      }
    },
  );

  it.skipIf(!hasStack)(
    'additivité — les primitives de 0155 restent, inchangées, et aucun nom n’a de surcharge',
    async () => {
      const pg = await pgConnect();
      const { rows } = await pg.query(
        `select p.proname, count(*)::int as signatures, min(p.proacl::text) as proacl
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
         where p.proname in (
           'link_shopify_embedded_shop', 'release_shopify_shop_app_identity',
           'uninstall_shopify_shop_fenced', 'disconnect_shop_fenced',
           'release_shopify_shop_app_identity_fenced', 'link_shopify_embedded_shop_fenced',
           'mark_shopify_store_connection_uninstalled_fenced'
         )
         group by p.proname
         order by p.proname`,
      );
      const acl = '{postgres=X/postgres,service_role=X/postgres}';
      expect(rows).toEqual(
        [
          'disconnect_shop_fenced',
          'link_shopify_embedded_shop',
          'link_shopify_embedded_shop_fenced',
          'mark_shopify_store_connection_uninstalled_fenced',
          'release_shopify_shop_app_identity',
          'release_shopify_shop_app_identity_fenced',
          'uninstall_shopify_shop_fenced',
        ].map((proname) => ({ proname, signatures: 1, proacl: acl })),
      );
      const { rows: legacy } = await pg.query(
        'select $1::regprocedure::text as a, $2::regprocedure::text as b',
        [
          'public.link_shopify_embedded_shop(uuid, uuid, text, text)',
          'public.release_shopify_shop_app_identity(uuid, uuid, text)',
        ],
      );
      expect(legacy).toHaveLength(1);
    },
  );

  it.skipIf(!hasStack)(
    'preuve 11 — ACL de shop, store_connection et shopify_token_lease : identique au relevé d’avant 0159',
    async () => {
      const pg = await pgConnect();
      const { rows: tables } = await pg.query(
        `select c.relname, c.relacl::text as relacl
         from pg_class c
         where c.oid in ('public.shop'::regclass, 'public.store_connection'::regclass,
                         'public.shopify_token_lease'::regclass)
         order by c.relname`,
      );
      // Relevé au catalogue local à 0158, AVANT application de 0159 (SCHEMA-LEASE-CLOSURE-01).
      expect(tables).toEqual([
        {
          relname: 'shop',
          relacl:
            '{postgres=arwdDxtm/postgres,anon=rdDxtm/postgres,authenticated=rdDxtm/postgres,service_role=arwdDxtm/postgres}',
        },
        {
          relname: 'shopify_token_lease',
          relacl: '{postgres=arwdDxtm/postgres,service_role=r/postgres}',
        },
        {
          relname: 'store_connection',
          relacl:
            '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=r/postgres}',
        },
      ]);

      const { rows: columns } = await pg.query(
        `select c.relname, a.attname, a.attacl::text as attacl
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         where c.oid in ('public.shop'::regclass, 'public.store_connection'::regclass,
                         'public.shopify_token_lease'::regclass)
           and a.attacl is not null
         order by c.relname, a.attname`,
      );
      expect(columns).toEqual([
        {
          relname: 'shopify_token_lease',
          attname: 'acquired_at',
          attacl: '{service_role=aw/postgres}',
        },
        {
          relname: 'shopify_token_lease',
          attname: 'generation',
          attacl: '{service_role=aw/postgres}',
        },
        {
          relname: 'shopify_token_lease',
          attname: 'lease_expires_at',
          attacl: '{service_role=aw/postgres}',
        },
        {
          relname: 'shopify_token_lease',
          attname: 'shop_domain',
          attacl: '{service_role=a/postgres}',
        },
      ]);

      const { rows: policies } = await pg.query(
        `select tablename, policyname, cmd from pg_policies
         where schemaname = 'public'
           and tablename in ('shop', 'store_connection', 'shopify_token_lease')
         order by tablename, policyname`,
      );
      expect(policies).toEqual([
        { tablename: 'shop', policyname: 'shop_delete', cmd: 'DELETE' },
        { tablename: 'shop', policyname: 'shop_insert', cmd: 'INSERT' },
        { tablename: 'shop', policyname: 'shop_select', cmd: 'SELECT' },
        { tablename: 'shop', policyname: 'shop_update', cmd: 'UPDATE' },
        { tablename: 'store_connection', policyname: 'store_connection_select', cmd: 'SELECT' },
      ]);
    },
  );

  it.skipIf(!hasStack || !anonKey)(
    'par PostgREST : un client anon n’atteint aucune des nouvelles RPC',
    async () => {
      const anon = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const rpc = await anon.rpc('uninstall_shopify_shop_fenced', {
        p_shop_domain: 'anon-probe.myshopify.com',
        p_shop_id: crypto.randomUUID(),
        p_merchant_account_id: crypto.randomUUID(),
        p_client_id: 'anon',
        p_ttl_seconds: 60,
      });
      expect(rpc.error?.code).toBe('42501');
    },
  );
});
