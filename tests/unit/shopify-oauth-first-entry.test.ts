// SHOPIFY-OAUTH-FIRST-01 / B1 — entrée `application_url` hors de l'iframe.
//
// Couche : unitaire. Le route handler est exercé tel quel ; seuls les bords sont remplacés
// (registre d'apps, client service-role, session). La classification SQL elle-même est prouvée
// contre PostgreSQL réel dans tests/rls/shopify-oauth-first-01.rls.test.ts.
//
// Tests : T1 (autorisation, 3xx sans rendu), T2 (requête non signée ou périmée), T22a/T22b
// (aucun grant pour une boutique installée), T26 (erreur publique sans fuite), T32 (D19,
// credentials illisibles), T36 (arrivée sans session).
import { createHmac, randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Valeurs générées à l'exécution : aucun littéral à allure de secret dans le dépôt.
const PUBLIC_SECRET = randomBytes(24).toString('hex');
const KOBA_SECRET = randomBytes(24).toString('hex');
const STATE_SECRET = randomBytes(24).toString('hex');
const ENCRYPTION_KEY = randomBytes(32).toString('hex');
const OTHER_ENCRYPTION_KEY = randomBytes(32).toString('hex');

const harness = vi.hoisted(() => ({
  classification: 'absent' as string | null,
  classificationError: null as { code: string } | null,
  credentials: null as {
    access_token_encrypted: string | null;
    refresh_token_encrypted: string | null;
  } | null,
  user: null as { id: string } | null,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  tableCalls: [] as Array<{ table: string; method: string }>,
  sentryMessages: [] as Array<{ message: string; context: unknown }>,
  apps: {} as Record<string, unknown>,
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: (message: string, context: unknown) =>
    harness.sentryMessages.push({ message, context }),
  captureException: vi.fn(),
}));

vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByLabel: (label: string) => harness.apps[label] ?? null,
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: harness.user } }) },
  }),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: () => ({
    rpc: async (name: string, args: unknown) => {
      harness.rpcCalls.push({ name, args });
      return { data: harness.classification, error: harness.classificationError };
    },
    from: (table: string) => {
      const chain = {
        select: () => {
          harness.tableCalls.push({ table, method: 'select' });
          return chain;
        },
        insert: () => {
          harness.tableCalls.push({ table, method: 'insert' });
          return chain;
        },
        update: () => {
          harness.tableCalls.push({ table, method: 'update' });
          return chain;
        },
        upsert: () => {
          harness.tableCalls.push({ table, method: 'upsert' });
          return chain;
        },
        delete: () => {
          harness.tableCalls.push({ table, method: 'delete' });
          return chain;
        },
        eq: () => chain,
        maybeSingle: async () => ({ data: harness.credentials, error: null }),
      };
      return chain;
    },
  }),
}));

const SHOP = 'entry-shop.myshopify.com';
const ORIGIN = 'http://localhost:3000';

