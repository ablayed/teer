// APP-03 / Lot 2 — confrontation d'identité d'app avant tout `ready` sur la session embarquée
// (GET /api/shopify/embedded/session). Avant ce lot, cette route n'avait aucun test dédié.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC_APP = {
  label: 'teer-public' as const,
  clientId: 'public_client_sentinel',
  clientSecret: 'public_secret_sentinel',
};

const harness = vi.hoisted(() => ({
  shop: null as Record<string, unknown> | null,
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

const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({
    from(table: string) {
      if (table !== 'shop') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: harness.shop, error: null }),
          }),
        }),
      };
    },
  })),
}));

function buildRequest() {
  return new NextRequest('http://localhost:3000/api/shopify/embedded/session', {
    headers: { authorization: 'Bearer synthetic-session-token' },
  });
}

describe('GET /api/shopify/embedded/session — confrontation d’identité d’app', () => {
  beforeEach(() => {
    harness.shop = null;
    captureException.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
  });

  it('renvoie ready quand shopify_client_id correspond exactement à l’app ayant vérifié le token', async () => {
    harness.shop = {
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'active',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.shop.domain).toBe('shared-domain.myshopify.com');
    expect(captureException).not.toHaveBeenCalled();
  });

  it('renvoie uninstalled quand le statut est uninstalled, app inchangée', async () => {
    harness.shop = {
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'uninstalled',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body.status).toBe('uninstalled');
    expect(body.nextAction).toBe('reinstall');
  });

  it('renvoie not_configured quand aucune ligne shop n’existe pour ce domaine', async () => {
    harness.shop = null;

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body.status).toBe('not_configured');
    expect(body.shop.domain).toBe('shared-domain.myshopify.com');
  });

  it('refuse en fermé quand la boutique appartient à une autre app (ex. KOBA) — jamais ready, aucune identité historique dans la réponse', async () => {
    harness.shop = {
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: 'koba_client_sentinel',
      status: 'active',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

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
  });

  it('refuse en fermé quand shopify_client_id est NULL (boutique legacy) — jamais de repli implicite vers une app par défaut', async () => {
    harness.shop = {
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: null,
      status: 'active',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

    const { GET } = await import('@/app/api/shopify/embedded/session/route');
    const response = await GET(buildRequest());
    const body = await response.json();

    expect(body).toEqual({ status: 'app_identity_mismatch' });
  });

  it('capture une exception interne avec un code stable, jamais déduit du texte du message', async () => {
    harness.shop = {
      shop_domain: 'shared-domain.myshopify.com',
      shopify_client_id: 'koba_client_sentinel',
      status: 'active',
      installed_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      last_reconciled_at: null,
    };

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
});
