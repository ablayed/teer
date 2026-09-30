// SHOPIFY-OAUTH-FIRST-01 — preuves contre PostgreSQL/PostgREST réels.
//
// Couche : RLS/intégration (stack Supabase locale, `0160` appliquée). Les modules applicatifs
// exercés n'importent pas `lib/env` : ce fichier se charge sans `RESEND_API_KEY`. Aucun appel à
// Shopify : le endpoint de jeton est remplacé, au niveau de `fetch`, par une réponse locale.
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

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
