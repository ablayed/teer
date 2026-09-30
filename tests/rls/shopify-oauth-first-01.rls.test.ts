// SHOPIFY-OAUTH-FIRST-01 — preuves contre PostgreSQL/PostgREST réels.
//
// Couche : RLS/intégration (stack Supabase locale, `0160` appliquée). Les modules applicatifs
// exercés n'importent pas `lib/env` : ce fichier se charge sans `RESEND_API_KEY`. Aucun appel à
// Shopify : le endpoint de jeton est remplacé, au niveau de `fetch`, par une réponse locale.
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

// Sentinelles observées (R2 : un effet échoué doit rester OBSERVABLE) ; aucun envoi réel.
const sentry = vi.hoisted(() => ({ messages: [] as Array<{ message: string; context: unknown }> }));
vi.mock('@sentry/nextjs', () => ({
  captureMessage: (message: string, context: unknown) => sentry.messages.push({ message, context }),
  captureException: () => undefined,
}));

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const hasStack = Boolean(serviceRoleKey);

const APP = 'oauth-first-01-app-sentinel';
const OTHER_APP = 'oauth-first-01-other-app-sentinel';
// Clé de test générée à l'exécution : aucun littéral à allure de secret dans le dépôt.
const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex');

type Tenant = { userId: string; merchantAccountId: string };

const createdUserIds: string[] = [];
const createdDomains: string[] = [];
const pgClients: TestPostgresClient[] = [];
let tenant: Tenant;
let otherTenant: Tenant;

function service() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Une seule connexion partagée par le fichier : les helpers l'appellent à chaque lecture.
let sharedPg: Promise<TestPostgresClient> | null = null;

