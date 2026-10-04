// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C5 et C6 — désinstallation ORDONNÉE sur les deux chemins, et route
// opaque : W4, W5, W6, W7, W7b, W8, W9, W10, W11.
//
// Couche : intégration. Les VRAIS gestionnaires de route (`/api/shopify/webhooks`, chemin global,
// et `/api/shopify/ingest/[token]`, chemin opaque) sont appelés avec des requêtes signées, contre
// PostgreSQL/PostgREST réels : c'est la primitive de 0161 qui décide, sous verrou. Rien n'est
// injecté à sa place. Aucun appel à Shopify.
//
// Le temps. Les scénarios du plan s'expriment en secondes (« désinstallation à 0 s, attente à
// 30 s, seconde livraison à 40 s »). Ils sont joués SANS attendre : l'instant 0 est placé dans le
// passé, et chaque date est posée relativement à lui — l'horodatage de l'événement dans son
// en-tête, la borne d'acquisition dans la base. La marge est celle du code (10 s, G9).
//
// Les apps sont FICTIVES et leurs secrets synthétiques, générés à l'exécution.
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Tenant,
  cleanupDomains,
  cleanupTenants,
  closePg,
  createTenant,
  ensureTestEncryptionKey,
  freshDomain,
  hasStack,
  installShopifyNetworkGuard,
  pg,
  seedConnectedShop,
  service,
} from '../helpers/shopify-webhooks-1b';

const harness = vi.hoisted(() => ({
  after: [] as Promise<unknown>[],
  sentry: [] as Array<{ message: string; tags: Record<string, string> }>,
}));

