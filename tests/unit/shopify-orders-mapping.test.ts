import {
  type ShopifyOrderNode,
  extractShopifyId,
  isStaleShopifyUpdate,
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
            sku: 'SAC-001',
            quantity: 2,
            originalUnitPriceSet: {
              shopMoney: { amount: '5000.25' },
            },
            variant: {
              id: 'gid://shopify/ProductVariant/444',
            },
            product: {
              id: 'gid://shopify/Product/333',
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

  it('preserves the Shopify currency code', () => {
    const order = mapShopifyOrder(
      makeOrder({
        currentTotalPriceSet: {
          shopMoney: {
            amount: '99.95',
            currencyCode: 'USD',
          },
        },
      }),
      {
        merchantAccountId: 'merchant_123',
        shopId: 'shop_123',
        customerId: null,
      },
    );

    expect(order.currency).toBe('USD');
  });

  it('maps line items into items summary while preserving Shopify identifiers', () => {
    const order = mapShopifyOrder(makeOrder(), {
      merchantAccountId: 'merchant_123',
      shopId: 'shop_123',
      customerId: null,
    });

    expect(order.items_summary).toEqual([
      {
        title: 'Sac',
        sku: 'SAC-001',
        quantity: 2,
        price: 5000.25,
        shopify_variant_id: '444',
        shopify_product_id: '333',
      },
    ]);
  });

  it('handles a missing shipping address', () => {
    const order = mapShopifyOrder(makeOrder({ shippingAddress: null }), {
      merchantAccountId: 'merchant_123',
      shopId: 'shop_123',
      customerId: null,
    });

    expect(order.shipping_address).toBeNull();
  });

  it('pose les 4 dimensions aux defauts a l_insert (Shopify n_ecrase pas l_etat operationnel)', () => {
    const order = mapShopifyOrder(makeOrder(), {
      merchantAccountId: 'merchant_123',
      shopId: 'shop_123',
      customerId: null,
    });

    expect(order.order_state).toBe('open');
    expect(order.call_state).toBe('to_call');
    expect(order.delivery_state).toBe('unassigned');
    expect(order.cash_state).toBe('not_due');
  });

  it('ecrit les colonnes miroir de canal shopify_* (distinctes des dimensions)', () => {
    const order = mapShopifyOrder(
      makeOrder({
        updatedAt: '2026-06-01T10:00:00Z',
        cancelledAt: '2026-06-01T11:00:00Z',
        displayFinancialStatus: 'REFUNDED',
        displayFulfillmentStatus: 'FULFILLED',
      }),
      { merchantAccountId: 'm', shopId: 's', customerId: null },
    );

    expect(order.shopify_financial_status).toBe('REFUNDED');
    expect(order.shopify_fulfillment_status).toBe('FULFILLED');
    expect(order.shopify_cancelled_at).toBe('2026-06-01T11:00:00Z');
    expect(order.shopify_updated_at).toBe('2026-06-01T10:00:00Z');
  });
});

describe('isStaleShopifyUpdate (garde hors-ordre)', () => {
  it('webhook plus ancien que le stocke → perime (ignore)', () => {
    expect(isStaleShopifyUpdate('2026-06-01T10:00:00Z', '2026-06-01T12:00:00Z')).toBe(true);
  });

  it('webhook identique au stocke → perime (ignore)', () => {
    expect(isStaleShopifyUpdate('2026-06-01T12:00:00Z', '2026-06-01T12:00:00Z')).toBe(true);
  });

  it('webhook plus recent → applique', () => {
    expect(isStaleShopifyUpdate('2026-06-01T13:00:00Z', '2026-06-01T12:00:00Z')).toBe(false);
  });

  it('stocke absent (premiere fois) → applique', () => {
    expect(isStaleShopifyUpdate('2026-06-01T13:00:00Z', null)).toBe(false);
  });
});
