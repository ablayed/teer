// SHOPIFY-EXPIRING-TOKENS-01 — rafraîchissement sous bail (lib/shopify/token.ts) :
//   preuve 4 (refresh) : bail tenu → aucun appel Shopify ;
//   preuve 5 (refresh) : bail perdu → sentinelle propre, jamais une erreur technique ;
//   preuve 6          : perte → relecture, paire du GAGNANT utilisée, l'opération aboutit ;
//   preuve 9          : 401 → UN SEUL réessai, après rafraîchissement OU relecture ; aucun sinon.
// Le comportement réel des RPC sous concurrence est prouvé contre PostgreSQL par
// tests/rls/shopify-expiring-tokens-01.rls.test.ts (dont la preuve 9B).
import { randomBytes } from 'node:crypto';
import { ShopifyGraphQLHttpError } from '@/lib/shopify/graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshAccessToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shopify/oauth', () => ({ refreshAccessToken }));

const captureMessage = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
  captureException: vi.fn(),
}));

// Clé de test générée à l'exécution : aucun littéral à allure de secret dans le dépôt.
const ENCRYPTION_KEY = randomBytes(32).toString('hex');

type Row = Record<string, unknown>;

function fakeAdmin(options: {
  acquire?: () => { data: unknown[]; error: null };
  persist?: () => { data: unknown[]; error: null };
  rows?: Row[];
}) {
  const rpcCalls: string[] = [];
  const releases: number[] = [];
  let rowIndex = 0;
  const admin = {
    rpc: vi.fn(async (name: string) => {
      rpcCalls.push(name);
      if (name === 'acquire_shopify_token_lease') {
        return (
          options.acquire?.() ?? {
            data: [{ acquired_generation: 3, expires_at: 'x' }],
            error: null,
          }
        );
      }
      return (
        options.persist?.() ?? { data: [{ outcome: 'updated', shop_id: 'shop-1' }], error: null }
      );
    }),
    from: vi.fn((table: string) => {
      if (table === 'shopify_token_lease') {
        const filters: Array<[string, unknown]> = [];
        const builder = {
          eq(column: string, value: unknown) {
            filters.push([column, value]);
            return builder;
          },
          async not() {
            releases.push(filters.find(([column]) => column === 'generation')?.[1] as number);
            return { error: null };
          },
        };
        return { update: () => builder };
      }
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          const rows = options.rows ?? [];
          const row = rows[Math.min(rowIndex, rows.length - 1)] ?? null;
          rowIndex += 1;
          return { data: row, error: null };
        },
      };
      return chain;
    }),
  };
  return { admin: admin as never, rpcCalls, releases };
}

async function encrypt(value: string) {
  const { encryptToken } = await import('@/lib/shopify/crypto');
  return encryptToken(value);
}

