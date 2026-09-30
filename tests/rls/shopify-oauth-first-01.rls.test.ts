// SHOPIFY-OAUTH-FIRST-01 — preuves contre PostgreSQL/PostgREST réels.
//
// Couche : RLS/intégration (stack Supabase locale, `0160` appliquée). Les modules applicatifs
// exercés n'importent pas `lib/env` : ce fichier se charge sans `RESEND_API_KEY`. Aucun appel à
// Shopify : le endpoint de jeton est remplacé, au niveau de `fetch`, par une réponse locale.
import { randomBytes } from 'node:crypto';
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

beforeAll(async () => {
  if (!hasStack) return;
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY ||= TEST_ENCRYPTION_KEY;
  tenant = await createTenant('oauth-first-01');
});

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
