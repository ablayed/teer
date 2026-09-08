// APP-03 / Lot 2 — cœur métier du rattachement embarqué : deux gardes (bascule d'app, propriété
// par tenant), écriture pending (jamais store_connection ici), jamais un write sur intent invalide.
//
// L'écriture (insert/update) passe par `admin` (service-role), pas par `ctx.supabase`. Un
// basculement vers le client RLS-respecting a été tenté puis abandonné (voir le commentaire dans
// embedded-link-write.ts) : preuve reproductible que shop_insert échoue sous PostgREST pour un
// owner légitime alors que la même vérification réussit en SQL direct et via RPC — un écart de
// comportement PostgREST/RLS non résolu sur ce stack, cause non identifiée. Basculer aurait cassé
// le rattachement pour tout utilisateur, y compris légitime. `ctx.supabase` ne sert donc ici qu'à
// la vérification d'appartenance (merchant_member), RLS-respecting par construction.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC_APP = {
  label: 'teer-public' as const,
  clientId: 'public_client_sentinel',
  clientSecret: 'public_secret_sentinel',
};

type ShopRow = {
  id: string;
  shop_domain: string;
  merchant_account_id: string;
  shopify_client_id: string | null;
  [key: string]: unknown;
};

const harness = vi.hoisted(() => ({
  shops: [] as ShopRow[],
  membership: null as { id: string } | null,
  nextId: 0,
  shopInsertCalls: [] as Array<Record<string, unknown>>,
  shopUpdateCalls: [] as Array<{
    payload: Record<string, unknown>;
    filters: Array<[string, unknown, 'eq' | 'is']>;
  }>,
  onAfterGuardRead: null as (() => void) | null,
  // Compteur explicite (pas une preuve par effet de bord) : la mock `store_connection` répond
  // normalement plutôt que de faire planter le test si jamais accédée — un test qui prouve
  // l'absence d'écriture en faisant lever une exception se casse silencieusement au premier
  // élargissement du faux client (ex. quelqu'un ajoute plus tard un accès légitime à une AUTRE
  // table et le throw générique masquerait alors un vrai accès à store_connection).
  storeConnectionWriteCount: 0,
}));

vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByClientId: vi.fn((clientId: string | null) =>
    clientId === PUBLIC_APP.clientId ? PUBLIC_APP : null,
  ),
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
      if (table === 'store_connection') {
        return {
          insert: (_payload: Record<string, unknown>) => {
            harness.storeConnectionWriteCount += 1;
            return Promise.resolve({ error: null });
          },
          update: (_payload: Record<string, unknown>) => {
            harness.storeConnectionWriteCount += 1;
            const builder = {
              eq: () => builder,
              // biome-ignore lint/suspicious/noThenProperty: thenable délibéré (PostgrestFilterBuilder réel, awaitable sans .select())
              then: (resolve: (result: { error: null }) => void) => resolve({ error: null }),
            };
            return builder;
          },
        };
      }
      if (table !== 'shop') throw new Error(`unexpected admin table ${table}`);
      return {
        select: () => ({
          eq: (_col: string, domain: string) => ({
            maybeSingle: async () => {
              // Snapshot AVANT le hook : la lecture de garde doit voir l'état d'avant la course.
              const row = harness.shops.find((s) => s.shop_domain === domain) ?? null;
              const snapshot = row
                ? {
                    id: row.id,
                    merchant_account_id: row.merchant_account_id,
                    shopify_client_id: row.shopify_client_id,
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
          harness.shopInsertCalls.push(payload);
          harness.shops.push({ ...(payload as ShopRow), id: `shop-${++harness.nextId}` });
          return Promise.resolve({ error: null });
        },
        update: (payload: Record<string, unknown>) => {
          const filters: Array<[string, unknown, 'eq' | 'is']> = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push([column, value, 'eq']);
              return builder;
            },
            is(column: string, value: unknown) {
              filters.push([column, value, 'is']);
              return builder;
            },
            select: () => ({
              maybeSingle: async () => {
                harness.shopUpdateCalls.push({ payload, filters });
                const row = harness.shops.find((s) =>
                  filters.every(([column, value]) => s[column] === value),
                );
                if (!row) return { data: null, error: null };
                Object.assign(row, payload);
                return { data: { id: row.id }, error: null };
              },
            }),
          };
          return builder;
        },
      };
    },
  })),
}));

