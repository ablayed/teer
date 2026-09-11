import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  intent: {
    id: '11111111-1111-4111-8111-111111111111',
    platform: 'woocommerce',
    external_identifier: 'https://store.example.test',
    expires_at: '2099-01-01T00:00:00.000Z',
    consumed_at: null as string | null,
  },
  intentFound: true,
  rpcResult: [{ result_code: 'ok', store_connection_id: '22222222-2222-4222-8222-222222222222' }],
  rpcError: null as { code: string } | null,
  readApiRoot: vi.fn(async () => ({ namespaces: ['wc/v3'] })),
  readIdentity: vi.fn(async () => ({
    claimedIdentity: 'https://store.example.test',
    canonicalIdentity: 'https://store.example.test',
    restUrl: 'https://store.example.test/wp-json/',
    homeUrl: 'https://store.example.test/',
  })),
  encrypt: vi.fn((_value: string) => 'encrypted-sentinel'),
  captureMessage: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-sentinel',
    NEXT_PUBLIC_APP_URL: 'https://app.example.test',
    CONNECTOR_CREDENTIALS_ENCRYPTION_KEY: '0'.repeat(64),
  },
}));

vi.mock('@/lib/connector-credentials/crypto', () => ({
  encryptConnectorCredential: (value: string) => harness.encrypt(value),
}));

vi.mock('@/lib/woocommerce/client', () => ({
  WooCommerceClientError: class WooCommerceClientError extends Error {
    code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  WooCommerceClient: class WooCommerceClient {
    readApiRoot = harness.readApiRoot;
    readIdentity = harness.readIdentity;
  },
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => ({
    from: (table: string) => {
      if (table !== 'store_connection_intent') throw new Error('unexpected table');
      return {
        select: () => ({
          eq: (_column: string, _value: string) => ({
            maybeSingle: async () => ({
              data: harness.intentFound ? harness.intent : null,
              error: null,
            }),
          }),
        }),
      };
    },
    rpc: harness.rpc,
  })),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: (...args: unknown[]) => harness.captureMessage(...args),
}));

