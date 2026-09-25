// SHOPIFY-EXPIRING-TOKENS-01 — le chemin APPLICATIF sous bail, contre PostgreSQL réel.
//
// Le schéma (0158, 0159) a prouvé qu'un seul détenteur obtient le bail. Ce fichier prouve qu'un
// seul APPEL SHOPIFY est émis (preuve 9B) : c'est le compteur d'appels du mock réseau qui est
// l'assertion, jamais le seul état final de la ligne — deux appels suivis d'une seule écriture
// gagnante passeraient sinon, alors que c'est l'état que Shopify interdit.
//
// Modules exercés tels quels : lib/shopify/token.ts (rafraîchissement sous bail) et
// lib/shopify/token-lease.ts (reprise de `store_connection` après une primitive destructive).
// Aucun des deux n'importe `lib/env` : ce fichier se charge sans `RESEND_API_KEY`.
//
// Les deux invocations concurrentes de 9B viennent de DEUX instances de module (`vi.resetModules`)
// : le dédoublonnage en mémoire de token.ts (`refreshInFlight`) ne peut donc pas masquer le bail.
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const hasStack = Boolean(serviceRoleKey);

const APP = 'expiring-tokens-01-app-sentinel';
const OTHER_APP = 'expiring-tokens-01-other-app-sentinel';
// Clé de test générée à l'exécution : aucun littéral à allure de secret dans le dépôt.
const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex');

type Tenant = { userId: string; merchantAccountId: string };

