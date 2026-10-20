// S1 / QStash — le balayage planifié, le cron quotidien et le balayage opportuniste en concurrence.
//
// Couche : intégration. Le VRAI gestionnaire `/api/shopify/ingest/[token]` est appelé avec une requête
// signée, contre PostgreSQL/PostgREST réels ; `replayPendingShopifyWebhooks`, les RPC
// `claim_shopify_webhook_events` et `finish_shopify_webhook_event` et le cœur métier sont réels.
// Substitué : `after()` de Next. Ses rappels sont retenus ; un test les exécute, un autre ne les
// exécute JAMAIS (c'est l'exécution tuée après la réponse). « Le temps passe » n'est pas simulé :
// le bail est reculé en base. Aucun appel à Shopify. Les apps et leurs secrets sont fictifs.
//
// Propriétés verrouillées :
//   - les trois voies de reprise lancées ENSEMBLE sur le même événement : une réclamation, une commande ;
//   - une signature invalide ne reprend rien, la voie signée reprend l'événement en attente.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type Tenant,
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
  held: [] as Array<() => Promise<unknown>>,
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after(callback: () => Promise<unknown>) {
    harness.held.push(callback);
  },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const APP = {
  clientId: 'ingest-sweep-app',
  secret: `synthetic-test-${randomBytes(12).toString('hex')}`,
};
const ENV_KEYS = [
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

type IngestPost = (
  request: Request,
  context: { params: Promise<{ token: string }> },
) => Promise<Response>;

const SWEEP_URL = 'https://webhooks.synthetic-test.example/api/internal/shopify-webhook-sweep';
const QSTASH_KEYS = {
  current: randomBytes(16).toString('hex'),
  next: randomBytes(16).toString('hex'),
};
const CRON_SECRET = `synthetic-cron-${randomBytes(8).toString('hex')}`;
const EXTRA_ENV = [
  'QSTASH_SWEEP_URL',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
  'CRON_SECRET',
] as const;

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

function qstashSignature(key: string, body: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: 'Upstash',
      sub: SWEEP_URL,
      exp: now + 300,
      nbf: now - 5,
      iat: now - 5,
      jti: `jwt_${randomBytes(6).toString('hex')}`,
      body: createHash('sha256').update(body).digest('base64url'),
    }),
  );
  return `${header}.${payload}.${b64url(createHmac('sha256', key).update(`${header}.${payload}`).digest())}`;
}

type QstashPost = (request: Request) => Promise<Response>;
type CronGet = (request: never) => Promise<Response>;

const previousEnv = new Map<string, string | undefined>();
let qstashPost: QstashPost;
let cronGet: CronGet;
let ingestPost: IngestPost;
let tenant: Tenant;
let removeNetworkGuard: () => void = () => undefined;

function sign(body: string): string {
  return createHmac('sha256', APP.secret).update(body, 'utf8').digest('base64');
}

function orderPayload(shopifyOrderId: string) {
  return {
    created_at: new Date().toISOString(),
    currency: 'XOF',
    financial_status: 'pending',
    fulfillment_status: null,
    id: shopifyOrderId,
    line_items: [{ price: '5000', quantity: 2, title: 'Article de balayage' }],
    name: `#${shopifyOrderId}`,
    total_price: '10000',
    updated_at: new Date().toISOString(),
  };
}

async function connectedShop(label: string) {
  const domain = freshDomain(label);
  const shop = await seedConnectedShop(tenant, domain, { clientId: APP.clientId });
  const { createWebhookToken } = await import('@/lib/ingestion/webhook-token-provisioning');
  const created = await createWebhookToken(service(), shop.connectionId);
  if (!created.ok) throw new Error('jeton L3');
  return { ...shop, token: `${created.token.publicId}.${created.token.secret}` };
}

async function deliver(shop: { domain: string; token: string }, shopifyOrderId: string) {
  const webhookId = `sweep-${crypto.randomUUID()}`;
  const rawBody = JSON.stringify(orderPayload(shopifyOrderId));
  const response = await ingestPost(
    new Request('http://localhost:3000/api/shopify/ingest/redacted', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': sign(rawBody),
        'x-shopify-shop-domain': shop.domain,
        'x-shopify-topic': 'orders/create',
        'x-shopify-triggered-at': new Date().toISOString(),
        'x-shopify-webhook-id': webhookId,
      },
      body: rawBody,
    }),
    { params: Promise.resolve({ token: shop.token }) },
  );
  return { response, webhookId };
}

/** Le processus est tué après la réponse : les rappels ne s'exécutent jamais. */
function killProcessAfterResponse(): void {
  harness.held.length = 0;
}

async function eventOf(webhookId: string) {
  const { rows } = await (await pg()).query(
    `select id, status, attempt_count::int as attempt_count, lease_until
       from public.webhook_event where shopify_webhook_id = $1`,
    [webhookId],
  );
  return rows[0] as { id: string; status: string; attempt_count: number; lease_until: Date | null };
}

