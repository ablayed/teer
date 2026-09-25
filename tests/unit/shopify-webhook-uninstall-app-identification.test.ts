// SHOPIFY-EXPIRING-TOKENS-01 — identification de l'app validante sur l'endpoint legacy, pour
// `app/uninstalled`. La garde d'app de `uninstall_shopify_shop_fenced` reçoit l'app dont le HMAC a
// été validé, jamais `shop.shopify_client_id` (qui la rendrait tautologique).
//
// Sous-chemin visé : corps SANS domaine (repli sur l'en-tête, `allowHeaderFallback`). Le HMAC y
// était vérifié contre tous les secrets par `verifyWebhookHmacAnySecret`, qui ne rend qu'un
// booléen. Il passe désormais par `identifyValidatingApps`, et exige EXACTEMENT une
// correspondance : zéro ou plusieurs → 401, jamais un choix arbitraire.
//
// Les HMAC sont calculés réellement (node:crypto) : ni `webhook-verify` ni `adapter` ne sont
// simulés. Seuls le cœur partagé (écritures) et le registre d'apps (env) le sont.
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type App = { clientId: string; clientSecret: string };

const harness = vi.hoisted(() => ({
  apps: [] as App[],
  shopsByDomain: new Map<string, Record<string, unknown>>(),
  dispatched: [] as Array<Record<string, unknown>>,
  pending: [] as Array<Promise<unknown>>,
}));

vi.mock('next/server', () => ({
  after: (callback: () => Promise<unknown>) => {
    harness.pending.push(callback());
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/shopify/apps', () => ({
  getRegisteredShopifyApps: vi.fn(() => harness.apps),
  getShopifyAppByClientId: vi.fn(
    (clientId: string | null) => harness.apps.find((app) => app.clientId === clientId) ?? null,
  ),
  getDefaultShopifyAppOrNull: vi.fn(() => harness.apps[0] ?? null),
  getShopifyAppForShop: vi.fn(
    (clientId: string | null) =>
      harness.apps.find((app) => app.clientId === clientId) ?? harness.apps[0] ?? null,
  ),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({})),
}));

vi.mock('@/lib/shopify/webhook-core', () => ({
  resolveShopLenient: vi.fn(
    async (_supabase: unknown, locator: { shopDomain: string }) =>
      harness.shopsByDomain.get(locator.shopDomain) ?? null,
  ),
  resolveShopForTopic: vi.fn(
    async (_supabase: unknown, _topic: string, locator: { shopDomain: string }) =>
      harness.shopsByDomain.get(locator.shopDomain) ?? null,
  ),
  recordWebhookReceipt: vi.fn(async () => ({ eventId: 'evt-1', duplicate: false, error: null })),
  runResolvedWebhookEvent: vi.fn(async (args: Record<string, unknown>) => {
    harness.dispatched.push(args);
  }),
  finishWebhookStatus: vi.fn(async () => undefined),
  isReceiptDue: vi.fn(() => false),
  isTerminalWebhookError: vi.fn(() => true),
  toJson: vi.fn((value: unknown) => value),
}));

const APP_A = { clientId: 'client-a', clientSecret: 'secret-a' };
const APP_B = { clientId: 'client-b', clientSecret: 'secret-b' };
const SHOP_DOMAIN = 'boutique-uninstall.myshopify.com';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

function uninstallRequest(body: string, hmac: string): Request {
  return new Request('http://localhost:3000/api/shopify/webhooks', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-shop-domain': SHOP_DOMAIN,
      'x-shopify-topic': 'app/uninstalled',
      'x-shopify-webhook-id': 'webhook-uninstall-1',
      'x-shopify-triggered-at': '2026-09-25T10:00:00.000Z',
    },
  });
}

async function post(request: Request): Promise<Response> {
  const { POST } = await import('@/app/api/shopify/webhooks/route');
  const response = await POST(request);
  await Promise.all(harness.pending);
  return response;
}

// Corps SANS domaine : le sous-chemin du repli sur l'en-tête.
const EMPTY_BODY = JSON.stringify({ id: 42 });