const createdUserIds: string[] = [];
const createdDomains: string[] = [];
const pgClients: TestPostgresClient[] = [];
const originalFetch = globalThis.fetch;
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
  const domain = `expiring-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

async function encrypt(value: string) {
  const { encryptToken } = await import('@/lib/shopify/crypto');
  return encryptToken(value);
}

async function decrypt(value: string) {
  const { decryptToken } = await import('@/lib/shopify/crypto');
  return decryptToken(value);
}

const SHOP_COLUMNS =
  'id, shop_domain, merchant_account_id, shopify_client_id, status, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at';

type ShopRow = {
  id: string;
  shop_domain: string;
  merchant_account_id: string;
  shopify_client_id: string | null;
  status: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
};

async function shopRow(domain: string): Promise<ShopRow> {
  const { data, error } = await service()
    .from('shop')
    .select(SHOP_COLUMNS)
    .eq('shop_domain', domain)
    .single();
  if (error || !data) throw new Error(`shop row: ${error?.message}`);
  return data as ShopRow;
}

async function leaseRow(domain: string) {
  const { data, error } = await service()
    .from('shopify_token_lease')
    .select('generation, lease_expires_at')
    .eq('shop_domain', domain)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as { generation: number; lease_expires_at: string | null } | null;
}

async function connectionRow(domain: string) {
  const { data, error } = await service()
    .from('store_connection')
    .select('status, platform_app_id, merchant_account_id')
    .eq('platform', 'shopify')
    .eq('external_identifier', domain)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as { status: string; platform_app_id: string | null } | null;
}

// Boutique à jeton EXPIRANT échu, refresh valide : le prochain accès doit rafraîchir.
async function seedExpiringShop(domain: string): Promise<ShopRow> {
  const { error } = await service()
    .from('shop')
    .insert({
      merchant_account_id: tenant.merchantAccountId,
      shop_domain: domain,
      shopify_client_id: APP,
      access_token_encrypted: await encrypt('seed-access'),
      refresh_token_encrypted: await encrypt('seed-refresh'),
      access_token_expires_at: new Date(Date.now() - 60_000).toISOString(),
      refresh_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      scopes: 'read_orders',
      status: 'active',
    });
  if (error) throw new Error(`seed shop failed: ${error.message}`);
  return shopRow(domain);
}

// Connexion active écrite par la primitive fencée, sous un bail aussitôt libéré.
async function seedConnection(domain: string) {
  const lease = await import('@/lib/shopify/token-lease');
  const admin = service();
  const acquired = await lease.acquireShopifyTokenLease(admin, domain);
  if (!acquired.ok) throw new Error('seed lease not acquired');
  const outcome = await lease.writeShopifyStoreConnectionFenced(admin, {
    shopDomain: domain,
    generation: acquired.generation,
    merchantAccountId: tenant.merchantAccountId,
    clientId: APP,
  });
  expect(outcome).toBe('written');
  await lease.releaseShopifyTokenLease(admin, domain, acquired.generation);
}

// Mock réseau Shopify : compte les appels au endpoint de jeton et les bloque sur une barrière.
function installShopifyNetworkMock() {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reachedResolve: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const tokenCalls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('/admin/oauth/access_token')) {
      return originalFetch(input, init);
    }
    tokenCalls.push(url);
    reachedResolve();
    await gate;
    return new Response(
      JSON.stringify({
        access_token: `network-access-${tokenCalls.length}`,
        refresh_token: `network-refresh-${tokenCalls.length}`,
        expires_in: 3600,
        refresh_token_expires_in: 7_776_000,
        scope: 'read_orders',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { tokenCalls, reached, open: () => open() };
}

async function freshTokenModule() {
  vi.resetModules();
  return import('@/lib/shopify/token');
}

beforeAll(async () => {
  if (!hasStack) return;
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY ||= TEST_ENCRYPTION_KEY;
  tenant = await createTenant('expiring-tokens-01');
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (!hasStack || createdDomains.length === 0) return;
  const admin = service();
  await admin.from('store_connection').delete().in('external_identifier', createdDomains);
  await admin.from('shop').delete().in('shop_domain', createdDomains);
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

describe('SHOPIFY-EXPIRING-TOKENS-01 — preuve 9B', () => {
  it.skipIf(!hasStack)(
    'deux rafraîchissements concurrents : UN SEUL appel Shopify ; le perdant s’arrête avant le réseau et utilise la paire du gagnant ; le gagnant persiste sous sa génération',
    async () => {
      const domain = freshDomain('9b');
      const shop = await seedExpiringShop(domain);
      const network = installShopifyNetworkMock();

      const winnerModule = await freshTokenModule();
      const loserModule = await freshTokenModule();
      expect(winnerModule).not.toBe(loserModule);

      let winnerDone: () => void = () => undefined;
      const winnerFinished = new Promise<void>((resolve) => {
        winnerDone = resolve;
      });
      let loserSlept = 0;

      // Le gagnant acquiert, puis se bloque DANS l'appel réseau.
      const winner = winnerModule
        .getValidShopAccessToken(service(), shop, APP, 'secret')
        .finally(() => winnerDone());
      await network.reached;
      const generationDuringCall = (await leaseRow(domain))?.generation;

      // Le perdant arrive pendant que le gagnant tient le bail : sa relecture attend la fin du
      // gagnant (la barrière s'ouvre à sa première attente).
      const loser = loserModule.getValidShopAccessToken(service(), shop, APP, 'secret', {
        sleep: async () => {
          loserSlept += 1;
          network.open();
          await winnerFinished;
        },
      });

      const [winnerResult, loserResult] = await Promise.all([winner, loser]);

      // L'ASSERTION CENTRALE : un seul appel au endpoint de jeton.
      expect(network.tokenCalls).toHaveLength(1);
      expect(winnerResult).toEqual({ ok: true, accessToken: 'network-access-1' });
      // Le perdant n'a jamais appelé Shopify : il a relu la paire persistée par le gagnant.
      expect(loserSlept).toBeGreaterThanOrEqual(1);
      expect(loserResult).toEqual({ ok: true, accessToken: 'network-access-1' });

      // Le gagnant a persisté SOUS SA génération, puis libéré.
      const row = await shopRow(domain);
      expect(await decrypt(row.access_token_encrypted as string)).toBe('network-access-1');
      expect(await decrypt(row.refresh_token_encrypted as string)).toBe('network-refresh-1');
      const lease = await leaseRow(domain);
      expect(lease?.generation).toBe(generationDuringCall);
      expect(lease?.lease_expires_at).toBeNull();
    },
  );
});

describe('SHOPIFY-EXPIRING-TOKENS-01 — preuve 10 : destruction concurrente d’une acquisition', () => {
  it.skipIf(!hasStack)(
    'désinstallation pendant un rafraîchissement en vol : préemption, la réponse Shopify du rafraîchissement n’est jamais écrite, la boutique reste désinstallée',
    async () => {
      const domain = freshDomain('10-uninstall');
      const shop = await seedExpiringShop(domain);
      await seedConnection(domain);
      const network = installShopifyNetworkMock();
      const tokenModule = await freshTokenModule();
      const lease = await import('@/lib/shopify/token-lease');

      const refresh = tokenModule.getValidShopAccessToken(service(), shop, APP, 'secret', {
        sleep: async () => {},
      });
      await network.reached;

      // Chemin de webhook-core.ts : primitive préemptive, puis store_connection sous SA génération.
      const { data, error } = await service().rpc('uninstall_shopify_shop_fenced', {
        p_shop_domain: domain,
        p_shop_id: shop.id,
        p_merchant_account_id: tenant.merchantAccountId,
        p_client_id: APP,
        p_ttl_seconds: lease.SHOPIFY_TOKEN_LEASE_TTL_SECONDS,
      });
      expect(error).toBeNull();
      const verdict = (data as Array<{ outcome: string; generation: number }>)[0];
      expect(verdict?.outcome).toBe('uninstalled');
      const connectionOutcome = await lease.markShopifyConnectionUninstalled(service(), {
        shopDomain: domain,
        generation: verdict?.generation ?? null,
        merchantAccountId: tenant.merchantAccountId,
      });
      expect(connectionOutcome).toBe('written');

      network.open();
      const result = await refresh;

      expect(network.tokenCalls).toHaveLength(1);
      expect(result).toEqual({ ok: false, reason: 'token_error' });
      const row = await shopRow(domain);
      expect(row.status).toBe('uninstalled');
      expect(row.access_token_encrypted).toBeNull();
      expect(row.refresh_token_encrypted).toBeNull();
      expect((await connectionRow(domain))?.status).toBe('uninstalled');
      expect((await leaseRow(domain))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'déconnexion pendant un rafraîchissement en vol : même régime, credentials effacés et jamais réécrits',
    async () => {
      const domain = freshDomain('10-disconnect');
      const shop = await seedExpiringShop(domain);
      await seedConnection(domain);
      const network = installShopifyNetworkMock();
      const tokenModule = await freshTokenModule();
      const lease = await import('@/lib/shopify/token-lease');

      const refresh = tokenModule.getValidShopAccessToken(service(), shop, APP, 'secret', {
        sleep: async () => {},
      });
      await network.reached;

      const { data, error } = await service().rpc('disconnect_shop_fenced', {
        p_user_id: tenant.userId,
        p_merchant_account_id: tenant.merchantAccountId,
        p_shop_id: shop.id,
        p_ttl_seconds: lease.SHOPIFY_TOKEN_LEASE_TTL_SECONDS,
      });
      expect(error).toBeNull();
      const verdict = (data as Array<{ outcome: string; generation: number }>)[0];
      expect(verdict?.outcome).toBe('disconnected');
      expect(
        await lease.markShopifyConnectionUninstalled(service(), {
          shopDomain: domain,
          generation: verdict?.generation ?? null,
          merchantAccountId: tenant.merchantAccountId,
        }),
      ).toBe('written');

      network.open();
      expect(await refresh).toEqual({ ok: false, reason: 'token_error' });
      const row = await shopRow(domain);
      expect(row.status).toBe('uninstalled');
      expect(row.access_token_encrypted).toBeNull();
      expect(row.refresh_token_expires_at).toBeNull();
      // §4.1 point 2 : store_connection suit la boutique.
      expect((await connectionRow(domain))?.status).toBe('uninstalled');
    },
  );
});

describe('SHOPIFY-EXPIRING-TOKENS-01 — preuve 13 : désinstallation concurrente d’une réinstallation', () => {
  it.skipIf(!hasStack)(
    'la réinstallation attend la libération du bail, bornée par le TTL ; l’état final est cohérent',
    async () => {
      const domain = freshDomain('13');
      const shop = await seedExpiringShop(domain);
      await seedConnection(domain);
      const lease = await import('@/lib/shopify/token-lease');

      // Désinstallation : la primitive préempte et TIENT le bail jusqu'à la reprise de connexion.
      const before = Date.now();
      const { data } = await service().rpc('uninstall_shopify_shop_fenced', {
        p_shop_domain: domain,
        p_shop_id: shop.id,
        p_merchant_account_id: tenant.merchantAccountId,
        p_client_id: APP,
        p_ttl_seconds: lease.SHOPIFY_TOKEN_LEASE_TTL_SECONDS,
      });
      const verdict = (data as Array<{ outcome: string; generation: number }>)[0];
      expect(verdict?.outcome).toBe('uninstalled');

      // Réinstallation concurrente : refusée tant que le bail est tenu…
      const blocked = await lease.acquireShopifyTokenLease(service(), domain);
      expect(blocked).toEqual({ ok: false, reason: 'lease_held' });
      // … et l'attente est BORNÉE par le TTL : l'échéance ne dépasse pas TTL après la préemption.
      const held = await leaseRow(domain);
      const expiresAt = Date.parse(held?.lease_expires_at as string);
      expect(expiresAt).toBeLessThanOrEqual(
        Date.now() + lease.SHOPIFY_TOKEN_LEASE_TTL_SECONDS * 1_000 + 5_000,
      );
      expect(expiresAt).toBeGreaterThan(before);

      // La désinstallation se termine et libère.
      expect(
        await lease.markShopifyConnectionUninstalled(service(), {
          shopDomain: domain,
          generation: verdict?.generation ?? null,
          merchantAccountId: tenant.merchantAccountId,
        }),
      ).toBe('written');

      // La réinstallation reprend et aboutit sous une génération plus récente.
      const acquired = await lease.acquireShopifyTokenLease(service(), domain);
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      expect(acquired.generation).toBeGreaterThan(verdict?.generation ?? 0);
      const persisted = await lease.persistShopifyCredentialsFenced(service(), {
        mode: 'authorization_code',
        shopDomain: domain,
        generation: acquired.generation,
        merchantAccountId: tenant.merchantAccountId,
        clientId: APP,
        accessTokenEncrypted: await encrypt('reinstall-access'),
        refreshTokenEncrypted: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scopes: 'read_orders',
      });
      expect(persisted.outcome).toBe('updated');
      expect(
        await lease.writeShopifyStoreConnectionFenced(service(), {
          shopDomain: domain,
          generation: acquired.generation,
          merchantAccountId: tenant.merchantAccountId,
          clientId: APP,
        }),
      ).toBe('written');
      await lease.releaseShopifyTokenLease(service(), domain, acquired.generation);

      const row = await shopRow(domain);
      expect(row.status).toBe('active');
      expect(await decrypt(row.access_token_encrypted as string)).toBe('reinstall-access');
      expect((await connectionRow(domain))?.status).toBe('active');
      expect((await leaseRow(domain))?.lease_expires_at).toBeNull();
    },
  );
});

describe('SHOPIFY-EXPIRING-TOKENS-01 — §4.1 point 1 : reprise après already_uninstalled', () => {
  it.skipIf(!hasStack)(
    'verdict idempotent sans génération : la reprise acquiert un bail NORMAL avant d’écrire store_connection',
    async () => {
      const domain = freshDomain('resume');
      const shop = await seedExpiringShop(domain);
      await seedConnection(domain);
      const lease = await import('@/lib/shopify/token-lease');
      const uninstallArgs = {
        p_shop_domain: domain,
        p_shop_id: shop.id,
        p_merchant_account_id: tenant.merchantAccountId,
        p_client_id: APP,
        p_ttl_seconds: lease.SHOPIFY_TOKEN_LEASE_TTL_SECONDS,
      };

      // Première livraison : la boutique est désinstallée mais la reprise de connexion échoue
      // (simulée : on ne l'appelle pas) ; on libère la préemption comme le ferait le TTL.
      const first = await service().rpc('uninstall_shopify_shop_fenced', uninstallArgs);
      const firstVerdict = (first.data as Array<{ generation: number }>)[0];
      await lease.releaseShopifyTokenLease(service(), domain, firstVerdict?.generation as number);
      expect((await connectionRow(domain))?.status).toBe('active');

      // Seconde livraison : verdict idempotent, AUCUNE génération rendue.
      const second = await service().rpc('uninstall_shopify_shop_fenced', uninstallArgs);
      const secondVerdict = (
        second.data as Array<{ outcome: string; generation: number | null }>
      )[0];
      expect(secondVerdict?.outcome).toBe('already_uninstalled');
      expect(secondVerdict?.generation).toBeNull();
      const generationBefore = (await leaseRow(domain))?.generation ?? 0;

      const outcome = await lease.markShopifyConnectionUninstalled(service(), {
        shopDomain: domain,
        generation: null,
        merchantAccountId: tenant.merchantAccountId,
      });

      expect(outcome).toBe('written');
      expect((await connectionRow(domain))?.status).toBe('uninstalled');
      // Un bail normal a été pris (génération + 1), puis libéré.
      const after = await leaseRow(domain);
      expect(after?.generation).toBe(generationBefore + 1);
      expect(after?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'garde d’app : un app/uninstalled d’une AUTRE app ne désinstalle pas la boutique',
    async () => {
      const domain = freshDomain('app-guard');
      const shop = await seedExpiringShop(domain);
      const { data } = await service().rpc('uninstall_shopify_shop_fenced', {
        p_shop_domain: domain,
        p_shop_id: shop.id,
        p_merchant_account_id: tenant.merchantAccountId,
        p_client_id: OTHER_APP,
        p_ttl_seconds: 60,
      });
      expect((data as Array<{ outcome: string }>)[0]?.outcome).toBe('app_identity_mismatch');
      expect((await shopRow(domain)).status).toBe('active');
    },
  );
});
