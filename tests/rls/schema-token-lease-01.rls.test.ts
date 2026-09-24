// SCHEMA-TOKEN-LEASE-01 — contrat SQL du bail de jeton Shopify par domaine (migration 0158).
//
// Ce qui est exercé : les RPC réelles, appelées par le client réellement utilisé en production
// (supabase-js → PostgREST, rôle service_role), et, pour les courses, deux connexions PostgreSQL
// dont les transactions sont entrelacées à la main sous `set local role service_role` — la seule
// façon de rendre une concurrence DÉTERMINISTE au lieu d'espérer un chevauchement.
//
// Ce qui n'est PAS exercé ici, et relève du lot applicatif : le branchement TypeScript des trois
// chemins (callback, session embarquée, rafraîchissement), donc la preuve 9B — « un seul appel
// Shopify réellement émis ». Ce fichier prouve 9A : un seul détenteur.
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

const APP_X = 'token-lease-01-app-x-sentinel';
const APP_Y = 'token-lease-01-app-y-sentinel';

// Colonnes comparées une à une pour prouver qu'une écriture refusée n'a RIEN modifié : l'union
// des colonnes écrites par les trois chemins, plus l'identité de la ligne.
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

type Verdict = { outcome: string; shop_id: string | null };
type ConnectionVerdict = { outcome: string; connection_id: string | null };

const createdUserIds: string[] = [];
const createdDomains: string[] = [];
const pgClients: TestPostgresClient[] = [];
let tenantA = '';
let tenantB = '';

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

async function createTenant(prefix: string): Promise<string> {
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
  return member.merchant_account_id as string;
}

