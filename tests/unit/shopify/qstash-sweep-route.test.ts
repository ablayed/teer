import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  clients: 0,
  replay: vi.fn(),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: () => {
    h.clients += 1;
    return { marker: 'client-service-role' };
  },
}));
vi.mock('@/lib/shopify/webhook-replay', () => ({
  replayPendingShopifyWebhooks: (...args: unknown[]) => h.replay(...args),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const ENV = [
  'QSTASH_SWEEP_URL',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;
const previous = new Map<string, string | undefined>();

// Clés et URL synthétiques, générées à l'exécution.
const currentKey = randomBytes(16).toString('hex');
const nextKey = randomBytes(16).toString('hex');
const otherKey = randomBytes(16).toString('hex');
const SWEEP_URL = 'https://webhooks.synthetic-test.example/api/internal/shopify-webhook-sweep';

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/** Jeton signé comme l'émet QStash : HS256, émetteur, destination, condensat du corps, validité. */
function sign(options: { key: string; url: string; body: string; expiresInSeconds?: number }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: 'Upstash',
      sub: options.url,
      exp: now + (options.expiresInSeconds ?? 300),
      nbf: now - 5,
      iat: now - 5,
      jti: `jwt_${randomBytes(6).toString('hex')}`,
      body: createHash('sha256').update(options.body).digest('base64url'),
    }),
  );
  const signature = createHmac('sha256', options.key).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(signature)}`;
}

function call(body: string, signature?: string) {
  return new Request(SWEEP_URL, {
    method: 'POST',
    body,
    headers: signature ? { 'upstash-signature': signature } : {},
  });
}

const BODY = '{}';
const SUMMARY = {
  examined: 2,
  needsReview: {},
  replayed: { done: 2, retryable: 0, terminal: 0, unknown: 0 },
  scanTruncated: false,
  skipped: {},
  stoppedOnBudget: false,
};

describe('route QStash du balayage des webhooks Shopify', () => {
  beforeEach(() => {
    for (const key of ENV) previous.set(key, process.env[key]);
    process.env.QSTASH_SWEEP_URL = SWEEP_URL;
    process.env.QSTASH_CURRENT_SIGNING_KEY = currentKey;
    process.env.QSTASH_NEXT_SIGNING_KEY = nextKey;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'cle-service-synthetique';
    h.clients = 0;
    h.replay.mockReset();
    h.replay.mockResolvedValue(SUMMARY);
  });

  afterEach(() => {
    for (const key of ENV) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function post(request: Request) {
    const { POST } = await import('@/app/api/internal/shopify-webhook-sweep/route');
    return POST(request);
  }

  function expectNothingTouched() {
    expect(h.clients).toBe(0);
    expect(h.replay).not.toHaveBeenCalled();
  }

  it('signature absente : 401, aucun client service-role, aucune reprise', async () => {
    const response = await post(call(BODY));
    expect(response.status).toBe(401);
    expectNothingTouched();
  });

  it('signature faite avec une autre clé : 401, rien n’est touché', async () => {
    const response = await post(call(BODY, sign({ key: otherKey, url: SWEEP_URL, body: BODY })));
    expect(response.status).toBe(401);
    expectNothingTouched();
  });

  it('signature mal formée : 401, rien n’est touché', async () => {
    const response = await post(call(BODY, 'pas-un-jeton'));
    expect(response.status).toBe(401);
    expectNothingTouched();
  });

  it('corps modifié après la signature : 401, rien n’est touché', async () => {
    const signature = sign({ key: currentKey, url: SWEEP_URL, body: BODY });
    const response = await post(call('{"altere":true}', signature));
    expect(response.status).toBe(401);
    expectNothingTouched();
  });

  it('signature émise pour une autre destination : 401, rien n’est touché', async () => {
    const signature = sign({
      key: currentKey,
      url: 'https://webhooks.synthetic-test.example/api/cron/une-autre-route',
      body: BODY,
    });
    const response = await post(call(BODY, signature));
    expect(response.status).toBe(401);
    expectNothingTouched();
  });

  it('signature expirée : 401, rien n’est touché', async () => {
    const signature = sign({ key: currentKey, url: SWEEP_URL, body: BODY, expiresInSeconds: -120 });
    const response = await post(call(BODY, signature));
    expect(response.status).toBe(401);
    expectNothingTouched();
  });

  it('clés ou destination non configurées : 503, rien n’est touché', async () => {
    for (const key of [
      'QSTASH_SWEEP_URL',
      'QSTASH_CURRENT_SIGNING_KEY',
      'QSTASH_NEXT_SIGNING_KEY',
    ]) {
      const saved = process.env[key];
      delete process.env[key];
      const response = await post(
        call(BODY, sign({ key: currentKey, url: SWEEP_URL, body: BODY })),
      );
      expect(response.status, key).toBe(503);
      expectNothingTouched();
      process.env[key] = saved;
    }
  });

  it('signature valide (clé courante) : une reprise, des comptes pour toute réponse', async () => {
    const response = await post(call(BODY, sign({ key: currentKey, url: SWEEP_URL, body: BODY })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...SUMMARY });
    expect(h.clients).toBe(1);
    expect(h.replay).toHaveBeenCalledTimes(1);
    // Aucun réglage ne vient de la requête.
    expect(h.replay.mock.calls[0]).toHaveLength(1);
  });

  it('rotation des clés : une signature faite avec la clé suivante est acceptée', async () => {
    const response = await post(call(BODY, sign({ key: nextKey, url: SWEEP_URL, body: BODY })));
    expect(response.status).toBe(200);
    expect(h.replay).toHaveBeenCalledTimes(1);
  });

  it('reprise en échec : 500, sans détail', async () => {
    h.replay.mockRejectedValue(new Error('shopify_webhook_replay_scan_failed'));
    const response = await post(call(BODY, sign({ key: currentKey, url: SWEEP_URL, body: BODY })));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'replay_failed', ok: false });
  });
});
