// SHOPIFY-WEBHOOKS-PER-SHOP-1B — outillage partagé des suites RLS du lot.
//
// Aucun appel réel à Shopify : la réconciliation reçoit son exécuteur GraphQL PAR INJECTION
// (`FakeShopifyAdmin`), jamais par un remplacement de `fetch`. Il n'y a donc aucun `fetch` à
// restaurer avant la fin d'un appel (constat 9B). En garde supplémentaire,
// `installShopifyNetworkGuard` fait échouer tout appel sortant vers un domaine Shopify.
//
// Toutes les valeurs à allure de secret sont SYNTHÉTIQUES et générées à l'exécution : aucune
// n'est écrite dans le dépôt.
import { randomBytes } from 'node:crypto';
import type { shopifyGraphQL } from '@/lib/shopify/graphql';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { type TestPostgresClient, createTestPostgresClient } from './postgres-client';

export const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const hasStack = Boolean(serviceRoleKey);

// Origine publique synthétique des webhooks (domaine réservé `.test`).
export const TEST_WEBHOOK_BASE_URL = 'https://synthetic-test-webhooks.example.test';

export type Admin = SupabaseClient<Database>;
export type Tenant = { userId: string; merchantAccountId: string };

export function service(): Admin {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

let sharedPg: Promise<TestPostgresClient> | null = null;

export async function pg(): Promise<TestPostgresClient> {
  sharedPg ??= (async () => {
    const client = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    return client;
  })();
  return sharedPg;
}

export async function closePg(): Promise<void> {
  if (sharedPg) {
    await (await sharedPg).end().catch(() => undefined);
    sharedPg = null;
  }
}

// Clé de chiffrement de test, générée à l'exécution (jamais un littéral).
export function ensureTestEncryptionKey(): void {
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
}

const createdUserIds: string[] = [];
const createdDomains: string[] = [];

export async function createTenant(label: string): Promise<Tenant> {
  const admin = service();
  const { data, error } = await admin.auth.admin.createUser({
    email: `${label}-${Date.now()}-${crypto.randomUUID()}@example.com`,
    password: `synthetic-test-${crypto.randomUUID()}`,
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
  return { userId: data.user.id, merchantAccountId: member.merchant_account_id };
}

export function freshDomain(label: string): string {
  const domain = `wps1b-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.myshopify.com`;
  createdDomains.push(domain);
  return domain;
}

export type SeededShop = { shopId: string; connectionId: string; domain: string };

// Boutique Shopify connectée + sa connexion, posées directement (un état, pas un parcours).
// Jeton d'accès NON expirant par défaut (`access_token_expires_at` NULL) : `getValidShopAccessToken`
// le rend tel quel, sans aucun appel réseau — c'est aussi le régime d'une app custom (KOBA).
export async function seedConnectedShop(
  tenant: Tenant,
  domain: string,
  options: {
    clientId: string;
    status?: 'active' | 'uninstalled';
    connectionStatus?: 'active' | 'uninstalled';
    // ISO, ou une expression SQL relative à now() via `credentialsAcquiredAgoSeconds`.
    credentialsAcquiredAgoSeconds?: number | null;
    withToken?: boolean;
  },
): Promise<SeededShop> {
  ensureTestEncryptionKey();
  const { encryptToken } = await import('@/lib/shopify/crypto');
  const status = options.status ?? 'active';
  const withToken = options.withToken ?? status === 'active';
  const client = await pg();

  const { rows: shopRows } = await client.query(
    `insert into public.shop (merchant_account_id, shop_domain, shopify_client_id,
       access_token_encrypted, scopes, status, store_kind, display_name, credentials_acquired_at)
     values ($1, $2, $3, $4, 'read_orders', $5, 'shopify', $2,
       case when $6::double precision is null then null
            else now() - make_interval(secs => $6::double precision) end)
     returning id`,
    [
      tenant.merchantAccountId,
      domain,
      options.clientId,
      withToken ? encryptToken(`synthetic-test-access-${crypto.randomUUID()}`) : null,
      status,
      options.credentialsAcquiredAgoSeconds ?? null,
    ],
  );
  const shopId = shopRows[0].id as string;

  const { rows: connectionRows } = await client.query(
    `insert into public.store_connection (merchant_account_id, shop_id, platform,
       external_identifier, platform_app_id, status)
     values ($1, $2, 'shopify', $3, $4, $5)
     returning id`,
    [
      tenant.merchantAccountId,
      shopId,
      domain,
      options.clientId,
      options.connectionStatus ?? status,
    ],
  );

  return { shopId, connectionId: connectionRows[0].id as string, domain };
}

export async function cleanupDomains(): Promise<void> {
  if (!hasStack || createdDomains.length === 0) return;
  const client = await pg();
  // Écritures métier d'une livraison acceptée (registre d'ingestion, commandes).
  await client.query(
    `delete from public.ingestion_event where store_connection_id in (
       select id from public.store_connection where external_identifier = any($1))`,
    [createdDomains],
  );
  await client.query(
    `delete from public.orders where shop_id in (
       select id from public.shop where shop_domain = any($1))`,
    [createdDomains],
  );
  // `store_connection` cascade vers le jeton L3, l'état des abonnements et le bail.
  await client.query('delete from public.store_connection where external_identifier = any($1)', [
    createdDomains,
  ]);
  await client.query(
    'delete from public.shopify_pending_installation where shop_domain = any($1)',
    [createdDomains],
  );
  await client.query('delete from public.webhook_event where shop_domain = any($1)', [
    createdDomains,
  ]);
  await client.query('delete from public.shop where shop_domain = any($1)', [createdDomains]);
  await client.query('delete from public.shopify_token_lease where shop_domain = any($1)', [
    createdDomains,
  ]);
  createdDomains.length = 0;
}

export async function cleanupTenants(): Promise<void> {
  if (!hasStack) return;
  const admin = service();
  await Promise.all(createdUserIds.map((userId) => admin.auth.admin.deleteUser(userId)));
  createdUserIds.length = 0;
}

// Garde réseau : tout appel sortant vers Shopify échoue. Posée pour TOUTE la durée du fichier et
// retirée seulement dans son `afterAll` — jamais entre deux appels.
export function installShopifyNetworkGuard(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (/myshopify\.com|shopify\.com/.test(new URL(url).hostname)) {
      throw new Error('appel réseau Shopify interdit dans cette suite');
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

type FakeSubscription = { id: string; topic: string; uri: string; apiVersion: string };

export type FakeShopifyCall =
  | { op: 'list' }
  | { op: 'create'; topic: string }
  | { op: 'delete'; id: string };

// Double de l'Admin GraphQL de Shopify, réduit aux abonnements webhook d'UNE boutique.
// Ne suppose rien d'un refus des doublons : comme la conception (G12), il les accepte.
export class FakeShopifyAdmin {
  subscriptions: FakeSubscription[] = [];
  calls: FakeShopifyCall[] = [];
  apiVersion = '2026-04';
  pageSizeCap: number | null = null;
  failCreateTopics = new Set<string>();
  // Points d'interruption, appelés APRÈS l'effet chez « Shopify » et AVANT le retour à l'appelant.
  afterCreate: ((subscription: FakeSubscription) => Promise<void> | void) | null = null;
  beforeCreate: ((topic: string) => Promise<void> | void) | null = null;
  afterList: (() => Promise<void> | void) | null = null;
  beforeDelete: ((id: string) => Promise<void> | void) | null = null;
  private sequence = 0;

  constructor(private readonly shopDomain: string) {}

  seed(topic: string, uri: string): FakeSubscription {
    this.sequence += 1;
    const subscription = {
      id: `gid://shopify/WebhookSubscription/${this.sequence}`,
      topic,
      uri,
      apiVersion: this.apiVersion,
    };
    this.subscriptions.push(subscription);
    return subscription;
  }

  count(op: FakeShopifyCall['op']): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  byTopic(topic: string): FakeSubscription[] {
    return this.subscriptions.filter((subscription) => subscription.topic === topic);
  }

  graphql = (async (input: {
    shopDomain: string;
    accessToken: string;
    query: string;
    variables?: Record<string, unknown>;
  }) => {
    if (input.shopDomain !== this.shopDomain) {
      throw new Error('FakeShopifyAdmin : domaine inattendu');
    }
    const variables = input.variables ?? {};

    if (input.query.includes('webhookSubscriptionCreate')) {
      const topic = String(variables.topic);
      this.calls.push({ op: 'create', topic });
      await this.beforeCreate?.(topic);
      if (this.failCreateTopics.has(topic)) {
        return {
          webhookSubscriptionCreate: {
            webhookSubscription: null,
            userErrors: [{ field: ['webhookSubscription'], message: 'refus simulé' }],
          },
        };
      }
      const uri = String((variables.webhookSubscription as { uri: string }).uri);
      const subscription = this.seed(topic, uri);
      await this.afterCreate?.(subscription);
      return {
        webhookSubscriptionCreate: {
          webhookSubscription: {
            id: subscription.id,
            topic,
            apiVersion: { handle: subscription.apiVersion },
          },
          userErrors: [],
        },
      };
    }

    if (input.query.includes('webhookSubscriptionDelete')) {
      const id = String(variables.id);
      this.calls.push({ op: 'delete', id });
      await this.beforeDelete?.(id);
      this.subscriptions = this.subscriptions.filter((subscription) => subscription.id !== id);
      return { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: id, userErrors: [] } };
    }

    if (input.query.includes('webhookSubscriptions(')) {
      this.calls.push({ op: 'list' });
      const requested = Number(variables.first);
      const pageSize = this.pageSizeCap ? Math.min(requested, this.pageSizeCap) : requested;
      const start = variables.after ? Number(variables.after) : 0;
      const snapshot = this.subscriptions.slice(start, start + pageSize);
      const end = start + snapshot.length;
      const hasNextPage = end < this.subscriptions.length;
      await this.afterList?.();
      return {
        webhookSubscriptions: {
          edges: snapshot.map((subscription) => ({
            node: {
              id: subscription.id,
              topic: subscription.topic,
              uri: subscription.uri,
              apiVersion: { handle: subscription.apiVersion },
            },
          })),
          pageInfo: { hasNextPage, endCursor: hasNextPage ? String(end) : null },
        },
      };
    }

    throw new Error('FakeShopifyAdmin : requête inattendue');
  }) as unknown as typeof shopifyGraphQL;
}

// Barrière : suspend un point d'interruption jusqu'à son ouverture, et signale qu'il est atteint.
export function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reach: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { wait: () => opened, open, reached, reach };
}