vi.mock('next/server', () => ({
  after(callback: () => Promise<unknown>) {
    harness.after.push(callback());
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: (message: string, context?: { tags?: Record<string, string> }) => {
    harness.sentry.push({ message, tags: context?.tags ?? {} });
  },
}));

const APP_A = {
  clientId: 'wps1b-order-app-a',
  secret: `synthetic-test-${randomBytes(12).toString('hex')}`,
};
const APP_B = {
  clientId: 'wps1b-order-app-b',
  secret: `synthetic-test-${randomBytes(12).toString('hex')}`,
};
const SHOPIFY_ENV_KEYS = [
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'SHOPIFY_PILOTE_API_KEY',
  'SHOPIFY_PILOTE_API_SECRET',
  'SHOPIFY_MARCHAND_API_KEY',
  'SHOPIFY_MARCHAND_API_SECRET',
  'SHOPIFY_KOBA_API_KEY',
  'SHOPIFY_KOBA_API_SECRET',
  'SHOPIFY_TEER_PUBLIC_API_KEY',
  'SHOPIFY_TEER_PUBLIC_API_SECRET',
  'RESEND_API_KEY',
] as const;

type Path = 'global' | 'opaque';
type LegacyPost = (request: Request) => Promise<Response>;
type IngestPost = (
  request: Request,
  context: { params: Promise<{ token: string }> },
) => Promise<Response>;

const previousEnv = new Map<string, string | undefined>();
let legacyPost: LegacyPost;
let ingestPost: IngestPost;
let tenant: Tenant;
let removeNetworkGuard: () => void = () => undefined;

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

// Instant ISO situé `secondsAgo` secondes avant maintenant.
function ago(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

async function settle(): Promise<void> {
  while (harness.after.length > 0) {
    await Promise.all(harness.after.splice(0));
  }
}

type Delivery = {
  domain: string;
  // `undefined` : en-tête absent. Chaîne : envoyée telle quelle.
  triggeredAt?: string;
  webhookId?: string;
  topic?: string;
  body?: unknown;
  secret?: string;
  // Chemin opaque : jeton d'URL. `headerDomain` : `null` pour l'omettre.
  token?: string;
  headerDomain?: string | null;
};

function headersFor(delivery: Delivery, rawBody: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': sign(rawBody, delivery.secret ?? APP_A.secret),
    'x-shopify-topic': delivery.topic ?? 'app/uninstalled',
    'x-shopify-webhook-id': delivery.webhookId ?? `wps1b-${crypto.randomUUID()}`,
  };
  if (delivery.triggeredAt !== undefined) {
    headers['x-shopify-triggered-at'] = delivery.triggeredAt;
  }
  const headerDomain =
    delivery.headerDomain === undefined ? delivery.domain : delivery.headerDomain;
  if (headerDomain) {
    headers['x-shopify-shop-domain'] = headerDomain;
  }
  return headers;
}

// Chemin GLOBAL : endpoint historique, boutique résolue par l'en-tête (D20b).
async function deliverGlobal(delivery: Delivery): Promise<Response> {
  const rawBody = JSON.stringify(delivery.body ?? {});
  const response = await legacyPost(
    new Request('http://localhost:3000/api/shopify/webhooks', {
      method: 'POST',
      headers: headersFor(delivery, rawBody),
      body: rawBody,
    }),
  );
  await settle();
  return response;
}

// Chemin OPAQUE : boutique résolue par le jeton d'URL.
async function deliverOpaque(delivery: Delivery & { token: string }): Promise<Response> {
  const rawBody = JSON.stringify(delivery.body ?? {});
  const response = await ingestPost(
    new Request('http://localhost:3000/api/shopify/ingest/redacted', {
      method: 'POST',
      headers: headersFor(delivery, rawBody),
      body: rawBody,
    }),
    { params: Promise.resolve({ token: delivery.token }) },
  );
  await settle();
  return response;
}

function deliver(path: Path, delivery: Delivery & { token: string }): Promise<Response> {
  return path === 'opaque' ? deliverOpaque(delivery) : deliverGlobal(delivery);
}

// Boutique connectée, avec sa connexion et son jeton d'URL opaque.
async function connectedShop(
  label: string,
  acquiredAgoSeconds: number | null,
  clientId = APP_A.clientId,
) {
  const domain = freshDomain(label);
  const shop = await seedConnectedShop(tenant, domain, {
    clientId,
    credentialsAcquiredAgoSeconds: acquiredAgoSeconds,
  });
  const { createWebhookToken } = await import('@/lib/ingestion/webhook-token-provisioning');
  const created = await createWebhookToken(service(), shop.connectionId);
  if (!created.ok) throw new Error('jeton L3');
  return { ...shop, token: `${created.token.publicId}.${created.token.secret}` };
}

// « Réinstallation » : la boutique redevient active, sa borne d'acquisition est posée.
async function reinstall(domain: string, acquiredAgoSeconds: number) {
  const { encryptToken } = await import('@/lib/shopify/crypto');
  const client = await pg();
  await client.query(
    `update public.shop
        set status = 'active', uninstalled_at = null, access_token_encrypted = $2,
            credentials_acquired_at = now() - make_interval(secs => $3::double precision)
      where shop_domain = $1`,
    [domain, encryptToken(`synthetic-test-access-${crypto.randomUUID()}`), acquiredAgoSeconds],
  );
  await client.query(
    `update public.store_connection set status = 'active', uninstalled_at = null
      where platform = 'shopify' and external_identifier = $1`,
    [domain],
  );
}

// Installation en attente. `acquiredAgoSeconds` NULL : attente antérieure au lot (repli sur
// `created_at`, posé par `createdAgoSeconds`).
async function seedPending(
  domain: string,
  options: { acquiredAgoSeconds: number | null; createdAgoSeconds?: number; clientId?: string },
) {
  await (await pg()).query(
    `insert into public.shopify_pending_installation (shop_domain, shopify_client_id,
       access_token_encrypted, scopes, ticket_hash, expires_at, credentials_acquired_at, created_at)
     values ($1, $2, $3, 'read_orders', $4, now() + interval '30 minutes',
       case when $5::double precision is null then null
            else now() - make_interval(secs => $5::double precision) end,
       now() - make_interval(secs => $6::double precision))`,
    [
      domain,
      options.clientId ?? APP_A.clientId,
      `synthetic-test-pending-${crypto.randomUUID()}`,
      randomBytes(32).toString('hex'),
      options.acquiredAgoSeconds,
      options.createdAgoSeconds ?? options.acquiredAgoSeconds ?? 0,
    ],
  );
}

async function pendingCount(domain: string): Promise<number> {
  const { rows } = await (await pg()).query(
    `select count(*)::int as n from public.shopify_pending_installation
      where shop_domain = $1 and consumed_at is null`,
    [domain],
  );
  return rows[0].n as number;
}

async function shopRow(domain: string) {
  const { rows } = await (await pg()).query(
    `select id, status, access_token_encrypted is not null as has_token
       from public.shop where shop_domain = $1`,
    [domain],
  );
  return rows[0] as { id: string; status: string; has_token: boolean } | undefined;
}

async function connectionRow(domain: string) {
  const { rows } = await (await pg()).query(
    `select status, uninstalled_at::text as uninstalled_at from public.store_connection
      where platform = 'shopify' and external_identifier = $1`,
    [domain],
  );
  return rows[0] as { status: string; uninstalled_at: string | null } | undefined;
}

async function uninstallAuditCount(shopId: string): Promise<number> {
  const { rows } = await (await pg()).query(
    `select count(*)::int as n from public.audit_log
      where action = 'shopify.app_uninstalled' and resource_id = $1`,
    [shopId],
  );
  return rows[0].n as number;
}

async function tokenLease(domain: string) {
  const { rows } = await (await pg()).query(
    `select generation::int as generation, lease_expires_at
       from public.shopify_token_lease where shop_domain = $1`,
    [domain],
  );
  return rows[0] as { generation: number; lease_expires_at: Date | null } | undefined;
}

async function webhookEventCount(webhookId: string): Promise<number> {
  const { rows } = await (await pg()).query(
    'select count(*)::int as n from public.webhook_event where shopify_webhook_id = $1',
    [webhookId],
  );
  return rows[0].n as number;
}

function sentinels(message: string) {
  return harness.sentry.filter((entry) => entry.message === message);
}

beforeAll(async () => {
  if (!hasStack) return;
  for (const key of SHOPIFY_ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  // Deux apps fictives, enregistrées AVANT le chargement des routes (le registre lit
  // l'environnement une fois). Valeur factice de RESEND_API_KEY, limitée à ce processus.
  process.env.SHOPIFY_API_KEY = APP_A.clientId;
  process.env.SHOPIFY_API_SECRET = APP_A.secret;
  process.env.SHOPIFY_PILOTE_API_KEY = APP_B.clientId;
  process.env.SHOPIFY_PILOTE_API_SECRET = APP_B.secret;
  process.env.RESEND_API_KEY = 'synthetic-test-local-placeholder';
  ensureTestEncryptionKey();
  removeNetworkGuard = installShopifyNetworkGuard();

  legacyPost = (await import('@/app/api/shopify/webhooks/route')).POST as LegacyPost;
  ingestPost = (await import('@/app/api/shopify/ingest/[token]/route')).POST as IngestPost;
  tenant = await createTenant('wps1b-order');
}, 120_000);

beforeEach(() => {
  harness.sentry.length = 0;
});

afterEach(async () => {
  await settle();
  await cleanupDomains();
});

afterAll(async () => {
  await closePg();
  await cleanupTenants();
  removeNetworkGuard();
  for (const key of SHOPIFY_ENV_KEYS) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

const ORDERS: Array<[Path, Path]> = [
  ['global', 'opaque'],
  ['opaque', 'global'],
];

describe('W5 — double livraison du même événement (Event-Id commun, Webhook-Id distincts)', () => {
  // Désinstallation à 0 s (il y a 40 s), attente à `pendingAt` s, seconde livraison à 40 s.
  async function doubleDelivery(first: Path, second: Path, pendingAtSeconds: number) {
    const shop = await connectedShop(`w5-${first}-${pendingAtSeconds}`, 200);
    const eventAt = ago(40);

    const firstResponse = await deliver(first, { ...shop, triggeredAt: eventAt });
    expect(firstResponse.status).toBe(200);
    expect((await shopRow(shop.domain))?.status).toBe('uninstalled');
    const connectionAfterFirst = await connectionRow(shop.domain);
    expect(connectionAfterFirst?.status).toBe('uninstalled');
    expect(await uninstallAuditCount(shop.shopId)).toBe(1);

    // Réautorisation en branche 2, `pendingAt` secondes après l'événement.
    await seedPending(shop.domain, { acquiredAgoSeconds: 40 - pendingAtSeconds });

    const secondResponse = await deliver(second, { ...shop, triggeredAt: eventAt });
    expect(secondResponse.status).toBe(200);
    return { shop, connectionAfterFirst };
  }

  it.skipIf(!hasStack).each(ORDERS)(
    'contre-exemple de la revue (%s puis %s) : attente à 30 s CONSERVÉE, une seule transition',
    async (first, second) => {
      const { shop, connectionAfterFirst } = await doubleDelivery(first, second, 30);

      // 30 ≥ 0 + 10 : l'attente est postérieure de plus de la marge, elle est conservée.
      expect(await pendingCount(shop.domain)).toBe(1);
      // Chaque effet métier, séparément : un seul audit, une seule écriture de store_connection.
      expect(await uninstallAuditCount(shop.shopId)).toBe(1);
      expect(await connectionRow(shop.domain)).toEqual(connectionAfterFirst);
      expect((await shopRow(shop.domain))?.status).toBe('uninstalled');
      expect(sentinels('shopify_pending_installation_deleted_on_uninstall')).toHaveLength(0);
      // Le bail préempté par chaque livraison est rendu.
      expect((await tokenLease(shop.domain))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack).each(ORDERS)(
    'dans la marge (%s puis %s) : attente à 5 s SUPPRIMÉE — coût nommé de G4',
    async (first, second) => {
      const { shop, connectionAfterFirst } = await doubleDelivery(first, second, 5);

      expect(await pendingCount(shop.domain)).toBe(0);
      expect(sentinels('shopify_pending_installation_deleted_on_uninstall')).toHaveLength(1);
      // La suppression de l'attente n'entraîne ni audit ni écriture de store_connection.
      expect(await uninstallAuditCount(shop.shopId)).toBe(1);
      expect(await connectionRow(shop.domain)).toEqual(connectionAfterFirst);
    },
  );
});

describe('W6 — livraison tardive de la désinstallation n°1 après une réinstallation', () => {
  // Désinstallation n°1 à 0 s (il y a 40 s), jamais traitée ; réinstallation à `reinstallAt` s.
  async function lateDelivery(path: Path, reinstallAtSeconds: number, fromRetryable: boolean) {
    const shop = await connectedShop(`w6-${path}-${reinstallAtSeconds}`, 200);
    await reinstall(shop.domain, 40 - reinstallAtSeconds);
    const eventAt = ago(40);
    const webhookId = `wps1b-w6-${crypto.randomUUID()}`;

    if (fromRetryable) {
      // La livraison n°1 était restée `retryable` (échec passager) AVANT la réinstallation.
      const { error } = await service()
        .from('webhook_event')
        .insert({
          shopify_webhook_id: webhookId,
          topic: 'app/uninstalled',
          shop_domain: shop.domain,
          shop_id: shop.shopId,
          merchant_account_id: tenant.merchantAccountId,
          triggered_at: eventAt,
          payload: {},
          status: 'retryable',
          attempt_count: 1,
          next_attempt_at: ago(60),
        });
      if (error) throw new Error(`webhook_event : ${error.message}`);
    }

    // Un tiers tient le bail des jetons (rafraîchissement en cours sur la boutique saine).
    const { acquireShopifyTokenLease } = await import('@/lib/shopify/token-lease');
    const held = await acquireShopifyTokenLease(service(), shop.domain);
    if (!held.ok) throw new Error('bail');

    const response = await deliver(path, { ...shop, triggeredAt: eventAt, webhookId });
    expect(response.status).toBe(200);
    return { shop, heldGeneration: held.generation };
  }

  const CASES: Array<[Path, boolean]> = [
    ['global', false],
    ['opaque', false],
    ['global', true],
    ['opaque', true],
  ];

  it.skipIf(!hasStack).each(CASES)(
    'réinstallation à 30 s (%s, reprise depuis retryable : %s) : la nouvelle installation RESTE connectée',
    async (path, fromRetryable) => {
      const { shop, heldGeneration } = await lateDelivery(path, 30, fromRetryable);

      // 0 < 30 − 10 : l'événement est ancien, il est ignoré.
      expect(await shopRow(shop.domain)).toMatchObject({ status: 'active', has_token: true });
      expect((await connectionRow(shop.domain))?.status).toBe('active');
      expect(await uninstallAuditCount(shop.shopId)).toBe(0);
      expect(sentinels('shopify_uninstall_stale_ignored')).toHaveLength(1);
      // Génération NULL → aucune préemption, aucune libération : le bail du tiers est intact.
      const lease = await tokenLease(shop.domain);
      expect(lease?.generation).toBe(heldGeneration);
      expect(lease?.lease_expires_at).not.toBeNull();
    },
  );

  it.skipIf(!hasStack).each(CASES)(
    'dans la marge — réinstallation à 5 s (%s, reprise : %s) : désinstallée, coût nommé',
    async (path, fromRetryable) => {
      const { shop } = await lateDelivery(path, 5, fromRetryable);

      // 0 ≥ 5 − 10 : dans la marge, l'issue récupérable est la désinstallation.
      expect(await shopRow(shop.domain)).toMatchObject({ status: 'uninstalled', has_token: false });
      expect((await connectionRow(shop.domain))?.status).toBe('uninstalled');
      expect(await uninstallAuditCount(shop.shopId)).toBe(1);
    },
  );
});

describe('W7 et W7b — frontière de G5 : la borne est celle du grant, jamais celle de la persistance', () => {
  const APP_CONFIG = {
    clientId: APP_A.clientId,
    clientSecret: APP_A.secret,
    distribution: 'public' as const,
  };

  // Grant sans session (branche 2). `exchangeSeconds` : durée simulée de l'échange OAuth — le
  // bail, pris AVANT l'échange, est antidaté d'autant pendant que l'échange « dure ».
  async function authorize(domain: string, exchangeSeconds = 0): Promise<string> {
    const { performNoSessionAuthorization } = await import(
      '@/lib/shopify/no-session-authorization'
    );
    const result = await performNoSessionAuthorization(
      service(),
      { shopDomain: domain, app: APP_CONFIG, code: 'authorization-code' },
      {
        exchangeCode: (async () => {
          if (exchangeSeconds > 0) {
            await (await pg()).query(
              `update public.shopify_token_lease
                  set acquired_at = acquired_at - make_interval(secs => $2::double precision)
                where shop_domain = $1`,
              [domain, exchangeSeconds],
            );
          }
          return {
            accessToken: `synthetic-test-access-${crypto.randomUUID()}`,
            refreshToken: `synthetic-test-refresh-${crypto.randomUUID()}`,
            scope: 'read_orders',
            accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
            refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
          };
        }) as never,
        syncProducts: async () => true,
        reconcileWebhooks: async () => true,
      },
    );
    if (result.kind !== 'pending') throw new Error(`attendu : pending, reçu ${result.kind}`);
    return result.ticket;
  }

  async function claim(ticket: string) {
    const { performShopifyClaim } = await import('@/lib/shopify/claim-core');
    return performShopifyClaim(
      service(),
      {
        ticket,
        userId: tenant.userId,
        merchantAccountId: tenant.merchantAccountId,
        resolveApp: (clientId) => (clientId === APP_A.clientId ? APP_CONFIG : null),
      },
      { syncProducts: async () => true, reconcileWebhooks: async () => true },
    );
  }

  it.skipIf(!hasStack)(
    'W7 (a) — attente, POST, puis désinstallation : la désinstallation est traitée',
    async () => {
      const domain = freshDomain('w7a');
      const ticket = await authorize(domain);
      expect(await claim(ticket)).toMatchObject({ kind: 'connected' });

      await deliverGlobal({ domain, triggeredAt: new Date().toISOString() });

      expect(await shopRow(domain)).toMatchObject({ status: 'uninstalled', has_token: false });
    },
  );

  it.skipIf(!hasStack)(
    'W7 (b) — attente, désinstallation traitée, puis POST : POST refusé (ticket_invalid)',
    async () => {
      const domain = freshDomain('w7b-order');
      const ticket = await authorize(domain);

      await deliverGlobal({ domain, triggeredAt: new Date().toISOString() });
      expect(await pendingCount(domain)).toBe(0);

      expect(await claim(ticket)).toEqual({ kind: 'error', code: 'ticket_invalid' });
      expect(await shopRow(domain)).toBeUndefined();
    },
  );

  it.skipIf(!hasStack)(
    'W7 (c) — POST et désinstallation simultanés : jamais de jetons révoqués réactivés',
    async () => {
      for (let round = 0; round < 5; round += 1) {
        const domain = freshDomain(`w7c-${round}`);
        const ticket = await authorize(domain);

        await Promise.all([
          claim(ticket),
          deliverGlobal({ domain, triggeredAt: new Date().toISOString() }),
        ]);
        await settle();

        // Équivalent à (a) — rattachée puis désinstallée — ou à (b) — jamais rattachée.
        const shop = await shopRow(domain);
        expect(shop === undefined || shop.status === 'uninstalled').toBe(true);
        expect(shop?.has_token ?? false).toBe(false);
        expect(await pendingCount(domain)).toBe(0);
      }
    },
  );

  it.skipIf(!hasStack)(
    'W7b — grant à 0 s, désinstallation à 1 s, persistance à 20 s : événement TRAITÉ, jamais stale_ignored',
    async () => {
      const domain = freshDomain('w7b');
      // L'échange OAuth « dure » 20 s : le bail a été acquis 20 s avant la persistance.
      const ticket = await authorize(domain, 20);
      expect(await claim(ticket)).toMatchObject({ kind: 'connected' });
      const { rows } = await (await pg()).query(
        `select extract(epoch from (now() - credentials_acquired_at))::float as age
           from public.shop where shop_domain = $1`,
        [domain],
      );
      // La borne écrite est celle du bail (≈ 20 s), pas celle de la persistance (≈ 0 s).
      expect(rows[0].age).toBeGreaterThan(19);

      // Désinstallation réelle 1 s après le grant, soit il y a 19 s.
      await deliverGlobal({ domain, triggeredAt: ago(19) });

      // 1 ≥ 0 − 10 : traité. Une borne prise à la persistance (20 s) l'aurait jugé ancien.
      expect(await shopRow(domain)).toMatchObject({ status: 'uninstalled', has_token: false });
      expect(sentinels('shopify_uninstall_stale_ignored')).toHaveLength(0);
    },
  );
});

describe('W8 — attente antérieure, postérieure, et zone de marge', () => {
  // Événement à 0 s (il y a 40 s), sans boutique rattachée : chemin global.
  async function pendingAfterUninstall(options: {
    acquiredAtSeconds: number | null;
    createdAtSeconds?: number;
  }) {
    const domain = freshDomain('w8');
    await seedPending(domain, {
      acquiredAgoSeconds:
        options.acquiredAtSeconds === null ? null : 40 - options.acquiredAtSeconds,
      createdAgoSeconds:
        options.createdAtSeconds === undefined ? undefined : 40 - options.createdAtSeconds,
    });
    const response = await deliverGlobal({ domain, triggeredAt: ago(40) });
    expect(response.status).toBe(200);
    return pendingCount(domain);
  }

  it.skipIf(!hasStack)('attente ANTÉRIEURE à l’événement (−30 s) : supprimée', async () => {
    expect(await pendingAfterUninstall({ acquiredAtSeconds: -30 })).toBe(0);
  });

  it.skipIf(!hasStack)('attente POSTÉRIEURE de plus de la marge (+30 s) : conservée', async () => {
    expect(await pendingAfterUninstall({ acquiredAtSeconds: 30 })).toBe(1);
  });

  it.skipIf(!hasStack)('attente dans la marge (+5 s) : supprimée — issue récupérable', async () => {
    expect(await pendingAfterUninstall({ acquiredAtSeconds: 5 })).toBe(0);
  });

  it.skipIf(!hasStack)(
    'attente antérieure au lot (borne NULL) : repli sur created_at, dans les deux sens',
    async () => {
      expect(await pendingAfterUninstall({ acquiredAtSeconds: null, createdAtSeconds: 30 })).toBe(
        1,
      );
      expect(await pendingAfterUninstall({ acquiredAtSeconds: null, createdAtSeconds: -30 })).toBe(
        0,
      );
    },
  );

  it.skipIf(!hasStack)(
    'l’attente d’une AUTRE app du même domaine n’est jamais touchée',
    async () => {
      const domain = freshDomain('w8-other-app');
      await seedPending(domain, { acquiredAgoSeconds: 70, clientId: APP_B.clientId });

      await deliverGlobal({ domain, triggeredAt: ago(40) });

      expect(await pendingCount(domain)).toBe(1);
    },
  );
});

describe('W9 — horodatage absent, illisible ou dans le futur', () => {
  const CASES: Array<[string, string | undefined, string]> = [
    ['absent', undefined, 'absent'],
    ['illisible', 'pas-une-date', 'unreadable'],
    ['forme lâche refusée', 'Oct 3 2026', 'unreadable'],
    ['dans le futur', new Date(Date.now() + 3_600_000).toISOString(), 'future'],
  ];

  it.skipIf(!hasStack).each(CASES)(
    '%s : désinstallation ET suppression de l’attente, sentinelle expurgée',
    async (_label, triggeredAt, anomaly) => {
      // Boutique dont la borne est récente : un horodatage ANCIEN et lisible l'aurait protégée.
      const shop = await connectedShop(`w9-${anomaly}`, 10);
      await seedPending(shop.domain, { acquiredAgoSeconds: 5 });

      const response = await deliverGlobal({ domain: shop.domain, triggeredAt });

      expect(response.status).toBe(200);
      expect(await shopRow(shop.domain)).toMatchObject({ status: 'uninstalled', has_token: false });
      expect(await pendingCount(shop.domain)).toBe(0);
      const unusable = sentinels('shopify_uninstall_triggered_at_unusable');
      expect(unusable).toHaveLength(1);
      expect(unusable[0].tags).toEqual({ module: 'shopify.webhook-core', anomaly });
      // Expurgée : ni le domaine, ni la valeur reçue.
      expect(JSON.stringify(harness.sentry)).not.toContain(shop.domain);
      if (triggeredAt) expect(JSON.stringify(harness.sentry)).not.toContain(triggeredAt);
    },
  );

  it.skipIf(!hasStack)(
    'contrôle positif : le même état, avec un horodatage lisible et ancien → stale_ignored',
    async () => {
      const shop = await connectedShop('w9-positive', 10);

      await deliverGlobal({ domain: shop.domain, triggeredAt: ago(40) });

      expect((await shopRow(shop.domain))?.status).toBe('active');
      expect(sentinels('shopify_uninstall_triggered_at_unusable')).toHaveLength(0);
    },
  );
});

describe('W10 — époque NULL (connexion historique)', () => {
  it.skipIf(!hasStack).each<Path>(['global', 'opaque'])(
    '%s : aucune garde d’ancienneté — un événement d’hier désinstalle, comme avant le lot',
    async (path) => {
      const shop = await connectedShop(`w10-${path}`, null);

      const response = await deliver(path, { ...shop, triggeredAt: ago(86_400) });

      expect(response.status).toBe(200);
      expect(await shopRow(shop.domain)).toMatchObject({ status: 'uninstalled', has_token: false });
      expect((await connectionRow(shop.domain))?.status).toBe('uninstalled');
      expect(await uninstallAuditCount(shop.shopId)).toBe(1);
      expect((await tokenLease(shop.domain))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'contrôle positif : la même boutique avec une borne posée → le même événement est ignoré',
    async () => {
      const shop = await connectedShop('w10-positive', 60);

      await deliverGlobal({ domain: shop.domain, triggeredAt: ago(86_400) });

      expect((await shopRow(shop.domain))?.status).toBe('active');
    },
  );
});

describe('garde d’app — une désinstallation d’une autre app ne touche ni la boutique ni le bail', () => {
  it.skipIf(!hasStack)(
    'boutique rattachée à B, livraison signée par A : other_app, aucune libération',
    async () => {
      const shop = await connectedShop('other-app', 60, APP_B.clientId);
      const { acquireShopifyTokenLease } = await import('@/lib/shopify/token-lease');
      const held = await acquireShopifyTokenLease(service(), shop.domain);
      if (!held.ok) throw new Error('bail');

      // Corps sans domaine : l'app est identifiée par le HMAC, parmi toutes les apps.
      await deliverGlobal({ domain: shop.domain, triggeredAt: new Date().toISOString() });

      expect((await shopRow(shop.domain))?.status).toBe('active');
      const lease = await tokenLease(shop.domain);
      expect(lease?.generation).toBe(held.generation);
      expect(lease?.lease_expires_at).not.toBeNull();
    },
  );
});

describe('W4 — route opaque : en-tête divergent ou absent, jeton inconnu', () => {
  async function expectRefused(response: Response, webhookId: string) {
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
    expect(await webhookEventCount(webhookId)).toBe(0);
  }

  it.skipIf(!hasStack)('en-tête ABSENT : refus, aucune écriture', async () => {
    const shop = await connectedShop('w4-absent', 60);
    const webhookId = `wps1b-w4-${crypto.randomUUID()}`;

    const response = await deliverOpaque({ ...shop, webhookId, headerDomain: null });

    await expectRefused(response, webhookId);
    expect((await shopRow(shop.domain))?.status).toBe('active');
  });

  it.skipIf(!hasStack)('en-tête DIVERGENT : refus, aucune écriture, nulle part', async () => {
    const shop = await connectedShop('w4-divergent', 60);
    const victim = await connectedShop('w4-victim', 60);
    const webhookId = `wps1b-w4-${crypto.randomUUID()}`;

    const response = await deliverOpaque({ ...shop, webhookId, headerDomain: victim.domain });

    await expectRefused(response, webhookId);
    expect((await shopRow(shop.domain))?.status).toBe('active');
    expect((await shopRow(victim.domain))?.status).toBe('active');
  });

  it.skipIf(!hasStack)(
    'jeton inconnu : même réponse qu’un jeton connu mal accompagné — rien ne dit si la boutique existe',
    async () => {
      const shop = await connectedShop('w4-unknown', 60);
      const { generateWebhookToken } = await import('@/lib/ingestion/webhook-token');
      const unknown = await deliverOpaque({
        ...shop,
        token: generateWebhookToken().raw,
        webhookId: `wps1b-w4-${crypto.randomUUID()}`,
      });
      const known = await deliverOpaque({
        ...shop,
        webhookId: `wps1b-w4-${crypto.randomUUID()}`,
        headerDomain: null,
      });

      expect(unknown.status).toBe(known.status);
      expect(await unknown.text()).toBe(await known.text());
      expect([...unknown.headers.keys()].sort()).toEqual([...known.headers.keys()].sort());
    },
  );

  it.skipIf(!hasStack)(
    'contrôle positif : en-tête égal au domaine de la connexion → 200',
    async () => {
      const shop = await connectedShop('w4-positive', null);
      const webhookId = `wps1b-w4-${crypto.randomUUID()}`;

      const response = await deliverOpaque({
        ...shop,
        webhookId,
        triggeredAt: new Date().toISOString(),
      });

      expect(response.status).toBe(200);
      expect(await webhookEventCount(webhookId)).toBe(1);
      expect((await shopRow(shop.domain))?.status).toBe('uninstalled');
    },
  );
});

describe('W11 — connexion inactive : app/uninstalled contre topic métier', () => {
  // Boutique et connexion déjà désinstallées, jeton d'URL toujours valide.
  async function inactiveShop(label: string, clientId = APP_A.clientId) {
    const domain = freshDomain(label);
    const shop = await seedConnectedShop(tenant, domain, { clientId, status: 'uninstalled' });
    const { createWebhookToken } = await import('@/lib/ingestion/webhook-token-provisioning');
    const created = await createWebhookToken(service(), shop.connectionId);
    if (!created.ok) throw new Error('jeton L3');
    return { ...shop, token: `${created.token.publicId}.${created.token.secret}` };
  }

  it.skipIf(!hasStack)(
    'app/uninstalled est TRAITÉ : 200, l’attente antérieure est supprimée, la boutique inchangée',
    async () => {
      const shop = await inactiveShop('w11-uninstall');
      await seedPending(shop.domain, { acquiredAgoSeconds: 60 });
      const webhookId = `wps1b-w11-${crypto.randomUUID()}`;

      const response = await deliverOpaque({
        ...shop,
        webhookId,
        triggeredAt: new Date().toISOString(),
      });

      expect(response.status).toBe(200);
      // Pas un acquittement sans effet : l'attente antérieure est supprimée.
      expect(await pendingCount(shop.domain)).toBe(0);
      expect((await shopRow(shop.domain))?.status).toBe('uninstalled');
      // Aucune transition : ni audit, ni écriture de store_connection.
      expect(await uninstallAuditCount(shop.shopId)).toBe(0);
      expect(await webhookEventCount(webhookId)).toBe(1);
    },
  );

  it.skipIf(!hasStack)('un topic métier reste refusé : 401, aucune écriture', async () => {
    const shop = await inactiveShop('w11-order');
    await seedPending(shop.domain, { acquiredAgoSeconds: 60 });
    const webhookId = `wps1b-w11-${crypto.randomUUID()}`;

    const response = await deliverOpaque({
      ...shop,
      webhookId,
      topic: 'orders/create',
      body: { id: 990_101, name: '#W11', total_price: '1000', currency: 'XOF' },
      triggeredAt: new Date().toISOString(),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
    expect(await webhookEventCount(webhookId)).toBe(0);
    expect(await pendingCount(shop.domain)).toBe(1);
  });

  it.skipIf(!hasStack)(
    'le recoupement d’app s’applique AUSSI à une connexion inactive : signé par une autre app → 401',
    async () => {
      const shop = await inactiveShop('w11-other-app');
      await seedPending(shop.domain, { acquiredAgoSeconds: 60 });
      const webhookId = `wps1b-w11-${crypto.randomUUID()}`;

      const response = await deliverOpaque({
        ...shop,
        webhookId,
        secret: APP_B.secret,
        triggeredAt: new Date().toISOString(),
      });

      expect(response.status).toBe(401);
      expect(await webhookEventCount(webhookId)).toBe(0);
      expect(await pendingCount(shop.domain)).toBe(1);
    },
  );

  it.skipIf(!hasStack)(
    'contrôle positif : sur une connexion ACTIVE, un topic autre qu’app/uninstalled est accepté',
    async () => {
      const shop = await connectedShop('w11-positive', 60);
      const webhookId = `wps1b-w11-${crypto.randomUUID()}`;

      // Topic sans écriture métier : seule l'acceptation par la route est observée ici. La
      // persistance d'une commande par ce chemin est prouvée par
      // tests/e2e/shopify-ingest-token-endpoint.spec.ts.
      const response = await deliverOpaque({
        ...shop,
        webhookId,
        topic: 'shop/update',
        body: { id: 990_102 },
        triggeredAt: new Date().toISOString(),
      });

      expect(response.status).toBe(200);
      expect(await webhookEventCount(webhookId)).toBe(1);
    },
  );
});