function signQuery(
  secret: string,
  values: Array<[string, string]> = [
    ['shop', SHOP],
    ['timestamp', String(Math.floor(Date.now() / 1000))],
    ['host', Buffer.from('admin.shopify.com/store/entry-shop').toString('base64url')],
  ],
): URLSearchParams {
  const params = new URLSearchParams(values);
  const message = Array.from(params.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  params.append('hmac', createHmac('sha256', secret).update(message).digest('hex'));
  return params;
}

async function callEntry(appLabel: string, query: URLSearchParams) {
  const { GET } = await import('@/app/api/shopify/entry/[appLabel]/route');
  return GET(new NextRequest(`${ORIGIN}/api/shopify/entry/${appLabel}?${query}`), {
    params: Promise.resolve({ appLabel }),
  });
}

async function encryptWith(key: string, value: string): Promise<string> {
  const previous = process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = key;
  try {
    const { encryptToken } = await import('@/lib/shopify/crypto');
    return encryptToken(value);
  } finally {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = previous;
  }
}

function location(response: Response): string {
  return response.headers.get('location') ?? '';
}

function stateCookie(response: Response): string | null {
  const header = response.headers.get('set-cookie') ?? '';
  const match = /shopify_oauth_state=([^;]*)/.exec(header);
  return match ? match[1] : null;
}

const savedEnv = {
  SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET,
  SHOPIFY_TOKEN_ENCRYPTION_KEY: process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY,
  SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS: process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

beforeAll(() => {
  process.env.SHOPIFY_API_SECRET = STATE_SECRET;
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
  // Aucune clé précédente : un chiffré d'une autre clé est réellement illisible.
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS = '';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-placeholder';
  harness.apps = {
    'teer-public': {
      label: 'teer-public',
      clientId: 'public-client-id',
      clientSecret: PUBLIC_SECRET,
      distribution: 'public',
      scopes: 'read_orders',
    },
    'teer-koba': {
      label: 'teer-koba',
      clientId: 'koba-client-id',
      clientSecret: KOBA_SECRET,
      distribution: 'custom',
      scopes: 'read_orders',
    },
  };
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  harness.classification = 'absent';
  harness.classificationError = null;
  harness.credentials = null;
  harness.user = null;
  harness.rpcCalls.length = 0;
  harness.tableCalls.length = 0;
  harness.sentryMessages.length = 0;
});

function expectNoWrite() {
  expect(harness.tableCalls.filter((call) => call.method !== 'select')).toEqual([]);
  expect(harness.rpcCalls.map((call) => call.name)).not.toContain(
    'decide_and_write_shopify_authorization',
  );
}

describe('T1 — autorisation sans session : 3xx direct vers Shopify, sans rendu', () => {
  for (const classification of [
    'absent',
    'uninstalled',
    'disconnected',
    'reauthorization_required',
  ]) {
    it(`${classification} : 307 vers /admin/oauth/authorize avec un state signé sans locataire`, async () => {
      harness.classification = classification;
      const response = await callEntry('teer-public', signQuery(PUBLIC_SECRET));

      expect(response.status).toBe(307);
      const target = new URL(location(response));
      expect(target.origin).toBe(`https://${SHOP}`);
      expect(target.pathname).toBe('/admin/oauth/authorize');
      expect(target.searchParams.get('client_id')).toBe('public-client-id');
      expect(target.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/shopify/callback`);

      const cookie = stateCookie(response);
      expect(cookie).not.toBeNull();
      const { verifyState } = await import('@/lib/shopify/state');
      const payload = verifyState(decodeURIComponent(cookie ?? ''));
      expect(payload).not.toBeNull();
      expect(payload?.nonce).toBe(target.searchParams.get('state'));
      expect(payload?.shopDomain).toBe(SHOP);
      expect(payload?.clientId).toBe('public-client-id');
      expect(payload).not.toHaveProperty('merchantAccountId');

      // Aucun rendu : aucune page HTML, aucun <meta refresh>.
      expect(await response.text()).toBe('');
      expect(harness.rpcCalls).toEqual([
        {
          name: 'classify_shopify_entry',
          args: { p_shop_domain: SHOP, p_client_id: 'public-client-id' },
        },
      ]);
      expectNoWrite();
    });
  }
});

describe('T2 / T26 — requête non vérifiable : erreur publique D15, aucune classification', () => {
  const fresh = String(Math.floor(Date.now() / 1000));
  const host = Buffer.from('admin.shopify.com/store/entry-shop').toString('base64url');
  const cases: Array<[string, () => URLSearchParams, string]> = [
    [
      'HMAC invalide',
      () => {
        const query = signQuery(PUBLIC_SECRET);
        query.set('hmac', '0'.repeat(64));
        return query;
      },
      'teer-public',
    ],
    ['HMAC signé par une autre app', () => signQuery(KOBA_SECRET), 'teer-public'],
    [
      'horodatage hors fenêtre',
      () =>
        signQuery(PUBLIC_SECRET, [
          ['shop', SHOP],
          ['timestamp', String(Math.floor(Date.now() / 1000) - 6 * 60)],
          ['host', host],
        ]),
      'teer-public',
    ],
    [
      'paramètre shop dupliqué',
      () =>
        signQuery(PUBLIC_SECRET, [
          ['shop', SHOP],
          ['shop', 'autre-boutique.myshopify.com'],
          ['timestamp', fresh],
          ['host', host],
        ]),
      'teer-public',
    ],
    [
      'paramètre timestamp dupliqué',
      () =>
        signQuery(PUBLIC_SECRET, [
          ['shop', SHOP],
          ['timestamp', fresh],
          ['timestamp', fresh],
          ['host', host],
        ]),
      'teer-public',
    ],
    [
      'paramètre hmac dupliqué',
      () => {
        const query = signQuery(PUBLIC_SECRET);
        query.append('hmac', query.get('hmac') ?? '');
        return query;
      },
      'teer-public',
    ],
    [
      'domaine non myshopify',
      () =>
        signQuery(PUBLIC_SECRET, [
          ['shop', 'evil.example.com'],
          ['timestamp', fresh],
          ['host', host],
        ]),
      'teer-public',
    ],
    ['app inconnue', () => signQuery(PUBLIC_SECRET), 'teer-inconnue'],
  ];

  for (const [name, buildQuery, appLabel] of cases) {
    it(`${name} → /shopify/erreur?code=invalid_request`, async () => {
      const response = await callEntry(appLabel, buildQuery());
      expect(response.status).toBe(307);
      expect(location(response)).toBe(`${ORIGIN}/shopify/erreur?code=invalid_request`);
      expect(stateCookie(response)).toBeNull();
      expect(harness.rpcCalls).toEqual([]);
    });
  }

  it('contrôle positif : la même requête correctement signée passe la vérification', async () => {
    const response = await callEntry('teer-public', signQuery(PUBLIC_SECRET));
    expect(location(response)).toContain('/admin/oauth/authorize');
  });
});

describe('T22a / T22b / T36 — boutique installée : aucun grant, arrivée R1', () => {
  it('T22a installed_valid avec session → /parametres?tab=shops, aucun cookie de state', async () => {
    harness.classification = 'installed_valid';
    harness.credentials = {
      access_token_encrypted: await encryptWith(ENCRYPTION_KEY, 'access-value'),
      refresh_token_encrypted: null,
    };
    harness.user = { id: 'user-1' };
    const response = await callEntry('teer-public', signQuery(PUBLIC_SECRET));
    expect(location(response)).toBe(`${ORIGIN}/parametres?tab=shops`);
    expect(stateCookie(response)).toBeNull();
    expectNoWrite();
  });

  it('T22b installed_refreshable avec session → /parametres?tab=shops, aucun cookie de state', async () => {
    harness.classification = 'installed_refreshable';
    harness.credentials = {
      access_token_encrypted: await encryptWith(ENCRYPTION_KEY, 'access-value'),
      refresh_token_encrypted: await encryptWith(ENCRYPTION_KEY, 'refresh-value'),
    };
    harness.user = { id: 'user-1' };
    const response = await callEntry('teer-public', signQuery(PUBLIC_SECRET));
    expect(location(response)).toBe(`${ORIGIN}/parametres?tab=shops`);
    expect(stateCookie(response)).toBeNull();
    expectNoWrite();
  });

  it('T36 installed_valid sans session → /connexion?redirectTo=/parametres?tab=shops', async () => {
    harness.classification = 'installed_valid';
    harness.credentials = {
      access_token_encrypted: await encryptWith(ENCRYPTION_KEY, 'access-value'),
      refresh_token_encrypted: null,
    };
    const response = await callEntry('teer-public', signQuery(PUBLIC_SECRET));
    expect(location(response)).toBe(
      `${ORIGIN}/connexion?redirectTo=${encodeURIComponent('/parametres?tab=shops')}`,
    );
    expect(stateCookie(response)).toBeNull();
    const { postSignInPath } = await import('@/lib/security/post-sign-in-path');
    expect(postSignInPath(new URL(location(response)).searchParams.get('redirectTo') ?? '')).toBe(
      '/parametres?tab=shops',
    );
  });
});

describe('T32 — D19 : credentials illisibles à l’entrée', () => {
  it('installed_valid chiffré par une autre clé → credentials_unavailable, sentinelle sans valeur, aucun grant', async () => {
    harness.classification = 'installed_valid';
    const unreadable = await encryptWith(OTHER_ENCRYPTION_KEY, 'access-value');
    harness.credentials = { access_token_encrypted: unreadable, refresh_token_encrypted: null };
    harness.user = { id: 'user-1' };

    const response = await callEntry('teer-public', signQuery(PUBLIC_SECRET));

    expect(location(response)).toBe(`${ORIGIN}/shopify/erreur?code=credentials_unavailable`);
    expect(stateCookie(response)).toBeNull();
    expectNoWrite();
    expect(harness.sentryMessages.map((entry) => entry.message)).toEqual([
      'shopify_entry_credentials_unreadable',
    ]);
    const serialized = JSON.stringify(harness.sentryMessages);
    expect(serialized).not.toContain(SHOP);
    expect(serialized).not.toContain(unreadable);
    expect(serialized).not.toContain('access-value');
  });

  it('installed_refreshable dont seul le refresh est illisible → credentials_unavailable', async () => {
    harness.classification = 'installed_refreshable';
    harness.credentials = {
      access_token_encrypted: await encryptWith(ENCRYPTION_KEY, 'access-value'),
      refresh_token_encrypted: await encryptWith(OTHER_ENCRYPTION_KEY, 'refresh-value'),
    };
    const response = await callEntry('teer-public', signQuery(PUBLIC_SECRET));
    expect(location(response)).toBe(`${ORIGIN}/shopify/erreur?code=credentials_unavailable`);
    expect(stateCookie(response)).toBeNull();
  });

  it('contrôle positif : les mêmes classes lisibles arrivent sans erreur', async () => {
    harness.classification = 'installed_refreshable';
    harness.credentials = {
      access_token_encrypted: await encryptWith(ENCRYPTION_KEY, 'access-value'),
      refresh_token_encrypted: await encryptWith(ENCRYPTION_KEY, 'refresh-value'),
    };
    harness.user = { id: 'user-1' };
    const response = await callEntry('teer-public', signQuery(PUBLIC_SECRET));
    expect(location(response)).toBe(`${ORIGIN}/parametres?tab=shops`);
    expect(harness.sentryMessages).toEqual([]);
  });
});

describe('D12 — refus publics, sans rien réfléchir de la requête', () => {
  const cases: Array<[string | null, string]> = [
    ['other_app', 'other_app'],
    ['invalid_input', 'invalid_request'],
    ['valeur_inattendue', 'unknown'],
    [null, 'unknown'],
  ];
  for (const [classification, code] of cases) {
    it(`${classification} → ${code}`, async () => {
      harness.classification = classification;
      const response = await callEntry('teer-public', signQuery(PUBLIC_SECRET));
      expect(location(response)).toBe(`${ORIGIN}/shopify/erreur?code=${code}`);
      expect(location(response)).not.toContain(SHOP);
      expect(stateCookie(response)).toBeNull();
      expectNoWrite();
    });
  }

  it('échec de la classification → unknown, aucun grant', async () => {
    harness.classificationError = { code: '42501' };
    const response = await callEntry('teer-public', signQuery(PUBLIC_SECRET));
    expect(location(response)).toBe(`${ORIGIN}/shopify/erreur?code=unknown`);
    expect(stateCookie(response)).toBeNull();
  });
});
