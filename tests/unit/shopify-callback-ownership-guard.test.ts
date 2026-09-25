// APP-03 / Lot 1 — matrice de test de la garde de propriété du callback OAuth Shopify.
//
// SHOPIFY-EXPIRING-TOKENS-01 — l'écriture ne passe plus par `.from('shop').insert/update` : elle
// passe par `persist_shopify_credentials_fenced` (mode `authorization_code`) sous bail de jeton,
// et `store_connection` par `write_shopify_store_connection_fenced`. Le faux client de ce fichier
// modélise ces RPC en mémoire (tests/unit/helpers/fake-shopify-lease-db.ts) ; leurs gardes
// réelles, sous verrou, sont prouvées contre PostgreSQL par les suites RLS de 0158 et de ce lot.
// Ici, on prouve l'ORCHESTRATION : gardes préalables avant l'échange, bail avant l'appel Shopify,
// verdicts de la RPC traduits sans jamais un succès silencieux, et aucune écriture directe.
import { fakeLeaseDb } from '@/tests/unit/helpers/fake-shopify-lease-db';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_A = 'tenant-a-sentinel';
const TENANT_B = 'tenant-b-sentinel';
const SHOP_DOMAIN = 'race-fixture.myshopify.com';

const APP = {
  label: 'teer-dev' as const,
  distribution: 'custom' as const,
  clientId: 'client-sentinel',
  clientSecret: 'secret-sentinel',
};

const exchangeCodeForToken = vi.fn(async (_input: Record<string, unknown>) => ({
  accessToken: 'access-token-sentinel',
  refreshToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  scope: 'read_customers,read_orders,read_products',
}));

// Espion pass-through : la vraie décision reste celle de lib/shopify/app-switch-guard.ts. Ce
// mock ne change aucun comportement — il prouve seulement QUE la route appelle ce module, et
// avec quels arguments.
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

vi.mock('@/lib/supabase/protected-client', async () => {
  const { fakeLeaseDb: db } = await import('@/tests/unit/helpers/fake-shopify-lease-db');
  return { createProtectedSupabaseClient: vi.fn(() => db.client()) };
});

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

function rpcNames(): string[] {
  return fakeLeaseDb.state.rpcCalls.map((call) => call.name);
}

function rpcArgs(name: string): Record<string, unknown> | undefined {
  return fakeLeaseDb.state.rpcCalls.find((call) => call.name === name)?.args;
}

function resetHarness() {
  fakeLeaseDb.reset();
  exchangeCodeForToken.mockClear();
  decideShopAppSwitchSpy.mockClear();
  captureException.mockClear();
  captureMessage.mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
}

