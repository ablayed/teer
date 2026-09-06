import { shopifyGraphQL } from '@/lib/shopify/graphql';
import { type ShopifyOrderNode, mapShopifyOrder } from '@/lib/shopify/orders-sync';
import { SHOPIFY_PRODUCTS_QUERY, syncProductsForShop } from '@/lib/shopify/products-sync';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shopify/graphql', () => ({
  shopifyGraphQL: vi.fn(),
}));

const shopifyGraphQLMock = vi.mocked(shopifyGraphQL);

function resolvedQuery<T>(data: T, error: unknown = null) {
  const query = Object.assign(Promise.resolve({ data, error }), {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
  });
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.range.mockReturnValue(query);
  return query;
}

function fakeAdmin({
  existingProducts = [],
  insertedProducts = [],
  updatedProducts = [],
}: {
  existingProducts?: Array<{ id: string; shopify_variant_id: string }>;
  insertedProducts?: Array<Record<string, unknown>>;
  updatedProducts?: Array<Record<string, unknown>>;
} = {}) {
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'product') {
        return {
          select: vi.fn(() => resolvedQuery(existingProducts)),
          insert: vi.fn((rows: Array<Record<string, unknown>>) => {
            insertedProducts.push(...rows);
            return resolvedQuery(null);
          }),
          update: vi.fn((row: Record<string, unknown>) => ({
            eq: vi.fn(() => {
              updatedProducts.push(row);
              return resolvedQuery(null);
            }),
          })),
        };
      }
      if (table === 'audit_log') {
        return { insert: vi.fn(() => resolvedQuery(null)) };
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  } as unknown as SupabaseClient;
  return { admin, insertedProducts, updatedProducts };
}

function graphqlProduct(status: string) {
  return {
    products: {
      edges: [
        {
          node: {
            id: 'gid://shopify/Product/100',
            title: 'Produit GraphQL',
            status,
            variants: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/ProductVariant/101',
                    title: 'Default Title',
                    sku: 'SKU-GRAPHQL',
                  },
                },
              ],
            },
          },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

beforeEach(() => {
  shopifyGraphQLMock.mockReset();
});

describe('SHOPIFY_PRODUCTS_QUERY', () => {
  it('demande les champs necessaires au catalogue produit', () => {
    expect(SHOPIFY_PRODUCTS_QUERY).toContain('products(first: 50');
    expect(SHOPIFY_PRODUCTS_QUERY).toContain('variants(first: 50)');
    expect(SHOPIFY_PRODUCTS_QUERY).toContain('sku');
    expect(SHOPIFY_PRODUCTS_QUERY).toContain('status');
  });
});

describe('syncProductsForShop — import GraphQL', () => {
  it.each([
    ['ACTIVE', true],
    ['DRAFT', false],
    ['ARCHIVED', false],
  ])('conserve le statut GraphQL %s (%s)', async (status, expectedActive) => {
    shopifyGraphQLMock.mockResolvedValueOnce(graphqlProduct(status));
    const { admin, insertedProducts } = fakeAdmin();

    await expect(
      syncProductsForShop({
        accessToken: 'synthetic-access-token',
        admin,
        merchantAccountId: 'merchant-graphql',
        shop: { id: 'shop-graphql', shop_domain: 'graphql.example.com' },
      }),
    ).resolves.toMatchObject({ ok: true, syncedCount: 1 });

    expect(insertedProducts).toHaveLength(1);
    expect(insertedProducts[0]?.is_active).toBe(expectedActive);
  });
});

describe('mapShopifyOrder with product identifiers', () => {
  it('preserve la forme existante et ajoute sku, variant et product Shopify', () => {
    const node: ShopifyOrderNode = {
      id: 'gid://shopify/Order/123',
      name: '#123',
      createdAt: '2026-06-03T10:00:00Z',
      displayFinancialStatus: 'PENDING',
      displayFulfillmentStatus: 'UNFULFILLED',
      currentTotalPriceSet: {
        shopMoney: {
          amount: '10000',
          currencyCode: 'XOF',
        },
      },
      customer: null,
      shippingAddress: null,
      lineItems: {
        edges: [
          {
            node: {
              title: 'Sac cuir',
              sku: 'SAC-CUIR',
              quantity: 1,
              originalUnitPriceSet: {
                shopMoney: {
                  amount: '10000',
                },
              },
              variant: { id: 'gid://shopify/ProductVariant/555' },
              product: { id: 'gid://shopify/Product/777' },
            },
          },
        ],
      },
    };

    const order = mapShopifyOrder(node, {
      merchantAccountId: 'merchant_1',
      shopId: 'shop_1',
      customerId: null,
    });

    expect(order.items_summary).toEqual([
      {
        title: 'Sac cuir',
        sku: 'SAC-CUIR',
        quantity: 1,
        price: 10000,
        shopify_variant_id: '555',
        shopify_product_id: '777',
      },
    ]);
  });
});
