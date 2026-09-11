import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  appUrl: 'https://app.example.test',
  resolveShopContext: vi.fn(),
  adminInsert: vi.fn(),
  adminClientCreated: vi.fn(),
  existingConnection: null as { id: string; external_identifier: string } | null,
}));

vi.mock('@/lib/actions/safe-action', () => ({
  requireRole: vi.fn(() => {
    const builder = {
      metadata: () => builder,
      inputSchema: () => builder,
      action: (handler: unknown) => handler,
    };
    return builder;
  }),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-sentinel',
    get NEXT_PUBLIC_APP_URL() {
      return harness.appUrl;
    },
  },
}));

vi.mock('@/lib/ingestion/resolve-shop-context', () => ({
  resolveShopContext: (...args: unknown[]) => harness.resolveShopContext(...args),
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: vi.fn(() => {
    harness.adminClientCreated();
    return {
      from: (table: string) => {
        if (table === 'store_connection') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: harness.existingConnection, error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table !== 'store_connection_intent') throw new Error('unexpected table');
        return {
          insert: (payload: Record<string, unknown>) => {
            harness.adminInsert(payload);
            return {
              select: () => ({
                single: async () => ({
                  data: {
                    id: '33333333-3333-4333-8333-333333333333',
                    expires_at: payload.expires_at,
                  },
                  error: null,
                }),
              }),
            };
          },
        };
      },
    };
  }),
}));

function userClient() {
  return {
    from: (table: string) => {
      if (table !== 'shop') throw new Error('unexpected table');
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { store_kind: 'woocommerce' }, error: null }),
            }),
          }),
        }),
      };
    },
  };
}

describe('création de l’intention WooCommerce', () => {
  beforeEach(() => {
    harness.appUrl = 'https://app.example.test';
    harness.resolveShopContext.mockReset().mockResolvedValue({
      ok: true,
      context: {
        merchantAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        shopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    });
    harness.adminInsert.mockReset();
    harness.adminClientCreated.mockReset();
    harness.existingConnection = null;
  });

  it('résout le contexte avec le client utilisateur et persiste uniquement une intention opaque', async () => {
    const { createWooCommerceConnectionIntentAction } = await import('@/lib/actions/woocommerce');
    const client = userClient();
    const result = await (
      createWooCommerceConnectionIntentAction as unknown as (input: unknown) => Promise<unknown>
    )({
      ctx: {
        user: { id: 'user-sentinel' },
        supabase: client,
        member: {
          id: 'member-sentinel',
          merchantAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          role: 'owner',
        },
      },
      parsedInput: {
        shopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        shopUrl: 'https://Store.Example.test/wordpress///',
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(harness.resolveShopContext).toHaveBeenCalledWith(client, {
      merchantAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      shopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(harness.adminInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'woocommerce',
        external_identifier: 'https://store.example.test/wordpress',
        created_by_member_id: 'member-sentinel',
      }),
    );
    expect(harness.adminInsert.mock.calls[0][0]).not.toHaveProperty('user_id');
    const authorizeUrl = new URL((result as { authorizeUrl: string }).authorizeUrl);
    expect(authorizeUrl.pathname).toBe('/wordpress/wc-auth/v1/authorize');
    expect(authorizeUrl.searchParams.get('user_id')).toBe('33333333-3333-4333-8333-333333333333');
    expect(harness.adminClientCreated).toHaveBeenCalledOnce();
  });

  it('refuse de fabriquer un callback WooCommerce non HTTPS', async () => {
    harness.appUrl = 'http://localhost:3000';
    const { createWooCommerceConnectionIntentAction } = await import('@/lib/actions/woocommerce');
    const result = await (
      createWooCommerceConnectionIntentAction as unknown as (input: unknown) => Promise<unknown>
    )({
      ctx: {
        user: { id: 'user-sentinel' },
        supabase: userClient(),
        member: {
          id: 'member-sentinel',
          merchantAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          role: 'owner',
        },
      },
      parsedInput: {
        shopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        shopUrl: 'https://store.example.test',
      },
    });

    expect(result).toEqual({ ok: false, errorCode: 'callback_url_not_secure' });
    expect(harness.adminInsert).not.toHaveBeenCalled();
  });

  it('refuse un changement d’URL sans parcours explicite de libération', async () => {
    harness.existingConnection = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      external_identifier: 'https://ancienne-boutique.example.test',
    };
    const { createWooCommerceConnectionIntentAction } = await import('@/lib/actions/woocommerce');
    const result = await (
      createWooCommerceConnectionIntentAction as unknown as (input: unknown) => Promise<unknown>
    )({
      ctx: {
        user: { id: 'user-sentinel' },
        supabase: userClient(),
        member: {
          id: 'member-sentinel',
          merchantAccountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          role: 'owner',
        },
      },
      parsedInput: {
        shopId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        shopUrl: 'https://nouvelle-boutique.example.test',
      },
    });

    expect(result).toEqual({ ok: false, errorCode: 'shop_url_change_requires_review' });
    expect(harness.adminInsert).not.toHaveBeenCalled();
  });
});