describe('callback OAuth — garde de propriété avant écriture (APP-03 / Lot 1)', () => {
  beforeEach(resetHarness);

  it("insère une nouvelle boutique quand aucune ligne n'existe pour ce domaine", async () => {
    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(response.status).toBe(307);
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(fakeLeaseDb.state.shops).toHaveLength(1);
    expect(fakeLeaseDb.state.shops[0]).toMatchObject({
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
    });
    expect(fakeLeaseDb.state.connections).toHaveLength(1);
    expect(fakeLeaseDb.state.connections[0]).toMatchObject({ merchant_account_id: TENANT_A });
    // Anti-divergence : le locataire transmis aux DEUX écritures est celui validé par la garde
    // (payload.merchantAccountId), jamais une valeur relue séparément.
    expect(rpcArgs('persist_shopify_credentials_fenced')?.p_merchant_account_id).toBe(TENANT_A);
    expect(rpcArgs('write_shopify_store_connection_fenced')?.p_merchant_account_id).toBe(TENANT_A);
    expect(fakeLeaseDb.state.directWrites).toEqual([]);
  });

  // SEC-APP-SWITCH-01 — la reconnexion légitime est celle de la MÊME app ; la bascule vers une
  // autre app est couverte, en refus, par le bloc dédié plus bas.
  it('met à jour la boutique existante en reconnexion sur le même tenant ET la même app', async () => {
    fakeLeaseDb.state.shops.push({
      id: 'shop-existing',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: APP.clientId,
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(response.status).toBe(307);
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(fakeLeaseDb.state.shops).toHaveLength(1);
    expect(fakeLeaseDb.state.shops[0]).toMatchObject({
      id: 'shop-existing',
      merchant_account_id: TENANT_A,
      shopify_client_id: APP.clientId,
      access_token_encrypted: 'encrypted-access-token-sentinel',
    });
  });

  it('reconnexion complète (shop ET store_connection déjà existants, même tenant) : aucune ' +
    'écriture directe, le locataire des deux lignes reste celui en place', async () => {
    fakeLeaseDb.state.shops.push({
      id: 'shop-existing',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: APP.clientId,
    });
    fakeLeaseDb.state.connections.push({
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
    // Les deux écritures passent par les RPC fencées : `merchant_account_id` n'y est qu'un
    // attendu comparé, jamais une colonne écrite sur une ligne existante (0158).
    expect(fakeLeaseDb.state.directWrites).toEqual([]);
    expect(rpcNames()).toEqual([
      'acquire_shopify_token_lease',
      'persist_shopify_credentials_fenced',
      'write_shopify_store_connection_fenced',
    ]);
    expect(fakeLeaseDb.state.shops[0].merchant_account_id).toBe(TENANT_A);
    expect(fakeLeaseDb.state.connections).toHaveLength(1);
    expect(fakeLeaseDb.state.connections[0]).toMatchObject({
      id: 'conn-existing',
      merchant_account_id: TENANT_A,
    });
  });

  it("refuse AVANT l'échange de code une boutique déjà possédée par un autre tenant — aucune " +
    'écriture, aucun 23503 brut ne doit remonter sur ce chemin (amendement 1)', async () => {
    fakeLeaseDb.state.shops.push({
      id: 'shop-victim',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_B,
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(response.status).toBe(307);
    expect(errorParamFrom(response)).toBe('connection_failed');
    // Refus AVANT l'échange de code — et avant même l'acquisition du bail.
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual([]);
    expect(fakeLeaseDb.state.shops).toEqual([
      { id: 'shop-victim', shop_domain: SHOP_DOMAIN, merchant_account_id: TENANT_B },
    ]);
    expect(fakeLeaseDb.state.connections).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_ownership_guard_refused',
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'ownership_mismatch' }) }),
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it('refuse en fermé (fail-closed) si la propriété change entre la lecture de garde et ' +
    "l'écriture (course sur le chemin update)", async () => {
    fakeLeaseDb.state.shops.push({
      id: 'shop-raced',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
    });
    fakeLeaseDb.state.onAfterGuardRead = () => {
      const row = fakeLeaseDb.state.shops.find((s) => s.id === 'shop-raced');
      if (row) row.merchant_account_id = TENANT_B;
    };

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(errorParamFrom(response)).toBe('connection_failed');
    expect(fakeLeaseDb.state.shops[0].merchant_account_id).toBe(TENANT_B);
    expect(fakeLeaseDb.state.connections).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_callback_shop_write_no_row',
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'shop_write_no_row' }),
        extra: expect.objectContaining({ outcome: 'ownership_refused' }),
      }),
    );
  });

  it('refuse en fermé (fail-closed) si la boutique est créée par une autre requête entre la ' +
    "lecture de garde et l'écriture (course sur le chemin insert)", async () => {
    fakeLeaseDb.state.onAfterGuardRead = () => {
      fakeLeaseDb.state.shops.push({
        id: 'shop-concurrent',
        shop_domain: SHOP_DOMAIN,
        merchant_account_id: TENANT_B,
      });
    };

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    // La RPC ne lève pas 23505 : la ligne concurrente est reprise et passe par la garde de
    // propriété, qui refuse. Jamais une upsert qui écraserait le propriétaire en place.
    expect(errorParamFrom(response)).toBe('connection_failed');
    expect(fakeLeaseDb.state.shops).toEqual([
      { id: 'shop-concurrent', shop_domain: SHOP_DOMAIN, merchant_account_id: TENANT_B },
    ]);
    expect(fakeLeaseDb.state.connections).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_callback_shop_write_no_row',
      expect.objectContaining({
        extra: expect.objectContaining({ outcome: 'ownership_refused' }),
      }),
    );
  });
});

// ============================================================================================
// SEC-APP-SWITCH-01 — garde de bascule d'app dans le callback OAuth.
//   1. la garde préalable, AVANT l'échange de code — refus nommé, aucun effet externe ;
//   2. la garde sous verrou de la RPC fencée — ferme la fenêtre entre la lecture et l'écriture.
// ============================================================================================
describe('callback OAuth — garde de bascule d’app (SEC-APP-SWITCH-01)', () => {
  beforeEach(resetHarness);

  it('appelle decideShopAppSwitch (module partagé) avec la ligne lue et le client_id du state', async () => {
    fakeLeaseDb.state.shops.push({
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

  it('refuse AVANT l’échange de code une boutique du MÊME locataire déjà rattachée à une autre app', async () => {
    fakeLeaseDb.state.shops.push({
      id: 'shop-koba',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: 'koba-client-sentinel',
      access_token_encrypted: 'encrypted-koba-token',
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(errorParamFrom(response)).toBe('app_switch_refused');
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual([]);
    expect(fakeLeaseDb.state.shops[0]).toMatchObject({
      shopify_client_id: 'koba-client-sentinel',
      access_token_encrypted: 'encrypted-koba-token',
    });
    expect(fakeLeaseDb.state.connections).toHaveLength(0);
    expect(fakeLeaseDb.state.otherInserts).toHaveLength(0);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SHOPIFY_APP_SWITCH_REFUSED' }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'app_switch_refused' }),
      }),
    );
  });

  it('laisse passer une boutique sans app rattachée (shopify_client_id null) — état normal après libération', async () => {
    fakeLeaseDb.state.shops.push({
      id: 'shop-released',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: null,
    });

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(errorParamFrom(response)).not.toBe('app_switch_refused');
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(fakeLeaseDb.state.shops[0]).toMatchObject({ shopify_client_id: APP.clientId });
  });

  it('laisse passer une reconnexion de la même app', async () => {
    fakeLeaseDb.state.shops.push({
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
    expect(fakeLeaseDb.state.shops).toHaveLength(1);
  });

  it('course sur l’identité d’app : refus sous verrou, refus fermé générique, aucune écriture secondaire', async () => {
    fakeLeaseDb.state.shops.push({
      id: 'shop-raced-app',
      shop_domain: SHOP_DOMAIN,
      merchant_account_id: TENANT_A,
      shopify_client_id: null,
    });
    fakeLeaseDb.state.onAfterGuardRead = () => {
      const row = fakeLeaseDb.state.shops.find((s) => s.id === 'shop-raced-app');
      if (row) row.shopify_client_id = 'concurrent-app-sentinel';
    };

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    // Refus GÉNÉRIQUE côté utilisateur : seul le refus de la garde PRÉALABLE porte
    // `app_switch_refused` (docs/lexique-microcopie.md).
    expect(errorParamFrom(response)).toBe('connection_failed');
    expect(fakeLeaseDb.state.shops[0]).toMatchObject({
      shopify_client_id: 'concurrent-app-sentinel',
    });
    expect(fakeLeaseDb.state.shops[0].access_token_encrypted).toBeUndefined();
    expect(fakeLeaseDb.state.connections).toHaveLength(0);
    expect(fakeLeaseDb.state.otherInserts).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_callback_shop_write_no_row',
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'shop_write_no_row' }),
        extra: expect.objectContaining({ outcome: 'app_switch_refused' }),
      }),
    );
  });
});

