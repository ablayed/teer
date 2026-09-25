// APP-03 / Lot 2 — confrontation d'identité d'app avant tout `ready` sur la session embarquée
// (GET /api/shopify/embedded/session). Avant ce lot, cette route n'avait aucun test dédié.
//
// SHOPIFY-EXPIRING-TOKENS-01 — la persistance passe par `persist_shopify_credentials_fenced`
// (mode `token_exchange`) sous bail de jeton ; le faux client modélise ces RPC en mémoire
// (tests/unit/helpers/fake-shopify-lease-db.ts).
import { fakeLeaseDb } from '@/tests/unit/helpers/fake-shopify-lease-db';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC_APP = {
  label: 'teer-public' as const,
  distribution: 'public' as const,
  clientId: 'public_client_sentinel',
  clientSecret: 'public_secret_sentinel',
};

const harness = vi.hoisted(() => ({
  tokenExchangeShouldFail: false,
  raceAfterTokenExchange: null as (() => void) | null,
}));

vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByClientId: vi.fn((clientId: string | null) =>
    clientId === PUBLIC_APP.clientId ? PUBLIC_APP : null,
  ),
}));

vi.mock('@/lib/shopify/session-token', () => ({
  extractShopifySessionAudience: vi.fn(() => PUBLIC_APP.clientId),
  verifyShopifySessionToken: vi.fn(() => ({
    ok: true,
    shopDomain: 'shared-domain.myshopify.com',
    claims: {
      aud: PUBLIC_APP.clientId,
      dest: 'https://shared-domain.myshopify.com',
      exp: 9999999999,
      iat: 1,
      iss: 'https://shared-domain.myshopify.com/admin',
      nbf: 1,
      sub: 'user-sentinel',
    },
  })),
}));

vi.mock('@/lib/shopify/oauth', () => ({
  exchangeIdTokenForOfflineToken: vi.fn(async (_input: Record<string, unknown>) => {
    if (harness.tokenExchangeShouldFail) {
      throw new Error('shopify_token_exchange_failed_sentinel');
    }
    // Fenêtre de course réaliste : le token exchange est l'appel réseau qui dure, entre la
    // lecture de garde (confrontation d'identité d'app, GET) et l'écriture de persistance.
    const race = harness.raceAfterTokenExchange;
    harness.raceAfterTokenExchange = null;
    race?.();
    return {
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token',
      scope: 'read_customers,read_orders,read_products',
      accessTokenExpiresAt: new Date('2026-01-01T01:00:00.000Z'),
      refreshTokenExpiresAt: new Date('2026-04-01T00:00:00.000Z'),
    };
  }),
}));

