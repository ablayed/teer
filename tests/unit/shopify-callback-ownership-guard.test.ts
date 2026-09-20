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
  // SEC-APP-SWITCH-01 : toute table hors `shop`/`store_connection` du chemin — aujourd'hui
  // `audit_log` seul. Compté pour prouver qu'un zéro-ligne au compare-and-set n'écrit RIEN
  // derrière lui, pas seulement qu'il ne touche pas `store_connection`.
  otherInsertCalls: [] as Array<{ table: string; payload: Record<string, unknown> }>,
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

// Espion pass-through : la vraie décision reste celle de lib/shopify/app-switch-guard.ts. Ce
// mock ne change aucun comportement — il prouve seulement QUE la route appelle ce module, et
// avec quels arguments. Un correctif qui réimplémenterait la règle sur place ferait rougir le
// test sans changer le comportement observable, ce qui est précisément le but.
const decideShopAppSwitchSpy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/shopify/app-switch-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopify/app-switch-guard')>();
  return {
    ...actual,
    decideShopAppSwitch: (...args: Parameters<typeof actual.decideShopAppSwitch>) => {
      decideShopAppSwitchSpy(...args);
      return actual.decideShopAppSwitch(...args);
    },
  };
});

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
                  ? {
                      id: row.id,
                      merchant_account_id: row.merchant_account_id,
                      // SEC-APP-SWITCH-01 : la lecture de garde sélectionne désormais aussi
                      // l'identité d'app. `undefined` (colonne absente de la fixture) est
                      // normalisé en `null` — c'est ce que rend la base pour une colonne
                      // nullable non renseignée, jamais `undefined`.
                      shopify_client_id: (row.shopify_client_id as string | null) ?? null,
                    }
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
            // Normalisation `undefined` → `null` des DEUX côtés : en base, une colonne nullable
            // non renseignée vaut NULL, jamais `undefined`. Sans cela, `.is('shopify_client_id',
            // null)` ne matcherait aucune fixture qui omet la colonne, et le test mesurerait la
            // forme de la fixture au lieu du prédicat.
            const matches = (row: ShopRow) =>
              filters.every(([column, value]) => (row[column] ?? null) === (value ?? null));
            const findRow = () => harness.shops.find(matches);
            const applyTo = (row: ShopRow | undefined) => {
              if (!row) return null;
              Object.assign(row, payload);
              return { id: row.id };
            };
            const builder = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              // SEC-APP-SWITCH-01 : le compare-and-set null-safe passe par `.is(col, null)`.
              is(column: string, value: unknown) {
                filters.push([column, value]);
                return builder;
              },
              select: () => ({
                single: async () => {
                  const applied = applyTo(findRow());
                  if (!applied) {
                    return { data: null, error: { code: 'PGRST116', message: 'no rows found' } };
                  }
                  return { data: applied, error: null };
                },
                // Zéro ligne → `data: null`, `error: null` : sémantique réelle de
                // `.maybeSingle()` (@supabase/postgrest-js, PostgrestBuilder.processResponse),
                // épinglée en plus contre le vrai PostgREST par la suite RLS de ce lot.
                maybeSingle: async () => ({ data: applyTo(findRow()), error: null }),
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

      return {
        insert: async (payload: Record<string, unknown>) => {
          harness.otherInsertCalls.push({ table, payload });
          return { error: null };
        },
      };
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
    harness.otherInsertCalls.length = 0;
    exchangeCodeForToken.mockClear();
    decideShopAppSwitchSpy.mockClear();
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

  // SEC-APP-SWITCH-01 — fixture REMPLACÉE, jamais complétée : elle portait `shopify_client_id:
  // 'old-client'` et asseyait donc le défaut (une reconnexion écrasait silencieusement l'identité
  // d'une AUTRE app du même locataire). La reconnexion légitime est celle de la MÊME app ; la
  // bascule vers une autre app est désormais couverte, en refus, par le bloc dédié plus bas.
  it('met à jour la boutique existante en reconnexion sur le même tenant ET la même app', async () => {
    harness.shops.push({
      id: 'shop-existing',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: APP.clientId,
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
    // Même correction de fixture que ci-dessus : reconnexion de la MÊME app.
    harness.shops.push({
      id: 'shop-existing',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: APP.clientId,
    });
    harness.connections.push({
      id: 'conn-existing',
      platform: 'shopify',
      external_identifier: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shop_id: 'shop-existing',
      platform_app_id: APP.clientId,
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
    // SEC-APP-SWITCH-01 : l'écriture se termine désormais en `.maybeSingle()`, donc zéro ligne
    // se lit `data: null, error: null` et non plus en PGRST116. Le comportement observable pour
    // l'utilisateur est inchangé (refus générique fermé) ; seule la sentinelle interne change,
    // et elle est volontairement NON attribuable à une cause unique.
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_callback_shop_write_no_row',
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'shop_write_no_row' }),
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

// ============================================================================================
// SEC-APP-SWITCH-01 — garde de bascule d'app dans le callback OAuth.
//
// `decideShopOwnership` ne confronte que le locataire : avant ce lot, une installation d'une
// AUTRE app du même locataire écrasait `shopify_client_id` et les jetons chiffrés d'une boutique
// déjà rattachée. Deux protections distinctes sont vérifiées ici, et elles ne se remplacent pas :
//   1. la garde préalable, AVANT l'échange de code — refus nommé, aucun effet externe ;
//   2. le compare-and-set à l'écriture — ferme la seule fenêtre restante, entre la lecture et
//      l'écriture ; il s'exerce nécessairement APRÈS l'échange.
// ============================================================================================
describe('callback OAuth — garde de bascule d’app (SEC-APP-SWITCH-01)', () => {
  beforeEach(() => {
    harness.shops.length = 0;
    harness.connections.length = 0;
    harness.onAfterGuardRead = null;
    harness.shopInsertCalls.length = 0;
    harness.shopUpdateCalls.length = 0;
    harness.connectionInsertCalls.length = 0;
    harness.connectionUpdateCalls.length = 0;
    harness.otherInsertCalls.length = 0;
    exchangeCodeForToken.mockClear();
    decideShopAppSwitchSpy.mockClear();
    captureException.mockClear();
    captureMessage.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
  });

  // Propriété 1 — la route appelle la garde PARTAGÉE, avec les bons arguments.
  it('appelle decideShopAppSwitch (module partagé) avec la ligne lue et le client_id du state', async () => {
    harness.shops.push({
      id: 'shop-koba',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: 'koba-client-sentinel',
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    await GET(buildRequest());

    expect(decideShopAppSwitchSpy).toHaveBeenCalledTimes(1);
    expect(decideShopAppSwitchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ shopify_client_id: 'koba-client-sentinel' }),
      APP.clientId,
    );
  });

  // Propriété 2 — le refus précède l'échange de code.
  it('refuse AVANT l’échange de code une boutique du MÊME locataire déjà rattachée à une autre app', async () => {
    harness.shops.push({
      id: 'shop-koba',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: 'koba-client-sentinel',
      access_token_encrypted: 'encrypted-koba-token',
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(errorParamFrom(response)).toBe('app_switch_refused');
    // Preuve par l'ABSENCE d'appel, jamais par l'ordre des lignes du fichier : aucun code
    // d'autorisation Shopify n'est consommé pour rien sur ce chemin.
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
    // Aucune écriture, nulle part — ni identité, ni jeton, ni connexion, ni audit.
    expect(harness.shops[0]).toMatchObject({
      shopify_client_id: 'koba-client-sentinel',
      access_token_encrypted: 'encrypted-koba-token',
    });
    expect(harness.shopUpdateCalls).toHaveLength(0);
    expect(harness.shopInsertCalls).toHaveLength(0);
    expect(harness.connections).toHaveLength(0);
    expect(harness.otherInsertCalls).toHaveLength(0);
    // Sentinelle interne à code stable — jamais le texte du message.
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SHOPIFY_APP_SWITCH_REFUSED' }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'app_switch_refused' }),
      }),
    );
  });

  // Matrice de la garde.
  it('laisse passer une boutique sans app rattachée (shopify_client_id null) — état normal après libération', async () => {
    harness.shops.push({
      id: 'shop-released',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: null,
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(errorParamFrom(response)).not.toBe('app_switch_refused');
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(harness.shops[0]).toMatchObject({ shopify_client_id: APP.clientId });
  });

  it('laisse passer une reconnexion de la même app', async () => {
    harness.shops.push({
      id: 'shop-same-app',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: APP.clientId,
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(errorParamFrom(response)).toBeNull();
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
  });

  it('laisse passer une première installation (aucune ligne pour ce domaine)', async () => {
    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(errorParamFrom(response)).toBeNull();
    expect(decideShopAppSwitchSpy).toHaveBeenCalledWith(null, APP.clientId);
    expect(harness.shops).toHaveLength(1);
  });

  // Propriété 3 — le prédicat de compare-and-set suit la valeur LUE.
  it('construit le prédicat `is null` quand la ligne lue ne porte aucune app', async () => {
    harness.shops.push({
      id: 'shop-released',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: null,
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    await GET(buildRequest());

    expect(harness.shopUpdateCalls).toHaveLength(1);
    expect(harness.shopUpdateCalls[0].filters).toContainEqual(['shopify_client_id', null]);
  });

  it('construit le prédicat `eq <app lue>` quand la ligne lue porte déjà cette app', async () => {
    harness.shops.push({
      id: 'shop-same-app',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: APP.clientId,
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    await GET(buildRequest());

    expect(harness.shopUpdateCalls).toHaveLength(1);
    expect(harness.shopUpdateCalls[0].filters).toContainEqual(['shopify_client_id', APP.clientId]);
  });

  // Propriété 4 — un zéro-ligne au compare-and-set arrête TOUTES les écritures suivantes.
  it('course sur l’identité d’app : zéro ligne au compare-and-set, refus fermé, aucune écriture secondaire', async () => {
    harness.shops.push({
      id: 'shop-raced-app',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: null,
    });
    // La garde lit « aucune app » (autorise), mais une autre installation rattache la boutique
    // entre la lecture et l'écriture — le prédicat `.is('shopify_client_id', null)` ne matche
    // alors plus aucune ligne. C'est exactement la fenêtre que la garde préalable ne couvre pas.
    harness.onAfterGuardRead = () => {
      const row = harness.shops.find((s) => s.id === 'shop-raced-app');
      if (row) row.shopify_client_id = 'concurrent-app-sentinel';
    };

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    // Refus GÉNÉRIQUE : à ce stade la cause n'est pas attribuable (app changée, propriété
    // réassignée, ligne supprimée). L'étiqueter `app_switch_refused` affirmerait une cause
    // non mesurée.
    expect(errorParamFrom(response)).toBe('connection_failed');
    // L'identité posée par la course est intacte — aucun jeton du perdant n'a été écrit.
    expect(harness.shops[0]).toMatchObject({ shopify_client_id: 'concurrent-app-sentinel' });
    expect(harness.shops[0].access_token_encrypted).toBeUndefined();
    // Aucune écriture secondaire derrière l'échec : ni connexion, ni audit, ni synchronisation.
    expect(harness.connections).toHaveLength(0);
    expect(harness.connectionInsertCalls).toHaveLength(0);
    expect(harness.otherInsertCalls).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_callback_shop_write_no_row',
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'shop_write_no_row' }),
      }),
    );
  });
});
