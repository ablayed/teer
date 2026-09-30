// SHOPIFY-OAUTH-FIRST-01 / B2 — callback bimodal (D13).
//
// Couche : unitaire, sur le route handler. Le cœur D16b (`performNoSessionAuthorization`) est
// remplacé ici par ses verdicts ; il est exercé contre PostgreSQL réel dans
// tests/rls/shopify-oauth-first-01.rls.test.ts. Ce fichier prouve la traduction verdict → réponse :
// aucune erreur du mode sans session ne part vers `/boutiques?error=`, le ticket ne voyage que
// dans son cookie (T19), un effet échoué après persistance n'est jamais un échec (T37), et le
// parcours historique ne change pas (T23).
import { NextRequest } from 'next/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TICKET = 'T'.repeat(43);

const harness = vi.hoisted(() => ({
  payload: null as Record<string, unknown> | null,
  hmacValid: true,
  user: null as { id: string } | null,
  result: { kind: 'pending', ticket: 'x', maxAgeSeconds: 3540 } as Record<string, unknown>,
  performCalls: [] as Array<Record<string, unknown>>,
  sentry: [] as unknown[],
  legacyExchange: vi.fn(),
}));

vi.mock('@/lib/shopify/apps', () => ({
  getDefaultShopifyAppOrNull: () => null,
  getShopifyAppByClientId: (clientId: string | null) =>
    clientId === 'public-client-id'
      ? {
          label: 'teer-public',
          clientId: 'public-client-id',
          clientSecret: 'unused-in-this-test',
          distribution: 'public',
        }
      : null,
}));

vi.mock('@/lib/shopify/state', () => ({
  verifyState: () => harness.payload,
}));

vi.mock('@/lib/shopify/oauth', () => ({
  validateShopDomain: (shop: string) => /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop),
  verifyOAuthHmac: () => harness.hmacValid,
  exchangeCodeForToken: harness.legacyExchange,
}));

vi.mock('@/lib/shopify/no-session-authorization', () => ({
  performNoSessionAuthorization: async (_admin: unknown, input: Record<string, unknown>) => {
    harness.performCalls.push(input);
    return harness.result;
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: harness.user } }) },
  }),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: () => ({}),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => harness.sentry.push(args),
  captureMessage: (...args: unknown[]) => harness.sentry.push(args),
}));

const SHOP = 'callback-shop.myshopify.com';
const ORIGIN = 'http://localhost:3000';

function callbackRequest(params: Record<string, string> = {}) {
  const query = new URLSearchParams({
    code: 'code-value',
    state: 'nonce-value',
    shop: SHOP,
    hmac: 'a'.repeat(64),
    ...params,
  });
  return new NextRequest(`${ORIGIN}/api/shopify/callback?${query}`, {
    headers: { cookie: 'shopify_oauth_state=signed-state' },
  });
}

async function callCallback(request = callbackRequest()) {
  const { GET } = await import('@/app/api/shopify/callback/route');
  return GET(request);
}

function location(response: Response) {
  return response.headers.get('location') ?? '';
}

// Import à froid du module de route (graphe de dépendances complet) : hors du délai d'un test.
beforeAll(async () => {
  await import('@/app/api/shopify/callback/route');
}, 60_000);

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-placeholder';
  harness.payload = {
    nonce: 'nonce-value',
    shopDomain: SHOP,
    exp: Date.now() + 60_000,
    clientId: 'public-client-id',
  };
  harness.hmacValid = true;
  harness.user = null;
  harness.result = { kind: 'pending', ticket: TICKET, maxAgeSeconds: 3540 };
  harness.performCalls.length = 0;
  harness.sentry.length = 0;
  harness.legacyExchange.mockReset();
});

describe('B2 — branche 2 : ticket dans un cookie restreint, jamais ailleurs (T19)', () => {
  it('pose le cookie de ticket et redirige vers /shopify/claim sans rien dans l’URL', async () => {
    const response = await callCallback();

    expect(response.status).toBe(307);
    expect(location(response)).toBe(`${ORIGIN}/shopify/claim`);
    expect(location(response)).not.toContain(TICKET);

    const cookies = response.headers.getSetCookie();
    const ticketCookie = cookies.find((cookie) => cookie.startsWith('shopify_claim_ticket=')) ?? '';
    expect(ticketCookie.split(';')[0]).toBe(`shopify_claim_ticket=${TICKET}`);
    expect(ticketCookie).toMatch(/; HttpOnly/i);
    expect(ticketCookie).toMatch(/; SameSite=lax/i);
    expect(ticketCookie).toMatch(/; Path=\/shopify\/claim(;|$)/);
    expect(ticketCookie).toMatch(/; Max-Age=3540/);
    // Le cookie de state est consommé.
    expect(cookies.some((cookie) => cookie.startsWith('shopify_oauth_state=;'))).toBe(true);

    expect(JSON.stringify(harness.sentry)).not.toContain(TICKET);
    expect(harness.performCalls).toEqual([
      {
        shopDomain: SHOP,
        code: 'code-value',
        app: expect.objectContaining({ clientId: 'public-client-id' }),
      },
    ]);
  });
});