vi.mock('@/lib/shopify/crypto', () => ({
  encryptToken: vi.fn((value: string) => `encrypted-${value}`),
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

type ShopFixture = Record<string, unknown> & { shop_domain: string };

function setShop(shop: ShopFixture | null) {
  fakeLeaseDb.state.shops.length = 0;
  if (shop) {
    fakeLeaseDb.state.shops.push({
      id: 'shop-fixture',
      merchant_account_id: 'tenant-sentinel',
      ...shop,
    });
  }
}

function currentShop() {
  return fakeLeaseDb.state.shops[0];
}

function rpcCalls(name: string) {
  return fakeLeaseDb.state.rpcCalls.filter((call) => call.name === name);
}

function buildRequest() {
  return new NextRequest('http://localhost:3000/api/shopify/embedded/session', {
    headers: { authorization: 'Bearer synthetic-session-token' },
  });
}

describe('GET /api/shopify/embedded/session — confrontation d’identité d’app', () => {
  beforeEach(() => {
    fakeLeaseDb.reset();
    harness.tokenExchangeShouldFail = false;
    harness.raceAfterTokenExchange = null;
    captureException.mockClear();
    captureMessage.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
    process.env.SHOPIFY_API_SECRET = 'intent-secret-sentinel';
  });

  it('renvoie ready quand shopify_client_id correspond exactement à l’app ayant vérifié le token', async () => {
    setShop({
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'active',
      access_token_encrypted: 'encrypted-token-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.shop.domain).toBe('shared-domain.myshopify.com');
    expect(captureException).not.toHaveBeenCalled();
  });

  it('réinstallation actionnable : uninstalled + ID token frais relance le token exchange (jamais /api/shopify/install), retombe ready au succès', async () => {
    setShop({
      id: 'shop-reinstall',
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'uninstalled',
      access_token_encrypted: 'stale-encrypted-token-sentinel',
      merchant_account_id: 'tenant-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body.status).toBe('ready');
    // L'ancien access_token_encrypted n'est jamais relu ni transmis à Shopify — seul le nouvel
    // ID token (déjà vérifié) sert de subject_token ; la ligne est écrasée par le nouveau couple.
    expect(rpcCalls('persist_shopify_credentials_fenced')).toHaveLength(1);
    // Attendus fermant la course, comparés SOUS VERROU par la RPC : locataire + app stricte.
    expect(rpcCalls('persist_shopify_credentials_fenced')[0].args).toMatchObject({
      p_mode: 'token_exchange',
      p_merchant_account_id: 'tenant-sentinel',
      p_client_id: PUBLIC_APP.clientId,
      p_access_token_encrypted: 'encrypted-fresh-access-token',
    });
    expect(currentShop()).toMatchObject({
      access_token_encrypted: 'encrypted-fresh-access-token',
      status: 'active',
    });
    expect(fakeLeaseDb.state.directWrites).toEqual([]);
  });

  it('réinstallation : un échec de token exchange ne bloque jamais sur un état ready trompeur (link_retry, statut inchangé côté écriture)', async () => {
    setShop({
      id: 'shop-reinstall',
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'uninstalled',
      access_token_encrypted: 'stale-encrypted-token-sentinel',
      merchant_account_id: 'tenant-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });
    harness.tokenExchangeShouldFail = true;

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body).toEqual({
      status: 'link_retry',
      shop: { domain: 'shared-domain.myshopify.com' },
    });
    expect(rpcCalls('persist_shopify_credentials_fenced')).toHaveLength(0);
  });

  it('renvoie not_configured quand aucune ligne shop n’existe pour ce domaine', async () => {
    setShop(null);

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body.status).toBe('not_configured');
    expect(body.shop.domain).toBe('shared-domain.myshopify.com');
  });

  it('refuse en fermé quand la boutique appartient à une autre app (ex. KOBA) — jamais ready, aucune identité historique dans la réponse', async () => {
    setShop({
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: 'koba_client_sentinel',
      status: 'active',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'app_identity_mismatch' });
    expect(body.status).not.toBe('ready');
    expect(body.status).not.toBe('not_configured');
    expect(JSON.stringify(body)).not.toContain('koba_client_sentinel');
    expect(JSON.stringify(body)).not.toContain(PUBLIC_APP.clientId);
    expect(JSON.stringify(body)).not.toContain('shared-domain.myshopify.com');
    // Aucun lien d'installation offert, et aucune ecriture : le correctif du cas NULL ci-dessus
    // ne doit jamais degrader ce refus en simple avertissement.
    expect(body).not.toHaveProperty('loginUrl');
    expect(body).not.toHaveProperty('nextAction');
    expect(rpcCalls('persist_shopify_credentials_fenced')).toHaveLength(0);
    expect(fakeLeaseDb.state.connections).toHaveLength(0);
  });

  // Défaut mesuré en production sur le chemin de l'étape 8 du runbook option D : une boutique
  // libérée par l'action owner (shopify_client_id NULL, store_connection.platform_app_id NULL,
  // status 'uninstalled', credentials NULL) était irrattachable — cette route répondait
  // app_identity_mismatch, que la surface embarquée ne sait pas nommer et rend en erreur fermée
  // (« Impossible de vérifier l'installation Shopify »). NULL veut dire « aucune app rattachée »,
  // jamais « une autre app » : c'est le motif `is distinct from` du projet. La PR #199 avait
  // verrouillé l'inverse par un test — celui-ci le remplace, il ne s'y ajoute pas.
  it('boutique libérée (shopify_client_id NULL) : état invitant au rattachement, jamais app_identity_mismatch', async () => {
    setShop({
      id: 'shop-released',
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: null,
      status: 'uninstalled',
      access_token_encrypted: null,
      merchant_account_id: 'tenant-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('not_configured');
    expect(body.status).not.toBe('app_identity_mismatch');
    expect(body.shop.domain).toBe('shared-domain.myshopify.com');
    expect(body.nextAction).toBe('associate_teer');
    // Réponse strictement identique à celle d'une boutique inconnue : le client n'a aucun état
    // supplémentaire à connaître, et rien de la ligne résiduelle n'est exposé.
    expect(body).not.toHaveProperty('shop.installedAt');
    // Aucun échange de token ni écriture tant que le rattachement n'a pas été confirmé par un
    // utilisateur authentifié — l'invitation n'est pas un rattachement.
    expect(rpcCalls('persist_shopify_credentials_fenced')).toHaveLength(0);
    expect(fakeLeaseDb.state.connections).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('boutique libérée : l’invitation est réellement actionnable (loginUrl signée quand host est valide)', async () => {
    setShop({
      id: 'shop-released',
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: null,
      status: 'uninstalled',
      access_token_encrypted: null,
      merchant_account_id: 'tenant-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });
    const validHost = Buffer.from('admin.shopify.com/store/shared-domain', 'utf8').toString(
      'base64url',
    );

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const request = new NextRequest(
      `http://localhost:3000/api/shopify/embedded/session?host=${validHost}`,
      { headers: { authorization: 'Bearer synthetic-session-token' } },
    );
    const response = await GET(request);
    const body = await response.json();

    expect(body.status).toBe('not_configured');
    expect(typeof body.loginUrl).toBe('string');
    const redirectTo = decodeURIComponent(body.loginUrl.split('redirectTo=')[1]);
    expect(redirectTo).toContain('/shopify/embedded-link?intent=');
  });

  it('capture une exception interne avec un code stable, jamais déduit du texte du message', async () => {
    setShop({
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: 'koba_client_sentinel',
      status: 'active',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    await GET(buildRequest());

    expect(captureException).toHaveBeenCalledTimes(1);
    const [capturedError, capturedOptions] = captureException.mock.calls[0];
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as { code: string }).code).toBe('SHOPIFY_APP_IDENTITY_MISMATCH');
    expect(capturedOptions).toMatchObject({
      tags: expect.objectContaining({ reason: 'app_identity_mismatch' }),
    });
  });

  it('renvoie une loginUrl signée quand la boutique est not_configured ET host valide', async () => {
    setShop(null);
    const validHost = Buffer.from('admin.shopify.com/store/shared-domain', 'utf8').toString(
      'base64url',
    );

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const request = new NextRequest(
      `http://localhost:3000/api/shopify/embedded/session?host=${validHost}`,
      { headers: { authorization: 'Bearer synthetic-session-token' } },
    );
    const response = await GET(request);
    const body = await response.json();

    expect(body.status).toBe('not_configured');
    expect(typeof body.loginUrl).toBe('string');
    expect(body.loginUrl).toContain('/connexion?redirectTo=');
    const redirectTo = decodeURIComponent(body.loginUrl.split('redirectTo=')[1]);
    expect(redirectTo).toContain('/shopify/embedded-link?intent=');
  });

  it('n’expose aucune loginUrl quand host est absent ou invalide (fermé, jamais de destination devinée)', async () => {
    setShop(null);

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body.status).toBe('not_configured');
    expect(body).not.toHaveProperty('loginUrl');
  });

  it('n’expose jamais de loginUrl pour une app historique, même avec un host valide (parcours legacy inchangé)', async () => {
    setShop(null);
    const { getShopifyAppByClientId } = await import('@/lib/shopify/apps');
    const { extractShopifySessionAudience, verifyShopifySessionToken } = await import(
      '@/lib/shopify/session-token'
    );
    const DEV_APP = {
      label: 'teer-dev' as const,
      distribution: 'custom' as const,
      clientId: 'dev_client_sentinel',
      clientSecret: 'dev_secret_sentinel',
      scopes: 'read_customers,read_orders,read_products',
    };
    vi.mocked(getShopifyAppByClientId).mockReturnValueOnce(DEV_APP);
    vi.mocked(extractShopifySessionAudience).mockReturnValueOnce(DEV_APP.clientId);
    vi.mocked(verifyShopifySessionToken).mockReturnValueOnce({
      ok: true,
      shopDomain: 'shared-domain.myshopify.com',
      claims: {
        aud: DEV_APP.clientId,
        dest: 'https://shared-domain.myshopify.com',
        exp: 9999999999,
        iat: 1,
        iss: 'https://shared-domain.myshopify.com/admin',
        nbf: 1,
        sub: 'user-sentinel',
      },
    });
    const validHost = Buffer.from('admin.shopify.com/store/shared-domain', 'utf8').toString(
      'base64url',
    );

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const request = new NextRequest(
      `http://localhost:3000/api/shopify/embedded/session?host=${validHost}`,
      { headers: { authorization: 'Bearer synthetic-session-token' } },
    );
    const response = await GET(request);
    const body = await response.json();

    expect(body.status).toBe('not_configured');
    expect(body.appLabel).toBe('teer-dev');
    expect(body).not.toHaveProperty('loginUrl');
  });

  it('complète le rattachement en attente : token exchange + persistance + store_connection, jamais un second aller-retour', async () => {
    setShop({
      id: 'shop-pending',
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'active',
      access_token_encrypted: null,
      merchant_account_id: 'tenant-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body.status).toBe('ready');
    expect(rpcCalls('persist_shopify_credentials_fenced')).toHaveLength(1);
    expect(currentShop()).toMatchObject({
      access_token_encrypted: 'encrypted-fresh-access-token',
      refresh_token_encrypted: 'encrypted-fresh-refresh-token',
    });
    expect(fakeLeaseDb.state.connections).toHaveLength(1);
    expect(fakeLeaseDb.state.connections[0]).toMatchObject({
      shop_id: 'shop-pending',
      platform: 'shopify',
      external_identifier: 'shared-domain.myshopify.com',
      platform_app_id: PUBLIC_APP.clientId,
      merchant_account_id: 'tenant-sentinel',
      status: 'active',
    });
  });

  it('renvoie link_retry sans écriture partielle quand le token exchange échoue', async () => {
    setShop({
      id: 'shop-pending',
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'active',
      access_token_encrypted: null,
      merchant_account_id: 'tenant-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });
    harness.tokenExchangeShouldFail = true;

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body).toEqual({
      status: 'link_retry',
      shop: { domain: 'shared-domain.myshopify.com' },
    });
    expect(rpcCalls('persist_shopify_credentials_fenced')).toHaveLength(0);
    expect(fakeLeaseDb.state.connections).toHaveLength(0);
  });

  it('refuse en fermé (fail-closed) si une bascule d’app concurrente survient pendant le token exchange, entre la lecture de garde et la persistance', async () => {
    setShop({
      id: 'shop-raced',
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'active',
      access_token_encrypted: null,
      merchant_account_id: 'tenant-sentinel',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    });
    // La confrontation d'identité d'app (GET, plus haut) lit shopify_client_id === PUBLIC_APP —
    // autorise. Pendant le token exchange (le seul appel réseau de ce chemin), une autre requête
    // réassigne la ligne à une autre app — le prédicat .eq('shopify_client_id', app.clientId) de
    // la persistance ne doit alors matcher aucune ligne : échec fermé, jamais un succès trompeur.
    harness.raceAfterTokenExchange = () => {
      const shop = currentShop();
      if (shop) shop.shopify_client_id = 'koba_client_sentinel';
    };

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body).toEqual({
      status: 'link_retry',
      shop: { domain: 'shared-domain.myshopify.com' },
    });
    expect(currentShop().access_token_encrypted).toBeNull();
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'shopify_credentials_persist_failed' }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: 'credentials_persist_failed' }),
      }),
    );
  });
});

// ============================================================================================
// SHOPIFY-EXPIRING-TOKENS-01 — bail de jeton sur l'échange par ID token (preuves 4, 5, 11) et
// distribution transmise à l'échange (preuves 1 et 2, côté route).
// ============================================================================================
describe('GET /api/shopify/embedded/session — bail de jeton (SHOPIFY-EXPIRING-TOKENS-01)', () => {
  const PENDING_SHOP = {
    id: 'shop-pending',
    shop_domain: 'shared-domain.myshopify.com',
    shopify_client_id: PUBLIC_APP.clientId,
    status: 'active',
    access_token_encrypted: null,
    merchant_account_id: 'tenant-sentinel',
    installed_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    last_reconciled_at: null,
  };

  beforeEach(() => {
    fakeLeaseDb.reset();
    harness.tokenExchangeShouldFail = false;
    harness.raceAfterTokenExchange = null;
    captureException.mockClear();
    captureMessage.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
    process.env.SHOPIFY_API_SECRET = 'intent-secret-sentinel';
  });

  it('preuve 4 — bail tenu : aucun échange par ID token, aucune écriture, link_retry', async () => {
    setShop({ ...PENDING_SHOP });
    fakeLeaseDb.holdLease(PENDING_SHOP.shop_domain);
    const { exchangeIdTokenForOfflineToken } = await import('@/lib/shopify/oauth');
    vi.mocked(exchangeIdTokenForOfflineToken).mockClear();

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const body = await (await GET(buildRequest())).json();

    expect(body.status).toBe('link_retry');
    expect(exchangeIdTokenForOfflineToken).not.toHaveBeenCalled();
    expect(fakeLeaseDb.state.rpcCalls.map((call) => call.name)).toEqual([
      'acquire_shopify_token_lease',
    ]);
    expect(currentShop().access_token_encrypted).toBeNull();
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_token_lease_busy',
      expect.objectContaining({ tags: expect.objectContaining({ operation: 'token_exchange' }) }),
    );
  });

  it('preuve 5 — bail perdu pendant l’échange : sentinelle propre, rien d’écrit', async () => {
    setShop({ ...PENDING_SHOP });
    harness.raceAfterTokenExchange = () => fakeLeaseDb.bumpLease(PENDING_SHOP.shop_domain);

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const body = await (await GET(buildRequest())).json();

    expect(body.status).toBe('link_retry');
    expect(currentShop().access_token_encrypted).toBeNull();
    expect(fakeLeaseDb.state.connections).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_token_lease_lost',
      expect.objectContaining({ tags: expect.objectContaining({ operation: 'token_exchange' }) }),
    );
    expect(captureException).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'shopify_credentials_persist_failed' }),
      expect.anything(),
    );
  });

  it('preuve 11 — une seule RPC porte les quatre valeurs, puis le bail est libéré', async () => {
    setShop({ ...PENDING_SHOP });

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    await GET(buildRequest());

    expect(rpcCalls('persist_shopify_credentials_fenced')).toHaveLength(1);
    expect(rpcCalls('persist_shopify_credentials_fenced')[0].args).toMatchObject({
      p_mode: 'token_exchange',
      p_generation: 1,
      p_access_token_encrypted: 'encrypted-fresh-access-token',
      p_refresh_token_encrypted: 'encrypted-fresh-refresh-token',
      p_access_token_expires_at: '2026-01-01T01:00:00.000Z',
      p_refresh_token_expires_at: '2026-04-01T00:00:00.000Z',
    });
    expect(fakeLeaseDb.state.releases).toEqual([
      { shopDomain: PENDING_SHOP.shop_domain, generation: 1 },
    ]);
  });

  it('transmet la distribution de l’app (publique ici) à l’échange par ID token', async () => {
    setShop({ ...PENDING_SHOP });
    const { exchangeIdTokenForOfflineToken } = await import('@/lib/shopify/oauth');
    vi.mocked(exchangeIdTokenForOfflineToken).mockClear();

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    await GET(buildRequest());

    expect(exchangeIdTokenForOfflineToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: PUBLIC_APP.clientId, distribution: 'public' }),
    );
  });
});