// ============================================================================================
// SHOPIFY-EXPIRING-TOKENS-01 — bail de jeton sur l'échange de code (preuves 4, 5 et 11) et
// distribution transmise à l'échange (preuves 1 et 2, côté route).
// ============================================================================================
describe('callback OAuth — bail de jeton (SHOPIFY-EXPIRING-TOKENS-01)', () => {
  beforeEach(resetHarness);

  it('preuve 4 — bail tenu : aucun échange de code, aucune écriture, refus nommé', async () => {
    fakeLeaseDb.holdLease(SHOP_DOMAIN);

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(errorParamFrom(response)).toBe('connection_in_progress');
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual(['acquire_shopify_token_lease']);
    expect(fakeLeaseDb.state.shops).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_token_lease_busy',
      expect.objectContaining({
        tags: expect.objectContaining({ operation: 'authorization_code' }),
      }),
    );
  });

  it('preuve 5 — bail perdu pendant l’échange : refus nommé, sentinelle propre, rien d’écrit', async () => {
    fakeLeaseDb.state.onBeforeRpc = (name) => {
      if (name === 'persist_shopify_credentials_fenced') {
        fakeLeaseDb.bumpLease(SHOP_DOMAIN);
      }
    };

    const { GET } = await import('@/app/api/shopify/callback/route');
    const response = await GET(buildRequest());

    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(errorParamFrom(response)).toBe('connection_in_progress');
    expect(fakeLeaseDb.state.shops).toHaveLength(0);
    expect(fakeLeaseDb.state.connections).toHaveLength(0);
    expect(fakeLeaseDb.state.otherInserts).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_token_lease_lost',
      expect.objectContaining({
        tags: expect.objectContaining({ operation: 'authorization_code' }),
      }),
    );
    // Distinct de l'échec d'écriture générique.
    expect(captureMessage).not.toHaveBeenCalledWith(
      'shopify_callback_shop_write_no_row',
      expect.anything(),
    );
  });

  it('preuve 11 — les quatre valeurs de jeton partent dans UNE seule RPC, sous la génération du bail', async () => {
    const { GET } = await import('@/app/api/shopify/callback/route');
    await GET(buildRequest());

    const persistCalls = fakeLeaseDb.state.rpcCalls.filter(
      (call) => call.name === 'persist_shopify_credentials_fenced',
    );
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].args).toMatchObject({
      p_mode: 'authorization_code',
      p_generation: 1,
      p_access_token_encrypted: 'encrypted-access-token-sentinel',
      p_refresh_token_encrypted: null,
      p_access_token_expires_at: null,
      p_refresh_token_expires_at: null,
    });
    expect(fakeLeaseDb.state.directWrites).toEqual([]);
  });

  it('libère le bail détenu après succès, sous sa génération', async () => {
    const { GET } = await import('@/app/api/shopify/callback/route');
    await GET(buildRequest());

    expect(fakeLeaseDb.state.releases).toEqual([{ shopDomain: SHOP_DOMAIN, generation: 1 }]);
    expect(fakeLeaseDb.state.leases.get(SHOP_DOMAIN)?.leaseExpiresAt).toBeNull();
  });

  it('transmet la distribution de l’app sélectionnée à l’échange de code', async () => {
    const { GET } = await import('@/app/api/shopify/callback/route');
    await GET(buildRequest());

    expect(exchangeCodeForToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: APP.clientId, distribution: 'custom' }),
    );
  });
});
