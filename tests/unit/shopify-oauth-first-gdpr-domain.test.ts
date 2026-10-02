// SHOPIFY-OAUTH-FIRST-01 / B7 — D20a, T31 : domaine faisant autorité des webhooks RGPD.
//
// Couche : unitaire. (1) la résolution pure, étape par étape ; (2) la route legacy réelle, HMAC
// calculé réellement : un rejet D20a termine l'événement AVANT le dispatcher (aucune lecture de
// données client, aucune DSAR, aucune suppression). Les refus d'en-tête forgé sont en outre
// prouvés de bout en bout par tests/e2e/shopify-webhooks.spec.ts.
import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type App = { clientId: string; clientSecret: string };

const harness = vi.hoisted(() => ({
  apps: [] as App[],
  dispatched: [] as Array<Record<string, unknown>>,
  finished: [] as Array<Record<string, unknown>>,
  resolvedDomains: [] as string[],
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
  getShopifyAppForShop: vi.fn(() => harness.apps[0] ?? null),
}));
vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({})),
}));
vi.mock('@/lib/shopify/webhook-core', () => ({
  resolveShopLenient: vi.fn(async () => null),
  resolveShopForTopic: vi.fn(
    async (_supabase: unknown, _topic: string, locator: { shopDomain: string }) => {
      harness.resolvedDomains.push(locator.shopDomain);
      return { id: 'shop-1', shop_domain: locator.shopDomain, merchant_account_id: 'm-1' };
    },
  ),
  recordWebhookReceipt: vi.fn(async () => ({ eventId: 'evt-1', duplicate: false, error: null })),
  runResolvedWebhookEvent: vi.fn(async (args: Record<string, unknown>) => {
    harness.dispatched.push(args);
  }),
  finishWebhookStatus: vi.fn(async (args: Record<string, unknown>) => {
    harness.finished.push(args);
  }),
  isReceiptDue: vi.fn(() => false),
  isTerminalWebhookError: vi.fn(() => true),
  toJson: vi.fn((value: unknown) => value),
}));

const APP: App = { clientId: 'gdpr-app', clientSecret: randomBytes(24).toString('hex') };

describe('D20a — résolution pure, étape par étape', () => {
  async function resolve(header: string | null, body: unknown) {
    const { resolveGdprShopDomain } = await import('@/lib/shopify/gdpr-shop-domain');
    return resolveGdprShopDomain(header, body);
  }

  it('contrôle positif : égalité stricte → domaine normalisé', async () => {
    expect(await resolve('shop-a.myshopify.com', { shop_domain: 'shop-a.myshopify.com' })).toEqual({
      ok: true,
      shopDomain: 'shop-a.myshopify.com',
    });
  });

  it('contrôle positif : extrémités et casse normalisées sur les deux côtés → égalité', async () => {
    expect(
      await resolve('  Shop-A.MyShopify.com\t', { shop_domain: ' SHOP-A.myshopify.com ' }),
    ).toEqual({ ok: true, shopDomain: 'shop-a.myshopify.com' });
  });

  it('espace interne → invalide, sur le corps comme sur l’en-tête (jamais « retiré »)', async () => {
    expect(await resolve('shop-a.myshopify.com', { shop_domain: 'shop-a .myshopify.com' })).toEqual(
      { ok: false, reason: 'invalid' },
    );
    expect(
      await resolve('shop-a\t.myshopify.com', { shop_domain: 'shop-a.myshopify.com' }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('domaine non canonique → invalide, même identique des deux côtés', async () => {
    for (const domain of ['shop-a.example.com', '-shop.myshopify.com', 'a.myshopify.com.evil']) {
      expect(await resolve(domain, { shop_domain: domain })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
  });

  it('divergence qui subsiste après normalisation → mismatch', async () => {
    expect(await resolve('shop-b.myshopify.com', { shop_domain: 'Shop-A.myshopify.com' })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('en-tête ou corps absent (ou vide) → missing', async () => {
    expect(await resolve(null, { shop_domain: 'shop-a.myshopify.com' })).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(await resolve('   ', { shop_domain: 'shop-a.myshopify.com' })).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(await resolve('shop-a.myshopify.com', { id: 1 })).toEqual({
      ok: false,
      reason: 'missing',
    });
  });
});

function sign(body: string): string {
  return createHmac('sha256', APP.clientSecret).update(body, 'utf8').digest('base64');
}

function gdprRequest(topic: string, header: string | null, body: string, hmac = sign(body)) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': hmac,
    'x-shopify-topic': topic,
    'x-shopify-webhook-id': `webhook-${crypto.randomUUID()}`,
  };
  if (header !== null) headers['x-shopify-shop-domain'] = header;
  return new Request('http://localhost:3000/api/shopify/webhooks', {
    method: 'POST',
    body,
    headers,
  });
}

async function post(request: Request): Promise<Response> {
  const { POST } = await import('@/app/api/shopify/webhooks/route');
  const response = await POST(request);
  await Promise.all(harness.pending);
  return response;
}

describe('T31 — route legacy : rejet D20a avant tout traitement', () => {
  beforeEach(() => {
    harness.apps = [APP];
    harness.dispatched = [];
    harness.finished = [];
    harness.resolvedDomains = [];
    harness.pending = [];
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-placeholder';
  });

  const topics = ['customers/data_request', 'customers/redact', 'shop/redact'];
  const rejections: Array<[string, string | null, string, string]> = [
    ['en-tête divergent', 'victime.myshopify.com', 'attaquant.myshopify.com', 'mismatch'],
    ['espace interne', 'shop-a.myshopify.com', 'shop-a .myshopify.com', 'invalid'],
    ['non canonique', 'shop-a.example.com', 'shop-a.example.com', 'invalid'],
    ['en-tête absent', null, 'shop-a.myshopify.com', 'missing'],
  ];

  for (const topic of topics) {
    for (const [name, header, bodyDomain, reason] of rejections) {
      it(`${topic} — ${name} → gdpr_shop_domain_${reason}, terminal, aucun dispatch`, async () => {
        const body = JSON.stringify({ shop_domain: bodyDomain, customer: { id: 1 } });
        const response = await post(gdprRequest(topic, header, body));

        expect(response.status).toBe(200);
        expect(harness.dispatched).toEqual([]);
        expect(harness.resolvedDomains).toEqual([]);
        expect(harness.finished).toEqual([
          expect.objectContaining({
            eventId: 'evt-1',
            outcome: 'terminal',
            errorCode: `gdpr_shop_domain_${reason}`,
          }),
        ]);
      });
    }

    it(`${topic} — contrôle positif : égalité après normalisation → traitement, domaine normalisé`, async () => {
      const body = JSON.stringify({ shop_domain: ' Shop-A.myshopify.com ', customer: { id: 1 } });
      const response = await post(gdprRequest(topic, 'shop-a.myshopify.com', body));

      expect(response.status).toBe(200);
      expect(harness.resolvedDomains).toEqual(['shop-a.myshopify.com']);
      expect(harness.dispatched).toHaveLength(1);
      expect(harness.dispatched[0]).toMatchObject({
        topic,
        resolvedShopDomain: 'shop-a.myshopify.com',
      });
    });
  }

  it('HMAC invalide → 401 avant toute résolution (ordre : HMAC d’abord)', async () => {
    const body = JSON.stringify({ shop_domain: 'shop-a.myshopify.com' });
    const response = await post(
      gdprRequest('shop/redact', 'shop-a.myshopify.com', body, sign(`${body} `)),
    );
    expect(response.status).toBe(401);
    expect(harness.finished).toEqual([]);
    expect(harness.dispatched).toEqual([]);
  });
});
