import { type ShopifyOrderNode, mapShopifyOrder } from '@/lib/shopify/orders-sync';
import { SHOPIFY_PRODUCTS_QUERY } from '@/lib/shopify/products-sync';
import { describe, expect, it } from 'vitest';

describe('SHOPIFY_PRODUCTS_QUERY', () => {
  it('demande les champs necessaires au catalogue produit', () => {
    expect(SHOPIFY_PRODUCTS_QUERY).toContain('products(first: 50');
    expect(SHOPIFY_PRODUCTS_QUERY).toContain('variants(first: 50)');
    expect(SHOPIFY_PRODUCTS_QUERY).toContain('sku');
    expect(SHOPIFY_PRODUCTS_QUERY).toContain('status');
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
