// SHOPIFY-OAUTH-FIRST-01 / B6 — `app/uninstalled` sur une installation en attente (T12) et course
// désinstallation / rattachement (T20), contre PostgreSQL/PostgREST réels.
//
// Couche : RLS/intégration. Exerce le VRAI dispatcher (`dispatchWebhookCore`), qui importe
// lib/env par lib/shopify/apps : comme les suites webhook existantes, ce fichier exige
// l'environnement complet (en local : `RESEND_API_KEY` factice, jamais écrite dans un fichier).
// Aucun appel à Shopify : l'échange de code est remplacé par une réponse locale.
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const hasStack = Boolean(serviceRoleKey);

const APP = 'oauth-first-01-uninstall-app-sentinel';
const OTHER_APP = 'oauth-first-01-uninstall-other-app-sentinel';
const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const APP_CONFIG = {
  clientId: APP,
  clientSecret: 'client-secret-unused-by-stubs',
  distribution: 'public' as const,
};

type Tenant = { userId: string; merchantAccountId: string };

const createdUserIds: string[] = [];
const createdDomains: string[] = [];
let tenant: Tenant;
let sharedPg: Promise<TestPostgresClient> | null = null;

function service() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function pg(): Promise<TestPostgresClient> {
  sharedPg ??= (async () => {
    const client = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    return client;
  })();
  return sharedPg;
}

function freshDomain(label: string): string {
  const domain = `oauth-first-u-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

async function authorize(domain: string, clientId = APP): Promise<string> {
  const { performNoSessionAuthorization } = await import('@/lib/shopify/no-session-authorization');
  const result = await performNoSessionAuthorization(
    service(),
    { shopDomain: domain, app: { ...APP_CONFIG, clientId }, code: 'authorization-code' },
    {
      exchangeCode: (async () => ({
        accessToken: `${domain}-access`,
        refreshToken: `${domain}-refresh`,
        scope: 'read_orders',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
      })) as never,
      syncProducts: async () => true,
    },
  );
  if (result.kind !== 'pending') throw new Error(`attendu : pending, reçu ${result.kind}`);
  return result.ticket;
}

async function claim(ticket: string, admin = service()) {
  const { performShopifyClaim } = await import('@/lib/shopify/claim-core');
  return performShopifyClaim(
    admin,
    {
      ticket,
      userId: tenant.userId,
      merchantAccountId: tenant.merchantAccountId,
      resolveApp: (clientId) => (clientId === APP ? APP_CONFIG : null),
    },
    { syncProducts: async () => true },
  );
}

// Le vrai dispatcher, tel que l'appellent les deux points d'entrée. `shop` : ce que la résolution a
// vu AVANT l'appel (null si aucune boutique à ce moment).
async function deliverUninstall(domain: string, options: { shopSeen?: boolean } = {}) {
  const { dispatchWebhookCore, resolveShopForTopic } = await import('@/lib/shopify/webhook-core');
  const shop = options.shopSeen
    ? await resolveShopForTopic(service(), 'app/uninstalled', { by: 'domain', shopDomain: domain })
    : null;
  await dispatchWebhookCore({
    supabase: service(),
    shop,
    eventId: crypto.randomUUID(),
    topic: 'app/uninstalled',
    payload: {},
    webhookId: null,
    triggeredAt: null,
    validatedClientId: APP,
    resolvedShopDomain: domain,
  });
}

async function pendingCount(domain: string, clientId?: string): Promise<number> {
  const { rows } = await (await pg()).query(
    `select count(*)::int as n from public.shopify_pending_installation
      where shop_domain = $1 and consumed_at is null and ($2::text is null or shopify_client_id = $2)`,
    [domain, clientId ?? null],
  );
  return rows[0].n as number;
}

async function shopStatus(domain: string): Promise<string | null> {
  const { rows } = await (await pg()).query(
    'select status from public.shop where shop_domain = $1',
    [domain],
  );
  return (rows[0]?.status as string | undefined) ?? null;
}

async function leaseExpiresAt(domain: string): Promise<string | null | undefined> {
  const { rows } = await (await pg()).query(
    'select lease_expires_at from public.shopify_token_lease where shop_domain = $1',
    [domain],
  );
  return rows[0]?.lease_expires_at as string | null | undefined;
}

beforeAll(async () => {
  if (!hasStack) return;
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY ||= TEST_ENCRYPTION_KEY;
  const admin = service();
  const { data, error } = await admin.auth.admin.createUser({
    email: `oauth-first-u-${Date.now()}-${crypto.randomUUID()}@example.com`,
    password: 'mot-de-passe-test-rls',
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`user creation failed: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { data: member } = await admin
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', data.user.id)
    .single();
  tenant = { userId: data.user.id, merchantAccountId: member?.merchant_account_id as string };
}, 60_000);