function buildRequest(payload: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('https://app.example.test/api/woocommerce/callback', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

function buildRawRequest(body: string) {
  return new NextRequest('https://app.example.test/api/woocommerce/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

const validPayload = {
  key_id: '1',
  user_id: harness.intent.id,
  consumer_key: 'ck_synthetic',
  consumer_secret: 'cs_synthetic',
  key_permissions: 'read_write',
};

describe('callback WooCommerce sécurisé', () => {
  beforeEach(() => {
    harness.intentFound = true;
    harness.intent.platform = 'woocommerce';
    harness.intent.consumed_at = null;
    harness.rpcResult = [
      {
        result_code: 'ok',
        store_connection_id: '22222222-2222-4222-8222-222222222222',
      },
    ];
    harness.rpcError = null;
    harness.readApiRoot.mockReset().mockResolvedValue({ namespaces: ['wc/v3'] });
    harness.readIdentity.mockReset().mockResolvedValue({
      claimedIdentity: 'https://store.example.test',
      canonicalIdentity: 'https://store.example.test',
      restUrl: 'https://store.example.test/wp-json/',
      homeUrl: 'https://store.example.test/',
    });
    harness.encrypt.mockClear();
    harness.captureMessage.mockClear();
    harness.rpc.mockReset().mockResolvedValue({ data: harness.rpcResult, error: harness.rpcError });
  });

  it('refuse une intention inconnue ou un POST forgé sans appeler WooCommerce ni la RPC', async () => {
    harness.intentFound = false;
    const { POST } = await import('@/app/api/woocommerce/callback/route');

    const response = await POST(buildRequest(validPayload));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'connection_failed' });
    expect(harness.readApiRoot).not.toHaveBeenCalled();
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it('refuse une intention déjà consommée sans refaire un appel fournisseur', async () => {
    harness.intent.consumed_at = '2099-01-01T00:00:00.000Z';
    const { POST } = await import('@/app/api/woocommerce/callback/route');

    const response = await POST(buildRequest(validPayload));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'connection_failed' });
    expect(harness.readApiRoot).not.toHaveBeenCalled();
    expect(harness.rpc).not.toHaveBeenCalled();
    harness.intent.consumed_at = null;
  });

  it('refuse une intention d’une autre plateforme avant tout appel fournisseur', async () => {
    harness.intent.platform = 'shopify';
    const { POST } = await import('@/app/api/woocommerce/callback/route');

    const response = await POST(buildRequest(validPayload));

    expect(response.status).toBe(400);
    expect(harness.readApiRoot).not.toHaveBeenCalled();
    expect(harness.rpc).not.toHaveBeenCalled();
    harness.intent.platform = 'woocommerce';
  });

  it('refuse les champs supplémentaires et les corps trop volumineux', async () => {
    const { POST } = await import('@/app/api/woocommerce/callback/route');

    const extra = await POST(buildRequest({ ...validPayload, tenant_id: 'forged' }));
    expect(extra.status).toBe(400);
    expect(harness.rpc).not.toHaveBeenCalled();

    const oversized = await POST(
      buildRawRequest(`${JSON.stringify(validPayload)}${' '.repeat(40_000)}`),
    );
    expect(oversized.status).toBe(400);
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it('teste les credentials, relit l’identité, chiffre puis appelle une seule fois la primitive', async () => {
    const { POST } = await import('@/app/api/woocommerce/callback/route');

    const response = await POST(buildRequest(validPayload));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(harness.readApiRoot).toHaveBeenCalledOnce();
    expect(harness.readIdentity).toHaveBeenCalledOnce();
    expect(harness.encrypt).toHaveBeenNthCalledWith(1, 'ck_synthetic');
    expect(harness.encrypt).toHaveBeenNthCalledWith(2, 'cs_synthetic');
    expect(harness.rpc).toHaveBeenCalledOnce();
    expect(harness.rpc.mock.calls[0][0]).toBe('finalize_woocommerce_connection');
    expect(harness.rpc.mock.calls[0][1]).toMatchObject({
      p_intent_id: harness.intent.id,
      p_verified_identity: 'https://store.example.test',
      p_scheme: 'basic_consumer',
      p_consumer_key_encrypted: 'encrypted-sentinel',
      p_consumer_secret_encrypted: 'encrypted-sentinel',
      p_key_permissions: 'read_write',
    });
    expect(JSON.stringify(harness.rpc.mock.calls[0][1])).not.toContain('ck_synthetic');
    expect(JSON.stringify(harness.rpc.mock.calls[0][1])).not.toContain('cs_synthetic');
  });

  it('refuse les permissions insuffisantes sans persister de credential', async () => {
    const { POST } = await import('@/app/api/woocommerce/callback/route');

    const response = await POST(buildRequest({ ...validPayload, key_permissions: 'read' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'connection_failed' });
    expect(harness.rpc).not.toHaveBeenCalled();
    expect(harness.encrypt).not.toHaveBeenCalled();
  });

  it('refuse des credentials invalides et une identité divergente en fermé', async () => {
    const { POST } = await import('@/app/api/woocommerce/callback/route');
    harness.readApiRoot.mockRejectedValueOnce(new Error('credentials_invalid'));
    const invalidCredentials = await POST(buildRequest(validPayload));
    expect(invalidCredentials.status).toBe(400);
    expect(harness.rpc).not.toHaveBeenCalled();

    harness.readApiRoot.mockResolvedValueOnce({ namespaces: ['wc/v3'] });
    harness.readIdentity.mockRejectedValueOnce(new Error('identity_mismatch'));
    const divergentIdentity = await POST(buildRequest(validPayload));
    expect(divergentIdentity.status).toBe(400);
    expect(harness.rpc).not.toHaveBeenCalled();
  });

  it('journalise distinctement une expiration après validation amont et masque les refus nommés', async () => {
    const { POST } = await import('@/app/api/woocommerce/callback/route');
    harness.rpc.mockResolvedValueOnce({
      data: [{ result_code: 'intent_expired', store_connection_id: null }],
      error: null,
    });

    const expired = await POST(buildRequest(validPayload));
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ error: 'connection_failed' });
    expect(harness.captureMessage).toHaveBeenCalledWith(
      'woocommerce_callback_intent_expired_after_validation',
      { level: 'warning' },
    );

    harness.captureMessage.mockClear();
    harness.rpc.mockResolvedValueOnce({
      data: [{ result_code: 'identity_already_assigned', store_connection_id: null }],
      error: null,
    });
    const crossTenant = await POST(buildRequest(validPayload));
    expect(crossTenant.status).toBe(400);
    expect(await crossTenant.json()).toEqual({ error: 'connection_failed' });
    expect(harness.captureMessage).toHaveBeenCalledWith('woocommerce_callback_refused', {
      level: 'warning',
      tags: { reason: 'identity_already_assigned' },
    });
  });
});