describe('POST /api/shopify/webhooks — app/uninstalled, identification de l’app validante', () => {
  beforeEach(() => {
    harness.apps = [APP_A, APP_B];
    harness.shopsByDomain = new Map([
      [
        SHOP_DOMAIN,
        {
          id: 'shop-1',
          shop_domain: SHOP_DOMAIN,
          merchant_account_id: 'merchant-1',
          shopify_client_id: APP_B.clientId,
        },
      ],
    ]);
    harness.dispatched = [];
    harness.pending = [];
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
  });

  it('exactement une correspondance : l’app qui a signé est transmise, jamais celle de la boutique', async () => {
    // La boutique porte B ; le corps est signé par A. La garde de la primitive doit recevoir A,
    // pour pouvoir refuser — c'est ce qui la rend non tautologique.
    const response = await post(uninstallRequest(EMPTY_BODY, sign(EMPTY_BODY, APP_A.clientSecret)));

    expect(response.status).toBe(200);
    expect(harness.dispatched).toHaveLength(1);
    expect(harness.dispatched[0]).toMatchObject({
      topic: 'app/uninstalled',
      validatedClientId: APP_A.clientId,
    });
  });

  it('exactement une correspondance, app de la boutique : transmise telle quelle', async () => {
    const response = await post(uninstallRequest(EMPTY_BODY, sign(EMPTY_BODY, APP_B.clientSecret)));

    expect(response.status).toBe(200);
    expect(harness.dispatched[0]).toMatchObject({ validatedClientId: APP_B.clientId });
  });

  it('zéro correspondance (HMAC invalide) : 401, aucun traitement', async () => {
    const response = await post(uninstallRequest(EMPTY_BODY, sign(EMPTY_BODY, 'secret-inconnu')));

    expect(response.status).toBe(401);
    expect(harness.dispatched).toHaveLength(0);
  });

  it('HMAC absent : 401, aucun traitement', async () => {
    const response = await post(uninstallRequest(EMPTY_BODY, ''));

    expect(response.status).toBe(401);
    expect(harness.dispatched).toHaveLength(0);
  });

  it('deux apps valident le même HMAC (identité ambiguë) : 401, jamais un choix arbitraire', async () => {
    const twin = { clientId: 'client-twin', clientSecret: APP_A.clientSecret };
    harness.apps = [APP_A, twin, APP_B];

    const response = await post(uninstallRequest(EMPTY_BODY, sign(EMPTY_BODY, APP_A.clientSecret)));

    expect(response.status).toBe(401);
    expect(harness.dispatched).toHaveLength(0);
  });

  it('corps portant le domaine : l’app de la boutique est la seule candidate, et c’est elle qui est transmise', async () => {
    const body = JSON.stringify({ id: 42, myshopify_domain: SHOP_DOMAIN });

    const valid = await post(uninstallRequest(body, sign(body, APP_B.clientSecret)));
    expect(valid.status).toBe(200);
    expect(harness.dispatched[0]).toMatchObject({ validatedClientId: APP_B.clientId });

    // Signé par une autre app enregistrée : refusé, comme avant ce lot.
    harness.dispatched = [];
    const other = await post(uninstallRequest(body, sign(body, APP_A.clientSecret)));
    expect(other.status).toBe(401);
    expect(harness.dispatched).toHaveLength(0);
  });

  it('un topic non concerné garde la vérification historique et ne porte aucune app', async () => {
    const body = JSON.stringify({ id: 7 });
    const request = new Request('http://localhost:3000/api/shopify/webhooks', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': sign(body, APP_A.clientSecret),
        'x-shopify-shop-domain': SHOP_DOMAIN,
        'x-shopify-topic': 'orders/create',
        'x-shopify-webhook-id': 'webhook-order-1',
      },
    });

    const response = await post(request);

    // La boutique porte B : le secret candidat est celui de B, un corps signé par A est refusé.
    expect(response.status).toBe(401);
  });
});