afterEach(async () => {
  if (!hasStack || createdDomains.length === 0) return;
  const client = await pg();
  await client.query('delete from public.store_connection where external_identifier = any($1)', [
    createdDomains,
  ]);
  await client.query(
    'delete from public.shopify_pending_installation where shop_domain = any($1)',
    [createdDomains],
  );
  await client.query('delete from public.shop where shop_domain = any($1)', [createdDomains]);
  await client.query('delete from public.shopify_token_lease where shop_domain = any($1)', [
    createdDomains,
  ]);
  createdDomains.length = 0;
});

afterAll(async () => {
  if (sharedPg) await (await sharedPg).end().catch(() => undefined);
  if (!hasStack) return;
  const admin = service();
  await Promise.all(createdUserIds.map((userId) => admin.auth.admin.deleteUser(userId)));
});

describe('T12 — app/uninstalled sur une attente', () => {
  it.skipIf(!hasStack)(
    'supprime la seule attente du couple (domaine, app validée) et libère le bail',
    async () => {
      const domain = freshDomain('t12');
      const neighbour = freshDomain('t12-neighbour');
      await authorize(domain, APP);
      await authorize(domain, OTHER_APP);
      await authorize(neighbour, APP);

      await deliverUninstall(domain);

      expect(await pendingCount(domain, APP)).toBe(0);
      // Contrôles positifs : l'autre app du même domaine et le domaine voisin sont intacts.
      expect(await pendingCount(domain, OTHER_APP)).toBe(1);
      expect(await pendingCount(neighbour, APP)).toBe(1);
      expect(await leaseExpiresAt(domain)).toBeNull();
      expect(await shopStatus(domain)).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'sans domaine résolu, rien n’est supprimé (comportement historique : journal seul)',
    async () => {
      const domain = freshDomain('t12-no-domain');
      await authorize(domain, APP);
      const { dispatchWebhookCore } = await import('@/lib/shopify/webhook-core');
      await dispatchWebhookCore({
        supabase: service(),
        shop: null,
        eventId: crypto.randomUUID(),
        topic: 'app/uninstalled',
        payload: {},
        webhookId: null,
        triggeredAt: null,
        validatedClientId: APP,
      });
      expect(await pendingCount(domain, APP)).toBe(1);
    },
  );
});

describe('T20 — course app/uninstalled / POST, dans les deux ordres', () => {
  it.skipIf(!hasStack)(
    'désinstallation PUIS POST : le ticket est refusé, aucune boutique rattachée',
    async () => {
      const domain = freshDomain('t20-uninstall-first');
      const ticket = await authorize(domain);

      await deliverUninstall(domain);
      expect(await claim(ticket)).toEqual({ kind: 'error', code: 'ticket_invalid' });

      expect(await shopStatus(domain)).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'POST PUIS désinstallation (résolue avant le POST) : la boutique rattachée est désinstallée sous verrou',
    async () => {
      const domain = freshDomain('t20-post-first');
      const ticket = await authorize(domain);

      expect(await claim(ticket)).toMatchObject({ kind: 'connected' });
      expect(await shopStatus(domain)).toBe('active');
      // La résolution de la livraison n'avait vu aucune boutique : la décision sous verrou
      // trouve celle que le POST vient de créer.
      await deliverUninstall(domain, { shopSeen: false });

      expect(await shopStatus(domain)).toBe('uninstalled');
      const { rows } = await (await pg()).query(
        `select status from public.store_connection
          where platform = 'shopify' and external_identifier = $1`,
        [domain],
      );
      expect(rows[0]?.status).toBe('uninstalled');
      expect(await leaseExpiresAt(domain)).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'désinstallation PENDANT le POST (bail tenu) : aucun rattachement, bail de la désinstallation libéré',
    async () => {
      const domain = freshDomain('t20-interleaved');
      const ticket = await authorize(domain);
      const admin = service();
      const originalRpc = admin.rpc.bind(admin);
      (admin as unknown as { rpc: (...args: unknown[]) => unknown }).rpc = async (
        ...args: unknown[]
      ) => {
        if (args[0] === 'consume_shopify_pending_installation') await deliverUninstall(domain);
        return (originalRpc as (...inner: unknown[]) => unknown)(...args);
      };

      const outcome = await claim(ticket, admin);

      expect(outcome.kind).toBe('error');
      expect(await shopStatus(domain)).toBeNull();
      expect(await pendingCount(domain)).toBe(0);
    },
  );

  it.skipIf(!hasStack)(
    'concurrence réelle (PostgREST) : jamais de boutique active à l’issue, quel que soit l’ordre',
    async () => {
      for (let round = 0; round < 5; round += 1) {
        const domain = freshDomain(`t20-concurrent-${round}`);
        const ticket = await authorize(domain);

        await Promise.all([claim(ticket, service()), deliverUninstall(domain)]);

        expect([null, 'uninstalled']).toContain(await shopStatus(domain));
        expect(await pendingCount(domain)).toBe(0);
      }
    },
  );
});

describe('T12b — app/uninstalled sur une boutique existante porteuse d’une attente', () => {
  // Boutique du locataire, posée directement (état, pas un parcours rejoué).
  async function seedShop(
    domain: string,
    seed: { status: 'active' | 'uninstalled'; token: boolean },
  ) {
    const { encryptToken } = await import('@/lib/shopify/crypto');
    await (await pg()).query(
      `insert into public.shop (merchant_account_id, shop_domain, shopify_client_id,
         access_token_encrypted, scopes, status, store_kind, display_name)
       values ($1, $2, $3, $4, 'read_orders', $5, 'shopify', $2)`,
      [
        tenant.merchantAccountId,
        domain,
        APP,
        seed.token ? encryptToken('seed-access') : null,
        seed.status,
      ],
    );
  }

  // Empreinte des 8 colonnes de credentials et d'état.
  async function fingerprint(domain: string): Promise<string | null> {
    const { rows } = await (await pg()).query(
      `select md5(concat_ws('|', access_token_encrypted, refresh_token_encrypted,
         access_token_expires_at, refresh_token_expires_at, scopes, shopify_client_id, status,
         reauthorization_required_at)) as h
       from public.shop where shop_domain = $1`,
      [domain],
    );
    return (rows[0]?.h as string | undefined) ?? null;
  }

  // Client service-role dont on relève les RPC appelées par le dispatcher.
  function recordingService() {
    const admin = service();
    const calls: string[] = [];
    const originalRpc = admin.rpc.bind(admin);
    (admin as unknown as { rpc: (...args: unknown[]) => unknown }).rpc = (...args: unknown[]) => {
      calls.push(String(args[0]));
      return (originalRpc as (...inner: unknown[]) => unknown)(...args);
    };
    return { admin, calls };
  }

  async function deliverResolvedUninstall(domain: string, admin = service()) {
    const { dispatchWebhookCore, resolveShopForTopic } = await import('@/lib/shopify/webhook-core');
    const shop = await resolveShopForTopic(service(), 'app/uninstalled', {
      by: 'domain',
      shopDomain: domain,
    });
    expect(shop).not.toBeNull();
    await dispatchWebhookCore({
      supabase: admin,
      shop,
      eventId: crypto.randomUUID(),
      topic: 'app/uninstalled',
      payload: {},
      webhookId: null,
      triggeredAt: null,
      validatedClientId: APP,
      resolvedShopDomain: domain,
    });
  }

  it.skipIf(!hasStack)(
    'ligne uninstalled + attente + app/uninstalled → attente supprimée, POST = ticket_invalid, ligne inchangée',
    async () => {
      const domain = freshDomain('t12b');
      await seedShop(domain, { status: 'uninstalled', token: false });
      const ticket = await authorize(domain);
      expect(await pendingCount(domain, APP)).toBe(1);
      const before = await fingerprint(domain);

      await deliverResolvedUninstall(domain);

      expect(await pendingCount(domain, APP)).toBe(0);
      expect(await leaseExpiresAt(domain)).toBeNull();
      expect(await claim(ticket)).toEqual({ kind: 'error', code: 'ticket_invalid' });
      expect(await shopStatus(domain)).toBe('uninstalled');
      expect(await fingerprint(domain)).toBe(before);
    },
  );

  it.skipIf(!hasStack)(
    'contrôle positif : sans app/uninstalled, le POST reconnecte la même ligne',
    async () => {
      const domain = freshDomain('t12b-positive');
      await seedShop(domain, { status: 'uninstalled', token: false });
      const ticket = await authorize(domain);

      expect(await claim(ticket)).toMatchObject({ kind: 'connected' });
      expect(await shopStatus(domain)).toBe('active');
    },
  );

  it.skipIf(!hasStack)(
    'chemin historique sans attente (KOBA) : effets inchangés, aucune préemption supplémentaire',
    async () => {
      const domain = freshDomain('t12b-historical');
      await seedShop(domain, { status: 'active', token: true });
      const { admin, calls } = recordingService();

      await deliverResolvedUninstall(domain, admin);

      expect(await shopStatus(domain)).toBe('uninstalled');
      expect(calls).toContain('uninstall_shopify_shop_fenced');
      expect(calls).not.toContain('uninstall_shopify_pending_or_shop');
      expect(await leaseExpiresAt(domain)).toBeNull();
    },
  );
});