async function pgConnect(): Promise<TestPostgresClient> {
  sharedPg ??= (async () => {
    const client = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    pgClients.push(client);
    return client;
  })();
  return sharedPg;
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
  const domain = `oauth-first-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

async function encrypt(value: string) {
  const { encryptToken } = await import('@/lib/shopify/crypto');
  return encryptToken(value);
}

type SeedShop = {
  clientId?: string | null;
  status?: 'active' | 'uninstalled';
  access?: boolean;
  refresh?: boolean;
  accessExpiresInMs?: number | null;
  refreshExpiresInMs?: number | null;
  reauthorizationRequired?: boolean;
  merchantAccountId?: string;
};

async function seedShop(domain: string, seed: SeedShop = {}) {
  const pg = await pgConnect();
  const accessExpiresAt =
    seed.accessExpiresInMs === undefined || seed.accessExpiresInMs === null
      ? null
      : new Date(Date.now() + seed.accessExpiresInMs).toISOString();
  const refreshExpiresAt =
    seed.refreshExpiresInMs === undefined || seed.refreshExpiresInMs === null
      ? null
      : new Date(Date.now() + seed.refreshExpiresInMs).toISOString();
  // Écriture directe en postgres : la fixture pose un état, elle ne rejoue pas un protocole.
  await pg.query(
    `insert into public.shop (merchant_account_id, shop_domain, shopify_client_id,
       access_token_encrypted, refresh_token_encrypted, access_token_expires_at,
       refresh_token_expires_at, scopes, status, store_kind, display_name,
       reauthorization_required_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'read_orders', $8, 'shopify', $2, $9)`,
    [
      seed.merchantAccountId ?? tenant.merchantAccountId,
      domain,
      seed.clientId === undefined ? APP : seed.clientId,
      seed.access === false ? null : await encrypt('seed-access'),
      seed.refresh ? await encrypt('seed-refresh') : null,
      accessExpiresAt,
      refreshExpiresAt,
      seed.status ?? 'active',
      seed.reauthorizationRequired ? new Date().toISOString() : null,
    ],
  );
}

async function classify(domain: string, clientId = APP): Promise<string> {
  const { data, error } = await service().rpc('classify_shopify_entry', {
    p_shop_domain: domain,
    p_client_id: clientId,
  });
  if (error) throw new Error(`classify: ${error.message}`);
  return data as string;
}

// ── Helpers des blocs B2 et suivants ─────────────────────────────────────────────────────────

const APP_CONFIG = {
  clientId: APP,
  clientSecret: 'client-secret-unused-by-stubs',
  distribution: 'public' as const,
};

type StubTokens = {
  accessToken: string;
  refreshToken?: string;
  scope: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
};
type TokenStub = ((args: Record<string, unknown>) => Promise<StubTokens>) & { calls: unknown[] };

// Remplace l'appel réseau Shopify (échange de code) par une réponse locale : AUCUN appel Shopify.
function exchangeStub(label: string, onCall?: () => Promise<void>): TokenStub {
  const calls: unknown[] = [];
  const stub = async (args: Record<string, unknown>) => {
    calls.push(args);
    await onCall?.();
    return {
      accessToken: `${label}-access`,
      refreshToken: `${label}-refresh`,
      scope: 'read_orders,read_customers,read_products',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 90 * 86_400_000),
    };
  };
  return Object.assign(stub, { calls });
}

async function authorizeWithoutSession(
  domain: string,
  options: {
    label?: string;
    syncOk?: boolean;
    onExchange?: () => Promise<void>;
    admin?: ReturnType<typeof service>;
  } = {},
) {
  const { performNoSessionAuthorization } = await import('@/lib/shopify/no-session-authorization');
  const exchange = exchangeStub(options.label ?? 'granted', options.onExchange);
  const result = await performNoSessionAuthorization(
    options.admin ?? service(),
    { shopDomain: domain, app: APP_CONFIG, code: 'authorization-code' },
    {
      exchangeCode: exchange as never,
      syncProducts: async () => options.syncOk ?? true,
    },
  );
  return { result, exchange };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function decryptValue(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  const { decryptToken } = await import('@/lib/shopify/crypto');
  return decryptToken(value);
}

type ShopState = {
  id: string;
  merchant_account_id: string;
  shopify_client_id: string | null;
  status: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  reauthorization_required_at: string | null;
  fingerprint: string;
};

async function shopState(domain: string): Promise<ShopState | undefined> {
  const pg = await pgConnect();
  const { rows } = await pg.query(
    `select id, merchant_account_id, shopify_client_id, status, access_token_encrypted,
            refresh_token_encrypted, reauthorization_required_at,
            md5(concat_ws('|', access_token_encrypted, refresh_token_encrypted,
              access_token_expires_at, refresh_token_expires_at, scopes, shopify_client_id,
              status, reauthorization_required_at, merchant_account_id)) as fingerprint
       from public.shop where shop_domain = $1`,
    [domain],
  );
  return rows[0] as ShopState | undefined;
}

type PendingRow = {
  id: string;
  ticket_hash: string;
  consumed_at: string | null;
  access_token_encrypted: string | null;
};

async function pendingRows(domain: string): Promise<PendingRow[]> {
  const pg = await pgConnect();
  const { rows } = await pg.query(
    `select id, ticket_hash, consumed_at, access_token_encrypted
       from public.shopify_pending_installation where shop_domain = $1 order by created_at`,
    [domain],
  );
  return rows as PendingRow[];
}

async function readPending(ticket: string) {
  const { data, error } = await service().rpc('read_shopify_pending_installation', {
    p_ticket_hash: sha256(ticket),
  });
  if (error) throw new Error(error.message);
  return data?.[0] as { state: string; shop_domain: string | null } | undefined;
}

async function auditCount(merchantAccountId: string, action: string): Promise<number> {
  const pg = await pgConnect();
  const { rows } = await pg.query(
    'select count(*)::int as n from public.audit_log where merchant_account_id = $1 and action = $2',
    [merchantAccountId, action],
  );
  return rows[0].n as number;
}

async function leaseState(domain: string) {
  const pg = await pgConnect();
  const { rows } = await pg.query(
    'select generation::int as generation, lease_expires_at from public.shopify_token_lease where shop_domain = $1',
    [domain],
  );
  return rows[0] as { generation: number; lease_expires_at: string | null } | undefined;
}

async function connectionState(domain: string) {
  const pg = await pgConnect();
  const { rows } = await pg.query(
    `select status, platform_app_id, merchant_account_id from public.store_connection
      where platform = 'shopify' and external_identifier = $1`,
    [domain],
  );
  return rows[0] as
    | { status: string; platform_app_id: string | null; merchant_account_id: string }
    | undefined;
}

async function releaseLeaseDirectly(domain: string) {
  const pg = await pgConnect();
  await pg.query(
    'update public.shopify_token_lease set lease_expires_at = null where shop_domain = $1',
    [domain],
  );
}

// Un autre détenteur reprend le bail (préemption) : toute génération antérieure est périmée.
async function preemptLease(domain: string) {
  const pg = await pgConnect();
  await pg.query(
    `update public.shopify_token_lease
        set generation = generation + 1, lease_expires_at = now() + interval '60 seconds',
            acquired_at = now()
      where shop_domain = $1`,
    [domain],
  );
}

// Client service-role instrumenté : compte les écritures sur `shopify_token_lease` (libérations).
function countingService() {
  const admin = service();
  const releases: unknown[] = [];
  const originalFrom = admin.from.bind(admin);
  (admin as unknown as { from: (table: string) => unknown }).from = (table: string) => {
    const builder = originalFrom(table as never) as unknown as Record<string, unknown>;
    if (table === 'shopify_token_lease') {
      const update = builder.update as (...args: unknown[]) => unknown;
      builder.update = (...args: unknown[]) => {
        releases.push(args[0]);
        return update.apply(builder, args);
      };
    }
    return builder;
  };
  return { admin, releases };
}

beforeAll(async () => {
  if (!hasStack) return;
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY ||= TEST_ENCRYPTION_KEY;
  tenant = await createTenant('oauth-first-01');
  otherTenant = await createTenant('oauth-first-01-other');
}, 60_000);

afterEach(async () => {
  if (!hasStack || createdDomains.length === 0) return;
  const pg = await pgConnect();
  await pg.query('delete from public.store_connection where external_identifier = any($1)', [
    createdDomains,
  ]);
  await pg.query('delete from public.shopify_pending_installation where shop_domain = any($1)', [
    createdDomains,
  ]);
  await pg.query(
    'delete from public.product where shop_id in (select id from public.shop where shop_domain = any($1))',
    [createdDomains],
  );
  await pg.query('delete from public.shop where shop_domain = any($1)', [createdDomains]);
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

describe('B1 — classification D16a contre la base réelle (tableau D12)', () => {
  it.skipIf(!hasStack)(
    'T22a : access non expirant (KOBA) ou non échu → installed_valid',
    async () => {
      const nonExpiring = freshDomain('valid-koba');
      await seedShop(nonExpiring, { accessExpiresInMs: null });
      expect(await classify(nonExpiring)).toBe('installed_valid');

      const fresh = freshDomain('valid-fresh');
      await seedShop(fresh, {
        accessExpiresInMs: 3_600_000,
        refresh: true,
        refreshExpiresInMs: 86_400_000,
      });
      expect(await classify(fresh)).toBe('installed_valid');
    },
  );

  it.skipIf(!hasStack)('T22b : access échu, refresh non échu → installed_refreshable', async () => {
    const domain = freshDomain('refreshable');
    await seedShop(domain, {
      accessExpiresInMs: -60_000,
      refresh: true,
      refreshExpiresInMs: 86_400_000,
    });
    expect(await classify(domain)).toBe('installed_refreshable');
  });

  it.skipIf(!hasStack)(
    'contrôles positifs du grant : absent, désinstallée, déconnectée, réautorisation requise',
    async () => {
      expect(await classify(freshDomain('absent'))).toBe('absent');

      const uninstalled = freshDomain('uninstalled');
      await seedShop(uninstalled, { status: 'uninstalled', access: false });
      expect(await classify(uninstalled)).toBe('uninstalled');

      const disconnected = freshDomain('disconnected');
      await seedShop(disconnected, { access: false });
      expect(await classify(disconnected)).toBe('disconnected');

      const marked = freshDomain('marked');
      await seedShop(marked, { reauthorizationRequired: true });
      expect(await classify(marked)).toBe('reauthorization_required');

      const refreshExpired = freshDomain('refresh-expired');
      await seedShop(refreshExpired, {
        accessExpiresInMs: 3_600_000,
        refresh: true,
        refreshExpiresInMs: -60_000,
      });
      expect(await classify(refreshExpired)).toBe('reauthorization_required');
    },
  );

  it.skipIf(!hasStack)(
    'autre app → other_app ; domaine non canonique → invalid_input',
    async () => {
      const domain = freshDomain('other-app');
      await seedShop(domain, { clientId: OTHER_APP });
      expect(await classify(domain)).toBe('other_app');
      expect(await classify('Upper-Case.myshopify.com')).toBe('invalid_input');
    },
  );
});

describe('B2 — D16b sans session contre la base réelle', () => {
  it.skipIf(!hasStack)(
    'T3 : boutique absente → branche 2 : attente créée, ZÉRO écriture dans shop, bail libéré',
    async () => {
      const domain = freshDomain('t3-absent');
      const { result, exchange } = await authorizeWithoutSession(domain);

      expect(result.kind).toBe('pending');
      expect(exchange.calls).toHaveLength(1);
      expect(await shopState(domain)).toBeUndefined();
      const pending = await pendingRows(domain);
      expect(pending).toHaveLength(1);
      expect(pending[0].consumed_at).toBeNull();
      if (result.kind !== 'pending') throw new Error('attendu : pending');
      // T19 : seule l'empreinte du ticket est en base.
      expect(pending[0].ticket_hash).toBe(sha256(result.ticket));
      expect(JSON.stringify(pending)).not.toContain(result.ticket);
      expect(await readPending(result.ticket)).toMatchObject({
        state: 'valid',
        shop_domain: domain,
      });
      expect((await leaseState(domain))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'T3 : boutique désinstallée du même locataire → branche 2, shop strictement inchangé',
    async () => {
      const domain = freshDomain('t3-uninstalled');
      await seedShop(domain, { status: 'uninstalled', access: false });
      const before = await shopState(domain);

      const { result } = await authorizeWithoutSession(domain);

      expect(result.kind).toBe('pending');
      expect((await shopState(domain))?.fingerprint).toBe(before?.fingerprint);
      expect(await pendingRows(domain)).toHaveLength(1);
    },
  );

  it.skipIf(!hasStack)('T16 : un second callback rend l’ancien ticket inutilisable', async () => {
    const domain = freshDomain('t16');
    const first = await authorizeWithoutSession(domain, { label: 'first' });
    const second = await authorizeWithoutSession(domain, { label: 'second' });
    if (first.result.kind !== 'pending' || second.result.kind !== 'pending') {
      throw new Error('attendu : deux attentes');
    }

    expect(await readPending(first.result.ticket)).toMatchObject({ state: 'invalid' });
    expect(await readPending(second.result.ticket)).toMatchObject({ state: 'valid' });
    expect(await pendingRows(domain)).toHaveLength(1);
  });

  it.skipIf(!hasStack)(
    'T24 / T25 : réautorisation requise → branche 1 : persistance immédiate chez le propriétaire, aucune attente, nouveau refresh token',
    async () => {
      const domain = freshDomain('t24');
      await seedShop(domain, {
        reauthorizationRequired: true,
        accessExpiresInMs: -60_000,
        refresh: true,
        refreshExpiresInMs: 86_400_000,
      });
      const auditsBefore = await auditCount(tenant.merchantAccountId, 'shopify.connected');

      const { result } = await authorizeWithoutSession(domain, { label: 'reauthorized' });

      expect(result).toEqual({ kind: 'arrived', syncPending: false });
      const shop = await shopState(domain);
      expect(shop?.merchant_account_id).toBe(tenant.merchantAccountId);
      expect(shop?.status).toBe('active');
      expect(shop?.reauthorization_required_at).toBeNull();
      expect(await decryptValue(shop?.access_token_encrypted)).toBe('reauthorized-access');
      // T25 : même abandonnée après le callback, la connexion porte le NOUVEAU refresh token.
      expect(await decryptValue(shop?.refresh_token_encrypted)).toBe('reauthorized-refresh');
      expect(await pendingRows(domain)).toHaveLength(0);
      expect(await auditCount(tenant.merchantAccountId, 'shopify.connected')).toBe(
        auditsBefore + 1,
      );
      expect(await connectionState(domain)).toMatchObject({
        status: 'active',
        platform_app_id: APP,
        merchant_account_id: tenant.merchantAccountId,
      });
      expect((await leaseState(domain))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'T29 : la ligne passe en désinstallée entre D16a et D16b → D16b choisit la branche 2',
    async () => {
      const domain = freshDomain('t29');
      await seedShop(domain, { reauthorizationRequired: true });
      expect(await classify(domain)).toBe('reauthorization_required');

      // Désinstallation concurrente, par la primitive réelle, entre la classification et D16b.
      const shop = await shopState(domain);
      const { data, error } = await service().rpc('uninstall_shopify_shop_fenced', {
        p_shop_domain: domain,
        p_shop_id: shop?.id as string,
        p_merchant_account_id: tenant.merchantAccountId,
        p_client_id: APP,
        p_ttl_seconds: 60,
      });
      if (error) throw new Error(error.message);
      expect(data?.[0]?.outcome).toBe('uninstalled');
      await releaseLeaseDirectly(domain);
      const afterUninstall = await shopState(domain);

      const { result } = await authorizeWithoutSession(domain);

      expect(result.kind).toBe('pending');
      const after = await shopState(domain);
      expect(after?.fingerprint).toBe(afterUninstall?.fingerprint);
      expect(after?.status).toBe('uninstalled');
    },
  );

  it.skipIf(!hasStack)(
    'T22c (callback) : boutique déconnectée par disconnect_shop_fenced → classée uninstalled, branche 2, shop inchangé',
    async () => {
      const domain = freshDomain('t22c-callback');
      await seedShop(domain, { accessExpiresInMs: null });
      const shop = await shopState(domain);
      const { data, error } = await service().rpc('disconnect_shop_fenced', {
        p_user_id: tenant.userId,
        p_merchant_account_id: tenant.merchantAccountId,
        p_shop_id: shop?.id as string,
        p_ttl_seconds: 60,
      });
      if (error) throw new Error(error.message);
      expect(data?.[0]?.outcome).toBe('disconnected');
      await releaseLeaseDirectly(domain);
      expect(await classify(domain)).toBe('uninstalled');
      const disconnected = await shopState(domain);

      const { result } = await authorizeWithoutSession(domain);

      expect(result.kind).toBe('pending');
      expect((await shopState(domain))?.fingerprint).toBe(disconnected?.fingerprint);
    },
  );

  it.skipIf(!hasStack)(
    'T37 (cœur) : store_connection refusée et synchronisation échouée → arrivée réussie, sync en attente, bail libéré',
    async () => {
      const domain = freshDomain('t37');
      await seedShop(domain, { reauthorizationRequired: true });
      // Connexion du même domaine appartenant à un autre locataire : l'écriture fencée la refuse.
      const pg = await pgConnect();
      const { rows } = await pg.query(
        'select id from public.shop where merchant_account_id = $1 limit 1',
        [otherTenant.merchantAccountId],
      );
      await pg.query(
        `insert into public.store_connection (merchant_account_id, shop_id, platform,
           external_identifier, platform_app_id, status)
         values ($1, $2, 'shopify', $3, $4, 'active')`,
        [otherTenant.merchantAccountId, rows[0].id, domain, APP],
      );

      const { result } = await authorizeWithoutSession(domain, { label: 't37', syncOk: false });

      expect(result).toEqual({ kind: 'arrived', syncPending: true });
      const shop = await shopState(domain);
      expect(shop?.status).toBe('active');
      expect(await decryptValue(shop?.access_token_encrypted)).toBe('t37-access');
      expect((await leaseState(domain))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'T37 (contrôle positif) : effets réussis → arrivée sans sync en attente',
    async () => {
      const domain = freshDomain('t37-positive');
      await seedShop(domain, { reauthorizationRequired: true });
      const { result } = await authorizeWithoutSession(domain, { syncOk: true });
      expect(result).toEqual({ kind: 'arrived', syncPending: false });
    },
  );

  it.skipIf(!hasStack)(
    'R3 : bail repris pendant l’échange → lease_lost, AUCUNE libération tentée, le bail de l’autre détenteur reste tenu',
    async () => {
      const domain = freshDomain('r3-lost');
      const { admin, releases } = countingService();

      const { result } = await authorizeWithoutSession(domain, {
        admin,
        onExchange: () => preemptLease(domain),
      });

      expect(result).toEqual({ kind: 'error', code: 'connection_in_progress' });
      expect(releases).toEqual([]);
      expect((await leaseState(domain))?.lease_expires_at).not.toBeNull();
      expect(await pendingRows(domain)).toHaveLength(0);
    },
  );

  it.skipIf(!hasStack)(
    'R3 (contrôle positif) : bail conservé → une seule libération, avec la génération acquise',
    async () => {
      const domain = freshDomain('r3-held');
      const { admin, releases } = countingService();
      const { result } = await authorizeWithoutSession(domain, { admin });
      expect(result.kind).toBe('pending');
      expect(releases).toEqual([{ lease_expires_at: null }]);
      expect((await leaseState(domain))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'R3 : une libération avec une génération périmée ne libère pas le bail d’un autre détenteur',
    async () => {
      const domain = freshDomain('r3-stale');
      const lease = await import('@/lib/shopify/token-lease');
      const first = await lease.acquireShopifyTokenLease(service(), domain);
      if (!first.ok) throw new Error('bail non acquis');
      await preemptLease(domain);

      await lease.releaseShopifyTokenLease(service(), domain, first.generation);

      const state = await leaseState(domain);
      expect(state?.generation).toBe(first.generation + 1);
      expect(state?.lease_expires_at).not.toBeNull();

      // Contrôle positif : la génération courante, elle, libère.
      await lease.releaseShopifyTokenLease(service(), domain, first.generation + 1);
      expect((await leaseState(domain))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)('T19 : aucun ticket ni jeton en clair dans les audits', async () => {
    const domain = freshDomain('t19');
    await seedShop(domain, { reauthorizationRequired: true });
    const branchTwo = freshDomain('t19-b2');
    const pending = await authorizeWithoutSession(branchTwo, { label: 't19-pending' });
    await authorizeWithoutSession(domain, { label: 't19-branch1' });
    if (pending.result.kind !== 'pending') throw new Error('attendu : pending');

    const pg = await pgConnect();
    const { rows } = await pg.query(
      `select coalesce(payload::text, '') || coalesce(reason, '') as body
         from public.audit_log where merchant_account_id = $1`,
      [tenant.merchantAccountId],
    );
    const all = rows.map((row: { body: string }) => row.body).join('\n');
    expect(all).not.toContain(pending.result.ticket);
    expect(all).not.toContain('t19-branch1-access');
    expect(all).not.toContain('t19-branch1-refresh');
    expect(all).not.toContain('t19-pending-access');
  });
});

describe('B3 — GET /shopify/claim en lecture seule', () => {
  async function snapshot(domain: string) {
    const pg = await pgConnect();
    const pending = await pg.query(
      `select md5(string_agg(t::text, '|' order by t.id)) as h
         from public.shopify_pending_installation t where t.shop_domain = $1`,
      [domain],
    );
    const lease = await pg.query(
      'select md5(t::text) as h from public.shopify_token_lease t where t.shop_domain = $1',
      [domain],
    );
    const shops = await pg.query(
      'select count(*)::int as n from public.shop where shop_domain = $1',
      [domain],
    );
    const audits = await pg.query(
      'select count(*)::int as n from public.audit_log where merchant_account_id = $1',
      [tenant.merchantAccountId],
    );
    return {
      pending: pending.rows[0].h as string | null,
      lease: lease.rows[0]?.h as string | undefined,
      shops: shops.rows[0].n as number,
      audits: audits.rows[0].n as number,
    };
  }

  async function loadView(ticket: string) {
    const { loadShopifyClaimView, readShopifyPendingInstallation } = await import(
      '@/lib/shopify/claim-view'
    );
    return loadShopifyClaimView({
      readPending: () => readShopifyPendingInstallation(service(), ticket),
      getUserId: async () => tenant.userId,
      getMembership: async () => ({ merchantAccountId: tenant.merchantAccountId, role: 'owner' }),
      getAccountName: async () => 'Espace',
    });
  }

  it.skipIf(!hasStack)(
    'T15 : GET répété ou préchargé (en parallèle) → zéro mutation, ticket toujours valide',
    async () => {
      const domain = freshDomain('t15');
      const { result } = await authorizeWithoutSession(domain);
      if (result.kind !== 'pending') throw new Error('attendu : pending');
      const before = await snapshot(domain);

      const views = await Promise.all(Array.from({ length: 5 }, () => loadView(result.ticket)));
      views.push(await loadView(result.ticket));

      for (const view of views) {
        expect(view).toMatchObject({ kind: 'confirm', shopDomain: domain });
      }
      expect(await snapshot(domain)).toEqual(before);
      expect(await readPending(result.ticket)).toMatchObject({ state: 'valid' });
    },
  );

  it.skipIf(!hasStack)(
    'T15 : une attente expirée est lue invalide, sans être supprimée ni modifiée',
    async () => {
      const domain = freshDomain('t15-expired');
      const { result } = await authorizeWithoutSession(domain);
      if (result.kind !== 'pending') throw new Error('attendu : pending');
      // Recul de l'horodatage : expiration sans attendre 59 minutes (created_at recule aussi,
      // pour respecter la contrainte de fenêtre).
      await (await pgConnect()).query(
        `update public.shopify_pending_installation
            set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
          where shop_domain = $1`,
        [domain],
      );
      const before = await snapshot(domain);

      expect(await loadView(result.ticket)).toEqual({ kind: 'ticket_invalid' });
      expect(await snapshot(domain)).toEqual(before);
      expect(await pendingRows(domain)).toHaveLength(1);
    },
  );
});

describe('B4 — POST de rattachement contre la base réelle', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    sentry.messages.length = 0;
  });

  async function claim(
    ticket: string | undefined,
    options: {
      as?: Tenant;
      userId?: string;
      syncOk?: boolean;
      realSync?: boolean;
      admin?: ReturnType<typeof service>;
    } = {},
  ) {
    const { performShopifyClaim } = await import('@/lib/shopify/claim-core');
    const as = options.as ?? tenant;
    return performShopifyClaim(
      options.admin ?? service(),
      {
        ticket,
        userId: options.userId ?? as.userId,
        merchantAccountId: as.merchantAccountId,
        resolveApp: (clientId) => (clientId === APP ? APP_CONFIG : null),
      },
      options.realSync ? undefined : { syncProducts: async () => options.syncOk ?? true },
    );
  }

  async function pendingTicket(domain: string, label = 'granted'): Promise<string> {
    const { result } = await authorizeWithoutSession(domain, { label });
    if (result.kind !== 'pending') throw new Error(`attendu : pending, reçu ${result.kind}`);
    return result.ticket;
  }

  async function shopCount(domain: string): Promise<number> {
    const { rows } = await (await pgConnect()).query(
      'select count(*)::int as n from public.shop where shop_domain = $1',
      [domain],
    );
    return rows[0].n as number;
  }

  // Agent du locataire : l'utilisateur de test naît propriétaire de son propre espace
  // (`handle_new_user`) ; son appartenance est déplacée vers le locataire, triggers de fixture
  // neutralisés le temps de ces deux écritures (état posé, pas un parcours rejoué).
  async function addAgent(): Promise<string> {
    const agent = await createTenant('oauth-first-01-agent');
    const pg = await pgConnect();
    await pg.query('begin');
    try {
      await pg.query("set local session_replication_role = 'replica'");
      await pg.query('delete from public.merchant_member where user_id = $1', [agent.userId]);
      await pg.query(
        `insert into public.merchant_member (merchant_account_id, user_id, role)
         values ($1, $2, 'agent')`,
        [tenant.merchantAccountId, agent.userId],
      );
      await pg.query('commit');
    } catch (error) {
      await pg.query('rollback');
      throw error;
    }
    return agent.userId;
  }

  // Réseau Shopify remplacé : refresh et GraphQL produits, sans aucun appel réel.
  function mockShopifyNetwork(options: { graphqlStatus?: number; refreshLabel?: string } = {}) {
    const calls = { refresh: 0, graphql: 0 };
    // Identifiants Shopify propres à chaque test : l'index produit est unique par marchand.
    const productId = String(Date.now()) + String(Math.floor(Math.random() * 1000));
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/admin/oauth/access_token')) {
        calls.refresh += 1;
        return new Response(
          JSON.stringify({
            access_token: `${options.refreshLabel ?? 'refreshed'}-access`,
            refresh_token: `${options.refreshLabel ?? 'refreshed'}-refresh`,
            expires_in: 3600,
            refresh_token_expires_in: 7_776_000,
            scope: 'read_orders,read_customers,read_products',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/graphql.json')) {
        calls.graphql += 1;
        if (options.graphqlStatus && options.graphqlStatus !== 200) {
          return new Response('{}', { status: options.graphqlStatus });
        }
        return new Response(
          JSON.stringify({
            data: {
              products: {
                edges: [
                  {
                    cursor: 'c1',
                    node: {
                      id: `gid://shopify/Product/${productId}`,
                      title: 'Produit test',
                      status: 'ACTIVE',
                      variants: {
                        edges: [
                          {
                            node: {
                              id: `gid://shopify/ProductVariant/${productId}`,
                              title: 'Défaut',
                              sku: `SKU-${productId}`,
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    return calls;
  }

  async function productCount(shopId: string): Promise<number> {
    const { rows } = await (await pgConnect()).query(
      'select count(*)::int as n from public.product where shop_id = $1',
      [shopId],
    );
    return rows[0].n as number;
  }

  it.skipIf(!hasStack)(
    'T4 : GET puis POST, boutique neuve → insertion chez le demandeur, ticket consommé, credentials effacés de l’attente',
    async () => {
      const domain = freshDomain('t4');
      const ticket = await pendingTicket(domain, 't4');
      expect(await readPending(ticket)).toMatchObject({ state: 'valid' });
      const auditsBefore = await auditCount(tenant.merchantAccountId, 'shopify.connected');

      const outcome = await claim(ticket);

      expect(outcome).toEqual({ kind: 'connected', syncPending: false });
      const shop = await shopState(domain);
      expect(shop?.merchant_account_id).toBe(tenant.merchantAccountId);
      expect(shop?.status).toBe('active');
      expect(await decryptValue(shop?.access_token_encrypted)).toBe('t4-access');
      const [pending] = await pendingRows(domain);
      expect(pending.consumed_at).not.toBeNull();
      expect(pending.access_token_encrypted).toBeNull();
      expect(await auditCount(tenant.merchantAccountId, 'shopify.connected')).toBe(
        auditsBefore + 1,
      );
      expect(await connectionState(domain)).toMatchObject({
        status: 'active',
        platform_app_id: APP,
      });
      expect((await leaseState(domain))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)('T5 : rejeu du même ticket → refus, rien ne change', async () => {
    const domain = freshDomain('t5');
    const ticket = await pendingTicket(domain, 't5');
    expect(await claim(ticket)).toMatchObject({ kind: 'connected' });
    const shopAfterFirst = await shopState(domain);
    const auditsAfterFirst = await auditCount(tenant.merchantAccountId, 'shopify.connected');

    expect(await claim(ticket)).toEqual({ kind: 'error', code: 'ticket_invalid' });

    expect((await shopState(domain))?.fingerprint).toBe(shopAfterFirst?.fingerprint);
    expect(await auditCount(tenant.merchantAccountId, 'shopify.connected')).toBe(auditsAfterFirst);
  });

  it.skipIf(!hasStack)('T6 : ticket expiré → refus, aucune boutique créée', async () => {
    const domain = freshDomain('t6');
    const ticket = await pendingTicket(domain);
    await (await pgConnect()).query(
      `update public.shopify_pending_installation
          set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        where shop_domain = $1`,
      [domain],
    );

    expect(await claim(ticket)).toEqual({ kind: 'error', code: 'ticket_invalid' });
    expect(await shopCount(domain)).toBe(0);
  });

  it.skipIf(!hasStack)(
    'T7 / T38 (d) : ticket falsifié, absent ou remplacé → refus ; le ticket courant reste valide',
    async () => {
      const domain = freshDomain('t7');
      const superseded = await pendingTicket(domain, 'old');
      const current = await pendingTicket(domain, 'current');

      const forged = randomBytes(32).toString('base64url');
      expect(await claim(forged)).toEqual({ kind: 'error', code: 'ticket_invalid' });
      expect(await claim(undefined)).toEqual({ kind: 'error', code: 'ticket_invalid' });
      expect(await claim(superseded)).toEqual({ kind: 'error', code: 'ticket_invalid' });
      expect(await shopCount(domain)).toBe(0);

      // Garde autoritative, en base : un ticket falsifié ne consomme aucune attente, même porteur
      // de la génération courante du bail.
      const lease = await import('@/lib/shopify/token-lease');
      const acquired = await lease.acquireShopifyTokenLease(service(), domain);
      if (!acquired.ok) throw new Error('bail non acquis');
      const { data: forgedConsume } = await service().rpc('consume_shopify_pending_installation', {
        p_ticket_hash: sha256(forged),
        p_user_id: tenant.userId,
        p_merchant_account_id: tenant.merchantAccountId,
        p_generation: acquired.generation,
      });
      expect(forgedConsume?.[0]?.outcome).toBe('ticket_invalid');
      await lease.releaseShopifyTokenLease(service(), domain, acquired.generation);
      expect(await shopCount(domain)).toBe(0);

      // Contrôle positif : le ticket courant rattache.
      expect(await claim(current)).toMatchObject({ kind: 'connected' });
    },
  );

  it.skipIf(!hasStack)(
    'T8 / T35 : boutique de X, POST par Y → refus générique, X inchangé, audit chez Y seulement',
    async () => {
      const domain = freshDomain('t8');
      await seedShop(domain, { status: 'uninstalled', access: false });
      const ownerBefore = await shopState(domain);
      const ticket = await pendingTicket(domain);
      const ownerConnected = await auditCount(tenant.merchantAccountId, 'shopify.connected');
      const ownerRefused = await auditCount(tenant.merchantAccountId, 'shopify.claim_refused');
      const requesterRefused = await auditCount(
        otherTenant.merchantAccountId,
        'shopify.claim_refused',
      );

      expect(await claim(ticket, { as: otherTenant })).toEqual({ kind: 'error', code: 'refused' });

      expect((await shopState(domain))?.fingerprint).toBe(ownerBefore?.fingerprint);
      expect(await pendingRows(domain)).toHaveLength(0);
      expect(await auditCount(otherTenant.merchantAccountId, 'shopify.claim_refused')).toBe(
        requesterRefused + 1,
      );
      expect(await auditCount(tenant.merchantAccountId, 'shopify.claim_refused')).toBe(
        ownerRefused,
      );
      expect(await auditCount(tenant.merchantAccountId, 'shopify.connected')).toBe(ownerConnected);

      // T35 : l'audit de refus ne désigne pas la boutique du propriétaire.
      const { rows } = await (await pgConnect()).query(
        `select actor_user_id, resource_id, coalesce(payload::text, '') as payload
           from public.audit_log
          where merchant_account_id = $1 and action = 'shopify.claim_refused'
          order by created_at desc limit 1`,
        [otherTenant.merchantAccountId],
      );
      expect(rows[0]).toEqual({
        actor_user_id: otherTenant.userId,
        resource_id: null,
        payload: '',
      });
    },
  );

  it.skipIf(!hasStack)(
    'T10 : un agent du locataire ne consomme pas le ticket (garde SQL D4) ; le ticket reste valide',
    async () => {
      const domain = freshDomain('t10');
      const ticket = await pendingTicket(domain);
      const agentUserId = await addAgent();

      expect(await claim(ticket, { userId: agentUserId })).toEqual({
        kind: 'error',
        code: 'forbidden',
      });
      expect(await shopCount(domain)).toBe(0);
      expect(await readPending(ticket)).toMatchObject({ state: 'valid' });

      // Contrôle positif : le propriétaire du même locataire rattache.
      expect(await claim(ticket)).toMatchObject({ kind: 'connected' });
    },
  );

  it.skipIf(!hasStack)(
    'T14 : même locataire, boutique désinstallée → reconnexion, sans doublon',
    async () => {
      const domain = freshDomain('t14');
      await seedShop(domain, { status: 'uninstalled', access: false });
      const before = await shopState(domain);
      const ticket = await pendingTicket(domain, 't14');

      expect(await claim(ticket)).toEqual({ kind: 'connected', syncPending: false });

      expect(await shopCount(domain)).toBe(1);
      const after = await shopState(domain);
      expect(after?.id).toBe(before?.id);
      expect(after?.status).toBe('active');
      expect(await decryptValue(after?.access_token_encrypted)).toBe('t14-access');
    },
  );

  it.skipIf(!hasStack)(
    'T22c (POST) : boutique déconnectée → le POST du même locataire reconnecte',
    async () => {
      const domain = freshDomain('t22c-post');
      await seedShop(domain, { accessExpiresInMs: null });
      const shop = await shopState(domain);
      const { error } = await service().rpc('disconnect_shop_fenced', {
        p_user_id: tenant.userId,
        p_merchant_account_id: tenant.merchantAccountId,
        p_shop_id: shop?.id as string,
        p_ttl_seconds: 60,
      });
      if (error) throw new Error(error.message);
      await releaseLeaseDirectly(domain);
      const ticket = await pendingTicket(domain, 't22c');
      expect((await shopState(domain))?.status).toBe('uninstalled');

      expect(await claim(ticket)).toMatchObject({ kind: 'connected' });
      const after = await shopState(domain);
      expect(after?.status).toBe('active');
      expect(await decryptValue(after?.access_token_encrypted)).toBe('t22c-access');
    },
  );

  // Reconnexion de la boutique par un autre chemin (persistance fencée directe), APRÈS le callback
  // qui a créé l'attente : l'attente devient périmée.
  async function reconnectByOtherPath(domain: string) {
    const lease = await import('@/lib/shopify/token-lease');
    const acquired = await lease.acquireShopifyTokenLease(service(), domain);
    if (!acquired.ok) throw new Error('bail non acquis');
    const persisted = await lease.persistShopifyCredentialsFenced(service(), {
      mode: 'authorization_code',
      shopDomain: domain,
      generation: acquired.generation,
      merchantAccountId: tenant.merchantAccountId,
      clientId: APP,
      accessTokenEncrypted: await encrypt('other-path-access'),
      refreshTokenEncrypted: await encrypt('other-path-refresh'),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: 'read_orders',
    });
    expect(persisted.outcome).toBe('updated');
    await lease.releaseShopifyTokenLease(service(), domain, acquired.generation);
  }

  it.skipIf(!hasStack)(
    'T34 / D22 : attente périmée, même locataire → already_connected, empreinte de tous les credentials inchangée, aucun audit',
    async () => {
      const domain = freshDomain('t34');
      await seedShop(domain, { status: 'uninstalled', access: false });
      const staleTicket = await pendingTicket(domain, 'stale');
      await reconnectByOtherPath(domain);
      const reconnected = await shopState(domain);
      const audits = await auditCount(tenant.merchantAccountId, 'shopify.connected');

      expect(await claim(staleTicket)).toEqual({ kind: 'already_connected' });

      expect((await shopState(domain))?.fingerprint).toBe(reconnected?.fingerprint);
      expect(await decryptValue((await shopState(domain))?.access_token_encrypted)).toBe(
        'other-path-access',
      );
      expect(await auditCount(tenant.merchantAccountId, 'shopify.connected')).toBe(audits);
      expect(await pendingRows(domain)).toHaveLength(0);
    },
  );

  it.skipIf(!hasStack)(
    'T34 / D22 : attente périmée, autre locataire → refused, boutique inchangée',
    async () => {
      const domain = freshDomain('t34-other');
      await seedShop(domain, { status: 'uninstalled', access: false });
      const staleTicket = await pendingTicket(domain, 'stale');
      await reconnectByOtherPath(domain);
      const reconnected = await shopState(domain);

      expect(await claim(staleTicket, { as: otherTenant })).toEqual({
        kind: 'error',
        code: 'refused',
      });
      expect((await shopState(domain))?.fingerprint).toBe(reconnected?.fingerprint);
    },
  );

  it.skipIf(!hasStack)(
    'T34 (contrôles positifs) : active sans jeton, et app NULL avec jetons → updated',
    async () => {
      const noToken = freshDomain('t34-no-token');
      await seedShop(noToken, { access: false });
      expect(await claim(await pendingTicket(noToken))).toMatchObject({ kind: 'connected' });
      expect((await shopState(noToken))?.shopify_client_id).toBe(APP);

      const nullApp = freshDomain('t34-null-app');
      await seedShop(nullApp, { clientId: null });
      expect(await claim(await pendingTicket(nullApp))).toMatchObject({ kind: 'connected' });
      expect((await shopState(nullApp))?.shopify_client_id).toBe(APP);
    },
  );

  it.skipIf(!hasStack)(
    'T9 / T21 : deux POST concurrents (TS, bail réel) → un seul rattachement, un seul audit, store_connection unique',
    async () => {
      const domain = freshDomain('t9-ts');
      const ticket = await pendingTicket(domain);
      const audits = await auditCount(tenant.merchantAccountId, 'shopify.connected');

      const outcomes = await Promise.all([
        claim(ticket, { admin: service() }),
        claim(ticket, { admin: service() }),
      ]);

      expect(outcomes.filter((outcome) => outcome.kind === 'connected')).toHaveLength(1);
      expect(await auditCount(tenant.merchantAccountId, 'shopify.connected')).toBe(audits + 1);
      expect(await shopCount(domain)).toBe(1);
      const { rows } = await (await pgConnect()).query(
        "select count(*)::int as n from public.store_connection where platform = 'shopify' and external_identifier = $1",
        [domain],
      );
      expect(rows[0].n).toBe(1);
    },
  );

  it.skipIf(!hasStack)(
    'T9 / T21 : deux consommations SQL concurrentes sous la MÊME génération → une seule réussit (relecture sous verrou)',
    async () => {
      const domain = freshDomain('t9-sql');
      const ticket = await pendingTicket(domain);
      const lease = await import('@/lib/shopify/token-lease');
      const acquired = await lease.acquireShopifyTokenLease(service(), domain);
      if (!acquired.ok) throw new Error('bail non acquis');
      const audits = await auditCount(tenant.merchantAccountId, 'shopify.connected');

      const consume = () =>
        service().rpc('consume_shopify_pending_installation', {
          p_ticket_hash: sha256(ticket),
          p_user_id: tenant.userId,
          p_merchant_account_id: tenant.merchantAccountId,
          p_generation: acquired.generation,
        });
      const results = await Promise.all([consume(), consume(), consume()]);

      const outcomes = results.map((result) => result.data?.[0]?.outcome);
      expect(outcomes.filter((outcome) => outcome === 'inserted')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'ticket_invalid')).toHaveLength(2);
      expect(await auditCount(tenant.merchantAccountId, 'shopify.connected')).toBe(audits + 1);
      expect(await shopCount(domain)).toBe(1);
    },
  );

  it.skipIf(!hasStack)(
    'R3 (POST) : bail repris avant la consommation → lease_lost, aucune libération, ticket conservé',
    async () => {
      const domain = freshDomain('r3-post');
      const ticket = await pendingTicket(domain);
      const { admin, releases } = countingService();
      // Un autre détenteur reprend le bail juste avant la transaction de consommation.
      const originalRpc = admin.rpc.bind(admin);
      (admin as unknown as { rpc: (...args: unknown[]) => unknown }).rpc = async (
        ...args: unknown[]
      ) => {
        if (args[0] === 'consume_shopify_pending_installation') await preemptLease(domain);
        return (originalRpc as (...inner: unknown[]) => unknown)(...args);
      };

      expect(await claim(ticket, { admin })).toEqual({
        kind: 'error',
        code: 'connection_in_progress',
      });
      expect(releases).toEqual([]);
      expect((await leaseState(domain))?.lease_expires_at).not.toBeNull();
      expect(await readPending(ticket)).toMatchObject({ state: 'valid' });
    },
  );

  it.skipIf(!hasStack)(
    'T18 : échec de la transaction de consommation → rollback, ticket intact puis utilisable',
    async () => {
      const domain = freshDomain('t18');
      const ticket = await pendingTicket(domain, 't18');
      // Échec injecté APRÈS la persistance, SANS DDL (un verrou de DDL sur une table partagée
      // interbloque les suites parallèles) : un membre `owner` « fantôme », sans utilisateur
      // auth, est posé sur cette seule session (FK suspendues le temps de cette écriture). La
      // consommation passe la garde de rôle, persiste, puis l'audit échoue sur sa FK
      // `actor_user_id` : toute la transaction doit être annulée.
      const ghostUserId = crypto.randomUUID();
      const pg = await pgConnect();
      await pg.query('begin');
      try {
        await pg.query("set local session_replication_role = 'replica'");
        await pg.query(
          `insert into public.merchant_member (merchant_account_id, user_id, role)
           values ($1, $2, 'owner')`,
          [tenant.merchantAccountId, ghostUserId],
        );
        await pg.query('commit');
      } catch (error) {
        await pg.query('rollback');
        throw error;
      }
      try {
        expect(await claim(ticket, { userId: ghostUserId })).toEqual({
          kind: 'error',
          code: 'unknown',
        });
        expect(await shopCount(domain)).toBe(0);
        const [pending] = await pendingRows(domain);
        expect(pending.consumed_at).toBeNull();
        expect(pending.access_token_encrypted).not.toBeNull();
      } finally {
        await pg.query('delete from public.merchant_member where user_id = $1', [ghostUserId]);
      }

      // Le ticket non consommé reste utilisable.
      expect(await claim(ticket)).toMatchObject({ kind: 'connected' });
    },
  );

  it.skipIf(!hasStack)(
    'T17 : access échu et refresh valide → connectée ; la synchronisation rafraîchit APRÈS la libération du bail',
    async () => {
      const domain = freshDomain('t17');
      const ticket = await pendingTicket(domain, 't17');
      await (await pgConnect()).query(
        `update public.shopify_pending_installation
            set access_token_expires_at = now() - interval '1 minute'
          where shop_domain = $1`,
        [domain],
      );
      const network = mockShopifyNetwork({ refreshLabel: 't17-refreshed' });

      const outcome = await claim(ticket, { realSync: true });

      expect(outcome).toEqual({ kind: 'connected', syncPending: false });
      expect(network.refresh).toBe(1);
      expect(network.graphql).toBe(1);
      const shop = await shopState(domain);
      expect(await decryptValue(shop?.access_token_encrypted)).toBe('t17-refreshed-access');
      expect(await productCount(shop?.id as string)).toBe(1);
      expect((await leaseState(domain))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'T27 / T28 : synchronisation en échec → rattachement réussi, échec observable, relance sans doublon',
    async () => {
      const domain = freshDomain('t27');
      const ticket = await pendingTicket(domain, 't27');
      mockShopifyNetwork({ graphqlStatus: 500 });

      expect(await claim(ticket, { realSync: true })).toEqual({
        kind: 'connected',
        syncPending: true,
      });
      const shop = await shopState(domain);
      expect(shop?.status).toBe('active');
      expect(
        sentry.messages.filter((entry) => entry.message === 'shopify_post_connect_effect_failed'),
      ).toHaveLength(1);
      expect(JSON.stringify(sentry.messages)).not.toContain(domain);
      expect(await productCount(shop?.id as string)).toBe(0);

      // Relance (T27), puis rejeu (T28) : un seul produit.
      mockShopifyNetwork();
      const { syncProductsAfterConnect } = await import('@/lib/shopify/post-connect-effects');
      const relaunch = () =>
        syncProductsAfterConnect(service(), {
          shopId: shop?.id as string,
          app: APP_CONFIG,
          actorUserId: tenant.userId,
        });
      expect(await relaunch()).toBe(true);
      expect(await productCount(shop?.id as string)).toBe(1);
      expect(await relaunch()).toBe(true);
      expect(await productCount(shop?.id as string)).toBe(1);
    },
  );

  it.skipIf(!hasStack)(
    'T37 (cœur) : store_connection refusée et synchronisation échouée → connectée, sync en attente',
    async () => {
      const domain = freshDomain('t37-claim');
      const ticket = await pendingTicket(domain, 't37-claim');
      const pg = await pgConnect();
      const { rows } = await pg.query(
        'select id from public.shop where merchant_account_id = $1 limit 1',
        [otherTenant.merchantAccountId],
      );
      await pg.query(
        `insert into public.store_connection (merchant_account_id, shop_id, platform,
           external_identifier, platform_app_id, status)
         values ($1, $2, 'shopify', $3, $4, 'active')`,
        [otherTenant.merchantAccountId, rows[0].id, domain, APP],
      );

      expect(await claim(ticket, { syncOk: false })).toEqual({
        kind: 'connected',
        syncPending: true,
      });
      expect((await shopState(domain))?.status).toBe('active');
      expect((await leaseState(domain))?.lease_expires_at).toBeNull();
    },
  );
});

describe('T13 — ACL de 0160 : service_role seul', () => {
  it.skipIf(!hasStack)(
    'table, colonnes et fonctions : aucun privilège pour anon ni authenticated',
    async () => {
      const pg = await pgConnect();
      const { rows: table } = await pg.query(`
        select r.rolname,
               has_table_privilege(r.rolname, 'public.shopify_pending_installation', 'SELECT') as sel,
               has_table_privilege(r.rolname, 'public.shopify_pending_installation', 'INSERT') as ins,
               has_table_privilege(r.rolname, 'public.shopify_pending_installation', 'UPDATE') as upd,
               has_table_privilege(r.rolname, 'public.shopify_pending_installation', 'DELETE') as del,
               has_any_column_privilege(r.rolname, 'public.shopify_pending_installation', 'SELECT,INSERT,UPDATE') as col
          from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role')
         order by r.rolname`);
      expect(table).toEqual([
        { rolname: 'anon', sel: false, ins: false, upd: false, del: false, col: false },
        { rolname: 'authenticated', sel: false, ins: false, upd: false, del: false, col: false },
        // INSERT et UPDATE : accordés colonne par colonne (0160), jamais sur la table entière.
        { rolname: 'service_role', sel: true, ins: false, upd: false, del: true, col: true },
      ]);
      const { rows: columns } = await pg.query(`
        select has_column_privilege('service_role', 'public.shopify_pending_installation', 'ticket_hash', 'INSERT') as ins_ticket,
               has_column_privilege('service_role', 'public.shopify_pending_installation', 'consumed_at', 'UPDATE') as upd_consumed,
               has_column_privilege('service_role', 'public.shopify_pending_installation', 'ticket_hash', 'UPDATE') as upd_ticket,
               has_column_privilege('authenticated', 'public.shopify_pending_installation', 'ticket_hash', 'SELECT') as auth_sel_ticket`);
      expect(columns).toEqual([
        { ins_ticket: true, upd_consumed: true, upd_ticket: false, auth_sel_ticket: false },
      ]);

      const { rows: rls } = await pg.query(`
        select relrowsecurity, relforcerowsecurity,
               (select count(*)::int from pg_policies where tablename = 'shopify_pending_installation') as policies
          from pg_class where oid = 'public.shopify_pending_installation'::regclass`);
      expect(rls).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, policies: 0 }]);

      const { rows: functions } = await pg.query(`
        select p.proname,
               has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
               has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
               p.prosecdef
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in (
           'classify_shopify_entry', 'decide_and_write_shopify_authorization',
           'consume_shopify_pending_installation', 'read_shopify_pending_installation',
           'uninstall_shopify_pending_or_shop', 'mark_shopify_reauthorization_required',
           'purge_expired_shopify_pending_installations', 'persist_shopify_credentials_fenced')
         order by p.proname`);
      expect(functions).toHaveLength(8);
      for (const fn of functions) {
        expect(fn).toMatchObject({
          anon: false,
          authenticated: false,
          service_role: true,
          prosecdef: false,
        });
      }

      // `shop.reauthorization_required_at` : aucune écriture hors service_role. Sa lecture suit le
      // régime préexistant de `shop` (SELECT de table pour anon et authenticated, lignes filtrées
      // par la RLS forcée) : la colonne n'y ajoute ni n'y retire rien.
      const { rows: shopColumn } = await pg.query(`
        select r.rolname,
               has_column_privilege(r.rolname, 'public.shop', 'reauthorization_required_at', 'UPDATE') as upd,
               has_column_privilege(r.rolname, 'public.shop', 'reauthorization_required_at', 'INSERT') as ins,
               has_column_privilege(r.rolname, 'public.shop', 'reauthorization_required_at', 'SELECT')
                 = has_table_privilege(r.rolname, 'public.shop', 'SELECT') as select_follows_table
          from pg_roles r where r.rolname in ('anon', 'authenticated') order by r.rolname`);
      expect(shopColumn).toEqual([
        { rolname: 'anon', upd: false, ins: false, select_follows_table: true },
        { rolname: 'authenticated', upd: false, ins: false, select_follows_table: true },
      ]);
    },
  );
});

describe('B5 — D17 : rejet définitif du refresh, contre la base réelle (T30)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  type RefreshReply = 'network' | { status: number; body: unknown };

  // Endpoint de jeton remplacé : chaque appel consomme la réponse suivante de la liste.
  function mockRefreshEndpoint(replies: RefreshReply[]) {
    const sentRefreshTokens: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/admin/oauth/access_token')) return originalFetch(input, init);
      const body = JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string };
      sentRefreshTokens.push(body.refresh_token ?? '');
      const reply = replies.shift();
      if (!reply || reply === 'network') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return sentRefreshTokens;
  }

  async function seedRefreshableShop(domain: string) {
    await seedShop(domain, {
      accessExpiresInMs: -60_000,
      refresh: true,
      refreshExpiresInMs: 86_400_000,
    });
    const pg = await pgConnect();
    const { rows } = await pg.query(
      `select id, shop_domain, merchant_account_id, access_token_encrypted, refresh_token_encrypted,
              access_token_expires_at, refresh_token_expires_at
         from public.shop where shop_domain = $1`,
      [domain],
    );
    return rows[0];
  }

  async function refresh(shop: Record<string, unknown>) {
    const { getValidShopAccessToken } = await import('@/lib/shopify/token');
    return getValidShopAccessToken(service(), shop as never, APP, 'client-secret-unused', {
      sleep: async () => undefined,
    });
  }

  const DEFINITIVE = {
    status: 401,
    body: {
      error: 'invalid_request',
      error_description: 'This request requires an active refresh_token',
    },
  };

  it.skipIf(!hasStack)(
    'signature exacte → reauthorization_required_at écrit sous le bail, token_error, puis un grant à l’ouverture suivante',
    async () => {
      const domain = freshDomain('t30-definitive');
      const shop = await seedRefreshableShop(domain);
      const sent = mockRefreshEndpoint([DEFINITIVE]);

      expect(await refresh(shop)).toEqual({ ok: false, reason: 'token_error' });

      expect(sent).toEqual(['seed-refresh']);
      const after = await shopState(domain);
      expect(after?.reauthorization_required_at).not.toBeNull();
      // Credentials inchangés : seul le marquage est écrit.
      expect(await decryptValue(after?.access_token_encrypted)).toBe('seed-access');
      expect((await leaseState(domain))?.lease_expires_at).toBeNull();
      expect(await classify(domain)).toBe('reauthorization_required');
    },
  );

  const controls: Array<[string, RefreshReply[], number]> = [
    ['réseau (deux fois : un seul rejeu)', ['network', 'network'], 2],
    ['500', [{ status: 500, body: {} }], 1],
    ['429', [{ status: 429, body: { errors: 'Too many requests' } }], 1],
    ['autre 401 (invalid_client)', [{ status: 401, body: { error: 'invalid_client' } }], 1],
    [
      '401 invalid_request, autre description',
      [{ status: 401, body: { error: 'invalid_request', error_description: 'Invalid grant' } }],
      1,
    ],
    ['401 sans corps objet', [{ status: 401, body: 'not-json' }], 1],
    // Chaque condition de la signature isolée : même description, statut ou code différent.
    ['400 avec la description exacte', [{ status: 400, body: DEFINITIVE.body }], 1],
    [
      '401 avec la description exacte, autre code d’erreur',
      [
        {
          status: 401,
          body: { error: 'invalid_client', error_description: DEFINITIVE.body.error_description },
        },
      ],
      1,
    ],
  ];

  for (const [name, replies, expectedCalls] of controls) {
    it.skipIf(!hasStack)(`contrôle : ${name} → token_error, AUCUNE écriture`, async () => {
      const domain = freshDomain('t30-control');
      const shop = await seedRefreshableShop(domain);
      const before = await shopState(domain);
      const sent = mockRefreshEndpoint([...replies]);

      expect(await refresh(shop)).toEqual({ ok: false, reason: 'token_error' });

      expect(sent).toHaveLength(expectedCalls);
      expect(new Set(sent)).toEqual(new Set(['seed-refresh']));
      expect((await shopState(domain))?.fingerprint).toBe(before?.fingerprint);
      expect((await leaseState(domain))?.lease_expires_at).toBeNull();
    });
  }

  it.skipIf(!hasStack)(
    'aucune réponse puis succès → un seul rejeu, avec le MÊME refresh token, persisté',
    async () => {
      const domain = freshDomain('t30-replay');
      const shop = await seedRefreshableShop(domain);
      const sent = mockRefreshEndpoint([
        'network',
        {
          status: 200,
          body: {
            access_token: 't30-replayed-access',
            refresh_token: 't30-replayed-refresh',
            expires_in: 3600,
            refresh_token_expires_in: 7_776_000,
            scope: 'read_orders',
          },
        },
      ]);

      expect(await refresh(shop)).toEqual({ ok: true, accessToken: 't30-replayed-access' });
      expect(sent).toEqual(['seed-refresh', 'seed-refresh']);
      const after = await shopState(domain);
      expect(await decryptValue(after?.access_token_encrypted)).toBe('t30-replayed-access');
      expect(after?.reauthorization_required_at).toBeNull();
    },
  );
});
