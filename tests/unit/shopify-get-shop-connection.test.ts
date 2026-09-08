// APP-03 / Lot 2 (correctif) — getShopConnection exclut désormais toute boutique sans
// access_token_encrypted (rattachement embarqué en attente) : preuve directe du filtre .not(),
// pas seulement du résultat sur un fixture déjà filtré.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  shops: [] as Array<Record<string, unknown>>,
  notCalls: [] as Array<[string, string, unknown]>,
}));

vi.mock('@/lib/actions/merchant', () => ({
  getMerchantAccount: vi.fn(async () => ({ id: 'tenant-a' })),
}));

// lib/actions/shopify.ts importe aussi syncOrdersAction (syncShopOrders, lib/shopify/shop-sync.ts,
// qui importe `env` — validation Zod complète au chargement, cf. CLAUDE.md). Mocké pour rester
// testable sans environnement serveur complet ; non exercé par ces tests (getShopConnection).
vi.mock('@/lib/shopify/shop-sync', () => ({
  syncShopOrders: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from(table: string) {
      if (table !== 'shop') throw new Error(`unexpected table ${table}`);
      const filters: Array<[string, unknown]> = [];
      const builder = {
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        not(column: string, operator: string, value: unknown) {
          harness.notCalls.push([column, operator, value]);
          filters.push([`${column}__not_${operator}`, value]);
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle: async () => {
          const requiresToken = harness.notCalls.some(
            ([column, operator]) => column === 'access_token_encrypted' && operator === 'is',
          );
          const match = harness.shops.find((shop) => {
            const statusOk = filters.every(([column, value]) => {
              if (column.endsWith('__not_is')) return true;
              return shop[column] === value;
            });
            const tokenOk = !requiresToken || shop.access_token_encrypted != null;
            return statusOk && tokenOk;
          });
          return { data: match ?? null, error: null };
        },
      };
      return { select: () => builder };
    },
  })),
}));

describe('getShopConnection', () => {
  beforeEach(() => {
    harness.shops = [];
    harness.notCalls = [];
  });

  it('exclut une boutique active sans access_token_encrypted (rattachement en attente)', async () => {
    harness.shops = [
      {
        merchant_account_id: 'tenant-a',
        store_kind: 'shopify',
        status: 'active',
        access_token_encrypted: null,
        shop_domain: 'pending-shop.myshopify.com',
      },
    ];

    const { getShopConnection } = await import('@/lib/actions/shopify');
    const result = await getShopConnection();

    expect(result).toBeNull();
    expect(harness.notCalls).toContainEqual(['access_token_encrypted', 'is', null]);
  });

  it('renvoie la boutique quand access_token_encrypted est présent', async () => {
    harness.shops = [
      {
        merchant_account_id: 'tenant-a',
        store_kind: 'shopify',
        status: 'active',
        access_token_encrypted: 'encrypted-token',
        shop_domain: 'ready-shop.myshopify.com',
      },
    ];

    const { getShopConnection } = await import('@/lib/actions/shopify');
    const result = await getShopConnection();

    expect(result).toMatchObject({ shop_domain: 'ready-shop.myshopify.com' });
  });
});