function fakeSupabase() {
  return {
    from: (table: string) => {
      if (table !== 'merchant_member') throw new Error(`unexpected ctx table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: harness.membership, error: null }),
            }),
          }),
        }),
      };
    },
    // biome-ignore lint/suspicious/noExplicitAny: fake client, shape not exercised beyond `from`.
  } as any;
}

const VALID_HOST = Buffer.from('admin.shopify.com/store/acme-shop', 'utf8').toString('base64url');

describe('performShopifyEmbeddedLink', () => {
  beforeEach(async () => {
    harness.shops = [];
    harness.membership = { id: 'membership-sentinel' };
    harness.nextId = 0;
    harness.shopInsertCalls = [];
    harness.shopUpdateCalls = [];
    harness.onAfterGuardRead = null;
    harness.storeConnectionWriteCount = 0;
    captureException.mockClear();
    captureMessage.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-sentinel';
    process.env.SHOPIFY_API_SECRET = 'intent-secret-sentinel';
  });

  async function signIntent(
    overrides: Partial<{ shopDomain: string; clientId: string; host: string; exp: number }> = {},
  ) {
    const { signEmbeddedLinkIntent } = await import('@/lib/shopify/embedded-link-intent');
    return signEmbeddedLinkIntent({
      shopDomain: 'acme-shop.myshopify.com',
      clientId: PUBLIC_APP.clientId,
      host: VALID_HOST,
      exp: Date.now() + 60_000,
      ...overrides,
    });
  }

  it("refuse sans écriture quand l'intent est invalide", async () => {
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent: 'not-a-valid-token', merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'intent_invalid' });
    expect(harness.shopInsertCalls).toHaveLength(0);
  });

  it("refuse sans écriture quand l'utilisateur n'est pas membre du tenant demandé", async () => {
    harness.membership = null;
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'not_a_member' });
    expect(harness.shopInsertCalls).toHaveLength(0);
  });

  it('insère une ligne shop pending (access_token_encrypted NULL) quand aucune boutique n’existe, et n’écrit jamais store_connection', async () => {
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({
      ok: true,
      redirectUrl: `https://admin.shopify.com/store/acme-shop/apps/${PUBLIC_APP.clientId}`,
    });
    expect(harness.shopInsertCalls).toHaveLength(1);
    expect(harness.shopInsertCalls[0]).toMatchObject({
      merchant_account_id: 'tenant-a',
      shop_domain: 'acme-shop.myshopify.com',
      shopify_client_id: PUBLIC_APP.clientId,
      status: 'active',
      access_token_encrypted: null,
    });
    // Compteur explicite (pas une preuve par effet de bord du faux client) : zéro écriture
    // store_connection à l'état pending — elle ne devient active qu'après le token exchange
    // (app/api/shopify/embedded/session/route.ts).
    expect(harness.storeConnectionWriteCount).toBe(0);
  });

  it('refuse en fermé, zéro écriture, quand la boutique appartient déjà à une autre app (même tenant)', async () => {
    harness.shops.push({
      id: 'shop-koba',
      shop_domain: 'acme-shop.myshopify.com',
      merchant_account_id: 'tenant-a',
      shopify_client_id: 'koba_client_sentinel',
    });
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'app_switch_refused' });
    expect(harness.shopInsertCalls).toHaveLength(0);
    expect(harness.shopUpdateCalls).toHaveLength(0);
    expect(harness.shops[0].shopify_client_id).toBe('koba_client_sentinel');
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SHOPIFY_APP_SWITCH_REFUSED' }),
      expect.anything(),
    );
  });

  it('refuse en fermé, zéro écriture, quand la boutique appartient à un autre tenant (garde de propriété réutilisée)', async () => {
    harness.shops.push({
      id: 'shop-victim',
      shop_domain: 'acme-shop.myshopify.com',
      merchant_account_id: 'tenant-victim',
      shopify_client_id: PUBLIC_APP.clientId,
    });
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'ownership_refused' });
    expect(harness.shopUpdateCalls).toHaveLength(0);
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_embedded_link_ownership_guard_refused',
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'ownership_mismatch' }) }),
    );
  });

  it('met à jour (reconnexion) avec prédicat sur shopify_client_id, sans jamais inclure merchant_account_id dans le payload', async () => {
    harness.shops.push({
      id: 'shop-existing',
      shop_domain: 'acme-shop.myshopify.com',
      merchant_account_id: 'tenant-a',
      shopify_client_id: PUBLIC_APP.clientId,
    });
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result.ok).toBe(true);
    expect(harness.shopInsertCalls).toHaveLength(0);
    expect(harness.shopUpdateCalls).toHaveLength(1);
    expect(harness.storeConnectionWriteCount).toBe(0);
    expect(harness.shopUpdateCalls[0].payload).not.toHaveProperty('merchant_account_id');
    expect(harness.shopUpdateCalls[0].filters).toContainEqual(['id', 'shop-existing', 'eq']);
    expect(harness.shopUpdateCalls[0].filters).toContainEqual([
      'merchant_account_id',
      'tenant-a',
      'eq',
    ]);
    expect(harness.shopUpdateCalls[0].filters).toContainEqual([
      'shopify_client_id',
      PUBLIC_APP.clientId,
      'eq',
    ]);
  });

  it('reconnexion avec shopify_client_id historiquement NULL : prédicat .is(null), pas .eq(null)', async () => {
    harness.shops.push({
      id: 'shop-legacy',
      shop_domain: 'acme-shop.myshopify.com',
      merchant_account_id: 'tenant-a',
      shopify_client_id: null,
    });
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result.ok).toBe(true);
    expect(harness.shopUpdateCalls[0].filters).toContainEqual(['shopify_client_id', null, 'is']);
  });

  it('refuse en fermé (fail-closed) si une bascule d’app concurrente survient entre la lecture de garde et l’update (course)', async () => {
    harness.shops.push({
      id: 'shop-raced',
      shop_domain: 'acme-shop.myshopify.com',
      merchant_account_id: 'tenant-a',
      shopify_client_id: PUBLIC_APP.clientId,
    });
    // La lecture de garde (admin) voit shopify_client_id === PUBLIC_APP → les deux gardes
    // autorisent ('update'). Juste après cette lecture — donc APRÈS la décision, AVANT
    // l'écriture — une autre requête réassigne la ligne à une autre app. Le prédicat
    // .eq('shopify_client_id', app.clientId) de l'update ne doit alors matcher aucune ligne.
    harness.onAfterGuardRead = () => {
      const row = harness.shops.find((s) => s.id === 'shop-raced');
      if (row) row.shopify_client_id = 'koba_client_sentinel';
    };
    const intent = await signIntent();
    const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');

    const result = await performShopifyEmbeddedLink(
      { intent, merchantAccountId: 'tenant-a' },
      { userId: 'user-a', supabase: fakeSupabase() },
    );

    expect(result).toEqual({ ok: false, errorCode: 'write_failed' });
    expect(harness.shopUpdateCalls).toHaveLength(1);
    expect(harness.shopUpdateCalls[0].filters).toContainEqual([
      'shopify_client_id',
      PUBLIC_APP.clientId,
      'eq',
    ]);
    // La ligne n'a JAMAIS été modifiée par cette écriture — elle porte toujours la valeur
    // réassignée par la course, jamais celle que l'update tentait d'imposer.
    expect(harness.shops[0].shopify_client_id).toBe('koba_client_sentinel');
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'shop_update_failed' }) }),
    );
  });
});