async function orderCount(shopId: string, shopifyOrderId: string) {
  const { rows } = await (await pg()).query(
    `select count(*)::int as orders,
            (select count(*)::int from public.order_line l
              join public.orders o2 on o2.id = l.order_id
             where o2.shop_id = $1 and o2.shopify_order_id = $2) as lines
       from public.orders where shop_id = $1 and shopify_order_id = $2`,
    [shopId, shopifyOrderId],
  );
  return rows[0] as { orders: number; lines: number };
}

async function leaseExpired(eventId: string) {
  await (await pg()).query(
    `update public.webhook_event set lease_until = now() - interval '3 minutes' where id = $1`,
    [eventId],
  );
}

beforeAll(async () => {
  if (!hasStack) return;
  for (const key of [...ENV_KEYS, ...EXTRA_ENV]) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.QSTASH_SWEEP_URL = SWEEP_URL;
  process.env.QSTASH_CURRENT_SIGNING_KEY = QSTASH_KEYS.current;
  process.env.QSTASH_NEXT_SIGNING_KEY = QSTASH_KEYS.next;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.SHOPIFY_API_KEY = APP.clientId;
  process.env.SHOPIFY_API_SECRET = APP.secret;
  process.env.RESEND_API_KEY = 'synthetic-test-local-placeholder';
  ensureTestEncryptionKey();
  removeNetworkGuard = installShopifyNetworkGuard();
  ingestPost = (await import('@/app/api/shopify/ingest/[token]/route')).POST as IngestPost;
  qstashPost = (await import('@/app/api/internal/shopify-webhook-sweep/route')).POST as QstashPost;
  cronGet = (await import('@/app/api/cron/shopify-webhook-retry/route')).GET as CronGet;
  tenant = await createTenant('ingest-sweep');
}, 120_000);

afterEach(async () => {
  harness.held.length = 0;
  const { resetOpportunisticSweepThrottleForTests } = await import(
    '@/lib/shopify/webhook-opportunistic-sweep'
  );
  resetOpportunisticSweepThrottleForTests();
});

// Le nettoyage passe par la suppression du compte de test (cascade), comme la suite de reprise : les
// lignes d'audit d'accès écrites par le traitement d'une commande sont en ajout seul et ne se suppriment
// pas boutique par boutique.
afterAll(async () => {
  await cleanupTenants();
  await closePg();
  removeNetworkGuard();
  for (const key of [...ENV_KEYS, ...EXTRA_ENV]) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

const suite = hasStack ? describe : describe.skip;

function signedSweep(key = QSTASH_KEYS.current) {
  const body = '{}';
  return qstashPost(
    new Request(SWEEP_URL, {
      method: 'POST',
      body,
      headers: { 'upstash-signature': qstashSignature(key, body) },
    }),
  );
}

function cronRun() {
  return cronGet(
    new Request('http://localhost:3000/api/cron/shopify-webhook-retry', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }) as never,
  );
}

suite('reprise des webhooks Shopify — voies planifiée, quotidienne et opportuniste', () => {
  it.each([1, 2, 3])(
    'les trois voies lancées ensemble sur un événement resté en attente (essai %i) : une réclamation, une commande',
    async (attempt) => {
      const shop = await connectedShop(`qs-race-${attempt}`);
      const orderId = `${Date.now()}${attempt}`;
      const { webhookId } = await deliver(shop, orderId);
      killProcessAfterResponse();
      await leaseExpired((await eventOf(webhookId)).id);

      const { sweepPendingShopifyWebhooks, resetOpportunisticSweepThrottleForTests } = await import(
        '@/lib/shopify/webhook-opportunistic-sweep'
      );
      resetOpportunisticSweepThrottleForTests();
      const results = await Promise.all([
        signedSweep(),
        cronRun(),
        sweepPendingShopifyWebhooks(service()),
      ]);

      expect((results[0] as Response).status).toBe(200);
      expect((results[1] as Response).status).toBe(200);
      expect(await eventOf(webhookId)).toMatchObject({ status: 'done', attempt_count: 2 });
      expect(await orderCount(shop.shopId, orderId)).toEqual({ orders: 1, lines: 1 });
    },
  );

  it('une signature invalide ne reprend rien ; la voie signée, avec la clé suivante, reprend l’événement', async () => {
    const shop = await connectedShop('qs-sign');
    const orderId = `${Date.now()}9`;
    const { webhookId } = await deliver(shop, orderId);
    killProcessAfterResponse();
    await leaseExpired((await eventOf(webhookId)).id);

    const refused = await signedSweep(randomBytes(16).toString('hex'));
    expect(refused.status).toBe(401);
    expect(await eventOf(webhookId)).toMatchObject({ status: 'processing', attempt_count: 1 });
    expect(await orderCount(shop.shopId, orderId)).toEqual({ orders: 0, lines: 0 });

    const accepted = await signedSweep(QSTASH_KEYS.next);
    expect(accepted.status).toBe(200);
    expect(await eventOf(webhookId)).toMatchObject({ status: 'done', attempt_count: 2 });
    expect(await orderCount(shop.shopId, orderId)).toEqual({ orders: 1, lines: 1 });
  });
});
