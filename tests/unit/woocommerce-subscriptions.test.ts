import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  connection: {
    id: '11111111-1111-4111-8111-111111111111',
    merchant_account_id: '22222222-2222-4222-8222-222222222222',
    shop_id: '33333333-3333-4333-8333-333333333333',
    platform: 'woocommerce',
    external_identifier: 'https://store.example.test',
    status: 'provisioning',
  },
  credential: {
    scheme: 'basic_consumer',
    consumer_key_encrypted: 'enc:consumer-key',
    consumer_secret_encrypted: 'enc:consumer-secret',
  },
  subscriptions: new Map<string, Record<string, unknown>>(),
  remote: new Map<string, Record<string, unknown>>(),
  remoteWrites: [] as Array<Record<string, unknown>>,
  remoteCreateCalls: 0,
  remoteListCalls: 0,
  nextProviderId: 0,
  failTopic: null as string | null,
  loseResponseTopic: null as string | null,
  mismatchTopic: null as string | null,
  readJson: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-sentinel',
    NEXT_PUBLIC_APP_URL: 'https://app.example.test',
    CONNECTOR_CREDENTIALS_ENCRYPTION_KEY: '01'.repeat(32),
  },
}));

vi.mock('@/lib/connector-credentials/crypto', () => ({
  encryptConnectorCredential: vi.fn((value: string) => `enc:${value}`),
  decryptConnectorCredential: vi.fn((value: string) => value.replace(/^enc:/, '')),
}));

