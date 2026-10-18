// S1 — accusé après persistance et balayage opportuniste, sur la route opaque.
//
// Couche : intégration. Le VRAI gestionnaire `/api/shopify/ingest/[token]` est appelé avec une requête
// signée, contre PostgreSQL/PostgREST réels ; `replayPendingShopifyWebhooks`, les RPC
// `claim_shopify_webhook_events` et `finish_shopify_webhook_event` et le cœur métier sont réels.
// Substitué : `after()` de Next. Ses rappels sont retenus ; un test les exécute, un autre ne les
// exécute JAMAIS (c'est l'exécution tuée après la réponse). « Le temps passe » n'est pas simulé :
// le bail est reculé en base. Aucun appel à Shopify. Les apps et leurs secrets sont fictifs.
//
// Propriétés verrouillées :
//   - la livraison est durable AVANT le 200 : ligne `processing`, bail ~5 min, aucune commande ;
//   - exécution tuée après le 200 : la commande n'existe pas, puis le balayage la crée, une fois ;
//   - deux balayages simultanés sur le même événement : une commande, une réclamation ;
//   - une livraison suivante reprend, par son balayage, l'événement resté en attente.
import { createHmac, randomBytes } from 'node:crypto';
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

vi.mock('next/server', () => ({
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

const previousEnv = new Map<string, string | undefined>();
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

/** Exécute les rappels retenus de `after()` : le processus a survécu à la réponse. */
async function runHeldAfterCallbacks(): Promise<void> {
  const callbacks = harness.held.splice(0);
  await Promise.all(callbacks.map((callback) => callback()));
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
  for (const key of ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.SHOPIFY_API_KEY = APP.clientId;
  process.env.SHOPIFY_API_SECRET = APP.secret;
  process.env.RESEND_API_KEY = 'synthetic-test-local-placeholder';
  ensureTestEncryptionKey();
  removeNetworkGuard = installShopifyNetworkGuard();
  ingestPost = (await import('@/app/api/shopify/ingest/[token]/route')).POST as IngestPost;
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
  for (const key of ENV_KEYS) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

const suite = hasStack ? describe : describe.skip;

suite('route opaque — accusé après persistance et balayage opportuniste', () => {
  it('persiste durablement la livraison avant le 200, sans l’avoir encore traitée', async () => {
    const shop = await connectedShop('s1-ack');
    const orderId = `${Date.now()}1`;

    const { response, webhookId } = await deliver(shop, orderId);

    expect(response.status).toBe(200);
    const event = await eventOf(webhookId);
    expect(event).toMatchObject({ status: 'processing', attempt_count: 1 });
    const leaseMs = (event.lease_until?.getTime() ?? 0) - Date.now();
    expect(leaseMs).toBeGreaterThan(4 * 60_000);
    expect(await orderCount(shop.shopId, orderId)).toEqual({ orders: 0, lines: 0 });
  });

  it('exécution tuée après le 200 : rien n’est perdu, le balayage crée la commande une fois', async () => {
    const shop = await connectedShop('s1-crash');
    const orderId = `${Date.now()}2`;
    const { response, webhookId } = await deliver(shop, orderId);
    expect(response.status).toBe(200);
    killProcessAfterResponse();

    // Bail non expiré : le balayage n'y touche pas (l'exécution pourrait être vivante).
    const { sweepPendingShopifyWebhooks, resetOpportunisticSweepThrottleForTests } = await import(
      '@/lib/shopify/webhook-opportunistic-sweep'
    );
    await sweepPendingShopifyWebhooks(service());
    expect((await eventOf(webhookId)).status).toBe('processing');
    expect(await orderCount(shop.shopId, orderId)).toEqual({ orders: 0, lines: 0 });

    // Le temps passe : le bail expire au-delà de la marge.
    await leaseExpired((await eventOf(webhookId)).id);
    resetOpportunisticSweepThrottleForTests();
    await sweepPendingShopifyWebhooks(service());

    expect(await eventOf(webhookId)).toMatchObject({ status: 'done', attempt_count: 2 });
    expect(await orderCount(shop.shopId, orderId)).toEqual({ orders: 1, lines: 1 });
  });

  it('deux balayages simultanés sur le même événement : une réclamation, une commande', async () => {
    const shop = await connectedShop('s1-race');
    const orderId = `${Date.now()}3`;
    const { webhookId } = await deliver(shop, orderId);
    killProcessAfterResponse();
    await leaseExpired((await eventOf(webhookId)).id);

    const { sweepPendingShopifyWebhooks, resetOpportunisticSweepThrottleForTests } = await import(
      '@/lib/shopify/webhook-opportunistic-sweep'
    );
    resetOpportunisticSweepThrottleForTests();
    const first = sweepPendingShopifyWebhooks(service());
    resetOpportunisticSweepThrottleForTests();
    const second = sweepPendingShopifyWebhooks(service());
    await Promise.all([first, second]);

    expect(await eventOf(webhookId)).toMatchObject({ status: 'done', attempt_count: 2 });
    expect(await orderCount(shop.shopId, orderId)).toEqual({ orders: 1, lines: 1 });
  });

  it('une livraison suivante reprend, par son propre balayage, l’événement resté en attente', async () => {
    const shop = await connectedShop('s1-next');
    const lostOrderId = `${Date.now()}4`;
    const { webhookId: lostWebhookId } = await deliver(shop, lostOrderId);
    killProcessAfterResponse();
    await leaseExpired((await eventOf(lostWebhookId)).id);

    const freshOrderId = `${Date.now()}5`;
    const { response, webhookId: freshWebhookId } = await deliver(shop, freshOrderId);
    expect(response.status).toBe(200);
    await runHeldAfterCallbacks();

    expect((await eventOf(freshWebhookId)).status).toBe('done');
    expect(await eventOf(lostWebhookId)).toMatchObject({ status: 'done', attempt_count: 2 });
    expect(await orderCount(shop.shopId, lostOrderId)).toEqual({ orders: 1, lines: 1 });
    expect(await orderCount(shop.shopId, freshOrderId)).toEqual({ orders: 1, lines: 1 });
  });
});
