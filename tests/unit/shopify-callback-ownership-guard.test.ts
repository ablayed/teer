// APP-03 / Lot 1 — matrice de test de la garde de propriété du callback OAuth Shopify.
// Un faux client admin Supabase, tenant l'état en mémoire (shop/store_connection), reproduit
// les contraintes réellement pertinentes (unicité shop_domain, unicité (platform,
// external_identifier)) sans stack Supabase — le comportement de la contrainte FK elle-même a
// déjà été mesuré empiriquement contre une base locale isolée (cf. rapport APP-03, scénarios 1-4).
// Ici, on prouve que le code applicatif ne dépend plus jamais de cette contrainte pour refuser.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ShopRow = {
  id: string;
  shop_domain: string;
  merchant_account_id: string;
  [key: string]: unknown;
};

type ConnectionRow = {
  id: string;
  platform: string;
  external_identifier: string;
  merchant_account_id: string;
  shop_id: string;
  [key: string]: unknown;
};

type WriteCall = { payload: Record<string, unknown>; filters: Array<[string, unknown]> };

const harness = vi.hoisted(() => ({
  shops: [] as ShopRow[],
  connections: [] as ConnectionRow[],
  nextId: 0,
  onAfterGuardRead: null as (() => void) | null,
  // Capture les payloads/filtres RÉELLEMENT transmis au client Supabase (pas seulement l'état
  // final) — c'est ce qui prouve que `merchant_account_id` est structurellement absent des
  // colonnes d'update, indépendamment de ce que le filtre laisse ensuite passer ou non.
  shopInsertCalls: [] as Array<{ payload: Record<string, unknown> }>,
  shopUpdateCalls: [] as WriteCall[],
  connectionInsertCalls: [] as Array<{ payload: Record<string, unknown> }>,
  connectionUpdateCalls: [] as WriteCall[],
}));

function freshId(prefix: string): string {
  harness.nextId += 1;
  return `${prefix}-${harness.nextId}`;
}

const TENANT_A = 'tenant-a-sentinel';
const TENANT_B = 'tenant-b-sentinel';
const SHOP_DOMAIN = 'race-fixture.myshopify.com';

const APP = {
  label: 'teer-dev' as const,
  clientId: 'client-sentinel',
  clientSecret: 'secret-sentinel',
};

const exchangeCodeForToken = vi.fn(async () => ({
  accessToken: 'access-token-sentinel',
  refreshToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  scope: 'read_customers,read_orders,read_products',
}));

vi.mock('@/lib/shopify/apps', () => ({
  getDefaultShopifyAppOrNull: vi.fn(() => APP),
  getShopifyAppByClientId: vi.fn((clientId: string | null) =>
    clientId === APP.clientId ? APP : null,
  ),
}));

vi.mock('@/lib/shopify/state', () => ({
  verifyState: vi.fn(() => ({
    nonce: 'synthetic-nonce',
    merchantAccountId: TENANT_A,
    shopDomain: SHOP_DOMAIN,
    clientId: APP.clientId,
  })),
}));

vi.mock('@/lib/shopify/oauth', () => ({
  validateShopDomain: vi.fn(() => true),
  verifyOAuthHmac: vi.fn(() => true),
  exchangeCodeForToken,
}));

vi.mock('@/lib/shopify/crypto', () => ({
  encryptToken: vi.fn((value: string) => `encrypted-${value}`),
}));

vi.mock('@/lib/shopify/products-sync', () => ({
  syncProductsForShop: vi.fn(async () => ({ ok: true })),
}));

const captureException = vi.fn();
const captureMessage = vi.fn();

vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({
    from(table: string) {
      if (table === 'shop') {
        return {
          select: () => ({
            eq: (_col: string, domain: string) => ({
              maybeSingle: async () => {
                const row = harness.shops.find((s) => s.shop_domain === domain);
                // Snapshot AVANT le hook : la lecture de garde doit voir l'état d'avant la
                // course, sinon le test simulerait une course déjà visible à la lecture elle-même.
                const snapshot = row
                  ? { id: row.id, merchant_account_id: row.merchant_account_id }
                  : null;
                const hook = harness.onAfterGuardRead;
                harness.onAfterGuardRead = null;
                hook?.();
                return { data: snapshot, error: null };
              },
            }),
          }),
          insert: (payload: Record<string, unknown>) => {
            harness.shopInsertCalls.push({ payload });
            return {
              select: () => ({
                single: async () => {
                  const domain = payload.shop_domain as string;
                  if (harness.shops.some((s) => s.shop_domain === domain)) {
                    return {
                      data: null,
                      error: {
                        code: '23505',
                        message: 'duplicate key value violates shop_shop_domain_key',
                      },
                    };
                  }
                  const row = { id: freshId('shop'), ...payload } as ShopRow;
                  harness.shops.push(row);
                  return { data: { id: row.id }, error: null };
                },
              }),
            };
          },
          update: (payload: Record<string, unknown>) => {
            const filters: Array<[string, unknown]> = [];
            harness.shopUpdateCalls.push({ payload, filters });
            const builder = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              select: () => ({
                single: async () => {
                  const row = harness.shops.find((s) =>
                    filters.every(([column, value]) => s[column] === value),
                  );
                  if (!row) {
                    return { data: null, error: { code: 'PGRST116', message: 'no rows found' } };
                  }
                  Object.assign(row, payload);
                  return { data: { id: row.id }, error: null };
                },
              }),
            };
            return builder;
          },
        };
      }

      if (table === 'store_connection') {
        return {
          insert: (payload: Record<string, unknown>) => {
            harness.connectionInsertCalls.push({ payload });
            return (async () => {
              const key = `${payload.platform}:${payload.external_identifier}`;
              const exists = harness.connections.some(
                (c) => `${c.platform}:${c.external_identifier}` === key,
              );
              if (exists) {
                return {
                  error: {
                    code: '23505',
                    message: 'duplicate key value violates store_connection_platform_external_key',
                  },
                };
              }
              harness.connections.push({ id: freshId('conn'), ...payload } as ConnectionRow);
              return { error: null };
            })();
          },
          update: (payload: Record<string, unknown>) => {
            const filters: Array<[string, unknown]> = [];
            harness.connectionUpdateCalls.push({ payload, filters });
            const builder = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              // Reproduit le PostgrestFilterBuilder réel de supabase-js, directement awaitable
              // sans .select() terminal — exactement l'usage du chemin store_connection dans route.ts.
              // biome-ignore lint/suspicious/noThenProperty: thenable délibéré, cf. commentaire ci-dessus.
              then(resolve: (result: { error: null }) => void) {
                const row = harness.connections.find((c) =>
                  filters.every(([column, value]) => c[column] === value),
                );
                if (row) {
                  Object.assign(row, payload);
                }
                resolve({ error: null });
              },
            };
            return builder;
          },
        };
      }

      return { insert: async () => ({ error: null }) };
    },
  })),
}));

function buildRequest() {
  return new NextRequest(
    `http://localhost:3000/api/shopify/callback?code=code-sentinel&state=synthetic-nonce&shop=${SHOP_DOMAIN}`,
    { headers: { cookie: 'shopify_oauth_state=state-sentinel' } },
  );
}

function errorParamFrom(response: Response): string | null {
  const location = response.headers.get('location');
  return location ? new URL(location).searchParams.get('error') : null;
}