vi.mock('@/lib/woocommerce/client', () => ({
  WooCommerceClientError: class WooCommerceClientError extends Error {
    code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  WooCommerceClient: class WooCommerceClient {},
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(),
}));

function subscriptionKey(connectionId: string, topic: string): string {
  return `${connectionId}:${topic}`;
}

function localRow(payload: Record<string, unknown>) {
  return {
    id: payload.id,
    store_connection_id: payload.store_connection_id,
    merchant_account_id: payload.merchant_account_id,
    shop_id: payload.shop_id,
    provider_subscription_id: null,
    topic: payload.topic,
    delivery_token_hash: payload.delivery_token_hash,
    secret_encrypted: payload.secret_encrypted,
    status: payload.status,
    created_at: payload.created_at,
    updated_at: payload.updated_at,
  };
}

function fakeAdmin() {
  return {
    from(table: string) {
      if (table === 'store_connection') {
        return {
          select: () => ({
            eq: (_column: string, _value: string) => ({
              maybeSingle: async () => ({ data: harness.connection, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            const builder = {
              eq: (_column: string, _value: string) => builder,
              // biome-ignore lint/suspicious/noThenProperty: simulation of the awaitable Supabase builder
              then: (resolve: (value: { error: null }) => void) => {
                Object.assign(harness.connection, payload);
                resolve({ error: null });
              },
            };
            return builder;
          },
        };
      }

      if (table === 'store_connection_credential') {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                maybeSingle: async () => ({ data: harness.credential, error: null }),
              }),
            }),
          }),
        };
      }

      if (table === 'store_connection_webhook_subscription') {
        return {
          select: () => ({
            eq: (_firstColumn: string, connectionId: string) => ({
              eq: (_secondColumn: string, topic: string) => ({
                maybeSingle: async () => ({
                  data: harness.subscriptions.get(subscriptionKey(connectionId, topic)) ?? null,
                  error: null,
                }),
              }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                const key = subscriptionKey(
                  String(payload.store_connection_id),
                  String(payload.topic),
                );
                if (harness.subscriptions.has(key)) {
                  return { data: null, error: { code: '23505' } };
                }
                const row = localRow(payload);
                harness.subscriptions.set(key, row);
                return { data: row, error: null };
              },
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async (_column: string, id: string) => {
              const row = [...harness.subscriptions.values()].find((item) => item.id === id);
              if (row) Object.assign(row, payload);
              return { error: row ? null : { code: 'PGRST116' } };
            },
          }),
        };
      }

      throw new Error(`unexpected table ${table}`);
    },
  };
}

function fakeClient() {
  harness.readJson.mockImplementation(async (path: string) => {
    if (path === 'wp-json/wc/v3/webhooks') {
      harness.remoteListCalls += 1;
      if (harness.failTopic === 'list') throw new Error('list_failed');
      return [...harness.remote.values()];
    }
    const id = path.split('/').pop() ?? '';
    const webhook = harness.remote.get(id);
    if (!webhook) throw new Error('not_found');
    return webhook;
  });
  harness.writeJson.mockImplementation(async (_path: string, payload: Record<string, unknown>) => {
    const topic = String(payload.topic);
    harness.remoteCreateCalls += 1;
    if (harness.failTopic === topic) throw new Error('create_failed');
    harness.nextProviderId += 1;
    const id = String(harness.nextProviderId);
    const webhook = {
      id,
      topic,
      status: harness.mismatchTopic === topic ? 'paused' : 'active',
      delivery_url: payload.delivery_url,
    };
    harness.remote.set(id, webhook);
    harness.remoteWrites.push(payload);
    if (harness.loseResponseTopic === topic) throw new Error('response_lost');
    return webhook;
  });
  return {
    readJson: harness.readJson,
    writeJson: harness.writeJson,
  };
}

describe('provisionnement des abonnements WooCommerce', () => {
  beforeEach(() => {
    harness.connection.status = 'provisioning';
    harness.subscriptions.clear();
    harness.remote.clear();
    harness.remoteWrites.length = 0;
    harness.remoteCreateCalls = 0;
    harness.remoteListCalls = 0;
    harness.nextProviderId = 0;
    harness.failTopic = null;
    harness.loseResponseTopic = null;
    harness.mismatchTopic = null;
    harness.readJson.mockReset();
    harness.writeJson.mockReset();
  });

  it('crée deux topics distincts, transmet deux secrets distincts et active après relecture', async () => {
    const { provisionWooCommerceSubscriptions } = await import('@/lib/woocommerce/subscriptions');
    const result = await provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
    });

    expect(result).toEqual({ ok: true });
    expect(harness.connection.status).toBe('active');
    expect(harness.subscriptions.size).toBe(2);
    expect(
      [...harness.subscriptions.values()].every(
        (row) => row.status === 'active' && typeof row.provider_subscription_id === 'string',
      ),
    ).toBe(true);
    expect(harness.remoteWrites).toHaveLength(2);
    expect(new Set(harness.remoteWrites.map((payload) => payload.secret)).size).toBe(2);
    expect(
      harness.remoteWrites.every((payload) =>
        String(payload.delivery_url).includes('/api/woocommerce/webhooks/'),
      ),
    ).toBe(true);

    const deliveryTokens = [...harness.remote.values()].map((webhook) => {
      const token = new URL(String(webhook.delivery_url)).pathname.split('/').pop();
      if (!token) throw new Error('delivery token absent');
      return token;
    });
    expect(new Set(deliveryTokens).size).toBe(2);
    expect(deliveryTokens.every((token) => token.length === 43)).toBe(true);
    expect(
      [...harness.subscriptions.values()].every(
        (row) => !deliveryTokens.some((token) => JSON.stringify(row).includes(token)),
      ),
    ).toBe(true);
    expect(
      deliveryTokens.every(
        (token) => createHash('sha256').update(token, 'utf8').digest('hex') !== token,
      ),
    ).toBe(true);
  });

  it('récupère une réponse perdue et ne crée aucun doublon au retry', async () => {
    harness.loseResponseTopic = 'order.created';
    const { provisionWooCommerceSubscriptions } = await import('@/lib/woocommerce/subscriptions');
    const first = await provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
    });
    const createdCallsAfterFirstRun = harness.remoteCreateCalls;
    const createdTopic = harness.subscriptions.get(
      subscriptionKey(harness.connection.id, 'order.created'),
    );
    if (!createdTopic) throw new Error('created local subscription absent');
    // Simule un crash après la création distante et avant la persistance de l'identifiant local.
    Object.assign(createdTopic, {
      provider_subscription_id: null,
      status: 'provisioning',
      updated_at: '2020-01-01T00:00:00.000Z',
    });
    const second = await provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
    });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(harness.remote.size).toBe(2);
    expect(harness.remoteWrites).toHaveLength(2);
    expect(createdCallsAfterFirstRun).toBe(2);
    expect(harness.remoteCreateCalls).toBe(2);
    expect(harness.remoteListCalls).toBeGreaterThan(0);
  });

  it('laisse le parent en provisioning si le premier ou le second topic échoue', async () => {
    const { provisionWooCommerceSubscriptions } = await import('@/lib/woocommerce/subscriptions');
    harness.failTopic = 'order.created';
    const first = await provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
    });
    expect(first).toEqual({ ok: false, errorCode: 'subscription_remote_failed' });
    expect(harness.connection.status).toBe('provisioning');

    beforeEachReset();
    harness.failTopic = 'order.updated';
    const second = await provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
    });
    expect(second).toEqual({ ok: false, errorCode: 'subscription_remote_failed' });
    expect(harness.connection.status).toBe('provisioning');
    expect(
      harness.subscriptions.get(subscriptionKey(harness.connection.id, 'order.created'))?.status,
    ).toBe('active');
    expect(
      harness.subscriptions.get(subscriptionKey(harness.connection.id, 'order.updated'))?.status,
    ).toBe('provisioning');
  });

  it('refuse une relecture discordante et ne passe jamais le parent à active', async () => {
    harness.mismatchTopic = 'order.created';
    const { provisionWooCommerceSubscriptions } = await import('@/lib/woocommerce/subscriptions');
    const result = await provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
    });

    expect(result).toEqual({ ok: false, errorCode: 'subscription_verification_failed' });
    expect(harness.connection.status).toBe('provisioning');
  });

  it('ne passe à needs_reauth que sur une invalidité de credentials établie par l’API', async () => {
    const { WooCommerceClientError } = await import('@/lib/woocommerce/client');
    const { provisionWooCommerceSubscriptions } = await import('@/lib/woocommerce/subscriptions');
    const client = fakeClient();
    harness.readJson.mockRejectedValue(new WooCommerceClientError('credentials_invalid'));

    const result = await provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: client as never,
    });

    expect(result).toEqual({ ok: false, errorCode: 'credentials_invalid' });
    expect(harness.connection.status).toBe('needs_reauth');
  });

  it.each([
    ['permission insuffisante', 'woocommerce_access_denied'],
    ['timeout', 'timeout'],
  ])('erreur %s : statut inchangÃ©', async (_label, code) => {
    const { WooCommerceClientError } = await import('@/lib/woocommerce/client');
    const { provisionWooCommerceSubscriptions } = await import('@/lib/woocommerce/subscriptions');
    harness.connection.status = 'active';
    const client = fakeClient();
    harness.readJson.mockRejectedValue(
      new WooCommerceClientError(
        code as 'woocommerce_access_denied' | 'upstream_unavailable' | 'timeout',
      ),
    );

    const result = await provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: client as never,
    });

    expect(result).toEqual({ ok: false, errorCode: 'subscription_remote_failed' });
    expect(harness.connection.status).toBe('active');
  });

  it('un 500 pendant le POST distant laisse le statut de connexion inchangÃ©', async () => {
    const { WooCommerceClientError } = await import('@/lib/woocommerce/client');
    const { provisionWooCommerceSubscriptions } = await import('@/lib/woocommerce/subscriptions');
    harness.connection.status = 'active';
    const client = fakeClient();
    harness.writeJson.mockRejectedValue(new WooCommerceClientError('upstream_unavailable', 500));

    const result = await provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: client as never,
    });

    expect(result).toEqual({ ok: false, errorCode: 'subscription_remote_failed' });
    expect(harness.connection.status).toBe('active');
  });

  it('réserve les topics avant l’appel distant et sérialise deux provisionnements concurrents', async () => {
    const { provisionWooCommerceSubscriptions } = await import('@/lib/woocommerce/subscriptions');
    const one = provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
    });
    const two = provisionWooCommerceSubscriptions(harness.connection.id, {
      admin: fakeAdmin() as never,
      client: fakeClient() as never,
    });

    await expect(Promise.all([one, two])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(harness.remoteWrites).toHaveLength(2);
    expect(harness.subscriptions.size).toBe(2);
    expect(harness.connection.status).toBe('active');
  });
});

function beforeEachReset(): void {
  harness.connection.status = 'provisioning';
  harness.subscriptions.clear();
  harness.remote.clear();
  harness.remoteWrites.length = 0;
  harness.remoteCreateCalls = 0;
  harness.remoteListCalls = 0;
  harness.nextProviderId = 0;
  harness.failTopic = null;
  harness.loseResponseTopic = null;
  harness.mismatchTopic = null;
  harness.readJson.mockReset();
  harness.writeJson.mockReset();
}
