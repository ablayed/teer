import {
  type ShopifyOrderNode,
  extractShopifyId,
  mapShopifyCustomer,
  mapShopifyOrder,
} from '@/lib/shopify/orders-sync';
import { describe, expect, it } from 'vitest';

function makeOrder(overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return {
    id: 'gid://shopify/Order/123456789',
    name: '#1001',
    createdAt: '2026-05-30T12:00:00Z',
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    currentTotalPriceSet: {
      shopMoney: {
        amount: '12500.50',
        currencyCode: 'XOF',
      },
    },
    customer: {
      id: 'gid://shopify/Customer/987654321',
      displayName: 'Awa Diop',
      phone: '+221771234567',
      email: 'awa@example.com',
    },
    shippingAddress: {
      address1: 'Rue 10',
      address2: null,
      city: 'Dakar',
      province: 'Dakar',
      country: 'Senegal',
      zip: '12500',
      phone: '+221771234567',
      name: 'Awa Diop',
    },
    lineItems: {
      edges: [
        {
          node: {
            title: 'Sac',
            quantity: 2,
            originalUnitPriceSet: {
              shopMoney: { amount: '5000.25' },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('extractShopifyId', () => {
  it('extracts the numeric ID from a Shopify GID', () => {
    expect(extractShopifyId('gid://shopify/Order/123456')).toBe('123456');
  });
});

describe('mapShopifyCustomer', () => {
  it('maps a Shopify customer from an order node', () => {
    expect(mapShopifyCustomer(makeOrder(), 'merchant_123')).toEqual({
      merchant_account_id: 'merchant_123',
      shopify_customer_id: '987654321',
      full_name: 'Awa Diop',
      phone: '+221771234567',
      email: 'awa@example.com',
      shipping_address: {
        address1: 'Rue 10',
        address2: null,
        city: 'Dakar',
        province: 'Dakar',
        country: 'Senegal',
        zip: '12500',
      },
    });
  });

  it('returns null when the Shopify customer is missing', () => {
    expect(mapShopifyCustomer(makeOrder({ customer: null }), 'merchant_123')).toBeNull();
  });
});

describe('mapShopifyOrder', () => {
  it('maps order totals, currency and statuses', () => {
    expect(
      mapShopifyOrder(makeOrder(), {
        merchantAccountId: 'merchant_123',
        shopId: 'shop_123',
        customerId: 'customer_123',
      }),
    ).toMatchObject({
      merchant_account_id: 'merchant_123',
      shop_id: 'shop_123',
      customer_id: 'customer_123',
      shopify_order_id: '123456789',
      order_number: '#1001',
      total_amount: 12500.5,
      currency: 'XOF',
      financial_status: 'PENDING',
      fulfillment_status: 'UNFULFILLED',
      created_at_shopify: '2026-05-30T12:00:00Z',
    });
  });

  it('maps line items into a lightweight items summary', () => {
    const order = mapShopifyOrder(makeOrder(), {
      merchantAccountId: 'merchant_123',
      shopId: 'shop_123',
      customerId: null,
    });

    expect(order.items_summary).toEqual([{ title: 'Sac', quantity: 2, price: 5000.25 }]);
  });

  it('handles a missing shipping address', () => {
    const order = mapShopifyOrder(makeOrder({ shippingAddress: null }), {
      merchantAccountId: 'merchant_123',
      shopId: 'shop_123',
      customerId: null,
    });

    expect(order.shipping_address).toBeNull();
  });
});