describe('callback OAuth — garde de propriété avant écriture (APP-03 / Lot 1)', () => {
  beforeEach(() => {
    harness.shops.length = 0;
    harness.connections.length = 0;
    harness.onAfterGuardRead = null;
    harness.shopInsertCalls.length = 0;
    harness.shopUpdateCalls.length = 0;
    harness.connectionInsertCalls.length = 0;
    harness.connectionUpdateCalls.length = 0;
    exchangeCodeForToken.mockClear();
    captureException.mockClear();
    captureMessage.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
  });

  it("insère une nouvelle boutique quand aucune ligne n'existe pour ce domaine", async () => {
    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(response.status).toBe(307);
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(harness.shops).toHaveLength(1);
    expect(harness.shops[0]).toMatchObject({
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
    });
    expect(harness.connections).toHaveLength(1);
    expect(harness.connections[0]).toMatchObject({ merchant_account_id: TENANT_A });
    // Anti-divergence : le merchant_account_id du payload d'insert store_connection est bien
    // celui validé par la garde (payload.merchantAccountId, même variable que pour `shop`),
    // jamais une valeur relue séparément de la session Tëër — la clé unique (platform,
    // external_identifier) ne contenant pas le tenant, un insert n'a pas d'autre barrière.
    expect(harness.connectionInsertCalls).toHaveLength(1);
    expect(harness.connectionInsertCalls[0].payload.merchant_account_id).toBe(TENANT_A);
  });

  it('met à jour la boutique existante en reconnexion sur le même tenant', async () => {
    harness.shops.push({
      id: 'shop-existing',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: 'old-client',
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(response.status).toBe(307);
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(harness.shops).toHaveLength(1);
    expect(harness.shops[0]).toMatchObject({
      id: 'shop-existing',
      merchant_account_id: TENANT_A,
      shopify_client_id: APP.clientId,
    });
  });

  it('reconnexion complète (shop ET store_connection déjà existants, même tenant) : les deux ' +
    'updates sont structurellement incapables de réassigner merchant_account_id', async () => {
    harness.shops.push({
      id: 'shop-existing',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: 'old-client',
    });
    harness.connections.push({
      id: 'conn-existing',
      platform: 'shopify',
      external_identifier: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shop_id: 'shop-existing',
      platform_app_id: 'old-client',
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(response.status).toBe(307);

    // shop.update : merchant_account_id absent des colonnes écrites, présent uniquement
    // comme filtre WHERE — aux côtés de `id`, pas à sa place.
    expect(harness.shopUpdateCalls).toHaveLength(1);
    expect(harness.shopUpdateCalls[0].payload).not.toHaveProperty('merchant_account_id');
    expect(harness.shopUpdateCalls[0].filters).toContainEqual(['id', 'shop-existing']);
    expect(harness.shopUpdateCalls[0].filters).toContainEqual(['merchant_account_id', TENANT_A]);

    // store_connection.update : même discipline, sur sa propre clé (platform,
    // external_identifier) — merchant_account_id n'y figure que comme filtre.
    expect(harness.connectionUpdateCalls).toHaveLength(1);
    expect(harness.connectionUpdateCalls[0].payload).not.toHaveProperty('merchant_account_id');
    expect(harness.connectionUpdateCalls[0].filters).toContainEqual(['platform', 'shopify']);
    expect(harness.connectionUpdateCalls[0].filters).toContainEqual([
      'external_identifier',
      SHOP_DOMAIN,
    ]);
    expect(harness.connectionUpdateCalls[0].filters).toContainEqual([
      'merchant_account_id',
      TENANT_A,
    ]);

    // `shop` : la décision de garde choisit insert XOR update — aucun insert tenté ici.
    expect(harness.shopInsertCalls).toHaveLength(0);
    // `store_connection` : le chemin route.ts tente TOUJOURS l'insert en premier (contrairement
    // à `shop`) ; ici il échoue en 23505 (ligne déjà existante) et retombe sur l'update guardé
    // ci-dessus — c'est cet insert tenté-puis-refusé qui est attendu, pas son absence.
    expect(harness.connectionInsertCalls).toHaveLength(1);
  });

  it("refuse AVANT l'échange de code une boutique déjà possédée par un autre tenant — aucune " +
    'écriture, aucun 23503 brut ne doit remonter sur ce chemin (amendement 1)', async () => {
    harness.shops.push({
      id: 'shop-victim',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_B,
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(response.status).toBe(307);
    expect(errorParamFrom(response)).toBe('connection_failed');
    // Refus AVANT l'échange de code : le token Shopify n'est jamais négocié pour rien.
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
    // Aucune écriture, dans un sens ou dans l'autre.
    expect(harness.shops).toEqual([
      { id: 'shop-victim', shop_domain: SHOP_DOMAIN, merchant_account_id: TENANT_B },
    ]);
    expect(harness.connections).toHaveLength(0);
    // Preuve du sentinel : c'est bien la garde applicative qui a parlé, pas une exception
    // Postgres brute (jamais de sqlstate/23503 sur ce chemin de refus).
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_ownership_guard_refused',
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'ownership_mismatch' }) }),
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it('refuse en fermé (fail-closed) si la propriété change entre la lecture de garde et ' +
    "l'écriture (course sur le chemin update)", async () => {
    harness.shops.push({
      id: 'shop-raced',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
    });
    // La garde lit tenant A (autorise), mais une autre requête réassigne la ligne à un tenant
    // tiers avant que cette écriture ne s'exécute — la clause .eq('merchant_account_id', ...)
    // ne doit alors matcher aucune ligne.
    harness.onAfterGuardRead = () => {
      const row = harness.shops.find((s) => s.id === 'shop-raced');
      if (row) row.merchant_account_id = TENANT_B;
    };

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(errorParamFrom(response)).toBe('connection_failed');
    expect(harness.shops[0].merchant_account_id).toBe(TENANT_B);
    expect(harness.connections).toHaveLength(0);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PGRST116' }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'ownership_guard_update_race' }),
      }),
    );
  });

  it('refuse en fermé (fail-closed) si la boutique est créée par une autre requête entre la ' +
    "lecture de garde et l'écriture (course sur le chemin insert)", async () => {
    // Aucune boutique au moment de la garde (résout 'insert'), mais une autre requête en crée
    // une entre-temps — l'INSERT doit se heurter à shop_shop_domain_key, jamais retomber sur
    // une upsert qui écraserait le propriétaire déjà en place.
    harness.onAfterGuardRead = () => {
      harness.shops.push({
        id: 'shop-concurrent',
        shop_domain: SHOP_DOMAIN,
        merchant_account_id: TENANT_B,
      });
    };

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(errorParamFrom(response)).toBe('connection_failed');
    expect(harness.shops).toEqual([
      { id: 'shop-concurrent', shop_domain: SHOP_DOMAIN, merchant_account_id: TENANT_B },
    ]);
    expect(harness.connections).toHaveLength(0);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ code: '23505' }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'ownership_guard_insert_race' }),
      }),
    );
  });
});