describe('B2 — branche 1 : arrivée R1, effets échoués seulement signalés (T37)', () => {
  it('avec session : /parametres?tab=shops', async () => {
    harness.user = { id: 'user-1' };
    harness.result = { kind: 'arrived', syncPending: false };
    expect(location(await callCallback())).toBe(`${ORIGIN}/parametres?tab=shops`);
  });

  it('T37 : effet échoué → même arrivée, avec sync=pending, sans erreur', async () => {
    harness.user = { id: 'user-1' };
    harness.result = { kind: 'arrived', syncPending: true };
    const target = location(await callCallback());
    expect(target).toBe(`${ORIGIN}/parametres?tab=shops&sync=pending`);
    expect(target).not.toContain('error');
    expect(target).not.toContain('connection_failed');
  });

  it('sans session : connexion avec pour seule reprise /parametres?tab=shops', async () => {
    harness.result = { kind: 'arrived', syncPending: true };
    expect(location(await callCallback())).toBe(
      `${ORIGIN}/connexion?redirectTo=${encodeURIComponent('/parametres?tab=shops')}`,
    );
  });
});

describe('B2 — toutes les erreurs du mode sans session vont vers D15', () => {
  const guardCases: Array<[string, () => NextRequest | undefined, () => void]> = [
    ['nonce différent', () => callbackRequest({ state: 'other-nonce' }), () => undefined],
    [
      'domaine différent du state',
      () => callbackRequest({ shop: 'autre.myshopify.com' }),
      () => undefined,
    ],
    [
      'HMAC invalide',
      () => undefined,
      () => {
        harness.hmacValid = false;
      },
    ],
    ['code absent', () => callbackRequest({ code: '' }), () => undefined],
    [
      'state sans clientId (aucun repli sur l’app par défaut)',
      () => undefined,
      () => {
        if (harness.payload) harness.payload.clientId = undefined;
      },
    ],
    [
      'state illisible, sans session',
      () => undefined,
      () => {
        harness.payload = null;
      },
    ],
  ];

  for (const [name, request, arrange] of guardCases) {
    it(`${name} → invalid_request, sans appel au cœur`, async () => {
      arrange();
      const response = await callCallback(request());
      expect(location(response)).toBe(`${ORIGIN}/shopify/erreur?code=invalid_request`);
      expect(location(response)).not.toContain('/boutiques');
      expect(harness.performCalls).toEqual([]);
    });
  }

  for (const code of ['other_app', 'connection_in_progress', 'unknown']) {
    it(`verdict du cœur ${code} → /shopify/erreur?code=${code}`, async () => {
      harness.result = { kind: 'error', code };
      expect(location(await callCallback())).toBe(`${ORIGIN}/shopify/erreur?code=${code}`);
    });
  }

  it('exception du cœur → unknown, télémétrie sans domaine', async () => {
    harness.result = undefined as unknown as Record<string, unknown>;
    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(callbackRequest());
    expect(location(response)).toBe(`${ORIGIN}/shopify/erreur?code=unknown`);
    expect(JSON.stringify(harness.sentry)).not.toContain(SHOP);
  });
});

describe('T23 — le parcours historique (state avec locataire) ne change pas', () => {
  it('HMAC invalide avec locataire → /boutiques?error=invalid_hmac, jamais D15 ni le cœur sans session', async () => {
    harness.payload = {
      nonce: 'nonce-value',
      shopDomain: SHOP,
      exp: Date.now() + 60_000,
      clientId: 'public-client-id',
      merchantAccountId: 'merchant-1',
    };
    harness.hmacValid = false;
    const response = await callCallback();
    expect(location(response)).toBe(`${ORIGIN}/boutiques?error=invalid_hmac`);
    expect(harness.performCalls).toEqual([]);
  });

  it('state illisible AVEC session → erreur historique invalid_state', async () => {
    harness.payload = null;
    harness.user = { id: 'user-1' };
    const response = await callCallback();
    expect(location(response)).toBe(`${ORIGIN}/boutiques?error=invalid_state`);
    expect(harness.performCalls).toEqual([]);
  });
});