function freshDomain(label: string): string {
  const domain = `lease-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquire(domain: string, ttlSeconds: number) {
  const { data, error } = await service().rpc('acquire_shopify_token_lease', {
    p_shop_domain: domain,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new Error(`acquire failed: ${error.code} ${error.message}`);
  return data as Array<{ acquired_generation: number; expires_at: string }>;
}

async function acquireOne(domain: string, ttlSeconds: number): Promise<number> {
  const rows = await acquire(domain, ttlSeconds);
  expect(rows).toHaveLength(1);
  return Number(rows[0]?.acquired_generation);
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

type PersistInput = {
  mode: 'authorization_code' | 'token_exchange' | 'refresh';
  domain: string;
  generation: number;
  merchantAccountId: string;
  clientId: string;
  access: string;
  refresh?: string | null;
  accessExpiresAt?: string | null;
  refreshExpiresAt?: string | null;
  scopes?: string | null;
};

async function persist(input: PersistInput): Promise<Verdict> {
  const { data, error } = await service().rpc('persist_shopify_credentials_fenced', {
    p_mode: input.mode,
    p_shop_domain: input.domain,
    p_generation: input.generation,
    p_merchant_account_id: input.merchantAccountId,
    p_client_id: input.clientId,
    p_access_token_encrypted: input.access,
    p_refresh_token_encrypted: input.refresh ?? null,
    p_access_token_expires_at: input.accessExpiresAt ?? null,
    p_refresh_token_expires_at: input.refreshExpiresAt ?? null,
    p_scopes: input.scopes === undefined ? 'read_orders' : input.scopes,
  });
  if (error) throw new Error(`persist failed: ${error.code} ${error.message}`);
  const rows = data as Verdict[];
  expect(rows).toHaveLength(1);
  return rows[0] as Verdict;
}

async function writeConnection(
  domain: string,
  generation: number,
  merchantAccountId: string,
  clientId: string,
): Promise<ConnectionVerdict> {
  const { data, error } = await service().rpc('write_shopify_store_connection_fenced', {
    p_shop_domain: domain,
    p_generation: generation,
    p_merchant_account_id: merchantAccountId,
    p_client_id: clientId,
  });
  if (error) throw new Error(`store_connection write failed: ${error.code} ${error.message}`);
  const rows = data as ConnectionVerdict[];
  expect(rows).toHaveLength(1);
  return rows[0] as ConnectionVerdict;
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
  overrides: Partial<ShopRow> = {},
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

// Rend un bail tenu par un détenteur PÉRIMÉ : A acquiert avec un TTL d'une seconde, l'échéance
// passe réellement (aucune manipulation d'horloge), B reprend. Renvoie les deux générations.
async function staleHolderPair(domain: string) {
  const generationA = await acquireOne(domain, 1);
  await sleep(1_200);
  const generationB = await acquireOne(domain, 60);
  expect(generationB).not.toBe(generationA);
  return { generationA, generationB };
}

beforeAll(async () => {
  if (!hasStack) return;
  tenantA = await createTenant('token-lease-a');
  tenantB = await createTenant('token-lease-b');
}, 60_000);

afterEach(async () => {
  if (!hasStack || createdDomains.length === 0) return;
  const admin = service();
  await admin.from('store_connection').delete().in('external_identifier', createdDomains);
  await admin.from('shop').delete().in('shop_domain', createdDomains);
  // service_role n'a volontairement pas DELETE sur la table de bail : le nettoyage passe par
  // la connexion d'administration du stack de test.
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

// Démarre une transaction sous le rôle réellement utilisé par l'application.
async function beginAsServiceRole(client: TestPostgresClient) {
  await client.query('begin');
  await client.query('set local role service_role');
}

// Vrai si la promesse est toujours en attente après `ms` : c'est la preuve que la seconde
// transaction est BLOQUÉE par la première, donc que la course a réellement lieu.
async function isStillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([promise.then(() => null), sleep(ms).then(() => marker)]);
  return winner === marker;
}

describe('SCHEMA-TOKEN-LEASE-01 — acquisition, reprise, renouvellement, libération', () => {
  it.skipIf(!hasStack)(
    'preuve 1 — deux acquisitions concurrentes sur la même boutique : un gagnant, l’autre à zéro ligne, sans erreur',
    async () => {
      const domain = freshDomain('p1');
      // Bail existant et libre : la course porte sur le `do update … where` d'une ligne présente.
      const initial = await acquireOne(domain, 60);
      const released = await service()
        .from('shopify_token_lease')
        .update({ lease_expires_at: null })
        .eq('shop_domain', domain)
        .eq('generation', initial)
        .not('lease_expires_at', 'is', null)
        .select('generation');
      expect(released.error).toBeNull();
      expect(released.data).toHaveLength(1);

      const first = await pgConnect();
      const second = await pgConnect();
      await beginAsServiceRole(first);
      await beginAsServiceRole(second);

      const winner = await first.query('select * from public.acquire_shopify_token_lease($1, 60)', [
        domain,
      ]);
      const loserPromise = second.query(
        'select * from public.acquire_shopify_token_lease($1, 60)',
        [domain],
      );
      expect(await isStillPending(loserPromise, 400)).toBe(true);
      await first.query('commit');
      const loser = await loserPromise;
      await second.query('commit');

      expect(winner.rowCount).toBe(1);
      expect(Number(winner.rows[0].acquired_generation)).toBe(initial + 1);
      expect(loser.rowCount).toBe(0);

      // Même propriété par le client de production, sans entrelacement forcé : dix appels
      // simultanés, exactement un gagnant, aucune erreur.
      const burstDomain = freshDomain('p1-burst');
      const results = await Promise.all(Array.from({ length: 10 }, () => acquire(burstDomain, 60)));
      expect(results.filter((rows) => rows.length === 1)).toHaveLength(1);
      expect(results.filter((rows) => rows.length === 0)).toHaveLength(9);
    },
  );

  it.skipIf(!hasStack)(
    'preuve 9A — deux réclamations concurrentes sur un domaine absent : un seul détenteur, aucun 23505',
    async () => {
      const domain = freshDomain('p9a');
      expect(await leaseRow(domain)).toBeNull();

      const first = await pgConnect();
      const second = await pgConnect();
      await beginAsServiceRole(first);
      await beginAsServiceRole(second);

      const winner = await first.query('select * from public.acquire_shopify_token_lease($1, 60)', [
        domain,
      ]);
      // La seconde insertion attend l'index unique de la première, non validée.
      const loserPromise = second.query(
        'select * from public.acquire_shopify_token_lease($1, 60)',
        [domain],
      );
      expect(await isStillPending(loserPromise, 400)).toBe(true);
      await first.query('commit');
      // Aucune exception : un 23505 rejetterait cette promesse.
      const loser = await loserPromise;
      await second.query('commit');

      expect(winner.rowCount).toBe(1);
      expect(Number(winner.rows[0].acquired_generation)).toBe(1);
      expect(loser.rowCount).toBe(0);
      expect(await leaseRow(domain)).toMatchObject({ generation: 1 });
    },
  );

  it.skipIf(!hasStack)(
    'preuve 2 — deux boutiques différentes : les deux acquisitions réussissent, sans attente mutuelle',
    async () => {
      const domainOne = freshDomain('p2-one');
      const domainTwo = freshDomain('p2-two');
      const first = await pgConnect();
      const second = await pgConnect();
      await beginAsServiceRole(first);
      await beginAsServiceRole(second);

      const one = await first.query('select * from public.acquire_shopify_token_lease($1, 60)', [
        domainOne,
      ]);
      // La première transaction reste ouverte : si la granularité n'était pas le domaine, la
      // seconde attendrait.
      const twoPromise = second.query('select * from public.acquire_shopify_token_lease($1, 60)', [
        domainTwo,
      ]);
      expect(await isStillPending(twoPromise, 400)).toBe(false);
      const two = await twoPromise;
      await first.query('commit');
      await second.query('commit');

      expect(one.rowCount).toBe(1);
      expect(two.rowCount).toBe(1);
    },
  );

  it.skipIf(!hasStack)(
    'preuve 3 — bail expiré : réacquérable, avec une génération différente',
    async () => {
      const domain = freshDomain('p3');
      const firstGeneration = await acquireOne(domain, 1);
      // Tant que le bail court, il n'est pas repris.
      expect(await acquire(domain, 60)).toEqual([]);
      await sleep(1_200);
      const secondGeneration = await acquireOne(domain, 60);
      expect(secondGeneration).toBe(firstGeneration + 1);
    },
  );

  it.skipIf(!hasStack)(
    'preuve 4 — renouvellement : réussit pour le détenteur, zéro ligne pour un autre',
    async () => {
      const domain = freshDomain('p4');
      const [acquired] = await acquire(domain, 5);
      const generation = Number(acquired?.acquired_generation);

      const renewed = await service().rpc('renew_shopify_token_lease', {
        p_shop_domain: domain,
        p_generation: generation,
        p_ttl_seconds: 120,
      });
      expect(renewed.error).toBeNull();
      expect(renewed.data).toHaveLength(1);
      const renewedAt = Date.parse(
        (renewed.data as Array<{ expires_at: string }>)[0]?.expires_at ?? '',
      );
      expect(renewedAt).toBeGreaterThan(Date.parse(acquired?.expires_at ?? ''));

      for (const otherGeneration of [generation + 1, generation - 1]) {
        const refused = await service().rpc('renew_shopify_token_lease', {
          p_shop_domain: domain,
          p_generation: otherGeneration,
          p_ttl_seconds: 120,
        });
        expect(refused.error).toBeNull();
        expect(refused.data).toEqual([]);
      }

      // Un ancien détenteur, après reprise, ne renouvelle pas davantage.
      const staleDomain = freshDomain('p4-stale');
      const { generationA } = await staleHolderPair(staleDomain);
      const staleRenew = await service().rpc('renew_shopify_token_lease', {
        p_shop_domain: staleDomain,
        p_generation: generationA,
        p_ttl_seconds: 120,
      });
      expect(staleRenew.error).toBeNull();
      expect(staleRenew.data).toEqual([]);
    },
  );

  it.skipIf(!hasStack)(
    'preuve 5 — libération par un ancien détenteur : zéro ligne ; par le détenteur courant : une ligne',
    async () => {
      const domain = freshDomain('p5');
      const { generationA, generationB } = await staleHolderPair(domain);

      const staleRelease = await service()
        .from('shopify_token_lease')
        .update({ lease_expires_at: null })
        .eq('shop_domain', domain)
        .eq('generation', generationA)
        .not('lease_expires_at', 'is', null)
        .select('generation');
      expect(staleRelease.error).toBeNull();
      expect(staleRelease.data).toEqual([]);
      const stillHeld = await leaseRow(domain);
      expect(stillHeld?.generation).toBe(generationB);
      expect(stillHeld?.lease_expires_at).not.toBeNull();

      const currentRelease = await service()
        .from('shopify_token_lease')
        .update({ lease_expires_at: null })
        .eq('shop_domain', domain)
        .eq('generation', generationB)
        .not('lease_expires_at', 'is', null)
        .select('generation');
      expect(currentRelease.error).toBeNull();
      expect(currentRelease.data).toHaveLength(1);
      expect((await leaseRow(domain))?.lease_expires_at).toBeNull();
      // Libéré, il est réacquérable immédiatement, avec une génération nouvelle.
      expect(await acquireOne(domain, 60)).toBe(generationB + 1);
    },
  );

  it.skipIf(!hasStack)(
    'entrées non canoniques : domaine hors forme et TTL non positif refusés, jamais normalisés',
    async () => {
      for (const domain of ['Lease-Upper.myshopify.com', ' lease-space.myshopify.com', 'x.com']) {
        const { error } = await service().rpc('acquire_shopify_token_lease', {
          p_shop_domain: domain,
          p_ttl_seconds: 60,
        });
        expect(error?.code).toBe('22023');
      }
      for (const ttl of [0, -5]) {
        const { error } = await service().rpc('acquire_shopify_token_lease', {
          p_shop_domain: freshDomain('ttl'),
          p_ttl_seconds: ttl,
        });
        expect(error?.code).toBe('22023');
      }
    },
  );
});

describe('SCHEMA-TOKEN-LEASE-01 — fencing à l’écriture', () => {
  it.skipIf(!hasStack)(
    'preuve 6 — détenteur périmé : lease_lost sur les trois modes et sur store_connection, aucune colonne modifiée',
    async () => {
      const domain = freshDomain('p6');
      const before = await seedShop(domain, tenantA);
      const { generationA } = await staleHolderPair(domain);

      for (const mode of ['authorization_code', 'token_exchange', 'refresh'] as const) {
        const verdict = await persist({
          mode,
          domain,
          generation: generationA,
          merchantAccountId: tenantA,
          clientId: APP_X,
          access: `stale-${mode}-access`,
          refresh: `stale-${mode}-refresh`,
          accessExpiresAt: '2040-01-01T00:00:00+00:00',
          refreshExpiresAt: '2040-06-01T00:00:00+00:00',
          scopes: 'stale_scope',
        });
        expect(verdict).toEqual({ outcome: 'lease_lost', shop_id: null });
      }
      const connection = await writeConnection(domain, generationA, tenantA, APP_X);
      expect(connection).toEqual({ outcome: 'lease_lost', connection_id: null });

      // Colonne par colonne : l'objet complet, `updated_at` compris.
      expect(await shopRow(domain)).toEqual(before);
      expect(await connectionRow(domain)).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'preuve 6 bis — bail libéré par son détenteur : l’écriture qui suit est refusée',
    async () => {
      const domain = freshDomain('p6-released');
      const before = await seedShop(domain, tenantA);
      const generation = await acquireOne(domain, 60);
      await service()
        .from('shopify_token_lease')
        .update({ lease_expires_at: null })
        .eq('shop_domain', domain)
        .eq('generation', generation);
      const verdict = await persist({
        mode: 'refresh',
        domain,
        generation,
        merchantAccountId: tenantA,
        clientId: APP_X,
        access: 'after-release-access',
      });
      expect(verdict.outcome).toBe('lease_lost');
      expect(await shopRow(domain)).toEqual(before);
    },
  );

  it.skipIf(!hasStack)(
    'preuve 7 — A acquiert, expire ; B acquiert et écrit ; A revient : la paire de B survit',
    async () => {
      // Domaine absent : c'est le chemin de la première installation.
      const domain = freshDomain('p7');
      expect(await shopRow(domain)).toBeNull();

      const generationA = await acquireOne(domain, 1);
      // … A appelle Shopify, et son bail expire pendant l'appel.
      await sleep(1_200);
      const generationB = await acquireOne(domain, 60);

      const writtenByB = await persist({
        mode: 'authorization_code',
        domain,
        generation: generationB,
        merchantAccountId: tenantA,
        clientId: APP_X,
        access: 'pair-B-access',
        refresh: 'pair-B-refresh',
        accessExpiresAt: '2031-01-01T00:00:00+00:00',
        refreshExpiresAt: '2031-06-01T00:00:00+00:00',
        scopes: 'scope_B',
      });
      expect(writtenByB.outcome).toBe('inserted');
      expect((await writeConnection(domain, generationB, tenantA, APP_X)).outcome).toBe('written');
      const afterB = await shopRow(domain);
      const connectionAfterB = await connectionRow(domain);

      // A revient tardivement avec sa propre paire.
      const lateA = await persist({
        mode: 'authorization_code',
        domain,
        generation: generationA,
        merchantAccountId: tenantA,
        clientId: APP_X,
        access: 'pair-A-access',
        refresh: 'pair-A-refresh',
        accessExpiresAt: '2032-01-01T00:00:00+00:00',
        refreshExpiresAt: '2032-06-01T00:00:00+00:00',
        scopes: 'scope_A',
      });
      expect(lateA).toEqual({ outcome: 'lease_lost', shop_id: null });
      expect((await writeConnection(domain, generationA, tenantA, APP_X)).outcome).toBe(
        'lease_lost',
      );

      const final = await shopRow(domain);
      expect(final).toEqual(afterB);
      expect(final).toMatchObject({
        access_token_encrypted: 'pair-B-access',
        refresh_token_encrypted: 'pair-B-refresh',
        scopes: 'scope_B',
        merchant_account_id: tenantA,
        shopify_client_id: APP_X,
      });
      expect(await connectionRow(domain)).toEqual(connectionAfterB);
      // Relecture : un détenteur périmé peut lire la paire du gagnant — rien ne l'en empêche.
      expect(final?.access_token_encrypted).toBe('pair-B-access');
    },
  );
});

describe('SCHEMA-TOKEN-LEASE-01 — gardes de propriété et d’identité d’app dans la RPC', () => {
  it.skipIf(!hasStack)(
    'preuve 10 — bail valide, locataire différent : ownership_refused sur les trois modes et store_connection, zéro écriture',
    async () => {
      const domain = freshDomain('p10');
      const before = await seedShop(domain, tenantA);
      const generation = await acquireOne(domain, 60);

      for (const mode of ['authorization_code', 'token_exchange', 'refresh'] as const) {
        const verdict = await persist({
          mode,
          domain,
          generation,
          merchantAccountId: tenantB,
          clientId: APP_X,
          access: `foreign-${mode}`,
          scopes: 'foreign_scope',
        });
        expect(verdict).toEqual({ outcome: 'ownership_refused', shop_id: null });
      }
      expect(await writeConnection(domain, generation, tenantB, APP_X)).toEqual({
        outcome: 'ownership_refused',
        connection_id: null,
      });
      expect(await shopRow(domain)).toEqual(before);
      expect(await connectionRow(domain)).toBeNull();
    },
  );

  it.skipIf(!hasStack)('store_connection d’un autre locataire : jamais réassignée', async () => {
    const domain = freshDomain('p10-conn');
    const shopA = await seedShop(domain, tenantA);
    const generation = await acquireOne(domain, 60);
    // Connexion orpheline portée par le locataire B sur une boutique de B.
    const pg = await pgConnect();
    const { rows } = await pg.query<{ id: string }>(
      'select id from public.shop where merchant_account_id = $1 and is_default',
      [tenantB],
    );
    const foreignShopId = rows[0]?.id;
    await pg.query(
      `insert into public.store_connection
           (merchant_account_id, shop_id, platform, external_identifier, platform_app_id, status)
         values ($1, $2, 'shopify', $3, 'foreign-app', 'uninstalled')`,
      [tenantB, foreignShopId, domain],
    );
    const before = await connectionRow(domain);
    expect(await writeConnection(domain, generation, tenantA, APP_X)).toEqual({
      outcome: 'ownership_refused',
      connection_id: null,
    });
    expect(await connectionRow(domain)).toEqual(before);
    expect(before?.shop_id).not.toBe(shopA.id);
  });

  it.skipIf(!hasStack)(
    'preuve 11 — bail valide, app différente : refus nommé, zéro écriture',
    async () => {
      const domain = freshDomain('p11');
      const before = await seedShop(domain, tenantA);
      const generation = await acquireOne(domain, 60);

      expect(
        await persist({
          mode: 'authorization_code',
          domain,
          generation,
          merchantAccountId: tenantA,
          clientId: APP_Y,
          access: 'other-app-access',
        }),
      ).toEqual({ outcome: 'app_switch_refused', shop_id: null });
      for (const mode of ['token_exchange', 'refresh'] as const) {
        expect(
          await persist({
            mode,
            domain,
            generation,
            merchantAccountId: tenantA,
            clientId: APP_Y,
            access: `other-app-${mode}`,
          }),
        ).toEqual({ outcome: 'app_identity_mismatch', shop_id: null });
      }
      expect(await writeConnection(domain, generation, tenantA, APP_Y)).toEqual({
        outcome: 'app_identity_mismatch',
        connection_id: null,
      });
      expect(await shopRow(domain)).toEqual(before);

      // App libérée (NULL) : le code d'autorisation l'accueille, l'échange par ID token et le
      // rafraîchissement non — la garde stricte de la session embarquée est conservée.
      const releasedDomain = freshDomain('p11-null');
      const releasedBefore = await seedShop(releasedDomain, tenantA, {
        shopify_client_id: null,
        status: 'uninstalled',
        access_token_encrypted: null,
      });
      const releasedGeneration = await acquireOne(releasedDomain, 60);
      for (const mode of ['token_exchange', 'refresh'] as const) {
        expect(
          (
            await persist({
              mode,
              domain: releasedDomain,
              generation: releasedGeneration,
              merchantAccountId: tenantA,
              clientId: APP_X,
              access: `null-app-${mode}`,
            })
          ).outcome,
        ).toBe('app_identity_mismatch');
      }
      expect(await shopRow(releasedDomain)).toEqual(releasedBefore);
      const relinked = await persist({
        mode: 'authorization_code',
        domain: releasedDomain,
        generation: releasedGeneration,
        merchantAccountId: tenantA,
        clientId: APP_Y,
        access: 'relinked-access',
      });
      expect(relinked).toEqual({ outcome: 'updated', shop_id: releasedBefore.id });
      expect(await shopRow(releasedDomain)).toMatchObject({
        shopify_client_id: APP_Y,
        status: 'active',
        uninstalled_at: null,
      });
    },
  );

  it.skipIf(!hasStack)(
    'preuve 12 — bail valide, même locataire, même app : succès, jeu de colonnes propre à chaque mode',
    async () => {
      const domain = freshDomain('p12');
      const seeded = await seedShop(domain, tenantA, {
        status: 'uninstalled',
        uninstalled_at: '2026-01-01T00:00:00+00:00',
      });
      const generation = await acquireOne(domain, 60);

      // token_exchange : jetons, échéances, scopes, statut ; identité et uninstalled_at intacts.
      expect(
        await persist({
          mode: 'token_exchange',
          domain,
          generation,
          merchantAccountId: tenantA,
          clientId: APP_X,
          access: 'te-access',
          refresh: null,
          scopes: 'te_scope',
        }),
      ).toEqual({ outcome: 'updated', shop_id: seeded.id });
      expect(await shopRow(domain)).toMatchObject({
        access_token_encrypted: 'te-access',
        refresh_token_encrypted: null,
        access_token_expires_at: null,
        scopes: 'te_scope',
        status: 'active',
        shopify_client_id: APP_X,
        uninstalled_at: seeded.uninstalled_at,
      });

      // refresh : un refresh token NULL conserve le précédent ; scopes et statut intacts.
      await service()
        .from('shop')
        .update({
          refresh_token_encrypted: 'kept-refresh',
          refresh_token_expires_at: '2033-01-01T00:00:00+00:00',
        })
        .eq('id', seeded.id);
      expect(
        await persist({
          mode: 'refresh',
          domain,
          generation,
          merchantAccountId: tenantA,
          clientId: APP_X,
          access: 'rf-access',
          refresh: null,
          accessExpiresAt: '2034-01-01T00:00:00+00:00',
          refreshExpiresAt: null,
          scopes: null,
        }),
      ).toEqual({ outcome: 'updated', shop_id: seeded.id });
      expect(await shopRow(domain)).toMatchObject({
        access_token_encrypted: 'rf-access',
        refresh_token_encrypted: 'kept-refresh',
        access_token_expires_at: '2034-01-01T00:00:00+00:00',
        refresh_token_expires_at: '2033-01-01T00:00:00+00:00',
        scopes: 'te_scope',
        status: 'active',
      });

      // authorization_code : jeu complet, uninstalled_at remis à NULL.
      expect(
        await persist({
          mode: 'authorization_code',
          domain,
          generation,
          merchantAccountId: tenantA,
          clientId: APP_X,
          access: 'ac-access',
          refresh: 'ac-refresh',
          scopes: 'ac_scope',
        }),
      ).toEqual({ outcome: 'updated', shop_id: seeded.id });
      expect(await shopRow(domain)).toMatchObject({
        access_token_encrypted: 'ac-access',
        refresh_token_encrypted: 'ac-refresh',
        scopes: 'ac_scope',
        status: 'active',
        uninstalled_at: null,
        merchant_account_id: tenantA,
      });

      expect(await writeConnection(domain, generation, tenantA, APP_X)).toMatchObject({
        outcome: 'written',
      });
      expect(await connectionRow(domain)).toMatchObject({
        merchant_account_id: tenantA,
        shop_id: seeded.id,
        platform_app_id: APP_X,
        status: 'active',
        uninstalled_at: null,
      });

      // Un rafraîchissement ne ranime jamais une boutique désinstallée entre-temps.
      await service().from('shop').update({ status: 'uninstalled' }).eq('id', seeded.id);
      const beforeInactive = await shopRow(domain);
      expect(
        (
          await persist({
            mode: 'refresh',
            domain,
            generation,
            merchantAccountId: tenantA,
            clientId: APP_X,
            access: 'revive-attempt',
          })
        ).outcome,
      ).toBe('shop_inactive');
      expect(await shopRow(domain)).toEqual(beforeInactive);
    },
  );

  it.skipIf(!hasStack)(
    'preuve 13 — ligne absente : insertion pour le seul locataire attendu ; aucun autre mode ne crée de ligne',
    async () => {
      for (const mode of ['token_exchange', 'refresh'] as const) {
        const domain = freshDomain(`p13-${mode.replace('_', '-')}`);
        const generation = await acquireOne(domain, 60);
        expect(
          await persist({
            mode,
            domain,
            generation,
            merchantAccountId: tenantA,
            clientId: APP_X,
            access: `absent-${mode}`,
          }),
        ).toEqual({ outcome: 'shop_not_found', shop_id: null });
        expect(await shopRow(domain)).toBeNull();
        expect(await writeConnection(domain, generation, tenantA, APP_X)).toEqual({
          outcome: 'shop_not_found',
          connection_id: null,
        });
      }

      const domain = freshDomain('p13-insert');
      const generation = await acquireOne(domain, 60);
      const inserted = await persist({
        mode: 'authorization_code',
        domain,
        generation,
        merchantAccountId: tenantB,
        clientId: APP_X,
        access: 'inserted-access',
        scopes: 'inserted_scope',
      });
      expect(inserted.outcome).toBe('inserted');
      expect(await shopRow(domain)).toMatchObject({
        id: inserted.shop_id,
        merchant_account_id: tenantB,
        shopify_client_id: APP_X,
        access_token_encrypted: 'inserted-access',
        status: 'active',
      });
    },
  );

  it.skipIf(!hasStack)('entrée invalide : invalid_input, aucune écriture', async () => {
    const domain = freshDomain('invalid');
    const generation = await acquireOne(domain, 60);
    for (const input of [
      { mode: 'authorization_code' as const, domain: domain.toUpperCase() },
      { mode: 'authorization_code' as const, domain, scopes: null },
      { mode: 'bogus' as unknown as 'refresh', domain },
    ]) {
      const verdict = await persist({
        generation,
        merchantAccountId: tenantA,
        clientId: APP_X,
        access: 'invalid-access',
        ...input,
      });
      expect(verdict).toEqual({ outcome: 'invalid_input', shop_id: null });
    }
    expect(await shopRow(domain)).toBeNull();
  });
});

describe('SCHEMA-TOKEN-LEASE-01 — preuve 8 : ACL lue au catalogue', () => {
  const FUNCTIONS = [
    'public.acquire_shopify_token_lease(text, integer)',
    'public.renew_shopify_token_lease(text, bigint, integer)',
    'public.persist_shopify_credentials_fenced(text, text, bigint, uuid, text, text, text, timestamptz, timestamptz, text)',
    'public.write_shopify_store_connection_fenced(text, bigint, uuid, text)',
  ];

  it.skipIf(!hasStack)(
    'RPC : security invoker, EXECUTE au seul service_role, proacl exact',
    async () => {
      const pg = await pgConnect();
      for (const signature of FUNCTIONS) {
        const { rows } = await pg.query<{
          proacl: string;
          prosecdef: boolean;
          anon: boolean;
          authenticated: boolean;
          service_role: boolean;
          public_role: boolean;
        }>(
          `select p.proacl::text as proacl,
                  p.prosecdef,
                  has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
                  exists (
                    select 1 from aclexplode(p.proacl) a
                    where a.grantee = 0 and a.privilege_type = 'EXECUTE'
                  ) as public_role
           from pg_proc p
           where p.oid = $1::regprocedure`,
          [signature],
        );
        expect(rows).toEqual([
          {
            proacl: '{postgres=X/postgres,service_role=X/postgres}',
            prosecdef: false,
            anon: false,
            authenticated: false,
            service_role: true,
            public_role: false,
          },
        ]);
      }
    },
  );

  it.skipIf(!hasStack)(
    'table de bail : RLS forcée, zéro policy, aucun droit pour anon/authenticated, service_role sans DELETE',
    async () => {
      const pg = await pgConnect();
      const { rows: rel } = await pg.query(
        `select c.relrowsecurity, c.relforcerowsecurity, c.relacl::text as relacl,
                (select count(*)::int from pg_policies p
                  where p.schemaname = 'public' and p.tablename = 'shopify_token_lease') as policies
         from pg_class c where c.oid = 'public.shopify_token_lease'::regclass`,
      );
      expect(rel).toEqual([
        {
          relrowsecurity: true,
          relforcerowsecurity: true,
          relacl: '{postgres=arwdDxtm/postgres,service_role=r/postgres}',
          policies: 0,
        },
      ]);

      const { rows } = await pg.query(
        `select r as role,
                has_table_privilege(r, 'public.shopify_token_lease', 'SELECT') as sel,
                has_any_column_privilege(r, 'public.shopify_token_lease', 'INSERT') as ins,
                has_any_column_privilege(r, 'public.shopify_token_lease', 'UPDATE') as upd,
                has_table_privilege(r, 'public.shopify_token_lease', 'DELETE') as del,
                has_table_privilege(r, 'public.shopify_token_lease', 'TRUNCATE') as trunc,
                has_column_privilege(r, 'public.shopify_token_lease', 'shop_domain', 'UPDATE') as upd_domain
         from unnest(array['anon', 'authenticated', 'service_role']) as r
         order by r`,
      );
      expect(rows).toEqual([
        {
          role: 'anon',
          sel: false,
          ins: false,
          upd: false,
          del: false,
          trunc: false,
          upd_domain: false,
        },
        {
          role: 'authenticated',
          sel: false,
          ins: false,
          upd: false,
          del: false,
          trunc: false,
          upd_domain: false,
        },
        {
          role: 'service_role',
          sel: true,
          ins: true,
          upd: true,
          del: false,
          trunc: false,
          upd_domain: false,
        },
      ]);
    },
  );

  it.skipIf(!hasStack)(
    'shop et store_connection : zéro colonne insérable ou modifiable pour anon et authenticated',
    async () => {
      const pg = await pgConnect();
      const { rows } = await pg.query(
        `select t.rel, r as role,
                count(*) filter (
                  where has_column_privilege(r, t.rel::regclass, a.attname, 'INSERT')
                     or has_column_privilege(r, t.rel::regclass, a.attname, 'UPDATE')
                )::int as writable_columns
         from unnest(array['public.shop', 'public.store_connection']) as t(rel)
         cross join unnest(array['anon', 'authenticated']) as r
         join pg_attribute a on a.attrelid = t.rel::regclass and a.attnum > 0 and not a.attisdropped
         group by t.rel, r
         order by t.rel, r`,
      );
      expect(rows).toEqual([
        { rel: 'public.shop', role: 'anon', writable_columns: 0 },
        { rel: 'public.shop', role: 'authenticated', writable_columns: 0 },
        { rel: 'public.store_connection', role: 'anon', writable_columns: 0 },
        { rel: 'public.store_connection', role: 'authenticated', writable_columns: 0 },
      ]);
    },
  );

  it.skipIf(!hasStack || !anonKey)(
    'par PostgREST : un client anon n’atteint ni la table ni les RPC',
    async () => {
      const anon = createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const table = await anon.from('shopify_token_lease').select('shop_domain');
      expect(table.error?.code).toBe('42501');
      const rpc = await anon.rpc('acquire_shopify_token_lease', {
        p_shop_domain: 'anon-probe.myshopify.com',
        p_ttl_seconds: 60,
      });
      expect(rpc.error?.code).toBe('42501');
    },
  );
});