async function expiringShop() {
  return {
    id: 'shop-1',
    shop_domain: 'boutique.myshopify.com',
    merchant_account_id: 'merchant-1',
    access_token_encrypted: await encrypt('old-access'),
    access_token_expires_at: new Date(Date.now() - 1_000).toISOString(),
    refresh_token_encrypted: await encrypt('old-refresh'),
    refresh_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

const noSleep = { sleep: async () => {} };

describe('rafraîchissement sous bail', () => {
  beforeEach(() => {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
    refreshAccessToken.mockReset();
    captureMessage.mockClear();
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'SHOPIFY_TOKEN_ENCRYPTION_KEY');
  });

  it('preuve 4 — bail tenu par un autre : aucun appel Shopify, relecture de la paire du gagnant', async () => {
    const { getValidShopAccessToken } = await import('@/lib/shopify/token');
    const shop = await expiringShop();
    const winnerAccess = await encrypt('winner-access');
    const { admin, rpcCalls } = fakeAdmin({
      acquire: () => ({ data: [], error: null }),
      rows: [
        {
          status: 'active',
          access_token_encrypted: winnerAccess,
          access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });

    const result = await getValidShopAccessToken(admin, shop, 'client', 'secret', noSleep);

    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual(['acquire_shopify_token_lease']);
    expect(result).toEqual({ ok: true, accessToken: 'winner-access' });
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_token_lease_busy',
      expect.objectContaining({ tags: expect.objectContaining({ operation: 'refresh' }) }),
    );
  });

  it('preuve 5 et 6 — bail perdu à l’écriture : sentinelle propre, paire du gagnant utilisée, l’opération aboutit', async () => {
    const { getValidShopAccessToken } = await import('@/lib/shopify/token');
    const shop = await expiringShop();
    refreshAccessToken.mockResolvedValue({
      accessToken: 'loser-access',
      scope: 'read_orders',
      refreshToken: 'loser-refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    });
    const winnerAccess = await encrypt('winner-access');
    const { admin, releases } = fakeAdmin({
      persist: () => ({ data: [{ outcome: 'lease_lost', shop_id: null }], error: null }),
      rows: [
        // Première relecture : le gagnant n'a pas encore écrit (même jeton qu'au départ).
        {
          status: 'active',
          access_token_encrypted: shop.access_token_encrypted,
          access_token_expires_at: shop.access_token_expires_at,
        },
        // Seconde relecture : la paire du gagnant est là.
        {
          status: 'active',
          access_token_encrypted: winnerAccess,
          access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });

    const result = await getValidShopAccessToken(admin, shop, 'client', 'secret', noSleep);

    expect(result).toEqual({ ok: true, accessToken: 'winner-access' });
    // La paire reçue par le perdant n'est JAMAIS utilisée.
    expect(result).not.toEqual({ ok: true, accessToken: 'loser-access' });
    expect(captureMessage).toHaveBeenCalledWith(
      'shopify_token_lease_lost',
      expect.objectContaining({ tags: expect.objectContaining({ operation: 'refresh' }) }),
    );
    expect(releases).toEqual([3]);
  });

  it('preuve 6 — relecture BORNÉE : sans paire du gagnant, token_error après le nombre maximal de lectures', async () => {
    const { TOKEN_REREAD_MAX_ATTEMPTS, getValidShopAccessToken } = await import(
      '@/lib/shopify/token'
    );
    const shop = await expiringShop();
    const { admin } = fakeAdmin({
      acquire: () => ({ data: [], error: null }),
      rows: [
        {
          status: 'active',
          access_token_encrypted: shop.access_token_encrypted,
          access_token_expires_at: shop.access_token_expires_at,
        },
      ],
    });
    const sleep = vi.fn(async () => {});

    const result = await getValidShopAccessToken(admin, shop, 'client', 'secret', { sleep });

    expect(result).toEqual({ ok: false, reason: 'token_error' });
    expect(sleep).toHaveBeenCalledTimes(TOKEN_REREAD_MAX_ATTEMPTS - 1);
  });

  it('boutique devenue inactive pendant la course : aucune paire, jamais ranimée', async () => {
    const { getValidShopAccessToken } = await import('@/lib/shopify/token');
    const shop = await expiringShop();
    const { admin } = fakeAdmin({
      acquire: () => ({ data: [], error: null }),
      rows: [
        { status: 'uninstalled', access_token_encrypted: null, access_token_expires_at: null },
      ],
    });

    const result = await getValidShopAccessToken(admin, shop, 'client', 'secret', noSleep);

    expect(result).toEqual({ ok: false, reason: 'token_error' });
  });
});

describe('preuve 9 — un seul réessai après 401', () => {
  beforeEach(() => {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
    refreshAccessToken.mockReset();
    captureMessage.mockClear();
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'SHOPIFY_TOKEN_ENCRYPTION_KEY');
  });

  function unauthorizedOnce(tokens: string[]) {
    return vi.fn(async (accessToken: string) => {
      tokens.push(accessToken);
      if (tokens.length === 1) {
        throw new ShopifyGraphQLHttpError(401);
      }
      return 'result';
    });
  }

  it('401 puis rafraîchissement de CETTE instance : un seul réessai, avec la nouvelle paire', async () => {
    const { runWithShopifyUnauthorizedRetry } = await import('@/lib/shopify/token');
    const shop = await expiringShop();
    refreshAccessToken.mockResolvedValue({
      accessToken: 'refreshed-access',
      scope: 'read_orders',
      refreshToken: 'refreshed-refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    });
    const { admin } = fakeAdmin({
      rows: [{ ...shop, status: 'active' }],
    });
    const tokens: string[] = [];
    const operation = unauthorizedOnce(tokens);

    const result = await runWithShopifyUnauthorizedRetry(
      admin,
      shop,
      'client',
      'secret',
      'old-access',
      operation,
      noSleep,
    );

    expect(result).toBe('result');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(tokens).toEqual(['old-access', 'refreshed-access']);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('401 puis relecture d’une paire écrite par une AUTRE instance : un seul réessai, sans rafraîchir', async () => {
    const { runWithShopifyUnauthorizedRetry } = await import('@/lib/shopify/token');
    const shop = await expiringShop();
    const { admin } = fakeAdmin({
      rows: [{ ...shop, status: 'active', access_token_encrypted: await encrypt('other-access') }],
    });
    const tokens: string[] = [];
    const operation = unauthorizedOnce(tokens);

    const result = await runWithShopifyUnauthorizedRetry(
      admin,
      shop,
      'client',
      'secret',
      'old-access',
      operation,
      noSleep,
    );

    expect(result).toBe('result');
    expect(tokens).toEqual(['old-access', 'other-access']);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('401 sans paire plus récente (jeton non expirant, aucun refresh token) : aucun réessai, erreur d’origine', async () => {
    const { runWithShopifyUnauthorizedRetry } = await import('@/lib/shopify/token');
    const shop = {
      ...(await expiringShop()),
      access_token_encrypted: await encrypt('old-access'),
      access_token_expires_at: null,
      refresh_token_encrypted: null,
      refresh_token_expires_at: null,
    };
    const { admin } = fakeAdmin({ rows: [{ ...shop, status: 'active' }] });
    const original = new ShopifyGraphQLHttpError(401);
    const operation = vi.fn(async () => {
      throw original;
    });

    await expect(
      runWithShopifyUnauthorizedRetry(admin, shop, 'client', 'secret', 'old-access', operation),
    ).rejects.toBe(original);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('401 de nouveau après le réessai : l’erreur remonte, jamais une boucle', async () => {
    const { runWithShopifyUnauthorizedRetry } = await import('@/lib/shopify/token');
    const shop = await expiringShop();
    const { admin } = fakeAdmin({
      rows: [{ ...shop, status: 'active', access_token_encrypted: await encrypt('other-access') }],
    });
    const operation = vi.fn(async () => {
      throw new ShopifyGraphQLHttpError(401);
    });

    await expect(
      runWithShopifyUnauthorizedRetry(admin, shop, 'client', 'secret', 'old-access', operation),
    ).rejects.toBeInstanceOf(ShopifyGraphQLHttpError);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('erreur autre que 401 : aucun réessai', async () => {
    const { runWithShopifyUnauthorizedRetry } = await import('@/lib/shopify/token');
    const shop = await expiringShop();
    const { admin, rpcCalls } = fakeAdmin({ rows: [] });
    const operation = vi.fn(async () => {
      throw new ShopifyGraphQLHttpError(500);
    });

    await expect(
      runWithShopifyUnauthorizedRetry(admin, shop, 'client', 'secret', 'old-access', operation),
    ).rejects.toBeInstanceOf(ShopifyGraphQLHttpError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toEqual([]);
  });
});
